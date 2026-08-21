import type { Component } from "@mariozechner/pi-tui"

export class FixedHeightField implements Component {
  constructor(private child: Component, private height: number) {}

  invalidate(): void {
    this.child.invalidate()
  }

  render(width: number): string[] {
    const lines = this.child.render(width)

    if (lines.length === this.height) return lines

    if (lines.length < this.height) {
      return [...lines, ...Array(this.height - lines.length).fill(" ".repeat(Math.max(0, width)))]
    }

    if (this.height <= 1) {
      return [lines[lines.length - 1] || ""]
    }

    const bottomLine = lines[lines.length - 1] || ""
    const bodyLines = lines.slice(0, -1)
    const viewportHeight = this.height - 1

    const cursorIndex = bodyLines.findIndex(line => line.includes("\x1b[7m"))

    let start = Math.max(0, bodyLines.length - viewportHeight)
    if (cursorIndex >= 0) {
      if (cursorIndex < start) {
        start = cursorIndex
      } else if (cursorIndex >= start + viewportHeight) {
        start = cursorIndex - viewportHeight + 1
      }
    }

    const clippedBody = bodyLines.slice(start, start + viewportHeight)
    if (clippedBody.length < viewportHeight) {
      clippedBody.push(...Array(viewportHeight - clippedBody.length).fill(" ".repeat(Math.max(0, width))))
    }

    return [...clippedBody, bottomLine]
  }

  handleInput(data: string): void {
    const childWithInput = this.child as Component & { handleInput?: (input: string) => void }
    childWithInput.handleInput?.(data)
  }
}
