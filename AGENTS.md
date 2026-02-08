# Beads Pi

An extension for pi to manage tasks via beads.

## Code style

- Where appropriate try to abstract code into helper functions and sometimes potentially helper objects. The resulting extension code should live on the same layer of abstraction and be elegant to read for intuitive understanding.

## Task Management

Use `bd` (beads) for task tracking.

- When creating or updating issues with multi-line descriptions, use actual newlines in the shell command (not `\n`).
- Use p2 as default priority unless context gives another impression.

Key commands:
- `bd ready --sort priority --json` -- see unblocked work at session start
- `bd list --status open --json` -- list all open issues
- `bd show <id> --json` -- show issue details
- `bd update <id> -s in_progress --json` -- mark a task as started
- `bd close <id> -r "reason" --json` -- close a completed task
- `bd create "title" -t task --json` -- create a new task
- `bd sync` -- sync issues to git before ending a session
