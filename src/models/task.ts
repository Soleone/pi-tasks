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
  closedAt?: string
  parentRef?: string
  childCount?: number
  blockers?: TaskRelation[]
  dependents?: TaskRelation[]
  dependencyCount?: number
  dependentCount?: number
  commentCount?: number
}

export function toKebabCase(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()
}

export function hasUnresolvedBlockers(task: Pick<Task, "blockers" | "status">): boolean {
  return task.blockers?.some(blocker => blocker.status !== "closed") ?? false
}

export function displayTaskStatus(task: Task): TaskStatus {
  if (task.status === "closed") return "closed"
  if (hasUnresolvedBlockers(task)) return "blocked"
  if (task.status === "blocked") return "open"
  return task.status
}
