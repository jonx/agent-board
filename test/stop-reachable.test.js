// A session that has used the board cannot end its turn unreachable. The waiter
// and the inbox hook only speak while an agent is working; this hook is the last
// moment anything can reach a session about to go idle with no waiter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(ROOT, 'configs', 'claude-code', 'board-stop.js');
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'agent-board-stop-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const waiters = join(dir, 'agent-board-waiters');
mkdirSync(waiters, { recursive: true });
// The hook reads the waiter directory under TMPDIR, so the child gets ours.
const env = { ...process.env, TMPDIR: dir + '/' };

let n = 0;
function transcript(lines) {
  const path = join(dir, `transcript-${n++}.jsonl`);
  writeFileSync(path, lines.join('\n'));
  return path;
}
const liveWaiter = (project, agent) =>
  writeFileSync(join(waiters, `${project}.${agent}`), String(process.pid));
const deadWaiter = (project, agent) =>
  writeFileSync(join(waiters, `${project}.${agent}`), '2147480000');

async function hook(project, input) {
  const child = execFile(process.execPath, [HOOK, project, '/repo'], { env });
  child.stdin.end(JSON.stringify(input));
  const { stdout } = await new Promise((resolve, reject) => {
    let out = '', err = '';
    child.stdout.on('data', c => out += c);
    child.stderr.on('data', c => err += c);
    child.on('close', code => code === 0 ? resolve({ stdout: out }) : reject(new Error(err || `exit ${code}`)));
  });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

const boardSession = () => transcript([
  '{"type":"user","text":"do the thing"}',
  '{"type":"tool","name":"Bash","input":"board agent claude-c post 19 \\"done\\""}',
]);

test('a board session with no waiter is held and told exactly what to start', async () => {
  const out = await hook('afsplus', { hook_event_name: 'Stop', stop_hook_active: false, transcript_path: boardSession() });
  assert.ok(out, 'the stop must be blocked');
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /claude-c/);
  assert.match(out.reason, /board-wait\.sh claude-c/);
  assert.match(out.reason, /BACKGROUND/);
});

test('it never blocks twice, so it cannot loop a session', async () => {
  const out = await hook('afsplus', { hook_event_name: 'Stop', stop_hook_active: true, transcript_path: boardSession() });
  assert.equal(out, null, 'a stop it already prevented must go through');
});

test('a session that never touched the board is left alone', async () => {
  const path = transcript(['{"type":"user","text":"rename a variable"}', '{"type":"tool","name":"Edit"}']);
  assert.equal(await hook('afsplus', { hook_event_name: 'Stop', stop_hook_active: false, transcript_path: path }), null);
});

test('a live waiter for this agent lets the session stop', async () => {
  liveWaiter('afsplus', 'claude-c');
  assert.equal(await hook('afsplus', { hook_event_name: 'Stop', stop_hook_active: false, transcript_path: boardSession() }), null);
  rmSync(join(waiters, 'afsplus.claude-c'), { force: true });
});

test("another agent's waiter does not excuse this one", async () => {
  liveWaiter('afsplus', 'claude-b');
  const out = await hook('afsplus', { hook_event_name: 'Stop', stop_hook_active: false, transcript_path: boardSession() });
  assert.ok(out, 'claude-b being reachable says nothing about claude-c');
  assert.match(out.reason, /claude-c/);
  rmSync(join(waiters, 'afsplus.claude-b'), { force: true });
});

test('a waiter whose process is gone does not count as reachable', async () => {
  deadWaiter('afsplus', 'claude-c');
  const out = await hook('afsplus', { hook_event_name: 'Stop', stop_hook_active: false, transcript_path: boardSession() });
  assert.ok(out, 'a stale liveness file must not make a session look reachable');
  rmSync(join(waiters, 'afsplus.claude-c'), { force: true });
});

test('the name comes from the latest way the session reached the board', async () => {
  const path = transcript([
    '{"type":"tool","input":"board as afsplus claude-old board_status"}',
    '{"type":"tool","input":"board agent claude-new post 19 \\"later\\""}',
  ]);
  const out = await hook('afsplus', { hook_event_name: 'Stop', stop_hook_active: false, transcript_path: path });
  assert.match(out.reason, /claude-new/);
});
