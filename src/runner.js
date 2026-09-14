// Optional process supervisor. Commands come ONLY from the user's local configuration,
// never from a board message or a skill. No shell interpolation, one run per identity.
import { isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export function validateRunnerConfig(config) {
  if(!Array.isArray(config.agents)||!config.agents.length) throw new Error('config.agents must be a non-empty array');
  if(config.interval_ms!==undefined&&(!Number.isFinite(config.interval_ms)||config.interval_ms<1000||config.interval_ms>60000)) throw new Error('interval_ms must be 1000–60000');
  const identities=new Set();
  for(const a of config.agents) {
    if(!a.project||!a.agent||!a.cwd||!Array.isArray(a.command)||!a.command.length||a.command.some(x=>typeof x!=='string')) throw new Error('each agent needs project, agent, cwd and command (argv array)');
    if(!isAbsolute(a.cwd)) throw new Error('cwd must be absolute');
    const key=`${a.project}/${a.agent}`;
    if(identities.has(key)) throw new Error('duplicate runner identity'); identities.add(key);
    if(a.max_runs_per_hour!==undefined&&(!Number.isInteger(a.max_runs_per_hour)||a.max_runs_per_hour<1||a.max_runs_per_hour>300)) throw new Error('max_runs_per_hour must be 1–300');
    if(a.timeout_seconds!==undefined&&(!Number.isFinite(a.timeout_seconds)||a.timeout_seconds<1||a.timeout_seconds>3500)) throw new Error('timeout_seconds must be 1–3500');
  }
}
export async function executeAgent(entry,prompt,{base,signal,onOutput=()=>{}}={}) {
  return new Promise(resolve=> {
    if(signal?.aborted) return resolve({success:false,error:'runner stopped'});
    const child=spawn(entry.command[0],entry.command.slice(1),{cwd:entry.cwd,shell:false,detached:process.platform!=='win32',
      env:{...process.env,BOARD_URL:base,BOARD_PROJECT:entry.project,BOARD_AGENT:entry.agent},stdio:['pipe','pipe','pipe']});
    let failure=null,settled=false,killTimer;
    const kill=sig=> {try {if(process.platform==='win32') child.kill(sig); else process.kill(-child.pid,sig);}catch{}};
    const stop=()=>{failure=signal?.aborted?'runner stopped':'execution timed out';kill('SIGTERM');killTimer=setTimeout(()=>kill('SIGKILL'),2000);};
    const timer=setTimeout(stop,(entry.timeout_seconds??300)*1000);
    signal?.addEventListener('abort',stop,{once:true});
    const done=r=> {if(settled)return;settled=true;clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',stop);resolve(r);};
    child.on('error',e=>done({success:false,error:e.message}));
    child.on('close',(code,sig)=>done({success:code===0&&!failure,error:failure||(code===0?null:`exit ${code??sig}`)}));
    child.stdout.on('data',c=>onOutput(c.toString())); child.stderr.on('data',c=>onOutput(c.toString()));
    child.stdin.on('error',()=>{}); child.stdin.end(prompt);
  });
}
export async function runWorker({base,token,config,once=false,signal:externalSignal,onOutput=console.log}) {
  validateRunnerConfig(config);
  if(!token) throw new Error('board run requires the local human token');
  const controller=new AbortController(); const stop=()=>controller.abort();
  process.once('SIGINT',stop);process.once('SIGTERM',stop);externalSignal?.addEventListener('abort',stop,{once:true});
  if(externalSignal?.aborted) controller.abort();
  const request=async(path,body)=> {
    const r=await fetch(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
    const result=await r.json();if(!r.ok)throw new Error(result.message??result.error);return result;
  };
  const active=new Map();
  const tick=async entry=> {
    const key=`${entry.project}/${entry.agent}`;
    if(active.has(key)) return;
    const work=(async()=> {
      const projects=await request('/api/projects');const p=projects.find(p=>p.name===entry.project);
      if(!p) throw new Error(`unknown project ${entry.project}`);
      const batch=await request(`/api/projects/${p.id}/dispatch`,{agent:entry.agent,seconds:(entry.timeout_seconds??300)+30,max_runs_per_hour:entry.max_runs_per_hour??30});
      if(!batch) return;
      const prompt=`Continue as ${entry.agent} on project ${entry.project}. Use board_status, board_notifications and board_tasks for current state.\nThese durable notifications triggered this follow-up (IDs may repeat after a crash; check current task state before repeating actions):\n${JSON.stringify(batch.notifications)}\nAccept offered tasks before doing them. Continue independent work after delegating. Complete tasks with a verified result, or record a blocking reason and handoff. Do not wait or poll for another agent.\n`;
      // Pause during execution also terminates a supervised process at the next health check.
      const runControl=new AbortController();const abort=()=>runControl.abort();controller.signal.addEventListener('abort',abort,{once:true});if(controller.signal.aborted) runControl.abort();
      const health=setInterval(async()=> {
        try { const d=await request(`/api/projects/${p.id}`); const member=d.members.find(a=>a.name===entry.agent);if(d.project.archived||!member||member.paused_reason) runControl.abort(); }
        catch {runControl.abort();}
      },2000);
      try {
        const result=await executeAgent(entry,prompt,{base,signal:runControl.signal,onOutput:text=>onOutput(`[${key}] ${text}`)});
        await request(`/api/projects/${p.id}/dispatch-finish`,{lease_token:batch.lease_token,...result});
      } finally {clearInterval(health);controller.signal.removeEventListener('abort',abort);}
    })().catch(e=>onOutput(`[${key}] ${e.message}`)).finally(()=>active.delete(key));
    active.set(key,work);
  };
  try {
    if(controller.signal.aborted) return;
    do {
      for(const entry of config.agents) await tick(entry);
      if(once) {await Promise.all(active.values());break;}
      await delay(Math.max(1000,config.interval_ms??2000),undefined,{signal:controller.signal}).catch(()=>{});
    } while(!controller.signal.aborted);
  } finally {controller.abort();await Promise.all(active.values());process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);externalSignal?.removeEventListener('abort',stop);}
}
