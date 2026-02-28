import { Editor, Text, type Component, type EditorTheme, type Focusable } from "@mariozechner/pi-tui"

interface BlurEditorFieldOptions {
  stripTopBorder?: boolean
  blurredBorderColor?: (str: string) => string
  paddingX?: number
  indentX?: number
  cursorGlyph?: string
  focusedCursorColor?: (str: string) => string
}

const INVERSE_CURSOR_SEGMENT = /\x1b\[7m([\s\S]*?)\x1b\[(?:0|27)m/

export class BlurEditorField implements Component, Focusable {
  focused = false
  onChange?: (text: string) => void

  private editor: Editor
  private previewText: Text
  private stripTopBorder: boolean
  private blurredBorderColor: (str: string) => string
  private indentX: number
  private cursorGlyph: string
  private focusedCursorColor: (str: string) => string

  constructor(tui: any, theme: EditorTheme, options: BlurEditorFieldOptions = {}) {
    const paddingX = options.paddingX ?? 1

    this.editor = new Editor(tui, theme)
    this.editor.setPaddingX(paddingX)
    this.previewText = new Text("", paddingX, 0)
    this.stripTopBorder = options.stripTopBorder ?? true
    this.blurredBorderColor = options.blurredBorderColor ?? theme.borderColor
    this.indentX = Math.max(0, options.indentX ?? 0)
    this.cursorGlyph = options.cursorGlyph ?? "▏"
    this.focusedCursorColor = options.focusedCursorColor ?? ((str: string) => str)

    this.editor.onChange = (text: string) => {
      this.onChange?.(text)
    }
  }

  set disableSubmit(value: boolean) {
    this.editor.disableSubmit = value
  }

  setText(text: string): void {
    this.editor.setText(text)
  }

  getText(): string {
    return this.editor.getText()
  }

  insertTextAtCursor(text: string): void {
    this.editor.insertTextAtCursor(text)
  }

  invalidate(): void {
    this.editor.invalidate()
    this.previewText.invalidate()
  }

  private replaceBlockCursor(line: string): string {
    const cursor = this.focusedCursorColor(this.cursorGlyph)
    return line.replace(INVERSE_CURSOR_SEGMENT, cursor)
  }

  private stylizeCursor(lines: string[]): string[] {
    let replaced = false

    return lines.map((line) => {
      if (replaced) return line

      const updated = this.replaceBlockCursor(line)
      if (updated !== line) {
        replaced = true
      }
      return updated
    })
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - this.indentX)
    const indent = " ".repeat(this.indentX)
    const withIndent = (lines: string[]) => lines.map(line => `${indent}${line}`)

    if (!this.focused) {
      this.previewText.setText(this.editor.getText())
      const contentLines = this.previewText.render(innerWidth)
      const lines = contentLines.length > 0 ? contentLines : [" ".repeat(Math.max(0, innerWidth))]
      const borderLine = this.blurredBorderColor("─".repeat(Math.max(0, innerWidth)))
      return withIndent([...lines, borderLine])
    }

    const lines = this.editor.render(innerWidth)
    const visibleLines = !this.stripTopBorder || lines.length <= 1 ? lines : lines.slice(1)
    const styledLines = this.stylizeCursor(visibleLines)
    return withIndent(styledLines)
  }

  handleInput(data: string): void {
    if (!this.focused) return
    this.editor.handleInput(data)
  }
}
