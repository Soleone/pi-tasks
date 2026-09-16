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
import type { Task } from "../../../models/task.ts"
import { PRIORITIES, PRIORITY_HOTKEYS } from "../shared/constants.ts"
import { sortActiveTasks, sortClosedTasks } from "../shared/sorting.ts"
import {
  categoryCandidatesForDirectory,
  detectCategorySlug,
  resolveLaunchCandidates,
  resolveTasksWorkspace,
  type TasksWorkspace,
} from "./discovery.ts"
import { TasksProtocolClient } from "./client.ts"
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
      "The pi-tasks extension is using the `tasks` backend, which talks to the Tasks app",
      "workspace over its JSON-lines command path, so edits are shared with the desktop app immediately.",
      category
        ? `This project is scoped to the \`@${category}\` category matched from the directory name;`
          + " pi-tasks keeps that token in the task title so tasks stay in scope."
        : "This project is not scoped to a category, so every task in the workspace is listed.",
      "Tasks has no task types or due dates; use `#tags` in the description for finer classification.",
      "Outside the Tasks UI, commands go to the backend as JSON lines (`--stdio --database <path>`):",
      "runtime.probe, task.list, task.get, task.create, task.update, task.start, task.pause,",
      "task.complete, task.reopen, task.move, task.dependency.add, task.dependency.remove.",
      "Every mutation needs the current `expectedVersion`; task ids may be given as unambiguous prefixes.",
    ].join(" "),
  }
}

/**
 * Adapter for the Tasks product command path. Reads and writes go through the
 * same typed commands as the desktop app, so nothing here needs the SQLite
 * cache or the canonical files beyond cheap discovery.
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

  async function matchingIds(prefix: string): Promise<string[]> {
    const needle = prefix.trim().toLowerCase()
    if (needle.length === 0) return []

    const [active, closed] = await Promise.all([listRecords(false), listRecords(true)])
    return [...active, ...closed].map(record => record.id).filter(id => id.toLowerCase().startsWith(needle))
  }

  /** Tasks addresses tasks by UUID, but the list shows a short id prefix. */
  async function resolveRef(ref: string): Promise<string> {
    const trimmed = ref.trim()
    if (isFullTaskId(trimmed)) return trimmed

    const matches = await matchingIds(trimmed)
    if (matches.length === 1) return matches[0]!
    if (matches.length > 1) {
      throw new Error(`Task "${trimmed}" matches ${matches.length} tasks; use a longer id prefix`)
    }

    throw new Error(`No task matches "${trimmed}"${category ? ` in the @${category} category` : ""}`)
  }

  async function getRecordById(id: string): Promise<TasksTaskRecord> {
    const result = await request<{ task?: TasksTaskRecord }>("task.get", { id })
    if (!result.task) throw new Error(`Tasks backend returned no task for ${id}`)
    return result.task
  }

  async function getRecord(ref: string): Promise<TasksTaskRecord> {
    return getRecordById(await resolveRef(ref))
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

  async function blockerContext(record: TasksTaskRecord): Promise<Map<string, TasksTaskRecord>> {
    const blockers = await Promise.all(record.blockedByIds.map(async ref => {
      try {
        return await getRecordById(ref)
      } catch {
        return undefined
      }
    }))

    return new Map(blockers.filter((blocker): blocker is TasksTaskRecord => Boolean(blocker)).map(blocker => [blocker.id, blocker]))
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
      const known = new Map(records.map(record => [record.id, record]))
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
      return toTask(record, await blockerContext(record))
    },

    async update(ref: string, update: TaskUpdate): Promise<void> {
      const id = await resolveRef(ref)
      if (update.parentRef === id) throw new Error("A task cannot be its own parent")
      if (update.blockedBy?.includes(id)) throw new Error("A task cannot block itself")

      let current = await getRecordById(id)

      const content = contentUpdate(update, current)
      if (Object.keys(content).length > 0) {
        current = await mutate("task.update", id, current.version, content)
      }

      if (update.status && update.status !== "blocked" && toBackendStatus(update.status) !== current.status) {
        current = await mutate(transitionCommand(update.status), id, current.version, {})
      }

      if (update.parentRef !== undefined && (update.parentRef ?? null) !== current.parentId) {
        current = await mutate("task.move", id, current.version, { parentId: update.parentRef ?? null })
      }

      if (update.blockedBy !== undefined) {
        // Canceled dependencies stay untouched: they are history rather than
        // readiness, and the UI never sees them as blockers.
        const desired = [...new Set(update.blockedBy)]
        for (const ref of current.blockedByIds.filter(candidate => !desired.includes(candidate))) {
          current = await mutate("task.dependency.remove", id, current.version, { dependsOnId: ref })
        }
        for (const ref of desired.filter(candidate => !current.blockedByIds.includes(candidate))) {
          current = await mutate("task.dependency.add", id, current.version, { dependsOnId: await resolveRef(ref) })
        }
      }
    },

    async create(input: CreateTaskInput): Promise<Task> {
      const description = input.description ?? ""
      const args: Record<string, unknown> = {
        title: scopedTitle(input.title.trim(), description),
        descriptionMarkdown: description,
        priority: toBackendPriority(input.priority) ?? DEFAULT_PRIORITY,
      }
      if (input.parentRef) args.parentId = await resolveRef(input.parentRef)

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
  category: string | undefined
}

let detection: Detection | null = null

function detectCategory(workspace: TasksWorkspace): string | undefined {
  const directory = process.cwd()
  if (detection?.directory === directory) return detection.category

  const category = detectCategorySlug(workspace.syncRoot, categoryCandidatesForDirectory(basename(directory)))
  detection = { directory, category }
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
    const client = new TasksProtocolClient(resolveLaunchCandidates(workspace))
    return createTasksAdapter({
      category: effectiveCategory(workspace),
      request: <T>(command: string, args: Record<string, unknown> = {}) => client.request<T>(command, args),
    })
  },
}

export default tasksAdapterInitializer
