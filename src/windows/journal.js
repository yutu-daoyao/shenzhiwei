import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const statuses = new Set(['queued','awaitingApproval','running','completed','cancelled','failed','unknown']);
export function actionRecord(action) {
  // Never persist typed text, tool arguments, UI trees, screenshots or raw error messages.
  const record=Object.fromEntries(['id','tool','status','startedAt','completedAt','resolution','reviewedAt'].filter(k=>action[k]!==undefined).map(k=>[k,action[k]]));
  if(action.scope)record.scope=Object.fromEntries(['app','windowId','bindingId'].filter(k=>typeof action.scope[k]==='string').map(k=>[k,action.scope[k]]));
  return record;
}
export function windowProof(window) {
  return Object.fromEntries(['id','pid','processStartedAt','className','app','documentName','tabRuntimeId'].filter(k=>window[k]!==undefined).map(k=>[k,window[k]]));
}
export class WindowsJournal {
  constructor(directory) { this.directory=directory;this.file=path.join(directory,'windows-state.json');this.queue=Promise.resolve(); }
  async load(workspace) {
    await mkdir(this.directory,{recursive:true});
    try {
      const state=JSON.parse(await readFile(this.file,'utf8'));
      if(state.version!==1||state.workspace!==workspace||!Array.isArray(state.actions)||!Array.isArray(state.bindings))throw new Error('invalid');
      if(state.actions.some(a=>typeof a.id!=='string'||typeof a.tool!=='string'||!statuses.has(a.status)))throw new Error('invalid actions');
      if(state.actions.some(a=>a.resolution!==undefined&&!['applied','notApplied','partial'].includes(a.resolution)))throw new Error('invalid resolution');
      if(state.bindings.some(b=>typeof b.id!=='string'||!['notepad','calculator','explorer','browser'].includes(b.proof?.app)||!/^\d+$/.test(b.proof?.id)||!Number.isInteger(b.proof?.pid)||typeof b.proof?.processStartedAt!=='string'||typeof b.proof?.className!=='string'))throw new Error('invalid bindings');
      const actions=state.actions.slice(-100).map(a=>{
        const record=actionRecord(a);
        if(record.status==='running')record.status='unknown';
        if(['queued','awaitingApproval'].includes(record.status))record.status='cancelled';
        return record;
      });
      const bindings=state.bindings.slice(-20).map(b=>({id:b.id,proof:windowProof(b.proof),createdAt:b.createdAt,updatedAt:b.updatedAt,status:b.status==='closed'?'closed':'saved'}));
      return {actions,bindings};
    } catch(error) {
      if(error.code==='ENOENT')return {actions:[],bindings:[]};
      throw new Error('Windows 操作记录损坏、不可读或属于其他测试目录。已保留原文件；聊天仍可使用，请备份 data/windows/windows-state.json 后修复。');
    }
  }
  save(workspace,actions,bindings) {
    const state={version:1,workspace,actions:actions.slice(-100).map(actionRecord),bindings:bindings.slice(-20).map(b=>({id:b.id,createdAt:b.createdAt,updatedAt:b.updatedAt,status:b.status,proof:windowProof(b.proof)}))};
    const data=JSON.stringify(state,null,2);
    const job=this.queue.then(async()=>{
      const temporary=`${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary,data,{mode:0o600});await rename(temporary,this.file);
    });
    this.queue=job.catch(()=>{});return job;
  }
}
