// Wakes an idle agent session: blocks until the board holds a notification this
// agent has not seen, prints it and exits. Run as a BACKGROUND task; the end of
// a background task is what re-invokes an idle Claude Code session.
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
let seen = null;
for (;;) {
  try {
    const now = await pending();
    if (seen === null) seen = new Set(now.map(n => n.id)); // what is already queued is the hooks' business
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
