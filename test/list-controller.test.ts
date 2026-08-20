import test from "node:test"
import assert from "node:assert/strict"
import { buildListHelpTexts, resolveListIntent, type ListControllerState } from "../src/controllers/list.ts"
import type { TaskListScope } from "../src/backend/api.ts"

function state(overrides: Partial<ListControllerState> = {}): ListControllerState {
  return {
    searching: false,
    filtered: false,
    allowSearch: true,
    allowPriority: true,
    allowHierarchy: true,
    scope: "active",
    closeKeys: [],
    priorities: ["p0", "p1", "p2", "p3", "p4"],
    ...overrides,
  }
}

test("x toggles task list scope in both cases", () => {
  assert.deepEqual(resolveListIntent("x", state()), { type: "toggleScope" })
  assert.deepEqual(resolveListIntent("X", state()), { type: "toggleScope" })
})

test("scope toggle help shows the scope it switches to", () => {
  const activeHelp = buildListHelpTexts(state({ scope: "active" satisfies TaskListScope }))
  const closedHelp = buildListHelpTexts(state({ scope: "closed" satisfies TaskListScope }))
  assert.match(activeHelp.primary, /x closed/)
  assert.match(closedHelp.primary, /x active/)
})

test("x stays a search character while searching", () => {
  const searchState = state({ searching: true })
  assert.deepEqual(resolveListIntent("x", searchState), { type: "searchAppend", value: "x" })
})