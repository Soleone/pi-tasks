import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { spawnSync } from "node:child_process"
import type { Task, TaskStatus } from "../../models/task.ts"
import type {
  CreateTaskInput,
  TaskAdapter,
  TaskAdapterInitializer,
  TaskSessionContextMessage,
  TaskStatusMap,
  TaskUpdate,
} from "../api.ts"

const MAX_LIST_RESULTS = 100
const PI_TASKS_METADATA_KEY = "pi_tasks"

const STATUS_MAP = {
  open: "pending",
  inProgress: "in_progress",
  closed: "closed",
} satisfies TaskStatusMap

const TASK_TYPES = ["task", "feature", "bug", "chore", "epic"]
const PRIORITIES = ["p0", "p1", "p2", "p3", "p4"]
const PRIORITY_HOTKEYS: Record<string, string> = {
  "0": "p0",
  "1": "p1",
  "2": "p2",
  "3": "p3",
  "4": "p4",
}

const SESSION_CONTEXT_MESSAGE: TaskSessionContextMessage = {
  customType: "pi-tasks-backend-context-sq-v1",
  content: [
    "The pi-tasks extension is using the `sq` backend for this project.",
    "If you need direct `sq` CLI guidance, run `sq prime`.",
    "When manipulating pi-tasks metadata through `sq`, store it under",
    "`pi_tasks`, for example",
    "`--metadata '{\"pi_tasks\":{\"taskType\":\"TYPE\",\"dueAt\":\"TIMESTAMP\"}}'`,",
    "or merge the same shape with `--merge-metadata`.",
  ].join(" "),
}

interface SqItem {
  id: string
  title?: string
  description?: string
  status: string
  priority?: number | string
  metadata?: Record<string, unknown>
  blocked_by?: string[]
  created_at?: string
  updated_at?: string
}

interface TaskMetadata {
  taskType?: string
  dueAt?: string
}

function normalizePriority(value: unknown): string | undefined {
  if (typeof value === "number") {
    const label = `p${value}`
    return PRIORITIES.includes(label) ? label : undefined
  }

  if (typeof value !== "string") return undefined

  const numericPriority = Number.parseInt(value, 10)
  if (String(numericPriority) === value.trim()) {
    return normalizePriority(numericPriority)
  }

  const normalized = value.toLowerCase()
  return PRIORITIES.includes(normalized) ? normalized : undefined
}

function toBackendPriority(priority: string): string {
  const normalized = normalizePriority(priority)
  if (!normalized) throw new Error(`Unsupported priority for sq backend: ${priority}`)
  return normalized.slice(1)
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function extractTaskMetadata(metadata: Record<string, unknown> | undefined): TaskMetadata {
  if (!metadata) return {}

  const piTasks = asRecord(metadata[PI_TASKS_METADATA_KEY])
  if (!piTasks) return {}

  return {
    taskType: normalizeText(piTasks.taskType),
    dueAt: normalizeText(piTasks.dueAt),
  }
}

function buildPiTasksMetadata(input: { taskType?: string, dueAt?: string }): Record<string, unknown> | undefined {
  const piTasks: Record<string, unknown> = {}

  if (input.taskType !== undefined) {
    piTasks.taskType = input.taskType || TASK_TYPES[0]
  }

  if (input.dueAt !== undefined) {
    piTasks.dueAt = input.dueAt
  }

  return Object.keys(piTasks).length > 0
    ? { [PI_TASKS_METADATA_KEY]: piTasks }
    : undefined
}

function toBackendStatus(status: TaskStatus): string {
  const mapped = STATUS_MAP[status]
  if (!mapped) throw new Error(`Unsupported status for sq backend: ${status}`)
  return mapped
}

function fromBackendStatus(status: string, blockedBy: string[] | undefined): TaskStatus {
  if (status === STATUS_MAP.inProgress) return "inProgress"
  if (status === STATUS_MAP.closed) return "closed"
  if ((blockedBy?.length ?? 0) > 0) return "blocked"
  return "open"
}

function toTask(item: SqItem): Task {
  const metadata = extractTaskMetadata(item.metadata)

  return {
    ref: item.id,
    id: item.id,
    title: item.title?.trim() || item.id,
    description: item.description ?? "",
    status: fromBackendStatus(item.status, item.blocked_by),
    priority: normalizePriority(item.priority),
    taskType: metadata.taskType,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    dueAt: metadata.dueAt,
    dependencyCount: item.blocked_by?.length,
  }
}

function taskStatusSortRank(status: TaskStatus): number {
  if (status === "inProgress") return 0
  if (status === "open") return 1
  if (status === "blocked") return 2
  return 3
}

function taskPrioritySortRank(priority: string | undefined): number {
  if (!priority) return PRIORITIES.length + 1
  const index = PRIORITIES.indexOf(priority)
  return index >= 0 ? index : PRIORITIES.length
}

function sortActiveTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((left, right) => {
    const statusOrder = taskStatusSortRank(left.status) - taskStatusSortRank(right.status)
    if (statusOrder !== 0) return statusOrder

    const priorityOrder = taskPrioritySortRank(left.priority) - taskPrioritySortRank(right.priority)
    if (priorityOrder !== 0) return priorityOrder

    return left.ref.localeCompare(right.ref)
  })
}

function parseJsonArray<T>(stdout: string, context: string): T[] {
  try {
    const parsed = JSON.parse(stdout)
    if (!Array.isArray(parsed)) throw new Error("expected JSON array")
    return parsed as T[]
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to parse sq output (${context}): ${message}`)
  }
}

function parseJsonObject<T>(stdout: string, context: string): T {
  try {
    const parsed = JSON.parse(stdout)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected JSON object")
    }
    return parsed as T
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to parse sq output (${context}): ${message}`)
  }
}

function isApplicable(): boolean {
  const result = spawnSync("sq", ["--help"], { stdio: "ignore" })
  return !result.error
}

function initialize(pi: ExtensionAPI): TaskAdapter {
  async function execSq(args: string[], timeout = 30_000): Promise<string> {
    const result = await pi.exec("sq", args, { timeout })
    if (result.code !== 0) {
      const details = (result.stderr || result.stdout || "").trim()
      throw new Error(details.length > 0 ? details : `sq ${args.join(" ")} failed (code ${result.code})`)
    }

    return result.stdout
  }

  async function showRaw(ref: string): Promise<SqItem> {
    const out = await execSq(["show", ref, "--json"])
    return parseJsonObject<SqItem>(out, `show ${ref}`)
  }

  return {
    id: "sq",
    statusMap: STATUS_MAP,
    taskTypes: TASK_TYPES,
    priorities: PRIORITIES,
    priorityHotkeys: PRIORITY_HOTKEYS,
    sessionContextMessage: SESSION_CONTEXT_MESSAGE,

    async list(): Promise<Task[]> {
      const [pendingOut, inProgressOut] = await Promise.all([
        execSq(["list", "--status", STATUS_MAP.open, "--json"]),
        execSq(["list", "--status", STATUS_MAP.inProgress, "--json"]),
      ])

      const pendingItems = parseJsonArray<SqItem>(pendingOut, "list pending")
      const inProgressItems = parseJsonArray<SqItem>(inProgressOut, "list in_progress")

      const dedupedById = new Map<string, Task>()
      for (const item of [...inProgressItems, ...pendingItems]) {
        dedupedById.set(item.id, toTask(item))
      }

      return sortActiveTasks([...dedupedById.values()]).slice(0, MAX_LIST_RESULTS)
    },

    async show(ref: string): Promise<Task> {
      return toTask(await showRaw(ref))
    },

    async update(ref: string, update: TaskUpdate): Promise<void> {
      const args = ["edit", ref]

      if (update.title !== undefined) {
        args.push("--set-title", update.title.trim())
      }

      if (update.description !== undefined) {
        args.push("--set-description", update.description)
      }

      if (update.status !== undefined) {
        args.push("--set-status", toBackendStatus(update.status))
      }

      if (update.priority !== undefined) {
        args.push("--set-priority", toBackendPriority(update.priority))
      }

      const metadataPatch = buildPiTasksMetadata({
        taskType: update.taskType,
        dueAt: update.dueAt,
      })

      if (metadataPatch) {
        args.push("--merge-metadata", JSON.stringify(metadataPatch))
      }

      if (args.length === 2) return
      await execSq(args)
    },

    async create(input: CreateTaskInput): Promise<Task> {
      const title = input.title.trim()
      const description = input.description ?? ""
      const selectedPriority = input.priority ?? PRIORITIES[Math.floor(PRIORITIES.length / 2)]
      const metadata = buildPiTasksMetadata({
        taskType: input.taskType || TASK_TYPES[0],
        dueAt: input.dueAt,
      })
      const sourceText = description.trim().length > 0 ? description : title

      const args = [
        "add",
        "--title", title,
        "--description", description,
        "--priority", toBackendPriority(selectedPriority),
        "--text", sourceText,
        "--json",
      ]

      if (metadata) {
        args.push("--metadata", JSON.stringify(metadata))
      }

      const out = await execSq(args)
      const created = parseJsonObject<SqItem>(out, "create")

      if (input.status && input.status !== "open") {
        await execSq(["edit", created.id, "--set-status", toBackendStatus(input.status)])
        return toTask(await showRaw(created.id))
      }

      return toTask(created)
    },
  }
}

export default {
  id: "sq",
  isApplicable,
  initialize,
} satisfies TaskAdapterInitializer
