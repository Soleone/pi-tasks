import type { Task } from "./task.ts"

export interface ProjectedTask {
  task: Task
  depth: number
  hasChildren: boolean
  expanded: boolean
}

export interface TaskProjectionOptions {
  grouped: boolean
  expandedRefs?: ReadonlySet<string>
  filterTerm?: string
}

function searchableStatus(status: Task["status"]): string {
  return status.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()
}

function matchesTask(task: Task, term: string): boolean {
  const normalized = term.toLowerCase()
  return [task.title, task.description, task.id, task.ref, searchableStatus(task.status), task.taskType]
    .some(value => value?.toLowerCase().includes(normalized))
}

function hasValidParent(task: Task, byRef: ReadonlyMap<string, Task>): boolean {
  if (!task.parentRef || task.parentRef === task.ref || !byRef.has(task.parentRef)) return false

  const seen = new Set([task.ref])
  let currentRef: string | undefined = task.parentRef
  while (currentRef) {
    if (seen.has(currentRef)) return false
    seen.add(currentRef)
    currentRef = byRef.get(currentRef)?.parentRef
  }
  return true
}

export function projectTaskList(tasks: Task[], options: TaskProjectionOptions): ProjectedTask[] {
  const expandedRefs = options.expandedRefs ?? new Set<string>()
  if (!options.grouped) {
    const visible = options.filterTerm
      ? tasks.filter(task => matchesTask(task, options.filterTerm!))
      : tasks
    return visible.map(task => ({ task, depth: 0, hasChildren: false, expanded: false }))
  }

  const byRef = new Map(tasks.map(task => [task.ref, task]))
  const children = new Map<string, Task[]>()
  const roots: Task[] = []

  for (const task of tasks) {
    if (!hasValidParent(task, byRef)) {
      roots.push(task)
      continue
    }
    const siblings = children.get(task.parentRef!) ?? []
    siblings.push(task)
    children.set(task.parentRef!, siblings)
  }

  const searchMatches = new Set<string>()
  if (options.filterTerm) {
    for (const task of tasks) {
      if (!matchesTask(task, options.filterTerm)) continue
      searchMatches.add(task.ref)
      let parentRef = hasValidParent(task, byRef) ? task.parentRef : undefined
      while (parentRef && !searchMatches.has(parentRef)) {
        searchMatches.add(parentRef)
        parentRef = byRef.get(parentRef)?.parentRef
      }
    }
  }

  const result: ProjectedTask[] = []
  const visit = (task: Task, depth: number) => {
    if (options.filterTerm && !searchMatches.has(task.ref)) return
    const descendants = children.get(task.ref) ?? []
    const expanded = options.filterTerm ? descendants.some(child => searchMatches.has(child.ref)) : expandedRefs.has(task.ref)
    result.push({ task, depth, hasChildren: descendants.length > 0, expanded })
    if (!expanded) return
    for (const child of descendants) visit(child, depth + 1)
  }

  for (const root of roots) visit(root, 0)
  return result
}

export function wouldCreateParentCycle(tasks: Task[], taskRef: string, parentRef: string | undefined): boolean {
  if (!parentRef) return false
  if (parentRef === taskRef) return true
  const byRef = new Map(tasks.map(task => [task.ref, task]))
  const seen = new Set<string>([taskRef])
  let currentRef: string | undefined = parentRef
  while (currentRef) {
    if (seen.has(currentRef)) return true
    seen.add(currentRef)
    currentRef = byRef.get(currentRef)?.parentRef
  }
  return false
}
