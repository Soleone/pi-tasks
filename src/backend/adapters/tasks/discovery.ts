import { readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { categorySlugsIn } from "./mapping.ts"

/** Data directory name used by the Tasks desktop app (`com.soleone.tasks`). */
const TASKS_APP_DATA_DIR = "com.soleone.tasks"

/**
 * Command name a Tasks install is expected to provide on `PATH`. Packaged deb
 * and rpm builds place it in `/usr/bin` beside the app. The app binary itself
 * is named `tasks` and opens a window, so it is never a candidate here.
 */
const TASKS_COMMAND = "tasks-cli"
interface CanonicalTaskFile {
  format?: unknown
  status?: unknown
  title?: unknown
}

export interface TasksWorkspace {
  databasePath: string
  syncRoot: string
}

export interface TasksLaunchCandidate {
  label: string
  command: string
  args: string[]
  /** Environment overrides needed to keep pi-only settings aligned with Tasks. */
  env?: Record<string, string | undefined>
}

type Environment = Record<string, string | undefined>

function defaultDataDirectory(environment: Environment): string {
  const home = homedir()

  if (process.platform === "win32") {
    return join(environment.APPDATA?.trim() || join(home, "AppData", "Roaming"), TASKS_APP_DATA_DIR)
  }

  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", TASKS_APP_DATA_DIR)
  }

  return join(environment.XDG_DATA_HOME?.trim() || join(home, ".local", "share"), TASKS_APP_DATA_DIR)
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
  const dataDirectorySetting = environment.PI_TASKS_TASKS_DATA_DIR?.trim()
  const databaseSetting = environment.PI_TASKS_TASKS_DB?.trim() || environment.TASKS_DATABASE_PATH?.trim()
  const syncRootSetting = environment.PI_TASKS_TASKS_SYNC_ROOT?.trim() || environment.TASKS_SYNC_ROOT?.trim()
  const dataDirectory = dataDirectorySetting ? expandPath(dataDirectorySetting) : defaultDataDirectory(environment)
  const databasePath = databaseSetting ? expandPath(databaseSetting) : join(dataDirectory, "tasks.db")
  const syncRoot = syncRootSetting ? expandPath(syncRootSetting) : join(dirname(databasePath), "sync")

  return { databasePath, syncRoot }
}

/** A `.js` command runs under the same Node that pi itself runs on. */
function isScriptFile(command: string): boolean {
  return /\.(js|mjs|cjs)$/i.test(command)
}

/** Bare names stay bare so the shell can resolve them through `PATH`. */
function expandCommand(command: string): string {
  return command.includes("/") || command.includes("\\") ? expandPath(command) : command
}

function commandCandidate(
  command: string,
  databasePath: string,
  label: string,
  env?: Record<string, string | undefined>,
): TasksLaunchCandidate {
  return isScriptFile(command)
    ? { label, command: process.execPath, args: [command, "--database", databasePath], ...(env ? { env } : {}) }
    : { label, command, args: ["--database", databasePath], ...(env ? { env } : {}) }
}

/**
 * Ways to reach the Tasks command path: `PI_TASKS_TASKS_COMMAND` when set, for
 * development builds and AppImage extracts, otherwise the `tasks-cli` command
 * a Tasks install puts on `PATH`. Nothing is guessed about where a Tasks
 * checkout or app might live on this machine.
 */
export function resolveLaunchCandidates(
  workspace: TasksWorkspace,
  environment: Environment = process.env,
): TasksLaunchCandidate[] {
  const configuredSyncRoot = environment.PI_TASKS_TASKS_SYNC_ROOT?.trim()
  const childEnvironment = configuredSyncRoot
    ? { ...environment, TASKS_SYNC_ROOT: workspace.syncRoot }
    : undefined
  const configured = environment.PI_TASKS_TASKS_COMMAND?.trim()
  if (configured) {
    return [commandCandidate(expandCommand(configured), workspace.databasePath, "PI_TASKS_TASKS_COMMAND", childEnvironment)]
  }

  return [commandCandidate(TASKS_COMMAND, workspace.databasePath, `${TASKS_COMMAND} on PATH`, childEnvironment)]
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

    for (const slug of categorySlugsIn(title)) {
      if (candidates.includes(slug)) return slug
    }
  }

  return undefined
}
