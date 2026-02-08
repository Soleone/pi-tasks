import { buildIssueListTextParts, type Issue } from "./issue.ts"

export interface IssueListRowOptions {
  maxLabelWidth?: number
}

export interface IssueListRowModel {
  id: string
  label: string
  description: string
}

export const DESCRIPTION_PART_SEPARATOR = "\u241F"

function encodeDescription(meta: string, summary?: string): string {
  return summary ? `${meta}${DESCRIPTION_PART_SEPARATOR}${summary}` : meta
}

export function decodeDescription(text: string): { meta: string; summary?: string } {
  const [meta, summary] = text.split(DESCRIPTION_PART_SEPARATOR)
  return { meta: meta || "", summary }
}

export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "")
}

export function buildListRowModel(issue: Issue, options: IssueListRowOptions = {}): IssueListRowModel {
  const { maxLabelWidth } = options
  const parts = buildIssueListTextParts(issue)
  const baseLabel = `${parts.identity} ${parts.title}`
  const visibleWidth = stripAnsi(baseLabel).length

  let label = baseLabel
  if (maxLabelWidth !== undefined && visibleWidth < maxLabelWidth) {
    label += " ".repeat(maxLabelWidth - visibleWidth)
  }

  return {
    id: issue.id,
    label,
    description: encodeDescription(parts.meta, parts.summary),
  }
}
