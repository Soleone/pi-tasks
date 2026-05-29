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

- `d` to open task details
- `Enter` to work off a task
- `Tab` to insert task details in prompt and close Tasks UI
- `c` to create a new task

### Edit view

- `Tab` to switch focus between inputs
- `Enter` to save

## Task backends

By default, the extension auto-detects the first applicable backend. If none are applicable, it falls back to `todo-md`. Projects with a `.tq` directory use the `tq` backend for that session, and projects with a `ws.toml` (Windshift) use the `windshift` backend; otherwise `sq` remains the recommended default.

For most setups, `sq` is recommended as the default backend. It is lightweight, works well in brand new directories, and can create its local data on demand. Install it from the [`sq` installation guide](https://github.com/DerekStride/sq?tab=readme-ov-file#installation).

### Supported backends:

- [sq](https://github.com/DerekStride/sq) - Uses the `sq` cli to manage tasks in a `.sift` directory via a `issues.jsonl` file. No initialization necessary.
- `tq` - Uses the `tq` cli to manage tasks in a `.tq/tasks.jsonl` file. Automatically preferred when a `.tq` directory is detected.
- [beads](https://github.com/steveyegge/beads) - Uses the `bd` cli to manage tasks into a `.beads` directory containing multiple files.
- `todo-md` - Creates or reads a `TODO.md` file with different sections to emulate priority.
- `windshift` - Uses the `ws` cli to manage Windshift work items in the workspace configured by a `ws.toml`. Run `ws init` to connect a project. Tasks are work items keyed like `WI-123`; status changes map to workflow transitions. Comments, links, milestones, and pages are available through the `ws` cli directly. Priority editing requires a `ws` build that supports `ws priority ls`; older builds show priority read-only.

## Optional env vars:

- `PI_TASKS_TODO_PATH` - override the TODO file path
- `PI_TASKS_BACKEND` - to explicitly choose a backend implementation. Currently supported values:
  - `sq`
  - `tq`
  - `beads`
  - `todo-md`
  - `windshift`
