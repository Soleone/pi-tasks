import { DynamicBorder, type ExtensionCommandContext } from "@mariozechner/pi-coding-agent"
import { Container, Key, Spacer, Text, matchesKey, truncateToWidth } from "@mariozechner/pi-tui"
import { ReservedLineText } from "../components/reserved-line-text.ts"
import {
  buildPrimaryHelpText,
  buildSecondaryHelpText,
  getHeaderStatus,
  isSameDraft,
  normalizeDraft,
  type FormDraft,
  type FormFocus,
  type FormMode,
  type HeaderStatus,
} from "../../controllers/show.ts"
import { buildTaskIdentityText, buildTaskListTextParts, formatTaskTypeCode } from "../task-format.ts"
import type { Task, TaskStatus } from "../../models/task.ts"
import type { TaskAdapterCapabilities } from "../../backend/api.ts"
import { BlurEditorField } from "../components/blur-editor.ts"
import { KEYBOARD_HELP_PADDING_X, formatKeyboardHelp } from "../components/keyboard-help.ts"
import { MinHeightContainer } from "../components/min-height.ts"
import { FixedHeightField } from "../components/fixed-height-field.ts"

export type TaskFormAction = "back" | "close_list"

export interface TaskFormResult {
  action: TaskFormAction
}

interface ShowTaskFormOptions {
  mode: FormMode
  subtitle: string
  task: Task
  relationshipCapabilities?: TaskAdapterCapabilities
  relationshipCandidates?: Task[]
  closeKeys: string[]
  cycleStatus: (status: TaskStatus) => TaskStatus
  cycleTaskType: (taskType: string | undefined) => string
  parsePriorityKey: (data: string) => string | null
  priorities: string[]
  priorityHotkeys?: Record<string, string>
  onSave: (draft: FormDraft) => Promise<boolean>
}

function buildPageTitle(theme: any, subtitle: string, status?: HeaderStatus): string {
  const base = `${theme.fg("muted", theme.bold("Tasks"))}${theme.fg("dim", ` • ${subtitle}`)}`
  if (!status) return base

  const marker = status.icon ? theme.fg(status.color, status.icon) : "•"
  return `${base} ${marker} ${theme.fg(status.color, status.message)}`
}

function buildSelectedTaskLine(
  mode: FormMode,
  theme: any,
  rowIdentity: string,
  rowMeta: string,
  priority: string | undefined,
  taskType: string | undefined,
): string {
  if (mode === "create") {
    const identity = buildTaskIdentityText(priority, "new")
    return `${theme.fg("accent", SELECTED_ITEM_PREFIX)}${identity} ${formatTaskTypeCode(taskType)}`
  }

  return `${theme.fg("accent", SELECTED_ITEM_PREFIX)}${rowIdentity} ${rowMeta}`
}

function fieldLabel(theme: any, label: string, focused: boolean): string {
  const color = focused ? "accent" : "muted"
  return theme.fg(color, theme.bold(label))
}

const SELECTED_ITEM_PREFIX = "› "
const DESCRIPTION_FIELD_HEIGHT = 8
const PAGE_CONTENT_MIN_HEIGHT = 19
const SHIFT_TAB_SEQUENCE = /^\x1b\[[0-9;]*Z$/
const SHIFT_ENTER_FALLBACK_SEQUENCE = /^\x1b\[13;2~$/

function isShiftTab(data: string): boolean {
  return SHIFT_TAB_SEQUENCE.test(data)
}

function isExplicitNewLineCommand(data: string): boolean {
  return (
    matchesKey(data, Key.shift("enter")) ||
    data === "\n" ||
    data === "\x1b\r" ||
    SHIFT_ENTER_FALLBACK_SEQUENCE.test(data)
  )
}

export async function showTaskForm(ctx: ExtensionCommandContext, options: ShowTaskFormOptions): Promise<TaskFormResult> {
  const { mode, subtitle, task, closeKeys, cycleStatus, cycleTaskType, parsePriorityKey, priorities, priorityHotkeys, onSave } = options

  let taskTypeValue = task.taskType
  let titleValue = task.title
  let descValue = task.description ?? ""
  let statusValue = task.status
  let priorityValue = task.priority
  let parentRefValue = task.parentRef
  let blockedByValue = (task.blockers ?? []).map(blocker => blocker.ref)
  const relationshipCapabilities = options.relationshipCapabilities ?? { hierarchy: "none", dependencies: "none" }
  const relationshipCandidates = options.relationshipCandidates ?? []

  return ctx.ui.custom<TaskFormResult>((tui: any, theme: any, _kb: any, done: any) => {
    const container = new Container()
    const headerContainer = new Container()
    const formContainer = new Container()
    const footerContainer = new Container()
    const paddedFormContainer = new MinHeightContainer(formContainer, PAGE_CONTENT_MIN_HEIGHT)

    container.addChild(headerContainer)
    container.addChild(paddedFormContainer)
    container.addChild(footerContainer)

    const pageTitleText = new Text("", 1, 0)
    const selectedTaskText = new Text("", 0, 0)
    const titleLabel = new Text("", 0, 0)
    const descLabel = new Text("", 0, 0)
    const parentRelationText = new Text("", 0, 0)
    const blockerRelationText = new Text("", 0, 0)
    const helpText = new ReservedLineText(KEYBOARD_HELP_PADDING_X)

    let focus: FormFocus = mode === "create" ? "title" : "nav"
    let saveIndicator: "saving" | "saved" | "error" | undefined
    let saveIndicatorTimer: ReturnType<typeof setTimeout> | undefined
    let saving = false
    let saveQueued = false
    let savePromise: Promise<void> | null = null
    let disposed = false

    const editorTheme = {
      borderColor: (s: string) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (t: string) => theme.fg("accent", t),
        selectedText: (t: string) => theme.fg("accent", t),
        description: (t: string) => theme.fg("muted", t),
        scrollInfo: (t: string) => theme.fg("dim", t),
        noMatch: (t: string) => theme.fg("warning", t),
      },
    }

    const titleEditor = new BlurEditorField(tui, editorTheme, {
      stripTopBorder: true,
      blurredBorderColor: (s: string) => theme.fg("muted", s),
      paddingX: 0,
      focusedCursorColor: (s: string) => theme.fg("accent", s),
    })
    titleEditor.setText(titleValue)
    titleEditor.disableSubmit = true
    titleEditor.onChange = (text: string) => {
      const normalized = text.replace(/\r?\n/g, " ")
      if (normalized !== text) {
        titleEditor.setText(normalized)
        return
      }
      titleValue = normalized
    }

    const descEditor = new BlurEditorField(tui, editorTheme, {
      stripTopBorder: true,
      blurredBorderColor: (s: string) => theme.fg("muted", s),
      paddingX: 0,
      focusedCursorColor: (s: string) => theme.fg("accent", s),
    })
    const descEditorField = new FixedHeightField(descEditor, DESCRIPTION_FIELD_HEIGHT)
    descEditor.setText(descValue)
    descEditor.disableSubmit = true
    descEditor.onChange = (text: string) => {
      descValue = text
    }

    const currentDraft = (): FormDraft => ({
      title: titleValue,
      description: descValue,
      status: statusValue,
      priority: priorityValue,
      taskType: taskTypeValue,
      parentRef: parentRefValue,
      blockedBy: [...blockedByValue],
    })

    let lastSavedDraft: FormDraft = currentDraft()

    const triggerSave = async () => {
      if (disposed) return

      const draft = currentDraft()
      if (saving) {
        saveQueued = true
        await savePromise
        return
      }

      if (isSameDraft(draft, lastSavedDraft)) return

      saving = true
      saveQueued = false
      if (saveIndicatorTimer) clearTimeout(saveIndicatorTimer)
      saveIndicator = "saving"
      renderLayout()

      const activeSave = (async () => {
        try {
          const didSave = await onSave(draft)
          if (disposed) return
          if (!didSave) {
            saveIndicator = undefined
            return
          }
          lastSavedDraft = normalizeDraft(draft)
          saveIndicator = "saved"
        } catch (e) {
          if (disposed) return
          saveIndicator = "error"
          ctx.ui.notify(e instanceof Error ? e.message : String(e), "error")
        } finally {
          saving = false
          if (!disposed) renderLayout()
        }

        if (saveIndicator === "saved" && !disposed) {
          saveIndicatorTimer = setTimeout(() => {
            if (disposed) return
            saveIndicator = undefined
            renderLayout()
          }, 5000)
        }

        if (saveQueued && !disposed) {
          saveQueued = false
          await triggerSave()
        }
      })()

      savePromise = activeSave

      try {
        await activeSave
      } finally {
        if (savePromise === activeSave) savePromise = null
      }
    }

    const canPersistCurrentDraft = (): boolean => {
      if (mode === "edit") return true
      return titleValue.trim().length > 0
    }

    const triggerAutoSave = () => {
      if (!canPersistCurrentDraft()) return
      void triggerSave()
    }

    let relationshipPickerOpen = false
    const candidateTasks = relationshipCandidates.filter(candidate => candidate.ref !== task.ref)
    const candidateLabel = (candidate: Task): string => `${candidate.ref} • ${candidate.title}`

    const chooseParent = async () => {
      if (relationshipCapabilities.hierarchy === "none") return
      if (candidateTasks.length === 0) {
        ctx.ui.notify("No other tasks are available as a parent", "warning")
        return
      }
      relationshipPickerOpen = true
      try {
        const labels = ["(no parent)", ...candidateTasks.map(candidateLabel)]
        const selected = await ctx.ui.select("Parent task", labels)
        if (!selected) return
        parentRefValue = selected === "(no parent)"
          ? undefined
          : candidateTasks.find(candidate => candidateLabel(candidate) === selected)?.ref
        renderLayout()
        triggerAutoSave()
      } finally {
        relationshipPickerOpen = false
      }
    }

    const chooseBlockers = async () => {
      if (relationshipCapabilities.dependencies === "none") return
      if (candidateTasks.length === 0) {
        ctx.ui.notify("No other tasks are available as blockers", "warning")
        return
      }
      relationshipPickerOpen = true
      try {
        const selectedRefs = new Set(blockedByValue)
        while (true) {
          const labels = ["Done", ...candidateTasks.map(candidate => `${selectedRefs.has(candidate.ref) ? "[x]" : "[ ]"} ${candidateLabel(candidate)}`)]
          const selected = await ctx.ui.select("Blocked by (toggle, then Done)", labels)
          if (!selected || selected === "Done") break
          const candidate = candidateTasks.find(item => selected.endsWith(candidateLabel(item)))
          if (!candidate) continue
          if (selectedRefs.has(candidate.ref)) selectedRefs.delete(candidate.ref)
          else selectedRefs.add(candidate.ref)
        }
        blockedByValue = [...selectedRefs]
        renderLayout()
        triggerAutoSave()
      } finally {
        relationshipPickerOpen = false
      }
    }

    const exitForm = (action: TaskFormAction) => {
      void (async () => {
        if ((saving || !isSameDraft(currentDraft(), lastSavedDraft)) && canPersistCurrentDraft()) {
          await triggerSave()
          if (saving || !isSameDraft(currentDraft(), lastSavedDraft)) return
        }

        done({ action })
      })()
    }

    const renderLayout = () => {
      titleEditor.focused = focus === "title"
      descEditor.focused = focus === "desc"

      const rowParts = buildTaskListTextParts({
        ...task,
        title: titleValue,
        description: descValue,
        status: statusValue,
        priority: priorityValue,
        taskType: taskTypeValue,
      })

      const headerStatus = getHeaderStatus(saveIndicator, focus)
      pageTitleText.setText(buildPageTitle(theme, subtitle, headerStatus))
      selectedTaskText.setText(
        buildSelectedTaskLine(mode, theme, rowParts.identity, rowParts.meta, priorityValue, taskTypeValue),
      )
      titleLabel.setText(fieldLabel(theme, "Title", focus === "title"))
      descLabel.setText(fieldLabel(theme, "Description", focus === "desc"))

      const parent = parentRefValue
        ? relationshipCandidates.find(candidate => candidate.ref === parentRefValue)
        : undefined
      parentRelationText.setText(relationshipCapabilities.hierarchy === "none"
        ? ""
        : theme.fg("muted", `Parent: ${parent?.title ? `${parent.title} (${parentRefValue})` : (parentRefValue ?? "none")}`))
      const blockerLabels = blockedByValue.map(ref => {
        const candidate = relationshipCandidates.find(item => item.ref === ref)
        return candidate?.title ? `${candidate.title} (${ref})` : ref
      })
      blockerRelationText.setText(relationshipCapabilities.dependencies === "none"
        ? ""
        : `${theme.fg("warning", "Blocked by:")} ${theme.fg("muted", blockerLabels.length > 0 ? blockerLabels.join(", ") : "none")}`)

      const primaryHelp = buildPrimaryHelpText(focus)
      const secondaryHelp = buildSecondaryHelpText(focus, priorities, priorityHotkeys, relationshipCapabilities)
      const combinedHelp = secondaryHelp ? `${primaryHelp} • ${secondaryHelp}` : primaryHelp

      helpText.setText(formatKeyboardHelp(theme, combinedHelp))

      container.invalidate()
      tui.requestRender()
    }

    headerContainer.addChild(new DynamicBorder((s: string) => theme.fg("dim", s)))
    headerContainer.addChild(pageTitleText)
    headerContainer.addChild(selectedTaskText)

    formContainer.addChild(new Spacer(1))
    formContainer.addChild(titleLabel)
    formContainer.addChild(titleEditor)
    formContainer.addChild(parentRelationText)
    formContainer.addChild(blockerRelationText)
    formContainer.addChild(new Spacer(1))
    formContainer.addChild(descLabel)
    formContainer.addChild(descEditorField)

    footerContainer.addChild(new DynamicBorder((s: string) => theme.fg("dim", s)))
    footerContainer.addChild(helpText)
    footerContainer.addChild(new DynamicBorder((s: string) => theme.fg("dim", s)))

    renderLayout()

    const requestRender = () => {
      container.invalidate()
      tui.requestRender()
    }

    const handleTitleInput = (data: string) => {
      if (matchesKey(data, Key.enter)) {
        focus = "nav"
        void triggerSave()
        renderLayout()
        return
      }

      if (isShiftTab(data)) {
        focus = "nav"
        renderLayout()
        return
      }

      if (matchesKey(data, Key.tab)) {
        focus = "desc"
        renderLayout()
        return
      }

      titleEditor.handleInput(data)
      requestRender()
    }

    const handleDescInput = (data: string) => {
      if (isExplicitNewLineCommand(data)) {
        descEditor.insertTextAtCursor("\n")
        requestRender()
        return
      }

      if (isShiftTab(data)) {
        focus = "title"
        renderLayout()
        return
      }

      if (matchesKey(data, Key.enter) || matchesKey(data, Key.tab)) {
        focus = "nav"
        void triggerSave()
        renderLayout()
        return
      }

      descEditor.handleInput(data)
      requestRender()
    }

    const handleNavInput = (data: string) => {
      if (relationshipPickerOpen) return

      if (matchesKey(data, Key.enter)) {
        void triggerSave()
        return
      }

      if (matchesKey(data, Key.tab)) {
        focus = "title"
        renderLayout()
        return
      }

      if (matchesKey(data, Key.escape) || matchesKey(data, Key.left) || data === "a" || data === "A") {
        exitForm("back")
        return
      }

      if (data === "p" || data === "P") {
        void chooseParent()
        return
      }

      if (data === "b" || data === "B") {
        void chooseBlockers()
        return
      }

      if (data === "t" || data === "T") {
        taskTypeValue = cycleTaskType(taskTypeValue)
        renderLayout()
        triggerAutoSave()
        return
      }

      if (data === " ") {
        statusValue = cycleStatus(statusValue)
        renderLayout()
        triggerAutoSave()
        return
      }

      const priority = parsePriorityKey(data)
      if (priority !== null) {
        priorityValue = priority
        renderLayout()
        triggerAutoSave()
      }
    }

    return {
      render: (w: number) => container.render(w).map((line: string) => truncateToWidth(line, w)),
      invalidate: () => container.invalidate(),
      dispose: () => {
        disposed = true
        if (saveIndicatorTimer) clearTimeout(saveIndicatorTimer)
      },
      handleInput: (data: string) => {
        if (closeKeys.some(closeKey => matchesKey(data, closeKey))) {
          exitForm("close_list")
          return
        }

        if (focus !== "nav" && matchesKey(data, Key.escape)) {
          focus = "nav"
          renderLayout()
          return
        }

        if (focus === "title") {
          handleTitleInput(data)
          return
        }

        if (focus === "desc") {
          handleDescInput(data)
          return
        }

        handleNavInput(data)
      },
    }
  })
}
