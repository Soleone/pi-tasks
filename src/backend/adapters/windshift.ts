import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { Task, TaskStatus } from "../../models/task.ts"
import type {
  CreateTaskInput,
  TaskAdapter,
  TaskAdapterInitializer,
  TaskSessionContextMessage,
  TaskStatusMap,
  TaskUpdate,
} from "../api.ts"

// Windshift is driven through the `ws` CLI, which reads its workspace + token
// from `ws.toml` (project) or the global config. Every command supports
// `-o json`, so this adapter shells out exactly like the sq/tq adapters do.
const COMMAND = "ws"
const WS_CONFIG_FILE = "ws.toml"
const MAX_LIST_RESULTS = 100
const DEFAULT_TASK_TYPE = "Task"

// pi-tasks statuses map onto the `ws task move` aliases, which resolve the
// underlying workflow transition (by alias, name, or id) for us.
const STATUS_MAP = {
  open: "open",
  inProgress: "progress",
  closed: "done",
} satisfies TaskStatusMap

const SESSION_CONTEXT_MESSAGE: TaskSessionContextMessage = {
  customType: "pi-tasks-backend-context-windshift-v1",
  content: [
    "The pi-tasks extension is using the Windshift backend for this project,",
    "backed by the `ws` CLI against the workspace configured in `ws.toml`.",
    "Tasks are Windshift work items keyed like `WI-123`.",
    "For anything beyond list/show/create/edit/status — comments, links,",
    "milestones, pages, sub-tasks — use the `ws` CLI directly (for example",
    "`ws task get WI-123`, `ws comment add`, `ws link add`).",
  ].join(" "),
}

interface WsRef {
  id: number
  name: string
}

interface WsItem {
  id: number
  key: string
  title?: string
  description?: string
  status?: WsRef
  priority?: { id: number; name: string }
  item_type?: WsRef
  due_date?: string | null
  created_at?: string
  updated_at?: string
}

interface WsItemType {
  id: number
  name: string
}

interface WsPriority {
  id: number
  name: string
  sort_order?: number
}

interface WsStatus {
  id: number
  name: string
  category_name?: string
  is_completed?: boolean
}

function parseJson(out: string, context: string): unknown {
  try {
    return JSON.parse(out)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to parse ws ${context} output: ${message}`)
  }
}

// `ws` list commands print a bare JSON array; tolerate a `{ data: [...] }`
// envelope as well so the adapter is robust to output-shape tweaks.
function asArray<T>(out: string, context: string): T[] {
  const parsed = parseJson(out, context)
  if (Array.isArray(parsed)) return parsed as T[]
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { data?: unknown }).data)) {
    return (parsed as { data: T[] }).data
  }
  throw new Error(`Expected a JSON array from ws ${context}`)
}

function asObject<T>(out: string, context: string): T {
  const parsed = parseJson(out, context)
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as T
  throw new Error(`Expected a JSON object from ws ${context}`)
}

const FALLBACK_TASK_TYPES = ["Task", "Bug", "Story", "Epic", "Sub-task", "Initiative"]
// Windshift's default priority catalog, highest-first. Used for the edit-form
// toggle when the running `ws` can't enumerate priorities; per-task priority is
// still displayed from the work item itself either way.
const FALLBACK_PRIORITIES = ["Critical", "High", "Medium", "Low"]

function classifyStatus(status: WsStatus): TaskStatus {
  if (status.is_completed) return "closed"
  if ((status.category_name ?? "").toLowerCase() === "in progress") return "inProgress"
  return "open"
}

// Used when the status catalog is unavailable (reduced-scope token) or a status
// name isn't in the catalog: classify by the name itself.
function classifyStatusByName(name: string): TaskStatus {
  const lower = name.toLowerCase()
  if (/(in[\s_-]?progress|doing|started|review)/.test(lower)) return "inProgress"
  if (/(done|closed|resolved|complete|completed|cancell?ed|shipped)/.test(lower)) return "closed"
  if (/(block)/.test(lower)) return "blocked"
  return "open"
}

// Put the default task type first (pi-tasks treats taskTypes[0] as the default),
// then keep the remaining workspace item types in their configured order.
function orderTaskTypes(names: string[]): string[] {
  const ordered: string[] = []
  const seen = new Set<string>()

  const preferred = names.find(name => name.toLowerCase() === DEFAULT_TASK_TYPE.toLowerCase())
  if (preferred) {
    ordered.push(preferred)
    seen.add(preferred)
  }
  for (const name of names) {
    if (!seen.has(name)) {
      ordered.push(name)
      seen.add(name)
    }
  }

  return ordered.length > 0 ? ordered : [DEFAULT_TASK_TYPE]
}

function taskStatusSortRank(status: TaskStatus): number {
  if (status === "inProgress") return 0
  if (status === "open") return 1
  if (status === "blocked") return 2
  return 3
}

function execSyncWs(args: string[]): string {
  const result = spawnSync(COMMAND, args, { encoding: "utf8" })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || "").trim()
    throw new Error(details.length > 0 ? details : `ws ${args.join(" ")} failed`)
  }
  return result.stdout
}

function isApplicable(): boolean {
  // Only auto-detect inside a Windshift-connected project. PI_TASKS_BACKEND can
  // still force this adapter even without a ws.toml in the working directory.
  if (!existsSync(resolve(process.cwd(), WS_CONFIG_FILE))) return false
  const result = spawnSync(COMMAND, ["version"], { stdio: "ignore" })
  return !result.error && result.status === 0
}

function initialize(pi: ExtensionAPI): TaskAdapter {
  // Resolve workspace metadata once, synchronously, so the readonly taskTypes /
  // status mapping are ready before the UI renders. `ws` scopes both lookups to
  // the workspace configured in ws.toml. Degrade gracefully if a reduced-scope
  // token can't read the type/status catalogs — the read paths still work.
  const itemTypeIdByName = new Map<string, number>()
  let taskTypes = FALLBACK_TASK_TYPES
  try {
    const itemTypes = asArray<WsItemType>(execSyncWs(["item-type", "ls", "-o", "json"]), "item-type ls")
    for (const type of itemTypes) itemTypeIdByName.set(type.name.toLowerCase(), type.id)
    taskTypes = orderTaskTypes(itemTypes.map(type => type.name))
  } catch {
    // keep fallback task types; create/edit will omit --type and use the
    // workspace default item type.
  }

  const statusKindByName = new Map<string, TaskStatus>()
  try {
    const statuses = asArray<WsStatus>(execSyncWs(["status", "ls", "-o", "json"]), "status ls")
    for (const status of statuses) statusKindByName.set(status.name.toLowerCase(), classifyStatus(status))
  } catch {
    // fall back to name-based status classification below.
  }

  // Priorities power the edit-form toggle (the host requires 3-5). The `ws` CLI
  // has no priority-list command yet, so fall back to the default catalog; once
  // `ws priority ls` exists this lights up priority editing automatically.
  const priorityIdByName = new Map<string, number>()
  let priorities = FALLBACK_PRIORITIES
  try {
    const rows = asArray<WsPriority>(execSyncWs(["priority", "ls", "-o", "json"]), "priority ls")
    if (rows.length >= 3) {
      for (const row of rows) priorityIdByName.set(row.name.toLowerCase(), row.id)
      priorities = [...rows]
        .sort((left, right) => (left.sort_order ?? 0) - (right.sort_order ?? 0))
        .map(row => row.name)
        .slice(0, 5)
    }
  } catch {
    // keep the fallback catalog; priority editing is a no-op (display only).
  }

  function statusKind(name: string | undefined): TaskStatus {
    if (!name) return "open"
    return statusKindByName.get(name.toLowerCase()) ?? classifyStatusByName(name)
  }

  function resolveTypeId(taskType: string | undefined): number | undefined {
    return itemTypeIdByName.get((taskType || DEFAULT_TASK_TYPE).toLowerCase())
  }

  function resolvePriorityId(priority: string | undefined): number | undefined {
    return priority ? priorityIdByName.get(priority.toLowerCase()) : undefined
  }

  function toTask(item: WsItem): Task {
    return {
      ref: item.key,
      id: item.key,
      title: item.title?.trim() || item.key,
      description: item.description ?? "",
      status: statusKind(item.status?.name),
      priority: item.priority?.name,
      taskType: item.item_type?.name,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      dueAt: item.due_date ?? undefined,
    }
  }

  async function exec(args: string[], timeout = 30_000): Promise<string> {
    const result = await pi.exec(COMMAND, args, { timeout })
    if (result.code !== 0) {
      const details = (result.stderr || result.stdout || "").trim()
      throw new Error(details.length > 0 ? details : `ws ${args.join(" ")} failed (code ${result.code})`)
    }
    return result.stdout
  }

  return {
    id: "windshift",
    statusMap: STATUS_MAP,
    taskTypes,
    priorities,
    sessionContextMessage: SESSION_CONTEXT_MESSAGE,

    async list(): Promise<Task[]> {
      const out = await exec(["task", "ls", "-s", "~done", "-o", "json"])
      const items = asArray<WsItem>(out, "task ls").map(toTask)

      return items
        .sort((left, right) => {
          const byStatus = taskStatusSortRank(left.status) - taskStatusSortRank(right.status)
          if (byStatus !== 0) return byStatus
          return left.ref.localeCompare(right.ref)
        })
        .slice(0, MAX_LIST_RESULTS)
    },

    async show(ref: string): Promise<Task> {
      return toTask(asObject<WsItem>(await exec(["task", "get", ref, "-o", "json"]), `task get ${ref}`))
    },

    async update(ref: string, update: TaskUpdate): Promise<void> {
      const editArgs = ["task", "edit", ref]
      let hasEdit = false

      if (update.title !== undefined) {
        editArgs.push("-t", update.title.trim())
        hasEdit = true
      }
      if (update.description !== undefined) {
        editArgs.push("-d", update.description)
        hasEdit = true
      }
      if (update.taskType !== undefined) {
        const typeId = resolveTypeId(update.taskType)
        if (typeId !== undefined) {
          editArgs.push("--type", String(typeId))
          hasEdit = true
        }
      }
      if (update.priority !== undefined) {
        // Only settable when the priority catalog could be resolved (see init);
        // otherwise the change is dropped and priority stays display-only.
        const priorityId = resolvePriorityId(update.priority)
        if (priorityId !== undefined) {
          editArgs.push("--priority", String(priorityId))
          hasEdit = true
        }
      }

      if (hasEdit) {
        editArgs.push("-o", "json")
        await exec(editArgs)
      }

      if (update.status !== undefined) {
        const target = STATUS_MAP[update.status]
        if (target) await exec(["task", "move", ref, target, "-o", "json"])
      }
    },

    async create(input: CreateTaskInput): Promise<Task> {
      const args = ["task", "create", "-t", input.title.trim()]
      if (input.description) args.push("-d", input.description)

      const typeId = resolveTypeId(input.taskType)
      if (typeId !== undefined) args.push("--type", String(typeId))

      const priorityId = resolvePriorityId(input.priority)
      if (priorityId !== undefined) args.push("--priority", String(priorityId))

      args.push("-o", "json")
      const created = asObject<WsItem>(await exec(args), "task create")

      if (input.status && input.status !== "open") {
        const target = STATUS_MAP[input.status]
        if (target) {
          await exec(["task", "move", created.key, target, "-o", "json"])
          return toTask(asObject<WsItem>(await exec(["task", "get", created.key, "-o", "json"]), `task get ${created.key}`))
        }
      }

      return toTask(created)
    },
  }
}

export default {
  id: "windshift",
  isApplicable,
  initialize,
} satisfies TaskAdapterInitializer
