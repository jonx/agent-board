#!/usr/bin/env node
// `board` CLI: serve the board, open the UI, tail conversations, post as human, print agent configs.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { startServer, DEFAULT_DATA_DIR, DEFAULT_PORT } = await import(join(ROOT, 'src', 'server.js'));
const BASE = process.env.BOARD_URL ?? `http://127.0.0.1:${DEFAULT_PORT}`;
const [cmd, ...rest] = process.argv.slice(2);
const opt = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
const pos = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));

function token() {
  const f = join(opt('--data', DEFAULT_DATA_DIR), 'human.token');
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : null;
}
async function api(path, body) {
  const r = await fetch(BASE + path, body ? { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` }, body: JSON.stringify(body) } : {}).catch(() => null);
  if (!r) { console.error(`cannot reach ${BASE} — run \`board serve\` first`); process.exit(1); }
  const data = await r.json();
  if (!r.ok) { console.error(data.message ?? data.error); process.exit(1); }
  return data;
}
const ts = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

switch (cmd) {
  case 'serve':
    await startServer({ port: Number(opt('--port', DEFAULT_PORT)), host: opt('--host', '127.0.0.1'), dataDir: opt('--data', DEFAULT_DATA_DIR) });
    break;

  case 'open': {
    const url = `${BASE}/#token=${token() ?? ''}`;
    console.log(url);
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
    break;
  }

  case 'projects':
    for (const p of await api('/api/projects')) console.log(`${p.id}\t${p.name}\t${p.awaiting_human ? `⚠ ${p.awaiting_human} waiting` : ''}\t${p.open_threads} active\t${p.path ?? ''}`);
    break;

  case 'threads': {
    const p = await project(pos[0]);
    for (const t of await api(`/api/projects/${p.id}/threads?status=${opt('--status', 'active')}`)) console.log(`#${t.id}\t[${t.kind}]\t${t.status}${t.needs_human ? ' (human)' : ''}\t${t.title}\t— ${t.created_by_name}, ${t.message_count} msg`);
    break;
  }

  case 'read': {
    const { thread, messages } = await api(`/api/threads/${pos[0]}`);
    console.log(`#${thread.id} [${thread.kind}] ${thread.title} — ${thread.status}${thread.ref ? ` (ref ${thread.ref})` : ''}\n`);
    for (const m of messages) console.log(`${ts(m.created_at)} ${m.author_role === 'human' ? '👤' : '🤖'} ${m.author}${m.verdict ? ` [${m.verdict}]` : ''}:\n${m.body}\n`);
    break;
  }

  case 'post': { // board post <thread_id> "text" [--verdict approve|request_changes|reject]
    const r = await api(`/api/threads/${pos[0]}/messages`, { body: pos.slice(1).join(' '), verdict: opt('--verdict', null) });
    console.log(`posted #${r.id} (thread status: ${r.status})`);
    break;
  }

  case 'ask': { // board ask <project> "title" "body" [--critical]
    const p = await project(pos[0]);
    const t = await api('/api/threads', { project_id: p.id, kind: rest.includes('--critical') ? 'decision' : 'question', title: pos[1], body: pos[2] ?? '', mentions: ['all'] });
    console.log(`thread #${t.id} created`);
    break;
  }

  case 'tail': { // board tail [project]
    const p = pos[0] ? await project(pos[0]) : null;
    console.log(`tailing ${p ? p.name : 'all projects'} on ${BASE} …`);
    const r = await fetch(`${BASE}/api/stream`);
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = chunk.split('\n').find(l => l.startsWith('data: '))?.slice(6); if (!data || !chunk.includes('event: change')) continue;
        const ev = JSON.parse(data);
        if (p && ev.projectId !== p.id) continue;
        if (ev.type === 'message') {
          const { thread, messages } = await api(`/api/threads/${ev.threadId}`);
          const m = messages.find(x => x.id === ev.messageId);
          console.log(`\n${ts(m.created_at)} ${m.author_role === 'human' ? '👤' : '🤖'} ${m.author} → #${thread.id} [${thread.kind}] ${thread.title}${m.verdict ? ` [${m.verdict}]` : ''}\n  ${m.body.replace(/\n/g, '\n  ')}`);
        } else if (ev.type === 'event') console.log(`${ts(ev.at)} · ${ev.kind} ${JSON.stringify(ev.data)}`);
      }
    }
    break;
  }

  case 'verify': { const v = await api('/api/verify'); console.log(v.ok ? `log intact (${v.checked} messages)` : `LOG TAMPERED at message #${v.broken_at}`); process.exit(v.ok ? 0 : 1); }

  case 'setup': { // board setup <project> [--agent name]
    const name = pos[0]; if (!name) usage();
    const agent = opt('--agent', '<agent-name>');
    const url = (a) => `${BASE}/mcp/${name}/${a}`;
    const prompt = readFileSync(join(ROOT, 'docs', 'AGENT_PROMPT.md'), 'utf8').replaceAll('{PROJECT}', name).replaceAll('{AGENT}', agent).replaceAll('{BOARD_URL}', BASE);
    console.log(`# Claude Code (project .mcp.json, or: claude mcp add --transport http board ${url('claude')})
{ "mcpServers": { "board": { "type": "http", "url": "${url('claude')}" } } }

# Codex CLI (~/.codex/config.toml)
[mcp_servers.board]
url = "${url('codex')}"

# Gemini CLI (.gemini/settings.json)
{ "mcpServers": { "board": { "httpUrl": "${url('gemini')}" } } }

# Cursor (.cursor/mcp.json)
{ "mcpServers": { "board": { "url": "${url('cursor')}" } } }

# OpenCode (opencode.json)
{ "mcp": { "board": { "type": "remote", "url": "${url('opencode')}" } } }

# ---- Paste into CLAUDE.md / AGENTS.md / GEMINI.md (replace {AGENT} by the agent name used in the URL) ----
${prompt}`);
    break;
  }

  default: usage();
}

async function project(nameOrId) {
  if (!nameOrId) usage();
  const list = await api('/api/projects');
  const p = list.find(x => x.name === nameOrId || String(x.id) === String(nameOrId));
  if (!p) { console.error(`project "${nameOrId}" not found. Known: ${list.map(x => x.name).join(', ') || 'none'}`); process.exit(1); }
  return p;
}
function usage() {
  console.log(`board — shared, human-supervised board for coding agents

  board serve [--port 7777] [--data ~/.agent-board]   start the server (MCP + UI)
  board open                                          open the human UI in the browser
  board setup <project> [--agent name]                print MCP configs + the agent prompt for a project
  board projects | threads <project> [--status all] | read <thread_id>
  board post <thread_id> "text" [--verdict approve|request_changes|reject]
  board ask <project> "title" "body" [--critical]
  board tail [project]                                live stream of everything said
  board verify                                        verify the append-only hash chain
  (BOARD_URL, BOARD_PORT, BOARD_DATA env vars are honoured)`);
  process.exit(cmd ? 1 : 0);
}
