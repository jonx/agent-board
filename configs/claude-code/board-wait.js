import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
// Wakes an idle agent session: prints what this agent has not read, then blocks
// until the board holds something new, prints that and exits. Run as a
// BACKGROUND task; the end of a background task is what re-invokes an idle
// Claude Code session, so the same one command is the whole cycle: it hands you
// the unread, and running it again both acknowledges nothing and waits afresh.
// While it runs it holds a liveness file, which the inbox hook reads to tell a
// session whether it is reachable at all.
// Read-only by construction: it only GETs /api/projects and /api/notifications,
// never acknowledges, never posts. The agent acknowledges with board_receive.
const [project, agent] = process.argv.slice(2);
const base = process.env.BOARD_URL || 'http://127.0.0.1:7777';
const interval = Math.max(1000, Number(process.env.BOARD_WAIT_INTERVAL_MS) || 15000);
if (!project || !agent) { console.error('usage: board-wait <project> <agent-name>'); process.exit(2); }
const get = async (path) => { const r = await fetch(base + path, { signal: AbortSignal.timeout(5000) }); if (!r.ok) throw new Error(`${r.status}`); return r.json(); };
const pending = async () => {
  const pr = (await get('/api/projects')).find(p => p.name === project);
  if (!pr) throw new Error(`project "${project}" does not exist on the board`);
  return get(`/api/notifications?project_id=${pr.id}&agent=${encodeURIComponent(agent)}`);
};
const alive = join(tmpdir(), 'agent-board-waiters', `${project}.${agent}`.replace(/[^A-Za-z0-9._-]/g, '_'));
mkdirSync(dirname(alive), { recursive: true });
const touch = () => { try { writeFileSync(alive, String(process.pid)); } catch {} };
const forget = () => { try { rmSync(alive, { force: true }); } catch {} };
touch();
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => { forget(); process.exit(0); });
process.on('exit', forget);

const show = (list, lead) => {
  console.log(lead);
  for (const n of list) console.log(`#${n.thread_id ?? '-'} (${n.kind}) ${String(n.body ?? '').replace(/\s+/g, ' ').slice(0, 300)}`);
};

let seen = null;
for (;;) {
  try {
    const now = await pending();
    if (seen === null) {
      // One command is the whole cycle. Printing while still blocked would help
      // nobody, because this output only reaches an idle session when the task
      // ends, so anything already unread ends it at once.
      if (now.length) {
        show(now, `[board] ${now.length} unread for ${agent}, waiting since before this started:`);
        console.log('Read board_inbox, act, confirm with board_receive, then start this again. Without board_receive it ends at once again, which is the point.');
        process.exit(0);
      }
      seen = new Set();
    }
    const fresh = now.filter(n => !seen.has(n.id));
    if (fresh.length) {
      console.log(`[board] ${fresh.length} new notification${fresh.length > 1 ? 's' : ''} for ${agent}:`);
      for (const n of fresh) console.log(`#${n.thread_id ?? '-'} (${n.kind}) ${String(n.body ?? '').replace(/\s+/g, ' ').slice(0, 300)}`);
      console.log('Read board_inbox, act, confirm with board_receive, then start this waiter again as a background task.');
      process.exit(0);
    }
  } catch (e) {
    if (seen === null && /does not exist/.test(e.message)) { console.error(e.message); process.exit(1); }
    // An unavailable board never ends the wait: a restart must not wake every agent.
  }
  await new Promise(r => setTimeout(r, interval));
}
