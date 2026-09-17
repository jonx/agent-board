// The background waiter: stays blocked while nothing is new, exits on the first new
// notification for its agent, and never acknowledges or writes anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../src/server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'agent-board-wait-'));
const { server, base, store } = await startServer({ port: 0, dataDir: dir, quiet: true });
test.after(() => { server.closeAllConnections(); server.close(); store.db.close(); rmSync(dir, { recursive: true, force: true }); });

async function agent(project, name) {
  const c = new Client({ name: `${name}-test`, version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${project}/claude`)));
  const call = async (tool, args = {}) => { const r = await c.callTool({ name: tool, arguments: args }); if (r.isError) throw new Error(r.content[0].text); return JSON.parse(r.content[0].text); };
  await call('board_join', { name });
  return { call };
}
const waiter = (project, name) => {
  const child = spawn(process.execPath, [join(ROOT, 'configs', 'claude-code', 'board-wait.js'), project, name],
    { env: { ...process.env, BOARD_URL: base, BOARD_WAIT_INTERVAL_MS: '1000' } });
  let out = ''; child.stdout.on('data', c => out += c);
  const exited = new Promise(r => child.on('close', code => r(code)));
  return { child, exited, out: () => out };
};

test('waiter blocks, wakes on a mention, and leaves the notification unacknowledged', async () => {
  const a = await agent('demo', 'claude-a');
  const b = await agent('demo', 'claude-b');
  const thread = await a.call('board_journal', { body: 'first entry' });
  await a.call('board_post', { thread_id: thread.thread_id ?? thread.id, body: '@claude-b already queued before the waiter starts' });

  const w = waiter('demo', 'claude-b');
  const early = await Promise.race([w.exited, delay(2500).then(() => 'blocked')]);
  assert.equal(early, 'blocked', 'what was queued before the start must not end the wait');

  await a.call('board_post', { thread_id: thread.thread_id ?? thread.id, body: '@claude-b wake up please' });
  const code = await Promise.race([w.exited, delay(8000).then(() => 'timeout')]);
  assert.equal(code, 0);
  assert.match(w.out(), /1 new notification for claude-b/);
  assert.match(w.out(), /wake up please/);
  assert.doesNotMatch(w.out(), /already queued/);

  const pending = await b.call('board_notifications');
  assert.equal(pending.notifications.filter(n => n.received_at === null).length, 2, 'the waiter only reads');
});

test('waiter refuses an unknown project at once and survives an unreachable board otherwise', async () => {
  const w = waiter('no-such-project', 'claude-b');
  assert.equal(await Promise.race([w.exited, delay(5000).then(() => 'timeout')]), 1);
});

test('board init installs the waiter next to the inbox hook and tells Claude to start it', async () => {
  const target = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'agent-board-init-'));
  try {
    // Asynchronous on purpose: the board server lives in this process, a blocking spawn would starve it.
    const r = await new Promise(resolve => {
      const c = spawn(process.execPath, [join(ROOT, 'bin', 'board.js'), 'init', target, '--project', 'demo', '--agents', 'claude,codex'], { env: { ...process.env, BOARD_URL: base } });
      let stderr = ''; c.stderr.on('data', d => stderr += d); c.on('close', status => resolve({ status, stderr }));
    });
    assert.equal(r.status, 0, r.stderr);
    const script = readFileSync(join(target, '.claude', 'board-wait.sh'), 'utf8');
    assert.match(script, /board-wait\.js" "demo" "\$1"/);
    assert.doesNotMatch(script, /__BOARD_/);
    assert.match(readFileSync(join(target, 'CLAUDE.md'), 'utf8'), /board-wait\.sh <your-agent-name>/);
    assert.doesNotMatch(readFileSync(join(target, 'AGENTS.md'), 'utf8'), /board-wait\.sh/, 'only Claude Code is re-invoked by a background task');
    assert.ok(existsSync(join(target, '.claude', 'board-inbox.sh')));
  } finally { rmSync(target, { recursive: true, force: true }); }
});
