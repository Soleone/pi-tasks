import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { Task, TaskStatus } from "../../models/task.ts"
import type { CreateTaskInput, TaskAdapter, TaskAdapterInitializer, TaskStatusMap, TaskUpdate } from "../api.ts"

const MAX_LIST_RESULTS = 100
const SQ_QUEUE_PATH_ENV = "PI_TASKS_SQ_QUEUE_PATH"

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

interface SqItem {
  id: string
  title?: string
  description?: string
  status: string
  metadata?: Record<string, unknown>
  blocked_by?: string[]
  created_at?: string
  updated_at?: string
}

interface TaskMetadata {
  priority?: string
  taskType?: string
  dueAt?: string
}

function configuredQueuePath(): string | null {
  const value = process.env[SQ_QUEUE_PATH_ENV]?.trim()
  return value && value.length > 0 ? value : null
}

function resolveQueuePath(): string | null {
  const configured = configuredQueuePath()
  if (!configured) return null
  return resolve(process.cwd(), configured)
}

function normalizePriority(value: unknown): string | undefined {
  if (typeof value === "number") {
    const label = `p${value}`
    return PRIORITIES.includes(label) ? label : undefined
  }

  if (typeof value !== "string") return undefined
  const normalized = value.toLowerCase()
  return PRIORITIES.includes(normalized) ? normalized : undefined
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function extractTaskMetadata(metadata: Record<string, unknown> | undefined): TaskMetadata {
  if (!metadata) return {}

  return {
    priority: normalizePriority(metadata.priority),
    taskType: normalizeText(metadata.taskType ?? metadata.type),
    dueAt: normalizeText(metadata.dueAt ?? metadata.due_at),
  }
}

function toBackendStatus(status: TaskStatus): string {
  const mapped = STATUS_MAP[status]
  if (!mapped) throw new Error(`Unsupported status for sq backend: ${status}`)
  return mapped
}

function isBlockedByPending(blockedBy: string[] | undefined, pendingIds: Set<string> | undefined): boolean {
  if ((blockedBy?.length ?? 0) === 0) return false
  if (!pendingIds) return false
  return blockedBy.some(id => pendingIds.has(id))
}

function fromBackendStatus(status: string, blockedBy: string[] | undefined, pendingIds?: Set<string>): TaskStatus {
  if (status === STATUS_MAP.inProgress) return "inProgress"
  if (status === STATUS_MAP.closed) return "closed"
  if (isBlockedByPending(blockedBy, pendingIds)) return "blocked"
  return "open"
}

function toTask(item: SqItem, pendingIds?: Set<string>): Task {
  const metadata = extractTaskMetadata(item.metadata)

  return {
    ref: item.id,
    id: item.id,
    title: item.title?.trim() || item.id,
    description: item.description ?? "",
    status: fromBackendStatus(item.status, item.blocked_by, pendingIds),
    priority: metadata.priority,
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
  const queuePath = resolveQueuePath()
  const queueExists = queuePath ? existsSync(queuePath) : existsSync(resolve(process.cwd(), ".sift"))
  if (!queueExists) return false

  const result = spawnSync("sq", ["--help"], { stdio: "ignore" })
  return !result.error
}

function initialize(pi: ExtensionAPI): TaskAdapter {
  async function execSq(args: string[], timeout = 30_000): Promise<string> {
    const queuePath = resolveQueuePath()
    const fullArgs = queuePath ? ["--queue", queuePath, ...args] : args

    const result = await pi.exec("sq", fullArgs, { timeout })
    if (result.code !== 0) {
      const details = (result.stderr || result.stdout || "").trim()
      throw new Error(details.length > 0 ? details : `sq ${fullArgs.join(" ")} failed (code ${result.code})`)
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

    async list(): Promise<Task[]> {
      const [pendingOut, inProgressOut] = await Promise.all([
        execSq(["list", "--status", STATUS_MAP.open, "--json"]),
        execSq(["list", "--status", STATUS_MAP.inProgress, "--json"]),
      ])

      const pendingItems = parseJsonArray<SqItem>(pendingOut, "list pending")
      const inProgressItems = parseJsonArray<SqItem>(inProgressOut, "list in_progress")
      const pendingIds = new Set(pendingItems.map(item => item.id))

      const dedupedById = new Map<string, Task>()
      for (const item of [...inProgressItems, ...pendingItems]) {
        dedupedById.set(item.id, toTask(item, pendingIds))
      }

      return sortActiveTasks([...dedupedById.values()]).slice(0, MAX_LIST_RESULTS)
    },

    async show(ref: string): Promise<Task> {
      const item = await showRaw(ref)

      let pendingIds: Set<string> | undefined
      if (item.status === STATUS_MAP.open && (item.blocked_by?.length ?? 0) > 0) {
        const pendingOut = await execSq(["list", "--status", STATUS_MAP.open, "--json"])
        const pendingItems = parseJsonArray<SqItem>(pendingOut, "list pending")
        pendingIds = new Set(pendingItems.map(pendingItem => pendingItem.id))
      }

      return toTask(item, pendingIds)
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

      const metadataPatch: Record<string, unknown> = {}
      if (update.priority !== undefined) metadataPatch.priority = update.priority
      if (update.taskType !== undefined) metadataPatch.taskType = update.taskType || TASK_TYPES[0]
      if (update.dueAt !== undefined) metadataPatch.dueAt = update.dueAt

      if (Object.keys(metadataPatch).length > 0) {
        args.push("--merge-metadata", JSON.stringify(metadataPatch))
      }

      if (args.length === 2) return
      await execSq(args)
    },

    async create(input: CreateTaskInput): Promise<Task> {
      const title = input.title.trim()
      const description = input.description ?? ""
      const selectedPriority = input.priority ?? PRIORITIES[Math.floor(PRIORITIES.length / 2)]
      const selectedTaskType = input.taskType || TASK_TYPES[0]

      const metadata: Record<string, unknown> = {
        priority: selectedPriority,
        taskType: selectedTaskType,
      }

      if (input.dueAt && input.dueAt.length > 0) {
        metadata.dueAt = input.dueAt
      }

      const sourceText = description.trim().length > 0 ? description : title

      const out = await execSq([
        "add",
        "--title", title,
        "--description", description,
        "--text", sourceText,
        "--metadata", JSON.stringify(metadata),
        "--json",
      ])

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
