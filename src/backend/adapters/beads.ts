import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { Task, TaskStatus } from "../../models/task.ts"
import { createCliRunner, parseJsonArray, parseJsonObject } from "./shared/cli.ts"
import { PRIORITIES, PRIORITY_HOTKEYS, TASK_TYPES } from "./shared/constants.ts"
import { sortActiveTasks, sortClosedTasks } from "./shared/sorting.ts"
import type {
  CreateTaskInput,
  TaskAdapter,
  TaskAdapterInitializer,
  TaskListScope,
  TaskSessionContextMessage,
  TaskStatusMap,
  TaskUpdate,
} from "../api.ts"

const MAX_LIST_RESULTS = 100
const STATUS_MAP = {
  open: "open",
  inProgress: "in_progress",
  closed: "closed",
} satisfies TaskStatusMap
const SESSION_CONTEXT_MESSAGE: TaskSessionContextMessage = {
  customType: "pi-tasks-backend-context-beads-v1",
  content: [
    "The pi-tasks extension is using the `beads` backend for this project.",
    "If you need a quick overview of the beads workflow, run `bd quickstart` or `bd onboard`.",
    "For most beads commands, agents should prefer the `--json` flag so output is structured and machine-readable.",
    "For more advanced command help, run `bd -h`.",
  ].join(" "),
}

const OPEN_TASK_LIST_ARGS = [
  "list",
  "--status", STATUS_MAP.open,
  "--limit", String(MAX_LIST_RESULTS),
  "--sort", "priority",
  "--json",
]

const IN_PROGRESS_TASK_LIST_ARGS = [
  "list",
  "--status", STATUS_MAP.inProgress,
  "--limit", String(MAX_LIST_RESULTS),
  "--sort", "priority",
  "--json",
]

const CLOSED_TASK_LIST_ARGS = [
  "list",
  "--status", STATUS_MAP.closed,
  "--limit", String(MAX_LIST_RESULTS),
  "--sort", "priority",
  "--json",
]

interface BeadsDependency {
  issue_id?: string
  depends_on_id?: string
  type?: string
}

interface BeadsIssue {
  id: string
  title: string
  description?: string
  status: string
  priority?: number
  issue_type?: string
  owner?: string
  created_at?: string
  due_at?: string
  due?: string
  updated_at?: string
  closed_at?: string
  dependency_count?: number
  dependent_count?: number
  comment_count?: number
  dependencies?: BeadsDependency[]
}

function toPriorityLabel(value: number | undefined): string | undefined {
  if (value === undefined) return undefined
  const label = `p${value}`
  return PRIORITIES.includes(label) ? label : undefined
}

function toPriorityValue(label: string | undefined): number | undefined {
  if (!label) return undefined
  const match = label.toLowerCase().match(/^p(\d)$/)
  if (!match) return undefined
  return Number(match[1])
}

function toRequiredPriorityValue(label: string): number {
  const value = toPriorityValue(label)
  if (value === undefined) {
    throw new Error(`Unsupported priority for beads backend: ${label}`)
  }
  return value
}

function fromBackendStatus(status: string): TaskStatus {
  for (const [internalStatus, backendStatus] of Object.entries(STATUS_MAP)) {
    if (backendStatus === status) return internalStatus as TaskStatus
  }
  return "open"
}

function toBackendStatus(status: TaskStatus): string {
  const mapped = STATUS_MAP[status]
  if (!mapped) throw new Error(`Unsupported status for beads backend: ${status}`)
  return mapped
}

function toTask(beadsIssue: BeadsIssue, issuesById: ReadonlyMap<string, BeadsIssue> = new Map()): Task {
  const blockers = (beadsIssue.dependencies ?? [])
    .filter(dependency => dependency.type === "blocks" && dependency.depends_on_id)
    .map(dependency => {
      const blocker = issuesById.get(dependency.depends_on_id!)
      return {
        ref: dependency.depends_on_id!,
        title: blocker?.title,
        status: blocker ? fromBackendStatus(blocker.status) : undefined,
      }
    })
  const task: Task = {
    ref: beadsIssue.id,
    id: beadsIssue.id,
    title: beadsIssue.title,
    description: beadsIssue.description ?? "",
    status: fromBackendStatus(beadsIssue.status),
    owner: beadsIssue.owner,
    priority: toPriorityLabel(beadsIssue.priority),
    blockers,
    dependencyCount: blockers.length || beadsIssue.dependency_count,
  }

  if (beadsIssue.issue_type !== undefined) task.taskType = beadsIssue.issue_type
  if (beadsIssue.created_at !== undefined) task.createdAt = beadsIssue.created_at
  if (beadsIssue.due_at !== undefined) task.dueAt = beadsIssue.due_at
  if (beadsIssue.due !== undefined) task.dueAt = beadsIssue.due
  if (beadsIssue.updated_at !== undefined) task.updatedAt = beadsIssue.updated_at
  if (beadsIssue.closed_at !== undefined) task.closedAt = beadsIssue.closed_at
  if (beadsIssue.dependency_count !== undefined) task.dependencyCount = beadsIssue.dependency_count
  if (beadsIssue.dependent_count !== undefined) task.dependentCount = beadsIssue.dependent_count
  if (beadsIssue.comment_count !== undefined) task.commentCount = beadsIssue.comment_count

  return task
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
    args.push("--status", toBackendStatus(update.status))
  }

  if (update.priority !== undefined) {
    args.push("--priority", String(toRequiredPriorityValue(update.priority)))
  }

  if (update.taskType !== undefined) {
    args.push("--type", update.taskType || TASK_TYPES[0])
  }

  if (update.dueAt !== undefined) {
    args.push("--due", update.dueAt)
  }

  return args
}

function isApplicable(): boolean {
  if (!existsSync(resolve(process.cwd(), ".beads"))) return false

  const result = spawnSync("bd", ["--version"], {
    stdio: "ignore",
  })

  return !result.error
}

function initialize(pi: ExtensionAPI): TaskAdapter {
  const execBd = createCliRunner(pi, "bd")

  async function update(ref: string, update: TaskUpdate): Promise<void> {
    if (update.parentRef !== undefined || update.blockedBy !== undefined) {
      throw new Error("The beads backend does not expose hierarchy or blocked-by editing yet")
    }

    const args = fromTaskUpdateToBeadsArgs(update)
    if (args.length === 0) return

    await execBd(["update", ref, ...args])
  }

  return {
    id: "beads",
    capabilities: { hierarchy: "none", dependencies: "none" },
    statusMap: STATUS_MAP,
    taskTypes: TASK_TYPES,
    priorities: PRIORITIES,
    priorityHotkeys: PRIORITY_HOTKEYS,
    sessionContextMessage: SESSION_CONTEXT_MESSAGE,

    async list(scope: TaskListScope = "active"): Promise<Task[]> {
      const scopeArgs = scope === "closed" ? [CLOSED_TASK_LIST_ARGS] : [OPEN_TASK_LIST_ARGS, IN_PROGRESS_TASK_LIST_ARGS]
      const results = await Promise.all(scopeArgs.map(args => execBd(args)))

      const issues = scope === "closed"
        ? parseJsonArray<BeadsIssue>(results[0]!, "list closed", "bd")
        : [
            ...parseJsonArray<BeadsIssue>(results[1]!, "list in_progress", "bd"),
            ...parseJsonArray<BeadsIssue>(results[0]!, "list open", "bd"),
          ]

      const issuesById = new Map(issues.map(issue => [issue.id, issue]))
      const dedupedById = new Map<string, Task>()
      for (const issue of issues) {
        dedupedById.set(issue.id, toTask(issue, issuesById))
      }

      const deduped = [...dedupedById.values()]
      return scope === "closed" ? sortClosedTasks(deduped) : sortActiveTasks(deduped).slice(0, MAX_LIST_RESULTS)
    },

    async show(ref: string): Promise<Task> {
      const out = await execBd(["show", ref, "--json"])
      const beadsIssues = parseJsonArray<BeadsIssue>(out, `show ${ref}`, "bd")
      const task = beadsIssues[0]
      if (!task) throw new Error(`Task not found: ${ref}`)
      return toTask(task)
    },

    update,

    async create(input: CreateTaskInput): Promise<Task> {
      if (input.parentRef !== undefined || input.blockedBy !== undefined) {
        throw new Error("The beads backend does not expose hierarchy or blocked-by editing yet")
      }

      const title = input.title.trim()
      const status = input.status ?? "open"
      const selectedPriority = input.priority ?? PRIORITIES[Math.floor(PRIORITIES.length / 2)]
      const createArgs = [
        "create",
        "--title", title,
        "--priority", String(toRequiredPriorityValue(selectedPriority)),
        "--type", input.taskType || TASK_TYPES[0],
        "--json",
      ]

      if (input.description && input.description.length > 0) {
        createArgs.splice(3, 0, "--description", input.description)
      }

      if (input.dueAt && input.dueAt.length > 0) {
        createArgs.splice(3, 0, "--due", input.dueAt)
      }

      const out = await execBd(createArgs)
      const created = toTask(parseJsonObject<BeadsIssue>(out, "create", "bd"))

      if (status !== "open") {
        await update(created.ref, { status })
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

      if (input.dueAt !== undefined) {
        created.dueAt = input.dueAt
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
