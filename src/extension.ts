import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent"
import type { Issue, IssueStatus } from "./models/issue.ts"
import { buildWorkPrompt, serializeReference } from "./models/reference.ts"
import { showIssueList } from "./ui/pages/list.ts"
import { showIssueForm } from "./ui/pages/show.ts"

type ListMode = "ready" | "open" | "all"

const MAX_LIST_RESULTS = 200
const CTRL_Q = "\x11"
const CTRL_F = "\x06"

const MODE_SUBTITLES: Record<ListMode, string> = {
  ready: "Ready",
  open: "Open",
  all: "All",
}

const LIST_MODE_ARGS: Record<ListMode, string[]> = {
  ready: ["ready", "--limit", String(MAX_LIST_RESULTS), "--sort", "priority", "--json"],
  open: ["list", "--sort", "priority", "--limit", String(MAX_LIST_RESULTS), "--json"],
  all: ["list", "--all", "--sort", "priority", "--limit", String(MAX_LIST_RESULTS), "--json"],
}

const LIST_MODE_CONTEXT: Record<ListMode, string> = {
  ready: "ready",
  open: "list",
  all: "list all",
}

const ARG_TO_LIST_MODE: Record<string, ListMode> = {
  open: "open",
  all: "all",
}

const CYCLE_STATUSES: IssueStatus[] = ["open", "in_progress", "closed"]
const CYCLE_TYPES = ["task", "feature", "bug", "chore", "epic"] as const

function isLikelyIssueId(value: string): boolean {
  return /^[a-z0-9]+-[a-z0-9]+$/i.test(value)
}

function parseJsonArray<T>(stdout: string, context: string): T[] {
  try {
    const parsed = JSON.parse(stdout)
    if (!Array.isArray(parsed)) throw new Error("expected JSON array")
    return parsed as T[]
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`Failed to parse bd output (${context}): ${msg}`)
  }
}

function parseJsonObject<T>(stdout: string, context: string): T {
  try {
    const parsed = JSON.parse(stdout)
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("expected JSON object")
    }
    return parsed as T
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`Failed to parse bd output (${context}): ${msg}`)
  }
}

function parsePriorityKey(data: string): number | null {
  if (data.length !== 1) return null
  const num = parseInt(data, 10)
  return !isNaN(num) && num >= 0 && num <= 4 ? num : null
}

function parseListMode(args: string): ListMode {
  return ARG_TO_LIST_MODE[args] || "ready"
}

function cycleStatus(current: IssueStatus): IssueStatus {
  const idx = CYCLE_STATUSES.indexOf(current)
  if (idx === -1) return "open"
  return CYCLE_STATUSES[(idx + 1) % CYCLE_STATUSES.length]
}

function cycleIssueType(current: string | undefined): string {
  const normalized = current || "task"
  const idx = CYCLE_TYPES.indexOf(normalized as (typeof CYCLE_TYPES)[number])
  if (idx === -1) return CYCLE_TYPES[0]
  return CYCLE_TYPES[(idx + 1) % CYCLE_TYPES.length]
}

interface EditIssueResult {
  updatedIssue: Issue | null
  closeList: boolean
}

function buildIssueUpdateArgs(previous: Issue, next: {
  title: string
  description: string
  status: IssueStatus
  priority: number | undefined
  issueType: string | undefined
}): string[] {
  const args: string[] = []

  const nextTitle = next.title.trim()
  if (nextTitle !== previous.title.trim()) {
    args.push("--title", nextTitle)
  }

  if (next.description !== (previous.description ?? "")) {
    args.push("--description", next.description)
  }

  if (next.status !== previous.status) {
    args.push("--status", next.status)
  }

  if (next.priority !== previous.priority) {
    args.push("--priority", String(next.priority))
  }

  if (next.issueType !== previous.issue_type) {
    args.push("--type", next.issueType || "task")
  }

  return args
}

export default function registerExtension(pi: ExtensionAPI) {
  async function execBd(args: string[], timeout = 30_000): Promise<string> {
    const result = await pi.exec("bd", args, { timeout })
    if (result.code !== 0) {
      const details = (result.stderr || result.stdout || "").trim()
      throw new Error(details.length > 0 ? details : `bd ${args.join(" ")} failed (code ${result.code})`)
    }
    return result.stdout
  }

  async function listIssues(mode: ListMode): Promise<Issue[]> {
    const out = await execBd(LIST_MODE_ARGS[mode])
    return parseJsonArray<Issue>(out, LIST_MODE_CONTEXT[mode])
  }

  async function showIssue(id: string): Promise<Issue> {
    const out = await execBd(["show", id, "--json"])
    const issues = parseJsonArray<Issue>(out, `show ${id}`)
    const issue = issues[0]
    if (!issue) throw new Error(`Issue not found: ${id}`)
    return issue
  }

  function needsIssueDetailsForEdit(issue: Issue): boolean {
    return issue.description === undefined
  }

  async function getIssueForEdit(id: string, fromList?: Issue): Promise<Issue> {
    if (!fromList) return showIssue(id)
    if (needsIssueDetailsForEdit(fromList)) return showIssue(id)
    return { ...fromList }
  }

  async function updateIssue(id: string, args: string[]): Promise<void> {
    await execBd(["update", id, ...args])
  }

  async function editIssue(ctx: ExtensionCommandContext, id: string, fromList?: Issue): Promise<EditIssueResult> {
    let issue = await getIssueForEdit(id, fromList)

    const formResult = await showIssueForm(ctx, {
      mode: "edit",
      subtitle: "Edit",
      issue,
      ctrlQ: CTRL_Q,
      cycleStatus,
      cycleIssueType,
      parsePriorityKey,
      onSave: async (draft) => {
        const updateArgs = buildIssueUpdateArgs(issue, {
          title: draft.title,
          description: draft.description,
          status: draft.status,
          priority: draft.priority,
          issueType: draft.issueType,
        })

        if (updateArgs.length === 0) return false

        await updateIssue(id, updateArgs)
        issue = {
          ...issue,
          title: draft.title.trim(),
          description: draft.description,
          status: draft.status,
          priority: draft.priority,
          issue_type: draft.issueType,
        }
        return true
      },
    })

    return {
      updatedIssue: issue,
      closeList: formResult.action === "close_list",
    }
  }

  async function createIssue(ctx: ExtensionCommandContext): Promise<Issue | null> {
    let createdIssue: Issue | null = null

    await showIssueForm(ctx, {
      mode: "create",
      subtitle: "Create",
      issue: {
        id: "new",
        title: "",
        description: "",
        status: "open",
        priority: 2,
        issue_type: "task",
      },
      ctrlQ: CTRL_Q,
      cycleStatus,
      cycleIssueType,
      parsePriorityKey,
      onSave: async (draft) => {
        const title = draft.title.trim()
        if (title.length === 0) {
          throw new Error("Title is required")
        }

        if (!createdIssue) {
          const createArgs = [
            "create",
            "--title", title,
            "--priority", String(draft.priority ?? 2),
            "--type", draft.issueType || "task",
            "--json",
          ]

          if (draft.description.length > 0) {
            createArgs.splice(3, 0, "--description", draft.description)
          }

          const out = await execBd(createArgs)
          const created = parseJsonObject<Issue>(out, "create")

          if (draft.status !== "open" && created.id) {
            await updateIssue(created.id, ["--status", draft.status])
            created.status = draft.status
          }

          createdIssue = {
            ...created,
            title,
            description: draft.description,
            status: draft.status,
            priority: draft.priority,
            issue_type: draft.issueType,
          }
          return true
        }

        const updateArgs = buildIssueUpdateArgs(createdIssue, {
          title,
          description: draft.description,
          status: draft.status,
          priority: draft.priority,
          issueType: draft.issueType,
        })

        if (updateArgs.length === 0) return false

        await updateIssue(createdIssue.id, updateArgs)
        createdIssue = {
          ...createdIssue,
          title,
          description: draft.description,
          status: draft.status,
          priority: draft.priority,
          issue_type: draft.issueType,
        }
        return true
      },
    })

    return createdIssue
  }

  async function browseIssues(ctx: ExtensionCommandContext, mode: ListMode): Promise<void> {
    const modeTitle = "Tasks"
    const modeSubtitle = MODE_SUBTITLES[mode]

    try {
      ctx.ui.setStatus("tasks", "Loading…")
      const issues = await listIssues(mode)
      ctx.ui.setStatus("tasks", undefined)

      await showIssueList(ctx, {
        title: modeTitle,
        subtitle: modeSubtitle,
        issues,
        ctrlQ: CTRL_Q,
        ctrlF: CTRL_F,
        cycleStatus,
        cycleIssueType,
        onUpdateIssue: updateIssue,
        onWork: (issue) => pi.sendUserMessage(buildWorkPrompt(issue)),
        onReference: (issue) => ctx.ui.pasteToEditor(`${serializeReference(issue)} `),
        onEdit: (id, issue) => editIssue(ctx, id, issue),
        onCreate: () => createIssue(ctx),
      })
    } catch (e) {
      ctx.ui.setStatus("tasks", undefined)
      ctx.ui.notify(e instanceof Error ? e.message : String(e), "error")
    }
  }

  pi.registerCommand("tasks", {
    description: "Browse and edit tasks",
    handler: async (rawArgs, ctx) => {
      if (!ctx.hasUI) return
      const args = (rawArgs || "").trim()
      if (args.length > 0 && isLikelyIssueId(args)) {
        try {
          await editIssue(ctx, args)
        } catch (e) {
          ctx.ui.notify(e instanceof Error ? e.message : String(e), "error")
        }
        return
      }
      await browseIssues(ctx, parseListMode(args))
    },
  })

  pi.registerShortcut("ctrl+q", {
    description: "Open task list",
    handler: async (ctx) => {
      if (!ctx.hasUI) return
      await browseIssues(ctx as ExtensionCommandContext, "ready")
    },
  })
}
