import type { Task } from "../models/task.ts"

export function serializeTask(task: Task): string {
  const parts = [
    `id=${task.id}`,
    `title="${task.title}"`,
    `status=${task.status}`,
    `priority=${task.priority ?? "unknown"}`,
    `type=${task.taskType || "task"}`,
  ]

  const description = task.description?.trim()
  if (description) {
    parts.push(`description="${description.replaceAll("\n", "\\n")}"`)
  }

  return `task(${parts.join(", ")})`
}

export function buildTaskWorkPrompt(task: Task): string {
  const lines = [
    `Work on task ${task.id}: ${task.title}`,
    "",
    `Status: ${task.status}`,
    `Priority: ${task.priority ?? "unknown"}`,
  ]

  if (task.description && task.description.trim()) {
    lines.push("", "Context:", task.description.trim())
  }

  return lines.join("\n")
}
