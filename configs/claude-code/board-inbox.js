import { mkdirSync,readFileSync,readdirSync,writeFileSync,renameSync,rmSync,statSync } from 'node:fs';
import { waiterFileAlive } from './liveness.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const project=process.argv[2];
const installed=process.argv[3];
const waitCmd=installed?`sh ${installed}/.claude/board-wait.sh <your-agent-name>`:'sh "$CLAUDE_PROJECT_DIR"/.claude/board-wait.sh <your-agent-name>';
async function main() {
  let input=''; for await(const chunk of process.stdin) input+=chunk;
  const hook=JSON.parse(input||'{}');
  if(!project) return;
  // A session that has just started is not reachable while idle until its waiter runs.
  // Reachability. A waiter publishes a liveness file while it runs; without one,
  // this session hears nothing while it is idle and would not otherwise know.
  // Collected instead of printed: on PostToolUse the only valid stdout is one JSON
  // object, so every line joins the additionalContext there (printing it raw broke
  // the checkpoint JSON and Claude Code dropped the whole message).
  const notes=[];
  let unreachable=false;
  try {
    const wdir=join(tmpdir(),'agent-board-waiters');
    let live=[];
    try {
      live=readdirSync(wdir).filter(f=>f.startsWith(project+'.')).filter(f=>{
        if(waiterFileAlive(join(wdir,f))) return true;
        try {rmSync(join(wdir,f),{force:true});} catch {} return false;
      });
    } catch {}
    unreachable=!live.length;
  } catch {}
  if(hook.hook_event_name==='SessionStart') notes.push('[board] Stay reachable while idle: once you have your agent name, start `'+waitCmd+'` as a background task, and start it again each time it ends.');
  const base=process.env.BOARD_URL||'http://127.0.0.1:7777';
  const key=createHash('sha256').update(`${base}/${project}/${hook.session_id||'default'}`).digest('hex');
  const dir=join(tmpdir(),'agent-board-cursors'); mkdirSync(dir,{recursive:true});
  const path=join(dir,key),lock=path+'.lock';
  try {mkdirSync(lock);} catch {
    try {if(Date.now()-statSync(lock).mtimeMs<30000)return;rmSync(lock,{recursive:true,force:true});mkdirSync(lock);}catch{return;}
  }
  try {
    let saved={id:0,at:0,warnAt:0}; try {saved=JSON.parse(readFileSync(path,'utf8'));} catch {}
    // The reachability reminder repeats at most every 10 minutes per session: saying it
    // at every checkpoint burned tokens without adding information.
    if(unreachable&&hook.hook_event_name!=='SessionStart'&&Date.now()-(saved.warnAt||0)>600000) {
      notes.push('[board] You are NOT reachable while idle: no waiter is running. Start one as a BACKGROUND task and start it again each time it ends: '+waitCmd);
      saved.warnAt=Date.now();
    }
    if(hook.hook_event_name==='PostToolUse'&&Date.now()-saved.at<15000) return;
    const res=await fetch(`${base}/api/projects/${encodeURIComponent(project)}/messages?since=${saved.id}&limit=20`,{signal:AbortSignal.timeout(1500)});
    if(!res.ok) return;
    const data=await res.json();
    if(data.messages.length||!saved.at) {
      // Counters plus a glimpse: the agent fetches full content itself with board_inbox,
      // so pasting long previews here only burns tokens at every checkpoint.
      const text=`[board] ${data.messages.length} new messages${data.truncated?' (more available)':''}. Check board_notifications and board_inbox at this checkpoint; continue independent work after delegating.\n`+
        data.messages.slice(-3).map(m=>`#${m.thread_id} ${m.author}: ${m.body.slice(0,100).replace(/\s+/g,' ')}`).join('\n');
      notes.push(text);
    }
    const temp=path+`.${process.pid}`; writeFileSync(temp,JSON.stringify({id:data.last_id,at:Date.now(),warnAt:saved.warnAt||0})); renameSync(temp,path);
  } finally {rmSync(lock,{recursive:true,force:true});}
  if(!notes.length) return;
  if(hook.hook_event_name==='PostToolUse') console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:notes.join('\n')}}));
  else console.log(notes.join('\n'));
}
await main().catch(()=>{}); // An unavailable board never breaks the agent's own work.
