// Schema + database-level invariants.
// Everything that protects the human's oversight lives here as SQLite triggers,
// so it holds no matter which code path (MCP, HTTP, CLI, a future feature) writes.
// See INVARIANTS.md. test/invariants.test.js and the startup self-check verify them.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const THREAD_KINDS = ['question', 'review', 'decision', 'status', 'board-change'];
export const THREAD_STATUSES = ['open', 'awaiting_human', 'approved', 'rejected', 'changes_requested', 'resolved'];
export const VERDICTS = ['approve', 'request_changes', 'reject'];
export const TASK_STATUSES = ['todo', 'doing', 'blocked', 'done'];
export const ACK_STATES = ['seen', 'working', 'done', 'blocked', 'declined'];
export const ACK_EMOJI = { seen: '\u{1F440}', working: '\u{1F527}', done: '\u2705', blocked: '\u26D4', declined: '\u{1F645}' };

// Column names that would let someone hide content. Their absence is an invariant.
export const FORBIDDEN_COLUMNS = ['private', 'hidden', 'visibility', 'secret', 'deleted', 'deleted_at', 'recipient_id', 'to_agent_id'];

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  path        TEXT,
  archived    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  provider      TEXT,
  role          TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('agent','human')),
  paused_reason TEXT,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT
);

CREATE TABLE IF NOT EXISTS memberships (
  agent_id             INTEGER NOT NULL REFERENCES agents(id),
  project_id           INTEGER NOT NULL REFERENCES projects(id),
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  joined_at            TEXT NOT NULL,
  last_seen_at         TEXT,
  PRIMARY KEY (agent_id, project_id)
);

CREATE TABLE IF NOT EXISTS threads (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id),
  kind          TEXT NOT NULL CHECK (kind IN ('question','review','decision','status','board-change')),
  title         TEXT NOT NULL,
  ref           TEXT,
  created_by    INTEGER NOT NULL REFERENCES agents(id),
  needs_human   INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','awaiting_human','approved','rejected','changes_requested','resolved')),
  paused_reason TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS threads_project ON threads(project_id, status);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY,
  thread_id   INTEGER NOT NULL REFERENCES threads(id),
  project_id  INTEGER NOT NULL REFERENCES projects(id),
  author_id   INTEGER NOT NULL REFERENCES agents(id),
  body        TEXT NOT NULL,
  verdict     TEXT CHECK (verdict IS NULL OR verdict IN ('approve','request_changes','reject')),
  mentions    TEXT NOT NULL DEFAULT '[]',
  kind        TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message','system')),
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_project ON messages(project_id, id);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, id);

CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id),
  title       TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','blocked','done')),
  owner_id    INTEGER REFERENCES agents(id),
  thread_id   INTEGER REFERENCES threads(id),
  created_by  INTEGER NOT NULL REFERENCES agents(id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claims (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id),
  agent_id    INTEGER NOT NULL REFERENCES agents(id),
  path        TEXT NOT NULL,
  note        TEXT,
  task_id     INTEGER REFERENCES tasks(id),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  released_at TEXT
);

-- Acknowledgements: a small closed vocabulary so an agent can say "seen / I am on it /
-- done / blocked / not me" without writing a message. Append-only like everything else;
-- the latest row per (thread, agent) is the current state. Rendered as emoji in the UI.
CREATE TABLE IF NOT EXISTS reactions (
  id         INTEGER PRIMARY KEY,
  thread_id  INTEGER NOT NULL REFERENCES threads(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  agent_id   INTEGER NOT NULL REFERENCES agents(id),
  state      TEXT NOT NULL CHECK (state IN ('seen','working','done','blocked','declined')),
  note       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reactions_thread ON reactions(thread_id, id);

-- Where the human has read up to, per thread. Their own bookkeeping: it hides nothing
-- (every message stays readable forever) and only the token-protected API can write it,
-- so no agent can mark things read on their behalf.
CREATE TABLE IF NOT EXISTS human_reads (
  thread_id            INTEGER PRIMARY KEY REFERENCES threads(id),
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  at                   TEXT NOT NULL
);

-- Key/value store for server state (e.g. last board version seen).
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Append-only audit of every non-message action (pause, approve, claim, join, ...).
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY,
  at          TEXT NOT NULL,
  kind        TEXT NOT NULL,
  agent_id    INTEGER REFERENCES agents(id),
  project_id  INTEGER REFERENCES projects(id),
  thread_id   INTEGER REFERENCES threads(id),
  data        TEXT NOT NULL DEFAULT '{}'
);

-- ===================== INVARIANT TRIGGERS =====================

-- I1. Messages are append-only. Nobody edits or deletes history.
CREATE TRIGGER IF NOT EXISTS inv_messages_no_update BEFORE UPDATE ON messages
BEGIN SELECT RAISE(ABORT, 'INVARIANT: messages are append-only (no update)'); END;
CREATE TRIGGER IF NOT EXISTS inv_messages_no_delete BEFORE DELETE ON messages
BEGIN SELECT RAISE(ABORT, 'INVARIANT: messages are append-only (no delete)'); END;

-- I2b. Acknowledgements are append-only too: a state is superseded by a newer row,
--      never edited away, so "I said I was on it" cannot be rewritten.
CREATE TRIGGER IF NOT EXISTS inv_reactions_no_update BEFORE UPDATE ON reactions
BEGIN SELECT RAISE(ABORT, 'INVARIANT: acknowledgements are append-only (no update)'); END;
CREATE TRIGGER IF NOT EXISTS inv_reactions_no_delete BEFORE DELETE ON reactions
BEGIN SELECT RAISE(ABORT, 'INVARIANT: acknowledgements are append-only (no delete)'); END;

-- I2. The audit log is append-only.
CREATE TRIGGER IF NOT EXISTS inv_events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'INVARIANT: events are append-only (no update)'); END;
CREATE TRIGGER IF NOT EXISTS inv_events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'INVARIANT: events are append-only (no delete)'); END;

-- I3. Threads and projects are never deleted (resolve / archive instead), so no
--     conversation can disappear from the human's view.
CREATE TRIGGER IF NOT EXISTS inv_threads_no_delete BEFORE DELETE ON threads
BEGIN SELECT RAISE(ABORT, 'INVARIANT: threads cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS inv_projects_no_delete BEFORE DELETE ON projects
BEGIN SELECT RAISE(ABORT, 'INVARIANT: projects cannot be deleted (archive instead)'); END;

-- I4. The human cannot be removed, demoted, paused, or duplicated.
CREATE TRIGGER IF NOT EXISTS inv_human_no_delete BEFORE DELETE ON agents WHEN OLD.role = 'human'
BEGIN SELECT RAISE(ABORT, 'INVARIANT: the human cannot be removed'); END;
CREATE TRIGGER IF NOT EXISTS inv_role_immutable BEFORE UPDATE OF role ON agents WHEN OLD.role <> NEW.role
BEGIN SELECT RAISE(ABORT, 'INVARIANT: agent roles are immutable'); END;
CREATE TRIGGER IF NOT EXISTS inv_human_no_pause BEFORE UPDATE OF paused_reason ON agents
  WHEN OLD.role = 'human' AND NEW.paused_reason IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'INVARIANT: the human cannot be paused'); END;
CREATE TRIGGER IF NOT EXISTS inv_single_human BEFORE INSERT ON agents
  WHEN NEW.role = 'human' AND (SELECT count(*) FROM agents WHERE role = 'human') > 0
BEGIN SELECT RAISE(ABORT, 'INVARIANT: only one human account exists; agents cannot create human accounts'); END;

-- I5. Human-gated threads can only leave awaiting_human by a human decision.
--     (Enforced in store.js where the actor is known; the trigger below guards the
--     one thing SQL can see: nobody flips needs_human off once set.)
CREATE TRIGGER IF NOT EXISTS inv_needs_human_sticky BEFORE UPDATE OF needs_human ON threads
  WHEN OLD.needs_human = 1 AND NEW.needs_human = 0
BEGIN SELECT RAISE(ABORT, 'INVARIANT: a thread that requires human approval keeps requiring it'); END;

-- I6. A thread paused by the human stays paused until the human lifts it (store.js
--     checks the actor); the trigger prevents silently moving a paused thread's project.
CREATE TRIGGER IF NOT EXISTS inv_thread_project_immutable BEFORE UPDATE OF project_id ON threads
BEGIN SELECT RAISE(ABORT, 'INVARIANT: threads cannot move between projects'); END;
`;

export function openDatabase(file = ':memory:') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  migrate(db);
  ensureHuman(db);
  ensureSystemAgent(db);
  return db;
}

// Additive migrations only (columns can be added, never removed or repurposed).
function migrate(db) {
  const cols = db.prepare(`PRAGMA table_info(agents)`).all().map(c => c.name);
  if (!cols.includes('last_board_version')) db.exec(`ALTER TABLE agents ADD COLUMN last_board_version TEXT`);
  // An identity can be retired (hidden from the lists) or merged into another (its name
  // resolves to the canonical agent from now on). Neither ever touches what was written:
  // past messages keep their original author for ever.
  if (!cols.includes('retired')) db.exec(`ALTER TABLE agents ADD COLUMN retired INTEGER NOT NULL DEFAULT 0`);
  if (!cols.includes('merged_into')) db.exec(`ALTER TABLE agents ADD COLUMN merged_into INTEGER REFERENCES agents(id)`);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS inv_human_not_retired BEFORE UPDATE OF retired ON agents
      WHEN OLD.role = 'human' AND NEW.retired = 1
    BEGIN SELECT RAISE(ABORT, 'INVARIANT: the human cannot be retired'); END;
    CREATE TRIGGER IF NOT EXISTS inv_human_not_merged BEFORE UPDATE OF merged_into ON agents
      WHEN OLD.role = 'human' AND NEW.merged_into IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'INVARIANT: the human cannot be merged away'); END;
    CREATE TRIGGER IF NOT EXISTS inv_no_self_merge BEFORE UPDATE OF merged_into ON agents
      WHEN NEW.merged_into = OLD.id
    BEGIN SELECT RAISE(ABORT, 'INVARIANT: an agent cannot be merged into itself'); END;
  `);
}

/** The reserved "board" account authors system messages (update notices). No session can join as it. */
export const SYSTEM_AGENT = 'board';
function ensureSystemAgent(db) {
  if (!db.prepare(`SELECT id FROM agents WHERE name = ?`).get(SYSTEM_AGENT)) {
    db.prepare(`INSERT INTO agents (name, provider, role, created_at) VALUES (?, 'system', 'agent', ?)`).run(SYSTEM_AGENT, new Date().toISOString());
  }
}

function ensureHuman(db) {
  const row = db.prepare(`SELECT id FROM agents WHERE role = 'human'`).get();
  if (!row) {
    db.prepare(`INSERT INTO agents (name, provider, role, created_at) VALUES ('human', 'human', 'human', ?)`)
      .run(new Date().toISOString());
  }
}
