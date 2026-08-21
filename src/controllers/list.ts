import { Key, matchesKey } from "@mariozechner/pi-tui"
import type { TaskListScope } from "../backend/api.ts"
import { buildPriorityHelpText, parsePriorityKey } from "../lib/priority-keys.ts"

export type ListIntent =
  | { type: "cancel" }
  | { type: "back" }
  | { type: "searchStart" }
  | { type: "searchCancel" }
  | { type: "searchApply" }
  | { type: "searchBackspace" }
  | { type: "searchAppend"; value: string }
  | { type: "moveSelection"; delta: number }
  | { type: "work" }
  | { type: "edit" }
  | { type: "toggleStatus" }
  | { type: "closeTask" }
  | { type: "setPriority"; priority: string }
  | { type: "scrollDescription"; delta: number }
  | { type: "toggleType" }
  | { type: "toggleGrouping" }
  | { type: "toggleExpanded" }
  | { type: "toggleScope" }
  | { type: "create" }
  | { type: "createChild" }
  | { type: "insert" }
  | { type: "delegate" }

export interface ListControllerState {
  searching: boolean
  filtered: boolean
  allowSearch: boolean
  allowPriority: boolean
  allowHierarchy: boolean
  scope: TaskListScope
  closeKeys: string[]
  priorities: string[]
  priorityHotkeys?: Record<string, string>
}

type ShortcutContext = "default" | "search"
type ShortcutCategory = "read" | "edit"

interface ShortcutDefinition {
  context: ShortcutContext
  category: ShortcutCategory
  help?: string | ((state: ListControllerState) => string)
  showInHelp?: (state: ListControllerState) => boolean
  match: (data: string, state: ListControllerState) => boolean
  intent: (data: string, state: ListControllerState) => ListIntent
}

function isPrintable(data: string): boolean {
  return data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) < 127
}

function matchesAnyShortcut(data: string, shortcuts: string[]): boolean {
  return shortcuts.some(shortcut => matchesKey(data, shortcut))
}

const MOVE_KEYS: Record<string, number> = {
  w: -1,
  W: -1,
  s: 1,
  S: 1,
}

const SCROLL_KEYS: Record<string, number> = {
  j: 1,
  k: -1,
}

const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
  {
    context: "search",
    category: "read",
    match: (data, state) => matchesAnyShortcut(data, state.closeKeys),
    intent: () => ({ type: "cancel" }),
  },
  {
    context: "search",
    category: "read",
    help: "esc cancel",
    match: (data) => matchesKey(data, Key.escape),
    intent: () => ({ type: "searchCancel" }),
  },
  {
    context: "search",
    category: "read",
    help: "enter apply",
    match: (data) => matchesKey(data, Key.enter),
    intent: () => ({ type: "searchApply" }),
  },
  {
    context: "search",
    category: "read",
    match: (data) => matchesKey(data, Key.backspace),
    intent: () => ({ type: "searchBackspace" }),
  },
  {
    context: "search",
    category: "read",
    help: "type to search",
    match: (data) => isPrintable(data),
    intent: (data) => ({ type: "searchAppend", value: data }),
  },
  {
    context: "default",
    category: "read",
    help: "w/s navigate",
    match: (data) => data in MOVE_KEYS,
    intent: (data) => ({ type: "moveSelection", delta: MOVE_KEYS[data] ?? 1 }),
  },
  {
    context: "default",
    category: "edit",
    help: "enter work",
    match: (data) => matchesKey(data, Key.enter),
    intent: () => ({ type: "work" }),
  },
  {
    context: "default",
    category: "read",
    help: "d details",
    match: (data) => data === "d" || data === "D" || matchesKey(data, Key.right),
    intent: () => ({ type: "edit" }),
  },
  {
    context: "default",
    category: "edit",
    help: (state) => buildPriorityHelpText(state.priorities, state.priorityHotkeys),
    showInHelp: (state) => state.allowPriority,
    match: (data, state) => state.allowPriority && parsePriorityKey(data, state.priorities, state.priorityHotkeys) !== null,
    intent: (data, state) => ({
      type: "setPriority",
      priority: parsePriorityKey(data, state.priorities, state.priorityHotkeys) ?? state.priorities[0] ?? "",
    }),
  },
  {
    context: "default",
    category: "read",
    help: "f find",
    showInHelp: (state) => state.allowSearch,
    match: (data, state) => state.allowSearch && (data === "f" || data === "F"),
    intent: () => ({ type: "searchStart" }),
  },
  {
    context: "default",
    category: "edit",
    help: "space status",
    match: (data) => data === " ",
    intent: () => ({ type: "toggleStatus" }),
  },
  {
    context: "default",
    category: "edit",
    help: "del close",
    match: (data) => matchesKey(data, Key.delete),
    intent: () => ({ type: "closeTask" }),
  },
  {
    context: "default",
    category: "read",
    help: "j/k scroll",
    match: (data) => data in SCROLL_KEYS,
    intent: (data) => ({ type: "scrollDescription", delta: SCROLL_KEYS[data] ?? 1 }),
  },
  {
    context: "default",
    category: "edit",
    help: "t type",
    match: (data) => data === "t" || data === "T",
    intent: () => ({ type: "toggleType" }),
  },
  {
    context: "default",
    category: "read",
    help: "g group",
    showInHelp: state => state.allowHierarchy,
    match: (data, state) => state.allowHierarchy && (data === "g" || data === "G"),
    intent: () => ({ type: "toggleGrouping" }),
  },
  {
    context: "default",
    category: "read",
    help: "e expand",
    showInHelp: state => state.allowHierarchy,
    match: (data, state) => state.allowHierarchy && (data === "e" || data === "E"),
    intent: () => ({ type: "toggleExpanded" }),
  },
  {
    context: "default",
    category: "read",
    help: (state) => (state.scope === "closed" ? "x active" : "x closed"),
    match: (data) => data === "x" || data === "X",
    intent: () => ({ type: "toggleScope" }),
  },
  {
    context: "default",
    category: "edit",
    help: "c create",
    match: (data) => data === "c" || data === "C",
    intent: () => ({ type: "create" }),
  },
  {
    context: "default",
    category: "edit",
    help: "n child",
    showInHelp: state => state.allowHierarchy,
    match: (data, state) => state.allowHierarchy && (data === "n" || data === "N"),
    intent: () => ({ type: "createChild" }),
  },
  {
    context: "default",
    category: "edit",
    help: "tab insert",
    match: (data) => matchesKey(data, Key.tab),
    intent: () => ({ type: "insert" }),
  },
  {
    context: "default",
    category: "read",
    match: (data) => data === "a" || data === "A" || matchesKey(data, Key.left),
    intent: () => ({ type: "back" }),
  },
  {
    context: "default",
    category: "read",
    match: (data, state) => matchesAnyShortcut(data, state.closeKeys),
    intent: () => ({ type: "cancel" }),
  },
]

export function resolveListIntent(data: string, state: ListControllerState): ListIntent {
  const context: ShortcutContext = state.searching ? "search" : "default"
  for (const shortcut of SHORTCUT_DEFINITIONS) {
    if (shortcut.context !== context) continue
    if (shortcut.match(data, state)) return shortcut.intent(data, state)
  }
  return { type: "delegate" }
}

export interface ListHelpTexts {
  /** First row: read-only actions (navigation, browsing, search). */
  primary: string
  /** Second row: actions that modify tasks. */
  secondary: string
}

export function buildListHelpTexts(state: ListControllerState): ListHelpTexts {
  const helpRow = (context: ShortcutContext, category: ShortcutCategory): string =>
    SHORTCUT_DEFINITIONS
      .filter(s => s.context === context && s.category === category)
      .filter(s => !!s.help)
      .filter(s => (s.showInHelp ? s.showInHelp(state) : true))
      .map(s => (typeof s.help === "function" ? s.help(state) : s.help as string))
      .join(" • ")

  const context: ShortcutContext = state.searching ? "search" : "default"
  const readActions = helpRow(context, "read")
  const primary =
    context === "default"
      ? `${readActions} • ${state.filtered ? "a/esc clear filter" : "a/esc back"}`
      : readActions

  return {
    primary,
    secondary: helpRow("default", "edit"),
  }
}
