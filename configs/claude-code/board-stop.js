// Stop hook: a session that has used the board does not get to go idle unreachable.
//
// The waiter makes an agent reachable while it runs, and the inbox hook says so
// when none does. Both only speak while the agent is WORKING. The moment a
// session ends its turn without restarting its waiter it is unreachable, and no
// warning can ever reach it again: messages pile up and the human sees an agent
// doing nothing. This hook is the only place that can still speak at that moment.
//
// It blocks a stop exactly when all of these hold, and stays silent otherwise:
//   - the session has a board identity (its transcript shows it acting as one),
//   - no live waiter holds that identity's liveness file,
//   - this is not already a stop the hook prevented (stop_hook_active).
// A session that never touched the board is never blocked.
import { readFileSync, readdirSync, rmSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const project = process.argv[2];
const installed = process.argv[3];
const waitCmd = (name) =>
  installed ? `sh ${installed}/.claude/board-wait.sh ${name}` : `sh "$CLAUDE_PROJECT_DIR"/.claude/board-wait.sh ${name}`;

// The last 4 MiB of the transcript: enough to see this session's board usage
// without reading a long conversation in full.
function tail(path, bytes = 4 << 20) {
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - bytes);
    const fd = openSync(path, 'r');
    const buf = Buffer.alloc(Math.min(size, bytes));
    readSync(fd, buf, 0, buf.length, start);
    closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}

// The agent name this session last acted under. Every pattern must be a spelling
// that ONLY appears when reaching this board: a bare "name" field would match any
// tool call and hold up sessions that have nothing to do with the board, which is
// worse than the gap this hook closes. board_join carries its name in a JSON
// argument, so it is matched through the call itself rather than through the key.
function agentName(text) {
  const patterns = [
    /board-wait\.(?:sh|js)\s+(?:\S+\s+)?["']?([A-Za-z0-9][\w.-]*)/g,
    /board\s+agent\s+([A-Za-z0-9][\w.-]*)/g,
    /board\s+as\s+\S+\s+([A-Za-z0-9][\w.-]*)/g,
    /\/mcp\/[^/\s"]+\/[^/\s"]+\/([A-Za-z0-9][\w.-]*)/g,
    /board_join[^\n]{0,200}?["']name["']\s*:\s*["']([A-Za-z0-9][\w.-]*)["']/g,
  ];
  let found = null, at = -1;
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      if (m.index > at) { at = m.index; found = m[1]; }
    }
  }
  return found;
}

function waiterLive(name) {
  const dir = join(tmpdir(), 'agent-board-waiters');
  const wanted = `${project}.${name}`.replace(/[^A-Za-z0-9._-]/g, '_');
  let entries = [];
  try { entries = readdirSync(dir); } catch { return false; }
  for (const f of entries) {
    if (f !== wanted) continue;
    try { process.kill(Number(readFileSync(join(dir, f), 'utf8')), 0); return true; }
    catch { try { rmSync(join(dir, f), { force: true }); } catch {} return false; }
  }
  return false;
}

async function main() {
  if (!project) return;
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  let hook = {}; try { hook = JSON.parse(input || '{}'); } catch { return; }
  // Already prevented one stop: let this one through rather than loop.
  if (hook.stop_hook_active) return;
  if (!hook.transcript_path) return;
  const name = agentName(tail(hook.transcript_path));
  // No board identity in this session: not ours to hold up.
  if (!name) return;
  if (waiterLive(name)) return;
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason:
      `You are about to go idle as "${name}" with no board waiter running, which means unreachable: ` +
      `board messages for you will pile up unread and nothing will wake you, however long you sit there. ` +
      `Start it now as a BACKGROUND task, not in the foreground, and then finish your turn:\n\n` +
      `    ${waitCmd(name)}\n\n` +
      `It ends as soon as anything is unread, or blocks until something arrives and then ends; the end of a ` +
      `background task wakes this session. Each time it ends: read board_inbox, act, confirm with ` +
      `board_receive, start it again. If "${name}" is not your agent name on this board, start the waiter ` +
      `under the name that is. This check will not hold you up a second time.`,
  }));
}
main();
