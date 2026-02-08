import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import type { Task, TaskStatus } from "../models/task.ts"

export interface TaskUpdate {
  title?: string
  description?: string
  status?: TaskStatus
  priority?: number
  taskType?: string
}

export interface CreateTaskInput extends TaskUpdate {
  title: string
}

export interface TaskAdapter {
  readonly id: string
  readonly statusCycle: TaskStatus[]
  readonly taskTypes: string[]
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
