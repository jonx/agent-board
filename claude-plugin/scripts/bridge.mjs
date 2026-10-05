#!/usr/bin/env node
// stdio <-> Streamable HTTP bridge for the agent-board MCP server. Zero dependencies,
// so the plugin works from its installed copy with no npm install.
//
// Why it exists: the board's HTTP URL names the project (/mcp/<project>/<provider>),
// but a plugin is installed once for every project. This bridge asks the board which
// project owns the current directory (falling back to the directory name), then
// forwards newline-delimited JSON-RPC from stdio to that URL. If the board server is
// down it tries once to start it (`board serve`), and if an MCP session dies (server
// restarted) it re-initializes transparently and retries, so old and new CLI versions
// alike just see a working stdio server.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';

const BASE = process.env.BOARD_URL ?? 'http://127.0.0.1:7777';
const PROVIDER = (process.env.BOARD_PROVIDER ?? 'claude').toLowerCase();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function up() { try { return (await fetch(`${BASE}/api/projects`)).ok; } catch { return false; } }

async function ensureServer() {
  if (await up()) return true;
  try { spawn('board', ['serve'], { detached: true, stdio: 'ignore' }).unref(); } catch {}
  for (let i = 0; i < 10; i++) { await sleep(400); if (await up()) return true; }
  return false;
}

async function resolveProject() {
  try {
    const r = await fetch(`${BASE}/api/hook/project?cwd=${encodeURIComponent(process.cwd())}`);
    const j = await r.json();
    if (j.project) return j.project;
  } catch {}
  return basename(process.cwd()).toLowerCase().replace(/[^a-z0-9._-]/g, '-') || 'default';
}

let url, sessionId = null, initMsg = null;

async function post(msg) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
    body: JSON.stringify(msg),
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const text = await res.text();
  return { status: res.status, text };
}

function emit(text) {
  if (!text) return;
  for (const chunk of text.split('\n')) {         // tolerate SSE framing just in case
    const line = chunk.startsWith('data:') ? chunk.slice(5).trim() : chunk.trim();
    if (!line || line.startsWith('event:') || line.startsWith(':')) continue;
    try { JSON.parse(line); process.stdout.write(line + '\n'); } catch {}
  }
}

async function handle(msg) {
  if (msg.method === 'initialize') initMsg = msg;
  let r;
  try { r = await post(msg); } catch { return; }      // server gone mid-flight: drop, client retries
  if (r.status === 404 && initMsg && msg.method !== 'initialize') {
    // Server restarted and forgot the session: re-initialize quietly and retry once.
    sessionId = null;
    try {
      await post(initMsg);
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
      r = await post(msg);
    } catch { return; }
  }
  if (msg.id === undefined) return;                   // notification: nothing to answer
  emit(r.text);
}

const main = async () => {
  if (!(await ensureServer())) {
    process.stderr.write(`agent-board: no server at ${BASE}. Start it with \`board serve\` (or \`board service install\`).\n`);
    process.exit(1);
  }
  url = `${BASE}/mcp/${encodeURIComponent(await resolveProject())}/${PROVIDER}`;
  const rl = createInterface({ input: process.stdin });
  let queue = Promise.resolve();
  rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    let msg; try { msg = JSON.parse(line); } catch { return; }
    queue = queue.then(() => handle(msg)).catch(() => {});
  });
  rl.on('close', () => { queue.finally(() => process.exit(0)); });
};
main();
