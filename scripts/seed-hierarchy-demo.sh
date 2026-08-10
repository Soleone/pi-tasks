#!/usr/bin/env bash
set -euo pipefail

json_id() {
  node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).id))'
}

if sq list --all --json | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.exit(JSON.parse(s).some(x=>x.metadata?.pi_tasks?.demo===true)?0:1))'; then
  echo "Hierarchy demo tasks already exist; remove tasks with metadata.pi_tasks.demo=true to reseed."
  exit 0
fi

add_task() {
  local title=$1 description=$2 type=$3 parent=${4:-} blockers=${5:-}
  local metadata
  if [[ -n "$parent" ]]; then
    metadata=$(printf '{"pi_tasks":{"taskType":"%s","parentRef":"%s","demo":true}}' "$type" "$parent")
  else
    metadata=$(printf '{"pi_tasks":{"taskType":"%s","demo":true}}' "$type")
  fi

  local args=(add --title "$title" --description "$description" --priority 2 --metadata "$metadata" --text "$description" --json)
  [[ -n "$blockers" ]] && args+=(--blocked-by "$blockers")
  sq "${args[@]}" | json_id
}

epic=$(add_task "Demo: Ship task hierarchy" "Demo epic for grouped list behavior." epic)
schema=$(add_task "Demo: Define relationship schema" "Closed prerequisite; API work depends on it." task "$epic")
sq close "$schema" --json >/dev/null
api=$(add_task "Demo: Implement adapter mapping" "Child blocked only by a resolved prerequisite." feature "$epic" "$schema")
contract=$(add_task "Demo: Test metadata contract" "Grandchild used to demonstrate multiple expansion levels." task "$api")
ui=$(add_task "Demo: Build grouped task list" "Blocked by adapter mapping; should display the blocker ref." feature "$epic" "$api")
tests=$(add_task "Demo: Run integration tests" "Blocked by two active tasks." task "$epic" "$api,$ui")
docs=$(add_task "Demo: Document hierarchy keys" "Independent child task." chore "$epic")

printf 'Created hierarchy demo:\n  epic: %s\n  schema (closed): %s\n  api: %s\n  contract: %s\n  ui: %s\n  tests: %s\n  docs: %s\n' \
  "$epic" "$schema" "$api" "$contract" "$ui" "$tests" "$docs"
