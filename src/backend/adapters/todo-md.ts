import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { Task, TaskStatus } from "../../models/task.ts"
import { wouldCreateParentCycle } from "../../models/task-hierarchy.ts"
import type { CreateTaskInput, TaskAdapter, TaskAdapterInitializer, TaskListScope, TaskStatusMap, TaskUpdate } from "../api.ts"

const DEFAULT_TODO_FILES = ["TODO.md", "todo.md"] as const
const TODO_FILE_ENV = "PI_TASKS_TODO_PATH"
const SECTION_ORDER = ["now", "next", "later", "archive"] as const
const OPEN_PRIORITIES = ["now", "next", "later"] as const
const DEFAULT_TODO_TITLE = "TODO"

const STATUS_MAP = {
  open: "open",
  closed: "done",
} satisfies TaskStatusMap

type TodoSection = typeof SECTION_ORDER[number]
type TodoPriority = typeof OPEN_PRIORITIES[number]

interface TodoTaskRecord {
  ref: string
  title: string
  description: string
  status: TaskStatus
  priority: TodoPriority | undefined
  parentRef?: string
}

interface ParsedTodoTask extends Omit<TodoTaskRecord, "ref" | "parentRef"> {
  parentIndex?: number
}

interface TodoDocument {
  title: string
  format: "structured" | "flat"
  tasks: TodoTaskRecord[]
}

function configuredTodoPath(): string {
  const fromEnv = process.env[TODO_FILE_ENV]?.trim()
  if (fromEnv && fromEnv.length > 0) return fromEnv

  const existingDefault = DEFAULT_TODO_FILES.find(file => existsSync(resolve(process.cwd(), file)))
  return existingDefault ?? DEFAULT_TODO_FILES[0]
}

function resolveTodoPath(): string {
  return resolve(process.cwd(), configuredTodoPath())
}

function sectionToPriority(section: TodoSection): TodoPriority | undefined {
  if (section === "archive") return undefined
  return section
}

function headingToSection(line: string): TodoSection | null {
  const match = line.match(/^##\s+(now|next|later|archive)\s*$/i)
  if (!match) return null
  return match[1]!.toLowerCase() as TodoSection
}

function parseTaskLine(line: string): { checked: boolean; title: string; inlineDescription: string; indent: number } | null {
  const match = line.match(/^(\s*)-\s*\[( |x|X)\]\s*(?:\*\*(.+?)\*\*|(.+?))(?:\s*[—-]\s*(.+))?\s*$/)
  if (!match) return null

  return {
    indent: match[1]!.replace(/\t/g, "  ").length,
    checked: match[2]!.toLowerCase() === "x",
    title: (match[3] ?? match[4] ?? "").trim(),
    inlineDescription: (match[5] ?? "").trim(),
  }
}

function parseDescriptionBullet(line: string): { indent: number; text: string } | null {
  const match = line.match(/^(\s+)-\s+(.+)$/)
  if (!match) return null
  return { indent: match[1]!.replace(/\t/g, "  ").length, text: `- ${match[2]!.trim()}` }
}

function computeTaskRef(title: string, description: string, occurrence: number): string {
  const digest = createHash("sha1")
    .update(title.trim())
    .update("\n")
    .update(description.trim())
    .digest("hex")
    .slice(0, 10)

  return `todo-${digest}-${occurrence}`
}

function createNewTaskRef(existingRefs: Set<string>): string {
  let candidate = `todo-${randomUUID().slice(0, 8)}`
  while (existingRefs.has(candidate)) {
    candidate = `todo-${randomUUID().slice(0, 8)}`
  }
  return candidate
}

function assignTaskRefs(tasks: ParsedTodoTask[]): TodoTaskRecord[] {
  const seen = new Map<string, number>()
  const refs = tasks.map((task) => {
    const key = `${task.title.trim()}\n${task.description.trim()}`
    const nextOccurrence = (seen.get(key) ?? 0) + 1
    seen.set(key, nextOccurrence)
    return computeTaskRef(task.title, task.description, nextOccurrence)
  })

  return tasks.map((task, index) => {
    const { parentIndex, ...record } = task
    return {
      ...record,
      ref: refs[index]!,
      parentRef: parentIndex === undefined ? undefined : refs[parentIndex],
    }
  })
}

function extractTitle(lines: string[]): string {
  const heading = lines.find(line => /^#\s+/.test(line.trim()))
  if (!heading) return DEFAULT_TODO_TITLE
  return heading.replace(/^#\s+/, "").trim() || DEFAULT_TODO_TITLE
}

function parseChecklistTasks(
  lines: string[],
  resolvePriority: (section: TodoSection | null) => TodoPriority | undefined,
): ParsedTodoTask[] {
  const parsedTasks: ParsedTodoTask[] = []
  const ancestors: Array<{ index: number; indent: number }> = []
  let section: TodoSection | null = null
  let activeIndex: number | undefined
  let activeIndent = -1

  for (const line of lines) {
    const nextSection = headingToSection(line)
    if (nextSection) {
      section = nextSection
      activeIndex = undefined
      ancestors.length = 0
      continue
    }

    const taskLine = parseTaskLine(line)
    if (taskLine) {
      while (ancestors.length > 0 && ancestors[ancestors.length - 1]!.indent >= taskLine.indent) ancestors.pop()
      const parentIndex = ancestors[ancestors.length - 1]?.index
      const index = parsedTasks.length
      parsedTasks.push({
        title: taskLine.title,
        description: taskLine.inlineDescription,
        status: taskLine.checked ? "closed" : "open",
        priority: taskLine.checked ? undefined : resolvePriority(section),
        parentIndex,
      })
      ancestors.push({ index, indent: taskLine.indent })
      activeIndex = index
      activeIndent = taskLine.indent
      continue
    }

    const bullet = parseDescriptionBullet(line)
    if (bullet && activeIndex !== undefined && bullet.indent > activeIndent) {
      const task = parsedTasks[activeIndex]!
      task.description = task.description
        ? `${task.description}\n${bullet.text}`
        : bullet.text
      continue
    }

    if (line.trim().length > 0) activeIndex = undefined
  }

  return parsedTasks
}

export function parseTodoDocument(content: string): TodoDocument {
  const lines = content.split(/\r?\n/)
  const title = extractTitle(lines)
  const hasStructuredSections = lines.some(line => headingToSection(line) !== null)

  if (hasStructuredSections) {
    const tasks = parseChecklistTasks(lines, section => sectionToPriority(section ?? "now") ?? "now")
    return {
      title,
      format: "structured",
      tasks: assignTaskRefs(tasks),
    }
  }

  const tasks = parseChecklistTasks(lines, () => "now")
  return {
    title,
    format: "flat",
    tasks: assignTaskRefs(tasks),
  }
}

function asBulletLines(description: string): string[] {
  const normalized = description
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)

  if (normalized.length === 0) return []

  return normalized.map(line => line.startsWith("- ") ? line : `- ${line}`)
}

function taskToMarkdownLine(task: TodoTaskRecord, indent = 0): string[] {
  const padding = " ".repeat(indent)
  const checked = task.status === "closed" ? "x" : " "
  const title = task.title.trim()
  const description = task.description.trim()

  if (description.length === 0) {
    return [`${padding}- [${checked}] **${title}**`]
  }

  const descriptionLines = description.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (descriptionLines.length === 1 && !descriptionLines[0]!.startsWith("- ")) {
    return [`${padding}- [${checked}] **${title}** — ${descriptionLines[0]}`]
  }

  const lines = [`${padding}- [${checked}] **${title}**`]
  for (const bullet of asBulletLines(description)) {
    lines.push(`${padding}  ${bullet}`)
  }
  return lines
}

function renderTaskForest(tasks: TodoTaskRecord[]): string[] {
  const byParent = new Map<string, TodoTaskRecord[]>()
  const refs = new Set(tasks.map(task => task.ref))
  const roots: TodoTaskRecord[] = []
  for (const task of tasks) {
    if (!task.parentRef || !refs.has(task.parentRef) || task.parentRef === task.ref) {
      roots.push(task)
      continue
    }
    const children = byParent.get(task.parentRef) ?? []
    children.push(task)
    byParent.set(task.parentRef, children)
  }

  const lines: string[] = []
  const visited = new Set<string>()
  const visit = (task: TodoTaskRecord, depth: number) => {
    if (visited.has(task.ref)) return
    visited.add(task.ref)
    lines.push(...taskToMarkdownLine(task, depth * 2))
    for (const child of byParent.get(task.ref) ?? []) visit(child, depth + 1)
  }
  for (const root of roots) visit(root, 0)
  for (const task of tasks) if (!visited.has(task.ref)) visit(task, 0)
  return lines
}

function renderStructuredDocument(document: TodoDocument): string {
  const sectionTasks: Record<TodoSection, TodoTaskRecord[]> = {
    now: [],
    next: [],
    later: [],
    archive: [],
  }

  const byRef = new Map(document.tasks.map(task => [task.ref, task]))
  const rootFor = (task: TodoTaskRecord): TodoTaskRecord => {
    const seen = new Set<string>()
    let current = task
    while (current.parentRef && byRef.has(current.parentRef) && !seen.has(current.parentRef)) {
      seen.add(current.ref)
      current = byRef.get(current.parentRef)!
    }
    return current
  }

  for (const task of document.tasks) {
    const root = rootFor(task)
    if (root.status === "closed") {
      sectionTasks.archive.push(task)
      continue
    }
    sectionTasks[root.priority ?? "now"].push(task)
  }

  const lines: string[] = [`# ${document.title}`, ""]

  const sectionTitleById: Record<TodoSection, string> = {
    now: "Now",
    next: "Next",
    later: "Later",
    archive: "Archive",
  }

  for (const section of SECTION_ORDER) {
    lines.push(`## ${sectionTitleById[section]}`)
    lines.push("")

    lines.push(...renderTaskForest(sectionTasks[section]))

    lines.push("")
  }

  return `${lines.join("\n").trimEnd()}\n`
}

function renderFlatDocument(document: TodoDocument): string {
  const lines: string[] = [`# ${document.title}`, ""]

  const rootByRef = new Map(document.tasks.map(task => [task.ref, task]))
  const rootFor = (task: TodoTaskRecord): TodoTaskRecord => {
    const seen = new Set<string>()
    let current = task
    while (current.parentRef && rootByRef.has(current.parentRef) && !seen.has(current.parentRef)) {
      seen.add(current.ref)
      current = rootByRef.get(current.parentRef)!
    }
    return current
  }
  const openTasks = document.tasks.filter(task => rootFor(task).status !== "closed")
  lines.push(...renderTaskForest(openTasks))

  const archivedTasks = document.tasks.filter(task => rootFor(task).status === "closed")
  if (archivedTasks.length > 0) {
    lines.push("", "## Archive", "")
    lines.push(...renderTaskForest(archivedTasks))
  }

  lines.push("")
  return `${lines.join("\n").trimEnd()}\n`
}

export function renderTodoDocument(document: TodoDocument): string {
  const shouldUseStructured = document.format === "structured" || document.tasks.some(task => (
    task.status === "open" && task.priority !== undefined && task.priority !== "now"
  ))

  return shouldUseStructured
    ? renderStructuredDocument(document)
    : renderFlatDocument(document)
}

function normalizePriority(priority: string | undefined): TodoPriority | undefined {
  if (!priority) return undefined
  const normalized = priority.toLowerCase()
  if (normalized === "now" || normalized === "next" || normalized === "later") return normalized
  return undefined
}

function toTask(task: TodoTaskRecord): Task {
  return {
    ref: task.ref,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    taskType: "task",
    parentRef: task.parentRef,
  }
}

function normalizeStatus(status: TaskStatus | undefined): TaskStatus {
  if (status === "closed") return "closed"
  return "open"
}

function applyTaskUpdate(task: TodoTaskRecord, update: TaskUpdate): TodoTaskRecord {
  const nextTitle = update.title !== undefined ? update.title.trim() : task.title
  const nextDescription = update.description !== undefined ? update.description : task.description
  const nextStatus = update.status !== undefined ? normalizeStatus(update.status) : task.status
  const nextPriority = update.priority !== undefined
    ? normalizePriority(update.priority) ?? task.priority
    : task.priority

  return {
    ...task,
    title: nextTitle,
    description: nextDescription,
    status: nextStatus,
    priority: nextStatus === "closed" ? undefined : (nextPriority ?? "now"),
    parentRef: update.parentRef === undefined ? task.parentRef : (update.parentRef ?? undefined),
  }
}

async function readDocument(filePath: string): Promise<TodoDocument> {
  try {
    const content = await readFile(filePath, "utf8")
    return parseTodoDocument(content)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { title: DEFAULT_TODO_TITLE, format: "structured", tasks: [] }
    }
    throw error
  }
}

async function writeDocument(filePath: string, document: TodoDocument): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, renderTodoDocument(document), "utf8")
}

function isApplicable(): boolean {
  return existsSync(resolveTodoPath())
}

function initialize(_pi: ExtensionAPI): TaskAdapter {
  const filePath = resolveTodoPath()
  let documentCache: TodoDocument | null = null

  async function getDocument(): Promise<TodoDocument> {
    if (documentCache) return documentCache
    documentCache = await readDocument(filePath)
    return documentCache
  }

  async function persistDocument(document: TodoDocument): Promise<void> {
    documentCache = document
    await writeDocument(filePath, document)
  }

  return {
    id: "todo-md",
    capabilities: { hierarchy: "markdown", dependencies: "none" },
    statusMap: STATUS_MAP,
    taskTypes: ["task"],
    priorities: [...OPEN_PRIORITIES],
    invalidateCache: () => {
      documentCache = null
    },

    async list(scope: TaskListScope = "active"): Promise<Task[]> {
      const document = await getDocument()
      return document.tasks
        .filter(task => scope === "closed" ? task.status === "closed" : task.status === "open")
        .map(toTask)
    },

    async show(ref: string): Promise<Task> {
      const document = await getDocument()
      const task = document.tasks.find(item => item.ref === ref)
      if (!task) throw new Error(`Task not found: ${ref}`)
      return toTask(task)
    },

    async update(ref: string, update: TaskUpdate): Promise<void> {
      if (update.blockedBy !== undefined) {
        throw new Error("The TODO.md backend does not support blocked-by dependencies")
      }

      const document = await getDocument()
      const index = document.tasks.findIndex(task => task.ref === ref)
      if (index === -1) throw new Error(`Task not found: ${ref}`)

      const updatedTasks = [...document.tasks]
      const currentTask = updatedTasks[index]!
      if (update.parentRef !== undefined && update.parentRef !== null) {
        if (!updatedTasks.some(task => task.ref === update.parentRef)) {
          throw new Error(`Parent task not found: ${update.parentRef}`)
        }
        const domainTasks = updatedTasks.map(toTask)
        if (wouldCreateParentCycle(domainTasks, ref, update.parentRef)) {
          throw new Error("A task cannot be its own parent or a descendant of itself")
        }
      }
      let taskUpdate = update

      if (update.priority !== undefined && currentTask.parentRef) {
        const byRef = new Map(updatedTasks.map((task, taskIndex) => [task.ref, taskIndex]))
        const seen = new Set<string>()
        let rootIndex = index
        while (true) {
          const parentRef = updatedTasks[rootIndex]!.parentRef
          if (!parentRef || seen.has(parentRef) || !byRef.has(parentRef)) break
          seen.add(parentRef)
          rootIndex = byRef.get(parentRef)!
        }
        updatedTasks[rootIndex] = applyTaskUpdate(updatedTasks[rootIndex]!, { priority: update.priority })
        const { priority: _inheritedPriority, ...remainingUpdate } = update
        taskUpdate = remainingUpdate
      }

      updatedTasks[index] = applyTaskUpdate(updatedTasks[index]!, taskUpdate)
      await persistDocument({ ...document, tasks: updatedTasks })
    },

    async create(input: CreateTaskInput): Promise<Task> {
      if (input.blockedBy !== undefined) {
        throw new Error("The TODO.md backend does not support blocked-by dependencies")
      }

      const document = await getDocument()
      if (input.parentRef && !document.tasks.some(task => task.ref === input.parentRef)) {
        throw new Error(`Parent task not found: ${input.parentRef}`)
      }

      const status = normalizeStatus(input.status)
      const existingRefs = new Set(document.tasks.map(task => task.ref))
      const createdTask: TodoTaskRecord = {
        ref: createNewTaskRef(existingRefs),
        title: input.title.trim(),
        description: input.description ?? "",
        status,
        priority: status === "closed"
          ? undefined
          : (normalizePriority(input.priority) ?? "now"),
        parentRef: input.parentRef ?? undefined,
      }

      await persistDocument({ ...document, tasks: [...document.tasks, createdTask] })
      return toTask(createdTask)
    },
  }
}

export default {
  id: "todo-md",
  isApplicable,
  initialize,
} satisfies TaskAdapterInitializer
