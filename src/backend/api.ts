import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import type { Task, TaskStatus } from "../models/task.ts"

export type TaskStatusMap = {
  open: string
  closed: string
  inProgress?: string
} & Partial<Record<Exclude<TaskStatus, "open" | "inProgress" | "closed">, string>>

export type TaskListScope = "active" | "closed"

export interface TaskUpdate {
  title?: string
  description?: string
  status?: TaskStatus
  priority?: string
  taskType?: string
  dueAt?: string
  parentRef?: string | null
  blockedBy?: string[]
}

export interface CreateTaskInput extends TaskUpdate {
  title: string
}

export interface TaskSessionContextMessage {
  customType: string
  content: string
}

export interface TaskAdapterCapabilities {
  hierarchy: "native" | "metadata" | "markdown" | "none"
  dependencies: "native" | "metadata" | "none"
}

export interface TaskAdapter {
  readonly id: string
  readonly capabilities: TaskAdapterCapabilities
  readonly statusMap: TaskStatusMap
  readonly taskTypes: string[]
  readonly priorities: string[]
  readonly priorityHotkeys?: Record<string, string>
  readonly sessionContextMessage?: TaskSessionContextMessage
  invalidateCache?(): void
  list(scope?: TaskListScope): Promise<Task[]>
  show(ref: string): Promise<Task>
  update(ref: string, update: TaskUpdate): Promise<void>
  create(input: CreateTaskInput): Promise<Task>
}

/** Selection tier reported by each backend's environment/project detector. */
export type TaskAdapterDetection = "project" | "default" | "fallback" | "final" | undefined

export interface TaskAdapterInitializer {
  readonly id: string
  /** Reports how this backend applies to the current project and environment. */
  detect(): TaskAdapterDetection
  initialize(pi: ExtensionAPI): TaskAdapter
}
