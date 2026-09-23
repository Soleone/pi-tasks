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
- `x` to toggle between active and closed tasks
- `n` to create a child under the selected task
- `d` to open task details
- `Enter` to work off a task
- `Tab` to insert task details in prompt and close Tasks UI
- `c` to create a root task
- `Delete` to close the selected task

Grouped mode shows root tasks first and reveals indented descendants on expansion. Press `x` to show archived (closed) tasks instead of active ones; `x` again returns to the active list. The archive is sorted most recently closed first (beads `closed_at`, or `updated_at` for sq/tq; TODO.md has no timestamps, so it keeps file order). Closing or reopening a task removes it from the current view since it no longer belongs to that scope. Searching in grouped mode automatically includes the ancestor path to matching descendants. Blocked rows include unresolved blocker refs, and the preview shows blocker titles and whether each blocker is open, closed, or missing. The blocked marker is derived from blocker readiness without changing the backend lifecycle status.

### Edit view

- `Tab` to switch focus between inputs
- `Enter` to save
- `p` to choose or clear the parent task when hierarchy is supported
- `b` to toggle blocker tasks when blocked-by dependencies are supported

Relationship pickers exclude the current task. Parent cycles, self-links, and dependency cycles are rejected before persistence; unsupported backend relationships are hidden and rejected by the adapter rather than silently discarded.

## Task backends

By default, project-specific matches take precedence, followed by the installed `sq` default, then Tasks as a category-scoped fallback when its workspace and `tasks-cli` are available. If none are available, the extension uses `todo-md`. Projects with a `.tq` directory use the `tq` backend for that session.

For most setups, `sq` is recommended as the default backend. It is lightweight, works well in brand new directories, and can create its local data on demand. Install it from the [`sq` installation guide](https://github.com/DerekStride/sq?tab=readme-ov-file#installation).

### Supported backends:

- [Tasks](https://github.com/Soleone/tasks) - Reads and writes a Tasks workspace through `tasks-cli`, scoped to the `@category` that matches the project name. Detection runs first, so a matching category claims the project.
- [sq](https://github.com/DerekStride/sq) - Uses the `sq` cli to manage tasks in a `.sift` directory via a `issues.jsonl` file. No initialization necessary.
- `tq` - Uses the `tq` cli to manage tasks in a `.tq/tasks.jsonl` file. Automatically preferred when a `.tq` directory is detected.
- [beads](https://github.com/steveyegge/beads) - Uses the `bd` cli to manage tasks into a `.beads` directory containing multiple files.
- `todo-md` - Creates or reads a `TODO.md` file with different sections to emulate priority.

### Tasks workspace backend

The `tasks` backend talks to the same command path as the Tasks desktop app, so the list, the app, and any other agent stay in sync without a shared file format to negotiate. Automatic detection needs two things:

1. The Tasks workspace exists (`com.soleone.tasks/tasks.db` in the platform data directory, or wherever `TASKS_DATABASE_PATH` points).
2. The project name matches a `@category` that at least one non-canceled task uses.

So a task titled `Fix the bar @pi-tasks` belongs to this repository, and only those tasks are listed. For Git projects, pi-tasks uses the main repository directory, so linked worktrees share the same category; other projects use the current directory. The project name is lowercased and anything outside letters, numbers, hyphens and underscores becomes a hyphen, so `My.App` reads as `@my-app`. If no category matches, Tasks stays out of the way during normal detection. If no other project backend applies, it can serve as the fallback using the derived project category, so unrelated workspace tasks are not shown.

Because Tasks derives `@category` from the title, the adapter keeps the scope token there: created tasks get it appended, renamed tasks keep it, and a title that uses a different category is rejected instead of quietly moving the task out of the project.

The adapter invokes `tasks-cli --json` once per operation. The CLI enters the same backend command implementation as the desktop app, so reads and writes stay in sync without pi-tasks touching SQLite directly. Task ids are UUIDs, so the list shows an eight character prefix that the adapter resolves back to the full id; longer prefixes disambiguate.

The CLI is expected on `PATH` as `tasks-cli`. Nothing is guessed about where Tasks is installed, and the app binary is never a candidate: it is named `tasks` and running it opens a window. When `tasks-cli` is not reachable, `PI_TASKS_TASKS_COMMAND` points at it explicitly.

| Situation | Setup |
| --- | --- |
| Installed from `.deb` / `.rpm` | none, `/usr/bin/tasks-cli` is already on `PATH` |
| Development build | symlink it under the packaged name (below) or set `PI_TASKS_TASKS_COMMAND` |
| AppImage | extract it, then set `PI_TASKS_TASKS_COMMAND` to `squashfs-root/usr/bin/tasks-cli` |
| CLI from source | `pnpm build:backend`, then `PI_TASKS_TASKS_COMMAND=<checkout>/dist/backend/tasks-cli.js`, which runs on the same Node as pi |

A development build names the sidecar after its target triple, so adding `src-tauri/binaries` to `PATH` does not put `tasks-cli` on `PATH`. Give it the packaged name instead:

```bash
host_tuple="$(rustc -vV | sed -n 's/^host: //p')"
ln -s "$SRC/products/tasks/src-tauri/binaries/tasks-cli-$host_tuple" ~/.local/bin/tasks-cli
```

Tasks has no task types or due dates, so the type stays `task`; unsupported task types and due dates are rejected rather than silently discarded. Status and priority map directly:

| pi-tasks | Tasks |
| --- | --- |
| `open` | `open` |
| `inProgress` | `in_progress` (`task.start`) |
| `deferred` | `paused` (`task.pause`) |
| `closed` | `done` (`task.complete`); `canceled` tasks also read as closed |
| `p0` - `p4` | priority `0` - `4` |

Versioned mutations carry the task's current `expectedVersion`, so a concurrent edit from the app surfaces as a stale-version error rather than a silent overwrite. Canceled dependencies stay in place as history; only the blockers the list shows are added or removed.

### Relationships

Parent/child hierarchy and blocked-by dependencies are independent: a child is not automatically blocked by its parent. Any task may be a parent, although the `epic` type is useful for groups.

| Backend | Hierarchy | Blocked by |
| --- | --- | --- |
| `tasks` | Native `parentId` (`task.move`) | Native `task.dependency.add` / `task.dependency.remove` |
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
  - `tasks`
  - `sq`
  - `tq`
  - `beads`
  - `todo-md`

Tasks backend, all optional:

- `PI_TASKS_TASKS_CATEGORY` - use this category instead of the one derived from the project name. Setting it activates the backend even before a task uses the category.
- `PI_TASKS_TASKS_COMMAND` - the `tasks-cli` command or path, for a development build, an extracted AppImage sidecar, or `tasks-cli.js`. Replaces the `PATH` lookup; a bare name still resolves through `PATH`.
- `PI_TASKS_TASKS_DB` - path to `tasks.db`. Defaults to `TASKS_DATABASE_PATH`, then the platform data directory.
- `PI_TASKS_TASKS_SYNC_ROOT` - canonical JSON root used for category detection. Defaults to `TASKS_SYNC_ROOT`, then `sync` beside the database.
- `PI_TASKS_TASKS_DATA_DIR` - directory holding `tasks.db`, for a Tasks profile that does not live in the default data directory.
