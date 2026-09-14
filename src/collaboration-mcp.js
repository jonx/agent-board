import { z } from 'zod';
export function registerCollaborationTools({reg,store,pid,agent}) {
  const id=z.number().int().positive();
  reg('board_delegate','Delegate work and return immediately. Include acceptance criteria and dependencies. Completion/failure notifies the requester; continue other work.',
    {to:z.string(),title:z.string(),description:z.string(),criteria:z.string(),depends_on:z.array(id).max(50).optional(),deadline:z.string().optional(),ref:z.string().optional()},
    args=>store.delegate(agent(),pid,args));
  reg('board_task_update','Accept or progress a delegated task. Read board_tasks for the current version. Provide a result and verification on done, or a reason on blocked/failed/declined/cancelled. Dependencies must be done before doing/done.',
    {id,state:z.enum(['accepted','doing','blocked','done','failed','declined','cancelled']).optional(),expected_version:id,result:z.string().optional(),ref:z.string().optional(),depends_on:z.array(id).max(50).optional()},
    args=>store.updateDelegatedTask(agent(),pid,args));
  reg('board_task_transfer','Explicitly hand a task to another project member. Only the owner or human can transfer. New owner must accept.',
    {id,to:z.string(),reason:z.string()},args=>store.transferTask(agent(),pid,args));
  reg('board_notifications','Get durable targeted notifications (human first), without consuming them. Use board_receive after taking note; task completion is separate.',
    {limit:id.max(200).optional(),all:z.boolean().optional()},args=>({notifications:store.notifications(agent(),pid,args)}));
  reg('board_receive','Confirm receipt of notification IDs. Does not finish tasks or mark conversation messages read.',
    {ids:z.array(id).max(200)},({ids})=>store.receiveNotifications(agent(),pid,ids));
  reg('board_skills','List reusable skills, descriptions and versions. Read the relevant skill only; bundled skills can be overridden per project.',{},()=>({skills:store.listSkills(pid)}));
  reg('board_skill_read','Read a skill or a historical version and its recent usage evidence. Version 0 is the bundled baseline.',
    {name:z.string(),version:z.number().int().min(0).optional()},({name,version})=>store.readSkill(pid,name,version));
  reg('board_skill_write','Create or improve a reusable skill from evidence, preserving user scope. Supply full Markdown and reason. expected_version=0 creates a project version; otherwise use current version. Immutable history and a human notification are automatic. No approval needed for routine skills.',
    {name:z.string(),description:z.string(),body:z.string(),reason:z.string(),expected_version:z.number().int().min(0)},args=>store.writeSkill(agent(),pid,args));
  reg('board_skill_feedback','Record observed usefulness or failure of a specific skill version with evidence. Feedback informs future edits; it does not automatically rewrite instructions.',
    {name:z.string(),version:z.number().int().min(0),outcome:z.enum(['helped','failed','neutral']),evidence:z.string(),task_id:id.optional()},args=>store.skillFeedback(agent(),pid,args));
  reg('board_checkpoint','Record a milestone and optionally finish/update a delegated task and release your claims in one operation. For done include the verified result; response includes new attention.',
    {body:z.string().min(1),task_id:id.optional(),state:z.enum(['accepted','doing','blocked','done','failed','declined','cancelled']).optional(),expected_version:id.optional(),result:z.string().optional(),ref:z.string().optional(),release:z.boolean().optional()},
    ({body,task_id,state,expected_version,result,ref,release})=>store.atomic(()=>{
      const a=agent(); store.assertCanAct(a,pid);
      const task=task_id?store.updateDelegatedTask(a,pid,{id:task_id,state,expected_version,result,ref}):null;
      const journal=store.journalThread(a,pid); store.post(a,{threadId:journal.id,body});
      if(release) store.release(a,pid);
      return {task,journal_thread_id:journal.id};
    }));
}
