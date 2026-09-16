import test from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  categoryCandidatesForDirectory,
  detectCategorySlug,
  directoryCategoryCandidates,
  resolveTasksWorkspace,
} from "../src/backend/adapters/tasks/discovery.ts"

function workspaceFixture(tasks: Array<{ id: string; title: string; status?: string; description?: string }>): string {
  const root = mkdtempSync(join(tmpdir(), "pi-tasks-discovery-"))
  const tasksDirectory = join(root, "sync", "tasks")
  mkdirSync(tasksDirectory, { recursive: true })
  writeFileSync(join(root, "sync", "workspace.json"), JSON.stringify({ format: "tasks.workspace", formatVersion: 1 }))

  for (const task of tasks) {
    writeFileSync(join(tasksDirectory, `${task.id}.json`), JSON.stringify({
      format: "tasks.task",
      formatVersion: 1,
      id: task.id,
      title: task.title,
      descriptionMarkdown: task.description ?? "",
      status: task.status ?? "open",
      priority: 2,
      parentId: null,
      dependencyIds: [],
    }))
  }

  return join(root, "sync")
}

test("directory names become the category slugs they could mean", () => {
  assert.deepEqual(directoryCategoryCandidates("pi-tasks"), ["pi-tasks"])
  assert.deepEqual(directoryCategoryCandidates("My.App"), ["my-app"])
  assert.deepEqual(directoryCategoryCandidates("Tasks UI"), ["tasks-ui"])
  assert.deepEqual(directoryCategoryCandidates("2 fast"), [])
  assert.deepEqual(directoryCategoryCandidates(""), [])
})

test("an explicit category override replaces the directory name", () => {
  assert.deepEqual(categoryCandidatesForDirectory("pi-tasks", { PI_TASKS_TASKS_CATEGORY: "Home" }), ["home"])
  assert.deepEqual(categoryCandidatesForDirectory("pi-tasks", {}), ["pi-tasks"])
})

test("detection matches the directory name against task categories", () => {
  const syncRoot = workspaceFixture([
    { id: "one", title: "Something @other" },
    { id: "two", title: "Prepare release", description: "Keep an eye on @pi-tasks" },
  ])

  assert.equal(detectCategorySlug(syncRoot, ["pi-tasks"]), "pi-tasks")
  assert.equal(detectCategorySlug(syncRoot, ["nope"]), undefined)
})

test("detection ignores categories that only exist on canceled tasks", () => {
  const syncRoot = workspaceFixture([
    { id: "one", title: "Dropped @pi-tasks", status: "canceled" },
    { id: "two", title: "Unrelated @other" },
  ])

  assert.equal(detectCategorySlug(syncRoot, ["pi-tasks"]), undefined)
})

test("detection tolerates a missing or unreadable workspace", () => {
  assert.equal(detectCategorySlug(join(tmpdir(), "definitely-not-here"), ["pi-tasks"]), undefined)

  const syncRoot = workspaceFixture([{ id: "one", title: "Fine @pi-tasks" }])
  writeFileSync(join(syncRoot, "tasks", "broken.json"), "{ not json")

  assert.equal(detectCategorySlug(syncRoot, ["pi-tasks"]), "pi-tasks")
})

test("workspace paths follow pi-tasks settings before Tasks settings", () => {
  const configured = resolveTasksWorkspace({ PI_TASKS_TASKS_DB: "/data/pi/tasks.db" })
  assert.equal(configured.databasePath, "/data/pi/tasks.db")
  assert.equal(configured.syncRoot, "/data/pi/sync")

  const fromTasks = resolveTasksWorkspace({ TASKS_SYNC_ROOT: "/shared/tasks-json" })
  assert.equal(fromTasks.syncRoot, "/shared/tasks-json")
  assert.ok(fromTasks.databasePath.endsWith("/com.soleone.tasks/tasks.db"))

  const explicitSyncRoot = resolveTasksWorkspace({
    PI_TASKS_TASKS_DB: "/data/pi/tasks.db",
    PI_TASKS_TASKS_SYNC_ROOT: "/data/pi/canonical",
  })
  assert.equal(explicitSyncRoot.syncRoot, "/data/pi/canonical")
})
