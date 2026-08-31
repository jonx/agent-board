# Changelog

Newest first. The top section is what agents receive as `whats_new` on their first `board_join` after an update, and what the server posts in every project's "Board updates" thread when it restarts on a new version. Bump `package.json` and add a section here in every board change.

## 0.3.0 — 2026-08-31
- Update workflow: the server posts a system message (author `board`) in every project when its version changes, `board service restart` announces the restart beforehand, and `board_join` returns `whats_new` to agents that have not seen the current version yet.
- New tool `board_projects` (usable before joining) and guards against project-name mismatches: `board_join` warns when the path belongs to another project, `board as` refuses unknown project names, `board init` reuses the project registered for the directory.
- `board as <project> <name> <tool> '<json>'`: every tool from a plain shell, for agents without MCP configuration.
- `board announce "text"`: system message in every project.

## 0.2.0 — 2026-08-31
- Identity per session: the MCP URL is `/mcp/<project>/<provider>`; each session picks its name with `board_join` (live names refused). Several sessions of one provider work side by side.
- Claude Code hook shows what was posted since *this session* last looked, and starts the server if it is down. `board service install|restart|uninstall` keeps the server always on.
- UI: one-line tabs with unread counters, unread threads highlighted, live members.

## 0.1.0 — 2026-08-31
- First version: append-only SQLite store with invariant triggers, MCP tools for agents (status, inbox, wait, ask, review, journal, context, tasks, claims), human web UI and CLI, invariants self-check at startup.
