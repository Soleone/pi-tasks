import { existsSync } from "node:fs"
import { basename } from "node:path"
import type {
  CreateTaskInput,
  TaskAdapter,
  TaskAdapterInitializer,
  TaskListScope,
  TaskSessionContextMessage,
  TaskUpdate,
} from "../../api.ts"
import type { Task, TaskStatus } from "../../../models/task.ts"
import { PRIORITIES, PRIORITY_HOTKEYS } from "../shared/constants.ts"
import { sortActiveTasks, sortClosedTasks } from "../shared/sorting.ts"
import {
  categoryCandidatesForDirectory,
  detectCategorySlug,
  resolveLaunchCandidates,
  resolveTasksWorkspace,
  type TasksWorkspace,
} from "./discovery.ts"
import { TasksCliClient } from "./client.ts"
import {
  backendStatusesForScope,
  isFullTaskId,
  STATUS_MAP,
  toBackendPriority,
  toBackendStatus,
  titleWithScope,
  toTask,
  transitionCommand,
  type TasksTaskRecord,
} from "./mapping.ts"

const PAGE_SIZE = 100
const MAX_TASKS = 1_000
const DEFAULT_PRIORITY = 2

/** Tasks has no task type concept, so the UI keeps a single non-cycling value. */
const TASK_TYPES = ["task"]

function validateSupportedInput(input: Pick<TaskUpdate, "dueAt" | "priority" | "status" | "taskType">): void {
  if (input.dueAt !== undefined) {
    throw new Error("The Tasks backend does not support due dates")
  }
  if (input.taskType !== undefined && input.taskType !== "task") {
    throw new Error(`The Tasks backend does not support task type ${input.taskType}`)
  }
  if (input.priority !== undefined && toBackendPriority(input.priority) === undefined) {
    throw new Error(`Unsupported priority for tasks backend: ${input.priority}`)
  }
  if (input.status !== undefined && !["open", "inProgress", "deferred", "closed", "blocked"].includes(input.status)) {
    throw new Error(`Unsupported status for tasks backend: ${input.status}`)
  }
  if (input.status === "blocked") {
    throw new Error("The Tasks backend derives blocked status from dependencies; it cannot be set directly")
  }
}

function transitionCommands(currentStatus: string, desiredStatus: TaskStatus): string[] {
  const desiredBackendStatus = toBackendStatus(desiredStatus)
  if (currentStatus === desiredBackendStatus || (desiredBackendStatus === "done" && currentStatus === "canceled")) {
    return []
  }

  // Tasks does not allow pause/start from canceled, and does not allow pause
  // from done. Reopen first, then apply the requested state.
  if (desiredBackendStatus === "in_progress" && currentStatus === "canceled") {
    return ["task.reopen", "task.start"]
  }
  if (desiredBackendStatus === "paused" && (currentStatus === "done" || currentStatus === "canceled")) {
    return ["task.reopen", "task.pause"]
  }

  return [transitionCommand(desiredStatus)]
}

export interface TasksRequest {
  <T>(command: string, args?: Record<string, unknown>): Promise<T>
}

export interface TasksAdapterOptions {
  request: TasksRequest
  /** `@category` the project is scoped to, when one matched. */
  category?: string
  sessionContextMessage?: TaskSessionContextMessage
}

function sessionContext(category: string | undefined): TaskSessionContextMessage {
  return {
    customType: "pi-tasks-backend-context-tasks-v1",
    content: [
      "The pi-tasks extension is using the `tasks` backend through the Tasks CLI, which",
      "uses the same Tasks command path as the desktop app, so edits are shared immediately.",
      category
        ? `This project is scoped to the \`@${category}\` category matched from the directory name;`
          + " pi-tasks keeps that token in the task title so tasks stay in scope."
        : "This project is not scoped to a category, so every task in the workspace is listed.",
      "Tasks has no task types or due dates; use `#tags` in the description for finer classification.",
      "Outside the Tasks UI, pi-tasks invokes `tasks-cli --json` for list/show/add/update,",
      "status, hierarchy, and dependency operations. Versioned mutations pass the task version",
      "explicitly; the CLI supplies idempotency keys and actor metadata.",
      "Versioned mutations need the current `expectedVersion`; creates use idempotency and task ids may be given as unambiguous prefixes.",
    ].join(" "),
  }
}

/**
 * Adapter for the Tasks product command path. Reads and writes go through the
 * Tasks CLI, which enters the same command implementation as the desktop app;
 * nothing here needs the SQLite cache or canonical files beyond cheap discovery.
 */
export function createTasksAdapter(options: TasksAdapterOptions): TaskAdapter {
  const { request, category } = options

  async function listRecords(closed: boolean): Promise<TasksTaskRecord[]> {
    const records: TasksTaskRecord[] = []

    while (records.length < MAX_TASKS) {
      const result = await request<{ tasks?: TasksTaskRecord[]; total?: number }>("task.list", {
        ...(category ? { category } : {}),
        status: backendStatusesForScope(closed),
        sort: "updated",
        direction: "desc",
        limit: PAGE_SIZE,
        offset: records.length,
      })
      const page = result.tasks ?? []
      records.push(...page)

      const total = typeof result.total === "number" ? result.total : records.length
      if (page.length === 0 || records.length >= total) break
    }

    return records
  }

  /** Tasks addresses tasks by UUID, but the list shows a short id prefix. */
  async function matchingIds(prefix: string): Promise<string[]> {
    const needle = prefix.trim().toLowerCase()
    if (needle.length === 0) return []

    const [active, closed] = await Promise.all([listRecords(false), listRecords(true)])
    return [...active, ...closed].map(record => record.id).filter(id => id.toLowerCase().startsWith(needle))
  }

  async function getRecordById(id: string): Promise<TasksTaskRecord> {
    const result = await request<{ task?: TasksTaskRecord }>("task.get", { id })
    if (!result.task) throw new Error(`Tasks backend returned no task for ${id}`)
    return result.task
  }

  function assertInScope(record: TasksTaskRecord): void {
    if (category && record.category?.slug !== category) {
      throw new Error(`Task "${record.id}" is outside the @${category} category scope`)
    }
  }

  async function resolveRef(ref: string): Promise<string> {
    const trimmed = ref.trim()
    if (trimmed.length === 0) throw new Error("Task reference is required")
    if (isFullTaskId(trimmed)) return trimmed.toLowerCase()

    const matches = await matchingIds(trimmed)
    if (matches.length === 1) return matches[0]!
    if (matches.length > 1) {
      throw new Error(`Task "${trimmed}" matches ${matches.length} tasks; use a longer id prefix`)
    }

    throw new Error(`No task matches "${trimmed}"${category ? ` in the @${category} category` : ""}`)
  }

  async function getRecord(ref: string): Promise<TasksTaskRecord> {
    const record = await getRecordById(await resolveRef(ref))
    assertInScope(record)
    return record
  }

  async function mutate(
    command: string,
    id: string,
    expectedVersion: number,
    args: Record<string, unknown>,
  ): Promise<TasksTaskRecord> {
    const result = await request<{ task?: TasksTaskRecord }>(command, { id, expectedVersion, ...args })
    if (!result.task) throw new Error(`Tasks backend returned no task for ${command}`)
    return result.task
  }

  async function recordsWithBlockerContext(records: readonly TasksTaskRecord[]): Promise<Map<string, TasksTaskRecord>> {
    const known = new Map(records.map(record => [record.id, record]))
    const missing = new Set(
      records.flatMap(record => record.blockedByIds).filter(ref => !known.has(ref)),
    )
    const blockers = await Promise.all([...missing].map(async ref => {
      try {
        return await getRecordById(ref)
      } catch {
        return undefined
      }
    }))

    for (const blocker of blockers) {
      if (blocker) known.set(blocker.id, blocker)
    }
    return known
  }

  function scopedTitle(title: string, description: string): string {
    if (title.length === 0) throw new Error("Title is required")
    return titleWithScope(title, description, category)
  }

  function contentUpdate(update: TaskUpdate, current: TasksTaskRecord): Record<string, unknown> {
    const args: Record<string, unknown> = {}

    if (update.title !== undefined || update.description !== undefined) {
      // The category lives in the task text, so title and description are
      // always written together to keep the derived classification intact.
      const description = update.description ?? current.descriptionMarkdown
      args.title = scopedTitle((update.title ?? current.title).trim(), description)
      args.descriptionMarkdown = description
    }

    const priority = toBackendPriority(update.priority)
    if (priority !== undefined && priority !== current.priority) {
      args.priority = priority
    }

    return args
  }

  return {
    id: "tasks",
    capabilities: { hierarchy: "native", dependencies: "native" },
    statusMap: STATUS_MAP,
    taskTypes: TASK_TYPES,
    priorities: PRIORITIES,
    priorityHotkeys: PRIORITY_HOTKEYS,
    sessionContextMessage: options.sessionContextMessage ?? sessionContext(category),

    async list(scope: TaskListScope = "active"): Promise<Task[]> {
      const records = await listRecords(scope === "closed")
      const known = await recordsWithBlockerContext(records)
      const tasks = records.map(record => toTask(record, known))

      const childCounts = new Map<string, number>()
      for (const task of tasks) {
        if (task.parentRef) childCounts.set(task.parentRef, (childCounts.get(task.parentRef) ?? 0) + 1)
      }
      for (const task of tasks) task.childCount = childCounts.get(task.ref) ?? 0

      return scope === "closed" ? sortClosedTasks(tasks) : sortActiveTasks(tasks)
    },

    async show(ref: string): Promise<Task> {
      const record = await getRecord(ref)
      return toTask(record, await recordsWithBlockerContext([record]))
    },

    async update(ref: string, update: TaskUpdate): Promise<void> {
      validateSupportedInput(update)
      let current = await getRecord(ref)
      const id = current.id

      let nextParentId: string | null | undefined
      if (update.parentRef !== undefined) {
        nextParentId = update.parentRef === null ? null : await resolveRef(update.parentRef)
        if (nextParentId === id) throw new Error("A task cannot be its own parent")
      }

      let desiredDependencyIds: string[] | undefined
      if (update.blockedBy !== undefined) {
        desiredDependencyIds = [...new Set(await Promise.all(
          [...new Set(update.blockedBy)].map(dependencyRef => resolveRef(dependencyRef)),
        ))]
        if (desiredDependencyIds.includes(id)) throw new Error("A task cannot block itself")
      }

      const content = contentUpdate(update, current)
      if (Object.keys(content).length > 0) {
        current = await mutate("task.update", id, current.version, content)
      }

      if (update.status !== undefined) {
        for (const command of transitionCommands(current.status, update.status)) {
          current = await mutate(command, id, current.version, {})
        }
      }

      if (nextParentId !== undefined && nextParentId !== current.parentId) {
        current = await mutate("task.move", id, current.version, { parentId: nextParentId })
      }

      if (desiredDependencyIds !== undefined) {
        // Canceled dependencies stay untouched: they are history rather than
        // readiness, and the UI never sees them as blockers.
        for (const dependencyId of current.blockedByIds.filter(candidate => !desiredDependencyIds.includes(candidate))) {
          current = await mutate("task.dependency.remove", id, current.version, { dependsOnId: dependencyId })
        }
        for (const dependencyId of desiredDependencyIds.filter(candidate => !current.blockedByIds.includes(candidate))) {
          current = await mutate("task.dependency.add", id, current.version, { dependsOnId: dependencyId })
        }
      }
    },

    async create(input: CreateTaskInput): Promise<Task> {
      validateSupportedInput(input)
      const description = input.description ?? ""
      const priority = input.priority === undefined ? DEFAULT_PRIORITY : toBackendPriority(input.priority)
      if (priority === undefined) {
        // validateSupportedInput handles this for normal callers; retain a
        // narrow guard for values arriving through JavaScript at runtime.
        throw new Error(`Unsupported priority for tasks backend: ${input.priority}`)
      }
      const args: Record<string, unknown> = {
        title: scopedTitle(input.title.trim(), description),
        descriptionMarkdown: description,
        priority,
      }
      if (input.parentRef !== undefined && input.parentRef !== null) {
        args.parentId = await resolveRef(input.parentRef)
      }

      const created = (await request<{ task?: TasksTaskRecord }>("task.create", args)).task
      if (!created) throw new Error("Tasks backend returned no task for task.create")

      let record = created
      if (input.status && input.status !== "open" && input.status !== "blocked") {
        record = await mutate(transitionCommand(input.status), record.id, record.version, {})
      }
      for (const ref of [...new Set(input.blockedBy ?? [])]) {
        record = await mutate("task.dependency.add", record.id, record.version, { dependsOnId: await resolveRef(ref) })
      }

      return toTask(record)
    },
  }
}

interface Detection {
  directory: string
  databasePath: string
  syncRoot: string
  candidatesKey: string
  category: string | undefined
}

let detection: Detection | null = null

function detectCategory(workspace: TasksWorkspace): string | undefined {
  const directory = process.cwd()
  const candidates = categoryCandidatesForDirectory(basename(directory))
  const candidatesKey = candidates.join("\u0000")
  if (
    detection?.directory === directory
    && detection.databasePath === workspace.databasePath
    && detection.syncRoot === workspace.syncRoot
    && detection.candidatesKey === candidatesKey
  ) return detection.category

  const category = detectCategorySlug(workspace.syncRoot, candidates)
  detection = { directory, databasePath: workspace.databasePath, syncRoot: workspace.syncRoot, candidatesKey, category }
  return category
}

/** An explicit category asks for Tasks even before a task uses it. */
function configuredCategory(): string | undefined {
  return process.env.PI_TASKS_TASKS_CATEGORY?.trim().toLowerCase() || undefined
}

function effectiveCategory(workspace: TasksWorkspace): string | undefined {
  return configuredCategory() ?? detectCategory(workspace)
}

function isApplicable(): boolean {
  const workspace = resolveTasksWorkspace()
  if (!existsSync(workspace.databasePath)) return false

  return configuredCategory() !== undefined || detectCategory(workspace) !== undefined
}

export const tasksAdapterInitializer: TaskAdapterInitializer = {
  id: "tasks",
  isApplicable,
  initialize: () => {
    const workspace = resolveTasksWorkspace()
    const client = new TasksCliClient(resolveLaunchCandidates(workspace))
    return createTasksAdapter({
      category: effectiveCategory(workspace),
      request: <T>(command: string, args: Record<string, unknown> = {}) => client.request<T>(command, args),
    })
  },
}

export default tasksAdapterInitializer
