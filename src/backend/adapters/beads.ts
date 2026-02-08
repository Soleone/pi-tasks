import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { Task } from "../../models/task.ts"
import type { CreateTaskInput, TaskAdapter, TaskAdapterInitializer, TaskUpdate } from "../api.ts"

const MAX_LIST_RESULTS = 100
const STATUS_CYCLE = ["open", "in_progress", "closed"] as const
const TASK_TYPES = ["task", "feature", "bug", "chore", "epic"] as const
const ACTIVE_TASK_LIST_ARGS = [
  "list",
  "--status", "open",
  "--status", "in_progress",
  "--limit", String(MAX_LIST_RESULTS),
  "--sort", "priority",
  "--json",
]

interface BeadsIssue {
  id: string
  title: string
  description?: string
  status: Task["status"]
  priority?: number
  issue_type?: string
  owner?: string
  created_at?: string
  updated_at?: string
  dependency_count?: number
  dependent_count?: number
  comment_count?: number
}

function toTask(beadsIssue: BeadsIssue): Task {
  const task: Task = {
    id: beadsIssue.id,
    title: beadsIssue.title,
    description: beadsIssue.description,
    status: beadsIssue.status,
    owner: beadsIssue.owner,
    priority: beadsIssue.priority,
  }

  if (beadsIssue.issue_type !== undefined) task.taskType = beadsIssue.issue_type
  if (beadsIssue.created_at !== undefined) task.createdAt = beadsIssue.created_at
  if (beadsIssue.updated_at !== undefined) task.updatedAt = beadsIssue.updated_at
  if (beadsIssue.dependency_count !== undefined) task.dependencyCount = beadsIssue.dependency_count
  if (beadsIssue.dependent_count !== undefined) task.dependentCount = beadsIssue.dependent_count
  if (beadsIssue.comment_count !== undefined) task.commentCount = beadsIssue.comment_count

  return task
}

function taskStatusSortRank(status: Task["status"]): number {
  if (status === "in_progress") return 0
  if (status === "open") return 1
  return 2
}

function byTaskPriority(a: Task, b: Task): number {
  if (a.priority === undefined && b.priority === undefined) return 0
  if (a.priority === undefined) return 1
  if (b.priority === undefined) return -1
  return a.priority - b.priority
}

function sortActiveTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((left, right) => {
    const statusOrder = taskStatusSortRank(left.status) - taskStatusSortRank(right.status)
    if (statusOrder !== 0) return statusOrder

    const priorityOrder = byTaskPriority(left, right)
    if (priorityOrder !== 0) return priorityOrder

    return left.id.localeCompare(right.id)
  })
}

function fromTaskUpdateToBeadsArgs(update: TaskUpdate): string[] {
  const args: string[] = []

  if (update.title !== undefined) {
    args.push("--title", update.title.trim())
  }

  if (update.description !== undefined) {
    args.push("--description", update.description)
  }

  if (update.status !== undefined) {
    args.push("--status", update.status)
  }

  if (update.priority !== undefined) {
    args.push("--priority", String(update.priority))
  }

  if (update.taskType !== undefined) {
    args.push("--type", update.taskType || "task")
  }

  return args
}

function parseJsonArray<T>(stdout: string, context: string): T[] {
  try {
    const parsed = JSON.parse(stdout)
    if (!Array.isArray(parsed)) throw new Error("expected JSON array")
    return parsed as T[]
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`Failed to parse bd output (${context}): ${msg}`)
  }
}

function parseJsonObject<T>(stdout: string, context: string): T {
  try {
    const parsed = JSON.parse(stdout)
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("expected JSON object")
    }
    return parsed as T
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`Failed to parse bd output (${context}): ${msg}`)
  }
}

function isApplicable(): boolean {
  return existsSync(resolve(process.cwd(), ".beads"))
}

function initialize(pi: ExtensionAPI): TaskAdapter {
  async function execBd(args: string[], timeout = 30_000): Promise<string> {
    const result = await pi.exec("bd", args, { timeout })
    if (result.code !== 0) {
      const details = (result.stderr || result.stdout || "").trim()
      throw new Error(details.length > 0 ? details : `bd ${args.join(" ")} failed (code ${result.code})`)
    }
    return result.stdout
  }

  async function update(id: string, update: TaskUpdate): Promise<void> {
    const args = fromTaskUpdateToBeadsArgs(update)
    if (args.length === 0) return

    await execBd(["update", id, ...args])
  }

  return {
    id: "beads",
    statusCycle: [...STATUS_CYCLE],
    taskTypes: [...TASK_TYPES],

    async list(): Promise<Task[]> {
      const out = await execBd(ACTIVE_TASK_LIST_ARGS)
      const beadsIssues = parseJsonArray<BeadsIssue>(out, "list active")
      return sortActiveTasks(beadsIssues.map(toTask))
    },

    async show(id: string): Promise<Task> {
      const out = await execBd(["show", id, "--json"])
      const beadsIssues = parseJsonArray<BeadsIssue>(out, `show ${id}`)
      const task = beadsIssues[0]
      if (!task) throw new Error(`Task not found: ${id}`)
      return toTask(task)
    },

    update,

    async create(input: CreateTaskInput): Promise<Task> {
      const title = input.title.trim()
      const status = input.status ?? "open"
      const createArgs = [
        "create",
        "--title", title,
        "--priority", String(input.priority ?? 2),
        "--type", input.taskType || "task",
        "--json",
      ]

      if (input.description && input.description.length > 0) {
        createArgs.splice(3, 0, "--description", input.description)
      }

      const out = await execBd(createArgs)
      const created = toTask(parseJsonObject<BeadsIssue>(out, "create"))

      if (status !== "open") {
        await update(created.id, { status })
        created.status = status
      }

      created.title = title
      created.description = input.description ?? ""

      if (input.priority !== undefined) {
        created.priority = input.priority
      }

      if (input.taskType !== undefined) {
        created.taskType = input.taskType
      }

      return created
    },
  }
}

export default {
  id: "beads",
  isApplicable,
  initialize,
} satisfies TaskAdapterInitializer
