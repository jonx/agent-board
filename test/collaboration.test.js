import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { Store } from '../src/store.js';
import { startServer } from '../src/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { runWorker, executeAgent, validateRunnerConfig } from '../src/runner.js';

function fixture(t,file=':memory:') {
  const s=new Store(openDatabase(file)); t.after(()=>s.db.close());
  const p=s.ensureProject('p'),a=s.ensureAgent('a','test'),b=s.ensureAgent('b','test');s.join(a,p);s.join(b,p);
  return {s,p,a,b,h:s.human()};
}
const offer=(s,p,a,to='b',extra={})=>s.delegate(a,p.id,{to,title:'Review',description:'Review commit abc',criteria:'Return verdict and verification',...extra});
const change=(s,p,a,t,state,extra={})=>s.updateDelegatedTask(a,p.id,{id:t.id,expected_version:t.version,state,...extra});

test('thread ack and priority pagination never consume unseen messages elsewhere',t=> {
  const {s,p,a,b,h}=fixture(t);
  const old=s.createThread(a,{projectId:p.id,kind:'question',title:'old',body:'older'});
  const recent=s.createThread(a,{projectId:p.id,kind:'question',title:'new',body:'newer'});
  s.react(b,recent.id,'seen');assert.equal(s.unreadCount(b,p.id),1);
  assert.deepEqual(s.readReceipts(p.id,s.threadMessages(old.id)[0].id),[]);
  s.post(h,{threadId:old.id,body:'urgent'});
  const top=s.inbox(b,p.id,{limit:1});assert.equal(top.threads[0].messages[0].author,'human');assert.equal(top.truncated,true);
  assert.equal(s.unreadCount(b,p.id),1);
  const next=s.inbox(b,p.id);assert.equal(next.threads[0].messages[0].body,'older');assert.equal(s.unreadCount(b,p.id),0);
  assert.ok(s.readReceipts(p.id,next.threads[0].messages[0].id).includes('b'));
});

test('delegation returns immediately, terminal result persists and receipt is separate',t=> {
  const {s,p,a,b}=fixture(t);
  let task=offer(s,p,a);assert.equal(task.state,'offered');
  const notice=s.notifications(b,p.id).find(n=>n.kind==='task.offered');assert.ok(notice);
  s.receiveNotifications(b,p.id,[notice.id]);assert.equal(s.taskDetail(p.id,task.id).state,'offered');
  assert.throws(()=>change(s,p,b,task,'done',{result:'verified'}),/invalid transition/);
  task=change(s,p,b,task,'accepted');
  assert.throws(()=>change(s,p,a,task,'doing'),/only the owner/);
  assert.throws(()=>change(s,p,b,{...task,version:1},'doing'),/task changed/);
  s.claim(b,p.id,['src/'],{taskId:task.id});
  task=change(s,p,b,task,'done',{result:'Inspected abc, tests pass, approve',ref:'abc'});
  assert.equal(task.state,'done');assert.equal(s.activeClaims(p.id).length,0);
  assert.ok(s.notifications(a,p.id).some(n=>n.kind==='task.done'));
  assert.throws(()=>change(s,p,b,task,'doing'),/terminal/);
  assert.equal(s.verifyChain().ok,true);
});

test('task assignment and transfer require ownership, and dependencies prevent cycles',t=> {
  const {s,p,a,b}=fixture(t);
  const legacy=s.upsertTask(a,p.id,{title:'legacy',owner:'me'});
  assert.throws(()=>s.upsertTask(b,p.id,{id:legacy.id,owner:'me'}),/already owned/);
  s.transferTask(a,p.id,{id:legacy.id,to:'b',reason:'handoff'});
  assert.equal(s.listTasks(p.id)[0].owner,'b');
  let first=offer(s,p,a);let second=offer(s,p,a,'a',{depends_on:[first.id],title:'Integration'});
  first=change(s,p,b,first,'accepted');second=change(s,p,a,second,'accepted');
  assert.throws(()=>change(s,p,a,second,'doing'),/dependencies/);
  assert.throws(()=>s.updateDelegatedTask(b,p.id,{id:first.id,expected_version:first.version,depends_on:[second.id]}),/cycle/);
  first=change(s,p,b,first,'done',{result:'reviewed'});
  assert.ok(s.notifications(a,p.id).some(n=>n.kind==='task.dependency'));
  second=change(s,p,a,second,'doing');assert.equal(second.state,'doing');
  assert.throws(()=>s.upsertTask(a,p.id,{id:second.id,status:'done'}),/board_task_update/);
});

test('failed/declined dependencies stay blocked, cancellation and overdue are explicit',t=> {
  const {s,p,a,b}=fixture(t);
  let first=offer(s,p,a,'b',{deadline:'2000-01-01T00:00:00Z'});
  s.sweepDelegations();s.sweepDelegations();assert.equal(s.notifications(a,p.id).filter(n=>n.kind==='task.overdue').length,1);
  let second=offer(s,p,a,'a',{depends_on:[first.id]});second=change(s,p,a,second,'accepted');
  first=change(s,p,b,first,'declined',{result:'Not available'});
  assert.throws(()=>change(s,p,a,second,'done',{result:'done'}),/dependencies/);
  second=change(s,p,a,second,'cancelled',{result:'No longer needed'});assert.equal(second.state,'cancelled');
});

test('skills retain versions, notify human without gated approval and record usage',t=> {
  const {s,p,a,b,h}=fixture(t);
  assert.equal(s.listSkills(p.id).length,4);
  const seed=s.readSkill(p.id,'review');assert.equal(seed.version,0);
  let sk=s.writeSkill(a,p.id,{name:'review',description:'Review changes',body:'Check permissions and test the failure.',reason:'Observed missing permission check',expected_version:0});
  assert.equal(sk.version,1);assert.equal(s.getThread(sk.thread_id).needs_human,0);
  assert.ok(s.notifications(h,p.id).some(n=>n.kind==='skill.updated'));
  assert.throws(()=>s.writeSkill(b,p.id,{name:'review',description:'x',body:'y',reason:'z',expected_version:0}),/skill changed/);
  sk=s.writeSkill(b,p.id,{name:'review',description:'Review changes',body:'Also verify callers.',reason:'Caller regression observed',expected_version:1});
  assert.match(s.readSkill(p.id,'review',1).body,/permissions/);
  assert.equal(s.readSkill(p.id,'review',0).body,seed.body);
  s.skillFeedback(a,p.id,{name:'review',version:2,outcome:'helped',evidence:'Found regression in caller'});
  assert.equal(s.readSkill(p.id,'review').feedback.length,1);
  assert.throws(()=>s.db.exec("UPDATE skill_versions SET body='tampered'"),/append-only/);
  assert.throws(()=>s.db.exec('DELETE FROM skill_feedback'),/append-only/);
  assert.equal(s.verifyChain().ok,true);
  const other=s.ensureProject('other');assert.equal(s.readSkill(other.id,'review').version,0);
});

test('pause and cross-project references apply to new operations',t=> {
  const {s,p,a,b,h}=fixture(t);const other=s.ensureProject('other');
  let task=offer(s,p,a);s.pauseAgent(h,b.id,'reviewing');
  assert.throws(()=>change(s,p,b,task,'accepted'),/paused/);
  assert.throws(()=>s.writeSkill(b,p.id,{name:'x',body:'x',description:'x',reason:'x',expected_version:0}),/paused/);
  assert.equal(s.reserveDelivery(h,p.id,'b'),null);
  s.pauseAgent(h,b.id,null);s.pauseThread(h,task.thread_id,'hold');
  assert.throws(()=>change(s,p,b,task,'accepted'),/paused/);
  assert.throws(()=>s.delegate(a,other.id,{to:'b',title:'x',description:'x',criteria:'x'}),/active project member/);
  assert.throws(()=>s.receiveNotifications(a,other.id,[s.notifications(b,p.id)[0].id]),/does not belong/);
  assert.throws(()=>s.reserveDelivery(a,p.id,'b'),/only the human/);
});

test('notifications and exact reads survive reopening database and identity merge',t=> {
  const dir=mkdtempSync(join(tmpdir(),'board-durable-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'db');let s=new Store(openDatabase(path));const p=s.ensureProject('p'),a=s.ensureAgent('a'),b=s.ensureAgent('b');s.join(a,p);s.join(b,p);
  const msg=s.createThread(a,{projectId:p.id,kind:'question',title:'q',body:'@b hello'});
  s.inbox(b,p.id);s.db.close();s=new Store(openDatabase(path));t.after(()=>s.db.close());
  assert.equal(s.unreadCount(b,p.id),0);assert.ok(s.notifications(b,p.id).length);
  const c=s.ensureAgent('c');s.join(c,p);s.mergeAgents(s.human(),b.id,c.id);
  assert.ok(s.notifications(c,p.id).length);assert.equal(s.unreadCount(c,p.id),0);
  assert.equal(s.threadMessages(msg.id)[0].author,'a');
});

test('dispatch leases prevent duplicate workers, retain errors and stop after three failures',t=> {
  const {s,p,a,b,h}=fixture(t);offer(s,p,a);
  const n=s.notifications(b,p.id)[0];
  for(let i=0;i<3;i++) {
    s.db.exec('UPDATE deliveries SET retry_at=NULL');
    const lease=s.reserveDelivery(h,p.id,'b');assert.ok(lease);
    assert.equal(s.reserveDelivery(h,p.id,'b'),null);
    s.finishDelivery(h,p.id,{lease_token:lease.lease_token,success:false,error:'offline'});
  }
  s.db.exec('UPDATE deliveries SET retry_at=NULL');assert.equal(s.reserveDelivery(h,p.id,'b'),null);
  assert.equal(s.notifications(b,p.id).find(x=>x.id===n.id).attempts,3);
  assert.ok(s.notifications(h,p.id).some(n=>n.kind==='runner.failed'));
});

test('real MCP, paged hook feed and optional process runner work together',async t=> {
  const dir=mkdtempSync(join(tmpdir(),'board-new-e2e-'));const {server,store:s,base,humanToken}=await startServer({port:0,dataDir:dir,quiet:true});
  t.after(()=>{server.close();server.closeAllConnections();s.db.close();rmSync(dir,{recursive:true,force:true});});
  const p=s.ensureProject('p');const b=s.ensureAgent('b','test');s.join(b,p);
  const c=new Client({name:'test',version:'1'});await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/p/test/a`)));t.after(()=>c.close());
  const call=async(name,args={})=> {const r=await c.callTool({name,arguments:args});assert.ok(!r.isError,r.content[0].text);return JSON.parse(r.content[0].text);};
  const task=await call('board_delegate',{to:'b',title:'Review',description:'Review abc',criteria:'verdict'});assert.equal(task.state,'offered');
  const sk=await call('board_skill_write',{name:'review',description:'Review',body:'Inspect callers',reason:'caller bug',expected_version:0});assert.equal(sk.version,1);
  const a=s.getAgent('a');for(let i=0;i<25;i++) s.post(a,{threadId:task.thread_id,body:'progress '+i});
  const page=await (await fetch(`${base}/api/projects/p/messages?since=0&limit=20`)).json();assert.equal(page.messages.length,20);assert.equal(page.last_id,page.messages.at(-1).id);assert.equal(page.truncated,true);
  const next=await (await fetch(`${base}/api/projects/p/messages?since=${page.last_id}&limit=20`)).json();assert.ok(next.messages.length>0);assert.equal(next.messages[0].id,page.last_id+1);
  const denied=await fetch(`${base}/api/projects/${p.id}/dispatch`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agent:'b'})});assert.equal(denied.status,403);
  const script=join(dir,'worker.cjs'),out=join(dir,'prompt.txt');writeFileSync(script,"const fs=require('fs');let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>fs.writeFileSync(process.argv[2],s));");
  const logs=[];await runWorker({base,token:humanToken,config:{agents:[{project:'p',agent:'b',cwd:dir,command:[process.execPath,script,out]}]},once:true,onOutput:x=>logs.push(x)});
  assert.deepEqual(logs,[]);assert.equal(s.notifications(b,p.id).filter(n=>n.priority>0).length,0);
  const {readFileSync}=await import('node:fs');assert.match(readFileSync(out,'utf8'),/Continue as b/);
  assert.equal(s.taskDetail(p.id,task.id).state,'offered','delivery does not mean work was performed');
});

test('runner validates configuration and terminates timed out commands',async()=> {
  assert.throws(()=>validateRunnerConfig({agents:[{command:'echo hi'}]}),/each agent/);
  const result=await executeAgent({project:'p',agent:'a',cwd:tmpdir(),command:[process.execPath,'-e','setInterval(()=>{},1000)'],timeout_seconds:0.05},'prompt',{base:'http://127.0.0.1:1'});
  assert.equal(result.success,false);assert.match(result.error,/timed out/);
});

test('posting and partial thread reads do not consume unrelated history',t=> {
  const {s,p,a,b}=fixture(t);
  const old=s.createThread(a,{projectId:p.id,kind:'question',title:'old',body:'unseen'});
  const recent=s.createThread(b,{projectId:p.id,kind:'question',title:'recent',body:'my own thread'});
  s.post(b,{threadId:recent.id,body:'my own progress'});
  assert.equal(s.unreadCount(b,p.id),1);assert.equal(s.inbox(b,p.id).threads[0].thread_id,old.id);
});

test('review progress is not a verdict; explicit acknowledgements settle attention',t=> {
  const {s,p,a,b}=fixture(t);
  const review=s.createThread(a,{projectId:p.id,kind:'review',title:'review',body:'@b review abc'});
  s.post(b,{threadId:review.id,body:'I will look'});
  assert.equal(s.waitingOnAgent(b,p.id).length,1);assert.equal(s.unansweredAsks(a,p.id).length,1);
  s.react(b,review.id,'declined');assert.equal(s.waitingOnAgent(b,p.id).length,0);
  s.post(b,{threadId:review.id,body:'Reviewed abc; verified caller',verdict:'approve'});
  assert.equal(s.unansweredAsks(a,p.id).length,0);
});

test('checkpoint failure rolls back task, journal and notifications together',t=> {
  const {s,p,a,b}=fixture(t);let task=offer(s,p,a);task=change(s,p,b,task,'accepted');
  const journal=s.journalThread(b,p.id);s.pauseThread(s.human(),journal.id,'hold');
  const count=s.db.prepare('SELECT count(*) n FROM notifications').get().n;
  assert.throws(()=>s.atomic(()=> {
    change(s,p,b,task,'done',{result:'verified'});
    s.post(b,{threadId:journal.id,body:'done'});
  }),/paused/);
  assert.equal(s.taskDetail(p.id,task.id).state,'accepted');assert.equal(s.db.prepare('SELECT count(*) n FROM notifications').get().n,count);
  assert.throws(()=>s.archiveThread(a,task.thread_id,'Everything is finished and verified.'),/finish or cancel/);
});

test('hourly dispatch cap and crashed final leases retain work and notify the human',t=> {
  const {s,p,a,b,h}=fixture(t);offer(s,p,a);
  const lease=s.reserveDelivery(h,p.id,'b',{max_runs_per_hour:1});assert.ok(lease);
  s.finishDelivery(h,p.id,{lease_token:lease.lease_token,success:false,error:'offline'});
  assert.equal(s.reserveDelivery(h,p.id,'b',{max_runs_per_hour:1}),null);
  assert.ok(s.notifications(h,p.id).some(n=>n.kind==='runner.rate_limited'));
  s.db.exec("UPDATE deliveries SET attempts=3,lease_until='2000-01-01T00:00:00Z',lease_token='old'");
  assert.equal(s.reserveDelivery(h,p.id,'b'),null);
  assert.ok(s.notifications(h,p.id).some(n=>n.kind==='runner.failed'));
  assert.throws(()=>s.finishDelivery(h,p.id,{lease_token:'old',success:true}),/unknown or expired/);
});

test('hook paginates, throttles tool checkpoints and releases its cursor lock',async t=> {
  const dir=mkdtempSync(join(tmpdir(),'board-hook-'));const {server,store:s,base}=await startServer({port:0,dataDir:dir,quiet:true});
  t.after(()=>{server.close();server.closeAllConnections();s.db.close();rmSync(dir,{recursive:true,force:true});});
  const p=s.ensureProject('p'),a=s.ensureAgent('a');s.join(a,p);
  const thread=s.createThread(a,{projectId:p.id,kind:'question',title:'q',body:'message 0'});
  for(let i=1;i<25;i++)s.post(a,{threadId:thread.id,body:'message '+i});
  const {spawn}=await import('node:child_process');
  const hook=event=>new Promise((resolve,reject)=>{
    const c=spawn(process.execPath,['configs/claude-code/board-inbox.js','p'],{env:{...process.env,BOARD_URL:base,TMPDIR:dir},stdio:['pipe','pipe','pipe']});
    let output='';c.stdout.on('data',c=>output+=c);c.on('error',reject);c.on('close',code=>code?reject(new Error('hook failed')):resolve(output));
    c.stdin.end(JSON.stringify({session_id:'one',hook_event_name:event}));
  });
  const first=await hook('PostToolUse');assert.match(JSON.parse(first).hookSpecificOutput.additionalContext,/20 new messages/);
  assert.equal(await hook('PostToolUse'),'');
  const next=await hook('UserPromptSubmit');assert.match(next,/5 new messages/);assert.match(next,/message 24/);
  assert.equal(await hook('UserPromptSubmit'),'');
  s.post(a,{threadId:thread.id,body:'last message'});assert.match(await hook('UserPromptSubmit'),/last message/);
});

test('human delegation and skill edits route attention without waking unrelated agents',t=> {
  const {s,p,a,b,h}=fixture(t);
  offer(s,p,h);
  assert.equal(s.notifications(a,p.id).length,0);
  assert.equal(s.notifications(b,p.id).filter(n=>n.kind==='task.offered').length,1);
  s.writeSkill(h,p.id,{name:'review',description:'Review',body:'Check callers.',reason:'Improve review',expected_version:0});
  assert.equal(s.notifications(a,p.id).filter(n=>n.priority>0).length,0);
  assert.ok(s.inbox(a,p.id).threads.some(t=>t.messages.some(m=>m.body.includes('Check callers'))),'routing never restricts visibility');
});

test('a new request revives attention after an acknowledgement',t=> {
  const {s,p,a,b}=fixture(t);
  const q=s.createThread(a,{projectId:p.id,kind:'question',title:'q',body:'@b first question'});
  s.react(b,q.id,'done');assert.equal(s.waitingOnAgent(b,p.id).length,0);
  s.post(a,{threadId:q.id,body:'@b follow-up question'});assert.equal(s.waitingOnAgent(b,p.id).length,1);
});
