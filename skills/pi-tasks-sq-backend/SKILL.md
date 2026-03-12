---
name: pi-tasks-sq-backend
description: Pi-specific overlay for task tracking when `PI_TASKS_BACKEND=sq`. Enforces correct use of `PI_TASKS_SQ_QUEUE_PATH` and explains when to prefer the Pi tasks extension vs raw `sq` commands.
model: haiku
---

# Pi Tasks + `sq`

Use this skill when working in Pi with task tracking enabled via the `sq` backend.

## Load Order

1. Load `Skill(sq)` first (generic workflow)
2. Apply this skill's Pi-specific overrides

## Pi Environment Contract

- `PI_TASKS_BACKEND=sq`
- `PI_TASKS_SQ_QUEUE_PATH=<queue file path>`

When `PI_TASKS_SQ_QUEUE_PATH` is set, it is the source of truth for where Pi tasks should be read/written. Always
pass: `--queue "$PI_TASKS_SQ_QUEUE_PATH"`, e.g.

```bash
sq --queue "$PI_TASKS_SQ_QUEUE_PATH" list --status pending --json
sq --queue "$PI_TASKS_SQ_QUEUE_PATH" add --title "..." --description "..." --text "..." --json
sq --queue "$PI_TASKS_SQ_QUEUE_PATH" edit <id> --set-status in_progress
sq --queue "$PI_TASKS_SQ_QUEUE_PATH" close <id>
```

## Metadata

Pi tasks extracts some information from `sq` task metadata, specifically:

1. priority (`metadata.priority`)
2. taskType (`metadata.taskType`)
3. dueAt (`metadata.dueAt`)

When creating tasks via the CLI, include them explicitly.

```bash
sq --queue "$PI_TASKS_SQ_QUEUE_PATH" add \
  --title "Migrate query helper" \
  --text "Refactor ..." \
  --metadata '{"priority":"p1","taskType":"feature","dueAt":"2026-03-15T17:00:00Z"}' \
  --json
```
