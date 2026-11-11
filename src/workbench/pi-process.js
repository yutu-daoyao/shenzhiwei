import {randomUUID} from 'node:crypto';
import {access,mkdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AcpProcess} from './acp-process.js';
import {findLocalCli} from './local-cli.js';
import {readJson,writeJson} from './storage.js';

const approvalFile=fileURLToPath(new URL('./pi-approval.js',import.meta.url));
const key=model=>model?.provider&&model?.id?`${model.provider}/${model.id}`:'';
const requestError=message=>Object.assign(Error(message),{code:'RPC_ERROR'});

export class PiProcess extends AcpProcess{
  constructor(options){
    super({...options,agent:'pi'});
    this.sessionDir=path.join(this.dataDir,'pi-sessions');
    this.indexFile=path.join(this.dataDir,'pi-session-index.json');
    this.on('disconnected',()=>this.turn?.reject(Error('Pi 连接已断开。')));
  }
  async start(){
    if(this.child)return;
    this.approvalReady=false;this.sessionId=null;
    await mkdir(this.sessionDir,{recursive:true});
    this.index=await readJson(this.indexFile,{});
    this.command??={command:process.execPath,args:[await findLocalCli('pi'),'--mode','rpc','--session-dir',this.sessionDir,
      '--no-extensions','--no-mcp','--no-skills','--no-prompt-templates',
      '--tools','read,bash,edit,write,grep,find,ls','--extension',approvalFile]};
    await super.start();
  }
  write({id,method,params,result,error}){
    if(!this.child?.stdin.writable)throw Error('Pi 连接已关闭。');
    const value=method?{id:id===undefined?undefined:String(id),type:method,...params}:
      {type:'extension_ui_response',id,...(error?{cancelled:true}:{confirmed:result?.outcome?.optionId==='allow'})};
    this.child.stdin.write(JSON.stringify(value)+'\n');
  }
  call(type,params={},timeout=15000){return super.request(type,params,timeout);}
  update(update){this.emit('notification',{method:'session/update',params:{sessionId:this.sessionId,update}});}
  handleMessage(message){
    if(!message)return;
    if(message.type==='response'){
      super.handleMessage({jsonrpc:'2.0',id:message.id,...(message.success?{result:message.data}:{error:{message:message.error||'Pi 请求失败'}})});
      return;
    }
    if(message.type==='extension_ui_request'){
      if(message.method==='notify'&&message.message==='zhiwei-approval-ready'){this.approvalReady=true;return;}
      if(message.method==='confirm'&&message.title==='知微工具审批'&&this.turn&&!this.turn.cancelled){
        this.emit('serverRequest',{id:message.id,method:'session/request_permission',params:{sessionId:this.sessionId,
          toolCall:{title:String(message.message||'Pi 工具').slice(0,1600)},
          options:[{optionId:'allow',kind:'allow_once'},{optionId:'deny',kind:'reject_once'}]}});
      }else if(['confirm','select','input','editor'].includes(message.method))this.rejectRequest(message.id);
      return;
    }
    const turn=this.turn;
    if(!turn)return;
    if(message.type==='message_update'&&message.assistantMessageEvent?.type==='text_delta'){
      const text=message.assistantMessageEvent.delta;
      if(typeof text==='string'&&text){turn.streamed=true;this.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text}});}
    }else if(message.type==='message_end'&&message.message?.role==='assistant'){
      turn.last=message.message;
      if(!turn.streamed)for(const block of turn.last.content||[])if(block.type==='text')this.update({sessionUpdate:'agent_message_chunk',content:block});
      turn.streamed=false;
    }else if(message.type==='tool_execution_start'||message.type==='tool_execution_end'){
      this.update({sessionUpdate:message.type.endsWith('start')?'tool_call':'tool_call_update',toolCallId:message.toolCallId,
        title:message.toolName,status:message.type.endsWith('start')?'in_progress':message.isError?'failed':'completed'});
    }else if(message.type==='agent_settled')this.settle(turn);
  }
  settle(turn){
    if(turn.cancelled||turn.last?.stopReason==='aborted')turn.resolve({stopReason:'cancelled'});
    else if(turn.last?.stopReason==='error')turn.reject(requestError(turn.last.errorMessage||'Pi 模型请求失败。'));
    else turn.resolve({stopReason:'end_turn'});
  }
  async config(state){
    state??=await this.call('get_state');
    const [available,thinking]=await Promise.all([this.call('get_available_models'),this.call('get_available_thinking_levels')]);
    this.modelList=new Map((available?.models||[]).filter(model=>key(model)).map(model=>[key(model),model]));
    return {sessionId:this.sessionId,configOptions:[
      {id:'model',category:'model',currentValue:key(state.model),options:[...this.modelList].map(([id,model])=>({value:id,name:model.name?`${model.name} · ${model.provider}`:id}))},
      {id:'thought_level',category:'thought_level',currentValue:state.thinkingLevel,options:(thinking?.levels||[]).map(level=>({value:level,name:level}))},
    ]};
  }
  async openSession(id){
    const saved=id?this.index[id]:null;
    if(id&&!saved)throw Error('Pi 会话不属于当前工作区。');
    const file=saved&&path.join(this.sessionDir,path.basename(saved));
    const exists=file&&await access(file).then(()=>true,()=>false);
    if(exists&&path.dirname(await realpath(file))!==await realpath(this.sessionDir))throw Error('Pi 会话文件不在当前工作区记录目录内。');
    const result=exists?await this.call('switch_session',{sessionPath:file}):await this.call('new_session');
    if(result?.cancelled)throw Error('Pi 已取消会话切换。');
    const state=await this.call('get_state');
    if(!this.approvalReady)throw Error('Pi 的知微工具审批未加载，已阻止发送任务。');
    if(typeof state.sessionFile!=='string'||path.dirname(path.resolve(state.sessionFile))!==path.resolve(this.sessionDir))throw Error('Pi 未返回当前工作区的会话文件。');
    this.sessionId=id||randomUUID();
    this.index[this.sessionId]=path.basename(state.sessionFile);
    await writeJson(this.indexFile,this.index);
    return this.config(state);
  }
  async prompt(params,timeout=1800000){
    if(!this.approvalReady||params.sessionId!==this.sessionId||this.turn)throw Error('Pi 会话尚未就绪或仍在执行。');
    const turn={};
    const completed=new Promise((resolve,reject)=>Object.assign(turn,{resolve,reject}));
    this.turn=turn;
    const timer=setTimeout(()=>turn.reject(Object.assign(Error('Pi 尚未确认任务结束。'),{code:'RPC_TIMEOUT'})),timeout);
    try{
      const accepted=this.call('prompt',{message:params.prompt.map(item=>item.text).join('\n\n')})
        .then(result=>{if(result?.disposition==='handled')turn.resolve({stopReason:'end_turn'});});
      const [,result]=await Promise.all([accepted,completed]);
      return result;
    }finally{clearTimeout(timer);if(this.turn===turn)this.turn=null;}
  }
  async request(method,params={},timeout){
    switch(method){
      case 'initialize': return {protocolVersion:1,agentInfo:{name:'pi'},agentCapabilities:{loadSession:true}};
      case 'session/new': return this.openSession();
      case 'session/load': return this.openSession(params.sessionId);
      case 'session/prompt': return this.prompt(params,timeout);
      case 'session/set_config_option': {
        if(params.sessionId!==this.sessionId)throw Error('Pi 会话已切换。');
        if(params.configId==='model'){
          const model=this.modelList?.get(params.value);
          if(!model)throw Error('请选择 Pi 当前配置的模型。');
          await this.call('set_model',{provider:model.provider,modelId:model.id});
        }else if(params.configId==='thought_level')await this.call('set_thinking_level',{level:params.value});
        else throw Error('Pi 不支持该选项。');
        return this.config();
      }
      default: throw Error('Pi 不支持此会话操作。');
    }
  }
  notify(method,params){
    if(method!=='session/cancel'||params.sessionId!==this.sessionId||!this.turn)return;
    const turn=this.turn;turn.cancelled=true;
    void this.call('abort').then(()=>turn.resolve({stopReason:'cancelled'}),()=>{});
  }
}
