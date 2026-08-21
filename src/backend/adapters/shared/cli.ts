import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"

const DEFAULT_TIMEOUT_MS = 30_000

export type CliRunner = (args: string[], timeout?: number) => Promise<string>

export function createCliRunner(pi: ExtensionAPI, command: string): CliRunner {
  return async (args, timeout = DEFAULT_TIMEOUT_MS) => {
    const result = await pi.exec(command, args, { timeout })
    if (result.code !== 0) {
      const details = (result.stderr || result.stdout || "").trim()
      throw new Error(details.length > 0 ? details : `${command} ${args.join(" ")} failed (code ${result.code})`)
    }
    return result.stdout
  }
}

export function parseJsonArray<T>(stdout: string, context: string, command: string): T[] {
  try {
    const parsed = JSON.parse(stdout)
    if (!Array.isArray(parsed)) throw new Error("expected JSON array")
    return parsed as T[]
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to parse ${command} output (${context}): ${message}`)
  }
}

export function parseJsonObject<T>(stdout: string, context: string, command: string): T {
  try {
    const parsed = JSON.parse(stdout)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected JSON object")
    }
    return parsed as T
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to parse ${command} output (${context}): ${message}`)
  }
}
