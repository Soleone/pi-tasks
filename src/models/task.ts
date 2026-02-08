export type TaskStatus = "open" | "in_progress" | "blocked" | "deferred" | "closed"

export interface Task {
  id: string
  title: string
  description?: string
  status: TaskStatus
  priority?: number
  taskType?: string
  owner?: string
  createdAt?: string
  updatedAt?: string
  dependencyCount?: number
  dependentCount?: number
  commentCount?: number
}

interface TaskListElements {
  id: string
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

const PRIORITY_COLORS: Record<number, string> = {
  0: "\x1b[38;5;196m",
  1: "\x1b[38;5;208m",
  2: "\x1b[38;5;34m",
  3: "\x1b[38;5;33m",
  4: "\x1b[38;5;245m",
}

const STATUS_SYMBOLS: Record<TaskStatus, string> = {
  open: "○",
  in_progress: "◑",
  blocked: "✖",
  deferred: "⏸",
  closed: "✓",
}

const MUTED_TEXT = "\x1b[38;5;245m"
const ANSI_RESET = "\x1b[0m"

export function formatTaskPriority(priority: number | undefined): string {
  if (priority === undefined || priority === null) return "P?"
  const color = PRIORITY_COLORS[priority] ?? ""
  return `${color}P${priority}${ANSI_RESET}`
}

function stripIdPrefix(id: string): string {
  const idx = id.indexOf("-")
  return idx >= 0 ? id.slice(idx + 1) : id
}

export function formatTaskTypeCode(taskType: string | undefined): string {
  return (taskType || "task").slice(0, 4).padEnd(4)
}

export function formatTaskStatusSymbol(status: TaskStatus): string {
  return STATUS_SYMBOLS[status] ?? "?"
}

function firstLine(text: string | undefined): string | undefined {
  if (!text) return undefined
  const line = text.split(/\r?\n/)[0]?.trim()
  return line && line.length > 0 ? line : undefined
}

function buildTaskListElements(task: Task): TaskListElements {
  return {
    id: stripIdPrefix(task.id),
    title: task.title,
    status: formatTaskStatusSymbol(task.status),
    type: formatTaskTypeCode(task.taskType),
    summary: firstLine(task.description),
  }
}

export function buildTaskIdentityText(priority: number | undefined, idText: string): string {
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

