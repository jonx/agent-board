// HTTP layer: MCP transport for agents, JSON API + SSE for the human UI/CLI, static UI.
// Binds to localhost only. Reads are open (the whole point is that the human can see
// everything); writes on /api require the human token (see server.js / INVARIANTS.md).

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMcpServer, CONTEXT_THREAD_TITLE } from './mcp.js';
import { attentionOf } from './store.js';
import { BoardError } from './store.js';

/** Live MCP sessions: which session holds which agent name. A name is "live" while its
 *  session made a request in the last SESSION_TTL ms; after that another session may take it. */
export class SessionRegistry {
  constructor(ttlMs = 10 * 60_000) { this.ttl = ttlMs; this.sessions = new Map(); }
  add(id, entry) { this.sessions.set(id, { ...entry, agentName: null, lastSeen: Date.now() }); }
  get(id) { return this.sessions.get(id); }
  touch(id) { const e = this.sessions.get(id); if (e) e.lastSeen = Date.now(); }
  remove(id) { this.sessions.delete(id); }
  bind(id, agentName) { const e = this.sessions.get(id); if (e) e.agentName = agentName; }
  holder(agentName) {
    for (const [id, e] of this.sessions) if (e.agentName === agentName && Date.now() - e.lastSeen < this.ttl) return id;
    return null;
  }
  sweep() { for (const [id, e] of this.sessions) if (Date.now() - e.lastSeen > this.ttl * 6) { e.transport?.close?.(); this.sessions.delete(id); } }
}

export function createHttpServer({ store, humanToken, uiFile, registry = new SessionRegistry() }) {
  const human = store.human();
  const sweeper = setInterval(() => registry.sweep(), 60_000); sweeper.unref();

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    try {
      // ---- MCP for agents: /mcp/<project>/<provider> ----
      const m = path.match(/^\/mcp\/([^/]+)\/([^/]+)\/?$/);
      if (m) return await handleMcp(req, res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
      if (path === '/mcp' || path === '/mcp/') return json(res, 400, { error: 'use /mcp/<project>/<provider>' });

      if (path === '/' || path === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(readFileSync(uiFile));
      }
      if (path === '/api/stream') return sse(req, res);
      if (path.startsWith('/api/')) return await api(req, res, url);
      json(res, 404, { error: 'not found' });
    } catch (e) {
      if (e instanceof BoardError) return json(res, e.code === 'human_only' || e.code === 'forbidden' ? 403 : e.code === 'not_found' ? 404 : e.code === 'conflict' ? 409 : 400, { error: e.code, message: e.message, ...e.extra });
      console.error(e);
      if (!res.headersSent) json(res, 500, { error: 'internal', message: e.message });
    }
  });

  async function handleMcp(req, res, projectName, provider) {
    const body = req.method === 'POST' ? await readJson(req) : undefined;
    const sid = req.headers['mcp-session-id'];
    const existing = sid ? registry.get(sid) : null;
    if (existing) {
      if (existing.projectName !== projectName || existing.provider !== provider) return json(res, 400, { error: 'session_mismatch', message: 'this session belongs to another project/provider URL' });
      registry.touch(sid);
      return existing.transport.handleRequest(req, res, body);
    }
    if (sid && !existing) return json(res, 404, { error: 'session_not_found', message: 'session expired or server restarted — re-initialize and board_join again' });
    if (req.method !== 'POST') return json(res, 405, { error: 'method', message: 'initialize first (POST)' });
    if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(provider)) return json(res, 400, { error: 'bad_provider', message: 'provider must be like claude, codex, gemini' });
    let project;
    try { project = store.ensureProject(projectName, null, null); } catch (e) { return json(res, 400, { error: e.code ?? 'bad_request', message: e.message }); }
    const ctx = { project, provider, sessionId: null, agent: null, registry };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => { ctx.sessionId = id; registry.add(id, { transport, projectName, provider }); },
    });
    transport.onclose = () => { if (ctx.sessionId) registry.remove(ctx.sessionId); };
    const server = buildMcpServer(store, ctx);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  function sse(req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`event: hello\ndata: {}\n\n`);
    const onChange = (ev) => res.write(`event: change\ndata: ${JSON.stringify(ev)}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    store.bus.on('change', onChange);
    req.on('close', () => { clearInterval(ping); store.bus.off('change', onChange); });
  }

  function requireHuman(req) {
    const auth = req.headers.authorization ?? '';
    const tok = auth.startsWith('Bearer ') ? auth.slice(7) : req.headers['x-board-token'];
    if (!humanToken || tok !== humanToken) throw new BoardError('forbidden', 'human token required for this action (see `board open` / ~/.agent-board/human.token)');
    return human;
  }

  async function api(req, res, url) {
    const p = url.pathname.replace(/\/$/, '');
    const q = url.searchParams;
    const seg = p.split('/').slice(2); // after /api
    const body = req.method === 'POST' ? (await readJson(req)) ?? {} : {};
    const id = (s) => { const n = Number(s); if (!Number.isInteger(n)) throw new BoardError('bad_input', 'bad id'); return n; };

    // ---- reads ----
    if (req.method === 'GET') {
      if (p === '/api/projects') return json(res, 200, store.listProjects());
      if (p === '/api/agents') return json(res, 200, store.listAgents());
      if (p === '/api/threads-index') return json(res, 200, store.threadsIndex());
      if (p === '/api/todo') { // everything that actually needs the human, across all projects
        const byProject = new Map(store.listProjects().map(pr => [pr.id, pr.name]));
        const items = store.threadsIndex().filter(t => t.attention !== 'ambient')
          .sort((a, b) => (a.attention === b.attention ? 0 : a.attention === 'action' ? -1 : 1) || (a.updated_at < b.updated_at ? 1 : -1));
        return json(res, 200, items.map(t => {
          const msgs = store.threadMessages(t.id);
          return { thread_id: t.id, project: byProject.get(t.project_id), kind: t.kind, title: t.title, status: t.status,
            attention: t.attention, paused: t.paused_reason ?? null, updated_at: t.updated_at,
            last: msgs.length ? { author: msgs.at(-1).author, body: msgs.at(-1).body } : null,
            asked_by: msgs.length ? msgs[0].author : null, question: msgs.length ? msgs[0].body : null };
        }));
      }
      if (p === '/api/verify') return json(res, 200, store.verifyChain());
      if (p === '/api/version') return json(res, 200, { version: store.getMeta('board_version') });
      if (p === '/api/events') return json(res, 200, store.listEvents(q.get('project_id') ? id(q.get('project_id')) : null, Number(q.get('limit') ?? 100)));
      if (p === '/api/inbox') { // peek for agent-side hooks: /api/inbox?project=x&agent=y
        const a = store.getAgent(q.get('agent') ?? ''), pr = store.getProject(q.get('project') ?? '');
        if (!a || !pr) return json(res, 404, { error: 'not_found' });
        return json(res, 200, store.inbox(a, pr.id, { peek: true, limit: Number(q.get('limit') ?? 50) }));
      }
      if (seg[0] === 'projects' && seg[1] && !seg[2]) {
        const pr = store.getProject(id(seg[1])); if (!pr) return json(res, 404, { error: 'not_found' });
        const ctx = store.db.prepare(`SELECT id FROM threads WHERE project_id = ? AND kind='status' AND title = ?`).get(pr.id, CONTEXT_THREAD_TITLE);
        const ctxMsgs = ctx ? store.threadMessages(ctx.id) : [];
        return json(res, 200, { project: pr, members: store.members(pr.id).map(m => ({ ...m, live: !!registry.holder(m.name) })), tasks: store.listTasks(pr.id), claims: store.activeClaims(pr.id), context: ctxMsgs[ctxMsgs.length - 1] ?? null, context_thread_id: ctx?.id ?? null });
      }
      if (seg[0] === 'projects' && seg[2] === 'messages') { // feed: /api/projects/<id|name>/messages?since=ID
        const pr = store.getProject(/^\d+$/.test(seg[1]) ? id(seg[1]) : seg[1]); if (!pr) return json(res, 404, { error: 'not_found' });
        return json(res, 200, { last_id: store.db.prepare('SELECT COALESCE(max(id),0) AS n FROM messages WHERE project_id = ?').get(pr.id).n, messages: store.messagesSince(pr.id, Number(q.get('since') ?? 0), Number(q.get('limit') ?? 50)) });
      }
      if (seg[0] === 'projects' && seg[2] === 'threads') {
        const list = store.listThreads(id(seg[1]), { status: q.get('status') || null, kind: q.get('kind') || null, limit: Number(q.get('limit') ?? 100) });
        const acks = store.acksForThreads(list.map(t => t.id));
        const att = new Map(store.threadsIndex().map(t => [t.id, t.attention]));
        return json(res, 200, list.map(t => ({ ...t, acks: acks[t.id] ?? [], attention: att.get(t.id) ?? 'ambient' })));
      }
      if (seg[0] === 'threads' && seg[1] && !seg[2]) {
        const t = store.getThread(id(seg[1])); if (!t) return json(res, 404, { error: 'not_found' });
        const msgs = store.threadMessages(t.id, Number(q.get('since') ?? 0));
        const lastId = store.db.prepare(`SELECT max(id) AS id FROM messages WHERE thread_id = ?`).get(t.id).id;
        return json(res, 200, { thread: t, messages: msgs, acks: store.threadAcks(t.id), read_by: lastId ? store.readReceipts(t.project_id, lastId) : [] });
      }
      return json(res, 404, { error: 'not found' });
    }

    // ---- writes: human only ----
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const actor = requireHuman(req);
    if (p === '/api/projects') return json(res, 200, store.ensureProject(body.name, body.path ?? null, actor));
    if (p === '/api/announce') { if (!body.body?.trim()) throw new BoardError('bad_input', 'body required'); return json(res, 200, store.announceAll(body.body)); }
    if (seg[0] === 'projects' && seg[2] === 'archive') { store.archiveProject(actor, id(seg[1]), body.archived !== false); return json(res, 200, { ok: true }); }
    if (p === '/api/threads') {
      return json(res, 200, store.createThread(actor, { projectId: id(body.project_id), kind: body.kind ?? 'question', title: body.title, body: body.body, ref: body.ref ?? null, needsHuman: !!body.needs_human, mentions: body.mentions ?? [] }));
    }
    if (seg[0] === 'threads' && seg[2] === 'messages') return json(res, 200, store.post(actor, { threadId: id(seg[1]), body: body.body, verdict: body.verdict ?? null, mentions: body.mentions ?? [] }));
    if (seg[0] === 'threads' && seg[2] === 'ack') return json(res, 200, store.react(actor, id(seg[1]), body.state, body.note ?? null));
    if (seg[0] === 'threads' && seg[2] === 'status') return json(res, 200, store.setThreadStatus(actor, id(seg[1]), body.status, body.note ?? null));
    if (seg[0] === 'threads' && seg[2] === 'pause') { store.pauseThread(actor, id(seg[1]), body.reason ?? null); return json(res, 200, store.getThread(id(seg[1]))); }
    if (seg[0] === 'agents' && seg[2] === 'pause') { store.pauseAgent(actor, id(seg[1]), body.reason ?? null); return json(res, 200, store.getAgent(id(seg[1]))); }
    return json(res, 404, { error: 'not found' });
  }
}

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try { resolve(JSON.parse(raw)); } catch { reject(new BoardError('bad_input', 'invalid JSON body')); }
    });
    req.on('error', reject);
  });
}
