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

// The agent name this session last acted under.
//
// Read from what the session RAN, never from what it wrote. A transcript holds
// prose as well as tool calls, and prose about the board looks exactly like a
// command to a regular expression: the first version of this took an agent name
// out of a sentence and told its own author he was called "worse". Only the
// input of a tool call is evidence that this session acted as an agent.
//
// Every pattern also demands what follows a real command, a board verb or a
// board tool, so that a sentence quoting the shape of one is not enough.
const NAME = String.raw`[A-Za-z0-9][\w.-]*`;
const PATTERNS = [
  // board-wait.sh <name>, and board-wait.js <project> <name>
  new RegExp(String.raw`board-wait\.sh\s+(${NAME})`, 'g'),
  new RegExp(String.raw`board-wait\.js\s+${NAME}\s+(${NAME})`, 'g'),
  new RegExp(String.raw`board\s+agent\s+(${NAME})\s+(?:post|ok|no|ask|delegate|announce)\b`, 'g'),
  new RegExp(String.raw`board\s+as\s+${NAME}\s+(${NAME})\s+board_[a-z_]+`, 'g'),
  new RegExp(String.raw`/mcp/[^/\s"]+/[^/\s"]+/(${NAME})`, 'g'),
  new RegExp(String.raw`board_join[^\n]{0,200}?["']name["']\s*:\s*["'](${NAME})["']`, 'g'),
];

// Every string inside the tool calls of a transcript, newest last. A tail cut
// mid-line is dropped, and a line that does not parse is skipped: missing a name
// costs a session nothing, inventing one holds up a stranger.
function toolInputs(text) {
  const out = [];
  const lines = text.split('\n');
  lines.shift();
  const collect = (value) => {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const walk = (node) => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (!node || typeof node !== 'object') return;
      if (node.type === 'tool_use' && node.input) collect(node.input);
      Object.values(node).forEach(walk);
    };
    walk(entry);
  }
  return out;
}

// The name a session works under recurs; a name it merely mentioned once, in an
// example or a test fixture, does not. Counting beats taking the newest match:
// this hook's author writes board commands about other agents all day, and the
// last one he happened to type is not who he is. Ties go to the most recent.
function agentName(text) {
  const seen = new Map();
  let order = 0;
  for (const input of toolInputs(text)) {
    for (const pattern of PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of input.matchAll(pattern)) {
        const name = match[1];
        const entry = seen.get(name) ?? { count: 0, last: 0 };
        entry.count += 1;
        entry.last = ++order;
        seen.set(name, entry);
      }
    }
  }
  let best = null;
  for (const [name, entry] of seen) {
    if (
      !best ||
      entry.count > best.count ||
      (entry.count === best.count && entry.last > best.last)
    ) {
      best = { name, ...entry };
    }
  }
  return best?.name ?? null;
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
