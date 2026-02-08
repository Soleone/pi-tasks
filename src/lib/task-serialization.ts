import type { Task } from "../models/task.ts"
import { toKebabCase } from "../models/task.ts"

export function serializeTask(task: Task): string {
  const parts = [
    `id=${task.id}`,
    `title="${task.title}"`,
    `status=${toKebabCase(task.status)}`,
    `priority=${task.priority ?? "unknown"}`,
    `type=${task.taskType || "task"}`,
  ]

  const description = task.description?.trim()
  if (description) {
    parts.push(`description="${description.replaceAll("\n", "\\n")}"`)
  }

  if (task.dueAt) {
    parts.push(`due="${task.dueAt}"`)
  }

  return `task(${parts.join(", ")})`
}

export function buildTaskWorkPrompt(task: Task): string {
  const lines = [
    `Work on task ${task.id}: ${task.title}`,
    "",
    `Status: ${toKebabCase(task.status)}`,
    `Priority: ${task.priority ?? "unknown"}`,
  ]

  if (task.description && task.description.trim()) {
    lines.push("", "Context:", task.description.trim())
  }

  return lines.join("\n")
}
