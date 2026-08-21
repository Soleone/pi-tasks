import { stripAnsi } from "../models/list-item.ts"

export function wrapText(text: string, width: number, maxLines: number): string[] {
  const lines: string[] = []
  const safeWidth = Math.max(1, width)

  if (text.length === 0) return [""]

  const words = text.split(" ")
  let currentLine = ""

  const flushLine = () => {
    if (lines.length < maxLines) lines.push(currentLine)
    currentLine = ""
  }

  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word

    if (stripAnsi(candidate).length <= safeWidth) {
      currentLine = candidate
      continue
    }

    if (currentLine) {
      flushLine()
      if (lines.length >= maxLines) break
    }

    let remaining = word
    while (stripAnsi(remaining).length > safeWidth) {
      const chunk = remaining.slice(0, safeWidth)
      if (lines.length < maxLines) lines.push(chunk)
      if (lines.length >= maxLines) break
      remaining = remaining.slice(safeWidth)
    }
    if (lines.length >= maxLines) break
    currentLine = remaining
  }

  if (currentLine && lines.length < maxLines) lines.push(currentLine)
  return lines.slice(0, maxLines)
}

export function buildDescText(descLines: string[], width: number): string {
  const wrappedLines: string[] = []
  for (const line of descLines) {
    const wrapped = wrapText(line, width, 7 - wrappedLines.length)
    wrappedLines.push(...wrapped)
    if (wrappedLines.length >= 7) break
  }
  while (wrappedLines.length < 7) wrappedLines.push("")
  return wrappedLines.join("\n")
}
