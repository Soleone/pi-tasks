import type { TaskStatus } from "../models/task.ts"
import type { TaskAdapterCapabilities } from "../backend/api.ts"
import { buildPriorityHelpText } from "../lib/priority-keys.ts"

export type FormFocus = "nav" | "title" | "desc"
export type FormMode = "edit" | "create"

export interface FormDraft {
  title: string
  description: string
  status: TaskStatus
  priority: string | undefined
  taskType: string | undefined
  parentRef?: string
  blockedBy?: string[]
}

type HeaderStatusColor = "dim" | "accent" | "warning"

export interface HeaderStatus {
  message: string
  icon?: string
  color: HeaderStatusColor
}

const FOCUS_LABELS: Record<Exclude<FormFocus, "nav">, string> = {
  title: "Title",
  desc: "Description",
}

export function normalizeDraft(draft: FormDraft): FormDraft {
  return {
    ...draft,
    title: draft.title.trim(),
    blockedBy: draft.blockedBy ? [...draft.blockedBy].sort() : undefined,
  }
}

export function isSameDraft(a: FormDraft, b: FormDraft): boolean {
  const left = normalizeDraft(a)
  const right = normalizeDraft(b)
  return (
    left.title === right.title &&
    left.description === right.description &&
    left.status === right.status &&
    left.priority === right.priority &&
    left.taskType === right.taskType &&
    left.parentRef === right.parentRef &&
    JSON.stringify(left.blockedBy ?? []) === JSON.stringify(right.blockedBy ?? [])
  )
}

export function getHeaderStatus(
  saveIndicator: "saving" | "saved" | "error" | undefined,
  focus: FormFocus,
): HeaderStatus | undefined {
  if (saveIndicator === "saving") return { message: "Saving…", icon: "⟳", color: "dim" }
  if (saveIndicator === "saved") return { message: "Saved", icon: "✓", color: "accent" }
  if (saveIndicator === "error") return { message: "Save failed", color: "warning" }
  if (focus === "title" || focus === "desc") return { message: `Editing ${FOCUS_LABELS[focus].toLowerCase()}`, color: "accent" }
  return undefined
}

export function buildPrimaryHelpText(focus: FormFocus): string {
  if (focus === "title") return "shift+tab nav • enter save • tab description • esc nav"
  if (focus === "desc") return "shift+enter newline • shift+tab title • enter save • esc nav"
  return "tab title • enter save • a/esc back"
}

export function buildSecondaryHelpText(
  focus: FormFocus,
  priorities: string[],
  priorityHotkeys?: Record<string, string>,
  relationshipCapabilities: TaskAdapterCapabilities = { hierarchy: "none", dependencies: "none" },
): string {
  if (focus !== "nav") return ""
  const relationships = [
    relationshipCapabilities.hierarchy !== "none" ? "p parent" : "",
    relationshipCapabilities.dependencies !== "none" ? "b blockers" : "",
  ].filter(Boolean)
  return ["space status", buildPriorityHelpText(priorities, priorityHotkeys), "t type", ...relationships].join(" • ")
}
