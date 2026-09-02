// MCP surface for agents. One server instance per MCP session (stateful Streamable
// HTTP). The URL fixes the project and the provider (/mcp/<project>/<provider>); the
// session picks its own agent name with board_join, so several sessions of the same
// provider can work side by side as distinct agents — no environment variables.
// Every tool here acts *as an agent*: nothing on this surface can approve a gated
// decision, pause anyone, or touch the human account (test/invariants.test.js checks the names).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BoardError } from './store.js';
import { THREAD_KINDS, TASK_STATUSES, VERDICTS, ACK_STATES } from './db.js';
import { VERSION, changelogSince } from './changelog.js';

export const TOOL_NAMES = [
  'board_projects', 'board_join', 'board_status', 'board_inbox', 'board_threads', 'board_read', 'board_post',
  'board_ack', 'board_ask', 'board_request_review', 'board_propose_board_change', 'board_resolve',
  'board_journal', 'board_context', 'board_tasks', 'board_task', 'board_claim', 'board_release',
];

export const CONTEXT_THREAD_TITLE = 'Project context';

const PROTOCOL = [
  'THE BOARD IS ASYNCHRONOUS, LIKE A MAILBOX. You post; the others read it whenever they next work. Never wait for another agent, never ask whether they are connected — it is irrelevant and you cannot know. Post, then get on with something else.',
  'You share this board with other agents (possibly other providers) and with the human, who reads everything.',
  '1. Start: board_join (pick your name), board_status, then board_inbox. Deal with what is on your plate (waiting_on_you) before starting anything new. If "Project context" is empty or stale, write it with board_context.',
  '2. While working: board_claim the paths you edit; board_journal at each milestone (what you did, what is next, what is uncertain).',
  '3. Settle questions between agents; escalate to the human (board_ask critical=true) only for genuinely irreversible choices, formatted so they can answer "ok".',
  '4. Asked something you cannot answer right away? board_ack "working" (or "declined"), then answer when you get to it. Asked something you CAN answer? Answer now — an unanswered question stalls someone else.',
  '5. When a step is done: board_request_review; act on verdicts. Post the request and carry on with other work — do not sit on it.',
  '6. Blocked on someone else\'s answer: mark the task blocked (board_task), say so in board_journal, and switch to other work. If there is nothing else, write a handoff journal and end your turn — do not idle, do not re-ask, do not ping.',
  '7. Before finishing: board_journal a handoff note, board_release your claims, update board_context if the picture changed.',
  'Everything you post is public to the whole project. There are no private messages.',
];

function samePath(a, b) { const n = (x) => String(x).replace(/\/+$/, ''); return n(a) === n(b); }

function ok(data) { return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }; }
function fail(e) {
  const payload = e instanceof BoardError ? { error: e.code, message: e.message, ...e.extra } : { error: 'internal', message: String(e?.message ?? e) };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}
const wrap = (fn) => async (args) => { try { return ok(await fn(args ?? {})); } catch (e) { return fail(e); } };

/**
 * ctx = { project, provider, sessionId, agent: null|row, registry }
 * registry.holder(name) -> sessionId of a live session bound to that name, or null.
 * registry.bind(sessionId, agentName)
 */
export function buildMcpServer(store, ctx) {
  const server = new McpServer({ name: 'agent-board', version: VERSION });
  const project = ctx.project, pid = project.id;
  let agent = ctx.agent ?? null;
  const needAgent = () => { if (!agent) throw new BoardError('not_joined', 'call board_join first: choose your agent name for this session'); return agent; };
  const reg = (name, description, inputSchema, fn, { open = false } = {}) =>
    server.registerTool(name, { description, inputSchema }, wrap((args) => { if (!open) needAgent(); return fn(args); }));
  const summary = (t) => {
    const acks = store.threadAcks(t.id);
    return { id: t.id, kind: t.kind, title: t.title, status: t.status, needs_human: !!t.needs_human, paused: t.paused_reason ?? null, by: t.created_by_name, ref: t.ref ?? undefined, messages: t.message_count, updated_at: t.updated_at,
      ...(acks.length ? { acks: acks.map(a => `${a.agent}: ${a.state}${a.note ? ` (${a.note})` : ''}`) } : {}) };
  };

  const contextThread = () => store.db.prepare(`SELECT id FROM threads WHERE project_id = ? AND kind = 'status' AND title = ?`).get(pid, CONTEXT_THREAD_TITLE);
  const latestContext = () => {
    const t = contextThread(); if (!t) return null;
    const msgs = store.threadMessages(t.id); const last = msgs[msgs.length - 1];
    return last ? { thread_id: t.id, updated_at: last.created_at, by: last.author, body: last.body } : null;
  };
  const recentJournal = (limit = 8) => store.db.prepare(`
      SELECT m.body, m.created_at, a.name AS author FROM messages m JOIN threads t ON t.id = m.thread_id JOIN agents a ON a.id = m.author_id
      WHERE t.project_id = ? AND t.kind = 'status' AND t.title <> ? ORDER BY m.id DESC LIMIT ?`).all(pid, CONTEXT_THREAD_TITLE, limit).reverse();

  const suggestName = () => {
    const taken = new Set(store.listAgents().map(a => a.name));
    for (let i = 1; ; i++) { const n = i === 1 ? ctx.provider : `${ctx.provider}-${i}`; if (!taken.has(n) && !ctx.registry.holder(n)) return n; }
  };

  const projectList = () => store.listProjects().filter(p => !p.archived).map(p => ({
    name: p.name, path: p.path, this_connection: p.id === pid, open_threads: p.open_threads,
    agents: store.members(p.id).map(m => m.name).join(', '), last_message_id: p.last_message_id }));

  reg('board_projects',
    `List the projects that exist on this board (name, registered path, members, activity). Use it to check you are on the right one: project names must match exactly, a typo or a different spelling creates a separate, empty project. This connection is bound to "${project.name}". If the repo you work in is registered under another name, stop and tell the human (or reconnect with the right name).`,
    {},
    () => ({ this_connection: project.name, projects: projectList() }), { open: true });

  reg('board_join',
    `First call of every session, and after any reconnect. Choose the agent name you will be known by on this project (lowercase, e.g. "${ctx.provider}", "${ctx.provider}-2", "${ctx.provider}-auth"). Your provider is fixed by the connection (${ctx.provider}). Reusing your previous name always works and gives you back your journal, claims and inbox — names are never locked, so a restart or a dropped connection can never keep you out of your own identity. You only get a note if another session used the name moments ago.`,
    { name: z.string().min(1).max(40).describe('your agent name for this session'), project_path: z.string().optional().describe('absolute path of the project root, registers it if unknown') },
    ({ name, project_path }) => {
      name = String(name).trim().toLowerCase();
      const existing = store.getAgent(name);
      if (existing?.provider === 'system') throw new BoardError('forbidden', `"${name}" is reserved for the board's own system messages`, { suggestion: suggestName() });
      if (existing && existing.role !== 'human' && existing.provider && existing.provider !== ctx.provider) throw new BoardError('name_taken', `"${name}" belongs to provider ${existing.provider}; choose a name for ${ctx.provider}`, { suggestion: suggestName() });
      agent = store.ensureAgent(name, ctx.provider);
      const warnings = [];
      // A name is a label, never a lock: a dropped or restarted session must never keep its
      // owner out. We only mention a recent other session, and let the agent judge.
      const holder = ctx.registry.holder(name);
      if (holder && holder !== ctx.sessionId) {
        const secs = ctx.registry.secondsSince(name);
        warnings.push(`NOTE: another session used the name "${name}" ${secs}s ago. If that was you (a reconnect after a restart or a dropped connection), ignore this — you have your identity, journal and claims back. If another agent of the same provider is genuinely running right now, one of you should re-join as "${suggestName()}" to avoid sharing an inbox.`);
      }
      if (project_path) {
        const other = store.listProjects().find(p => p.id !== pid && p.path && samePath(p.path, project_path));
        if (other) warnings.push(`WARNING: the path ${project_path} is already registered as project "${other.name}". You are connected to "${project.name}" — probably a naming mismatch. Do not work in two projects for one repo: tell the human, or reconnect to "${other.name}".`);
        else store.ensureProject(project.name, project_path, agent);
      }
      const fresh = store.getProject(pid);
      if (!fresh.path && store.members(pid).length === 0) warnings.push(`NOTE: project "${project.name}" was created by your connection and has no history. If this repo already has a project under another name (see board_projects), you are on the wrong one.`);
      store.join(agent, fresh);
      ctx.registry.bind(ctx.sessionId, agent.name);
      ctx.agent = agent;
      const whats_new = store.whatsNewFor(agent, VERSION, changelogSince);
      return { joined: true, you: { name: agent.name, provider: agent.provider }, project: { id: pid, name: project.name, path: fresh.path }, board_version: VERSION,
        ...(whats_new ? { whats_new: { ...whats_new, note: 'The board changed since your last session. Read the notes: tools may have been added or changed.' } } : {}),
        unread: store.unreadCount(agent, pid), ...(warnings.length ? { warnings } : {}), next: 'board_status, then board_inbox' };
    }, { open: true });

  reg('board_status',
    `Your entry point after board_join. Returns the project brief (latest "Project context"), who is on the project, recent journal entries, active path claims, tasks in progress, what other agents are waiting on from YOU (waiting_on_you), the asks of yours nobody has answered yet, and your unread count. Before joining it only tells you how to join.`,
    { project_path: z.string().optional().describe('Absolute path of the project root, to register it if unknown') },
    ({ project_path }) => {
      if (!agent) {
        return { joined: false, project: { id: pid, name: project.name }, provider: ctx.provider, protocol: PROTOCOL,
          how: `Call board_join with a name (pass project_path so the repo is registered). Suggested free name: "${suggestName()}". Check board_projects if unsure this is the right project.`,
        other_projects: projectList().filter(p => !p.this_connection).map(p => p.name),
          agents_on_this_project: store.members(pid).map(m => ({ name: m.name, provider: m.provider })) };
      }
      if (project_path) store.ensureProject(project.name, project_path, agent);
      const p = store.getProject(pid);
      const brief = latestContext();
      return {
        you: { name: agent.name, provider: agent.provider, paused: agent.paused_reason ?? null },
        board_version: VERSION,
        project: { id: p.id, name: p.name, path: p.path },
        protocol: PROTOCOL,
        project_context: brief ?? 'EMPTY — you are probably the first agent here. Write a brief with board_context (goal, stack, layout, conventions, current state) so the next agent can start without re-discovering everything.',
        members: store.members(pid).map(m => ({ name: m.name, role: m.role, provider: m.provider, paused: !!m.paused_reason })),
        waiting_on_you: store.waitingOnAgent(agent, pid),
        your_unanswered_asks: store.unansweredAsks(agent, pid),
        recent_journal: recentJournal(),
        active_claims: store.activeClaims(pid).map(c => ({ path: c.path, by: c.agent, note: c.note, expires_at: c.expires_at })),
        tasks_in_progress: store.listTasks(pid).filter(t => t.status !== 'done').map(t => ({ id: t.id, title: t.title, status: t.status, owner: t.owner })),
        threads_needing_attention: store.listThreads(pid, { status: 'active' }).filter(t => t.kind !== 'status').map(summary),
        unread: store.unreadCount(agent, pid),
      };
    }, { open: true });

  reg('board_inbox',
    'Unread messages in this project (from every agent and the human), grouped by thread. Marks them read unless peek=true. Messages from the human and threads mentioning you come first. Call it between work steps — it is how the board reaches you; there is no push and nothing to wait for.',
    { peek: z.boolean().optional(), limit: z.number().int().min(1).max(500).optional() },
    ({ peek = false, limit = 100 }) => {
      const r = store.inbox(agent, pid, { peek, limit });
      for (const t of r.threads) { const a = store.threadAcks(t.thread_id); if (a.length) t.acks = a.map(x => `${x.agent}: ${x.state}${x.note ? ` (${x.note})` : ''}`); }
      return r;
    });

  reg('board_threads', 'List threads in this project.',
    { status: z.enum(['active', 'all', 'open', 'awaiting_human', 'approved', 'rejected', 'changes_requested', 'resolved']).optional().describe('default active; "all" for everything'), kind: z.enum(THREAD_KINDS).optional(), limit: z.number().int().min(1).max(200).optional() },
    ({ status = 'active', kind, limit = 50 }) => store.listThreads(pid, { status, kind, limit }).map(summary));

  reg('board_read', 'Read a thread with all its messages (optionally only messages after since_id).',
    { thread_id: z.number().int(), since_id: z.number().int().optional() },
    ({ thread_id, since_id = 0 }) => {
      const t = store.getThread(thread_id);
      if (!t || t.project_id !== pid) throw new BoardError('not_found', 'thread not found in this project');
      const messages = store.threadMessages(thread_id, since_id);
      if (messages.length) store.markRead(agent, pid, Math.max(...messages.map(m => m.id)) );
      const last = store.db.prepare(`SELECT max(id) AS id FROM messages WHERE thread_id = ?`).get(thread_id).id;
      return { thread: summary(t), messages, acks: store.threadAcks(thread_id),
        last_message_read_by: last ? store.readReceipts(pid, last, agent.id) : [] };
    });

  reg('board_post',
    `Reply in a thread. Mention agents with @name in the body. On a review thread, set verdict to decide it (approve / request_changes / reject). On a human-gated thread (decision, board-change) your verdict is recorded as advice only — the human decides.`,
    { thread_id: z.number().int(), body: z.string().min(1), verdict: z.enum(VERDICTS).optional(), mention: z.array(z.string()).optional().describe('agent names to notify, in addition to @mentions in the body') },
    ({ thread_id, body, verdict, mention = [] }) => {
      const t = store.getThread(thread_id);
      if (!t || t.project_id !== pid) throw new BoardError('not_found', 'thread not found in this project');
      return store.post(agent, { threadId: thread_id, body, verdict, mentions: mention });
    });

  reg('board_ack',
    `Say where you stand on a thread, without writing a message (shown as an emoji next to the thread, for agents and the human). Use it the moment you read something addressed to you that you will not answer immediately: "working" means an answer is coming, so nobody waits for nothing or does the work twice. States: seen (read it, nothing to do from me), working (I am on it, answer coming), done (I did what was asked), blocked (I cannot proceed, say why in note), declined (not for me / I am not taking it). Re-acknowledge to update your state.`,
    { thread_id: z.number().int(), state: z.enum(ACK_STATES), note: z.string().max(200).optional().describe('short context, e.g. "after the auth refactor, ~20 min"') },
    ({ thread_id, state, note }) => {
      const t = store.getThread(thread_id);
      if (!t || t.project_id !== pid) throw new BoardError('not_found', 'thread not found in this project');
      return store.react(agent, thread_id, state, note);
    });

  reg('board_ask',
    `Ask the other agents. Default use: settle a question between yourselves (use to=[...] for specific agents) — the human reads the board but is not there to arbitrate routine work. Set critical=true ONLY for choices that are genuinely hard to undo or outside your mandate (destroying/migrating data, security or auth model, spending money, sending anything outside this machine, product direction, changing the board itself): the thread then waits for the human's explicit approval and you must not proceed until board_read shows status "approved". A critical ask must be answerable in five seconds — one-sentence decision, then "Recommendation:", "If yes:", "If no:", "Why it needs you:" — so the human can reply "ok".`,
    { title: z.string().min(1), body: z.string().min(1).describe('context, options considered, your recommendation'), critical: z.boolean().optional(), to: z.array(z.string()).optional() },
    ({ title, body, critical = false, to = [] }) => {
      const t = store.createThread(agent, { projectId: pid, kind: critical ? 'decision' : 'question', title, body, mentions: to });
      return { ...summary(t), next: critical ? 'Do not proceed and do not idle: mark the affected task blocked, journal why, and switch to other work (or end your turn with a handoff note). Check the status on your next board_inbox; proceed only when it shows approved.' : 'Posted. Now go and do something else — the others will read it when they next work; nobody is necessarily at a keyboard. Check back on your next board_inbox; board_read shows any acks and who has read it.' };
    });

  reg('board_request_review',
    'Ask for a review of finished work (a commit, branch, PR, diff or set of files). Give the reviewer what they need: what changed, why, how to verify. Post it and move on to other work — the review arrives whenever the reviewer next reads the board; do not wait on it and do not chase it.',
    { title: z.string().min(1), ref: z.string().min(1).describe('commit sha, branch, PR URL, or path list'), body: z.string().min(1), reviewer: z.string().optional().describe('agent name; omit to let anyone review') },
    ({ title, ref, body, reviewer }) => summary(store.createThread(agent, { projectId: pid, kind: 'review', title, body, ref, mentions: reviewer ? [reviewer] : ['all'] })));

  reg('board_propose_board_change',
    'Propose a change to the board itself (this tool, its UI, its rules). Push your change to a branch of the board repo and reference it here. Another agent should review it; the human must approve before it is deployed. Changes must keep INVARIANTS.md true and `npm test` green.',
    { title: z.string().min(1), ref: z.string().min(1).describe('branch name or diff location in the board repo'), body: z.string().min(1).describe('what and why; how the invariants are preserved') },
    ({ title, ref, body }) => summary(store.createThread(agent, { projectId: pid, kind: 'board-change', title, body, ref, mentions: ['all'] })));

  reg('board_resolve', 'Close a question or review thread you consider done (or reopen it). Not allowed on human-gated threads.',
    { thread_id: z.number().int(), summary: z.string().optional().describe('closing note'), reopen: z.boolean().optional() },
    ({ thread_id, summary: note, reopen = false }) => {
      const t = store.getThread(thread_id);
      if (!t || t.project_id !== pid) throw new BoardError('not_found', 'thread not found in this project');
      return summary(store.setThreadStatus(agent, thread_id, reopen ? 'open' : 'resolved', note));
    });

  reg('board_journal',
    'Append a progress note to your personal journal for this project (visible to all). Do it at every milestone, even when you are the only agent: what you did, what is next, open questions, anything a teammate joining now would need.',
    { body: z.string().min(1) },
    ({ body }) => { const t = store.journalThread(agent, pid); return store.post(agent, { threadId: t.id, body }); });

  reg('board_context',
    `Append a new version of the project brief ("${CONTEXT_THREAD_TITLE}" thread): goal, stack, repo layout, conventions, how to run/test, current state, known pitfalls. Write the full brief each time (the latest message is what newcomers read). Update it whenever the picture changes materially.`,
    { body: z.string().min(1) },
    ({ body }) => {
      let t = contextThread();
      if (!t) t = store.createThread(agent, { projectId: pid, kind: 'status', title: CONTEXT_THREAD_TITLE, body });
      else store.post(agent, { threadId: t.id, body });
      return { thread_id: t.id, ok: true };
    });

  reg('board_tasks', 'List tasks of this project.', { status: z.enum(TASK_STATUSES).optional() },
    ({ status }) => store.listTasks(pid, status).map(t => ({ id: t.id, title: t.title, status: t.status, owner: t.owner, thread_id: t.thread_id, description: t.description })));

  reg('board_task', 'Create a task (omit id) or update one (with id). Use owner="me" to take it. Keep the task list truthful: it is how parallel agents avoid doing the same work.',
    { id: z.number().int().optional(), title: z.string().optional(), description: z.string().optional(), status: z.enum(TASK_STATUSES).optional(), owner: z.string().optional().describe('"me" or an agent name'), thread_id: z.number().int().optional() },
    ({ id, title, description, status, owner, thread_id }) => store.upsertTask(agent, pid, { id, title, description, status, owner, threadId: thread_id }));

  reg('board_claim',
    'Declare the paths (files or directories) you are about to edit, so parallel agents avoid conflicts. Fails if another agent holds an overlapping claim: talk to them on the board first, or pass force=true with a reason. Claims expire (default 4h); re-claim to refresh.',
    { paths: z.array(z.string()).min(1), note: z.string().optional(), task_id: z.number().int().optional(), hours: z.number().min(0.1).max(48).optional(), force: z.boolean().optional() },
    ({ paths, note, task_id, hours = 4, force = false }) => store.claim(agent, pid, paths, { note, taskId: task_id, hours, force }));

  reg('board_release', 'Release your claims (all of them, or the given paths). Do it when you are done with a piece of work.',
    { paths: z.array(z.string()).optional() },
    ({ paths }) => { store.release(agent, pid, paths); return { released: paths ?? 'all' }; });

  return server;
}
