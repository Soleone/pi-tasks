export type TaskStatus = "open" | "inProgress" | "blocked" | "deferred" | "closed"

export interface TaskRelation {
  ref: string
  title?: string
  status?: TaskStatus
}

export interface Task {
  ref: string
  id?: string
  title: string
  description?: string
  status: TaskStatus
  priority?: string
  taskType?: string
  owner?: string
  createdAt?: string
  dueAt?: string
  updatedAt?: string
  parentRef?: string
  childCount?: number
  blockers?: TaskRelation[]
  dependents?: TaskRelation[]
  dependencyCount?: number
  dependentCount?: number
  commentCount?: number
}

interface TaskListElements {
  id?: string
  title: string
  status: string
  type: string
  summary?: string
}

export interface TaskListTextParts {
  identity: string
  title: string
  meta: string
  summary?: string
}

const PRIORITY_RANK_COLORS = [
  "\x1b[38;5;196m",
  "\x1b[38;5;208m",
  "\x1b[38;5;34m",
  "\x1b[38;5;33m",
  "\x1b[38;5;245m",
]

const STATUS_SYMBOLS: Record<TaskStatus, string> = {
  open: "○",
  inProgress: "◑",
  blocked: "✖",
  deferred: "⏸",
  closed: "✓",
}

const MUTED_TEXT = "\x1b[38;5;245m"
const ANSI_RESET = "\x1b[0m"

function priorityRank(priority: string | undefined): number | undefined {
  if (!priority) return undefined
  const match = priority.toLowerCase().match(/^p(\d)$/)
  if (!match) return undefined
  return Number(match[1])
}

export function formatTaskPriority(priority: string | undefined): string {
  if (priority === undefined || priority === null || priority.length === 0) return "P?"

  const rank = priorityRank(priority)
  const color = rank !== undefined ? PRIORITY_RANK_COLORS[rank] ?? "" : ""
  return `${color}${priority.toUpperCase()}${ANSI_RESET}`
}

function stripIdPrefix(id: string): string {
  const idx = id.indexOf("-")
  return idx >= 0 ? id.slice(idx + 1) : id
}

export function formatTaskTypeCode(taskType: string | undefined): string {
  return (taskType || "task").slice(0, 4).padEnd(4)
}

export function toKebabCase(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()
}

export function hasUnresolvedBlockers(task: Pick<Task, "blockers" | "status">): boolean {
  return task.blockers?.some(blocker => blocker.status !== "closed") ?? false
}

export function displayTaskStatus(task: Task): TaskStatus {
  if (task.status === "open" && hasUnresolvedBlockers(task)) return "blocked"
  return task.status
}

export function formatTaskStatusSymbol(status: TaskStatus): string {
  return STATUS_SYMBOLS[status] ?? "?"
}

function firstLine(text: string | undefined): string | undefined {
  if (!text) return undefined
  const line = text.split(/\r?\n/)[0]?.trim()
  return line && line.length > 0 ? line : undefined
}

function formatBlockerSummary(task: Task): string | undefined {
  const unresolved = task.blockers?.filter(blocker => blocker.status !== "closed") ?? []
  if (unresolved.length === 0) return undefined
  const shown = unresolved.slice(0, 2).map(blocker => blocker.ref).join(",")
  const remaining = unresolved.length - 2
  return `← ${shown}${remaining > 0 ? ` +${remaining}` : ""}`
}

function buildTaskListElements(task: Task): TaskListElements {
  const blockerSummary = formatBlockerSummary(task)
  return {
    id: task.id ? stripIdPrefix(task.id) : undefined,
    title: task.title,
    status: formatTaskStatusSymbol(displayTaskStatus(task)),
    type: `${formatTaskTypeCode(task.taskType)}${blockerSummary ? ` ${blockerSummary}` : ""}`,
    summary: firstLine(task.description),
  }
}

export function buildTaskIdentityText(priority: string | undefined, idText?: string): string {
  if (!idText) return formatTaskPriority(priority)
  const mutedId = `${MUTED_TEXT}${idText}${ANSI_RESET}`
  return `${formatTaskPriority(priority)} ${mutedId}`
}

export function buildTaskListTextParts(task: Task): TaskListTextParts {
  const elements = buildTaskListElements(task)

  return {
    identity: buildTaskIdentityText(task.priority, elements.id),
    title: elements.title,
    meta: `${elements.status} ${elements.type}`,
    summary: elements.summary,
  }
}
