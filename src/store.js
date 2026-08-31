// All board operations. Every write goes through here, with the acting agent known,
// so the human-in-the-loop rules that need to know *who* acts are enforced here.
// Rules that don't need the actor live as triggers in db.js.

import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { THREAD_KINDS, THREAD_STATUSES, TASK_STATUSES, VERDICTS, SYSTEM_AGENT } from './db.js';

export class BoardError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; this.extra = extra; }
}

const now = () => new Date().toISOString();
const hoursFromNow = (h) => new Date(Date.now() + h * 3600_000).toISOString();
const GENESIS = 'genesis';

export class Store {
  constructor(db) {
    this.db = db;
    this.bus = new EventEmitter();
    this.bus.setMaxListeners(1000);
  }

  // ---------- helpers ----------
  emit(type, payload) { this.bus.emit('change', { type, at: now(), ...payload }); }

  event(kind, { agentId = null, projectId = null, threadId = null, data = {} } = {}) {
    this.db.prepare(`INSERT INTO events (at, kind, agent_id, project_id, thread_id, data) VALUES (?,?,?,?,?,?)`)
      .run(now(), kind, agentId, projectId, threadId, JSON.stringify(data));
    this.emit('event', { kind, agentId, projectId, threadId, data });
  }

  // ---------- agents ----------
  human() { return this.db.prepare(`SELECT * FROM agents WHERE role = 'human'`).get(); }
  getAgent(nameOrId) {
    return typeof nameOrId === 'number'
      ? this.db.prepare(`SELECT * FROM agents WHERE id = ?`).get(nameOrId)
      : this.db.prepare(`SELECT * FROM agents WHERE name = ?`).get(String(nameOrId));
  }
  listAgents() { return this.db.prepare(`SELECT * FROM agents ORDER BY role DESC, name`).all(); }

  /** Get-or-create an *agent* identity. Never creates or returns the human. */
  ensureAgent(name, provider = null) {
    name = String(name || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(name)) throw new BoardError('bad_agent', `invalid agent name "${name}" (use a-z 0-9 . _ -)`);
    const existing = this.getAgent(name);
    if (existing?.role === 'human') throw new BoardError('forbidden', `"${name}" is the human account; agents cannot act as the human`);
    if (existing?.provider === 'system' || name === SYSTEM_AGENT) throw new BoardError('forbidden', `"${name}" is reserved for the board's own system messages`);
    if (existing) {
      this.db.prepare(`UPDATE agents SET last_seen_at = ?, provider = COALESCE(?, provider) WHERE id = ?`).run(now(), provider, existing.id);
      return { ...existing, last_seen_at: now() };
    }
    this.db.prepare(`INSERT INTO agents (name, provider, role, created_at, last_seen_at) VALUES (?,?,'agent',?,?)`).run(name, provider, now(), now());
    const agent = this.getAgent(name);
    this.event('agent.created', { agentId: agent.id, data: { name, provider } });
    return agent;
  }

  pauseAgent(actor, agentId, reason) {
    this.requireHuman(actor, 'pause or resume an agent');
    const target = this.getAgent(agentId);
    if (!target) throw new BoardError('not_found', 'agent not found');
    this.db.prepare(`UPDATE agents SET paused_reason = ? WHERE id = ?`).run(reason ?? null, target.id);
    this.event(reason ? 'agent.paused' : 'agent.resumed', { agentId: target.id, data: { by: actor.name, reason } });
  }

  requireHuman(actor, what) {
    if (actor?.role !== 'human') throw new BoardError('human_only', `only the human can ${what}`);
  }

  // ---------- projects ----------
  listProjects() {
    return this.db.prepare(`
      SELECT p.*,
        (SELECT count(*) FROM threads t WHERE t.project_id = p.id AND t.status = 'awaiting_human') AS awaiting_human,
        (SELECT count(*) FROM threads t WHERE t.project_id = p.id AND t.status IN ('open','awaiting_human','changes_requested')) AS open_threads,
        (SELECT max(id) FROM messages m WHERE m.project_id = p.id) AS last_message_id
      FROM projects p ORDER BY archived, name`).all();
  }
  getProject(nameOrId) {
    return typeof nameOrId === 'number'
      ? this.db.prepare(`SELECT * FROM projects WHERE id = ?`).get(nameOrId)
      : this.db.prepare(`SELECT * FROM projects WHERE name = ?`).get(String(nameOrId));
  }
  ensureProject(name, path = null, actor = null) {
    name = String(name || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) throw new BoardError('bad_project', `invalid project name "${name}"`);
    let p = this.getProject(name);
    if (p) {
      if (path && !p.path) { this.db.prepare(`UPDATE projects SET path = ? WHERE id = ?`).run(path, p.id); p = this.getProject(name); }
      return p;
    }
    this.db.prepare(`INSERT INTO projects (name, path, created_at) VALUES (?,?,?)`).run(name, path, now());
    p = this.getProject(name);
    this.event('project.created', { projectId: p.id, agentId: actor?.id ?? null, data: { name, path } });
    return p;
  }
  archiveProject(actor, projectId, archived = true) {
    this.requireHuman(actor, 'archive a project');
    this.db.prepare(`UPDATE projects SET archived = ? WHERE id = ?`).run(archived ? 1 : 0, projectId);
    this.event(archived ? 'project.archived' : 'project.unarchived', { projectId, agentId: actor.id });
  }

  join(agent, project) {
    const m = this.db.prepare(`SELECT * FROM memberships WHERE agent_id = ? AND project_id = ?`).get(agent.id, project.id);
    if (m) {
      this.db.prepare(`UPDATE memberships SET last_seen_at = ? WHERE agent_id = ? AND project_id = ?`).run(now(), agent.id, project.id);
      return m;
    }
    // New member: start reading from now, not from the beginning of time.
    const last = this.db.prepare(`SELECT COALESCE(max(id),0) AS id FROM messages WHERE project_id = ?`).get(project.id).id;
    this.db.prepare(`INSERT INTO memberships (agent_id, project_id, last_read_message_id, joined_at, last_seen_at) VALUES (?,?,?,?,?)`)
      .run(agent.id, project.id, last, now(), now());
    this.event('agent.joined', { agentId: agent.id, projectId: project.id, data: { agent: agent.name } });
    return this.db.prepare(`SELECT * FROM memberships WHERE agent_id = ? AND project_id = ?`).get(agent.id, project.id);
  }
  members(projectId) {
    return this.db.prepare(`
      SELECT a.id, a.name, a.provider, a.role, a.paused_reason, m.joined_at, m.last_seen_at, m.last_read_message_id
      FROM memberships m JOIN agents a ON a.id = m.agent_id WHERE m.project_id = ? ORDER BY m.last_seen_at DESC`).all(projectId);
  }

  // ---------- threads ----------
  getThread(id) {
    return this.db.prepare(`
      SELECT t.*, a.name AS created_by_name, p.name AS project_name,
        (SELECT count(*) FROM messages m WHERE m.thread_id = t.id) AS message_count
      FROM threads t JOIN agents a ON a.id = t.created_by JOIN projects p ON p.id = t.project_id WHERE t.id = ?`).get(id);
  }
  listThreads(projectId, { status = null, kind = null, limit = 50 } = {}) {
    const where = ['t.project_id = ?']; const args = [projectId];
    if (status === 'all') status = null;
    if (status === 'active') where.push(`t.status IN ('open','awaiting_human','changes_requested')`);
    else if (status) { where.push('t.status = ?'); args.push(status); }
    if (kind) { where.push('t.kind = ?'); args.push(kind); }
    args.push(limit);
    return this.db.prepare(`
      SELECT t.*, a.name AS created_by_name,
        (SELECT count(*) FROM messages m WHERE m.thread_id = t.id) AS message_count,
        (SELECT max(m.id) FROM messages m WHERE m.thread_id = t.id) AS last_message_id
      FROM threads t JOIN agents a ON a.id = t.created_by
      WHERE ${where.join(' AND ')} ORDER BY t.updated_at DESC LIMIT ?`).all(...args);
  }
  threadMessages(threadId, sinceId = 0, limit = 500) {
    return this.db.prepare(`
      SELECT m.id, m.thread_id, m.author_id, a.name AS author, a.role AS author_role, m.body, m.verdict, m.mentions, m.kind, m.created_at
      FROM messages m JOIN agents a ON a.id = m.author_id
      WHERE m.thread_id = ? AND m.id > ? ORDER BY m.id LIMIT ?`).all(threadId, sinceId, limit)
      .map(m => ({ ...m, mentions: JSON.parse(m.mentions) }));
  }

  /** Project-wide feed (for the human UI/hooks): messages after sinceId. */
  messagesSince(projectId, sinceId = 0, limit = 50) {
    return this.db.prepare(`
      SELECT m.id, m.thread_id, t.title, t.kind, a.name AS author, a.role AS author_role, m.body, m.verdict, m.created_at
      FROM messages m JOIN agents a ON a.id = m.author_id JOIN threads t ON t.id = m.thread_id
      WHERE m.project_id = ? AND m.id > ? ORDER BY m.id LIMIT ?`).all(projectId, sinceId, limit);
  }

  createThread(actor, { projectId, kind, title, body, ref = null, needsHuman = false, mentions = [] }) {
    if (!THREAD_KINDS.includes(kind)) throw new BoardError('bad_kind', `kind must be one of ${THREAD_KINDS.join(', ')}`);
    if (!title?.trim()) throw new BoardError('bad_input', 'title is required');
    this.assertCanAct(actor, projectId);
    // Critical decisions and changes to the board itself always wait for the human.
    if (kind === 'decision' || kind === 'board-change') needsHuman = true;
    const status = needsHuman ? 'awaiting_human' : 'open';
    const t = now();
    const tx = this.db.prepare(`INSERT INTO threads (project_id, kind, title, ref, created_by, needs_human, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`);
    this.db.exec('BEGIN');
    let threadId;
    try {
      threadId = Number(tx.run(projectId, kind, title.trim(), ref, actor.id, needsHuman ? 1 : 0, status, t, t).lastInsertRowid);
      if (body?.trim()) this.insertMessage({ threadId, projectId, author: actor, body, mentions });
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.event('thread.created', { agentId: actor.id, projectId, threadId, data: { kind, title, needs_human: needsHuman } });
    this.emit('thread', { projectId, threadId });
    return this.getThread(threadId);
  }

  /** The per-agent, per-project journal thread (kind=status) used for progress notes. */
  journalThread(agent, projectId) {
    const title = `${agent.name} — journal`;
    const t = this.db.prepare(`SELECT id FROM threads WHERE project_id = ? AND kind = 'status' AND created_by = ? AND title = ?`).get(projectId, agent.id, title);
    if (t) return this.getThread(t.id);
    return this.createThread(agent, { projectId, kind: 'status', title, body: null });
  }

  assertCanAct(actor, projectId, thread = null) {
    if (!actor) throw new BoardError('unauthenticated', 'unknown actor');
    if (actor.role === 'human') return;
    const fresh = this.getAgent(actor.id);
    if (fresh?.paused_reason) throw new BoardError('paused', `you are paused by the human: ${fresh.paused_reason}. Wait until the human resumes you.`);
    if (thread?.paused_reason) throw new BoardError('paused', `this thread is paused by the human: ${thread.paused_reason}`);
    const p = this.getProject(projectId);
    if (!p) throw new BoardError('not_found', 'project not found');
    if (p.archived) throw new BoardError('archived', 'project is archived');
  }

  insertMessage({ threadId, projectId, author, body, verdict = null, mentions = [], kind = 'message' }) {
    const all = new Set(mentions.map(s => String(s).replace(/^@/, '').toLowerCase()));
    for (const m of body.matchAll(/(^|[\s(])@([a-z0-9][a-z0-9._-]*)/gi)) all.add(m[2].toLowerCase());
    const prev = this.db.prepare(`SELECT id, hash FROM messages ORDER BY id DESC LIMIT 1`).get();
    const id = (prev?.id ?? 0) + 1;
    const prevHash = prev?.hash ?? GENESIS;
    const createdAt = now();
    const mentionsJson = JSON.stringify([...all]);
    const hash = messageHash({ id, threadId, projectId, authorId: author.id, body, verdict, mentions: mentionsJson, kind, createdAt, prevHash });
    this.db.prepare(`INSERT INTO messages (id, thread_id, project_id, author_id, body, verdict, mentions, kind, prev_hash, hash, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, threadId, projectId, author.id, body, verdict, mentionsJson, kind, prevHash, hash, createdAt);
    this.db.prepare(`UPDATE threads SET updated_at = ? WHERE id = ?`).run(createdAt, threadId);
    return id;
  }

  post(actor, { threadId, body, verdict = null, mentions = [] }) {
    const thread = this.getThread(threadId);
    if (!thread) throw new BoardError('not_found', `thread ${threadId} not found`);
    if (!body?.trim()) throw new BoardError('bad_input', 'body is required');
    if (verdict && !VERDICTS.includes(verdict)) throw new BoardError('bad_input', `verdict must be one of ${VERDICTS.join(', ')}`);
    this.assertCanAct(actor, thread.project_id, thread);

    let newStatus = null, advisory = false;
    if (verdict) {
      const target = { approve: 'approved', request_changes: 'changes_requested', reject: 'rejected' }[verdict];
      if (thread.needs_human && actor.role !== 'human') advisory = true; // recorded as an opinion, does not decide
      else newStatus = target;
    }
    this.db.exec('BEGIN');
    let id;
    try {
      id = this.insertMessage({ threadId, projectId: thread.project_id, author: actor, body, verdict, mentions });
      if (newStatus) this.db.prepare(`UPDATE threads SET status = ?, updated_at = ? WHERE id = ?`).run(newStatus, now(), threadId);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    if (actor.role !== 'human') this.markRead(actor, thread.project_id, id); // your own post is read
    if (newStatus) this.event('thread.status', { agentId: actor.id, projectId: thread.project_id, threadId, data: { status: newStatus, via: 'verdict' } });
    this.emit('message', { projectId: thread.project_id, threadId, messageId: id, authorId: actor.id, authorRole: actor.role });
    return { id, status: newStatus ?? thread.status, advisory };
  }

  setThreadStatus(actor, threadId, status, note = null) {
    if (!THREAD_STATUSES.includes(status)) throw new BoardError('bad_input', `status must be one of ${THREAD_STATUSES.join(', ')}`);
    const thread = this.getThread(threadId);
    if (!thread) throw new BoardError('not_found', 'thread not found');
    this.assertCanAct(actor, thread.project_id, thread);
    if (actor.role !== 'human') {
      if (thread.needs_human) throw new BoardError('human_only', 'this thread requires a human decision; agents may only comment (optionally with an advisory verdict)');
      if (!['open', 'resolved'].includes(status)) throw new BoardError('human_only', 'agents can only resolve or reopen threads; use a verdict on a review to approve/request changes');
    }
    this.db.exec('BEGIN');
    try {
      if (note?.trim()) this.insertMessage({ threadId, projectId: thread.project_id, author: actor, body: note });
      this.db.prepare(`UPDATE threads SET status = ?, updated_at = ? WHERE id = ?`).run(status, now(), threadId);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.event('thread.status', { agentId: actor.id, projectId: thread.project_id, threadId, data: { status, by: actor.name } });
    this.emit('thread', { projectId: thread.project_id, threadId });
    return this.getThread(threadId);
  }

  pauseThread(actor, threadId, reason) {
    this.requireHuman(actor, 'pause or resume a thread');
    const thread = this.getThread(threadId);
    if (!thread) throw new BoardError('not_found', 'thread not found');
    this.db.prepare(`UPDATE threads SET paused_reason = ?, updated_at = ? WHERE id = ?`).run(reason ?? null, now(), threadId);
    this.event(reason ? 'thread.paused' : 'thread.resumed', { agentId: actor.id, projectId: thread.project_id, threadId, data: { reason } });
    this.emit('thread', { projectId: thread.project_id, threadId });
  }

  // ---------- inbox ----------
  markRead(agent, projectId, upToId) {
    this.db.prepare(`UPDATE memberships SET last_read_message_id = max(last_read_message_id, ?), last_seen_at = ? WHERE agent_id = ? AND project_id = ?`)
      .run(upToId, now(), agent.id, projectId);
  }

  /** Unread messages for an agent in a project, grouped by thread. Agents see *everything* posted in their project. */
  inbox(agent, projectId, { peek = false, limit = 100 } = {}) {
    const m = this.db.prepare(`SELECT last_read_message_id FROM memberships WHERE agent_id = ? AND project_id = ?`).get(agent.id, projectId);
    const since = m?.last_read_message_id ?? 0;
    const rows = this.db.prepare(`
      SELECT m.id, m.thread_id, m.body, m.verdict, m.mentions, m.created_at, a.name AS author, a.role AS author_role,
             t.title, t.kind, t.status, t.needs_human
      FROM messages m JOIN agents a ON a.id = m.author_id JOIN threads t ON t.id = m.thread_id
      WHERE m.project_id = ? AND m.id > ? AND m.author_id <> ? ORDER BY m.id LIMIT ?`).all(projectId, since, agent.id, limit + 1);
    const truncated = rows.length > limit;
    if (truncated) rows.pop();
    const threads = new Map();
    for (const r of rows) {
      const mentions = JSON.parse(r.mentions);
      const mentioned = mentions.includes(agent.name) || mentions.includes('all') || mentions.includes('everyone');
      if (!threads.has(r.thread_id)) threads.set(r.thread_id, { thread_id: r.thread_id, title: r.title, kind: r.kind, status: r.status, mentions_you: false, from_human: false, messages: [] });
      const t = threads.get(r.thread_id);
      t.mentions_you ||= mentioned; t.from_human ||= r.author_role === 'human';
      t.messages.push({ id: r.id, author: r.author, author_role: r.author_role, body: r.body, verdict: r.verdict, mentioned, created_at: r.created_at });
    }
    const maxId = rows.length ? rows[rows.length - 1].id : since;
    if (!peek && rows.length) this.markRead(agent, projectId, maxId);
    const list = [...threads.values()].sort((a, b) => (b.from_human - a.from_human) || (b.mentions_you - a.mentions_you));
    return { unread: rows.length, truncated, threads: list };
  }

  unreadCount(agent, projectId) {
    const m = this.db.prepare(`SELECT last_read_message_id FROM memberships WHERE agent_id = ? AND project_id = ?`).get(agent.id, projectId);
    return this.db.prepare(`SELECT count(*) AS n FROM messages WHERE project_id = ? AND id > ? AND author_id <> ?`).get(projectId, m?.last_read_message_id ?? 0, agent.id).n;
  }

  waitForInbox(agent, projectId, timeoutMs) {
    if (this.unreadCount(agent, projectId) > 0) return Promise.resolve(true);
    return new Promise(resolve => {
      const onChange = (ev) => {
        if (ev.type === 'message' && ev.projectId === projectId && ev.authorId !== agent.id) done(true);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      const done = (v) => { clearTimeout(timer); this.bus.off('change', onChange); resolve(v); };
      this.bus.on('change', onChange);
    });
  }

  // ---------- tasks ----------
  listTasks(projectId, status = null) {
    const args = [projectId]; let w = 'tk.project_id = ?';
    if (status) { w += ' AND tk.status = ?'; args.push(status); }
    return this.db.prepare(`
      SELECT tk.*, o.name AS owner, c.name AS created_by_name FROM tasks tk
      LEFT JOIN agents o ON o.id = tk.owner_id JOIN agents c ON c.id = tk.created_by
      WHERE ${w} ORDER BY CASE tk.status WHEN 'doing' THEN 0 WHEN 'blocked' THEN 1 WHEN 'todo' THEN 2 ELSE 3 END, tk.updated_at DESC`).all(...args);
  }
  upsertTask(actor, projectId, { id = null, title, description = null, status = null, owner = null, threadId = null }) {
    this.assertCanAct(actor, projectId);
    if (status && !TASK_STATUSES.includes(status)) throw new BoardError('bad_input', `status must be one of ${TASK_STATUSES.join(', ')}`);
    let ownerId = null;
    if (owner === 'me') ownerId = actor.id;
    else if (owner) { const a = this.getAgent(owner); if (!a) throw new BoardError('not_found', `agent ${owner} not found`); ownerId = a.id; }
    const t = now();
    if (id) {
      const cur = this.db.prepare(`SELECT * FROM tasks WHERE id = ? AND project_id = ?`).get(id, projectId);
      if (!cur) throw new BoardError('not_found', 'task not found');
      this.db.prepare(`UPDATE tasks SET title = COALESCE(?, title), description = COALESCE(?, description), status = COALESCE(?, status), owner_id = COALESCE(?, owner_id), thread_id = COALESCE(?, thread_id), updated_at = ? WHERE id = ?`)
        .run(title ?? null, description, status, ownerId, threadId, t, id);
    } else {
      if (!title?.trim()) throw new BoardError('bad_input', 'title is required');
      id = Number(this.db.prepare(`INSERT INTO tasks (project_id, title, description, status, owner_id, thread_id, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(projectId, title.trim(), description, status ?? 'todo', ownerId, threadId, actor.id, t, t).lastInsertRowid);
    }
    this.event('task.upserted', { agentId: actor.id, projectId, data: { id, title, status, owner } });
    this.emit('task', { projectId, taskId: id });
    return this.db.prepare(`SELECT tk.*, o.name AS owner FROM tasks tk LEFT JOIN agents o ON o.id = tk.owner_id WHERE tk.id = ?`).get(id);
  }

  // ---------- claims (advisory locks on paths, for parallel work) ----------
  activeClaims(projectId) {
    return this.db.prepare(`
      SELECT c.*, a.name AS agent FROM claims c JOIN agents a ON a.id = c.agent_id
      WHERE c.project_id = ? AND c.released_at IS NULL AND c.expires_at > ? ORDER BY c.created_at`).all(projectId, now());
  }
  claim(actor, projectId, paths, { note = null, taskId = null, hours = 4, force = false } = {}) {
    this.assertCanAct(actor, projectId);
    paths = [...new Set(paths.map(normPath).filter(Boolean))];
    if (!paths.length) throw new BoardError('bad_input', 'at least one path is required');
    const conflicts = [];
    for (const c of this.activeClaims(projectId)) {
      if (c.agent_id === actor.id) continue;
      for (const p of paths) if (overlaps(p, c.path)) conflicts.push({ path: p, held_by: c.agent, their_path: c.path, note: c.note, expires_at: c.expires_at });
    }
    if (conflicts.length && !force) {
      throw new BoardError('conflict', 'some paths are already claimed by another agent; coordinate with them on the board first (or pass force=true and say why)', { conflicts });
    }
    const t = now(), exp = hoursFromNow(Math.min(Math.max(hours, 0.1), 48));
    const ins = this.db.prepare(`INSERT INTO claims (project_id, agent_id, path, note, task_id, created_at, expires_at) VALUES (?,?,?,?,?,?,?)`);
    // Re-claiming your own path refreshes it.
    const rel = this.db.prepare(`UPDATE claims SET released_at = ? WHERE project_id = ? AND agent_id = ? AND path = ? AND released_at IS NULL`);
    for (const p of paths) { rel.run(t, projectId, actor.id, p); ins.run(projectId, actor.id, p, note, taskId, t, exp); }
    this.event('claim.added', { agentId: actor.id, projectId, data: { paths, note, forced: force && conflicts.length > 0, conflicts } });
    this.emit('claim', { projectId });
    return { claimed: paths, expires_at: exp, conflicts };
  }
  release(actor, projectId, paths = null) {
    const t = now();
    if (paths?.length) {
      const st = this.db.prepare(`UPDATE claims SET released_at = ? WHERE project_id = ? AND agent_id = ? AND path = ? AND released_at IS NULL`);
      for (const p of paths.map(normPath)) st.run(t, projectId, actor.id, p);
    } else {
      this.db.prepare(`UPDATE claims SET released_at = ? WHERE project_id = ? AND agent_id = ? AND released_at IS NULL`).run(t, projectId, actor.id);
    }
    this.event('claim.released', { agentId: actor.id, projectId, data: { paths: paths ?? 'all' } });
    this.emit('claim', { projectId });
  }

  // ---------- system messages (board updates) ----------
  systemAgent() { return this.getAgent(SYSTEM_AGENT); }
  getMeta(key) { return this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key)?.value ?? null; }
  setMeta(key, value) { this.db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value)); }

  /** Post a system message in a project's "Board updates" thread (created on demand). */
  systemPost(projectId, body) {
    const sys = this.systemAgent();
    let t = this.db.prepare(`SELECT id FROM threads WHERE project_id = ? AND kind = 'status' AND created_by = ? AND title = 'Board updates'`).get(projectId, sys.id);
    const now_ = now();
    this.db.exec('BEGIN');
    let id;
    try {
      if (!t) {
        const r = this.db.prepare(`INSERT INTO threads (project_id, kind, title, created_by, needs_human, status, created_at, updated_at) VALUES (?, 'status', 'Board updates', ?, 0, 'open', ?, ?)`).run(projectId, sys.id, now_, now_);
        t = { id: Number(r.lastInsertRowid) };
      }
      id = this.insertMessage({ threadId: t.id, projectId, author: sys, body, kind: 'system' });
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.emit('message', { projectId, threadId: t.id, messageId: id, authorId: sys.id, authorRole: 'agent' });
    return { thread_id: t.id, id };
  }
  /** Same message in every non-archived project. */
  announceAll(body) {
    const posted = [];
    for (const p of this.listProjects()) if (!p.archived) posted.push({ project: p.name, ...this.systemPost(p.id, body) });
    this.event('board.announce', { data: { body: body.slice(0, 200), projects: posted.length } });
    return posted;
  }
  /** Called at startup: if the board version changed since last run, tell every project what is new. */
  recordVersion(version, changelogSince) {
    const prev = this.getMeta('board_version');
    if (prev === version) return { changed: false, version };
    this.setMeta('board_version', version);
    if (prev !== null) {
      const notes = changelogSince(prev) || '(no changelog entry)';
      this.announceAll(`Board updated: ${prev} → ${version}. Your MCP session was reset by the restart: if board tools are missing or stale, reconnect (Claude Code: /mcp) and call board_join again — its reply carries a "whats_new" field.\n\nWhat changed:\n${notes}`);
    }
    return { changed: true, version, previous: prev };
  }
  /** What an agent has not seen yet; marks the version as seen. */
  whatsNewFor(agent, version, changelogSince) {
    const seen = this.getAgent(agent.id)?.last_board_version ?? null;
    if (seen === version) return null;
    this.db.prepare(`UPDATE agents SET last_board_version = ? WHERE id = ?`).run(version, agent.id);
    if (seen === null) return null; // first visit ever: nothing to diff against
    return { since: seen, now: version, notes: changelogSince(seen) || '(no changelog entry)' };
  }

  // ---------- audit ----------
  listEvents(projectId = null, limit = 100) {
    const args = []; let w = '1=1';
    if (projectId) { w = 'e.project_id = ?'; args.push(projectId); }
    args.push(limit);
    return this.db.prepare(`SELECT e.*, a.name AS agent FROM events e LEFT JOIN agents a ON a.id = e.agent_id WHERE ${w} ORDER BY e.id DESC LIMIT ?`).all(...args)
      .map(e => ({ ...e, data: JSON.parse(e.data) }));
  }

  /** Walk the hash chain. Detects any out-of-band edit of the message log. */
  verifyChain() {
    const rows = this.db.prepare(`SELECT * FROM messages ORDER BY id`).all();
    let prevHash = GENESIS, prevId = 0;
    for (const m of rows) {
      const expected = messageHash({ id: m.id, threadId: m.thread_id, projectId: m.project_id, authorId: m.author_id, body: m.body, verdict: m.verdict, mentions: m.mentions, kind: m.kind, createdAt: m.created_at, prevHash });
      if (m.prev_hash !== prevHash || m.hash !== expected || m.id !== prevId + 1) return { ok: false, checked: rows.length, broken_at: m.id };
      prevHash = m.hash; prevId = m.id;
    }
    return { ok: true, checked: rows.length };
  }
}

export function messageHash(f) {
  return createHash('sha256').update(JSON.stringify([f.id, f.threadId, f.projectId, f.authorId, f.body, f.verdict ?? null, f.mentions, f.kind, f.createdAt, f.prevHash])).digest('hex');
}

export function normPath(p) {
  return String(p ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}
export function overlaps(a, b) {
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/') || a === '' || b === '';
}
