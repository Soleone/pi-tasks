import type { Task, TaskStatus } from "../models/task.ts"
import { wouldCreateDependencyCycle, wouldCreateParentCycle } from "../models/task-hierarchy.ts"
import type { TaskAdapterCapabilities, TaskUpdate } from "../backend/api.ts"

export function cycleStatus(current: TaskStatus, statusMap: Record<string, string>): TaskStatus {
  const statusCycle = Object.keys(statusMap) as TaskStatus[]
  if (statusCycle.length === 0) return "open"
  const normalizedCurrent = current === "blocked" ? "open" : current
  const idx = statusCycle.indexOf(normalizedCurrent)
  if (idx === -1) return statusCycle[0]
  return statusCycle[(idx + 1) % statusCycle.length]
}

export function cycleTaskType(current: string | undefined, taskTypes: string[]): string {
  if (taskTypes.length === 0) return "task"
  const normalized = current || taskTypes[0]
  const idx = taskTypes.indexOf(normalized)
  if (idx === -1) return taskTypes[0]
  return taskTypes[(idx + 1) % taskTypes.length]
}

export function defaultPriority(priorities: string[]): string | undefined {
  if (priorities.length === 0) return undefined
  return priorities[Math.floor(priorities.length / 2)]
}

export function defaultTaskType(taskTypes: string[]): string | undefined {
  return taskTypes[0]
}

export function hasUniqueValues(values: string[]): boolean {
  return new Set(values).size === values.length
}

export function validateBackendConfiguration(backend: {
  id: string
  statusMap: Record<string, string>
  taskTypes: string[]
  priorities: string[]
  priorityHotkeys?: Record<string, string>
}): void {
  const statusKeys = Object.keys(backend.statusMap)
  if (statusKeys.length === 0) {
    throw new Error(`Invalid backend config (${backend.id}): statusMap must not be empty`)
  }

  if (!statusKeys.includes("open") || !statusKeys.includes("closed")) {
    throw new Error(`Invalid backend config (${backend.id}): statusMap must include open and closed`)
  }

  if (backend.taskTypes.length === 0) {
    throw new Error(`Invalid backend config (${backend.id}): taskTypes must not be empty`)
  }

  if (!hasUniqueValues(backend.taskTypes)) {
    throw new Error(`Invalid backend config (${backend.id}): taskTypes must be unique`)
  }

  if (backend.priorities.length < 3 || backend.priorities.length > 5) {
    throw new Error(`Invalid backend config (${backend.id}): priorities must contain 3 to 5 values`)
  }

  if (!hasUniqueValues(backend.priorities)) {
    throw new Error(`Invalid backend config (${backend.id}): priorities must be unique`)
  }

  if (backend.priorityHotkeys) {
    for (const [key, priority] of Object.entries(backend.priorityHotkeys)) {
      if (key.length !== 1) {
        throw new Error(`Invalid backend config (${backend.id}): priority hotkey keys must be a single character`)
      }

      if (!backend.priorities.includes(priority)) {
        throw new Error(`Invalid backend config (${backend.id}): priority hotkey ${key} points to unsupported priority ${priority}`)
      }
    }
  }
}

export interface DraftRelationships {
  parentRef?: string
  blockedBy?: string[]
}

export function supportedDraftRelationships(
  draft: DraftRelationships,
  capabilities: TaskAdapterCapabilities,
): DraftRelationships {
  const relationships: DraftRelationships = {}
  if (capabilities.hierarchy !== "none") relationships.parentRef = draft.parentRef
  if (capabilities.dependencies !== "none") relationships.blockedBy = draft.blockedBy
  return relationships
}

export function buildTaskUpdate(previous: Task, next: {
  title: string
  description: string
  status: TaskStatus
  priority: string | undefined
  taskType: string | undefined
  parentRef?: string
  blockedBy?: string[]
}, allTasks: Task[] = []): TaskUpdate {
  const update: TaskUpdate = {}

  const nextTitle = next.title.trim()
  if (nextTitle !== previous.title.trim()) {
    update.title = nextTitle
  }

  if (next.description !== (previous.description ?? "")) {
    update.description = next.description
  }

  if (next.status !== previous.status) {
    update.status = next.status
  }

  if (next.priority !== previous.priority && next.priority !== undefined) {
    update.priority = next.priority
  }

  if (next.taskType !== previous.taskType) {
    update.taskType = next.taskType || "task"
  }

  if (Object.prototype.hasOwnProperty.call(next, "parentRef") && next.parentRef !== previous.parentRef) {
    if (wouldCreateParentCycle(allTasks, previous.ref, next.parentRef)) {
      throw new Error("A task cannot be its own parent or a descendant of itself")
    }
    update.parentRef = next.parentRef ?? null
  }

  if (Object.prototype.hasOwnProperty.call(next, "blockedBy") && next.blockedBy !== undefined) {
    const previousBlockers = (previous.blockers ?? []).map(blocker => blocker.ref).sort()
    const nextBlockers = [...new Set(next.blockedBy)].sort()
    if (nextBlockers.includes(previous.ref)) throw new Error("A task cannot block itself")
    if (wouldCreateDependencyCycle(allTasks, previous.ref, nextBlockers)) {
      throw new Error("Blocked-by relationships cannot contain a cycle")
    }
    if (JSON.stringify(previousBlockers) !== JSON.stringify(nextBlockers)) {
      update.blockedBy = nextBlockers
    }
  }

  return update
}

export function hasTaskUpdate(update: TaskUpdate): boolean {
  return Object.keys(update).length > 0
}

export function applyDraftToTask(
  task: Task,
  draft: {
    title: string
    description: string
    status: TaskStatus
    priority: string | undefined
    taskType: string | undefined
    parentRef?: string
    blockedBy?: string[]
  },
  candidates: Task[] = [],
): Task {
  const nextTask: Task = {
    ...task,
    title: draft.title.trim(),
    description: draft.description,
    status: draft.status,
  }

  if (draft.priority !== undefined) {
    nextTask.priority = draft.priority
  } else {
    delete nextTask.priority
  }

  if (draft.taskType !== undefined) {
    nextTask.taskType = draft.taskType
  } else {
    delete nextTask.taskType
  }

  if (Object.prototype.hasOwnProperty.call(draft, "parentRef")) {
    if (draft.parentRef !== undefined) nextTask.parentRef = draft.parentRef
    else delete nextTask.parentRef
  }

  if (Object.prototype.hasOwnProperty.call(draft, "blockedBy") && draft.blockedBy !== undefined) {
    const byRef = new Map(candidates.map(candidate => [candidate.ref, candidate]))
    const existingByRef = new Map((task.blockers ?? []).map(blocker => [blocker.ref, blocker]))
    nextTask.blockers = draft.blockedBy.map(ref => {
      const candidate = byRef.get(ref)
      const existing = existingByRef.get(ref)
      return {
        ref,
        title: candidate?.title ?? existing?.title,
        status: candidate?.status ?? existing?.status,
      }
    })
    nextTask.dependencyCount = nextTask.blockers.length
  }

  return nextTask
}
