// Every write names its author. A bare write with no terminal is refused rather
// than signed with the supervisor's name, which is how an agent's delegation
// once ended up on the board as if a person had written it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../src/server.js';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'board.js');
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'agent-board-identity-'));
const { server, base, store } = await startServer({ port: 0, dataDir: dir, quiet: true });
test.after(() => { server.closeAllConnections(); server.close(); store.db.close(); rmSync(dir, { recursive: true, force: true }); });

// execFile gives the child a pipe, not a terminal: exactly an agent's shell.
const board = (...args) => run(process.execPath, [CLI, ...args, '--data', dir], { env: { ...process.env, BOARD_URL: base } });

async function thread() {
  const c = new Client({ name: 'seed', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/demo/claude`)));
  const call = async (tool, args = {}) => { const r = await c.callTool({ name: tool, arguments: args }); if (r.isError) throw new Error(r.content[0].text); return JSON.parse(r.content[0].text); };
  await call('board_join', { name: 'seed-agent' });
  const t = await call('board_ask', { title: 'a thread to write into', body: 'seeded' });
  await c.close();
  return t.id ?? t.thread_id ?? t.thread?.id;
}
const messages = async (id) => (await (await fetch(`${base}/api/threads/${id}`)).json()).messages;

test('a bare write with no terminal is refused and names both signed forms', async () => {
  const id = await thread();
  const before = (await messages(id)).length;
  const failure = await board('post', String(id), 'who wrote this?').then(() => null, (e) => e);
  assert.ok(failure, 'a bare post from a pipe must not succeed');
  assert.equal(failure.code, 1);
  assert.match(failure.stderr, /board human post/);
  assert.match(failure.stderr, /board agent <name> post/);
  assert.equal((await messages(id)).length, before, 'the refused write must leave no message');
});

test('delegate, the command that caused this, is refused unsigned too', async () => {
  const failure = await board('delegate', 'demo', '{"to":"claude-b","title":"t","description":"d"}').then(() => null, (e) => e);
  assert.ok(failure, 'a bare delegate from a pipe must not succeed');
  assert.match(failure.stderr, /board agent <name> delegate/);
});

test('board agent <name> post writes as that agent', async () => {
  const id = await thread();
  await board('agent', 'claude-t', 'post', String(id), 'signed by the agent');
  const last = (await messages(id)).at(-1);
  assert.equal(last.body, 'signed by the agent');
  assert.equal(last.author, 'claude-t');
  assert.equal(last.author_role, 'agent');
});

test('board human post writes as the human', async () => {
  const id = await thread();
  await board('human', 'post', String(id), 'signed by the supervisor');
  const last = (await messages(id)).at(-1);
  assert.equal(last.body, 'signed by the supervisor');
  assert.equal(last.author_role, 'human');
});

test('an agent takes the project from the thread, without being told', async () => {
  const id = await thread();
  await board('agent', 'claude-t', 'ok', String(id), 'looks right to me');
  const last = (await messages(id)).at(-1);
  assert.equal(last.author, 'claude-t');
  assert.equal(last.verdict, 'approve');
});
