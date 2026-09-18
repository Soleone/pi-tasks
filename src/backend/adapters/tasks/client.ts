import { spawn, type ChildProcessByStdio } from "node:child_process"
import { randomUUID } from "node:crypto"
import type { Readable, Writable } from "node:stream"
import type { TasksLaunchCandidate } from "./discovery.ts"

const PROTOCOL_VERSION = 1
const ACTOR = { kind: "agent", label: "pi" } as const
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const CONNECT_TIMEOUT_MS = 8_000
const IDLE_EXIT_MS = 60_000
const MAX_STDERR_CHARS = 2_000

type SidecarProcess = ChildProcessByStdio<Writable, Readable, Readable>

interface PendingRequest {
  child: SidecarProcess
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface ProtocolEnvelope {
  requestId?: unknown
  ok?: unknown
  result?: unknown
  error?: { code?: unknown; message?: unknown }
}

/** A command the Tasks backend rejected; `code` is the protocol error code. */
export class TasksBackendError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = "TasksBackendError"
    this.code = code
  }
}

function exitReason(candidate: TasksLaunchCandidate, code: number | null, signal: NodeJS.Signals | null): string {
  return `${candidate.label} exited (${signal ?? `code ${code}`})`
}

function responseError(envelope: ProtocolEnvelope): TasksBackendError {
  const code = typeof envelope.error?.code === "string" ? envelope.error.code : "INTERNAL_ERROR"
  const message = typeof envelope.error?.message === "string" ? envelope.error.message : "Tasks backend request failed"
  return new TasksBackendError(code, message)
}

function withDetails(message: string, details: string): Error {
  const trimmed = details.trim()
  return new Error(trimmed.length > 0 ? `${message}: ${trimmed}` : message)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * JSON-lines client for the Tasks command path. One `--stdio` child process is
 * shared by every request and respawned on demand, which keeps the sidecar warm
 * without outliving the session: the child also exits when stdin closes, and an
 * idle timeout reaps it sooner.
 */
export class TasksProtocolClient {
  private candidates: TasksLaunchCandidate[]
  private child: SidecarProcess | null = null
  private preferredCandidate = 0
  private connecting: Promise<SidecarProcess> | null = null
  private pending = new Map<string, PendingRequest>()
  private stdoutBuffer = ""
  private stderrTail = ""
  private idleTimer: NodeJS.Timeout | null = null
  private sessionKey = randomUUID()
  private requestCounter = 0

  constructor(candidates: TasksLaunchCandidate[]) {
    this.candidates = candidates
    process.once("exit", () => this.close())
  }

  async request<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    const child = await this.connect()
    const requestId = `pi-${process.pid}-${++this.requestCounter}`

    try {
      return await this.dispatch<T>(child, requestId, command, args, DEFAULT_REQUEST_TIMEOUT_MS)
    } finally {
      this.scheduleIdleExit()
    }
  }

  close(): void {
    const child = this.child
    this.child = null
    this.stdoutBuffer = ""
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
  }

  private connect(): Promise<SidecarProcess> {
    if (this.child) return Promise.resolve(this.child)
    if (this.connecting) return this.connecting

    this.connecting = this.openCandidate().then(
      child => {
        this.connecting = null
        return child
      },
      error => {
        this.connecting = null
        throw error
      },
    )

    return this.connecting
  }

  private async openCandidate(): Promise<SidecarProcess> {
    const failures: string[] = []
    const ordered = [
      ...this.candidates.slice(this.preferredCandidate),
      ...this.candidates.slice(0, this.preferredCandidate),
    ]

    for (const candidate of ordered) {
      const child = this.spawn(candidate)
      try {
        await this.dispatch(child, `pi-${process.pid}-probe`, "runtime.probe", {}, CONNECT_TIMEOUT_MS)
        this.child = child
        this.preferredCandidate = Math.max(0, this.candidates.indexOf(candidate))
        return child
      } catch (error) {
        this.handleExit(child, messageOf(error))
        failures.push(`- ${candidate.label}: ${messageOf(error)}`)
      }
    }

    throw new Error([
      "Could not reach a Tasks backend.",
      ...failures,
      "Install Tasks so `tasks-backend` is on PATH, or set PI_TASKS_TASKS_COMMAND to a",
      "development build, an extracted AppImage sidecar, or the backend's cli.js.",
    ].join("\n"))
  }

  private spawn(candidate: TasksLaunchCandidate): SidecarProcess {
    const child = spawn(candidate.command, candidate.args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...(candidate.env ? { env: candidate.env } : {}),
    }) as SidecarProcess
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdin.on("error", () => undefined)
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk))
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-MAX_STDERR_CHARS)
    })
    child.once("error", (error: Error) => this.handleExit(child, error.message))
    child.once("exit", (code, signal) => this.handleExit(child, exitReason(candidate, code, signal)))
    return child
  }

  private dispatch<T>(
    child: SidecarProcess,
    requestId: string,
    command: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<T> {
    // Tasks requires an idempotencyKey on every mutation. The adapter never
    // replays a mutation whose outcome is unknown, so a unique key per attempt
    // is enough to keep two intentional writes from collapsing into one.
    const payload = JSON.stringify({
      version: PROTOCOL_VERSION,
      requestId,
      command,
      args,
      actor: ACTOR,
      idempotencyKey: `pi-${this.sessionKey}-${requestId}`,
    })

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`${command} timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pending.set(requestId, {
        child,
        resolve: result => resolve(result as T),
        reject,
        timer,
      })

      child.stdin.write(`${payload}\n`, error => {
        if (!error) return
        const entry = this.pending.get(requestId)
        if (!entry) return
        this.pending.delete(requestId)
        clearTimeout(entry.timer)
        entry.reject(withDetails(`Failed to send ${command}`, error.message))
      })
    })
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk

    let newline = this.stdoutBuffer.indexOf("\n")
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline)
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      this.settleLine(line)
      newline = this.stdoutBuffer.indexOf("\n")
    }
  }

  private settleLine(line: string): void {
    if (line.trim() === "") return

    let envelope: ProtocolEnvelope
    try {
      envelope = JSON.parse(line) as ProtocolEnvelope
    } catch {
      return
    }

    const requestId = typeof envelope.requestId === "string" ? envelope.requestId : ""
    const entry = this.pending.get(requestId)
    if (!entry) return

    this.pending.delete(requestId)
    clearTimeout(entry.timer)

    if (envelope.ok === true) entry.resolve(envelope.result ?? {})
    else entry.reject(responseError(envelope))
  }

  private handleExit(child: SidecarProcess, reason = "Tasks backend stopped"): void {
    const details = this.stderrTail
    const wasCurrent = this.child === child

    if (wasCurrent) {
      this.child = null
      this.stdoutBuffer = ""
      this.stderrTail = ""
    }
    child.stdout.removeAllListeners("data")

    for (const [requestId, entry] of this.pending) {
      if (entry.child !== child) continue
      this.pending.delete(requestId)
      clearTimeout(entry.timer)
      entry.reject(withDetails(reason, details))
    }

    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  }

  private scheduleIdleExit(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.close(), IDLE_EXIT_MS)
    this.idleTimer.unref?.()
  }
}
