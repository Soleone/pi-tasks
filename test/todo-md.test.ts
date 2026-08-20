import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import todoMdInitializer, { parseTodoDocument, renderTodoDocument } from "../src/backend/adapters/todo-md.ts"

test("nested checklist items become parent and child tasks", () => {
  const document = parseTodoDocument(`# Demo\n\n## Now\n\n- [ ] **Epic**\n  - Parent note\n  - [ ] **Child** — child summary\n    - Child note\n    - [x] **Grandchild**\n- [ ] **Separate**\n`)

  assert.equal(document.tasks.length, 4)
  const [epic, child, grandchild, separate] = document.tasks
  assert.equal(child!.parentRef, epic!.ref)
  assert.equal(grandchild!.parentRef, child!.ref)
  assert.equal(separate!.parentRef, undefined)
  assert.equal(epic!.description, "- Parent note")
  assert.equal(child!.description, "child summary\n- Child note")
})

test("nested hierarchy round trips without turning descriptions into tasks", () => {
  const first = parseTodoDocument(`# Demo\n\n## Now\n\n- [ ] **Epic**\n  - [ ] **Child**\n    - implementation note\n`)
  const rendered = renderTodoDocument(first)
  const second = parseTodoDocument(rendered)

  assert.match(rendered, /  - \[ \] \*\*Child\*\*/)
  assert.match(rendered, /    - implementation note/)
  assert.equal(second.tasks.length, 2)
  assert.equal(second.tasks[1]!.parentRef, second.tasks[0]!.ref)
  assert.equal(second.tasks[1]!.description, "- implementation note")
})

test("todo list scopes between open and archived tasks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-tasks-todo-"))
  const path = join(directory, "TODO.md")
  await writeFile(path, `# Demo\n\n## Now\n\n- [ ] **Open task**\n\n## Archive\n\n- [x] **Done task**\n`, "utf8")
  const previousPath = process.env.PI_TASKS_TODO_PATH
  process.env.PI_TASKS_TODO_PATH = path
  try {
    const adapter = todoMdInitializer.initialize({} as never)
    const active = await adapter.list()
    assert.equal(active.length, 1)
    assert.equal(active[0]!.title, "Open task")
    assert.equal(active[0]!.status, "open")

    const closed = await adapter.list("closed")
    assert.equal(closed.length, 1)
    assert.equal(closed[0]!.title, "Done task")
    assert.equal(closed[0]!.status, "closed")
  } finally {
    if (previousPath === undefined) delete process.env.PI_TASKS_TODO_PATH
    else process.env.PI_TASKS_TODO_PATH = previousPath
  }
})

test("changing child priority moves its root tree so the update round trips", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-tasks-todo-"))
  const path = join(directory, "TODO.md")
  await writeFile(path, `# Demo\n\n## Now\n\n- [ ] **Epic**\n  - [ ] **Child**\n\n## Next\n\n## Later\n\n## Archive\n`, "utf8")
  const previousPath = process.env.PI_TASKS_TODO_PATH
  process.env.PI_TASKS_TODO_PATH = path
  try {
    const adapter = todoMdInitializer.initialize({} as never)
    const tasks = await adapter.list()
    const child = tasks.find(task => task.title === "Child")!
    await adapter.update(child.ref, { priority: "later" })
    const content = await readFile(path, "utf8")
    const laterSection = content.split("## Later")[1]!.split("## Archive")[0]!
    assert.match(laterSection, /\*\*Epic\*\*/)
    assert.match(laterSection, /  - \[ \] \*\*Child\*\*/)
  } finally {
    if (previousPath === undefined) delete process.env.PI_TASKS_TODO_PATH
    else process.env.PI_TASKS_TODO_PATH = previousPath
  }
})
