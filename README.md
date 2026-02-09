# @soleone/pi-tasks

Task management extension for the [pi coding agent](https://github.com/badlogic/pi-mono), designed for pluggable task backends.

## Quick start

1. Installation: `pi install npm:@soleone/pi-tasks`
2. Toggle the Tasks UI with `ctrl + q`, or use `/tasks`.

## Usage

- Navigate up with `w` and `s` (arrows also work)
- `space` to change status
- `0` to `4` to change priority
- `t` to change task type
- `f` for keyword search (title, description)
- `q` or `Esc` to go back

### List view

- `e` to edit a task
- `Enter` to work off a task
- `Tab` to insert task details in prompt and close Tasks UI

### Edit view

- `Tab` to switch focus between inputs
- `Enter` to save

## Backend selection

By default, the extension auto-detects the first applicable backend. If none are applicable, it falls back to `todo-md`.

Set `PI_TASKS_BACKEND` to explicitly choose a backend implementation.
Currently supported values:

- `beads`
- `todo-md`

### TODO.md backend

The `todo-md` backend reads/writes a markdown task file (default: `TODO.md`; if `todo.md` already exists, it is used).

Optional env var:

- `PI_TASKS_TODO_PATH` — override the TODO file path
