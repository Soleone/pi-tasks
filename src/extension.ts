import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent"
import initializeAdapter from "./backend/resolver.ts"
import type { Task, TaskStatus } from "./models/task.ts"
import { wouldCreateDependencyCycle, wouldCreateParentCycle } from "./models/task-hierarchy.ts"
import { buildTaskWorkPrompt, serializeTask } from "./lib/task-serialization.ts"
import { showTaskList } from "./ui/pages/list.ts"
import { showTaskForm } from "./ui/pages/show.ts"
import type { TaskAdapterCapabilities, TaskUpdate } from "./backend/api.ts"

const TASK_LIST_SHORTCUTS = ["ctrl+shift+r", "alt+x"]

function parsePriorityKey(
  data: string,
  priorities: string[],
  priorityHotkeys?: Record<string, string>,
): string | null {
  if (data.length !== 1) return null

  const hotkeyPriority = priorityHotkeys?.[data]
  if (hotkeyPriority && priorities.includes(hotkeyPriority)) return hotkeyPriority

  const rank = parseInt(data, 10)
  if (isNaN(rank) || rank < 1 || rank > priorities.length) return null
  return priorities[rank - 1] ?? null
}

function cycleStatus(current: TaskStatus, statusMap: Record<string, string>): TaskStatus {
  const statusCycle = Object.keys(statusMap) as TaskStatus[]
  if (statusCycle.length === 0) return "open"
  const normalizedCurrent = current === "blocked" ? "open" : current
  const idx = statusCycle.indexOf(normalizedCurrent)
  if (idx === -1) return statusCycle[0]
  return statusCycle[(idx + 1) % statusCycle.length]
}

function cycleTaskType(current: string | undefined, taskTypes: string[]): string {
  if (taskTypes.length === 0) return "task"
  const normalized = current || taskTypes[0]
  const idx = taskTypes.indexOf(normalized)
  if (idx === -1) return taskTypes[0]
  return taskTypes[(idx + 1) % taskTypes.length]
}

function defaultPriority(priorities: string[]): string | undefined {
  if (priorities.length === 0) return undefined
  return priorities[Math.floor(priorities.length / 2)]
}

function defaultTaskType(taskTypes: string[]): string | undefined {
  return taskTypes[0]
}

function hasUniqueValues(values: string[]): boolean {
  return new Set(values).size === values.length
}

function validateBackendConfiguration(backend: {
  id: string
  statusMap: Record<string, string>
  taskTypes: string[]
  priorities: string[]
  priorityHotkeys?: Record<string, string>
}): void {
  const statusKeys = Object.keys(backend.statusMap)
  if (statusKeys.length === 0) {
    throw new Error(`Invalid backend config (${backend.id}): statusMap must not be empty`)
  }

  if (!statusKeys.includes("open") || !statusKeys.includes("closed")) {
    throw new Error(`Invalid backend config (${backend.id}): statusMap must include open and closed`)
  }

  if (backend.taskTypes.length === 0) {
    throw new Error(`Invalid backend config (${backend.id}): taskTypes must not be empty`)
  }

  if (!hasUniqueValues(backend.taskTypes)) {
    throw new Error(`Invalid backend config (${backend.id}): taskTypes must be unique`)
  }

  if (backend.priorities.length < 3 || backend.priorities.length > 5) {
    throw new Error(`Invalid backend config (${backend.id}): priorities must contain 3 to 5 values`)
  }

  if (!hasUniqueValues(backend.priorities)) {
    throw new Error(`Invalid backend config (${backend.id}): priorities must be unique`)
  }

  if (backend.priorityHotkeys) {
    for (const [key, priority] of Object.entries(backend.priorityHotkeys)) {
      if (key.length !== 1) {
        throw new Error(`Invalid backend config (${backend.id}): priority hotkey keys must be a single character`)
      }

      if (!backend.priorities.includes(priority)) {
        throw new Error(`Invalid backend config (${backend.id}): priority hotkey ${key} points to unsupported priority ${priority}`)
      }
    }
  }
}

interface EditTaskResult {
  updatedTask: Task | null
  closeList: boolean
}

interface DraftRelationships {
  parentRef?: string
  blockedBy?: string[]
}

function supportedDraftRelationships(
  draft: DraftRelationships,
  capabilities: TaskAdapterCapabilities,
): DraftRelationships {
  const relationships: DraftRelationships = {}
  if (capabilities.hierarchy !== "none") relationships.parentRef = draft.parentRef
  if (capabilities.dependencies !== "none") relationships.blockedBy = draft.blockedBy
  return relationships
}

function buildTaskUpdate(previous: Task, next: {
  title: string
  description: string
  status: TaskStatus
  priority: string | undefined
  taskType: string | undefined
  parentRef?: string
  blockedBy?: string[]
}, allTasks: Task[] = []): TaskUpdate {
  const update: TaskUpdate = {}

  const nextTitle = next.title.trim()
  if (nextTitle !== previous.title.trim()) {
    update.title = nextTitle
  }

  if (next.description !== (previous.description ?? "")) {
    update.description = next.description
  }

  if (next.status !== previous.status) {
    update.status = next.status
  }

  if (next.priority !== previous.priority && next.priority !== undefined) {
    update.priority = next.priority
  }

  if (next.taskType !== previous.taskType) {
    update.taskType = next.taskType || "task"
  }

  if (Object.prototype.hasOwnProperty.call(next, "parentRef") && next.parentRef !== previous.parentRef) {
    if (wouldCreateParentCycle(allTasks, previous.ref, next.parentRef)) {
      throw new Error("A task cannot be its own parent or a descendant of itself")
    }
    update.parentRef = next.parentRef ?? null
  }

  if (Object.prototype.hasOwnProperty.call(next, "blockedBy") && next.blockedBy !== undefined) {
    const previousBlockers = (previous.blockers ?? []).map(blocker => blocker.ref).sort()
    const nextBlockers = [...new Set(next.blockedBy)].sort()
    if (nextBlockers.includes(previous.ref)) throw new Error("A task cannot block itself")
    if (wouldCreateDependencyCycle(allTasks, previous.ref, nextBlockers)) {
      throw new Error("Blocked-by relationships cannot contain a cycle")
    }
    if (JSON.stringify(previousBlockers) !== JSON.stringify(nextBlockers)) {
      update.blockedBy = nextBlockers
    }
  }

  return update
}

function hasTaskUpdate(update: TaskUpdate): boolean {
  return Object.keys(update).length > 0
}

function applyDraftToTask(
  task: Task,
  draft: {
    title: string
    description: string
    status: TaskStatus
    priority: string | undefined
    taskType: string | undefined
    parentRef?: string
    blockedBy?: string[]
  },
  candidates: Task[] = [],
): Task {
  const nextTask: Task = {
    ...task,
    title: draft.title.trim(),
    description: draft.description,
    status: draft.status,
  }

  if (draft.priority !== undefined) {
    nextTask.priority = draft.priority
  } else {
    delete nextTask.priority
  }

  if (draft.taskType !== undefined) {
    nextTask.taskType = draft.taskType
  } else {
    delete nextTask.taskType
  }

  if (Object.prototype.hasOwnProperty.call(draft, "parentRef")) {
    if (draft.parentRef !== undefined) nextTask.parentRef = draft.parentRef
    else delete nextTask.parentRef
  }

  if (Object.prototype.hasOwnProperty.call(draft, "blockedBy") && draft.blockedBy !== undefined) {
    const byRef = new Map(candidates.map(candidate => [candidate.ref, candidate]))
    const existingByRef = new Map((task.blockers ?? []).map(blocker => [blocker.ref, blocker]))
    nextTask.blockers = draft.blockedBy.map(ref => {
      const candidate = byRef.get(ref)
      const existing = existingByRef.get(ref)
      return {
        ref,
        title: candidate?.title ?? existing?.title,
        status: candidate?.status ?? existing?.status,
      }
    })
    nextTask.dependencyCount = nextTask.blockers.length
  }

  return nextTask
}

function branchHasCustomMessage(entries: unknown[], customType: string): boolean {
  return entries.some((entry) => {
    if (!entry || typeof entry !== "object") return false

    const candidate = entry as {
      type?: unknown
      customType?: unknown
    }

    return candidate.type === "custom_message" && candidate.customType === customType
  })
}

export default function registerExtension(pi: ExtensionAPI) {
  const backend = initializeAdapter(pi)
  validateBackendConfiguration(backend)

  const backendContextMessage = backend.sessionContextMessage

  function ensureBackendContextOnBranch(entries: unknown[]): void {
    if (!backendContextMessage) return
    if (branchHasCustomMessage(entries, backendContextMessage.customType)) return

    pi.sendMessage({
      customType: backendContextMessage.customType,
      content: backendContextMessage.content,
      display: false,
      details: { backendId: backend.id },
    })
  }

  pi.on("session_start", async (_event, ctx) => {
    ensureBackendContextOnBranch(ctx.sessionManager.getBranch())
  })

  pi.on("session_switch", async (_event, ctx) => {
    ensureBackendContextOnBranch(ctx.sessionManager.getBranch())
  })

  pi.on("session_fork", async (_event, ctx) => {
    ensureBackendContextOnBranch(ctx.sessionManager.getBranch())
  })

  const nextStatus = (status: TaskStatus): TaskStatus => cycleStatus(status, backend.statusMap)
  const nextTaskType = (current: string | undefined): string => cycleTaskType(current, backend.taskTypes)
  const nextPriorityFromKey = (data: string): string | null => parsePriorityKey(
    data,
    backend.priorities,
    backend.priorityHotkeys,
  )

  async function listTasks(): Promise<Task[]> {
    return backend.list()
  }

  async function showTask(ref: string): Promise<Task> {
    return backend.show(ref)
  }

  function needsTaskDetailsForEdit(task: Task): boolean {
    return task.description === undefined
  }

  async function getTaskForEdit(ref: string, fromList?: Task): Promise<Task> {
    if (!fromList) return showTask(ref)
    if (needsTaskDetailsForEdit(fromList)) return showTask(ref)
    return { ...fromList }
  }

  async function updateTask(ref: string, update: TaskUpdate): Promise<void> {
    await backend.update(ref, update)
  }

  async function editTask(
    ctx: ExtensionCommandContext,
    ref: string,
    fromList?: Task,
    allTasks: Task[] = [],
  ): Promise<EditTaskResult> {
    let task = await getTaskForEdit(ref, fromList)

    const formResult = await showTaskForm(ctx, {
      mode: "edit",
      subtitle: "Edit",
      task,
      relationshipCapabilities: backend.capabilities,
      relationshipCandidates: allTasks,
      closeKeys: TASK_LIST_SHORTCUTS,
      cycleStatus: nextStatus,
      cycleTaskType: nextTaskType,
      parsePriorityKey: nextPriorityFromKey,
      priorities: backend.priorities,
      priorityHotkeys: backend.priorityHotkeys,
      onSave: async (draft) => {
        const relationships = supportedDraftRelationships(draft, backend.capabilities)
        const nextDraft = {
          title: draft.title,
          description: draft.description,
          status: draft.status,
          priority: draft.priority,
          taskType: draft.taskType,
          ...relationships,
        }
        const update = buildTaskUpdate(task, nextDraft, allTasks)

        if (!hasTaskUpdate(update)) return false

        await updateTask(ref, update)
        task = applyDraftToTask(task, nextDraft, allTasks)
        return true
      },
    })

    return {
      updatedTask: task,
      closeList: formResult.action === "close_list",
    }
  }

  async function createTask(ctx: ExtensionCommandContext, parentRef?: string, allTasks: Task[] = []): Promise<Task | null> {
    let createdTask: Task | null = null

    await showTaskForm(ctx, {
      mode: "create",
      subtitle: "Create",
      task: {
        ref: "new",
        title: "",
        description: "",
        status: "open",
        priority: defaultPriority(backend.priorities),
        taskType: defaultTaskType(backend.taskTypes),
        parentRef,
      },
      relationshipCapabilities: backend.capabilities,
      relationshipCandidates: allTasks,
      closeKeys: TASK_LIST_SHORTCUTS,
      cycleStatus: nextStatus,
      cycleTaskType: nextTaskType,
      parsePriorityKey: nextPriorityFromKey,
      priorities: backend.priorities,
      priorityHotkeys: backend.priorityHotkeys,
      onSave: async (draft) => {
        const title = draft.title.trim()
        if (title.length === 0) {
          throw new Error("Title is required")
        }

        const relationships = supportedDraftRelationships(draft, backend.capabilities)
        const nextDraft = {
          title,
          description: draft.description,
          status: draft.status,
          priority: draft.priority,
          taskType: draft.taskType,
          ...relationships,
        }

        if (!createdTask) {
          createdTask = await backend.create(nextDraft)
          createdTask = applyDraftToTask(createdTask, nextDraft, allTasks)
          return true
        }

        const update = buildTaskUpdate(createdTask, nextDraft, [...allTasks, createdTask])

        if (!hasTaskUpdate(update)) return false

        await updateTask(createdTask.ref, update)
        createdTask = applyDraftToTask(createdTask, nextDraft, allTasks)
        return true
      },
    })

    return createdTask
  }

  async function browseTasks(ctx: ExtensionCommandContext): Promise<void> {
    const pageTitle = "Tasks"
    const backendLabel = backend.id

    try {
      backend.invalidateCache?.()
      ctx.ui.setStatus("tasks", "Loading…")
      const tasks = await listTasks()
      ctx.ui.setStatus("tasks", undefined)

      await showTaskList(ctx, {
        title: pageTitle,
        subtitle: backendLabel,
        tasks,
        closeKeys: TASK_LIST_SHORTCUTS,
        priorities: backend.priorities,
        priorityHotkeys: backend.priorityHotkeys,
        allowHierarchy: backend.capabilities.hierarchy !== "none",
        cycleStatus: nextStatus,
        cycleTaskType: nextTaskType,
        onUpdateTask: updateTask,
        onWork: (task) => pi.sendUserMessage(buildTaskWorkPrompt(task)),
        onInsert: (task) => ctx.ui.pasteToEditor(`${serializeTask(task)} `),
        onEdit: (ref, task) => editTask(ctx, ref, task, tasks),
        onCreate: parentRef => createTask(ctx, parentRef, tasks),
      })
    } catch (e) {
      ctx.ui.setStatus("tasks", undefined)
      ctx.ui.notify(e instanceof Error ? e.message : String(e), "error")
    }
  }

  pi.registerCommand("tasks", {
    description: "Open task list",
    handler: async (_rawArgs, ctx) => {
      if (!ctx.hasUI) return
      await browseTasks(ctx)
    },
  })

  const openTaskListShortcut = async (ctx: ExtensionCommandContext): Promise<void> => {
    if (!ctx.hasUI) return
    await browseTasks(ctx)
  }

  for (const shortcut of TASK_LIST_SHORTCUTS) {
    pi.registerShortcut(shortcut, {
      description: "Open task list",
      handler: openTaskListShortcut,
    })
  }
}
