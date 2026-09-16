import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { categorySlugsIn } from "./mapping.ts"

/** Data directory name used by the Tasks desktop app (`com.soleone.tasks`). */
const TASKS_APP_DATA_DIR = "com.soleone.tasks"
const TASKS_SIDECAR_TARGETS: Record<string, string> = {
  "linux-x64": "tasks-backend-x86_64-unknown-linux-gnu",
  "linux-arm64": "tasks-backend-aarch64-unknown-linux-gnu",
  "darwin-arm64": "tasks-backend-aarch64-apple-darwin",
  "darwin-x64": "tasks-backend-x86_64-apple-darwin",
  "win32-x64": "tasks-backend-x86_64-pc-windows-msvc.exe",
}
interface CanonicalTaskFile {
  format?: unknown
  status?: unknown
  title?: unknown
  descriptionMarkdown?: unknown
}

export interface TasksWorkspace {
  databasePath: string
  syncRoot: string
}

export interface TasksLaunchCandidate {
  label: string
  command: string
  args: string[]
}

type Environment = Record<string, string | undefined>

function defaultDataDirectory(environment: Environment): string {
  const home = homedir()

  if (process.platform === "win32") {
    return join(environment.APPDATA ?? join(home, "AppData", "Roaming"), TASKS_APP_DATA_DIR)
  }

  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", TASKS_APP_DATA_DIR)
  }

  return join(environment.XDG_DATA_HOME ?? join(home, ".local", "share"), TASKS_APP_DATA_DIR)
}

function expandPath(value: string): string {
  if (value === "~") return homedir()
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2))
  return isAbsolute(value) ? value : resolve(value)
}

/**
 * Locates the Tasks workspace. Explicit pi-tasks settings win, then the env
 * vars the Tasks app itself honours, then the platform data directory.
 */
export function resolveTasksWorkspace(environment: Environment = process.env): TasksWorkspace {
  const dataDirectory = environment.PI_TASKS_TASKS_DATA_DIR
    ? expandPath(environment.PI_TASKS_TASKS_DATA_DIR)
    : defaultDataDirectory(environment)

  const databasePath = environment.PI_TASKS_TASKS_DB || environment.TASKS_DATABASE_PATH
    ? expandPath(environment.PI_TASKS_TASKS_DB ?? environment.TASKS_DATABASE_PATH ?? "")
    : join(dataDirectory, "tasks.db")

  const syncRoot = environment.PI_TASKS_TASKS_SYNC_ROOT || environment.TASKS_SYNC_ROOT
    ? expandPath(environment.PI_TASKS_TASKS_SYNC_ROOT ?? environment.TASKS_SYNC_ROOT ?? "")
    : join(dirname(databasePath), "sync")

  return { databasePath, syncRoot }
}

function isScriptFile(command: string): boolean {
  return /\.(js|mjs|cjs)$/i.test(command)
}

function scriptCandidate(label: string, scriptPath: string, databasePath: string): TasksLaunchCandidate {
  return {
    label,
    command: process.execPath,
    args: [scriptPath, "--stdio", "--database", databasePath],
  }
}

function sidecarCandidate(label: string, executablePath: string, databasePath: string): TasksLaunchCandidate {
  return { label, command: executablePath, args: ["--stdio", "--database", databasePath] }
}

/** Candidate Tasks checkouts, in the order they should be trusted. */
function tasksRepositories(environment: Environment): string[] {
  const repositories = [environment.TASKS_REPO]

  if (environment.SRC) repositories.push(join(environment.SRC, "products", "tasks"))

  return repositories.filter((repository): repository is string => Boolean(repository))
}

function sidecarNames(): string[] {
  const current = TASKS_SIDECAR_TARGETS[`${process.platform}-${process.arch}`]
  return current ? [current] : Object.keys(TASKS_SIDECAR_TARGETS).map(key => TASKS_SIDECAR_TARGETS[key]!)
}

/**
 * Ways to reach the Tasks command path. Configured commands come first, then
 * build output of known checkouts, then well-known names on `PATH`. Existence
 * is checked where possible; `PATH` entries fail fast on spawn.
 */
export function resolveLaunchCandidates(
  workspace: TasksWorkspace,
  environment: Environment = process.env,
): TasksLaunchCandidate[] {
  const configured = environment.PI_TASKS_TASKS_COMMAND?.trim()
  if (configured) {
    return [isScriptFile(configured)
      ? scriptCandidate("PI_TASKS_TASKS_COMMAND", expandPath(configured), workspace.databasePath)
      : sidecarCandidate("PI_TASKS_TASKS_COMMAND", expandPath(configured), workspace.databasePath)]
  }

  const candidates: TasksLaunchCandidate[] = []

  for (const repository of tasksRepositories(environment)) {
    for (const sidecar of sidecarNames()) {
      const sidecarPath = join(repository, "src-tauri", "binaries", sidecar)
      if (existsSync(sidecarPath)) candidates.push(sidecarCandidate(sidecarPath, sidecarPath, workspace.databasePath))
    }

    const cliPath = join(repository, "dist", "backend", "cli.js")
    if (existsSync(cliPath)) candidates.push(scriptCandidate(cliPath, cliPath, workspace.databasePath))
  }

  candidates.push(sidecarCandidate("tasks-backend on PATH", "tasks-backend", workspace.databasePath))
  candidates.push(sidecarCandidate("tasks on PATH", "tasks", workspace.databasePath))

  return candidates
}

/**
 * The category slug a directory name stands for. Tasks slugs start with a
 * letter and hold letters, numbers, hyphens and underscores, so `My.App`
 * reads as `my-app` and a name that cannot be a slug yields nothing.
 */
export function directoryCategoryCandidates(directoryName: string): string[] {
  const slug = directoryName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")

  return /^[a-z][a-z0-9_-]*$/.test(slug) ? [slug] : []
}

export function categoryCandidatesForDirectory(
  directoryName: string,
  environment: Environment = process.env,
): string[] {
  const override = environment.PI_TASKS_TASKS_CATEGORY?.trim().toLowerCase()
  return override ? [override] : directoryCategoryCandidates(directoryName)
}

/**
 * Finds which of the candidate slugs the workspace actually uses by reading
 * the canonical task files. This stays synchronous for adapter detection and
 * deliberately avoids the database, which is only a rebuildable cache.
 */
export function detectCategorySlug(
  syncRoot: string,
  candidates: readonly string[],
): string | undefined {
  if (candidates.length === 0) return undefined

  let fileNames: string[]
  try {
    fileNames = readdirSync(join(syncRoot, "tasks"))
  } catch {
    return undefined
  }

  for (const fileName of fileNames) {
    if (!fileName.endsWith(".json")) continue

    let task: CanonicalTaskFile
    try {
      task = JSON.parse(readFileSync(join(syncRoot, "tasks", fileName), "utf8")) as CanonicalTaskFile
    } catch {
      continue
    }

    if (task.format !== "tasks.task" || task.status === "canceled") continue

    const title = typeof task.title === "string" ? task.title : ""
    const description = typeof task.descriptionMarkdown === "string" ? task.descriptionMarkdown : ""

    for (const slug of categorySlugsIn(`${title}\n${description}`)) {
      if (candidates.includes(slug)) return slug
    }
  }

  return undefined
}
