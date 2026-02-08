export type IssueStatus = "open" | "in_progress" | "blocked" | "deferred" | "closed"

export interface Issue {
  id: string
  title: string
  description?: string
  status: IssueStatus
  priority?: number
  issue_type?: string
  owner?: string
  created_at?: string
  updated_at?: string
  dependency_count?: number
  dependent_count?: number
  comment_count?: number
}

interface IssueListElements {
  id: string
  title: string
  status: string
  type: string
  summary?: string
}

export interface IssueListTextParts {
  identity: string
  title: string
  meta: string
  summary?: string
}

const PRIORITY_COLORS: Record<number, string> = {
  0: "\x1b[38;5;196m",
  1: "\x1b[38;5;208m",
  2: "\x1b[38;5;34m",
  3: "\x1b[38;5;33m",
  4: "\x1b[38;5;245m",
}

const STATUS_SYMBOLS: Record<IssueStatus, string> = {
  open: "○",
  in_progress: "◑",
  blocked: "✖",
  deferred: "⏸",
  closed: "✓",
}

const MUTED_TEXT = "\x1b[38;5;245m"
const ANSI_RESET = "\x1b[0m"

export function formatIssuePriority(priority: number | undefined): string {
  if (priority === undefined || priority === null) return "P?"
  const color = PRIORITY_COLORS[priority] ?? ""
  return `${color}P${priority}${ANSI_RESET}`
}

function stripIdPrefix(id: string): string {
  const idx = id.indexOf("-")
  return idx >= 0 ? id.slice(idx + 1) : id
}

export function formatIssueTypeCode(issueType: string | undefined): string {
  return (issueType || "issue").slice(0, 4).padEnd(4)
}

export function formatIssueStatusSymbol(status: IssueStatus): string {
  return STATUS_SYMBOLS[status] ?? "?"
}

function firstLine(text: string | undefined): string | undefined {
  if (!text) return undefined
  const line = text.split(/\r?\n/)[0]?.trim()
  return line && line.length > 0 ? line : undefined
}

function buildIssueListElements(issue: Issue): IssueListElements {
  return {
    id: stripIdPrefix(issue.id),
    title: issue.title,
    status: formatIssueStatusSymbol(issue.status),
    type: formatIssueTypeCode(issue.issue_type),
    summary: firstLine(issue.description),
  }
}

export function buildIssueIdentityText(priority: number | undefined, idText: string): string {
  const mutedId = `${MUTED_TEXT}${idText}${ANSI_RESET}`
  return `${formatIssuePriority(priority)} ${mutedId}`
}

export function buildIssueListTextParts(issue: Issue): IssueListTextParts {
  const elements = buildIssueListElements(issue)

  return {
    identity: buildIssueIdentityText(issue.priority, elements.id),
    title: elements.title,
    meta: `${elements.status} ${elements.type}`,
    summary: elements.summary,
  }
}
