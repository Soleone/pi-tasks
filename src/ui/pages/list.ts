import { DynamicBorder, type ExtensionCommandContext } from "@mariozechner/pi-coding-agent"
import { Container, Spacer, Text, truncateToWidth } from "@mariozechner/pi-tui"
import type { Task, TaskStatus } from "../../models/task.ts"
import { projectTaskList } from "../../models/task-hierarchy.ts"
import type { TaskListScope, TaskUpdate } from "../../backend/api.ts"
import { DESCRIPTION_PART_SEPARATOR, buildListRowModel, decodeDescription, stripAnsi } from "../../models/list-item.ts"
import { buildListHelpTexts, resolveListIntent, type ListControllerState } from "../../controllers/list.ts"
import { KEYBOARD_HELP_PADDING_X, formatKeyboardHelp } from "../components/keyboard-help.ts"
import { MinHeightContainer } from "../components/min-height.ts"
import { ReservedLineText } from "../components/reserved-line-text.ts"
import { SelectListWithColumns } from "../components/select-list-with-columns.ts"
import { buildDescText, wrapText } from "../../lib/text.ts"

const LIST_PAGE_CONTENT_MIN_HEIGHT = 20
const TASK_LIST_ROW_LAYOUT = {
  valueMaxWidth: 68,
  valueColumnWidth: 70,
}

interface ListItem {
  value: string
  label: string
  description: string
}

export interface ListPageConfig {
  title: string
  subtitle?: string
  tasks: Task[]
  allowPriority?: boolean
  allowSearch?: boolean
  allowHierarchy?: boolean
  filterTerm?: string
  priorities: string[]
  priorityHotkeys?: Record<string, string>
  closeKeys: string[]
  cycleStatus: (status: TaskStatus) => TaskStatus
  cycleTaskType: (current: string | undefined) => string
  onUpdateTask: (ref: string, update: TaskUpdate) => Promise<void>
  onWork: (task: Task) => void
  onInsert: (task: Task) => void
  onReload: (scope: TaskListScope) => Promise<Task[]>
  onEdit: (ref: string, task: Task | undefined) => Promise<{ updatedTask: Task | null; closeList: boolean }>
  onCreate: (parentRef?: string) => Promise<Task | null>
}

function truncateDescription(desc: string | undefined, maxLines: number): string[] {
  if (!desc || !desc.trim()) return ["(no description)"]
  const allLines = desc.split(/\r?\n/)
  const lines = allLines.slice(0, maxLines)
  if (allLines.length > maxLines) lines.push("...")
  return lines
}

function buildHeaderText(
  theme: any,
  title: string,
  subtitle: string | undefined,
  searching: boolean,
  searchBuffer: string,
  filterTerm: string,
): string {
  if (searching) return theme.fg("muted", theme.bold(`Search: ${searchBuffer}_`))
  if (filterTerm) return theme.fg("muted", theme.bold(`${title} [filter: ${filterTerm}]`))

  const subtitlePart = subtitle ? theme.fg("dim", ` • ${subtitle}`) : ""
  return `${theme.fg("muted", theme.bold(title))}${subtitlePart}`
}

export async function showTaskList(ctx: ExtensionCommandContext, config: ListPageConfig): Promise<void> {
  const { title, subtitle, tasks, allowPriority = true, allowSearch = true, allowHierarchy = false } = config

  const displayTasks = [...tasks]
  let scope: TaskListScope = "active"
  let filterTerm = config.filterTerm || ""
  let rememberedSelectedRef: string | undefined
  let grouped = false
  const expandedRefs = new Set<string>()

  while (true) {
    const visible = projectTaskList(displayTasks, { grouped, expandedRefs, filterTerm }).map(row => row.task)

    if (visible.length === 0 && filterTerm) {
      ctx.ui.notify(`No matches for "${filterTerm}"`, "warning")
      filterTerm = ""
      continue
    }

    const projectedTasks = () => projectTaskList(displayTasks, { grouped, expandedRefs, filterTerm })
    const taskWithHierarchyLabel = (task: Task, depth: number, hasChildren: boolean, expanded: boolean): Task => ({
      ...task,
      title: `${"  ".repeat(depth)}${hasChildren ? (expanded ? "▾ " : "▸ ") : (depth > 0 ? "  " : "")}${task.title}`,
    })

    let selectedRef: string | undefined
    let createParentRef: string | undefined
    const result = await ctx.ui.custom<"cancel" | "select" | "create" | "createChild">((tui: any, theme: any, _kb: any, done: any) => {
      const container = new Container()
      let searching = false
      let searchBuffer = ""
      let descScroll = 0

      const headerContainer = new Container()
      const listAreaContainer = new Container()
      const footerContainer = new Container()
      const paddedListAreaContainer = new MinHeightContainer(listAreaContainer, LIST_PAGE_CONTENT_MIN_HEIGHT)

      container.addChild(headerContainer)
      container.addChild(paddedListAreaContainer)
      container.addChild(footerContainer)

      const titleText = new Text("", 1, 0)

      const META_SUMMARY_SEPARATOR = " "
      const accentMarker = "__ACCENT_MARKER__"
      const accentedMarker = theme.fg("accent", accentMarker)
      const markerIndex = accentedMarker.indexOf(accentMarker)
      const accentPrefix = markerIndex >= 0 ? accentedMarker.slice(0, markerIndex) : ""
      const accentSuffix = markerIndex >= 0 ? accentedMarker.slice(markerIndex + accentMarker.length) : "\x1b[0m"
      const applyAccentWithAnsi = (text: string) => {
        const normalized = text.replaceAll(DESCRIPTION_PART_SEPARATOR, META_SUMMARY_SEPARATOR)
        if (!accentPrefix) return theme.fg("accent", normalized)
        return `${accentPrefix}${normalized.replace(/\x1b\[0m/g, `\x1b[0m${accentPrefix}`)}${accentSuffix}`
      }

      const styleDescription = (text: string) => {
        const { meta, summary } = decodeDescription(text)
        if (!summary) return theme.fg("muted", meta)
        return `${theme.fg("muted", meta)}${META_SUMMARY_SEPARATOR}${summary}`
      }

      const getItems = (): ListItem[] => {
        const projected = projectedTasks()
        const maxLabelWidth = Math.max(0, ...projected.map(row =>
          stripAnsi(buildListRowModel(taskWithHierarchyLabel(row.task, row.depth, row.hasChildren, row.expanded)).label).length
        ))
        return projected.map(({ task, depth, hasChildren, expanded }) => {
          const row = buildListRowModel(taskWithHierarchyLabel(task, depth, hasChildren, expanded), { maxLabelWidth })
          return {
            value: row.ref,
            label: row.label,
            description: row.description,
          }
        })
      }

      const selectListTheme = {
        selectedPrefix: (t: string) => theme.fg("accent", t),
        selectedText: (t: string) => applyAccentWithAnsi(t),
        description: (t: string) => styleDescription(t),
        scrollInfo: (t: string) => theme.fg("dim", t),
        noMatch: (t: string) => theme.fg("warning", t),
      }

      const rerender = () => {
        container.invalidate()
        tui.requestRender()
      }

      let items = getItems()

      const createSelectList = (nextItems: ListItem[]) => {
        const list = new SelectListWithColumns(nextItems, Math.min(nextItems.length, 10), selectListTheme, TASK_LIST_ROW_LAYOUT)
        list.onSelectionChange = () => {
          const selected = list.getSelectedItem()
          if (selected) rememberedSelectedRef = selected.value
          updateDescPreview()
          tui.requestRender()
        }
        list.onSelect = () => {
          const sel = list.getSelectedItem()
          if (sel) {
            selectedRef = sel.value
            rememberedSelectedRef = sel.value
          }
          done("select")
        }
        list.onCancel = () => {
          if (filterTerm) {
            filterTerm = ""
            rebuildAndRender()
          } else {
            done("cancel")
          }
        }
        return list
      }

      const restoreSelection = (preferredRef: string | undefined) => {
        if (!preferredRef) return
        const index = items.findIndex(i => i.value === preferredRef)
        if (index >= 0) selectList.setSelectedIndex(index)
      }

      let selectList = createSelectList(items)
      restoreSelection(rememberedSelectedRef)

      const renderListArea = () => {
        while (listAreaContainer.children.length > 0) {
          listAreaContainer.removeChild(listAreaContainer.children[0])
        }
        listAreaContainer.addChild(selectList)
        listAreaContainer.addChild(new Spacer(1))
        listAreaContainer.addChild(itemPreviewContainer)
      }

      const previewTitleText = new Text("", 0, 0)
      const descTextComponent = new Text(buildDescText([], 80), 0, 0)
      const itemPreviewContainer = new Container()
      itemPreviewContainer.addChild(previewTitleText)
      itemPreviewContainer.addChild(descTextComponent)

      let lastWidth = 80

      const updateDescPreview = () => {
        const selected = selectList.getSelectedItem()
        if (!selected) {
          previewTitleText.setText("")
          descTextComponent.setText(buildDescText([], lastWidth))
          return
        }

        descScroll = 0
        const task = displayTasks.find(i => i.ref === selected.value)
        if (!task) {
          previewTitleText.setText("")
          descTextComponent.setText(buildDescText([], lastWidth))
          return
        }

        previewTitleText.setText(theme.fg("accent", theme.bold(task.title)))
        const relationshipLines: string[] = []
        if (task.parentRef) {
          const parent = displayTasks.find(candidate => candidate.ref === task.parentRef)
          relationshipLines.push(`Parent: ${parent?.title ? `${parent.title} (${task.parentRef})` : `${task.parentRef} (unknown)`}`)
        }
        if (task.blockers?.length) {
          const blockers = task.blockers.map(blocker => `${blocker.ref}${blocker.title ? ` ${blocker.title}` : ""} (${blocker.status ?? "unknown"})`)
          relationshipLines.push(`${theme.fg("warning", "Blocked by:")} ${blockers.join(", ")}`)
        }
        const descLines = [...relationshipLines, ...truncateDescription(task.description, 100)]
        descTextComponent.setText(buildDescText(descLines, lastWidth))
      }
      if (items[0]) updateDescPreview()

      headerContainer.addChild(new DynamicBorder((s: string) => theme.fg("dim", s)))
      headerContainer.addChild(titleText)

      const helpText = new ReservedLineText(KEYBOARD_HELP_PADDING_X)
      const shortcutsText = new ReservedLineText(KEYBOARD_HELP_PADDING_X)

      footerContainer.addChild(new DynamicBorder((s: string) => theme.fg("dim", s)))
      footerContainer.addChild(helpText)
      footerContainer.addChild(shortcutsText)
      footerContainer.addChild(new DynamicBorder((s: string) => theme.fg("dim", s)))

      renderListArea()

      const controllerState = (): ListControllerState => ({
        searching,
        filtered: !!filterTerm,
        allowSearch,
        allowPriority,
        allowHierarchy,
        scope,
        closeKeys: config.closeKeys,
        priorities: config.priorities,
        priorityHotkeys: config.priorityHotkeys,
      })

      const refreshDisplay = () => {
        const modeSubtitle = `${subtitle ?? ""}${subtitle ? " • " : ""}${scope}${grouped ? " • grouped" : " • flat"}`
        titleText.setText(buildHeaderText(theme, title, modeSubtitle, searching, searchBuffer, filterTerm))
        const help = buildListHelpTexts(controllerState())
        helpText.setText(formatKeyboardHelp(theme, help.primary))
        shortcutsText.setText(formatKeyboardHelp(theme, help.secondary))
      }
      refreshDisplay()

      const moveSelection = (delta: number) => {
        if (items.length === 0) return
        const selected = selectList.getSelectedItem()
        const currentIndex = selected ? items.findIndex(i => i.value === selected.value) : 0
        const normalizedIndex = currentIndex >= 0 ? currentIndex : 0
        const nextIndex = (normalizedIndex + delta + items.length) % items.length
        selectList.setSelectedIndex(nextIndex)
        updateDescPreview()
        rerender()
      }

      const getSelectedTask = (): Task | undefined => {
        const selected = selectList.getSelectedItem()
        if (!selected) return undefined
        rememberedSelectedRef = selected.value
        return displayTasks.find(i => i.ref === selected.value)
      }

      const withSelectedTask = (run: (task: Task) => void): void => {
        const task = getSelectedTask()
        if (!task) return
        run(task)
      }

      const rebuildAndRender = () => {
        const prevSelected = selectList.getSelectedItem()

        items = getItems()
        selectList = createSelectList(items)

        renderListArea()
        restoreSelection(prevSelected?.value ?? rememberedSelectedRef)

        refreshDisplay()
        updateDescPreview()
        rerender()
      }

      const reloadTasks = (nextScope: TaskListScope) => {
        ctx.ui.setStatus("tasks", nextScope === "closed" ? "Loading closed…" : "Loading…")
        void config.onReload(nextScope)
          .then(tasks => {
            scope = nextScope
            displayTasks.length = 0
            displayTasks.push(...tasks)
            filterTerm = ""
            rebuildAndRender()
          })
          .catch(error => {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error")
          })
          .finally(() => ctx.ui.setStatus("tasks", undefined))
      }

      return {
        render: (w: number) => {
          if (lastWidth !== w) {
            lastWidth = w
            updateDescPreview()
          }
          return container.render(w).map((l: string) => truncateToWidth(l, w))
        },
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          const intent = resolveListIntent(data, controllerState())

          switch (intent.type) {
            case "cancel":
              done("cancel")
              return

            case "back":
              if (filterTerm) {
                filterTerm = ""
                rebuildAndRender()
              } else {
                done("cancel")
              }
              return

            case "searchStart":
              searching = true
              searchBuffer = ""
              refreshDisplay()
              rerender()
              return

            case "searchCancel":
              searching = false
              searchBuffer = ""
              refreshDisplay()
              rerender()
              return

            case "searchApply":
              filterTerm = searchBuffer.trim()
              searching = false
              rebuildAndRender()
              refreshDisplay()
              return

            case "searchBackspace":
              searchBuffer = searchBuffer.slice(0, -1)
              refreshDisplay()
              rerender()
              return

            case "searchAppend":
              searchBuffer += intent.value
              refreshDisplay()
              rerender()
              return

            case "moveSelection":
              moveSelection(intent.delta)
              return

            case "work":
              withSelectedTask((task) => {
                done("cancel")
                config.onWork(task)
              })
              return

            case "edit":
              withSelectedTask((task) => {
                selectedRef = task.ref
                done("select")
              })
              return

            case "toggleStatus":
              withSelectedTask((task) => {
                const newStatus = config.cycleStatus(task.status)
                task.status = newStatus
                void config.onUpdateTask(task.ref, { status: newStatus })
                if ((newStatus === "closed") !== (scope === "closed")) {
                  const idx = displayTasks.findIndex(i => i.ref === task.ref)
                  if (idx !== -1) displayTasks.splice(idx, 1)
                }
                rebuildAndRender()
              })
              return

            case "closeTask":
              withSelectedTask((task) => {
                const idx = displayTasks.findIndex(i => i.ref === task.ref)
                if (idx !== -1) displayTasks.splice(idx, 1)
                void config.onUpdateTask(task.ref, { status: "closed" })
                rebuildAndRender()
              })
              return

            case "setPriority":
              withSelectedTask((task) => {
                if (task.priority === intent.priority) return
                task.priority = intent.priority
                void config.onUpdateTask(task.ref, { priority: intent.priority })
                rebuildAndRender()
              })
              return

            case "scrollDescription":
              withSelectedTask((task) => {
                const descLines = truncateDescription(task.description, 100)
                const allWrapped: string[] = []
                for (const line of descLines) {
                  const wrapped = wrapText(line, lastWidth, 100)
                  allWrapped.push(...wrapped)
                }
                const maxScroll = Math.max(0, allWrapped.length - 7)
                if (intent.delta > 0 && descScroll < maxScroll) {
                  descScroll++
                } else if (intent.delta < 0 && descScroll > 0) {
                  descScroll--
                }
                const visible = allWrapped.slice(descScroll, descScroll + 7)
                while (visible.length < 7) visible.push("")
                descTextComponent.setText(visible.join("\n"))
                rerender()
              })
              return

            case "toggleType":
              withSelectedTask((task) => {
                const newType = config.cycleTaskType(task.taskType)
                task.taskType = newType
                void config.onUpdateTask(task.ref, { taskType: newType })
                rebuildAndRender()
              })
              return

            case "toggleGrouping":
              grouped = !grouped
              rebuildAndRender()
              return

            case "toggleScope":
              reloadTasks(scope === "closed" ? "active" : "closed")
              return

            case "toggleExpanded":
              withSelectedTask((task) => {
                const projected = projectedTasks().find(row => row.task.ref === task.ref)
                if (!projected?.hasChildren || !grouped) return
                if (expandedRefs.has(task.ref)) expandedRefs.delete(task.ref)
                else expandedRefs.add(task.ref)
                rebuildAndRender()
              })
              return

            case "create":
              done("create")
              return

            case "createChild":
              withSelectedTask((task) => {
                createParentRef = task.ref
                done("createChild")
              })
              return

            case "insert":
              withSelectedTask((task) => {
                done("cancel")
                config.onInsert(task)
              })
              return

            case "delegate":
              selectList.handleInput(data)
              tui.requestRender()
              return
          }
        },
      }
    })

    if (result === "cancel") return

    if (result === "create" || result === "createChild") {
      const createdTask = await config.onCreate(result === "createChild" ? createParentRef : undefined)
      if (createdTask && (createdTask.status === "closed") === (scope === "closed")) {
        displayTasks.unshift(createdTask)
        if (createdTask.parentRef) expandedRefs.add(createdTask.parentRef)
        rememberedSelectedRef = createdTask.ref
      }
      continue
    }

    if (result === "select" && selectedRef) {
      rememberedSelectedRef = selectedRef
      const currentTask = displayTasks.find(i => i.ref === selectedRef)
      const editResult = await config.onEdit(selectedRef, currentTask)
      if (editResult.updatedTask) {
        const idx = displayTasks.findIndex(i => i.ref === selectedRef)
        if (idx !== -1) displayTasks[idx] = editResult.updatedTask
      }
      if (editResult.closeList) return
    }
  }
}
