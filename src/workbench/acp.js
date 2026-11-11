import {EventEmitter} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Sessions} from '../codex/sessions.js';
import {Orchestrator} from '../orchestrator.js';
import {safeError} from '../codex/process.js';
import {voiceTaskInstructions} from '../voice/task-control.js';
import {desktopInstructions} from '../agent-desktop.js';
import {readJson,writeJson} from './storage.js';
import {acpReadTarget,projectReadAllowed} from './approval-policy.js';
import {AcpProcess} from './acp-process.js';
import {PiProcess} from './pi-process.js';
import {screenText} from '../desktop/screen.js';
import {ConnectionStages} from './connection-stages.js';
const busy=new Set(['starting','running','stopping','unknown']);
export const ACP_AGENT_NAMES={dsh:'DeepSeek Harness',workbuddy:'WorkBuddy',hermes:'Hermes Agent',antigravity:'Antigravity（反重力）','gemini-cli':'Gemini CLI',pi:'Pi'};
function configChoices(options=[]){
  return options.flatMap(option=>option.options?configChoices(option.options):typeof option.value==='string'?[{id:option.value,name:option.name||option.value,description:option.description}]:[]);
}

export class AcpExecutor extends EventEmitter{
  constructor({agent,workspace,dataDir,desktopMcp,transport,stopTimeoutMs=20000}={}){
    super();Object.assign(this,{agent,workspace,dataDir,desktopMcp,stopTimeoutMs});this.name=ACP_AGENT_NAMES[agent];
    this.transport=transport||(agent==='pi'?new PiProcess({workspace,dataDir}):new AcpProcess({agent,workspace,dataDir}));this.rpc={connected:false};
    this.connectionStages=new ConnectionStages(this,agent);
    this.sessions=new Sessions(dataDir);this.items=new Map();this.completed=new Set();this.approvals=new Map();this.questions=new Map();this.permissions=new Map();this.turnResults=new Map();this.logs=[];
    this.task={status:'idle',turnId:null};this.connection='disconnected';this.orchestrator=new Orchestrator({client:this});this.configOptions=[];this.modelOptions=[];
    this.models={snapshot:()=>({selected:this.selectedModel||'',options:this.modelOptions,effort:this.effortSnapshot(),error:this.modelError||null}),refresh:()=>this.refreshModels(),current:async()=>({id:this.selectedModel}),select:(id,options)=>this.selectModel(id,options)};
    this.transport.on('notification',message=>this.notification(message));this.transport.on('serverRequest',message=>this.serverRequest(message));
    this.transport.on('disconnected',()=>{this.rpc.connected=false;this.connection='disconnected';if(this.busy){this.task.status='unknown';this.error='Agent 连接已断开，结果尚未确认。';}this.cancelPermissions();this.changed();});
  }
  get busy(){return busy.has(this.task.status);}
  changed(){this.emit('change');}
  log(message){this.logs.push({time:new Date().toISOString(),message:safeError(message)});this.logs=this.logs.slice(-100);this.changed();}
  ready(){if(this.closing||!this.rpc.connected)throw Error(this.name+' 尚未连接，请重新连接。');}
  snapshot(){return {connection:this.connection,workspace:this.workspace,currentId:this.currentId||null,task:this.task,sessions:[...this.sessions.entries],items:[...this.items.values()],approvals:[...this.approvals.values()],questions:[],logs:this.logs,models:this.models.snapshot(),connectionStages:this.connectionStages.snapshot(),version:this.init?.agentInfo?.version||null,error:this.error||null,needsResume:!!this.needsResume,locked:!!this.locked,plan:this.plan||null,computer:null};}
  mcpServers(){return this.desktopMcp&&this.agent!=='pi'?[{name:'agent-desktop',command:this.desktopMcp.command,args:this.desktopMcp.args,env:Object.entries(this.desktopMcp.env||{}).map(([name,value])=>({name,value}))}]:[];}
  effortConfig(){
    return this.configOptions.find(option=>Array.isArray(option.options)&&(option.category==='thought_level'||['thought_level','reasoning_effort','reasoning-effort','thinking_level','effort'].includes(option.id)));
  }
  effortSnapshot(){
    const option=this.effortConfig();
    return option?{selected:option.currentValue,options:configChoices(option.options)}:null;
  }
  async connect(){
    if(this.connecting)return this.connecting;if(this.busy&&this.task.status!=='unknown'||this.locked)throw Error('请先停止当前任务。');
    this.connecting=(async()=>{const stages=this.connectionStages;stages.reset();this.connection='connecting';this.changed();try{
      await stages.run('startup',async()=>{
        await this.sessions.load();await this.transport.stop();await this.transport.start();if(this.closing){await this.transport.stop();throw Error('工作台正在退出');}
        this.init=await this.transport.request('initialize',{protocolVersion:1,clientInfo:{name:'zhiwei',version:'0.3.0'},clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}});
      });
      stages.skip('login','协议未提供独立的登录状态查询');
      if(this.closing)throw Error('工作台正在退出');this.rpc.connected=true;
      const latest=this.sessions.entries.toSorted((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
      const restore=!!(this.currentId||latest);
      const session=await stages.run('session',async()=>{
        if(restore){this.currentId??=latest.id;this.needsResume=true;return (await this.resume(this.currentId,{deferConfig:true})).session;}
        return this.createSession({deferConfig:true});
      },restore?'恢复已有会话':'无旧会话，建立新会话');
      await stages.run('models',()=>this.applyConfig(session),'整理会话返回的模型');
      this.connection='connected';this.error=null;this.log(this.name+' 已通过 ACP 连接。');
    }catch(error){
      if(this.agent==='gemini-cli'&&/no longer supported.*(?:Code Assist|individuals)/i.test(error.message)){
        await this.transport.stop().catch(()=>{});
        error=Error('Google 已停用 Gemini CLI 的个人版 Code Assist 登录。本机可选择已接入的 Antigravity（反重力）。');
      }else if(this.agent==='gemini-cli'&&/api key.*(?:missing|not configured)|requires authentication|not authenticated/i.test(error.message)){
        await this.transport.stop().catch(()=>{});
        error=Error('Gemini CLI 尚未登录或配置 API Key。请在终端运行 gemini，用 /auth 完成认证，再回到知微重新连接。');
      }
      this.error=safeError(error);this.connection='error';throw error;
    }finally{this.connecting=null;this.changed();}})();return this.connecting;
  }
  applyConfig(value){
    if(value.configOptions)this.configOptions=value.configOptions;
    const model=this.configOptions.find(o=>o.id==='model'||o.category==='model');
    if(model){this.selectedModel=model.currentValue;this.modelOptions=configChoices(model.options).map(({id,name,description})=>({id,name:name+(description?' · '+description:''),efforts:[]}));}
    else if(value.models){this.selectedModel=value.models.currentModelId;this.modelOptions=(value.models.availableModels||[]).map(m=>({id:m.modelId,name:m.name,efforts:[]}));}
    this.changed();
  }
  async createSession({deferConfig=false}={}){
    this.ready();const session=await this.transport.request('session/new',{cwd:this.workspace,mcpServers:this.mcpServers()});
    if(typeof session.sessionId!=='string')throw Error('Agent 未返回会话编号。');
    const now=new Date().toISOString();await this.sessions.put({id:session.sessionId,title:'新对话',createdAt:now,updatedAt:now});
    this.currentId=session.sessionId;this.items.clear();this.completed.clear();this.cancelPermissions();this.needsResume=false;if(!deferConfig)this.applyConfig(session);this.changed();return session;
  }
  async newThread(){this.ready();if(this.busy||this.locked||this.stopping)throw Error('请先停止当前任务。');this.locked=true;this.changed();try{await this.createSession();this.task={status:'idle',turnId:null};this.plan=null;return {id:this.currentId};}finally{this.locked=false;this.changed();}}
  historyFile(id=this.currentId){return path.join(this.dataDir,'history',createHash('sha256').update(id).digest('hex')+'.json');}
  async saveHistory(){if(!this.currentId)return;const file=this.historyFile(),items=[...this.items.values()].slice(-500);const job=(this.historyQueue||Promise.resolve()).catch(()=>{}).then(()=>writeJson(file,items));this.historyQueue=job;return job;}
  async resume(id,{deferConfig=false}={}){
    this.ready();if(this.busy&&this.task.status!=='unknown'||this.locked||this.stopping)throw Error('请先停止当前任务。');if(!this.sessions.entries.some(s=>s.id===id))throw Error('会话不属于当前项目。');
    this.locked=true;this.changed();try{
      const capabilities=this.init.agentCapabilities||{},method=capabilities.sessionCapabilities?.resume?'session/resume':capabilities.loadSession?'session/load':null;
      if(!method)throw Error('此 Agent 不支持恢复会话，请明确新建对话。');
      await this.historyQueue;const session=await this.transport.request(method,{sessionId:id,cwd:this.workspace,mcpServers:this.mcpServers()});
      this.currentId=id;this.items=new Map((await readJson(this.historyFile(id),[])).map(item=>[item.id,item]));this.completed=new Set(this.items.keys());if(!deferConfig)this.applyConfig(session);this.task={status:'idle',turnId:null};this.needsResume=false;this.error=null;return deferConfig?{id,session}:{id};
    }catch(error){this.needsResume=true;throw error;}finally{this.locked=false;this.changed();}
  }
  async refreshModels(){this.ready();return this.models.snapshot();}
  async listProjectDirectories(){
    if(!this.init?.agentCapabilities?.sessionCapabilities?.list)return null;
    const directories=[],cursors=new Set();
    let cursor;
    do {
      const page=await this.transport.request('session/list',cursor?{cursor}:{},5000);
      if(!Array.isArray(page?.sessions))return null;
      directories.push(...page.sessions.map(session=>({id:session?.sessionId,cwd:session?.cwd,
        title:session?.title,updatedAt:session?.updatedAt,unscoped:!session?.cwd})));
      cursor=page.nextCursor;
      if(typeof cursor!=='string'||!cursor||cursors.has(cursor))break;
      cursors.add(cursor);
    }while(cursors.size<5);
    return directories;
  }
  async selectModel(id,{effort}={}){
    this.ready();if(this.busy||this.locked)throw Error('请先停止当前任务。');if(!this.modelOptions.some(m=>m.id===id))throw Error('请选择 Agent 返回的模型。');
    if(effort!==undefined){
      const config=this.effortConfig();
      if(id!==this.selectedModel||!config||!configChoices(config.options).some(choice=>choice.id===effort))throw Error('请为当前模型选择 Agent 支持的思考强度。');
      this.locked=true;this.changed();
      try{
        const response=await this.transport.request('session/set_config_option',{sessionId:this.currentId,configId:config.id,value:effort});
        this.applyConfig(response);
        if(this.effortConfig()?.currentValue!==effort)throw Error('Agent 尚未确认思考强度。');
        return this.models.snapshot();
      }finally{this.locked=false;this.changed();}
    }
    this.locked=true;this.changed();try{const model=this.configOptions.find(o=>o.id==='model'||o.category==='model');const response=await this.transport.request(model?'session/set_config_option':'session/set_model',model?{sessionId:this.currentId,configId:model.id,value:id}:{sessionId:this.currentId,modelId:id});this.applyConfig(response);this.selectedModel=id;return this.models.snapshot();}finally{this.locked=false;this.changed();}
  }
  upsert(item,turnId,done=false){this.items.set(item.id,{id:item.id,type:item.type,text:String(item.text||'').slice(0,200000),turnId,...(item.tool?{tool:item.tool}:{})});if(done)this.completed.add(item.id);while(this.items.size>500){const key=this.items.keys().next().value;this.items.delete(key);this.completed.delete(key);}}
  notification({method,params:p={}}){
    if(method!=='session/update'||p.sessionId!==this.currentId)return;const u=p.update||{};
    if(u.sessionUpdate==='config_option_update'){this.applyConfig(u);return;}
    if(!this.busy||this.task.status==='stopping'||!this.task.turnId)return;
    if(u._meta?.['codebuddy.ai/memberEvent'])return;
    if(u.sessionUpdate==='agent_message_chunk'&&u.content?.type==='text'){
      const id=this.task.turnId+'-answer',previous=this.items.get(id)?.text||'';this.upsert({id,type:'agentMessage',text:previous+u.content.text},this.task.turnId);
    }else if(['tool_call','tool_call_update'].includes(u.sessionUpdate)){
      const id='tool-'+u.toolCallId,previous=this.items.get(id);this.upsert({id,type:'tool',tool:'dynamicToolCall',text:(u.title||previous?.text||'Agent 工具')+' · '+(u.status||'进行中')},this.task.turnId,['completed','failed'].includes(u.status));
    }else return;
    this.changed();
  }
  async serverRequest({id,method,params:p={}}){
    if(method!=='session/request_permission'){this.transport.rejectRequest(id);return;}
    if(p.sessionId!==this.currentId||!['starting','running'].includes(this.task.status)||this.closing){this.transport.respond(id,{outcome:{outcome:'cancelled'}});return;}
    const turnId=this.task.turnId;
    const allow=p.options?.find(option=>option.kind==='allow_once');
    const target=acpReadTarget(p.toolCall);
    if(allow&&target&&this.autoApproveRead?.()&&await projectReadAllowed(this.workspace,target)){
      if(this.closing||p.sessionId!==this.currentId||this.task.turnId!==turnId||this.task.status!=='running'){
        this.transport.respond(id,{outcome:{outcome:'cancelled'}});
        return;
      }
      if(this.autoApproveRead?.()){
        this.transport.respond(id,{outcome:{outcome:'selected',optionId:allow.optionId}});
        this.log('已自动批准一次本项目文件读取。');
        return;
      }
    }
    if(this.closing||this.task.turnId!==turnId||!['starting','running'].includes(this.task.status)){
      this.transport.respond(id,{outcome:{outcome:'cancelled'}});
      return;
    }
    this.permissions.set(String(id),{rpcId:id,turnId:this.task.turnId,options:p.options||[]});
    this.approvals.set(String(id),{id:String(id),agent:this.name,reason:this.name+' 请求执行工具；仅批准本次操作。',command:safeError(this.agent==='pi'?p.toolCall?.title:JSON.stringify(p.toolCall||{})),cwd:this.workspace,method:'acp/permission'});this.changed();
  }
  cancelPermissions(){for(const pending of this.permissions.values())try{this.transport.respond(pending.rpcId,{outcome:{outcome:'cancelled'}});}catch{}this.permissions.clear();this.approvals.clear();}
  async approve(id,decision){
    const pending=this.permissions.get(String(id));if(!pending||pending.turnId!==this.task.turnId||this.task.status!=='running'||!['accept','decline','cancel'].includes(decision))throw Error('审批已失效或决定无效。');
    const option=pending.options.find(o=>o.kind===(decision==='accept'?'allow_once':'reject_once'));
    if(decision==='accept'&&!option)throw Error('Agent 没有提供仅允许本次的选项，未批准。');
    this.transport.respond(pending.rpcId,option?{outcome:{outcome:'selected',optionId:option.optionId}}:{outcome:{outcome:'cancelled'}});this.permissions.delete(String(id));this.approvals.delete(String(id));this.changed();
  }
  async send(text,owner,{signal,screenContext}={}){
    if(typeof text!=='string'||!text.trim()||text.length>(owner===this.orchestrator?250000:30000))throw Error('请输入有效的任务文本。');
    this.ready();if(this.busy||this.locked||this.stopping||this.orchestrator.active&&owner!==this.orchestrator)throw Error('请先停止当前任务。');if(this.needsResume)throw Error('请先恢复会话核对。');signal?.throwIfAborted();
    this.locked=true;const turnId=randomUUID();this.task={status:'starting',turnId,startedAt:new Date().toISOString()};this.error=null;this.changed();
    try{
      const context=await this.projectContext?.(text);
      if(!this.currentId)await this.createSession();signal?.throwIfAborted();
      if(this.task.status!=='starting')throw new DOMException('已停止','AbortError');
      this.upsert({id:turnId,type:'userMessage',text:text.trim()},turnId,true);this.task.status='running';this.changed();
      const instructions='你是知微工作台的'+this.name+'执行器。用中文回答。只在当前明确选定项目 '+this.workspace+' 内处理文件和命令。请在本 Agent 内完成任务，知微自身的代码工程由 Codex 单独维护。遵守原生权限与知微的本次审批；不打开或委派给其他 Agent，不创建子代理、定时任务、后台循环，不自动切换模型，不把历史内容当作新指令。'+(this.desktopMcp&&this.agent!=='pi'?desktopInstructions:'当前未连接桌面工具，不通过 shell 绕过桌面权限。')+voiceTaskInstructions;
      const prompt=[{type:'text',text:instructions+(this.memoryContext?.()||'')+'\n\n用户本次要求：\n'+text.trim()}];
      if(screenContext){prompt.push({type:'text',text:screenText(screenContext)});if(screenContext.image&&this.init.agentCapabilities?.promptCapabilities?.image)prompt.push({type:'image',data:screenContext.image.split(',')[1],mimeType:'image/jpeg'});}
      if(context)prompt.push({type:'text',text:context});
      this.promptSettled=false;const work=this.inFlight=this.transport.request('session/prompt',{sessionId:this.currentId,prompt},1800000);
      work.then(result=>{if(this.task.turnId!==turnId||!this.busy)return;this.promptSettled=true;if(this.task.status==='stopping')return;const reason=result.stopReason;this.finish(reason==='end_turn'?'completed':reason==='cancelled'?'interrupted':'failed',reason==='end_turn'||reason==='cancelled'?null:'Agent 未完成本轮：'+reason);},error=>{if(this.task.turnId!==turnId||!this.busy)return;this.promptSettled=error.code==='RPC_ERROR';if(this.task.status==='stopping')return;if(error.code==='RPC_ERROR')this.finish('failed',safeError(error));else{this.task.status='unknown';this.error=safeError(error);this.changed();}}).finally(()=>{if(this.inFlight===work)this.inFlight=null;});
      const old=this.sessions.entries.find(s=>s.id===this.currentId);await this.sessions.put({...old,title:old.title==='新对话'?text.trim().slice(0,36):old.title,updatedAt:new Date().toISOString()});return {turnId};
    }catch(error){if(this.task.status==='starting')this.finish(signal?.aborted?'interrupted':'failed',signal?.aborted?null:safeError(error));throw error;}finally{this.locked=false;this.changed();}
  }
  finish(status,error){const turnId=this.task.turnId;this.task.status=status;this.error=error||null;this.cancelPermissions();for(const item of this.items.values())if(item.turnId===turnId)this.completed.add(item.id);const result={turnId,status,error,text:[...this.items.values()].findLast(i=>i.turnId===turnId&&i.type==='agentMessage')?.text||''};this.turnResults.set(turnId,result);while(this.turnResults.size>32)this.turnResults.delete(this.turnResults.keys().next().value);this.emit('turnResult',result);void this.saveHistory().catch(error=>{this.error='本地历史保存失败：'+safeError(error);this.changed();});this.log(this.name+' 本轮'+status+'。');}
  waitForTurn(turnId,signal){if(this.turnResults.has(turnId))return Promise.resolve(this.turnResults.get(turnId));return new Promise(resolve=>{const done=result=>{if(result.turnId!==turnId)return;this.off('turnResult',done);signal?.removeEventListener('abort',abort);resolve(result);};const abort=()=>done({turnId,status:'interrupted',text:''});this.on('turnResult',done);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});}
  async interrupt(){
    this.orchestrator.stop();if(this.stopping)return this.stopping;if(!this.busy)return;
    this.stopping=(async()=>{const turnId=this.task.turnId;this.task.status='stopping';this.cancelPermissions();this.changed();
      try{this.transport.notify('session/cancel',{sessionId:this.currentId});const done=this.inFlight?this.inFlight.then(()=>true,error=>error.code==='RPC_ERROR'):Promise.resolve(!!this.promptSettled);const settled=await Promise.race([done,delay(this.stopTimeoutMs).then(()=>false)]);if(!settled){await this.transport.stop();this.needsResume=true;}if(this.task.turnId===turnId)this.finish('interrupted');}
      catch(error){this.task.status='unknown';this.error='停止尚未确认：'+safeError(error);this.changed();throw error;}
    })().finally(()=>{this.stopping=null;this.changed();});return this.stopping;
  }
  runPlan(text){return this.orchestrator.runPlan(text,{maxAttempts:1});}
  async close(){this.closing=true;this.orchestrator.stop();if(this.busy)await this.interrupt().catch(()=>{});this.cancelPermissions();await this.transport.stop();await this.connecting?.catch(()=>{});await this.transport.stop();await this.sessions.queue;await this.historyQueue;await this.connectionStages.pending;this.rpc.connected=false;}
}
