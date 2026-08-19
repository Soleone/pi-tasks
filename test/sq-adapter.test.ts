import test from "node:test"
import assert from "node:assert/strict"
import { createSqCompatibleAdapterInitializer } from "../src/backend/adapters/shared/sq-compatible.ts"

function createAdapter(items: unknown[]) {
  const calls: string[][] = []
  const pi = {
    exec: async (_command: string, args: string[]) => {
      calls.push(args)
      if (args[0] === "list") return { code: 0, stdout: JSON.stringify(items), stderr: "" }
      if (args[0] === "show") return { code: 0, stdout: JSON.stringify(items[0]), stderr: "" }
      return { code: 0, stdout: JSON.stringify(items[0]), stderr: "" }
    },
  }
  const initializer = createSqCompatibleAdapterInitializer({
    id: "sq-test",
    command: "sq",
    sessionContextMessage: { customType: "test", content: "test" },
    isApplicable: () => true,
  })
  return { adapter: initializer.initialize(pi as never), calls }
}

test("sq list preserves hierarchy and resolves blocker details", async () => {
  const { adapter, calls } = createAdapter([
    { id: "epic", title: "Epic", status: "pending", priority: 2, metadata: { pi_tasks: { taskType: "epic" } } },
    { id: "done", title: "Finished prerequisite", status: "closed", priority: 2 },
    { id: "child", title: "Child", status: "blocked", priority: 2, blocked_by: ["done", "missing"], metadata: { pi_tasks: { parentRef: "epic" } } },
  ])

  const tasks = await adapter.list()
  const epic = tasks.find(task => task.ref === "epic")!
  const child = tasks.find(task => task.ref === "child")!
  assert.deepEqual(calls[0], ["list", "--all", "--json"])
  assert.equal(epic.childCount, 1)
  assert.equal(child.parentRef, "epic")
  // Blocked-by is readiness metadata; the lifecycle status remains open.
  assert.equal(child.status, "open")
  assert.deepEqual(child.blockers, [
    { ref: "done", title: "Finished prerequisite", status: "closed" },
    { ref: "missing", title: undefined, status: undefined },
  ])
})

test("sq show resolves closed blockers instead of reporting a false block", async () => {
  const { adapter } = createAdapter([
    { id: "child", title: "Child", status: "pending", blocked_by: ["done"] },
    { id: "done", title: "Done", status: "closed" },
  ])
  const task = await adapter.show("child")
  assert.equal(task.status, "open")
  assert.deepEqual(task.blockers, [{ ref: "done", title: "Done", status: "closed" }])
})

test("sq updates and clears blockers and hierarchy under pi_tasks metadata", async () => {
  const { adapter, calls } = createAdapter([{ id: "child", title: "Child", status: "pending" }])
  await adapter.update("child", { parentRef: "epic", blockedBy: ["a", "b"] })
  await adapter.update("child", { parentRef: null, blockedBy: [] })
  assert.deepEqual(calls[0], [
    "edit",
    "child",
    '--merge-metadata={"pi_tasks":{"parentRef":"epic"}}',
    "--set-blocked-by=a,b",
  ])
  assert.deepEqual(calls[1], [
    "edit",
    "child",
    '--merge-metadata={"pi_tasks":{"parentRef":""}}',
    "--set-blocked-by=",
  ])
})
