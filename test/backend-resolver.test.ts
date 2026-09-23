import test from "node:test"
import assert from "node:assert/strict"
import type { TaskAdapterDetection, TaskAdapterInitializer } from "../src/backend/api.ts"
import { resolveAdapterInitializer } from "../src/backend/resolver.ts"

function adapter(id: string, detection: TaskAdapterDetection): TaskAdapterInitializer {
  return {
    id,
    detect: () => detection,
    initialize: () => { throw new Error("not used by resolver tests") },
  }
}

test("project matches outrank defaults, fallbacks, and the final fallback", () => {
  const tasks = adapter("tasks", "project")
  const sq = adapter("sq", "default")
  const todo = adapter("todo-md", "final")

  assert.equal(resolveAdapterInitializer([tasks, sq, todo]), tasks)
})

test("defaults outrank available fallbacks", () => {
  const tasks = adapter("tasks", "fallback")
  const sq = adapter("sq", "default")
  const todo = adapter("todo-md", "final")

  assert.equal(resolveAdapterInitializer([tasks, sq, todo]), sq)
})

test("registry order breaks ties within a precedence tier", () => {
  const preferred = adapter("preferred", "project")
  const other = adapter("other", "project")

  assert.equal(resolveAdapterInitializer([preferred, other, adapter("todo-md", "final")]), preferred)
})

test("fallback backend is selected when higher tiers are unavailable", () => {
  const tasks = adapter("tasks", "fallback")
  const todo = adapter("todo-md", "final")

  assert.equal(resolveAdapterInitializer([tasks, adapter("sq", undefined), todo]), tasks)
})

test("all detections are gathered before precedence is applied", () => {
  const calls: string[] = []
  const make = (id: string, detection: TaskAdapterDetection): TaskAdapterInitializer => ({
    ...adapter(id, detection),
    detect: () => { calls.push(id); return detection },
  })
  const sq = make("sq", "default")
  const todo = make("todo-md", "final")

  assert.equal(resolveAdapterInitializer([make("tasks", undefined), sq, todo]), sq)
  assert.deepEqual(calls, ["tasks", "sq", "todo-md"])
})

test("the final fallback is used when no backend is available", () => {
  const todo = adapter("todo-md", "final")

  assert.equal(resolveAdapterInitializer([adapter("tasks", undefined), todo]), todo)
})

test("explicit configuration wins and reports unknown backends", () => {
  const sq = adapter("sq", undefined)
  const todo = adapter("todo-md", "final")

  assert.equal(resolveAdapterInitializer([sq, todo], "sq"), sq)
  assert.throws(
    () => resolveAdapterInitializer([sq, todo], "unknown"),
    /Unsupported tasks backend: unknown/,
  )
})
