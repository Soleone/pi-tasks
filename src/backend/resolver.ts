import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import type { TaskAdapter, TaskAdapterInitializer } from "./api.ts"
import beadsAdapter from "./adapters/beads.ts"
import sqAdapter from "./adapters/sq.ts"
import tasksAdapter from "./adapters/tasks/index.ts"
import todoMdAdapter from "./adapters/todo-md.ts"
import tqAdapter from "./adapters/tq.ts"

// Detection order matters: the first applicable adapter wins. `tasks` leads
// because a category that matches the project directory is an explicit choice,
// then the file-based `tq` marker, then beads and sq.
const ADAPTER_INITIALIZERS: TaskAdapterInitializer[] = [
  tasksAdapter,
  tqAdapter,
  beadsAdapter,
  sqAdapter,
  todoMdAdapter,
]

function findAdapter(id: string): TaskAdapterInitializer | undefined {
  return ADAPTER_INITIALIZERS.find(adapter => adapter.id === id)
}

function lookup(): TaskAdapterInitializer {
  const configuredAdapterId = process.env.PI_TASKS_BACKEND?.trim()
  if (configuredAdapterId) {
    const configured = findAdapter(configuredAdapterId)
    if (!configured) {
      throw new Error(`Unsupported tasks backend: ${configuredAdapterId}`)
    }
    return configured
  }

  const detected = ADAPTER_INITIALIZERS.find(adapter => adapter.isApplicable())
  if (detected) return detected

  const fallback = findAdapter("todo-md")
  if (fallback) return fallback

  return ADAPTER_INITIALIZERS[0]!
}

export default function initializeAdapter(pi: ExtensionAPI): TaskAdapter {
  return lookup().initialize(pi)
}
