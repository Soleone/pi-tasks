import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  categoryCandidatesForDirectory,
  categoryCandidatesForProject,
  detectCategorySlug,
  directoryCategoryCandidates,
  isTasksCliAvailable,
  resolveLaunchCandidates,
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

test("Git worktrees use the main checkout directory for category detection", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tasks-git-"))
  const main = join(root, "pi-tasks")
  const worktree = join(root, "pi-tasks-feature")
  mkdirSync(main, { recursive: true })

  try {
    execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: main, stdio: "ignore" })
    writeFileSync(join(main, "README.md"), "fixture")
    execFileSync("git", ["add", "README.md"], { cwd: main, stdio: "ignore" })
    execFileSync(
      "git",
      ["-c", "user.name=pi-tasks-test", "-c", "user.email=pi-tasks@example.invalid", "commit", "--quiet", "-m", "initial"],
      { cwd: main, stdio: "ignore" },
    )
    execFileSync("git", ["worktree", "add", "--quiet", "-b", "feature", worktree], { cwd: main, stdio: "ignore" })
    mkdirSync(join(worktree, "src"), { recursive: true })

    assert.deepEqual(categoryCandidatesForProject(main), ["pi-tasks"])
    assert.deepEqual(categoryCandidatesForProject(worktree), ["pi-tasks"])
    assert.deepEqual(categoryCandidatesForProject(join(worktree, "src")), ["pi-tasks"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("non-Git projects fall back to the directory name", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tasks-plain-"))
  const project = join(root, "Plain.Project")
  mkdirSync(project)

  try {
    assert.deepEqual(categoryCandidatesForProject(project), ["plain-project"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("detection matches the directory name against task categories in titles", () => {
  const syncRoot = workspaceFixture([
    { id: "one", title: "Something @other" },
    { id: "two", title: "Prepare release @pi-tasks", description: "Keep an eye on @other" },
  ])

  assert.equal(detectCategorySlug(syncRoot, ["pi-tasks"]), "pi-tasks")
  assert.equal(detectCategorySlug(syncRoot, ["nope"]), undefined)
})

test("detection ignores category-looking text in descriptions and code", () => {
  const syncRoot = workspaceFixture([
    { id: "one", title: "Description only", description: "Keep an eye on @pi-tasks" },
    { id: "two", title: "Inline `@pi-tasks`" },
    { id: "three", title: "Fenced code", description: "```\n@pi-tasks\n```" },
  ])

  assert.equal(detectCategorySlug(syncRoot, ["pi-tasks"]), undefined)
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

test("the backend command is expected on PATH unless it is configured", () => {
  const workspace = { databasePath: "/data/tasks.db", syncRoot: "/data/sync" }
  const cliArgs = ["--database", "/data/tasks.db"]

  assert.deepEqual(resolveLaunchCandidates(workspace, {}), [
    { label: "tasks-cli on PATH", command: "tasks-cli", args: cliArgs },
  ])

  const [absolute] = resolveLaunchCandidates(workspace, { PI_TASKS_TASKS_COMMAND: "/opt/tasks/tasks-cli" })
  assert.deepEqual(absolute, { label: "PI_TASKS_TASKS_COMMAND", command: "/opt/tasks/tasks-cli", args: cliArgs })

  const [bareName] = resolveLaunchCandidates(workspace, { PI_TASKS_TASKS_COMMAND: "tasks-cli" })
  assert.equal(bareName!.command, "tasks-cli")

  const [fromHome] = resolveLaunchCandidates(workspace, { PI_TASKS_TASKS_COMMAND: "~/bin/tasks-cli" })
  assert.equal(fromHome!.command, join(homedir(), "bin", "tasks-cli"))

  const [script] = resolveLaunchCandidates(workspace, { PI_TASKS_TASKS_COMMAND: "/opt/tasks/dist/backend/tasks-cli.js" })
  assert.equal(script!.command, process.execPath)
  assert.deepEqual(script!.args, ["/opt/tasks/dist/backend/tasks-cli.js", "--database", "/data/tasks.db"])

  const [customSyncRoot] = resolveLaunchCandidates(workspace, {
    PI_TASKS_TASKS_SYNC_ROOT: "/shared/tasks",
    PATH: "/usr/bin",
  })
  assert.equal(customSyncRoot!.env?.TASKS_SYNC_ROOT, "/data/sync")
  assert.equal(customSyncRoot!.env?.PI_TASKS_TASKS_SYNC_ROOT, "/shared/tasks")
})

test("fallback availability probes the configured CLI launch candidate", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tasks-cli-detection-"))
  const command = join(root, "tasks-cli.js")
  const workspace = { databasePath: join(root, "tasks.db"), syncRoot: join(root, "sync") }
  writeFileSync(command, "process.exit(0)\n")

  try {
    assert.equal(isTasksCliAvailable(workspace, { PI_TASKS_TASKS_COMMAND: command }), true)
    assert.equal(
      isTasksCliAvailable(workspace, { PI_TASKS_TASKS_COMMAND: join(root, "missing.js") }),
      false,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
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

  const emptyOverrides = resolveTasksWorkspace({
    PI_TASKS_TASKS_DB: " ",
    TASKS_DATABASE_PATH: "/data/tasks.db",
    PI_TASKS_TASKS_SYNC_ROOT: "",
    TASKS_SYNC_ROOT: "/data/canonical",
  })
  assert.equal(emptyOverrides.databasePath, "/data/tasks.db")
  assert.equal(emptyOverrides.syncRoot, "/data/canonical")
})
