import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TasksCliClient, TasksCliError } from "../src/backend/adapters/tasks/client.ts"

function fakeCli(): { directory: string; script: string } {
  const directory = mkdtempSync(join(tmpdir(), "pi-tasks-cli-client-"))
  const script = join(directory, "fake-cli.mjs")
  writeFileSync(script, `
const args = process.argv.slice(2)
if (args[0] === "complete") {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: "STALE_TASK_VERSION", message: "stale" } }))
  process.exitCode = 3
} else {
  process.stdout.write(JSON.stringify({ args }))
}
`)
  return { directory, script }
}

test("Tasks CLI client maps JSON requests to argv and preserves empty values", async () => {
  const { directory, script } = fakeCli()
  try {
    const client = new TasksCliClient([{
      label: "fake tasks-cli",
      command: process.execPath,
      args: [script],
    }])

    const created = await client.request<{ args: string[] }>("task.create", {
      title: "--literal title",
      descriptionMarkdown: "",
    })
    assert.deepEqual(created.args.slice(0, 5), ["add", "--description", "", "--idempotency-key", created.args[4]])
    assert.deepEqual(created.args.slice(-2), ["--", "--literal title"])

    const result = await client.request<{ args: string[] }>("task.update", {
      id: "task-id",
      title: "New title",
      descriptionMarkdown: "",
      priority: 2,
      expectedVersion: 7,
    })

    assert.deepEqual(result.args, [
      "update",
      "task-id",
      "--title",
      "New title",
      "--description",
      "",
      "--priority",
      "2",
      "--idempotency-key",
      result.args[9],
      "--expected-version",
      "7",
      "--actor-kind",
      "agent",
      "--actor-label",
      "pi",
      "--json",
    ])
    assert.match(result.args[9]!, /^pi-[0-9a-f-]+-2$/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Tasks CLI client preserves structured CLI errors", async () => {
  const { directory, script } = fakeCli()
  try {
    const client = new TasksCliClient([{
      label: "fake tasks-cli",
      command: process.execPath,
      args: [script],
    }])

    await assert.rejects(
      () => client.request("task.complete", { id: "task-id", expectedVersion: 1 }),
      (error: unknown) => error instanceof TasksCliError && error.code === "STALE_TASK_VERSION",
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
