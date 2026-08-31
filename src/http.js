// HTTP layer: MCP transport for agents, JSON API + SSE for the human UI/CLI, static UI.
// Binds to localhost only. Reads are open (the whole point is that the human can see
// everything); writes on /api require the human token (see server.js / INVARIANTS.md).

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMcpServer, CONTEXT_THREAD_TITLE } from './mcp.js';
import { BoardError } from './store.js';

export function createHttpServer({ store, humanToken, uiFile }) {
  const human = store.human();

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    try {
      // ---- MCP for agents: /mcp/<project>/<agent> ----
      const m = path.match(/^\/mcp\/([^/]+)\/([^/]+)\/?$/);
      if (m) return await handleMcp(req, res, m[1], m[2], url.searchParams.get('provider') || providerFromUA(req.headers['user-agent']));
      if (path === '/mcp' || path === '/mcp/') return json(res, 400, { error: 'use /mcp/<project>/<agent>' });

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

  async function handleMcp(req, res, projectName, agentName, provider) {
    let agent, project;
    try {
      agent = store.ensureAgent(decodeURIComponent(agentName), provider);
      project = store.ensureProject(decodeURIComponent(projectName), null, agent);
      store.join(agent, project);
    } catch (e) {
      return json(res, 400, { error: e.code ?? 'bad_request', message: e.message });
    }
    const server = buildMcpServer(store, agent, project);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    const body = req.method === 'POST' ? await readJson(req) : undefined;
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
      if (p === '/api/verify') return json(res, 200, store.verifyChain());
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
        return json(res, 200, { project: pr, members: store.members(pr.id), tasks: store.listTasks(pr.id), claims: store.activeClaims(pr.id), context: ctxMsgs[ctxMsgs.length - 1] ?? null, context_thread_id: ctx?.id ?? null });
      }
      if (seg[0] === 'projects' && seg[2] === 'threads') return json(res, 200, store.listThreads(id(seg[1]), { status: q.get('status') || null, kind: q.get('kind') || null, limit: Number(q.get('limit') ?? 100) }));
      if (seg[0] === 'threads' && seg[1] && !seg[2]) {
        const t = store.getThread(id(seg[1])); if (!t) return json(res, 404, { error: 'not_found' });
        return json(res, 200, { thread: t, messages: store.threadMessages(t.id, Number(q.get('since') ?? 0)) });
      }
      return json(res, 404, { error: 'not found' });
    }

    // ---- writes: human only ----
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const actor = requireHuman(req);
    if (p === '/api/projects') return json(res, 200, store.ensureProject(body.name, body.path ?? null, actor));
    if (seg[0] === 'projects' && seg[2] === 'archive') { store.archiveProject(actor, id(seg[1]), body.archived !== false); return json(res, 200, { ok: true }); }
    if (p === '/api/threads') {
      return json(res, 200, store.createThread(actor, { projectId: id(body.project_id), kind: body.kind ?? 'question', title: body.title, body: body.body, ref: body.ref ?? null, needsHuman: !!body.needs_human, mentions: body.mentions ?? [] }));
    }
    if (seg[0] === 'threads' && seg[2] === 'messages') return json(res, 200, store.post(actor, { threadId: id(seg[1]), body: body.body, verdict: body.verdict ?? null, mentions: body.mentions ?? [] }));
    if (seg[0] === 'threads' && seg[2] === 'status') return json(res, 200, store.setThreadStatus(actor, id(seg[1]), body.status, body.note ?? null));
    if (seg[0] === 'threads' && seg[2] === 'pause') { store.pauseThread(actor, id(seg[1]), body.reason ?? null); return json(res, 200, store.getThread(id(seg[1]))); }
    if (seg[0] === 'agents' && seg[2] === 'pause') { store.pauseAgent(actor, id(seg[1]), body.reason ?? null); return json(res, 200, store.getAgent(id(seg[1]))); }
    return json(res, 404, { error: 'not found' });
  }
}

function providerFromUA(ua = '') {
  ua = ua.toLowerCase();
  for (const k of ['claude', 'codex', 'openai', 'gemini', 'cursor', 'opencode', 'copilot', 'aider']) if (ua.includes(k)) return k;
  return null;
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
