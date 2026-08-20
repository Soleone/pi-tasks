# @soleone/pi-tasks

Task management extension for the [pi coding agent](https://github.com/badlogic/pi-mono), designed for pluggable task backends.

<img width="2373" height="1305" alt="image" src="https://github.com/user-attachments/assets/af210b63-f993-447d-9668-3308874d493c" />

## Quick start

1. Installation: `pi install npm:@soleone/pi-tasks`
2. Toggle the Tasks UI with `ctrl + shift + r` or `alt + x`, or use `/tasks`.

## Usage

- Navigate with `w` / `s` (up / down arrows also work)
- `a` to go back (`Esc` and left arrow also work)
- `space` to change status
- `0` to `4` to change priority
- `t` to change task type
- `f` for keyword search (title, description)

### List view

- `g` to toggle between flat and grouped hierarchy modes
- `e` to expand or collapse the selected parent in grouped mode
- `n` to create a child under the selected task
- `d` to open task details
- `Enter` to work off a task
- `Tab` to insert task details in prompt and close Tasks UI
- `c` to create a root task
- `Delete` to close the selected task

Grouped mode shows root tasks first and reveals indented descendants on demand. Searching in grouped mode automatically includes the ancestor path to matching descendants. Blocked rows include unresolved blocker refs, and the preview shows blocker titles and whether each blocker is open, closed, or missing. The blocked marker is derived from blocker readiness without changing the backend lifecycle status.

### Edit view

- `Tab` to switch focus between inputs
- `Enter` to save
- `p` to choose or clear the parent task when hierarchy is supported
- `b` to toggle blocker tasks when blocked-by dependencies are supported

Relationship pickers exclude the current task. Parent cycles, self-links, and dependency cycles are rejected before persistence; unsupported backend relationships are hidden and rejected by the adapter rather than silently discarded.

## Task backends

By default, the extension auto-detects the first applicable backend. If none are applicable, it falls back to `todo-md`. Projects with a `.tq` directory use the `tq` backend for that session; otherwise `sq` remains the recommended default.

For most setups, `sq` is recommended as the default backend. It is lightweight, works well in brand new directories, and can create its local data on demand. Install it from the [`sq` installation guide](https://github.com/DerekStride/sq?tab=readme-ov-file#installation).

### Supported backends:

- [sq](https://github.com/DerekStride/sq) - Uses the `sq` cli to manage tasks in a `.sift` directory via a `issues.jsonl` file. No initialization necessary.
- `tq` - Uses the `tq` cli to manage tasks in a `.tq/tasks.jsonl` file. Automatically preferred when a `.tq` directory is detected.
- [beads](https://github.com/steveyegge/beads) - Uses the `bd` cli to manage tasks into a `.beads` directory containing multiple files.
- `todo-md` - Creates or reads a `TODO.md` file with different sections to emulate priority.

### Relationships

Parent/child hierarchy and blocked-by dependencies are independent: a child is not automatically blocked by its parent. Any task may be a parent, although the `epic` type is useful for groups.

| Backend | Hierarchy | Blocked by |
| --- | --- | --- |
| `sq` / `tq` | `metadata.pi_tasks.parentRef` | Native `blocked_by` |
| `todo-md` | Nested checklist indentation | Not supported |
| `beads` | Not supported | Read-only when native blocker records are present |

Pi-tasks metadata is always namespaced under `pi_tasks`; sq/tq hierarchy therefore uses:

```json
{"pi_tasks":{"taskType":"epic","parentRef":"parent-id"}}
```

Nested TODO.md tasks use two spaces per level. Non-checklist nested bullets remain task descriptions:

```md
- [ ] **Parent**
  - [ ] **Child**
    - Child description
```

For local UI testing, `scripts/seed-hierarchy-demo.sh` creates an idempotent sq demo epic with children, a grandchild, resolved and unresolved blockers, and a two-blocker task.

## Optional env vars:

- `PI_TASKS_TODO_PATH` - override the TODO file path
- `PI_TASKS_BACKEND` - to explicitly choose a backend implementation. Currently supported values:
  - `sq`
  - `tq`
  - `beads`
  - `todo-md`
