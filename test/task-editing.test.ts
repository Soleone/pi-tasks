import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  applyDraftToTask,
  buildTaskUpdate,
  cycleStatus,
  cycleTaskType,
  defaultPriority,
  validateBackendConfiguration,
} from "../src/lib/task-editing.ts"
import type { Task } from "../src/models/task.ts"

function task(overrides: Partial<Task> = {}): Task {
  return { ref: "t1", title: "Title", description: "", status: "open", ...overrides }
}

const noopDraft = { title: "Title", description: "", status: "open" as const, priority: undefined, taskType: undefined }

describe("buildTaskUpdate", () => {
  it("returns an empty update when nothing changed", () => {
    assert.deepEqual(buildTaskUpdate(task(), noopDraft), {})
  })

  it("trims titles and detects trimmed changes", () => {
    assert.deepEqual(buildTaskUpdate(task(), { ...noopDraft, title: "  New  " }), { title: "New" })
    assert.deepEqual(buildTaskUpdate(task({ title: " Old " }), { ...noopDraft, title: "Old" }), {})
  })

  it("detects status changes", () => {
    assert.deepEqual(buildTaskUpdate(task(), { ...noopDraft, status: "closed" }), { status: "closed" })
  })

  it("skips undefined priority even when previous had one", () => {
    const update = buildTaskUpdate(task({ priority: "p1" }), noopDraft)
    assert.deepEqual(update, {})
  })

  it("throws when parentRef would create a cycle", () => {
    const a = task({ ref: "a" })
    const b = task({ ref: "b", parentRef: "a" })
    assert.throws(() => buildTaskUpdate(a, { ...noopDraft, parentRef: "b" }, [a, b]))
  })

  it("accepts a valid parentRef", () => {
    const a = task({ ref: "a" })
    const b = task({ ref: "b" })
    assert.deepEqual(buildTaskUpdate(b, { ...noopDraft, parentRef: "a" }, [a, b]), { parentRef: "a" })
  })

  it("throws when a task blocks itself", () => {
    assert.throws(() => buildTaskUpdate(task(), { ...noopDraft, blockedBy: ["t1"] }))
  })

  it("normalizes blockers and skips no-op updates", () => {
    const prev = task({ blockers: [{ ref: "a" }, { ref: "b" }] })
    assert.deepEqual(buildTaskUpdate(prev, { ...noopDraft, blockedBy: ["b", "a", "b"] }), {})
    assert.deepEqual(buildTaskUpdate(prev, { ...noopDraft, blockedBy: ["c"] }), { blockedBy: ["c"] })
  })

  it("rejects dependency cycles", () => {
    const a = task({ ref: "a", blockers: [{ ref: "b" }] })
    const b = task({ ref: "b" })
    assert.throws(() => buildTaskUpdate(b, { ...noopDraft, blockedBy: ["a"] }, [a, b]))
  })
})

describe("applyDraftToTask", () => {
  it("applies scalars, clears unset optionals, and leaves absent keys alone", () => {
    const base = task({ priority: "p1", taskType: "bug", parentRef: "root" })
    const next = applyDraftToTask(base, { title: " T ", description: "d", status: "closed", priority: undefined, taskType: undefined })
    assert.equal(next.title, "T")
    assert.equal(next.description, "d")
    assert.equal(next.status, "closed")
    assert.equal(next.priority, undefined)
    assert.equal(next.taskType, undefined)
    assert.equal(next.parentRef, "root")
  })

  it("rebuilds blockers from candidate tasks", () => {
    const c1 = task({ ref: "c1", title: "C1", status: "open" })
    const base = task({ blockers: [{ ref: "c1", title: "Stale" }] })
    const next = applyDraftToTask(base, { ...noopDraft, blockedBy: ["c1"] }, [c1])
    assert.deepEqual(next.blockers, [{ ref: "c1", title: "C1", status: "open" }])
    assert.equal(next.dependencyCount, 1)
  })
})

describe("cycles and defaults", () => {
  const statusMap = { open: "pending", inProgress: "in_progress", closed: "closed" }

  it("cycles status through the backend status map and treats blocked as open", () => {
    assert.equal(cycleStatus("open", statusMap), "inProgress")
    assert.equal(cycleStatus("inProgress", statusMap), "closed")
    assert.equal(cycleStatus("closed", statusMap), "open")
    assert.equal(cycleStatus("blocked", statusMap), "inProgress")
  })

  it("cycles task types and falls back to the first", () => {
    assert.equal(cycleTaskType(undefined, ["a", "b"]), "b")
    assert.equal(cycleTaskType("b", ["a", "b"]), "a")
    assert.equal(cycleTaskType("unknown", ["a"]), "a")
    assert.equal(cycleTaskType("anything", []), "task")
  })

  it("picks the middle priority by default", () => {
    assert.equal(defaultPriority(["p0", "p1", "p2"]), "p1")
    assert.equal(defaultPriority([]), undefined)
  })
})

describe("validateBackendConfiguration", () => {
  const valid = {
    id: "x",
    statusMap: { open: "o", closed: "c" },
    taskTypes: ["task"],
    priorities: ["p0", "p1", "p2"],
  }

  it("accepts a valid config", () => {
    assert.doesNotThrow(() => validateBackendConfiguration(valid))
  })

  it("rejects broken configs", () => {
    assert.throws(() => validateBackendConfiguration({ ...valid, statusMap: {} }))
    assert.throws(() => validateBackendConfiguration({ ...valid, statusMap: { open: "o" } }))
    assert.throws(() => validateBackendConfiguration({ ...valid, taskTypes: [] }))
    assert.throws(() => validateBackendConfiguration({ ...valid, taskTypes: ["a", "a"] }))
    assert.throws(() => validateBackendConfiguration({ ...valid, priorities: ["p0", "p1"] }))
    assert.throws(() => validateBackendConfiguration({ ...valid, priorityHotkeys: { ab: "p0" } }))
    assert.throws(() => validateBackendConfiguration({ ...valid, priorityHotkeys: { z: "p9" } }))
  })
})
