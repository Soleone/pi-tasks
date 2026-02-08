import type { Issue } from "./issue.ts"

export function serializeReference(issue: Issue): string {
  const parts = [
    `id=${issue.id}`,
    `title="${issue.title}"`,
    `status=${issue.status}`,
    `priority=${issue.priority ?? "unknown"}`,
    `type=${issue.issue_type || "issue"}`,
  ]

  const description = issue.description?.trim()
  if (description) {
    parts.push(`description="${description.replaceAll("\n", "\\n")}"`)
  }

  return `task(${parts.join(", ")})`
}

export function buildWorkPrompt(issue: Issue): string {
  const lines = [
    `Work on task ${issue.id}: ${issue.title}`,
    "",
    `Status: ${issue.status}`,
    `Priority: ${issue.priority ?? "unknown"}`,
  ]

  if (issue.description && issue.description.trim()) {
    lines.push("", "Context:", issue.description.trim())
  }

  return lines.join("\n")
}
