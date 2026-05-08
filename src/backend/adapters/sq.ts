import { spawnSync } from "node:child_process"
import type { TaskSessionContextMessage } from "../api.ts"
import { createSqCompatibleAdapterInitializer } from "./shared/sq-compatible.ts"

const SESSION_CONTEXT_MESSAGE: TaskSessionContextMessage = {
  customType: "pi-tasks-backend-context-sq-v1",
  content: [
    "The pi-tasks extension is using the `sq` backend for this project.",
    "If you need direct `sq` CLI guidance, run `sq prime`.",
    "When manipulating pi-tasks metadata through `sq`, store it under",
    "`pi_tasks`, for example",
    "`--metadata '{\"pi_tasks\":{\"taskType\":\"TYPE\",\"dueAt\":\"TIMESTAMP\"}}'`,",
    "or merge the same shape with `--merge-metadata`.",
  ].join(" "),
}

function isApplicable(): boolean {
  const result = spawnSync("sq", ["--help"], { stdio: "ignore" })
  return !result.error
}

export default createSqCompatibleAdapterInitializer({
  id: "sq",
  command: "sq",
  sessionContextMessage: SESSION_CONTEXT_MESSAGE,
  isApplicable,
})
