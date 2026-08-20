import test from "node:test"
import assert from "node:assert/strict"
import { projectTaskList, wouldCreateDependencyCycle, wouldCreateParentCycle } from "../src/models/task-hierarchy.ts"
import { buildTaskWorkPrompt, serializeTask } from "../src/lib/task-serialization.ts"
import { buildTaskListTextParts, displayTaskStatus, type Task } from "../src/models/task.ts"

const tasks: Task[] = [
  { ref: "root", title: "Epic", status: "open", taskType: "epic" },
  { ref: "child-a", title: "API", status: "open", parentRef: "root" },
  { ref: "grandchild", title: "Contract", status: "open", parentRef: "child-a" },
  { ref: "child-b", title: "UI", status: "blocked", parentRef: "root" },
  { ref: "other", title: "Release", status: "open" },
]

test("grouped projection hides and expands descendants", () => {
  assert.deepEqual(
    projectTaskList(tasks, { grouped: true }).map(row => [row.task.ref, row.depth]),
    [["root", 0], ["other", 0]],
  )

  assert.deepEqual(
    projectTaskList(tasks, { grouped: true, expandedRefs: new Set(["root", "child-a"]) })
      .map(row => [row.task.ref, row.depth]),
    [["root", 0], ["child-a", 1], ["grandchild", 2], ["child-b", 1], ["other", 0]],
  )
})

test("search reveals a matching descendant and its ancestors", () => {
  assert.deepEqual(
    projectTaskList(tasks, { grouped: true, filterTerm: "contract" }).map(row => row.task.ref),
    ["root", "child-a", "grandchild"],
  )
})

test("orphans and cycles remain visible as roots", () => {
  const malformed: Task[] = [
    { ref: "orphan", title: "Orphan", status: "open", parentRef: "missing" },
    { ref: "a", title: "A", status: "open", parentRef: "b" },
    { ref: "b", title: "B", status: "open", parentRef: "a" },
  ]
  assert.deepEqual(
    projectTaskList(malformed, { grouped: true }).map(row => row.task.ref),
    ["orphan", "a", "b"],
  )
})

test("status search accepts user-facing kebab case", () => {
  const active: Task = { ref: "active", title: "Active", status: "inProgress" }
  assert.deepEqual(projectTaskList([active], { grouped: false, filterTerm: "in-progress" }).map(row => row.task.ref), ["active"])
})

test("blocked row metadata names concrete unresolved blocker refs", () => {
  const task: Task = {
    ref: "blocked",
    title: "Blocked",
    status: "blocked",
    blockers: [
      { ref: "open-a", status: "open" },
      { ref: "done-b", status: "closed" },
      { ref: "missing-c" },
    ],
  }
  assert.match(buildTaskListTextParts(task).meta, /← open-a,missing-c/)
  assert.doesNotMatch(buildTaskListTextParts(task).meta, /done-b/)
  assert.equal(displayTaskStatus(task), "blocked")
})

test("resolved blockers clear a stale blocked lifecycle marker", () => {
  assert.equal(displayTaskStatus({
    ref: "resolved",
    title: "Resolved",
    status: "blocked",
    blockers: [{ ref: "done", status: "closed" }],
  }), "open")
  assert.equal(displayTaskStatus({
    ref: "working",
    title: "Working",
    status: "inProgress",
    blockers: [{ ref: "open", status: "open" }],
  }), "blocked")
})

test("serialized task handoff preserves relationship refs", () => {
  const serialized = serializeTask({
    ref: "child",
    title: "Child",
    status: "blocked",
    parentRef: "epic",
    blockers: [{ ref: "api", status: "open" }],
  })
  assert.match(serialized, /parent=epic/)
  assert.match(serialized, /blocked-by=api/)
})

test("work prompt tells the agent to mark the task in progress first", () => {
  const prompt = buildTaskWorkPrompt({
    ref: "task-1",
    id: "task-1",
    title: "Implement the feature",
    status: "open",
  })

  assert.match(prompt, /immediately mark this task as in progress before doing any other work/)
})

test("dependency cycle validation rejects self and transitive cycles", () => {
  const dependencyTasks: Task[] = [
    { ref: "api", title: "API", status: "open", blockers: [{ ref: "schema" }] },
    { ref: "schema", title: "Schema", status: "open" },
  ]
  assert.equal(wouldCreateDependencyCycle(dependencyTasks, "schema", ["api"]), true)
  assert.equal(wouldCreateDependencyCycle(dependencyTasks, "api", ["api"]), true)
  assert.equal(wouldCreateDependencyCycle(dependencyTasks, "schema", ["missing"]), false)
})

test("parent cycle validation rejects self and descendant parents", () => {
  assert.equal(wouldCreateParentCycle(tasks, "root", "grandchild"), true)
  assert.equal(wouldCreateParentCycle(tasks, "child-b", "child-b"), true)
  assert.equal(wouldCreateParentCycle(tasks, "child-b", "other"), false)
})
