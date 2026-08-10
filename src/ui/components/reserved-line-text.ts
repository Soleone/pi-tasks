import { truncateToWidth, visibleWidth, type Component } from "@mariozechner/pi-tui"

/**
 * Single-line text component. Truncates to fit the available width instead of
 * wrapping, reserving exactly one line in the layout.
 */
export class ReservedLineText implements Component {
  private text = ""

  constructor(private paddingX = 1) {}

  setText(text: string): void {
    this.text = text
  }

  invalidate(): void {}

  render(width: number): string[] {
    const innerWidth = Math.max(0, width - this.paddingX * 2)
    const left = " ".repeat(this.paddingX)
    const right = " ".repeat(this.paddingX)

    if (!this.text || this.text.trim().length === 0) {
      return [`${left}${" ".repeat(innerWidth)}${right}`]
    }

    const content = truncateToWidth(this.text, innerWidth)
    const trailingPadding = Math.max(0, innerWidth - visibleWidth(content))
    return [`${left}${content}${" ".repeat(trailingPadding)}${right}`]
  }
}