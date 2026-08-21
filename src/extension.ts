import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent"
import initializeAdapter from "./backend/resolver.ts"
import type { Task, TaskStatus } from "./models/task.ts"
import { buildTaskWorkPrompt, serializeTask } from "./lib/task-serialization.ts"
import { parsePriorityKey } from "./lib/priority-keys.ts"
import {
  applyDraftToTask,
  buildTaskUpdate,
  cycleStatus,
  cycleTaskType,
  defaultPriority,
  defaultTaskType,
  hasTaskUpdate,
  supportedDraftRelationships,
  validateBackendConfiguration,
} from "./lib/task-editing.ts"
import { showTaskList } from "./ui/pages/list.ts"
import { showTaskForm } from "./ui/pages/show.ts"
import type { TaskListScope, TaskUpdate } from "./backend/api.ts"

const TASK_LIST_SHORTCUTS = ["ctrl+shift+r", "alt+x"]

interface EditTaskResult {
  updatedTask: Task | null
  closeList: boolean
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

  async function listTasks(scope: TaskListScope = "active"): Promise<Task[]> {
    return backend.list(scope)
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
        onReload: async (scope) => {
          backend.invalidateCache?.()
          return backend.list(scope)
        },
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
