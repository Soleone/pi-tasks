import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent"
import { DynamicBorder } from "@mariozechner/pi-coding-agent"
import { Container, SelectList, Spacer, Text, truncateToWidth } from "@mariozechner/pi-tui"
import {
  DESCRIPTION_PART_SEPARATOR,
  buildIssueListRowModel,
  buildWorkPrompt,
  decodeIssueDescription,
  serializeIssueReference,
  stripAnsi,
  type BdIssue,
  type IssueStatus,
} from "./beads-task-view-model.ts"
import {
  buildListPrimaryHelpText,
  buildListSecondaryHelpText,
  resolveListIntent,
} from "./beads-list-controller.ts"
import { showIssueForm } from "./components/beads-issue-show-view.ts"
import { MinHeightContainer } from "./components/min-height-container.ts"
import { formatKeyboardHelp, KEYBOARD_HELP_PADDING_X } from "./components/keyboard-help-style.ts"

type ListMode = "ready" | "open" | "all"

interface IssueListConfig {
  title: string
  subtitle?: string
  issues: BdIssue[]
  allowPriority?: boolean
  allowSearch?: boolean
  filterTerm?: string
}

const MAX_LIST_RESULTS = 200
const LIST_PAGE_CONTENT_MIN_HEIGHT = 20
const CTRL_F = "\x06"
const CTRL_Q = "\x11"

const MODE_SUBTITLES: Record<ListMode, string> = {
  ready: "Ready",
  open: "Open",
  all: "All",
}

const LIST_MODE_ARGS: Record<ListMode, string[]> = {
  ready: ["ready", "--limit", String(MAX_LIST_RESULTS), "--sort", "priority", "--json"],
  open: ["list", "--sort", "priority", "--limit", String(MAX_LIST_RESULTS), "--json"],
  all: ["list", "--all", "--sort", "priority", "--limit", String(MAX_LIST_RESULTS), "--json"],
}

const LIST_MODE_CONTEXT: Record<ListMode, string> = {
  ready: "ready",
  open: "list",
  all: "list all",
}

function isLikelyIssueId(value: string): boolean {
  return /^[a-z0-9]+-[a-z0-9]+$/i.test(value)
}

function truncateDescription(desc: string | undefined, maxLines: number): string[] {
  if (!desc || !desc.trim()) return ["(no description)"]
  const allLines = desc.split(/\r?\n/)
  const lines = allLines.slice(0, maxLines)
  if (allLines.length > maxLines) lines.push("...")
  return lines
}

function parseJsonArray<T>(stdout: string, context: string): T[] {
  try {
    const parsed = JSON.parse(stdout)
    if (!Array.isArray(parsed)) throw new Error("expected JSON array")
    return parsed as T[]
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`Failed to parse bd output (${context}): ${msg}`)
  }
}

function parseJsonObject<T>(stdout: string, context: string): T {
  try {
    const parsed = JSON.parse(stdout)
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("expected JSON object")
    }
    return parsed as T
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`Failed to parse bd output (${context}): ${msg}`)
  }
}

function parsePriorityKey(data: string): number | null {
  if (data.length !== 1) return null
  const num = parseInt(data, 10)
  return !isNaN(num) && num >= 0 && num <= 4 ? num : null
}

function matchesFilter(issue: BdIssue, term: string): boolean {
  const lower = term.toLowerCase()
  return (
    issue.title.toLowerCase().includes(lower) ||
    (issue.description ?? "").toLowerCase().includes(lower) ||
    issue.id.toLowerCase().includes(lower) ||
    issue.status.toLowerCase().includes(lower)
  )
}

function buildListHeaderText(
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

const ARG_TO_LIST_MODE: Record<string, ListMode> = {
  open: "open",
  all: "all",
}

function parseListMode(args: string): ListMode {
  return ARG_TO_LIST_MODE[args] || "ready"
}

const CYCLE_STATUSES: IssueStatus[] = ["open", "in_progress", "closed"]
const CYCLE_TYPES = ["task", "feature", "bug", "chore", "epic"] as const

function cycleStatus(current: IssueStatus): IssueStatus {
  const idx = CYCLE_STATUSES.indexOf(current)
  if (idx === -1) return "open"
  return CYCLE_STATUSES[(idx + 1) % CYCLE_STATUSES.length]
}

function cycleIssueType(current: string | undefined): string {
  const normalized = current || "task"
  const idx = CYCLE_TYPES.indexOf(normalized as (typeof CYCLE_TYPES)[number])
  if (idx === -1) return CYCLE_TYPES[0]
  return CYCLE_TYPES[(idx + 1) % CYCLE_TYPES.length]
}

export default function beadsTasks(pi: ExtensionAPI) {

  async function execBd(args: string[], timeout = 30_000): Promise<string> {
    const result = await pi.exec("bd", args, { timeout })
    if (result.code !== 0) {
      const details = (result.stderr || result.stdout || "").trim()
      throw new Error(details.length > 0 ? details : `bd ${args.join(" ")} failed (code ${result.code})`)
    }
    return result.stdout
  }

  async function listIssues(mode: ListMode): Promise<BdIssue[]> {
    const out = await execBd(LIST_MODE_ARGS[mode])
    return parseJsonArray<BdIssue>(out, LIST_MODE_CONTEXT[mode])
  }

  async function showIssue(id: string): Promise<BdIssue> {
    const out = await execBd(["show", id, "--json"])
    const issues = parseJsonArray<BdIssue>(out, `show ${id}`)
    const issue = issues[0]
    if (!issue) throw new Error(`Issue not found: ${id}`)
    return issue
  }

  function needsIssueDetailsForEdit(issue: BdIssue): boolean {
    return issue.description === undefined
  }

  async function getIssueForEdit(id: string, fromList?: BdIssue): Promise<BdIssue> {
    if (!fromList) return showIssue(id)
    if (needsIssueDetailsForEdit(fromList)) return showIssue(id)
    return { ...fromList }
  }

  async function updateIssue(id: string, args: string[]): Promise<void> {
    await execBd(["update", id, ...args])
  }

  // Issue list with description preview and priority hotkeys.
  async function showIssueList(ctx: ExtensionCommandContext, config: IssueListConfig): Promise<void> {
    const { title, subtitle, issues, allowPriority = true, allowSearch = true } = config

    if (issues.length === 0) {
      ctx.ui.notify("No issues found", "info")
      return
    }

    // Mutable copy for local updates
    const displayIssues = [...issues]
    let filterTerm = config.filterTerm || ""
    let rememberedSelectedId: string | undefined

    while (true) {
      const visible = filterTerm
        ? displayIssues.filter(i => matchesFilter(i, filterTerm))
        : displayIssues

      if (visible.length === 0) {
        ctx.ui.notify(`No matches for "${filterTerm}"`, "warning")
        filterTerm = ""
        continue
      }

      const getMaxLabelWidth = () => Math.max(...displayIssues.map(i =>
        stripAnsi(buildIssueListRowModel(i).label).length
      ))

      let selectedId: string | undefined
      const result = await ctx.ui.custom<"cancel" | "select" | "create">((tui: any, theme: any, _kb: any, done: any) => {
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
          const { meta, summary } = decodeIssueDescription(text)
          if (!summary) return theme.fg("muted", meta)
          return `${theme.fg("muted", meta)}${META_SUMMARY_SEPARATOR}${summary}`
        }

        const getItems = () => {
          const filtered = filterTerm
            ? displayIssues.filter(i => matchesFilter(i, filterTerm))
            : displayIssues
          const maxLabelWidth = getMaxLabelWidth()
          return filtered.map((issue) => {
            const row = buildIssueListRowModel(issue, { maxLabelWidth })
            return {
              value: row.id,
              label: row.label,
              description: row.description,
            }
          })
        }

        let items = getItems()
        let selectList = new SelectList(items, Math.min(items.length, 10), {
          selectedPrefix: (t: string) => theme.fg("accent", t),
          selectedText: (t: string) => applyAccentWithAnsi(t),
          description: (t: string) => styleDescription(t),
          scrollInfo: (t: string) => theme.fg("dim", t),
          noMatch: (t: string) => theme.fg("warning", t),
        })

        if (rememberedSelectedId) {
          const rememberedIndex = items.findIndex(i => i.value === rememberedSelectedId)
          if (rememberedIndex >= 0) selectList.setSelectedIndex(rememberedIndex)
        }

        selectList.onSelectionChange = () => {
          const selected = selectList.getSelectedItem()
          if (selected) rememberedSelectedId = selected.value
          updateDescPreview()
          tui.requestRender()
        }
        selectList.onSelect = () => {
          const sel = selectList.getSelectedItem()
          if (sel) {
            selectedId = sel.value
            rememberedSelectedId = sel.value
          }
          done("select")
        }
        selectList.onCancel = () => {
          if (filterTerm) {
            filterTerm = ""
            items = getItems()
            selectList = new SelectList(items, Math.min(items.length, 10), selectList.theme)
            selectList.onSelectionChange = selectList.onSelectionChange
            selectList.onSelect = selectList.onSelect
            selectList.onCancel = selectList.onCancel
            container.invalidate()
            tui.requestRender()
          } else {
            done("cancel")
          }
        }
        const renderListArea = () => {
          while (listAreaContainer.children.length > 0) {
            listAreaContainer.removeChild(listAreaContainer.children[0])
          }
          listAreaContainer.addChild(selectList)
          listAreaContainer.addChild(new Spacer(1))
          listAreaContainer.addChild(itemPreviewContainer)
        }

        const wrapText = (text: string, width: number, maxLines: number): string[] => {
          const lines: string[] = []
          const safeWidth = Math.max(1, width)

          if (text.length === 0) return [""]

          const words = text.split(" ")
          let currentLine = ""

          const flushLine = () => {
            if (lines.length < maxLines) lines.push(currentLine)
            currentLine = ""
          }

          for (const word of words) {
            const candidate = currentLine ? `${currentLine} ${word}` : word

            if (stripAnsi(candidate).length <= safeWidth) {
              currentLine = candidate
              continue
            }

            if (currentLine) {
              flushLine()
              if (lines.length >= maxLines) break
            }

            let remaining = word
            while (stripAnsi(remaining).length > safeWidth) {
              const chunk = remaining.slice(0, safeWidth)
              if (lines.length < maxLines) lines.push(chunk)
              if (lines.length >= maxLines) break
              remaining = remaining.slice(safeWidth)
            }
            if (lines.length >= maxLines) break
            currentLine = remaining
          }

          if (currentLine && lines.length < maxLines) lines.push(currentLine)
          return lines.slice(0, maxLines)
        }

        // Build description preview with word wrapping, capped at 7 visual lines
        const buildDescText = (descLines: string[], width: number): string => {
          const wrappedLines: string[] = []
          for (const line of descLines) {
            const wrapped = wrapText(line, width, 7 - wrappedLines.length)
            wrappedLines.push(...wrapped)
            if (wrappedLines.length >= 7) break
          }
          while (wrappedLines.length < 7) wrappedLines.push("")
          return wrappedLines.join("\n")
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
          const issue = displayIssues.find(i => i.id === selected.value)
          if (!issue) {
            previewTitleText.setText("")
            descTextComponent.setText(buildDescText([], lastWidth))
            return
          }

          previewTitleText.setText(theme.fg("accent", theme.bold(issue.title)))
          const descLines = truncateDescription(issue.description, 100)
          descTextComponent.setText(buildDescText(descLines, lastWidth))
        }
        if (items[0]) updateDescPreview()

        headerContainer.addChild(new DynamicBorder((s: string) => theme.fg("dim", s)))
        headerContainer.addChild(titleText)

        const helpText = new Text("", KEYBOARD_HELP_PADDING_X, 0)
        const shortcutsText = new Text(formatKeyboardHelp(theme, buildListSecondaryHelpText()), KEYBOARD_HELP_PADDING_X, 0)

        footerContainer.addChild(new DynamicBorder((s: string) => theme.fg("dim", s)))
        footerContainer.addChild(helpText)
        footerContainer.addChild(shortcutsText)
        footerContainer.addChild(new DynamicBorder((s: string) => theme.fg("dim", s)))

        renderListArea()

        const refreshDisplay = () => {
          titleText.setText(buildListHeaderText(theme, title, subtitle, searching, searchBuffer, filterTerm))
          helpText.setText(formatKeyboardHelp(theme, buildListPrimaryHelpText({
            searching,
            filtered: !!filterTerm,
            allowPriority,
            allowSearch,
            ctrlQ: CTRL_Q,
            ctrlF: CTRL_F,
          })))
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
          container.invalidate()
          tui.requestRender()
        }

        const getSelectedIssue = (): BdIssue | undefined => {
          const selected = selectList.getSelectedItem()
          if (!selected) return undefined
          rememberedSelectedId = selected.value
          return displayIssues.find(i => i.id === selected.value)
        }

        const withSelectedIssue = (run: (issue: BdIssue) => void): void => {
          const issue = getSelectedIssue()
          if (!issue) return
          run(issue)
        }

        // Re-render helper - rebuild list area while preserving page sections.
        const rebuildAndRender = () => {
          items = getItems()
          const prevSelected = selectList.getSelectedItem()

          // Recreate SelectList
          selectList = new SelectList(items, Math.min(items.length, 10), {
            selectedPrefix: (t: string) => theme.fg("accent", t),
            selectedText: (t: string) => applyAccentWithAnsi(t),
            description: (t: string) => styleDescription(t),
            scrollInfo: (t: string) => theme.fg("dim", t),
            noMatch: (t: string) => theme.fg("warning", t),
          })

          selectList.onSelectionChange = () => {
            const selected = selectList.getSelectedItem()
            if (selected) rememberedSelectedId = selected.value
            updateDescPreview()
            tui.requestRender()
          }
          selectList.onSelect = () => {
            const sel = selectList.getSelectedItem()
            if (sel) {
              selectedId = sel.value
              rememberedSelectedId = sel.value
            }
            done("select")
          }
          selectList.onCancel = () => {
            if (filterTerm) {
              filterTerm = ""
              rebuildAndRender()
            } else {
              done("cancel")
            }
          }

          renderListArea()

          // Restore selection
          if (prevSelected) {
            const newIdx = items.findIndex(i => i.value === prevSelected.value)
            if (newIdx >= 0) selectList.setSelectedIndex(newIdx)
          }

          refreshDisplay()
          updateDescPreview()
          container.invalidate()
          tui.requestRender()
        }

        return {
          render: (w: number) => {
            lastWidth = w
            return container.render(w).map((l: string) => truncateToWidth(l, w))
          },
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            const intent = resolveListIntent(data, {
              searching,
              filtered: !!filterTerm,
              allowSearch,
              allowPriority,
              ctrlQ: CTRL_Q,
              ctrlF: CTRL_F,
            })

            switch (intent.type) {
              case "cancel":
                done("cancel")
                return

              case "searchStart":
                searching = true
                searchBuffer = ""
                refreshDisplay()
                container.invalidate()
                tui.requestRender()
                return

              case "searchCancel":
                searching = false
                searchBuffer = ""
                refreshDisplay()
                container.invalidate()
                tui.requestRender()
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
                container.invalidate()
                tui.requestRender()
                return

              case "searchAppend":
                searchBuffer += intent.value
                refreshDisplay()
                container.invalidate()
                tui.requestRender()
                return

              case "moveSelection":
                moveSelection(intent.delta)
                return

              case "work":
                withSelectedIssue((issue) => {
                  done("cancel")
                  pi.sendUserMessage(buildWorkPrompt(issue))
                })
                return

              case "edit":
                withSelectedIssue((issue) => {
                  selectedId = issue.id
                  done("select")
                })
                return

              case "toggleStatus":
                withSelectedIssue((issue) => {
                  const newStatus = cycleStatus(issue.status)
                  issue.status = newStatus
                  updateIssue(issue.id, ["--status", newStatus])
                  rebuildAndRender()
                })
                return

              case "setPriority":
                withSelectedIssue((issue) => {
                  if (issue.priority === intent.priority) return
                  issue.priority = intent.priority
                  updateIssue(issue.id, ["--priority", String(intent.priority)])
                  rebuildAndRender()
                })
                return

              case "scrollDescription":
                withSelectedIssue((issue) => {
                  const descLines = truncateDescription(issue.description, 100)
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
                  container.invalidate()
                  tui.requestRender()
                })
                return

              case "toggleType":
                withSelectedIssue((issue) => {
                  const newType = cycleIssueType(issue.issue_type)
                  issue.issue_type = newType
                  updateIssue(issue.id, ["--type", newType])
                  rebuildAndRender()
                })
                return

              case "create":
                done("create")
                return

              case "reference":
                withSelectedIssue((issue) => {
                  done("cancel")
                  ctx.ui.pasteToEditor(`${serializeIssueReference(issue)} `)
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
      if (result === "create") {
        const createdIssue = await createIssue(ctx)
        if (createdIssue) {
          displayIssues.unshift(createdIssue)
          rememberedSelectedId = createdIssue.id
        }
        continue
      }
      if (result === "select" && selectedId) {
        rememberedSelectedId = selectedId
        const currentIssue = displayIssues.find(i => i.id === selectedId)
        const editResult = await editIssue(ctx, selectedId, currentIssue)
        if (editResult.updatedIssue) {
          const idx = displayIssues.findIndex(i => i.id === selectedId)
          if (idx !== -1) {
            displayIssues[idx] = editResult.updatedIssue
          }
        }
        if (editResult.closeList) return
        continue
      }
    }
  }

  interface EditIssueResult {
    updatedIssue: BdIssue | null
    closeList: boolean
  }

  function buildIssueUpdateArgs(previous: BdIssue, next: {
    title: string
    description: string
    status: IssueStatus
    priority: number | undefined
    issueType: string | undefined
  }): string[] {
    const args: string[] = []

    const nextTitle = next.title.trim()
    if (nextTitle !== previous.title.trim()) {
      args.push("--title", nextTitle)
    }

    if (next.description !== (previous.description ?? "")) {
      args.push("--description", next.description)
    }

    if (next.status !== previous.status) {
      args.push("--status", next.status)
    }

    if (next.priority !== previous.priority) {
      args.push("--priority", String(next.priority))
    }

    if (next.issueType !== previous.issue_type) {
      args.push("--type", next.issueType || "task")
    }

    return args
  }

  // Issue show view with inline save behavior.
  async function editIssue(ctx: ExtensionCommandContext, id: string, fromList?: BdIssue): Promise<EditIssueResult> {
    let issue = await getIssueForEdit(id, fromList)

    const formResult = await showIssueForm(ctx, {
      mode: "edit",
      subtitle: "Edit",
      issue,
      ctrlQ: CTRL_Q,
      cycleStatus,
      cycleIssueType,
      parsePriorityKey,
      onSave: async (draft) => {
        const updateArgs = buildIssueUpdateArgs(issue, {
          title: draft.title,
          description: draft.description,
          status: draft.status,
          priority: draft.priority,
          issueType: draft.issueType,
        })

        if (updateArgs.length === 0) return false

        await updateIssue(id, updateArgs)
        issue = {
          ...issue,
          title: draft.title.trim(),
          description: draft.description,
          status: draft.status,
          priority: draft.priority,
          issue_type: draft.issueType,
        }
        return true
      },
    })

    return {
      updatedIssue: issue,
      closeList: formResult.action === "close_list",
    }
  }

  async function createIssue(ctx: ExtensionCommandContext): Promise<BdIssue | null> {
    let createdIssue: BdIssue | null = null

    await showIssueForm(ctx, {
      mode: "create",
      subtitle: "Create",
      issue: {
        id: "new",
        title: "",
        description: "",
        status: "open",
        priority: 2,
        issue_type: "task",
      },
      ctrlQ: CTRL_Q,
      cycleStatus,
      cycleIssueType,
      parsePriorityKey,
      onSave: async (draft) => {
        const title = draft.title.trim()
        if (title.length === 0) {
          throw new Error("Title is required")
        }

        if (!createdIssue) {
          const createArgs = [
            "create",
            "--title", title,
            "--priority", String(draft.priority ?? 2),
            "--type", draft.issueType || "task",
            "--json",
          ]

          if (draft.description.length > 0) {
            createArgs.splice(3, 0, "--description", draft.description)
          }

          const out = await execBd(createArgs)
          const created = parseJsonObject<BdIssue>(out, "create")

          if (draft.status !== "open" && created.id) {
            await updateIssue(created.id, ["--status", draft.status])
            created.status = draft.status
          }

          createdIssue = {
            ...created,
            title,
            description: draft.description,
            status: draft.status,
            priority: draft.priority,
            issue_type: draft.issueType,
          }
          return true
        }

        const updateArgs = buildIssueUpdateArgs(createdIssue, {
          title,
          description: draft.description,
          status: draft.status,
          priority: draft.priority,
          issueType: draft.issueType,
        })

        if (updateArgs.length === 0) return false

        await updateIssue(createdIssue.id, updateArgs)
        createdIssue = {
          ...createdIssue,
          title,
          description: draft.description,
          status: draft.status,
          priority: draft.priority,
          issue_type: draft.issueType,
        }
        return true
      },
    })

    return createdIssue
  }

  async function browseIssues(ctx: ExtensionCommandContext, mode: ListMode): Promise<void> {
    const modeTitle = "Tasks"
    const modeSubtitle = MODE_SUBTITLES[mode]

    try {
      ctx.ui.setStatus("beads", "Loading…")
      const issues = await listIssues(mode)
      ctx.ui.setStatus("beads", undefined)
      await showIssueList(ctx, { title: modeTitle, subtitle: modeSubtitle, issues })
    } catch (e) {
      ctx.ui.setStatus("beads", undefined)
      ctx.ui.notify(e instanceof Error ? e.message : String(e), "error")
    }
  }

  pi.registerCommand("beads", {
    description: "Browse and edit Beads issues",
    handler: async (rawArgs, ctx) => {
      if (!ctx.hasUI) return
      const args = (rawArgs || "").trim()
      if (args.length > 0 && isLikelyIssueId(args)) {
        try {
          await editIssue(ctx, args)
        } catch (e) {
          ctx.ui.notify(e instanceof Error ? e.message : String(e), "error")
        }
        return
      }
      await browseIssues(ctx, parseListMode(args))
    },
  })

  pi.registerShortcut("ctrl+q", {
    description: "Open Beads task list",
    handler: async (ctx) => {
      if (!ctx.hasUI) return
      await browseIssues(ctx as ExtensionCommandContext, "ready")
    },
  })
}