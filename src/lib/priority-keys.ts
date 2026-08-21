export function parsePriorityKey(
  data: string,
  priorities: string[],
  priorityHotkeys?: Record<string, string>,
): string | null {
  if (data.length !== 1) return null

  const hotkeyPriority = priorityHotkeys?.[data]
  if (hotkeyPriority && priorities.includes(hotkeyPriority)) return hotkeyPriority

  const rank = parseInt(data, 10)
  if (isNaN(rank) || rank < 1 || rank > priorities.length) return null
  return priorities[rank - 1] ?? null
}

export function buildPriorityHelpText(priorities: string[], priorityHotkeys?: Record<string, string>): string {
  const hotkeyKeys = priorityHotkeys ? Object.keys(priorityHotkeys).sort((a, b) => a.localeCompare(b)) : []
  if (hotkeyKeys.length > 0) {
    return `${hotkeyKeys.join("/")} priority`
  }

  if (priorities.length === 0) return "priority"
  if (priorities.length === 1) return "1 priority"
  return `1-${priorities.length} priority`
}
