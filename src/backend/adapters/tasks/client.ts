import { spawn, type ChildProcessByStdio } from "node:child_process"
import { randomUUID } from "node:crypto"
import type { Readable, Writable } from "node:stream"
import type { TasksLaunchCandidate } from "./discovery.ts"

const COMMAND_TIMEOUT_MS = 15_000
const MAX_STDERR_CHARS = 2_000

type CliProcess = ChildProcessByStdio<Writable, Readable, Readable>

type JsonRecord = Record<string, unknown>

/** A command the Tasks CLI rejected; `code` is the backend error code. */
export class TasksCliError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = "TasksCliError"
    this.code = code
  }
}

const MUTATION_COMMANDS = new Set([
  "task.create",
  "task.update",
  "task.delete",
  "task.start",
  "task.pause",
  "task.complete",
  "task.reopen",
  "task.cancel",
  "task.status.undo",
  "task.move",
  "task.dependency.add",
  "task.dependency.remove",
])

const VERSIONED_COMMANDS = new Set([
  "task.update",
  "task.delete",
  "task.start",
  "task.pause",
  "task.complete",
  "task.reopen",
  "task.cancel",
  "task.status.undo",
  "task.move",
  "task.dependency.add",
  "task.dependency.remove",
])

function requiredString(args: JsonRecord, name: string): string {
  const value = args[name]
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`)
  }
  return value
}

function appendOption(argv: string[], name: string, value: unknown): void {
  if (value === undefined) return
  argv.push(name, String(value))
}

function appendRepeatedOption(argv: string[], name: string, value: unknown): void {
  if (!Array.isArray(value)) {
    if (value !== undefined) appendOption(argv, name, value)
    return
  }
  for (const item of value) appendOption(argv, name, item)
}

function hasOwn(args: JsonRecord, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(args, name)
}

function commandArguments(command: string, args: JsonRecord): string[] {
  switch (command) {
    case "runtime.probe":
    case "workspace.info":
      return ["info"]

    case "task.list": {
      const argv = ["list"]
      appendRepeatedOption(argv, "--status", args.status)
      appendOption(argv, "--priority", args.priority)
      appendOption(argv, "--category", args.category)
      appendRepeatedOption(argv, "--tag", args.tags)
      appendOption(argv, "--search", args.search)
      appendOption(argv, "--limit", args.limit)
      appendOption(argv, "--offset", args.offset)
      appendOption(argv, "--sort", args.sort)
      appendOption(argv, "--direction", args.direction)
      if (args.unblocked === true) argv.push("--unblocked")
      if (args.includeAncestors === true) argv.push("--include-ancestors")
      return argv
    }

    case "task.get":
      return ["show", requiredString(args, "id")]

    case "task.create": {
      const argv = ["add"]
      if (hasOwn(args, "descriptionMarkdown")) appendOption(argv, "--description", args.descriptionMarkdown)
      appendOption(argv, "--priority", args.priority)
      if (args.parentId !== undefined && args.parentId !== null) appendOption(argv, "--parent", args.parentId)
      // Keep a title beginning with `--` positional instead of letting the CLI
      // interpret it as an option.
      argv.push("--", requiredString(args, "title"))
      return argv
    }

    case "task.update": {
      const argv = ["update", requiredString(args, "id")]
      appendOption(argv, "--title", args.title)
      if (hasOwn(args, "descriptionMarkdown")) appendOption(argv, "--description", args.descriptionMarkdown)
      appendOption(argv, "--priority", args.priority)
      return argv
    }

    case "task.start":
      return ["start", requiredString(args, "id")]
    case "task.pause":
      return ["pause", requiredString(args, "id")]
    case "task.complete":
      return ["complete", requiredString(args, "id")]
    case "task.reopen":
      return ["reopen", requiredString(args, "id")]
    case "task.cancel":
      return ["cancel", requiredString(args, "id")]
    case "task.delete":
      return ["delete", requiredString(args, "id")]
    case "task.status.undo":
      return ["undo", requiredString(args, "id")]

    case "task.move": {
      const argv = ["move", requiredString(args, "id")]
      if (args.parentId === null) argv.push("--root")
      else appendOption(argv, "--parent", args.parentId)
      return argv
    }

    case "task.dependency.add":
      return ["dep-add", requiredString(args, "id"), requiredString(args, "dependsOnId")]
    case "task.dependency.remove":
      return ["dep-remove", requiredString(args, "id"), requiredString(args, "dependsOnId")]

    case "category.list":
      return ["categories"]
    case "tag.list":
      return ["tags"]
    case "activity.list": {
      const argv = ["activity"]
      appendOption(argv, "--task", args.taskId)
      appendOption(argv, "--limit", args.limit)
      return argv
    }

    default:
      throw new Error(`The Tasks CLI does not support protocol command ${command}`)
  }
}

function errorFromResult(result: unknown): TasksCliError | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined
  const envelope = result as JsonRecord
  if (envelope.ok !== false || !envelope.error || typeof envelope.error !== "object" || Array.isArray(envelope.error)) {
    return undefined
  }

  const error = envelope.error as JsonRecord
  return new TasksCliError(
    typeof error.code === "string" ? error.code : "UNKNOWN",
    typeof error.message === "string" ? error.message : "Tasks CLI request failed",
  )
}

function parseJson(stdout: string, command: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error(`tasks-cli returned invalid JSON for ${command}`)
  }
}

function stderrDetails(stderr: string): string {
  return stderr.trim().slice(-MAX_STDERR_CHARS)
}

function exitMessage(candidate: TasksLaunchCandidate, code: number | null, signal: NodeJS.Signals | null): string {
  return `${candidate.label} exited (${signal ?? `code ${code}`})`
}

/**
 * Executes the installed Tasks CLI once per request. The CLI itself enters the
 * same Tasks backend command path as the desktop app, but owns process startup,
 * optimistic-version lookup, idempotency, and JSON error formatting for us.
 */
export class TasksCliClient {
  private readonly candidates: TasksLaunchCandidate[]
  private readonly sessionKey = randomUUID()
  private requestCounter = 0

  constructor(candidates: TasksLaunchCandidate[]) {
    this.candidates = candidates
  }

  async request<T>(command: string, args: JsonRecord = {}): Promise<T> {
    const candidate = this.candidates[0]
    if (!candidate) throw new Error("No Tasks CLI command was configured")

    const argv = commandArguments(command, args)
    const globalArgs: string[] = []
    if (MUTATION_COMMANDS.has(command)) {
      globalArgs.push("--idempotency-key", `pi-${this.sessionKey}-${++this.requestCounter}`)
      if (VERSIONED_COMMANDS.has(command) && args.expectedVersion !== undefined) {
        appendOption(globalArgs, "--expected-version", args.expectedVersion)
      }
    }
    globalArgs.push("--actor-kind", "agent", "--actor-label", "pi", "--json")

    const terminator = argv.indexOf("--")
    if (terminator === -1) argv.push(...globalArgs)
    else argv.splice(terminator, 0, ...globalArgs)

    return await this.run<T>(candidate, argv)
  }

  private run<T>(candidate: TasksLaunchCandidate, argv: string[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const child = spawn(candidate.command, [...candidate.args, ...argv], {
        stdio: ["ignore", "pipe", "pipe"],
        ...(candidate.env ? { env: candidate.env } : {}),
      }) as CliProcess
      let stdout = ""
      let stderr = ""
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill("SIGTERM")
        reject(new Error(`tasks-cli command ${argv[0] ?? "unknown"} timed out after ${COMMAND_TIMEOUT_MS}ms`))
      }, COMMAND_TIMEOUT_MS)

      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        callback()
      }

      child.stdout.setEncoding("utf8")
      child.stderr.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk
      })
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk
      })
      child.once("error", (error: Error) => {
        finish(() => reject(new Error(`Failed to launch ${candidate.label}: ${error.message}`)))
      })
      child.once("close", (code, signal) => {
        finish(() => {
          let result: unknown
          if (stdout.trim().length > 0) {
            try {
              result = parseJson(stdout, argv[0] ?? "unknown")
            } catch (error) {
              if (code === 0) {
                reject(error)
                return
              }
            }
          }

          const cliError = errorFromResult(result)
          if (cliError) {
            reject(cliError)
            return
          }
          if (code !== 0) {
            const details = stderrDetails(stderr)
            const reason = exitMessage(candidate, code, signal)
            reject(new Error(details.length > 0 ? `${reason}: ${details}` : reason))
            return
          }
          resolve(result as T)
        })
      })
    })
  }
}
