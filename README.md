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

## Backend selection

By default, the extension auto-detects the first applicable backend. If none are applicable, it falls back to `todo-md`.

Set `PI_TASKS_BACKEND` to explicitly choose a backend implementation.
Currently supported values:

- `beads`
- `sq`
- `todo-md`

### Sift Queue (`sq`) backend

The `sq` backend integrates with [sift-queue](https://github.com/shopify-playground/sift) and reads/writes tasks through the `sq` CLI.

### TODO.md backend

The `todo-md` backend reads/writes a markdown task file (default: `TODO.md`; if `todo.md` already exists, it is used).

Optional env var:

- `PI_TASKS_TODO_PATH` — override the TODO file path
