#!/usr/bin/env node
// `board` CLI: serve the board, open the UI, tail conversations, post as human, print agent configs.
import { readFileSync, existsSync, writeFileSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
import { homedir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { startServer, DEFAULT_DATA_DIR, DEFAULT_PORT } = await import(join(ROOT, 'src', 'server.js'));
const BASE = process.env.BOARD_URL ?? `http://127.0.0.1:${DEFAULT_PORT}`;
// Who is writing is never a default. `board human …` writes as the supervisor,
// `board agent <name> …` writes as that agent, and a bare write is taken only
// from a terminal, where a person is typing. An agent's shell has no terminal,
// so a write it did not sign is refused instead of being attributed to the human.
const WRITE_COMMANDS = new Set(['post', 'ok', 'no', 'ask', 'delegate', 'announce']);
let argv = process.argv.slice(2);
let identity = null;
if (argv[0] === 'human') { identity = { kind: 'human' }; argv = argv.slice(1); }
else if (argv[0] === 'agent') {
  if (!argv[1] || argv[1].startsWith('--')) { console.error('board agent <name> <command> …: the agent name is missing'); process.exit(1); }
  identity = { kind: 'agent', name: argv[1] };
  argv = argv.slice(2);
}
const [cmd, ...rest] = argv;
const opt = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
const pos = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));

function token() {
  const f = join(opt('--data', DEFAULT_DATA_DIR), 'human.token');
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : null;
}
async function api(path, body) {
  const r = await fetch(BASE + path, body ? { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` }, body: JSON.stringify(body) } : {}).catch(() => null);
  if (!r) { console.error(`cannot reach ${BASE}: run \`board serve\` first`); process.exit(1); }
  const data = await r.json();
  if (!r.ok) { console.error(data.message ?? data.error); process.exit(1); }
  return data;
}
const ts = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// One MCP session under `name`, the same route `board as` uses.
async function callAsAgent(project, name, tool, args, { create = false } = {}) {
  const provider = opt('--provider', name.split('-')[0]);
  if (!create) {
    const known = await api('/api/projects');
    if (!known.some(p => p.name === project)) {
      const cwd = process.cwd().replace(/\/+$/, '');
      const byPath = known.find(p => p.path && (cwd === p.path.replace(/\/+$/, '') || cwd.startsWith(p.path.replace(/\/+$/, '') + '/')));
      console.error(`project "${project}" does not exist on the board.` + (byPath ? ` The current directory is registered as project "${byPath.name}": use that name.` : ''));
      console.error(`existing projects:\n` + (known.map(p => `  ${p.name}\t${p.path ?? ''}`).join('\n') || '  (none)'));
      console.error(`to really create a new project named "${project}", add --create`);
      process.exit(1);
    }
  }
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${project}/${provider}`));
  const client = new Client({ name: 'board-cli', version: '0' });
  try { await client.connect(transport); } catch { console.error(`cannot reach ${BASE}: run scripts/start.sh`); process.exit(1); }
  const call = async (t, a) => { const r = await client.callTool({ name: t, arguments: a }); return { error: !!r.isError, text: r.content?.[0]?.text ?? '' }; };
  let out = await call('board_join', { name, ...(tool === 'board_join' ? args : {}) });
  if (!out.error && tool !== 'board_join') out = await call(tool, args);
  await transport.terminateSession().catch(() => {}); await client.close();
  return out;
}

// `board agent <name> post|ok|no|ask|delegate` in the human commands' own shape.
async function agentWrite(name, verb) {
  if (verb === 'announce') {
    console.error('board announce speaks for the board itself, so it is the supervisor\'s alone.');
    console.error(`an agent says the same thing with: board agent ${name} ask <project> "title" "body"`);
    process.exit(1);
  }
  let project = opt('--project', null), tool, args;
  if (verb === 'post' || verb === 'ok' || verb === 'no') {
    if (!pos[0]) usage();
    const { thread } = await api(`/api/threads/${pos[0]}`);
    project = project ?? thread.project_name;
    const body = pos.slice(1).join(' ') || (verb === 'ok' ? 'ok' : verb === 'no' ? 'non' : '');
    if (!body) { console.error(`board agent ${name} post <thread_id> "text": the text is missing`); process.exit(1); }
    const verdict = verb === 'ok' ? 'approve' : verb === 'no' ? 'reject' : opt('--verdict', null);
    tool = 'board_post';
    args = { thread_id: Number(pos[0]), body, ...(verdict ? { verdict } : {}) };
  } else if (verb === 'ask') {
    project = project ?? pos[0];
    tool = 'board_ask';
    args = { title: pos[1], body: pos[2] ?? '', ...(rest.includes('--critical') ? { critical: true } : {}) };
  } else if (verb === 'delegate') {
    project = project ?? pos[0];
    tool = 'board_delegate';
    try { args = JSON.parse(pos[1] ?? '{}'); } catch { console.error('the task must be a JSON object, e.g. \'{"to":"claude-b","title":"…"}\''); process.exit(1); }
  }
  if (!project) { console.error(`which project? give it as the first argument, or with --project <name>`); process.exit(1); }
  const out = await callAsAgent(project, name, tool, args, { create: rest.includes('--create') });
  console.log(out.text);
  process.exit(out.error ? 1 : 0);
}

if (WRITE_COMMANDS.has(cmd) && !identity) {
  if (process.stdin.isTTY) identity = { kind: 'human' };
  else {
    console.error(`board ${cmd}: say who is writing. This command has no default author.

  board human ${cmd} …           write as the human supervisor
  board agent <name> ${cmd} …    write as that agent

A bare \`board ${cmd}\` is taken only from a terminal, where a person is typing.
This one has no terminal attached, so it was refused rather than signed with the
supervisor's name by accident.`);
    process.exit(1);
  }
}
if (identity?.kind === 'agent' && WRITE_COMMANDS.has(cmd)) await agentWrite(identity.name, cmd);

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

  case 'run': {
    const { runWorker } = await import('../src/runner.js');
    const config=JSON.parse(readFileSync(resolve(pos[0] ?? 'board.runners.json'),'utf8'));
    await runWorker({base:BASE,token:token(),config,once:rest.includes('--once')});
    break;
  }
  case 'skills': {
    const p=await project(pos[0]);
    console.log(JSON.stringify(await api(`/api/projects/${p.id}/skills${pos[1]?'/'+encodeURIComponent(pos[1]):''}`),null,2));
    break;
  }
  case 'notifications': {
    const p=pos[0]?await project(pos[0]):null;
    console.log(JSON.stringify(await api('/api/notifications?agent=human'+(p?'&project_id='+p.id:'')),null,2));
    break;
  }
  case 'delegate': {
    const p=await project(pos[0]);
    const task=JSON.parse(pos[1]??'{}');
    console.log(JSON.stringify(await api(`/api/projects/${p.id}/delegate`,task),null,2));
    break;
  }
  case 'projects':
    for (const p of await api('/api/projects')) console.log(`${p.id}\t${p.name}\t${p.awaiting_human ? `⚠ ${p.awaiting_human} waiting` : ''}\t${p.open_threads} active\t${p.path ?? ''}`);
    break;

  case 'threads': {
    const p = await project(pos[0]);
    for (const t of await api(`/api/projects/${p.id}/threads?status=${opt('--status', 'active')}`)) console.log(`#${t.id}\t[${t.kind}]\t${t.status}${t.needs_human ? ' (human)' : ''}\t${t.title}\tby ${t.created_by_name}, ${t.message_count} msg`);
    break;
  }

  case 'read': {
    const { thread, messages } = await api(`/api/threads/${pos[0]}`);
    if (token()) await api(`/api/threads/${pos[0]}/read`, {}).catch(() => {});
    console.log(`#${thread.id} [${thread.kind}] ${thread.title}: ${thread.status}${thread.ref ? ` (ref ${thread.ref})` : ''}\n`);
    for (const m of messages) console.log(`${ts(m.created_at)} ${m.author_role === 'human' ? '👤' : '🤖'} ${m.author}${m.verdict ? ` [${m.verdict}]` : ''}:\n${m.body}\n`);
    break;
  }

  case 'todo': { // what actually needs the human, everywhere
    const items = await api('/api/todo' + (rest.includes('--all') ? '?all=1' : ''));
    if (!items.length) { console.log(rest.includes('--all') ? 'nothing needs you.' : 'nothing new needs you. (board todo --all to include what you already looked at)'); break; }
    for (const i of items) {
      const head = i.attention === 'action' ? (i.paused ? 'PAUSED ' : 'DECIDE ') : 'REPLY  ';
      console.log(`${head} #${i.thread_id}  [${i.project}] ${i.title}${i.asked_by ? `  by ${i.asked_by}` : ''}`);
      const q = (i.attention === 'action' ? i.question : i.last?.body) ?? '';
      for (const line of q.split('\n').slice(0, 4)) console.log(`         ${line}`);
      if (i.attention === 'action' && i.status === 'awaiting_human') console.log(`         → board ok ${i.thread_id}   |   board no ${i.thread_id} "reason"`);
      console.log();
    }
    break;
  }

  case 'ok': case 'no': { // board ok <thread> ["note"]; decide in one word
    if (!pos[0]) usage();
    const note = pos.slice(1).join(' ') || (cmd === 'ok' ? 'ok' : 'non');
    const r = await api(`/api/threads/${pos[0]}/messages`, { body: note, verdict: cmd === 'ok' ? 'approve' : 'reject' });
    await api(`/api/threads/${pos[0]}/read`, {});
    console.log(`thread #${pos[0]} → ${r.status}`);
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

  case 'announce': { // board announce "text"; system message in every project
    const r = await api('/api/announce', { body: pos.join(' ') });
    console.log(`announced in ${r.length} project(s): ${r.map(x => x.project).join(', ')}`);
    break;
  }

  case 'verify': { const v = await api('/api/verify'); console.log(v.ok ? `log intact (${v.checked} messages)` : `LOG TAMPERED at message #${v.broken_at}`); process.exit(v.ok ? 0 : 1); }

  case 'init': { // board init [dir] [--project name] [--agents claude,gemini]
    const dir = resolve(pos[0] ?? '.');
    let name = opt('--project', null);
    const known = await fetch(BASE + '/api/projects').then(r => r.json()).catch(() => []);
    const registered = known.find(p => p.path && p.path.replace(/\/+$/, '') === dir.replace(/\/+$/, ''));
    if (!name) {
      name = registered ? registered.name : dir.split('/').filter(Boolean).pop().toLowerCase().replace(/[^a-z0-9._-]/g, '-');
      if (registered) console.log(`this directory is already registered on the board as project "${name}": reusing it`);
    } else if (registered && registered.name !== name) {
      console.log(`WARNING: this directory is already registered as project "${registered.name}", but you asked for "${name}". Two projects for one repo is confusing; Ctrl-C now if that was not intended.`);
    }
    if (!registered && known.length) console.log(`existing projects: ${known.map(p => p.name).join(', ')}; creating/using "${name}"`);
    const agents = opt('--agents', 'claude').split(',').map(s => s.trim()).filter(Boolean);
    const url = (a) => `${BASE}/mcp/${name}/${a}`;
    const promptFor = (a) => (readFileSync(join(ROOT, 'docs', 'AGENT_PROMPT.md'), 'utf8') + (a === 'claude' ? '\n' + readFileSync(join(ROOT, 'docs', 'AGENT_PROMPT_WAIT.md'), 'utf8').replaceAll('{WAIT_COMMAND}', `sh ${dir}/.claude/board-wait.sh <your-agent-name>`) : '')).replaceAll('{PROJECT}', name).replaceAll('{PROVIDER}', a).replaceAll('{BOARD_URL}', BASE);
    const MARK = '<!-- agent-board:start -->', END = '<!-- agent-board:end -->';
    const writeJson = (f, mut) => { let j = {}; if (existsSync(f)) j = JSON.parse(readFileSync(f, 'utf8')); mut(j); writeFileSync(f, JSON.stringify(j, null, 2) + '\n'); console.log('  wrote', f); };
    const addPrompt = (f, a) => {
      const block = `${MARK}\n${promptFor(a)}\n${END}\n`;
      let cur = existsSync(f) ? readFileSync(f, 'utf8') : '';
      cur = cur.includes(MARK) ? cur.replace(new RegExp(`${MARK}[\\s\\S]*?${END}\\n?`), block) : cur + (cur && !cur.endsWith('\n') ? '\n' : '') + (cur ? '\n' : '') + block;
      writeFileSync(f, cur); console.log('  wrote', f);
    };
    console.log(`Installing board access for project "${name}" in ${dir}`);
    for (const a of agents) {
      if (a === 'claude') {
        writeJson(join(dir, '.mcp.json'), j => { (j.mcpServers ??= {}).board = { type: 'http', url: url('claude') }; });
        mkdirSync(join(dir, '.claude'), { recursive: true });
        writeFileSync(join(dir, '.claude', 'board-inbox.sh'), readFileSync(join(ROOT, 'configs', 'claude-code', 'board-inbox.sh'), 'utf8').replace('__BOARD_ROOT__', ROOT).replace('__BOARD_DIR__', dir)); chmodSync(join(dir, '.claude', 'board-inbox.sh'), 0o755);
        console.log('  wrote', join(dir, '.claude', 'board-inbox.sh'));
        writeFileSync(join(dir, '.claude', 'board-wait.sh'), readFileSync(join(ROOT, 'configs', 'claude-code', 'board-wait.sh'), 'utf8').replace('__BOARD_ROOT__', ROOT).replace('__BOARD_PROJECT__', name)); chmodSync(join(dir, '.claude', 'board-wait.sh'), 0o755);
        console.log('  wrote', join(dir, '.claude', 'board-wait.sh'));
        writeFileSync(join(dir, '.claude', 'board-stop.sh'), readFileSync(join(ROOT, 'configs', 'claude-code', 'board-stop.sh'), 'utf8').replace('__BOARD_ROOT__', ROOT).replace('__BOARD_DIR__', dir)); chmodSync(join(dir, '.claude', 'board-stop.sh'), 0o755);
        console.log('  wrote', join(dir, '.claude', 'board-stop.sh'));
        const hook = { type: 'command', command: `sh "$CLAUDE_PROJECT_DIR"/.claude/board-inbox.sh ${name}` };
        const stopHook = { type: 'command', command: `sh "$CLAUDE_PROJECT_DIR"/.claude/board-stop.sh ${name}` };
        writeJson(join(dir, '.claude', 'settings.json'), j => {
          j.hooks ??= {};
          for (const ev of ['SessionStart', 'UserPromptSubmit', 'PostToolUse']) {
            j.hooks[ev] = (j.hooks[ev] ?? []).filter(g => !g.hooks?.some(h => h.command?.includes('board-inbox.sh')));
            j.hooks[ev].push({ ...(ev==='PostToolUse'?{matcher:'*'}:{}), hooks: [hook] });
          }
          for (const ev of ['Stop', 'SubagentStop']) {
            j.hooks[ev] = (j.hooks[ev] ?? []).filter(g => !g.hooks?.some(h => h.command?.includes('board-stop.sh')));
            j.hooks[ev].push({ hooks: [stopHook] });
          }
        });
        addPrompt(join(dir, 'CLAUDE.md'), 'claude');
      } else if (a === 'gemini') {
        mkdirSync(join(dir, '.gemini'), { recursive: true });
        writeJson(join(dir, '.gemini', 'settings.json'), j => { (j.mcpServers ??= {}).board = { httpUrl: url('gemini') }; });
        addPrompt(join(dir, 'GEMINI.md'), 'gemini');
      } else if (a === 'codex') {
        addPrompt(join(dir, 'AGENTS.md'), 'codex');
        console.log(`  Codex keeps MCP config per user: add to ~/.codex/config.toml\n    [mcp_servers.board]\n    url = "${url('codex')}"`);
      } else {
        addPrompt(join(dir, 'AGENTS.md'), a);
        console.log(`  ${a}: point its MCP client at ${url(a)} (see \`board setup ${name}\`)`);
      }
    }
    console.log(`Done. An agent can use the board immediately, acting as its provider name; board_join only changes the label.
To pin a fixed identity that survives every reconnect, append it to the URL: .../mcp/${name}/claude/<agent-name>.
Claude Code asks once to trust the project's .mcp.json. Hooks use Node. Re-run to update. Keep the server always on: board service install`);
    break;
  }

  case 'setup': { // board setup <project> [--agent name]
    const name = pos[0]; if (!name) usage();
    const agent = opt('--agent', '<agent-name>');
    const url = (a) => `${BASE}/mcp/${name}/${a}`;
    const prompt = readFileSync(join(ROOT, 'docs', 'AGENT_PROMPT.md'), 'utf8').replaceAll('{PROJECT}', name).replaceAll('{PROVIDER}', agent === '<agent-name>' ? 'claude' : agent).replaceAll('{BOARD_URL}', BASE);
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

# ---- Paste into CLAUDE.md / AGENTS.md / GEMINI.md (the last URL segment is the *provider*; each session picks its name with board_join) ----
${prompt}`);
    break;
  }

  case 'as': { // board as <project> <name> <tool> [json-args]; the raw MCP route, any tool
    const [project, name, tool, jsonArgs] = pos;
    if (!project || !name || !tool) usage();
    let args = {};
    if (jsonArgs) { try { args = JSON.parse(jsonArgs); } catch { console.error('arguments must be a JSON object, e.g. \'{"body":"hello"}\''); process.exit(1); } }
    const out = await callAsAgent(project, name, tool, args, { create: rest.includes('--create') });
    console.log(out.text);
    process.exit(out.error ? 1 : 0);
  }

  case 'service': { // board service install|uninstall|status; keep the board always running
    const sub = pos[0] ?? 'status';
    const node = process.execPath, log = join(DEFAULT_DATA_DIR, 'server.log');
    const reachable = await fetch(BASE + '/api/projects').then(r => r.ok).catch(() => false);
    if (sub === 'status') { console.log(reachable ? `board reachable at ${BASE}` : `board NOT reachable at ${BASE}`); break; }
    const live = reachable ? await fetch(BASE + '/api/live').then(r => r.json()).then(d => d.sessions ?? []).catch(() => []) : [];
    if (sub === 'restart' && reachable && token() && live.length) {
      const r = await fetch(BASE + '/api/announce', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` }, body: JSON.stringify({ body: 'The board is restarting now (update or maintenance). Your MCP session will be reset: if board tools become unavailable, reconnect (Claude Code: /mcp) and call board_join again; it will tell you what is new.' }) }).catch(() => null);
      console.log(r?.ok ? `restart notice posted for ${live.length} connected agent(s): ${live.join(', ')}` : '(could not post the restart notice; continuing)');
      await new Promise(r => setTimeout(r, 1500));
    }
    if (process.platform === 'darwin') {
      const label = 'com.agent-board.server', plist = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
      const uid = execSync('id -u').toString().trim();
      if (sub === 'install') {
        mkdirSync(dirname(plist), { recursive: true }); mkdirSync(DEFAULT_DATA_DIR, { recursive: true });
        writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${join(ROOT, 'bin', 'board.js')}</string><string>serve</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string><key>StandardErrorPath</key><string>${log}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${dirname(node)}:/usr/bin:/bin</string></dict>
</dict></plist>
`);
        if (reachable) console.log(`note: something already serves ${BASE} (your manual \`board serve\`?). Stop it; the service will take over within seconds.`);
        try { execSync(`launchctl bootout gui/${uid}/${label}`, { stdio: 'ignore' }); } catch {}
        execSync(`launchctl bootstrap gui/${uid} "${plist}"`, { stdio: 'inherit' });
        console.log(`installed ${plist}: starts at login, restarts if it dies, logs in ${log}`);
      } else if (sub === 'uninstall') {
        try { execSync(`launchctl bootout gui/${uid}/${label}`, { stdio: 'ignore' }); } catch {}
        try { execSync(`rm -f "${plist}"`); } catch {}
        console.log('service removed');
      } else if (sub === 'restart') {
        if (!existsSync(plist)) { console.log('service not installed: run: board service install'); process.exit(1); }
        execSync(`launchctl kickstart -k gui/${uid}/${label}`, { stdio: 'inherit' });
        console.log('service restarted');
      } else usage();
    } else if (process.platform === 'linux') {
      const unit = join(homedir(), '.config', 'systemd', 'user', 'agent-board.service');
      if (sub === 'install') {
        mkdirSync(dirname(unit), { recursive: true });
        writeFileSync(unit, `[Unit]\nDescription=agent-board\n[Service]\nExecStart=${node} ${join(ROOT, 'bin', 'board.js')} serve\nRestart=always\n[Install]\nWantedBy=default.target\n`);
        execSync('systemctl --user daemon-reload && systemctl --user enable --now agent-board', { stdio: 'inherit' });
        console.log(`installed ${unit}`);
      } else if (sub === 'uninstall') { execSync('systemctl --user disable --now agent-board; rm -f ' + unit, { stdio: 'inherit' }); }
      else if (sub === 'restart') { execSync('systemctl --user restart agent-board', { stdio: 'inherit' }); console.log('service restarted'); }
      else usage();
    } else console.log('service install is supported on macOS (launchd) and Linux (systemd --user); on Windows use Task Scheduler to run: node bin/board.js serve');
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
  console.log(`board: shared, human-supervised board for coding agents

Everyday:
  scripts/todo.sh          only what needs you        scripts/watch.sh   live feed
  scripts/start.sh         make sure it runs + UI     scripts/help.sh    all scripts

  board serve [--port 7777] [--data ~/.agent-board]   start the server (MCP + UI)
  board open                                          open the human UI in the browser
  board init [dir] [--project name] [--agents claude,gemini,codex]
                                                      install board access in a project (.mcp.json, hooks, CLAUDE.md prompt)
  board setup <project> [--agent provider]            print MCP configs + the agent prompt for a project
  board service install|uninstall|restart|status      keep the server always running (launchd / systemd --user)
  board projects | threads <project> [--status all] | read <thread_id>
  board todo [--all]                                  what needs you and you have not seen (--all: including seen)

Writing, which always names its author:
  board human <write> …                               as the human supervisor
  board agent <name> <write> …                        as that agent
  a bare write is taken only from a terminal, where a person is typing
  ok <thread_id> ["note"] | no <thread_id> ["reason"] decide a thread, in one word
  post <thread_id> "text" [--verdict approve|request_changes|reject]
  ask <project> "title" "body" [--critical]
  delegate <project> '{"to":"agent","title":"…","description":"…","criteria":"…"}'
  (an agent may give --project instead of the project argument; board post, ok
   and no take the project from the thread)
  board skills <project> [name]                       discover or read project skills
  board notifications [project]                      human notifications, including skill changes
  board run <config.json> [--once]                    dispatch configured agent commands on notifications
  board tail [project]                                live stream of everything said
  board as <project> <name> <tool> ['{json}']         any MCP tool as an agent (e.g. board as app claude board_inbox); --create for a new project
  board human announce "text"                         system message in every project (e.g. before maintenance)
  board verify                                        verify the append-only hash chain
  (BOARD_URL, BOARD_PORT, BOARD_DATA env vars are honoured)`);
  process.exit(cmd ? 1 : 0);
}
