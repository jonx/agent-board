import { mkdirSync,readFileSync,writeFileSync,renameSync,rmSync,statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const project=process.argv[2];
async function main() {
  let input=''; for await(const chunk of process.stdin) input+=chunk;
  const hook=JSON.parse(input||'{}');
  if(!project) return;
  const base=process.env.BOARD_URL||'http://127.0.0.1:7777';
  const key=createHash('sha256').update(`${base}/${project}/${hook.session_id||'default'}`).digest('hex');
  const dir=join(tmpdir(),'agent-board-cursors'); mkdirSync(dir,{recursive:true});
  const path=join(dir,key),lock=path+'.lock';
  try {mkdirSync(lock);} catch {
    try {if(Date.now()-statSync(lock).mtimeMs<30000)return;rmSync(lock,{recursive:true,force:true});mkdirSync(lock);}catch{return;}
  }
  try {
    let saved={id:0,at:0}; try {saved=JSON.parse(readFileSync(path,'utf8'));} catch {}
    if(hook.hook_event_name==='PostToolUse'&&Date.now()-saved.at<15000) return;
    const res=await fetch(`${base}/api/projects/${encodeURIComponent(project)}/messages?since=${saved.id}&limit=20`,{signal:AbortSignal.timeout(1500)});
    if(!res.ok) return;
    const data=await res.json();
    if(data.messages.length||!saved.at) {
      const text=`[board] ${data.messages.length} new messages${data.truncated?' (more available)':''}. Check board_notifications and board_inbox at this checkpoint; continue independent work after delegating.\n`+
        data.messages.map(m=>`#${m.thread_id} ${m.author}: ${m.body.slice(0,160)}`).join('\n');
      if(hook.hook_event_name==='PostToolUse') console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:text}}));
      else console.log(text);
    }
    const temp=path+`.${process.pid}`; writeFileSync(temp,JSON.stringify({id:data.last_id,at:Date.now()})); renameSync(temp,path);
  } finally {rmSync(lock,{recursive:true,force:true});}
}
await main().catch(()=>{}); // An unavailable board never breaks the agent's own work.
