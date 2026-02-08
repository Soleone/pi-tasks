import { DynamicBorder, type ExtensionCommandContext } from "@mariozechner/pi-coding-agent"
import { Container, SelectList, Spacer, Text, truncateToWidth } from "@mariozechner/pi-tui"
import type { Issue, IssueStatus } from "../../models/issue.ts"
import { DESCRIPTION_PART_SEPARATOR, buildListRowModel, decodeDescription, stripAnsi } from "../../models/list-item.ts"
import { buildListPrimaryHelpText, buildListSecondaryHelpText, resolveListIntent } from "../../controllers/list.ts"
import { KEYBOARD_HELP_PADDING_X, formatKeyboardHelp } from "../components/keyboard-help.ts"
import { MinHeightContainer } from "../components/min-height.ts"

const LIST_PAGE_CONTENT_MIN_HEIGHT = 20

export interface ListPageConfig {
  title: string
  subtitle?: string
  issues: Issue[]
  allowPriority?: boolean
  allowSearch?: boolean
  filterTerm?: string
  ctrlQ: string
  ctrlF: string
  cycleStatus: (status: IssueStatus) => IssueStatus
  cycleIssueType: (current: string | undefined) => string
  onUpdateIssue: (id: string, args: string[]) => Promise<void>
  onWork: (issue: Issue) => void
  onReference: (issue: Issue) => void
  onEdit: (id: string, issue: Issue | undefined) => Promise<{ updatedIssue: Issue | null; closeList: boolean }>
  onCreate: () => Promise<Issue | null>
}

function truncateDescription(desc: string | undefined, maxLines: number): string[] {
  if (!desc || !desc.trim()) return ["(no description)"]
  const allLines = desc.split(/\r?\n/)
  const lines = allLines.slice(0, maxLines)
  if (allLines.length > maxLines) lines.push("...")
  return lines
}

function matchesFilter(issue: Issue, term: string): boolean {
  const lower = term.toLowerCase()
  return (
    issue.title.toLowerCase().includes(lower) ||
    (issue.description ?? "").toLowerCase().includes(lower) ||
    issue.id.toLowerCase().includes(lower) ||
    issue.status.toLowerCase().includes(lower)
  )
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

export async function showIssueList(ctx: ExtensionCommandContext, config: ListPageConfig): Promise<void> {
  const { title, subtitle, issues, allowPriority = true, allowSearch = true } = config

  const displayIssues = [...issues]
  let filterTerm = config.filterTerm || ""
  let rememberedSelectedId: string | undefined

  while (true) {
    const visible = filterTerm
      ? displayIssues.filter(i => matchesFilter(i, filterTerm))
      : displayIssues

    if (visible.length === 0 && filterTerm) {
      ctx.ui.notify(`No matches for "${filterTerm}"`, "warning")
      filterTerm = ""
      continue
    }

    const getMaxLabelWidth = () => Math.max(...displayIssues.map(i =>
      stripAnsi(buildListRowModel(i).label).length
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
        const { meta, summary } = decodeDescription(text)
        if (!summary) return theme.fg("muted", meta)
        return `${theme.fg("muted", meta)}${META_SUMMARY_SEPARATOR}${summary}`
      }

      const getItems = () => {
        const filtered = filterTerm
          ? displayIssues.filter(i => matchesFilter(i, filterTerm))
          : displayIssues
        const maxLabelWidth = getMaxLabelWidth()
        return filtered.map((issue) => {
          const row = buildListRowModel(issue, { maxLabelWidth })
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
        titleText.setText(buildHeaderText(theme, title, subtitle, searching, searchBuffer, filterTerm))
        helpText.setText(formatKeyboardHelp(theme, buildListPrimaryHelpText({
          searching,
          filtered: !!filterTerm,
          allowPriority,
          allowSearch,
          ctrlQ: config.ctrlQ,
          ctrlF: config.ctrlF,
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

      const getSelectedIssue = (): Issue | undefined => {
        const selected = selectList.getSelectedItem()
        if (!selected) return undefined
        rememberedSelectedId = selected.value
        return displayIssues.find(i => i.id === selected.value)
      }

      const withSelectedIssue = (run: (issue: Issue) => void): void => {
        const issue = getSelectedIssue()
        if (!issue) return
        run(issue)
      }

      const rebuildAndRender = () => {
        items = getItems()
        const prevSelected = selectList.getSelectedItem()

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
            ctrlQ: config.ctrlQ,
            ctrlF: config.ctrlF,
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
                config.onWork(issue)
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
                const newStatus = config.cycleStatus(issue.status)
                issue.status = newStatus
                void config.onUpdateIssue(issue.id, ["--status", newStatus])
                rebuildAndRender()
              })
              return

            case "setPriority":
              withSelectedIssue((issue) => {
                if (issue.priority === intent.priority) return
                issue.priority = intent.priority
                void config.onUpdateIssue(issue.id, ["--priority", String(intent.priority)])
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
                const newType = config.cycleIssueType(issue.issue_type)
                issue.issue_type = newType
                void config.onUpdateIssue(issue.id, ["--type", newType])
                rebuildAndRender()
              })
              return

            case "create":
              done("create")
              return

            case "reference":
              withSelectedIssue((issue) => {
                done("cancel")
                config.onReference(issue)
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
      const createdIssue = await config.onCreate()
      if (createdIssue) {
        displayIssues.unshift(createdIssue)
        rememberedSelectedId = createdIssue.id
      }
      continue
    }

    if (result === "select" && selectedId) {
      rememberedSelectedId = selectedId
      const currentIssue = displayIssues.find(i => i.id === selectedId)
      const editResult = await config.onEdit(selectedId, currentIssue)
      if (editResult.updatedIssue) {
        const idx = displayIssues.findIndex(i => i.id === selectedId)
        if (idx !== -1) displayIssues[idx] = editResult.updatedIssue
      }
      if (editResult.closeList) return
    }
  }
}
