import test from "node:test"
import assert from "node:assert/strict"
import { createTasksAdapter, type TasksRequest } from "../src/backend/adapters/tasks/index.ts"

interface FakeTask {
  id: string
  title: string
  descriptionMarkdown: string
  status: string
  priority: number
  category: { slug: string; label: string } | null
  tags: Array<{ slug: string }>
  parentId: string | null
  dependencyIds: string[]
  blockedByIds: string[]
  version: number
  createdAt: string
  updatedAt: string
  completedAt: string | null
  canceledAt: string | null
}

interface RecordedCall {
  command: string
  args: Record<string, unknown>
}

const TRANSITIONS: Record<string, string> = {
  "task.start": "in_progress",
  "task.pause": "paused",
  "task.complete": "done",
  "task.reopen": "open",
}

function taskFixture(overrides: Partial<FakeTask> = {}): FakeTask {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Task @pi-tasks",
    descriptionMarkdown: "",
    status: "open",
    priority: 2,
    category: { slug: "pi-tasks", label: "pi-tasks" },
    tags: [],
    parentId: null,
    dependencyIds: [],
    blockedByIds: [],
    version: 1,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-02T10:00:00.000Z",
    completedAt: null,
    canceledAt: null,
    ...overrides,
  }
}

/** Small stand-in for the Tasks command path, including optimistic versions. */
function createHarness(initialTasks: FakeTask[], category = "pi-tasks") {
  const tasks = new Map(initialTasks.map(task => [task.id, task]))
  const calls: RecordedCall[] = []
  let created = 0

  const request: TasksRequest = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    calls.push({ command, args })

    if (command === "task.list") {
      const statuses = args.status as string[]
      const matched = [...tasks.values()]
        .filter(task => statuses.includes(task.status))
        .filter(task => !args.category || task.category?.slug === args.category)
      const offset = args.offset as number
      return {
        tasks: matched.slice(offset, offset + (args.limit as number)),
        total: matched.length,
      } as T
    }

    if (command === "task.create") {
      created += 1
      const task = taskFixture({
        id: `0000000${created}-0000-4000-8000-000000000000`,
        title: args.title as string,
        descriptionMarkdown: (args.descriptionMarkdown as string) ?? "",
        priority: (args.priority as number) ?? 2,
        parentId: (args.parentId as string | null) ?? null,
      })
      tasks.set(task.id, task)
      return { task } as T
    }

    const task = tasks.get(args.id as string)
    if (!task) throw new Error("TASK_NOT_FOUND: unknown task")
    if (command === "task.get") return { task } as T
    if (args.expectedVersion !== task.version) {
      throw new Error(`STALE_TASK_VERSION: task ${task.id} is at version ${task.version}`)
    }

    if (command === "task.update") {
      task.title = (args.title as string) ?? task.title
      task.descriptionMarkdown = (args.descriptionMarkdown as string) ?? task.descriptionMarkdown
      task.priority = (args.priority as number) ?? task.priority
    } else if (TRANSITIONS[command]) {
      task.status = TRANSITIONS[command]!
    } else if (command === "task.move") {
      task.parentId = (args.parentId as string | null) ?? null
    } else if (command === "task.dependency.add" || command === "task.dependency.remove") {
      const dependsOnId = args.dependsOnId as string
      const dependency = tasks.get(dependsOnId)
      if (!dependency) throw new Error("TASK_NOT_FOUND: unknown dependency")
      const remaining = task.dependencyIds.filter(ref => ref !== dependsOnId)
      task.dependencyIds = command === "task.dependency.add" ? [...remaining, dependsOnId].sort() : remaining
      task.blockedByIds = task.dependencyIds.filter(ref => tasks.get(ref)?.status !== "canceled")
    } else {
      throw new Error(`UNEXPECTED_COMMAND: ${command}`)
    }

    task.version += 1
    return { task } as T
  }

  return { adapter: createTasksAdapter({ request, category }), calls, tasks }
}

test("tasks list scopes the category and maps records", async () => {
  const { adapter, calls } = createHarness([
    taskFixture({ id: "aaaa1111-0000-4000-8000-000000000000", title: "Parent @pi-tasks" }),
    taskFixture({
      id: "bbbb2222-0000-4000-8000-000000000000",
      title: "Child @pi-tasks",
      status: "in_progress",
      priority: 0,
      parentId: "aaaa1111-0000-4000-8000-000000000000",
      dependencyIds: ["cccc3333-0000-4000-8000-000000000000"],
      blockedByIds: ["cccc3333-0000-4000-8000-000000000000"],
    }),
    taskFixture({
      id: "cccc3333-0000-4000-8000-000000000000",
      title: "Blocker @pi-tasks",
      priority: 4,
    }),
  ])

  const tasks = await adapter.list()
  const parent = tasks.find(task => task.ref.startsWith("aaaa"))!
  const child = tasks.find(task => task.ref.startsWith("bbbb"))!

  assert.deepEqual(calls[0], {
    command: "task.list",
    args: {
      category: "pi-tasks",
      status: ["open", "in_progress", "paused"],
      sort: "updated",
      direction: "desc",
      limit: 100,
      offset: 0,
    },
  })
  assert.equal(child.status, "inProgress")
  assert.equal(child.priority, "p0")
  assert.equal(child.taskType, "task")
  assert.equal(child.id, "bbbb2222")
  assert.equal(child.parentRef, parent.ref)
  assert.equal(parent.childCount, 1)
  assert.deepEqual(child.blockers, [
    { ref: "cccc3333-0000-4000-8000-000000000000", title: "Blocker @pi-tasks", status: "open" },
  ])
})

test("tasks list shows done and canceled tasks as closed", async () => {
  const { adapter, calls } = createHarness([
    taskFixture({ id: "dddd1111-0000-4000-8000-000000000000", status: "done", completedAt: "2026-09-03T10:00:00.000Z" }),
    taskFixture({ id: "eeee2222-0000-4000-8000-000000000000", status: "canceled", canceledAt: "2026-09-05T10:00:00.000Z" }),
    taskFixture({ id: "ffff3333-0000-4000-8000-000000000000", status: "paused" }),
  ])

  const closed = await adapter.list("closed")

  assert.deepEqual(calls[0]!.args.status, ["done", "canceled"])
  assert.deepEqual(closed.map(task => task.ref.slice(0, 4)), ["eeee", "dddd"])
  assert.deepEqual(closed.map(task => task.status), ["closed", "closed"])
  assert.equal(closed[0]!.closedAt, "2026-09-05T10:00:00.000Z")
})

test("tasks updates keep the category token in the title", async () => {
  const { adapter, calls } = createHarness([
    taskFixture({ id: "aaaa1111-0000-4000-8000-000000000000", title: "Old title @pi-tasks", version: 7 }),
  ])

  await adapter.update("aaaa1111-0000-4000-8000-000000000000", { title: "New title" })

  assert.deepEqual(calls[1], {
    command: "task.update",
    args: {
      id: "aaaa1111-0000-4000-8000-000000000000",
      expectedVersion: 7,
      title: "New title @pi-tasks",
      descriptionMarkdown: "",
    },
  })
})

test("tasks updates move a description-only category token into the title", async () => {
  const { adapter, calls } = createHarness([
    taskFixture({
      id: "aaaa1111-0000-4000-8000-000000000000",
      title: "Tracked in the notes",
      descriptionMarkdown: "belongs to @pi-tasks",
    }),
  ])

  await adapter.update("aaaa1111-0000-4000-8000-000000000000", { description: "still @pi-tasks" })

  assert.equal(calls[1]!.args.title, "Tracked in the notes @pi-tasks")
  assert.equal(calls[1]!.args.descriptionMarkdown, "still @pi-tasks")
})

test("tasks scope ignores category-looking text in descriptions and code", async () => {
  const { adapter, calls } = createHarness([
    taskFixture({
      id: "aaaa1111-0000-4000-8000-000000000000",
      title: "Tracked in the notes",
      descriptionMarkdown: "mention @other",
    }),
  ])

  await adapter.update("aaaa1111-0000-4000-8000-000000000000", { title: "Use `@other` in an example" })

  assert.equal(calls[1]!.args.title, "Use `@other` in an example @pi-tasks")
})

test("tasks updates reject a foreign category and report the scope", async () => {
  const { adapter } = createHarness([taskFixture({ id: "aaaa1111-0000-4000-8000-000000000000" })])

  await assert.rejects(
    () => adapter.update("aaaa1111-0000-4000-8000-000000000000", { title: "Mine @personal now" }),
    /scoped to the @pi-tasks category/,
  )
})

test("tasks updates send one command per change with the running version", async () => {
  const { adapter, calls } = createHarness([
    taskFixture({ id: "aaaa1111-0000-4000-8000-000000000000", title: "Work @pi-tasks", priority: 3 }),
    taskFixture({ id: "bbbb2222-0000-4000-8000-000000000000", title: "Blocker @pi-tasks" }),
  ])

  await adapter.update("aaaa1111-0000-4000-8000-000000000000", {
    priority: "p1",
    status: "inProgress",
    parentRef: "bbbb2222-0000-4000-8000-000000000000",
    blockedBy: ["bbbb2222-0000-4000-8000-000000000000"],
  })

  const mutations = calls.slice(1).filter(call => call.args.expectedVersion !== undefined)
  assert.deepEqual(mutations.map(call => call.command), [
    "task.update",
    "task.start",
    "task.move",
    "task.dependency.add",
  ])
  assert.deepEqual(mutations.map(call => call.args.expectedVersion), [1, 2, 3, 4])
  assert.equal(calls[1]!.args.priority, 1)
  assert.equal(calls[3]!.args.parentId, "bbbb2222-0000-4000-8000-000000000000")
})

test("tasks updates drop stale blockers and keep canceled history", async () => {
  const { adapter, calls, tasks } = createHarness([
    taskFixture({ id: "aaaa1111-0000-4000-8000-000000000000", title: "Work @pi-tasks" }),
    taskFixture({ id: "bbbb2222-0000-4000-8000-000000000000", title: "Done blocker @pi-tasks", status: "done" }),
    taskFixture({ id: "cccc3333-0000-4000-8000-000000000000", title: "Gone blocker @pi-tasks", status: "canceled" }),
  ])
  const target = tasks.get("aaaa1111-0000-4000-8000-000000000000")!
  target.dependencyIds = ["bbbb2222-0000-4000-8000-000000000000", "cccc3333-0000-4000-8000-000000000000"]
  target.blockedByIds = ["bbbb2222-0000-4000-8000-000000000000"]

  await adapter.update("aaaa1111-0000-4000-8000-000000000000", { blockedBy: [] })

  assert.deepEqual(calls.slice(1).map(call => call.command), ["task.dependency.remove"])
  assert.deepEqual(target.dependencyIds, ["cccc3333-0000-4000-8000-000000000000"])
})

test("tasks create stays in scope and applies the requested state", async () => {
  const { adapter, calls } = createHarness([
    taskFixture({ id: "bbbb2222-0000-4000-8000-000000000000", title: "Blocker @pi-tasks" }),
  ])

  const created = await adapter.create({
    title: "Brand new",
    description: "with context",
    priority: "p1",
    status: "inProgress",
    blockedBy: ["bbbb2222"],
  })

  assert.equal(created.title, "Brand new @pi-tasks")
  assert.equal(created.status, "inProgress")
  assert.deepEqual(
    calls.filter(call => call.command !== "task.list" && call.command !== "task.get").map(call => call.command),
    ["task.create", "task.start", "task.dependency.add"],
  )
  assert.equal(calls[0]!.args.title, "Brand new @pi-tasks")
  assert.equal(calls[0]!.args.priority, 1)
  assert.equal(calls.find(call => call.command === "task.dependency.add")!.args.dependsOnId, "bbbb2222-0000-4000-8000-000000000000")
})

test("tasks create appends scope even when the description mentions a category", async () => {
  const { adapter } = createHarness([])

  const created = await adapter.create({ title: "A note", description: "See @other for context" })

  assert.equal(created.title, "A note @pi-tasks")
})

test("tasks create rejects an empty title", async () => {
  const { adapter } = createHarness([])

  await assert.rejects(() => adapter.create({ title: "   " }), /Title is required/)
})

test("tasks reject unsupported fields instead of silently dropping them", async () => {
  const { adapter } = createHarness([taskFixture({ id: "aaaa1111-0000-4000-8000-000000000000" })])

  await assert.rejects(() => adapter.create({ title: "A task", dueAt: "2026-09-10" }), /does not support due dates/)
  await assert.rejects(() => adapter.create({ title: "A task", taskType: "bug" }), /does not support task type bug/)
  await assert.rejects(() => adapter.create({ title: "A task", priority: "p9" }), /Unsupported priority/)
  await assert.rejects(() => adapter.create({ title: "A task", status: "blocked" }), /cannot be set directly/)
  await assert.rejects(() => adapter.update("aaaa1111-0000-4000-8000-000000000000", { dueAt: "2026-09-10" }), /does not support due dates/)
  await assert.rejects(() => adapter.update("aaaa1111-0000-4000-8000-000000000000", { taskType: "bug" }), /does not support task type bug/)
  await assert.rejects(() => adapter.update("aaaa1111-0000-4000-8000-000000000000", { priority: "p9" }), /Unsupported priority/)
  await assert.rejects(() => adapter.update("aaaa1111-0000-4000-8000-000000000000", { status: "blocked" }), /cannot be set directly/)
})

test("tasks resolves short id prefixes and refuses ambiguous ones", async () => {
  const { adapter, calls } = createHarness([
    taskFixture({ id: "abcd1111-0000-4000-8000-000000000000", title: "First @pi-tasks" }),
    taskFixture({ id: "abcd2222-0000-4000-8000-000000000000", title: "Second @pi-tasks" }),
  ])

  const shown = await adapter.show("abcd1111")
  assert.equal(shown.title, "First @pi-tasks")
  assert.ok(calls.some(call => call.command === "task.get" && call.args.id === "abcd1111-0000-4000-8000-000000000000"))

  await assert.rejects(() => adapter.show("abcd"), /matches 2 tasks/)
})

test("tasks normalize short parent and blocker references", async () => {
  const { adapter, calls } = createHarness([
    taskFixture({ id: "aaaa1111-0000-4000-8000-000000000000", title: "Work @pi-tasks" }),
    taskFixture({ id: "bbbb2222-0000-4000-8000-000000000000", title: "Related @pi-tasks" }),
  ])

  await adapter.update("aaaa1111-0000-4000-8000-000000000000", {
    parentRef: "bbbb2222",
    blockedBy: ["bbbb2222"],
  })

  assert.equal(calls.find(call => call.command === "task.move")!.args.parentId, "bbbb2222-0000-4000-8000-000000000000")
  assert.equal(calls.find(call => call.command === "task.dependency.add")!.args.dependsOnId, "bbbb2222-0000-4000-8000-000000000000")
})

test("tasks list resolves blocker details outside the requested status scope", async () => {
  const { adapter, calls } = createHarness([
    taskFixture({
      id: "aaaa1111-0000-4000-8000-000000000000",
      title: "Work @pi-tasks",
      dependencyIds: ["bbbb2222-0000-4000-8000-000000000000"],
      blockedByIds: ["bbbb2222-0000-4000-8000-000000000000"],
    }),
    taskFixture({
      id: "bbbb2222-0000-4000-8000-000000000000",
      title: "Completed blocker @pi-tasks",
      status: "done",
    }),
  ])

  const tasks = await adapter.list()
  const work = tasks.find(task => task.ref.startsWith("aaaa"))!

  assert.deepEqual(work.blockers, [{
    ref: "bbbb2222-0000-4000-8000-000000000000",
    title: "Completed blocker @pi-tasks",
    status: "closed",
  }])
  assert.ok(calls.some(call => call.command === "task.get" && call.args.id === "bbbb2222-0000-4000-8000-000000000000"))
})

test("tasks enforce category scope for full ids", async () => {
  const foreignId = "bbbb2222-0000-4000-8000-000000000000"
  const { adapter } = createHarness([
    taskFixture({ id: foreignId, title: "Foreign @other", category: { slug: "other", label: "other" } }),
  ])

  await assert.rejects(() => adapter.show(foreignId), /outside the @pi-tasks category scope/)
  await assert.rejects(() => adapter.update(foreignId, { status: "inProgress" }), /outside the @pi-tasks category scope/)
})

test("tasks transition from canceled through reopen when needed", async () => {
  const { adapter, calls } = createHarness([
    taskFixture({
      id: "aaaa1111-0000-4000-8000-000000000000",
      title: "Canceled @pi-tasks",
      status: "canceled",
    }),
  ])

  await adapter.update("aaaa1111-0000-4000-8000-000000000000", { status: "inProgress" })

  assert.deepEqual(calls.slice(1).map(call => call.command), ["task.reopen", "task.start"])
  assert.deepEqual(calls.slice(1).map(call => call.args.expectedVersion), [1, 2])
})

test("tasks treat canceled as already closed when updating state", async () => {
  const { adapter, calls } = createHarness([
    taskFixture({
      id: "aaaa1111-0000-4000-8000-000000000000",
      title: "Canceled @pi-tasks",
      status: "canceled",
    }),
  ])

  await adapter.update("aaaa1111-0000-4000-8000-000000000000", { status: "closed" })

  assert.equal(calls.filter(call => call.command.startsWith("task.") && call.command !== "task.get").length, 0)
})

test("tasks show resolves blocker details without changing the lifecycle status", async () => {
  const { adapter, calls } = createHarness([
    taskFixture({
      id: "aaaa1111-0000-4000-8000-000000000000",
      title: "Work @pi-tasks",
      dependencyIds: ["bbbb2222-0000-4000-8000-000000000000"],
      blockedByIds: ["bbbb2222-0000-4000-8000-000000000000"],
    }),
    taskFixture({ id: "bbbb2222-0000-4000-8000-000000000000", title: "Blocker @pi-tasks" }),
  ])

  const task = await adapter.show("aaaa1111-0000-4000-8000-000000000000")

  // Blocked-by is readiness metadata; the stored status stays open.
  assert.equal(task.status, "open")
  assert.deepEqual(task.blockers, [
    { ref: "bbbb2222-0000-4000-8000-000000000000", title: "Blocker @pi-tasks", status: "open" },
  ])
  assert.ok(calls.some(call => call.command === "task.get" && call.args.id === "bbbb2222-0000-4000-8000-000000000000"))
})
