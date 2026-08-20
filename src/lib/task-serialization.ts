import type { Task } from "../models/task.ts"
import { toKebabCase } from "../models/task.ts"

export function serializeTask(task: Task): string {
  const parts = [
    `title="${task.title}"`,
    `status=${toKebabCase(task.status)}`,
    `priority=${task.priority ?? "unknown"}`,
    `type=${task.taskType || "task"}`,
  ]

  if (task.id) {
    parts.unshift(`id=${task.id}`)
  }

  const description = task.description?.trim()
  if (description) {
    parts.push(`description="${description.replaceAll("\n", "\\n")}"`)
  }

  if (task.dueAt) {
    parts.push(`due="${task.dueAt}"`)
  }

  if (task.parentRef) {
    parts.push(`parent=${task.parentRef}`)
  }

  if (task.blockers?.length) {
    parts.push(`blocked-by=${task.blockers.map(blocker => blocker.ref).join("|")}`)
  }

  return `task(${parts.join(", ")})`
}

export function buildTaskWorkPrompt(task: Task): string {
  const leadLine = task.id
    ? `Work on task ${task.id}: ${task.title}`
    : `Work on task: ${task.title}`

  const lines = [
    leadLine,
    "",
    "Action required: immediately mark this task as in progress before doing any other work. Use the configured task backend and wait for the update to succeed.",
    "",
    `Status: ${toKebabCase(task.status)}`,
    `Priority: ${task.priority ?? "unknown"}`,
  ]

  if (task.parentRef) lines.push(`Parent: ${task.parentRef}`)
  if (task.blockers?.length) lines.push(`Blocked by: ${task.blockers.map(blocker => blocker.ref).join(", ")}`)

  if (task.description && task.description.trim()) {
    lines.push("", "Context:", task.description.trim())
  }

  return lines.join("\n")
}
