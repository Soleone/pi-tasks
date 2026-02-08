import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import type { Task, TaskStatus } from "../models/task.ts"

export type TaskStatusMap = {
  open: string
  inProgress: string
  closed: string
} & Partial<Record<Exclude<TaskStatus, "open" | "inProgress" | "closed">, string>>

export interface TaskUpdate {
  title?: string
  description?: string
  status?: TaskStatus
  priority?: string
  taskType?: string
  dueAt?: string
}

export interface CreateTaskInput extends TaskUpdate {
  title: string
}

export interface TaskAdapter {
  readonly id: string
  readonly statusMap: TaskStatusMap
  readonly taskTypes: string[]
  readonly priorities: string[]
  list(): Promise<Task[]>
  show(id: string): Promise<Task>
  update(id: string, update: TaskUpdate): Promise<void>
  create(input: CreateTaskInput): Promise<Task>
}

export interface TaskAdapterInitializer {
  readonly id: string
  isApplicable(): boolean
  initialize(pi: ExtensionAPI): TaskAdapter
}
