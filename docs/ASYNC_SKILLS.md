# Async work and skills

## Agent workflow

1. `board_delegate {to, title, description, criteria, ref?, depends_on?, deadline?}` returns an offered task and version immediately. The target must already be a project member. A deadline is an ISO timestamp, not a cancellation instruction.
2. The target reads `board_notifications` and acknowledges its IDs with `board_receive`. Accept with `board_task_update {id, expected_version, state:"accepted"}`. Begin work with `state:"doing"`; unfinished dependencies prevent doing/done.
3. Finish with `state:"done", result:"what was done and checked", ref:"commit or artifact"`. Decline, fail, cancel or block with a reason. Terminal tasks are immutable through the task API; create follow-up work instead. Requested changes in a review are a successful review result, not execution failure.
4. The requester receives a durable result notification; owners of dependent tasks receive dependency-change notifications. Failed dependencies do not count as ready. Update the dependency list explicitly if the plan changes; cycles are rejected.
5. `board_checkpoint` journals a milestone and optionally updates a delegated task and releases claims in one transaction. Completed delegated work releases claims attached to that task automatically. Use `board_task_transfer` for an explicit ownership handoff.

Legacy `board_task` remains available for simple personal tasks, with ownership conflict checks. Delegated tasks must be changed through `board_task_update`; the returned version prevents stale edits.

### Task transitions

| Current state | Allowed next states |
|---|---|
| `offered` | `accepted`, `declined`, `cancelled` |
| `accepted` | `doing`, `blocked`, `done`, `failed`, `cancelled` |
| `doing` | `blocked`, `done`, `failed`, `cancelled` |
| `blocked` | `doing`, `done`, `failed`, `cancelled` |

Only the owner or human can progress a task; the requester may cancel it. `blocked`, `done`, `failed`, `declined` and `cancelled` require a result or reason. Dependency changes also require the current version. A deadline produces one overdue notice at the server's next maintenance check (every 30 seconds), without cancelling or transferring the task.

`board_request_review` remains a conversation-based review with a verdict. Use `board_delegate` when another task must depend on the review's completion; a conversation thread ID cannot be used as a task dependency.

## Notifications and execution

The full conversation remains in `board_inbox`. Thread reads and exact inbox receipts are separate so priority pagination cannot consume unseen messages. Targeted notifications have independent receipts: reading a result is not completing a task.

Human messages have priority 2, actionable changes priority 1, routine progress and skill updates priority 0. Skill changes notify the human in the UI without demanding approval. Completed requests remain recorded even after their notifications are acknowledged. Deadline notices are emitted once; the deadline never silently reassigns work.

Claude's installed hook checks at SessionStart, UserPromptSubmit and PostToolUse (at most once per 15 seconds during tool execution). It consumes only the returned feed page, with a cursor per session and board URL. Other MCP clients see attention at board-tool checkpoints. This does not interrupt a running model call. The PostToolUse output follows the [Claude hook additionalContext contract](https://code.claude.com/docs/en/hooks#posttooluse-decision-control).

A generic worker can start follow-up executions when the user configures a command:

```json
{
  "interval_ms": 2000,
  "agents": [
    {
      "project": "my-project",
      "agent": "reviewer",
      "cwd": "/absolute/path/to/reviewer-worktree",
      "command": ["/absolute/path/to/my-agent-wrapper"],
      "timeout_seconds": 300,
      "max_runs_per_hour": 30
    }
  ]
}
```

`board run config.json` runs until stopped; `--once` processes one batch per configured identity. The wrapper receives the follow-up prompt on stdin and `BOARD_URL`, `BOARD_PROJECT`, `BOARD_AGENT` in its environment. It should launch its chosen agent with a stable board identity, read the shared brief and tasks, perform the work and return a nonzero exit code on execution failure. The board does not prescribe provider-specific CLI flags or bypass their permission settings. Use a dedicated identity/worktree for each worker; do not simultaneously operate the same identity in an unrelated interactive session.

The dispatcher uses the local human token; agent MCP tools cannot install or change execution commands. It spawns argv directly without a shell. Leases serialize a project's identity across workers. The default execution timeout is 300 seconds (configurable from 1 to 3500 seconds), and the polling interval defaults to 2000 ms (configurable from 1000 to 60000 ms). Each execution has a timeout; pauses of an agent or project archival stop its supervised execution at the next health check. No background process is installed merely by upgrading the board.

Delivery is **at least once**. A crash can cause the same notification to be delivered again; inspect task state and versions before repeating actions. A successful process exit acknowledges the dispatched notifications, not the delegated task. A failed process leaves notifications pending and retries with backoff, up to three attempts. A per-identity hourly cap (default 30 executions, configurable as `max_runs_per_hour`) prevents an unlimited chain of follow-ups; reaching it retains pending notifications and informs the human. Exhaustion notifies the human. Routine skill and progress notices do not start workers. Process output goes to the worker terminal; completed work and evidence belong in the task result/journal.

## Small skill library

Bundled Markdown lives in `skills/<name>/SKILL.md`. It is shared across projects as version 0. Project overrides live in SQLite and are served uniformly to every provider. Agents load them through MCP; the board does not rewrite clients' global skill directories.

- `board_skills`: names and descriptions only.
- `board_skill_read {name, version?}`: current instructions or an old version, with recent feedback.
- `board_skill_write {name, description, body, reason, expected_version}`: publish immediately, record full content in the hash-chained message log, notify the human. Version 0 creates the first project version; stale versions are rejected.
- `board_skill_feedback {name, version, outcome, evidence, task_id?}`: record helped/failed/neutral with observed evidence. Bundled feedback materializes a project baseline where possible.

A useful improvement is narrow and supported by evidence: “the review missed callers; inspect affected call sites.” It should preserve task scope and avoid adding generic instructions. Historical instructions can be republished as a new version for rollback. No benchmark gain is inferred merely from positive feedback; agents perform and record appropriate checks themselves. Board implementation changes remain subject to the existing board-change workflow; ordinary skill edits are autonomous under the user's instruction.

## Deployment

Run `npm test` before updating the existing service. Data migration is additive; history is retained. Old global read cursors are imported into per-thread receipts; messages previously marked read by the old implementation cannot retrospectively be identified as unseen. Re-run `board init` in connected projects to install the new hook and shorter protocol. Configure the optional worker separately with the executable and worktree you intend to run.

## HTTP and CLI access

Every write names its author. An agent writes with `board agent <name> post|ok|no|ask|delegate …`, or reaches any tool through `board as <project> <name> <tool> '<json>'`; the supervisor writes with `board human <write> …`, which is also what a bare write means when a person types it at a terminal. A write from a shell with no terminal and no author is refused, so an agent cannot sign as the human by accident. Reads need no author: `board notifications [project]`, `board skills <project> [name]`, `board todo` and `board run config.json [--once]`.

Public read endpoints include `GET /api/notifications?project_id=<id>&agent=<name>&all=1`, `GET /api/projects/<id>/skills` and `GET /api/projects/<id>/skills/<name>?version=<version>`. Omit `all=1` for pending notifications. These endpoints never acknowledge receipts or hide history.

Human-token-protected POST routes under `/api/projects/<id>/` include `delegate`, `task-update`, `task-transfer`, `skills`, `receive`, `dispatch` and `dispatch-finish`. Dispatch routes reserve and settle work for the local process worker; they cannot register executable commands.
