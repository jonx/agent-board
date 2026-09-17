// The background waiter: stays blocked while nothing is new, exits on the first new
// notification for its agent, and never acknowledges or writes anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
const running = new Set();
test.after(() => { for (const c of running) { try { c.kill('SIGKILL'); } catch {} } });
const waiter = (project, name) => {
  const child = spawn(process.execPath, [join(ROOT, 'configs', 'claude-code', 'board-wait.js'), project, name],
    { env: { ...process.env, BOARD_URL: base, BOARD_WAIT_INTERVAL_MS: '1000' } });
  running.add(child);
  let out = ''; child.stdout.on('data', c => out += c); child.stderr.on('data', c => out += c);
  const exited = new Promise(r => child.on('close', code => { running.delete(child); r(code); }));
  return { child, exited, out: () => out };
};

test('waiter blocks, wakes on a mention, and leaves the notification unacknowledged', async () => {
  const a = await agent('demo', 'claude-a');
  const b = await agent('demo', 'claude-b');
  const thread = await a.call('board_journal', { body: 'first entry' });
  await a.call('board_post', { thread_id: thread.thread_id ?? thread.id, body: '@claude-b already queued before the waiter starts' });

  // Anything already unread ends the wait at once: the output of a background
  // task reaches the session only when it ends, so blocking on it would hide it.
  const first = waiter('demo', 'claude-b');
  assert.equal(await Promise.race([first.exited, delay(8000).then(() => 'timeout')]), 0);
  assert.match(first.out(), /1 unread for claude-b/);
  assert.match(first.out(), /already queued/);
  assert.match(first.out(), /board_receive/, 'it says how not to be woken by the same thing again');

  await b.call('board_receive', { ids: (await b.call('board_notifications')).notifications.map(n => n.id) });
  const w = waiter('demo', 'claude-b');
  const early = await Promise.race([w.exited, delay(2500).then(() => 'blocked')]);
  assert.equal(early, 'blocked', 'with nothing unread it waits');

  await a.call('board_post', { thread_id: thread.thread_id ?? thread.id, body: '@claude-b wake up please' });
  const code = await Promise.race([w.exited, delay(8000).then(() => 'timeout')]);
  assert.equal(code, 0, w.out());
  assert.match(w.out(), /1 new notification for claude-b/);
  assert.match(w.out(), /wake up please/);

  const pending = await b.call('board_notifications');
  assert.equal(pending.notifications.filter(n => n.received_at === null).length, 1, 'the waiter only reads; the wake it delivered is still unacknowledged');
});

test('waiter publishes a liveness file while it runs and removes it when it ends', async () => {
  const a = await agent('demo', 'claude-live-a');
  await agent('demo', 'claude-live-b');
  const file = join(tmpdir(), 'agent-board-waiters', 'demo.claude-live-b');
  const w = waiter('demo', 'claude-live-b');
  for (let i = 0; i < 40 && !existsSync(file); i++) await delay(100);
  assert.ok(existsSync(file), 'a running waiter is visible to the hook');
  const asked = await a.call('board_ask', { title: 'liveness', body: 'a thread to wake into', to: ['claude-live-b'] });
  await a.call('board_post', { thread_id: asked.id, body: '@claude-live-b wake' });
  assert.equal(await Promise.race([w.exited, delay(8000).then(() => 'timeout')]), 0, w.out());
  for (let i = 0; i < 40 && existsSync(file); i++) await delay(100);
  assert.ok(!existsSync(file), 'a waiter that ended leaves no claim to be reachable');
});

test('the inbox hook says so when nothing is listening', async () => {
  const run = (env) => new Promise(resolve => {
    const c = spawn(process.execPath, [join(ROOT, 'configs', 'claude-code', 'board-inbox.js'), 'demo'],
      { env: { ...process.env, BOARD_URL: base, ...env } });
    let out = ''; c.stdout.on('data', d => out += d);
    c.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'hook-' + Math.random() }));
    c.on('close', () => resolve(out));
  });
  rmSync(join(tmpdir(), 'agent-board-waiters'), { recursive: true, force: true });
  assert.match(await run({}), /NOT reachable while idle/);
  const dir = join(tmpdir(), 'agent-board-waiters');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'demo.claude-hooked'), String(process.pid));
  assert.doesNotMatch(await run({}), /NOT reachable/, 'a live waiter silences the warning');
  writeFileSync(join(dir, 'demo.claude-dead'), '999999');
  rmSync(join(dir, 'demo.claude-hooked'), { force: true });
  assert.match(await run({}), /NOT reachable/, 'a stale file from a dead waiter does not count');
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
    const prompt = readFileSync(join(target, 'CLAUDE.md'), 'utf8');
    // A hook has CLAUDE_PROJECT_DIR; an agent running a command in a shell may
    // not, and an unset variable turns the path into /.claude/board-wait.sh.
    assert.match(prompt, new RegExp(`sh ${target}/\\.claude/board-wait\\.sh <your-agent-name>`));
    assert.doesNotMatch(prompt, /CLAUDE_PROJECT_DIR"?\/\.claude\/board-wait/);
    const hookScript = readFileSync(join(target, '.claude', 'board-inbox.sh'), 'utf8');
    assert.match(hookScript, new RegExp(`"${target}"`), 'the hook carries the directory so its warning can name the command');
    const warn = await new Promise(resolve => {
      const c = spawn(process.execPath, [join(ROOT, 'configs', 'claude-code', 'board-inbox.js'), 'demo', target], { env: { ...process.env, BOARD_URL: base } });
      let out = ''; c.stdout.on('data', d => out += d);
      c.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'abs-' + Math.random() }));
      c.on('close', () => resolve(out));
    });
    assert.match(warn, new RegExp(`sh ${target}/\\.claude/board-wait\\.sh`), 'the warning names a command that runs anywhere');
    assert.doesNotMatch(readFileSync(join(target, 'AGENTS.md'), 'utf8'), /board-wait\.sh/, 'only Claude Code is re-invoked by a background task');
    assert.ok(existsSync(join(target, '.claude', 'board-inbox.sh')));
  } finally { rmSync(target, { recursive: true, force: true }); }
});
