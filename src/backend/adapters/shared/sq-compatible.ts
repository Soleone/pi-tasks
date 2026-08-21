import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import type { Task, TaskStatus } from "../../../models/task.ts"
import { createCliRunner, parseJsonArray, parseJsonObject } from "./cli.ts"
import { PRIORITIES, PRIORITY_HOTKEYS, TASK_TYPES } from "./constants.ts"
import { sortActiveTasks, sortClosedTasks } from "./sorting.ts"
import type {
  CreateTaskInput,
  TaskAdapter,
  TaskAdapterInitializer,
  TaskListScope,
  TaskSessionContextMessage,
  TaskStatusMap,
  TaskUpdate,
} from "../../api.ts"

const PI_TASKS_METADATA_KEY = "pi_tasks"

const STATUS_MAP = {
  open: "pending",
  inProgress: "in_progress",
  closed: "closed",
} satisfies TaskStatusMap

interface SqCompatibleAdapterOptions {
  id: string
  command: string
  sessionContextMessage: TaskSessionContextMessage
  isApplicable(): boolean
}

interface SqCompatibleItem {
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
  parentRef?: string
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

function toBackendPriority(priority: string, backendId: string): string {
  const normalized = normalizePriority(priority)
  if (!normalized) throw new Error(`Unsupported priority for ${backendId} backend: ${priority}`)
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
    parentRef: normalizeText(piTasks.parentRef),
  }
}

function buildPiTasksMetadata(input: {
  taskType?: string
  dueAt?: string
  parentRef?: string | null
}): Record<string, unknown> | undefined {
  const piTasks: Record<string, unknown> = {}

  if (input.taskType !== undefined) {
    piTasks.taskType = input.taskType || TASK_TYPES[0]
  }

  if (input.dueAt !== undefined) {
    piTasks.dueAt = input.dueAt
  }

  if (input.parentRef !== undefined) {
    piTasks.parentRef = input.parentRef ?? ""
  }

  return Object.keys(piTasks).length > 0
    ? { [PI_TASKS_METADATA_KEY]: piTasks }
    : undefined
}

function toBackendStatus(status: TaskStatus, backendId: string): string {
  const mapped = STATUS_MAP[status]
  if (!mapped) throw new Error(`Unsupported status for ${backendId} backend: ${status}`)
  return mapped
}

function optionWithValue(option: string, value: string): string {
  return `${option}=${value}`
}

function fromBackendStatus(status: string): TaskStatus {
  if (status === STATUS_MAP.inProgress) return "inProgress"
  if (status === STATUS_MAP.closed) return "closed"
  return "open"
}

function toTask(item: SqCompatibleItem, itemsById: ReadonlyMap<string, SqCompatibleItem> = new Map()): Task {
  const metadata = extractTaskMetadata(item.metadata)
  const blockers = (item.blocked_by ?? []).map((ref) => {
    const blocker = itemsById.get(ref)
    return {
      ref,
      title: blocker?.title?.trim() || undefined,
      status: blocker ? fromBackendStatus(blocker.status) : undefined,
    }
  })
  const lifecycleStatus = fromBackendStatus(item.status)

  return {
    ref: item.id,
    id: item.id,
    title: item.title?.trim() || item.id,
    description: item.description ?? "",
    // `blocked_by` is readiness information, not the backend lifecycle state.
    // Keep the native status intact and let the UI derive the blocked marker.
    status: lifecycleStatus,
    priority: normalizePriority(item.priority),
    taskType: metadata.taskType,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    dueAt: metadata.dueAt,
    parentRef: metadata.parentRef,
    blockers,
    dependencyCount: blockers.length,
  }
}

function initialize(pi: ExtensionAPI, options: SqCompatibleAdapterOptions): TaskAdapter {
  const execCommand = createCliRunner(pi, options.command)

  async function showRaw(ref: string): Promise<SqCompatibleItem> {
    const out = await execCommand(["show", ref, "--json"])
    return parseJsonObject<SqCompatibleItem>(out, `show ${ref}`, options.command)
  }

  return {
    id: options.id,
    capabilities: { hierarchy: "metadata", dependencies: "native" },
    statusMap: STATUS_MAP,
    taskTypes: TASK_TYPES,
    priorities: PRIORITIES,
    priorityHotkeys: PRIORITY_HOTKEYS,
    sessionContextMessage: options.sessionContextMessage,

    async list(scope: TaskListScope = "active"): Promise<Task[]> {
      const out = await execCommand(["list", "--all", "--json"])
      const allItems = parseJsonArray<SqCompatibleItem>(out, "list all", options.command)
      const itemsById = new Map(allItems.map(item => [item.id, item]))
      const scopedItems = allItems.filter(item => (
        scope === "closed" ? item.status === STATUS_MAP.closed : item.status !== STATUS_MAP.closed
      ))
      const tasks = scopedItems.map(item => toTask(item, itemsById))
      const childCounts = new Map<string, number>()
      for (const task of tasks) {
        if (task.parentRef) childCounts.set(task.parentRef, (childCounts.get(task.parentRef) ?? 0) + 1)
      }
      for (const task of tasks) task.childCount = childCounts.get(task.ref) ?? 0
      return scope === "closed" ? sortClosedTasks(tasks) : sortActiveTasks(tasks)
    },

    async show(ref: string): Promise<Task> {
      const [item, allOut] = await Promise.all([
        showRaw(ref),
        execCommand(["list", "--all", "--json"]),
      ])
      const allItems = parseJsonArray<SqCompatibleItem>(allOut, "list all for show", options.command)
      return toTask(item, new Map(allItems.map(candidate => [candidate.id, candidate])))
    },

    async update(ref: string, update: TaskUpdate): Promise<void> {
      if (update.parentRef === ref) throw new Error("A task cannot be its own parent")
      if (update.blockedBy?.includes(ref)) throw new Error("A task cannot block itself")

      const args = ["edit", ref]

      if (update.title !== undefined) {
        args.push(optionWithValue("--set-title", update.title.trim()))
      }

      if (update.description !== undefined) {
        args.push(optionWithValue("--set-description", update.description))
      }

      if (update.status !== undefined) {
        args.push(optionWithValue("--set-status", toBackendStatus(update.status, options.id)))
      }

      if (update.priority !== undefined) {
        args.push(optionWithValue("--set-priority", toBackendPriority(update.priority, options.id)))
      }

      const metadataPatch = buildPiTasksMetadata({
        taskType: update.taskType,
        dueAt: update.dueAt,
        parentRef: update.parentRef,
      })

      if (metadataPatch) {
        args.push(optionWithValue("--merge-metadata", JSON.stringify(metadataPatch)))
      }

      if (update.blockedBy !== undefined) {
        args.push(optionWithValue("--set-blocked-by", update.blockedBy.join(",")))
      }

      if (args.length === 2) return
      await execCommand(args)
    },

    async create(input: CreateTaskInput): Promise<Task> {
      const title = input.title.trim()
      const description = input.description ?? ""
      const selectedPriority = input.priority ?? PRIORITIES[Math.floor(PRIORITIES.length / 2)]
      const metadata = buildPiTasksMetadata({
        taskType: input.taskType || TASK_TYPES[0],
        dueAt: input.dueAt,
        parentRef: input.parentRef,
      })
      const sourceText = description.trim().length > 0 ? description : title

      const args = [
        "add",
        optionWithValue("--title", title),
        optionWithValue("--description", description),
        optionWithValue("--priority", toBackendPriority(selectedPriority, options.id)),
        optionWithValue("--text", sourceText),
        "--json",
      ]

      if (metadata) {
        args.push(optionWithValue("--metadata", JSON.stringify(metadata)))
      }

      if (input.blockedBy?.length) {
        args.push(optionWithValue("--blocked-by", input.blockedBy.join(",")))
      }

      const out = await execCommand(args)
      const created = parseJsonObject<SqCompatibleItem>(out, "create", options.command)

      if (input.status && input.status !== "open") {
        await execCommand(["edit", created.id, optionWithValue("--set-status", toBackendStatus(input.status, options.id))])
        return toTask(await showRaw(created.id))
      }

      return toTask(created)
    },
  }
}

export function createSqCompatibleAdapterInitializer(options: SqCompatibleAdapterOptions): TaskAdapterInitializer {
  return {
    id: options.id,
    isApplicable: options.isApplicable,
    initialize: (pi) => initialize(pi, options),
  }
}
