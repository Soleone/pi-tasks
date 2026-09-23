import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import type { TaskAdapter, TaskAdapterDetection, TaskAdapterInitializer } from "./api.ts"
import beadsAdapter from "./adapters/beads.ts"
import sqAdapter from "./adapters/sq.ts"
import tasksAdapter from "./adapters/tasks/index.ts"
import todoMdAdapter from "./adapters/todo-md.ts"
import tqAdapter from "./adapters/tq.ts"

// The array order breaks ties within each detection tier.
const ADAPTER_INITIALIZERS: TaskAdapterInitializer[] = [
  tasksAdapter,
  tqAdapter,
  beadsAdapter,
  sqAdapter,
  todoMdAdapter,
]

const DETECTION_PRECEDENCE: Exclude<TaskAdapterDetection, undefined>[] = [
  "project",
  "default",
  "fallback",
  "final",
]

export function resolveAdapterInitializer(
  adapters: readonly TaskAdapterInitializer[],
  configuredAdapterId = process.env.PI_TASKS_BACKEND?.trim(),
): TaskAdapterInitializer {
  if (configuredAdapterId) {
    const configured = adapters.find(adapter => adapter.id === configuredAdapterId)
    if (!configured) {
      throw new Error(`Unsupported tasks backend: ${configuredAdapterId}`)
    }
    return configured
  }

  const detections = adapters.map(adapter => ({ adapter, detection: adapter.detect() }))
  for (const preference of DETECTION_PRECEDENCE) {
    const selected = detections.find(candidate => candidate.detection === preference)
    if (selected) return selected.adapter
  }

  throw new Error("No task backend is available")
}

export default function initializeAdapter(pi: ExtensionAPI): TaskAdapter {
  return resolveAdapterInitializer(ADAPTER_INITIALIZERS).initialize(pi)
}
