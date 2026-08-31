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

async function agent(project, name) {
  const c = new Client({ name: `${name}-test`, version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${project}/${name}`)));
  const call = async (tool, args = {}) => { const r = await c.callTool({ name: tool, arguments: args }); const text = r.content[0].text; let data; try { data = JSON.parse(text); } catch { throw new Error(`${tool}: ${text}`); } if (r.isError) { const e = new Error(data.message); e.data = data; throw e; } return data; };
  return { c, call };
}

test.after(() => { server.closeAllConnections(); server.close(); store.db.close(); rmSync(dir, { recursive: true, force: true }); });

test('two providers coordinate through the board with the human watching', async () => {
  const claude = await agent('demo', 'claude');
  const codex = await agent('demo', 'codex');
  const tools = (await claude.c.listTools()).tools.map(t => t.name);
  assert.ok(tools.includes('board_status') && tools.includes('board_ask'));

  // First agent alone: brief is empty, it writes context + journal.
  let st = await claude.call('board_status', { project_path: '/tmp/demo' });
  assert.match(String(st.project_context), /EMPTY/);
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
  const waited = await claude.call('board_wait', { timeout_seconds: 5 });
  assert.equal(waited.arrived, true);

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
  await assert.rejects(agent('demo', 'human'));

  // Multi-project isolation + log integrity + UI served.
  const other = await agent('other', 'gemini');
  assert.equal((await other.call('board_threads', { status: 'all' })).length, 0);
  assert.equal((await humanApi('/api/verify')).data.ok, true);
  assert.match(await (await fetch(base + '/')).text(), /agent-board/);

  await claude.c.close(); await codex.c.close(); await other.c.close();
});
