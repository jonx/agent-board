// End-to-end: real HTTP server, real MCP clients (SDK) for two agents, human via the JSON API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../src/server.js';

const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'agent-board-'));
const { server, base, humanToken, store } = await startServer({ port: 0, dataDir: dir, quiet: true });
const humanApi = (path, body) => fetch(base + path, body ? { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${humanToken}` }, body: JSON.stringify(body) } : {}).then(async r => ({ status: r.status, data: await r.json() }));

async function agent(project, name, provider = name.split('-')[0]) {
  const c = new Client({ name: `${name}-test`, version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${project}/${provider}`)));
  const call = async (tool, args = {}) => { const r = await c.callTool({ name: tool, arguments: args }); const text = r.content[0].text; let data; try { data = JSON.parse(text); } catch { throw new Error(`${tool}: ${text}`); } if (r.isError) { const e = new Error(data.message); e.data = data; throw e; } return data; };
  if (name) await call('board_join', { name });
  return { c, call };
}

test.after(() => { server.closeAllConnections(); server.close(); store.db.close(); rmSync(dir, { recursive: true, force: true }); });

test('two providers coordinate through the board with the human watching', async () => {
  const claude = await agent('demo', 'claude');
  const codex = await agent('demo', 'codex');
  const tools = (await claude.c.listTools()).tools.map(t => t.name);
  assert.ok(tools.includes('board_status') && tools.includes('board_ask'));

  // Sessions pick their own names; a live name cannot be taken, a foreign provider's name neither.
  const anon = await agent('demo', null, 'claude');
  const pre = await anon.call('board_status');
  assert.equal(pre.joined, false); assert.match(pre.how, /claude-2/);
  await assert.rejects(anon.call('board_inbox'), /board_join first/);
  await assert.rejects(anon.call('board_join', { name: 'claude' }), /another live session/);
  await assert.rejects(anon.call('board_join', { name: 'codex' }), /belongs to provider codex/);
  await assert.rejects(anon.call('board_join', { name: 'human' }), /human account/);
  await anon.call('board_join', { name: 'claude-2' });
  assert.equal((await anon.call('board_status')).you.name, 'claude-2');
  await anon.c.close();


  // First agent alone: brief is empty, it writes context + journal.
  let st = await claude.call('board_status', { project_path: '/tmp/demo' });
  assert.match(String(st.project_context), /EMPTY/);

  // Agents can list projects, and a path registered under another name triggers a warning.
  const typo = await agent('demo-typo', null, 'claude');
  const listed = await typo.call('board_projects');
  assert.ok(listed.projects.some(p => p.name === 'demo' && p.path === '/tmp/demo'));
  const j = await typo.call('board_join', { name: 'claude-3', project_path: '/tmp/demo' });
  assert.match(j.warnings.join(' '), /already registered as project "demo"/);
  await typo.c.close();
  await claude.call('board_context', { body: 'Goal: demo app. Stack: node. Run: npm test.' });
  await claude.call('board_journal', { body: 'Started on auth module.' });
  await claude.call('board_claim', { paths: ['src/auth/'], note: 'auth' });

  // Second agent arrives: sees the brief, the journal, the claim.
  st = await codex.call('board_status');
  assert.equal(st.project_context.body, 'Goal: demo app. Stack: node. Run: npm test.');
  assert.equal(st.recent_journal.length, 1);
  assert.equal(st.active_claims[0].by, 'claude');
  await assert.rejects(codex.call('board_claim', { paths: ['src/auth/login.js'] }), /already claimed/);

  // Opinion request + answer.
  const q = await claude.call('board_ask', { title: 'JWT or sessions?', body: 'Leaning JWT.', to: ['codex'] });
  const inbox = await codex.call('board_inbox');
  assert.ok(inbox.threads.some(t => t.thread_id === q.id && t.mentions_you));
  await codex.call('board_post', { thread_id: q.id, body: 'Sessions, simpler to revoke. @claude' });
  assert.equal((await claude.call('board_inbox')).unread, 1, 'the answer is simply there on the next inbox check');
  assert.ok((await codex.call('board_status')).waiting_on_you !== undefined, 'status tells an agent what is on its plate');

  // Critical decision: agent approval is advisory, human decides.
  const dec = await claude.call('board_ask', { title: 'Drop legacy users table', body: 'Irreversible.', critical: true });
  assert.equal(dec.status, 'awaiting_human');
  const adv = await codex.call('board_post', { thread_id: dec.id, body: 'fine by me', verdict: 'approve' });
  assert.equal(adv.advisory, true);
  assert.equal((await claude.call('board_read', { thread_id: dec.id })).thread.status, 'awaiting_human');
  await assert.rejects(codex.call('board_resolve', { thread_id: dec.id }), /human/);
  let r = await humanApi(`/api/threads/${dec.id}/messages`, { body: 'Approved, but back it up first.', verdict: 'approve' });
  assert.equal(r.status, 200);
  assert.equal((await claude.call('board_read', { thread_id: dec.id })).thread.status, 'approved');

  // Acknowledgements: codex says it is on it, claude can see that before deciding to wait.
  const ack = await codex.call('board_ack', { thread_id: q.id, state: 'working', note: 'after the auth refactor, ~20 min' });
  assert.equal(ack.acks.find(a => a.agent === 'codex').state, 'working');
  const seen = await claude.call('board_read', { thread_id: q.id });
  assert.equal(seen.acks.find(a => a.agent === 'codex').note, 'after the auth refactor, ~20 min');
  assert.ok(seen.last_message_read_by.includes('codex'), 'acknowledging marks the thread read');
  await codex.call('board_ack', { thread_id: q.id, state: 'done' });
  assert.equal((await claude.call('board_read', { thread_id: q.id })).acks.find(a => a.agent === 'codex').state, 'done');
  await assert.rejects(codex.call('board_ack', { thread_id: q.id, state: 'maybe' }), /state|enum|invalid/i);
  // The human can acknowledge too, from the API.
  assert.equal((await humanApi(`/api/threads/${q.id}/ack`, { state: 'seen' })).status, 200);
  assert.ok((await humanApi(`/api/threads/${q.id}`)).data.acks.some(a => a.agent === 'human'));

  // Review with verdict between agents.
  const rv = await claude.call('board_request_review', { title: 'auth module', ref: 'abc123', body: 'please check', reviewer: 'codex' });
  await codex.call('board_post', { thread_id: rv.id, body: 'lgtm', verdict: 'approve' });
  assert.equal((await claude.call('board_read', { thread_id: rv.id })).thread.status, 'approved');

  // Human pauses codex: it cannot post; then resumes.
  const codexId = (await humanApi('/api/agents')).data.find(a => a.name === 'codex').id;
  await humanApi(`/api/agents/${codexId}/pause`, { reason: 'wait for me' });
  await assert.rejects(codex.call('board_post', { thread_id: q.id, body: 'x' }), /paused/);
  await humanApi(`/api/agents/${codexId}/pause`, { reason: null });
  await codex.call('board_post', { thread_id: q.id, body: 'back' });

  // Writes without the token are refused; reads are open.
  const noTok = await fetch(`${base}/api/threads/${q.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'fake human' }) });
  assert.equal(noTok.status, 403);
  assert.equal((await fetch(`${base}/api/threads/${q.id}`)).status, 200);
  // Nobody can register as the human over MCP.
  await assert.rejects(agent('demo', 'human', 'claude'), /human account/);

  // Multi-project isolation + log integrity + UI served.
  const other = await agent('other', 'gemini');
  assert.equal((await other.call('board_threads', { status: 'all' })).length, 0);
  assert.equal((await humanApi('/api/verify')).data.ok, true);
  assert.match(await (await fetch(base + '/')).text(), /agent-board/);

  await claude.c.close(); await codex.c.close(); await other.c.close();
});

test('update workflow: version change is announced and join reports whats_new', async () => {
  const notes = (v) => `## 9.9.9\n- pretend change (since ${v})`;
  // Simulate: the running version was 0.0.1, the server restarts as 9.9.9.
  store.setMeta('board_version', '0.0.1');
  const r = store.recordVersion('9.9.9', notes);
  assert.equal(r.previous, '0.0.1');
  const demo = store.getProject('demo');
  const updates = store.listThreads(demo.id, { status: 'all', kind: 'status' }).find(t => t.title === 'Board updates');
  assert.ok(updates, 'Board updates thread created');
  const last = store.threadMessages(updates.id).at(-1);
  assert.equal(last.author, 'board'); assert.match(last.body, /0\.0\.1 → 9\.9\.9/); assert.match(last.body, /pretend change/);
  // An agent that had seen an older version gets whats_new; the next join does not repeat it.
  const a = store.getAgent('claude');
  store.db.prepare(`UPDATE agents SET last_board_version = '0.0.1' WHERE id = ?`).run(a.id);
  assert.equal(store.whatsNewFor(a, '9.9.9', notes)?.since, '0.0.1');
  assert.equal(store.whatsNewFor(a, '9.9.9', notes), null);
  // The human can announce; agents cannot take the "board" name.
  const ann = await humanApi('/api/announce', { body: 'maintenance in 5 min' });
  assert.equal(ann.status, 200); assert.ok(ann.data.length >= 2);
  await assert.rejects(agent('demo', 'board', 'claude'), /reserved/);
  // The announce endpoint is human-only.
  const noTok = await fetch(`${base}/api/announce`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'x' }) });
  assert.equal(noTok.status, 403);
});
