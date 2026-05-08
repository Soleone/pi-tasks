import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import type { TaskSessionContextMessage } from "../api.ts"
import { createSqCompatibleAdapterInitializer } from "./shared/sq-compatible.ts"

const SESSION_CONTEXT_MESSAGE: TaskSessionContextMessage = {
  customType: "pi-tasks-backend-context-tq-v1",
  content: [
    "The pi-tasks extension is using the `tq` backend for this project because a `.tq` directory was detected.",
    "If you need direct `tq` CLI guidance, run `tq prime`.",
    "When manipulating pi-tasks metadata through `tq`, store it under",
    "`pi_tasks`, for example",
    "`--metadata '{\"pi_tasks\":{\"taskType\":\"TYPE\",\"dueAt\":\"TIMESTAMP\"}}'`,",
    "or merge the same shape with `--merge-metadata`.",
  ].join(" "),
}

function hasTqDirectory(startDirectory = process.cwd()): boolean {
  let currentDirectory = resolve(startDirectory)

  while (true) {
    if (existsSync(resolve(currentDirectory, ".tq"))) return true

    const parentDirectory = dirname(currentDirectory)
    if (parentDirectory === currentDirectory) return false
    currentDirectory = parentDirectory
  }
}

function isApplicable(): boolean {
  if (!hasTqDirectory()) return false

  const result = spawnSync("tq", ["--help"], { stdio: "ignore" })
  if (result.error) {
    throw new Error("Detected a .tq directory, but the `tq` CLI is not available on PATH")
  }
  return true
}

export default createSqCompatibleAdapterInitializer({
  id: "tq",
  command: "tq",
  sessionContextMessage: SESSION_CONTEXT_MESSAGE,
  isApplicable,
})
