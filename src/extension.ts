import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent"
import initializeAdapter from "./backend/resolver.ts"
import type { Task, TaskStatus } from "./models/task.ts"
import { buildTaskWorkPrompt, serializeTask } from "./lib/task-serialization.ts"
import { showTaskList } from "./ui/pages/list.ts"
import { showTaskForm } from "./ui/pages/show.ts"
import type { TaskUpdate } from "./backend/api.ts"

const CTRL_Q = "\x11"

function parsePriorityKey(data: string): number | null {
  if (data.length !== 1) return null
  const num = parseInt(data, 10)
  return !isNaN(num) && num >= 0 && num <= 4 ? num : null
}

function cycleStatus(current: TaskStatus, statusCycle: TaskStatus[]): TaskStatus {
  if (statusCycle.length === 0) return "open"
  const idx = statusCycle.indexOf(current)
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

interface EditTaskResult {
  updatedTask: Task | null
  closeList: boolean
}

function buildTaskUpdate(previous: Task, next: {
  title: string
  description: string
  status: TaskStatus
  priority: number | undefined
  taskType: string | undefined
}): TaskUpdate {
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
    priority: number | undefined
    taskType: string | undefined
  },
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

  return nextTask
}

export default function registerExtension(pi: ExtensionAPI) {
  const backend = initializeAdapter(pi)

  const nextStatus = (status: TaskStatus): TaskStatus => cycleStatus(status, backend.statusCycle)
  const nextTaskType = (current: string | undefined): string => cycleTaskType(current, backend.taskTypes)

  async function listTasks(): Promise<Task[]> {
    return backend.list()
  }

  async function showTask(id: string): Promise<Task> {
    return backend.show(id)
  }

  function needsTaskDetailsForEdit(task: Task): boolean {
    return task.description === undefined
  }

  async function getTaskForEdit(id: string, fromList?: Task): Promise<Task> {
    if (!fromList) return showTask(id)
    if (needsTaskDetailsForEdit(fromList)) return showTask(id)
    return { ...fromList }
  }

  async function updateTask(id: string, update: TaskUpdate): Promise<void> {
    await backend.update(id, update)
  }

  async function editTask(ctx: ExtensionCommandContext, id: string, fromList?: Task): Promise<EditTaskResult> {
    let task = await getTaskForEdit(id, fromList)

    const formResult = await showTaskForm(ctx, {
      mode: "edit",
      subtitle: "Edit",
      task,
      ctrlQ: CTRL_Q,
      cycleStatus: nextStatus,
      cycleTaskType: nextTaskType,
      parsePriorityKey,
      onSave: async (draft) => {
        const update = buildTaskUpdate(task, {
          title: draft.title,
          description: draft.description,
          status: draft.status,
          priority: draft.priority,
          taskType: draft.taskType,
        })

        if (!hasTaskUpdate(update)) return false

        await updateTask(id, update)
        task = applyDraftToTask(task, {
          title: draft.title,
          description: draft.description,
          status: draft.status,
          priority: draft.priority,
          taskType: draft.taskType,
        })
        return true
      },
    })

    return {
      updatedTask: task,
      closeList: formResult.action === "close_list",
    }
  }

  async function createTask(ctx: ExtensionCommandContext): Promise<Task | null> {
    let createdTask: Task | null = null

    await showTaskForm(ctx, {
      mode: "create",
      subtitle: "Create",
      task: {
        id: "new",
        title: "",
        description: "",
        status: "open",
        priority: 2,
        taskType: "task",
      },
      ctrlQ: CTRL_Q,
      cycleStatus: nextStatus,
      cycleTaskType: nextTaskType,
      parsePriorityKey,
      onSave: async (draft) => {
        const title = draft.title.trim()
        if (title.length === 0) {
          throw new Error("Title is required")
        }

        if (!createdTask) {
          createdTask = await backend.create({
            title,
            description: draft.description,
            status: draft.status,
            priority: draft.priority,
            taskType: draft.taskType,
          })
          return true
        }

        const update = buildTaskUpdate(createdTask, {
          title,
          description: draft.description,
          status: draft.status,
          priority: draft.priority,
          taskType: draft.taskType,
        })

        if (!hasTaskUpdate(update)) return false

        await updateTask(createdTask.id, update)
        createdTask = applyDraftToTask(createdTask, {
          title,
          description: draft.description,
          status: draft.status,
          priority: draft.priority,
          taskType: draft.taskType,
        })
        return true
      },
    })

    return createdTask
  }

  async function browseTasks(ctx: ExtensionCommandContext): Promise<void> {
    const pageTitle = "Tasks"
    const backendLabel = backend.id

    try {
      ctx.ui.setStatus("tasks", "Loading…")
      const tasks = await listTasks()
      ctx.ui.setStatus("tasks", undefined)

      await showTaskList(ctx, {
        title: pageTitle,
        subtitle: backendLabel,
        tasks,
        ctrlQ: CTRL_Q,
        cycleStatus: nextStatus,
        cycleTaskType: nextTaskType,
        onUpdateTask: updateTask,
        onWork: (task) => pi.sendUserMessage(buildTaskWorkPrompt(task)),
        onInsert: (task) => ctx.ui.pasteToEditor(`${serializeTask(task)} `),
        onEdit: (id, task) => editTask(ctx, id, task),
        onCreate: () => createTask(ctx),
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

  pi.registerShortcut("ctrl+q", {
    description: "Open task list",
    handler: async (ctx) => {
      if (!ctx.hasUI) return
      await browseTasks(ctx as ExtensionCommandContext)
    },
  })
}
