import { BoardError } from './store.js';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
const now = () => new Date().toISOString();
const terminal = ['done','failed','declined','cancelled'];
const bad = message => { throw new BoardError('bad_input',message); };
const conflict = message => { throw new BoardError('conflict',message); };
const required = (value, name, max=20000) => {
  if(typeof value!=='string' || !value.trim() || value.length>max) bad(`${name} must contain 1–${max} characters`);
  return value.trim();
};
const seeds = readdirSync(new URL('../skills/',import.meta.url)).map(name => {
  const body=readFileSync(new URL(`../skills/${name}/SKILL.md`,import.meta.url),'utf8');
  return {name,description:body.match(/^description: (.+)$/m)[1],body,version:0,bundled:true};
});

export const collaborationMethods = {
  atomic(fn) {
    const savepoint=`board_${randomUUID().replaceAll('-','')}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try { const r=fn(); this.db.exec(`RELEASE ${savepoint}`); return r; }
    catch(e) { this.db.exec(`ROLLBACK TO ${savepoint}`); this.db.exec(`RELEASE ${savepoint}`); throw e; }
  },
  notify(projectId, agentId, kind, body, {threadId=null,taskId=null,priority=1}={}) {
    const id=Number(this.db.prepare(`INSERT INTO notifications(project_id,kind,priority,body,thread_id,task_id,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(projectId,kind,priority,body,threadId,taskId,now()).lastInsertRowid);
    this.db.prepare('INSERT INTO deliveries(notification_id,agent_id) VALUES (?,?)').run(id,agentId);
    this.emit('notification',{projectId,agentId,notificationId:id,threadId,taskId});
    return id;
  },
  notifyMessage({projectId,threadId,author,body,mentions}) {
    if(this.db.prepare('SELECT 1 FROM tasks t JOIN task_details d ON d.task_id=t.id WHERE t.thread_id=?').get(threadId) && author.role!=='human') return;
    const targets=new Set();
    const members=this.members(projectId);
    for(const m of members) if(author.role==='human'||mentions.some(n=>[m.name,'all','everyone'].includes(n))) targets.add(m.id);
    const thread=this.getThread(threadId);
    if(thread.created_by!==author.id && thread.kind!=='status') targets.add(this.canonical(this.getAgent(thread.created_by)).id);
    for(const name of mentions) { const a=this.getAgent(name); if(a) targets.add(this.canonical(a).id); }
    targets.delete(author.id);
    for(const target of targets) this.notify(projectId,target,'message',`${author.name}: ${body.slice(0,400)}`,{threadId,priority:author.role==='human'?2:1});
  },
  notifications(agent,projectId,{limit=30,all=false}={}) {
    return this.db.prepare(`SELECT n.*,d.received_at,d.attempts,d.last_error FROM notifications n JOIN deliveries d ON d.notification_id=n.id
      WHERE n.project_id=? AND d.agent_id=? ${all?'':'AND d.received_at IS NULL'} ORDER BY n.priority DESC,n.id LIMIT ?`)
      .all(projectId,agent.id,Math.max(1,Math.min(200,Number(limit)||30)));
  },
  receiveNotifications(agent,projectId,ids) {
    if(!Array.isArray(ids)||ids.length>200) bad('ids must be a list of at most 200 notification IDs');
    return this.atomic(()=> {
      for(const id of ids) {
        const d=this.db.prepare(`SELECT n.id FROM notifications n JOIN deliveries d ON d.notification_id=n.id WHERE n.id=? AND n.project_id=? AND d.agent_id=?`).get(id,projectId,agent.id);
        if(!d) bad('notification does not belong to this agent/project');
        this.db.prepare('UPDATE deliveries SET received_at=COALESCE(received_at,?) WHERE notification_id=? AND agent_id=?').run(now(),id,agent.id);
      }
      this.event('notifications.received',{agentId:agent.id,projectId,data:{ids}});
      return {received:ids};
    });
  },
  attention(agent,projectId) {
    return {notifications:this.notifications(agent,projectId,{limit:5}),tasks:this.delegatedTasks(projectId).filter(t=>
      (t.owner_id===agent.id&&!terminal.includes(t.state)) || (t.requester_id===agent.id&&t.overdue)).slice(0,10)};
  },
  taskMember(name,projectId) {
    const a=this.getAgent(name);
    if(!a||a.role!=='agent'||a.provider==='system'||a.retired||a.merged_into||!this.members(projectId).some(m=>m.id===a.id)) bad('choose an active project member');
    return a;
  },
  delegatedTasks(projectId) {
    return this.db.prepare(`SELECT t.*,d.*,a.name AS owner,r.name AS requester FROM tasks t JOIN task_details d ON d.task_id=t.id
      LEFT JOIN agents a ON a.id=t.owner_id LEFT JOIN agents r ON r.id=d.requester_id WHERE t.project_id=? ORDER BY t.id DESC`).all(projectId)
      .map(t=>({...t,depends_on:this.db.prepare('SELECT depends_on FROM task_dependencies WHERE task_id=?').all(t.id).map(x=>x.depends_on),
        overdue:!!t.deadline&&t.deadline<now()&&!terminal.includes(t.state)}));
  },
  taskDetail(projectId,id) {
    const t=this.delegatedTasks(projectId).find(t=>t.id===id);
    if(!t) throw new BoardError('not_found','delegated task not found in this project');
    return t;
  },
  delegate(actor,projectId,{to,title,description,criteria,depends_on=[],deadline=null,ref=null}) {
    this.assertCanAct(actor,projectId);
    const owner=this.taskMember(to,projectId);
    title=required(title,'title',200); description=required(description,'description'); criteria=required(criteria,'criteria');
    if(deadline) { if(!Number.isFinite(Date.parse(deadline))) bad('deadline must be an ISO date'); deadline=new Date(deadline).toISOString(); }
    return this.atomic(()=> {
      for(const dep of depends_on) this.taskDetail(projectId,dep);
      const thread=this.createThread(actor,{projectId,kind:'question',title:`Task: ${title}`,body:`${description}\n\nAcceptance: ${criteria}`,ref,mentions:[owner.name],notify:false});
      const task=this.upsertTask(actor,projectId,{title,description,owner:owner.name,threadId:thread.id});
      this.db.prepare(`INSERT INTO task_details(task_id,requester_id,criteria,deadline,ref) VALUES (?,?,?,?,?)`).run(task.id,actor.id,criteria,deadline,ref);
      for(const dep of new Set(depends_on)) this.db.prepare('INSERT INTO task_dependencies(task_id,depends_on) VALUES (?,?)').run(task.id,dep);
      this.notify(projectId,owner.id,'task.offered',`${actor.name} delegated: ${title}`,{taskId:task.id,threadId:thread.id});
      return {...this.taskDetail(projectId,task.id),next:'Continue independent work. Completion or failure will notify you; do not poll this task.'};
    });
  },
  updateDelegatedTask(actor,projectId,{id,state,result,ref,expected_version,depends_on}) {
    return this.atomic(()=> {
      const t=this.taskDetail(projectId,id);
      this.assertCanAct(actor,projectId,this.getThread(t.thread_id));
      if(expected_version!==t.version) conflict('task changed; read its current version');
      if(actor.role!=='human'&&actor.id!==t.owner_id&&!(state==='cancelled'&&actor.id===t.requester_id)) conflict('only the owner can update this task; requester may cancel');
      if(!state && depends_on===undefined) bad('provide state or depends_on');
      if(terminal.includes(t.state)) conflict('task is terminal; delegate follow-up work explicitly');
      const transitions={offered:['accepted','declined','cancelled'],accepted:['doing','blocked','done','failed','cancelled'],doing:['blocked','done','failed','cancelled'],blocked:['doing','done','failed','cancelled']};
      if(state && !transitions[t.state]?.includes(state)) bad(`invalid transition ${t.state} → ${state}`);
      if(depends_on!==undefined) {
        for(const dep of new Set(depends_on)) {
          this.taskDetail(projectId,dep);
          const cycle=this.db.prepare(`WITH RECURSIVE chain(id) AS (SELECT ? UNION SELECT d.depends_on FROM task_dependencies d JOIN chain c ON d.task_id=c.id) SELECT 1 FROM chain WHERE id=?`).get(dep,id);
          if(cycle) conflict('dependency would create a cycle');
        }
        this.db.prepare('DELETE FROM task_dependencies WHERE task_id=?').run(id);
        for(const dep of new Set(depends_on)) this.db.prepare('INSERT INTO task_dependencies(task_id,depends_on) VALUES (?,?)').run(id,dep);
      }
      const deps=this.db.prepare(`SELECT d.state FROM task_dependencies e JOIN task_details d ON d.task_id=e.depends_on WHERE e.task_id=?`).all(id);
      if(['doing','done'].includes(state??t.state)&&deps.some(d=>d.state!=='done')) conflict('dependencies are unfinished; continue independent work');
      if(['done','failed','declined','blocked','cancelled'].includes(state)) result=required(result,'result / blocking reason');
      if(state==='done' && this.getThread(t.thread_id).needs_human && this.getThread(t.thread_id).status!=='approved') conflict('human decision is still pending');
      const next=state??t.state;
      const status=next==='done'?'done':terminal.includes(next)||next==='blocked'?'blocked':next==='doing'||next==='accepted'?'doing':'todo';
      this.db.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=?').run(status,now(),id);
      this.db.prepare('UPDATE task_details SET state=?,result=COALESCE(?,result),ref=COALESCE(?,ref),version=version+1 WHERE task_id=?').run(next,result??null,ref??null,id);
      if(state) {
        this.post(actor,{threadId:t.thread_id,notify:false,body:`Task #${id}: ${next}${result?'\n'+result:''}${ref?'\nReference: '+ref:''}`});
        this.notify(projectId,t.requester_id,`task.${next}`,`${t.title}: ${next}${result?' — '+result.slice(0,300):''}`,{taskId:id,threadId:t.thread_id,priority:['accepted','doing'].includes(next)?0:1});
        if(state==='cancelled'&&t.owner_id!==actor.id) this.notify(projectId,t.owner_id,'task.cancelled',`${t.title}: cancelled`,{taskId:id,threadId:t.thread_id,priority:2});
        if(terminal.includes(next)) {
          this.db.prepare('UPDATE claims SET released_at=? WHERE task_id=? AND agent_id=? AND released_at IS NULL').run(now(),id,t.owner_id);
          for(const dependent of this.db.prepare('SELECT task_id FROM task_dependencies WHERE depends_on=?').all(id)) {
            const dt=this.taskDetail(projectId,dependent.task_id);
            if(!terminal.includes(dt.state)) this.notify(projectId,dt.owner_id,'task.dependency',`${t.title}: ${next}; check dependencies of ${dt.title}`,{taskId:dt.id,threadId:dt.thread_id});
          }
        }
      }
      this.event('task.transition',{agentId:actor.id,projectId,threadId:t.thread_id,data:{id,state:next,depends_on}});
      return this.taskDetail(projectId,id);
    });
  },
  transferTask(actor,projectId,{id,to,reason}) {
    required(reason,'reason');
    return this.atomic(()=> {
      const t=this.db.prepare('SELECT * FROM tasks WHERE id=? AND project_id=?').get(id,projectId);
      if(!t) bad('task not found');
      this.assertCanAct(actor,projectId,t.thread_id?this.getThread(t.thread_id):null);
      if(actor.role!=='human'&&t.owner_id!==actor.id) conflict('only the current owner or human can transfer a task');
      const owner=this.taskMember(to,projectId);
      const d=this.db.prepare('SELECT * FROM task_details WHERE task_id=?').get(id);
      if(d&&terminal.includes(d.state)) conflict('cannot transfer terminal task');
      this.db.prepare("UPDATE tasks SET owner_id=?,status='todo',updated_at=? WHERE id=?").run(owner.id,now(),id);
      this.db.prepare("UPDATE task_details SET state='offered',version=version+1 WHERE task_id=?").run(id);
      this.db.prepare('UPDATE claims SET released_at=? WHERE task_id=? AND released_at IS NULL').run(now(),id);
      this.event('task.transferred',{agentId:actor.id,projectId,threadId:t.thread_id,data:{id,from:t.owner_id,to:owner.id,reason}});
      this.notify(projectId,owner.id,'task.offered',`${t.title}: transferred by ${actor.name}. ${reason}`,{taskId:id,threadId:t.thread_id});
      if(d) this.notify(projectId,d.requester_id,'task.transferred',`${t.title}: now assigned to ${owner.name}`,{taskId:id,threadId:t.thread_id});
      return {id,owner:owner.name};
    });
  },
  listSkills(projectId) {
    const versions=this.db.prepare(`SELECT v.*,a.name AS author FROM skill_versions v JOIN agents a ON a.id=v.author_id WHERE project_id=?
      AND version=(SELECT max(version) FROM skill_versions x WHERE x.project_id=v.project_id AND x.name=v.name) ORDER BY name`).all(projectId);
    const combined=new Map(seeds.map(s=>[s.name,s])); for(const s of versions) combined.set(s.name,s);
    return [...combined.values()].map(({body,...s})=>s);
  },
  readSkill(projectId,name,version) {
    const s=version===0?null:this.db.prepare(`SELECT * FROM skill_versions WHERE project_id=? AND name=? ${version===undefined?'ORDER BY version DESC LIMIT 1':'AND version=?'}`)
      .get(...(version===undefined?[projectId,name]:[projectId,name,version]));
    if(s) return {...s,feedback:this.db.prepare('SELECT f.*,a.name AS author FROM skill_feedback f JOIN agents a ON a.id=f.author_id WHERE skill_version_id=? ORDER BY f.id DESC LIMIT 20').all(s.id)};
    const seed=seeds.find(s=>s.name===name); if(seed&&(version===undefined||version===0)) return seed;
    throw new BoardError('not_found','skill version not found');
  },
  writeSkill(actor,projectId,{name,description,body,reason,expected_version}) {
    this.assertCanAct(actor,projectId);
    if(!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) bad('invalid skill name');
    description=required(description,'description',500); body=required(body,'body',16000); reason=required(reason,'reason',2000);
    if(!body.startsWith('---\n')) body=`---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}`;
    return this.atomic(()=> {
      const latest=this.db.prepare('SELECT * FROM skill_versions WHERE project_id=? AND name=? ORDER BY version DESC LIMIT 1').get(projectId,name);
      if(expected_version!==(latest?.version??0)) conflict('skill changed; read current version and reconcile');
      let threadId=latest?.thread_id;
      if(!threadId) threadId=this.createThread(actor,{projectId,kind:'status',title:`Skill: ${name}`,body:null}).id;
      this.assertCanAct(actor,projectId,this.getThread(threadId));
      const version=(latest?.version??0)+1;
      // The entire skill is also covered by the message hash chain.
      this.post(actor,{threadId,notify:false,body:`Skill ${name} v${version}\n${description}\n\nChange: ${reason}\n\n${body}`});
      this.db.prepare(`INSERT INTO skill_versions(project_id,name,version,description,body,reason,author_id,thread_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(projectId,name,version,description,body,reason,actor.id,threadId,now());
      for(const a of [...this.members(projectId),this.human()]) if(a.id!==actor.id) this.notify(projectId,a.id,'skill.updated',`${actor.name} updated ${name} v${version}: ${reason}`,{threadId,priority:0});
      this.event('skill.updated',{agentId:actor.id,projectId,threadId,data:{name,version,reason}});
      return this.readSkill(projectId,name);
    });
  },
  skillFeedback(actor,projectId,{name,version,outcome,evidence,task_id=null}) {
    this.assertCanAct(actor,projectId); evidence=required(evidence,'evidence',4000);
    if(!['helped','failed','neutral'].includes(outcome)) bad('invalid outcome');
    let skill=this.readSkill(projectId,name,version);
    if(task_id) this.taskDetail(projectId,task_id);
    return this.atomic(()=> {
      // Materialize bundled v0 as a project version before attaching immutable evidence.
      if(skill.bundled) {
        const baseline=this.db.prepare('SELECT * FROM skill_versions WHERE project_id=? AND name=? AND body=? ORDER BY version LIMIT 1').get(projectId,name,skill.body);
        if(baseline) skill=baseline;
        else { const current=this.listSkills(projectId).find(s=>s.name===name); if(current.version!==0) conflict('bundled baseline was not recorded; give feedback on an existing project version'); skill=this.writeSkill(actor,projectId,{name,description:skill.description,body:skill.body,reason:'Record bundled baseline for usage feedback',expected_version:0}); }
      }
      this.assertCanAct(actor,projectId,this.getThread(skill.thread_id));
      this.db.prepare('INSERT INTO skill_feedback(skill_version_id,author_id,task_id,outcome,evidence,created_at) VALUES (?,?,?,?,?,?)').run(skill.id,actor.id,task_id,outcome,evidence,now());
      this.post(actor,{threadId:skill.thread_id,notify:false,body:`Usage of ${name} v${skill.version}: ${outcome}${task_id?' on task #'+task_id:''}\n${evidence}`});
      return {name,version:skill.version,outcome};
    });
  },
  mergeCollaboration(from,into) {
    for(const r of this.db.prepare('SELECT * FROM agent_reads WHERE agent_id=?').all(from)) this.markThreadRead({id:into},r.thread_id,r.last_read_message_id);
    this.db.prepare('INSERT OR IGNORE INTO message_reads SELECT ?,message_id FROM message_reads WHERE agent_id=?').run(into,from);
    this.db.prepare('DELETE FROM agent_reads WHERE agent_id=?').run(from);
    this.db.prepare('DELETE FROM message_reads WHERE agent_id=?').run(from);
    for(const d of this.db.prepare('SELECT * FROM deliveries WHERE agent_id=?').all(from)) {
      this.db.prepare(`INSERT INTO deliveries(notification_id,agent_id,received_at) VALUES (?,?,?) ON CONFLICT(notification_id,agent_id) DO UPDATE SET received_at=COALESCE(deliveries.received_at,excluded.received_at)`)
        .run(d.notification_id,into,d.received_at);
    }
    this.db.prepare('DELETE FROM deliveries WHERE agent_id=?').run(from);
    this.db.prepare('UPDATE task_details SET requester_id=? WHERE requester_id=?').run(into,from);
  },
  sweepDelegations() {
    for(const p of this.listProjects().filter(p=>!p.archived)) for(const t of this.delegatedTasks(p.id).filter(t=>t.overdue)) {
      if(this.db.prepare("SELECT 1 FROM events WHERE kind='task.overdue' AND project_id=? AND json_extract(data,'$.id')=?").get(p.id,t.id)) continue;
      this.atomic(()=> {
        this.notify(p.id,t.requester_id,'task.overdue',`${t.title}: deadline passed; consider an explicit reassignment`,{taskId:t.id,threadId:t.thread_id});
        this.event('task.overdue',{projectId:p.id,data:{id:t.id}});
      });
    }
  },
  // A human-configured runner reserves a batch; reading alerts never consumes them.
  reserveDelivery(actor,projectId,agentName,{seconds=300,max_runs_per_hour=30}={}) {
    this.requireHuman(actor,'dispatch an agent');
    if(!Number.isFinite(seconds)||seconds<1||seconds>3600) bad('seconds must be 1–3600');
    if(!Number.isInteger(max_runs_per_hour)||max_runs_per_hour<1||max_runs_per_hour>300) bad('max_runs_per_hour must be 1–300');
    const a=this.taskMember(agentName,projectId);
    if(a.paused_reason||this.getProject(projectId).archived) return null;
    return this.atomic(()=> {
      if(this.db.prepare('SELECT 1 FROM deliveries d JOIN notifications n ON n.id=d.notification_id WHERE d.agent_id=? AND n.project_id=? AND d.lease_until>?').get(a.id,projectId,now())) return null;
      const since=new Date(Date.now()-3600000).toISOString();
      const runs=this.db.prepare("SELECT count(*) AS n FROM events WHERE kind='runner.started' AND project_id=? AND agent_id=? AND at>?").get(projectId,a.id,since).n;
      if(runs>=max_runs_per_hour) {
        if(!this.db.prepare("SELECT 1 FROM events WHERE kind='runner.rate_limited' AND project_id=? AND agent_id=? AND at>?").get(projectId,a.id,since)) {
          this.notify(projectId,this.human().id,'runner.rate_limited',`${a.name}: hourly execution limit reached; pending work is retained`,{priority:2});
          this.event('runner.rate_limited',{projectId,agentId:a.id,data:{max_runs_per_hour}});
        }
        return null;
      }
      const exhausted=this.db.prepare(`SELECT d.notification_id FROM deliveries d JOIN notifications n ON n.id=d.notification_id
        WHERE d.agent_id=? AND n.project_id=? AND d.received_at IS NULL AND d.attempts>=3 AND d.lease_until<=?`).all(a.id,projectId,now());
      for(const d of exhausted) {
        this.notify(projectId,this.human().id,'runner.failed',`${a.name}: dispatch lease expired after 3 attempts; notification #${d.notification_id} remains pending`,{priority:2});
        this.db.prepare("UPDATE deliveries SET lease_until=NULL,lease_token=NULL,last_error='lease expired after 3 attempts' WHERE notification_id=? AND agent_id=?").run(d.notification_id,a.id);
      }
      const batch=this.db.prepare(`SELECT n.* FROM notifications n JOIN deliveries d ON d.notification_id=n.id
        LEFT JOIN threads t ON t.id=n.thread_id
        WHERE n.project_id=? AND d.agent_id=? AND n.priority>0 AND d.received_at IS NULL
          AND d.attempts<3 AND (d.retry_at IS NULL OR d.retry_at<=?) AND t.paused_reason IS NULL
        ORDER BY n.priority DESC,n.id LIMIT 20`).all(projectId,a.id,now());
      if(!batch.length) return null;
      const token=randomUUID(); const expires=new Date(Date.now()+Math.min(3600,Math.max(10,seconds))*1000).toISOString();
      for(const n of batch) this.db.prepare('UPDATE deliveries SET lease_token=?,lease_until=?,attempts=attempts+1 WHERE notification_id=? AND agent_id=?').run(token,expires,n.id,a.id);
      this.event('runner.started',{projectId,agentId:a.id,data:{count:batch.length}});
      return {lease_token:token,agent:a.name,project:this.getProject(projectId).name,notifications:batch};
    });
  },
  finishDelivery(actor,projectId,{lease_token,success,error=null}) {
    this.requireHuman(actor,'finish dispatch');
    const rows=this.db.prepare('SELECT d.* FROM deliveries d JOIN notifications n ON n.id=d.notification_id WHERE d.lease_token=? AND n.project_id=?').all(lease_token,projectId);
    if(!rows.length||rows.some(d=>d.lease_until<now())) conflict('unknown or expired dispatch lease');
    return this.atomic(()=> {
      for(const d of rows) this.db.prepare(`UPDATE deliveries SET received_at=CASE WHEN ? THEN COALESCE(received_at,?) ELSE received_at END,
        lease_until=NULL,lease_token=NULL,last_error=?,retry_at=? WHERE notification_id=? AND agent_id=?`)
        .run(success?1:0,now(),success?null:String(error??'runner failed').slice(0,1000),new Date(Date.now()+60000*d.attempts).toISOString(),d.notification_id,d.agent_id);
      this.event(success?'runner.completed':'runner.failed',{projectId,agentId:rows[0].agent_id,data:{count:rows.length,error}});
      if(!success&&rows.some(d=>d.attempts>=3)) this.notify(projectId,this.human().id,'runner.failed',`Agent dispatch failed after 3 attempts: ${String(error??'unknown error').slice(0,300)}`,{priority:2});
      return {ok:true};
    });
  }
};
