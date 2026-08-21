import type { Task } from "../../../models/task.ts"
import { PRIORITIES } from "./constants.ts"

function taskStatusSortRank(status: Task["status"]): number {
  if (status === "inProgress") return 0
  if (status === "open") return 1
  if (status === "blocked") return 2
  return 3
}

function taskPrioritySortRank(priority: string | undefined): number {
  if (!priority) return PRIORITIES.length + 1
  const index = PRIORITIES.indexOf(priority)
  return index >= 0 ? index : PRIORITIES.length
}

function closedTaskRecency(task: Task): number {
  const time = Date.parse(task.closedAt ?? task.updatedAt ?? "")
  return Number.isNaN(time) ? -Infinity : time
}

export function sortClosedTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((left, right) => {
    const recencyOrder = closedTaskRecency(right) - closedTaskRecency(left)
    if (recencyOrder !== 0) return recencyOrder

    const priorityOrder = taskPrioritySortRank(left.priority) - taskPrioritySortRank(right.priority)
    if (priorityOrder !== 0) return priorityOrder

    return left.ref.localeCompare(right.ref)
  })
}

export function sortActiveTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((left, right) => {
    const statusOrder = taskStatusSortRank(left.status) - taskStatusSortRank(right.status)
    if (statusOrder !== 0) return statusOrder

    const priorityOrder = taskPrioritySortRank(left.priority) - taskPrioritySortRank(right.priority)
    if (priorityOrder !== 0) return priorityOrder

    return left.ref.localeCompare(right.ref)
  })
}
