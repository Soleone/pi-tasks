import type { Task, TaskStatus } from "../../../models/task.ts"
import { PRIORITIES } from "../shared/constants.ts"

/** Tasks status values per pi-tasks status. `blocked` is derived, never stored. */
export const STATUS_MAP = {
  open: "open",
  inProgress: "in_progress",
  deferred: "paused",
  closed: "done",
} as const

const ACTIVE_BACKEND_STATUSES = ["open", "in_progress", "paused"]
const CLOSED_BACKEND_STATUSES = ["done", "canceled"]

const STATUS_BY_BACKEND: Record<string, TaskStatus> = {
  open: "open",
  in_progress: "inProgress",
  paused: "deferred",
  done: "closed",
  canceled: "closed",
}

const TRANSITION_COMMANDS: Record<string, string> = {
  open: "task.reopen",
  in_progress: "task.start",
  paused: "task.pause",
  done: "task.complete",
}

const CATEGORY_TOKEN_PATTERN = /(^|[^A-Za-z0-9_/@])@([A-Za-z][A-Za-z0-9_-]*)\b/g

/** A Tasks task record as returned by `task.get`, `task.list` and mutations. */
export interface TasksTaskRecord {
  id: string
  title: string
  descriptionMarkdown: string
  status: string
  priority: number
  category: { slug: string } | null
  tags: Array<{ slug: string }>
  parentId: string | null
  dependencyIds: string[]
  blockedByIds: string[]
  version: number
  createdAt: string
  updatedAt: string
  completedAt: string | null
  canceledAt: string | null
}

export function fromBackendStatus(status: string): TaskStatus {
  return STATUS_BY_BACKEND[status] ?? "open"
}

export function toBackendStatus(status: TaskStatus): string {
  const mapped = STATUS_MAP[status as keyof typeof STATUS_MAP]
  if (!mapped) throw new Error(`Unsupported status for tasks backend: ${status}`)
  return mapped
}

export function transitionCommand(status: TaskStatus): string {
  // `toBackendStatus` rejects statuses the backend cannot store, such as the
  // derived `blocked` state.
  const command = TRANSITION_COMMANDS[toBackendStatus(status)]
  if (!command) throw new Error(`Unsupported status for tasks backend: ${status}`)
  return command
}

export function backendStatusesForScope(closed: boolean): string[] {
  return closed ? CLOSED_BACKEND_STATUSES : ACTIVE_BACKEND_STATUSES
}

export function fromBackendPriority(priority: number | undefined | null): string | undefined {
  if (typeof priority !== "number" || !Number.isInteger(priority)) return undefined
  const label = `p${priority}`
  return PRIORITIES.includes(label) ? label : undefined
}

export function toBackendPriority(priority: string | undefined): number | undefined {
  if (!priority) return undefined
  const index = PRIORITIES.indexOf(priority.toLowerCase())
  return index >= 0 ? index : undefined
}

/** Tasks ids are UUIDs; the list only has room for a short, typeable prefix. */
export function shortTaskId(id: string): string {
  return /^[0-9a-f]{8}-/i.test(id) ? id.slice(0, 8) : id
}

export function isFullTaskId(ref: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref.trim())
}

export function categorySlugsIn(text: string): string[] {
  return [...text.matchAll(CATEGORY_TOKEN_PATTERN)]
    .map(match => (match[2] ?? "").toLowerCase())
    .filter(slug => slug.length > 0)
}

/**
 * Tasks derives `@category` and `#tags` from task text, so a category-scoped
 * project has to keep its token in the text or the task leaves the scope. The
 * token goes in the title, where it is visible, and a foreign category is
 * rejected rather than silently retargeting the task.
 */
export function titleWithScope(title: string, description: string, category: string | undefined): string {
  if (!category) return title

  const text = `${title}\n${description}`
  const slugs = categorySlugsIn(text)
  const foreign = slugs.filter(slug => slug !== category)
  if (foreign.length > 0) {
    throw new Error(`This project is scoped to the @${category} category, but the task text uses @${foreign[0]}`)
  }

  return slugs.includes(category) ? title : `${title} @${category}`.trim()
}

export function toTask(
  record: TasksTaskRecord,
  known: ReadonlyMap<string, TasksTaskRecord> = new Map(),
): Task {
  const blockers = record.blockedByIds.map(ref => {
    const blocker = known.get(ref)
    return {
      ref,
      title: blocker?.title?.trim() || undefined,
      status: blocker ? fromBackendStatus(blocker.status) : undefined,
    }
  })

  return {
    ref: record.id,
    id: shortTaskId(record.id),
    title: record.title,
    description: record.descriptionMarkdown,
    // `blockedByIds` is readiness information, not a lifecycle state, so the
    // stored status stays intact and the UI derives the blocked marker.
    status: fromBackendStatus(record.status),
    priority: fromBackendPriority(record.priority),
    // Tasks has no task type concept; one constant value keeps the UI honest.
    taskType: "task",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    closedAt: record.completedAt ?? record.canceledAt ?? undefined,
    parentRef: record.parentId ?? undefined,
    blockers,
    dependencyCount: blockers.length,
  }
}
