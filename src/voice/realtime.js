import {CaptionTranslator,StreamingCaption} from './captions.js';
import { randomUUID } from 'node:crypto';
import { safeError } from '../codex/process.js';
import {waitUntilStopped} from './brain.js';
import {isVoiceFiller,voiceTaskControl,voiceTaskInstructions} from './task-control.js';

const ignoreFillers='“嗯”“嗯嗯”“啊”“呃”和单独的附和声不构成新请求。继续当前回答或任务，不回复、不委派这些声音。';

// Codex owns speech understanding, response generation and tool delegation.
// Explicit priority controls reuse the client's interrupt/send path without closing WebRTC.
export class RealtimeVoice {
  constructor(client,{timeoutMs=30000}={}) { this.client=client;this.translator=new CaptionTranslator(client.rpc);this.captionPipeline=new StreamingCaption(this.translator,caption=>{this.caption=caption;this.changed();});this.timeoutMs=timeoutMs;this.status='off';this.epoch=0;this.live=new Map();this.canonical=new Map();this.canonicalRoles=new Set();this.handledInputs=new Set();this.userInputs=[]; }
  get active(){return ['connecting','connected','stopping','unknown'].includes(this.status);}
  snapshot(){return {status:this.status,error:this.error??null,taskControl:this.taskControl??null,threadId:this.threadId??null,sessionId:this.sessionId??null,caption:this.caption??null,captionSource:this.captionSource??null,captionEngine:this.captionEngine??'cloud'};}
  changed(){this.client.changed();}
  async start(sdp,{language='en',captionEngine='cloud'}={}){
    if(!['cloud','local'].includes(captionEngine))throw new Error('字幕引擎无效');
    if(!['en','zh'].includes(language))throw new Error('不支持的语音语言');
    if(typeof sdp!=='string'||!sdp.startsWith('v=0')||sdp.length>100000)throw new Error('WebRTC 会话描述无效');
    if(this.active||this.client.locked||this.client.busy)throw new Error('当前已有任务或语音连接，请先停止。');
    if(this.client.voice.enabled||this.client.voice.changing)throw new Error('请先关闭旧语音，避免同时占用麦克风。');
    this.client.ready();
    const epoch=++this.epoch;this.status='connecting';this.error=null;this.caption=null;this.captionSource=null;this.captionEngine=captionEngine;this.captionPipeline.reset();this.blockTurns=false;this.live.clear();this.canonical.clear();this.canonicalRoles.clear();this.changed();
    this.handledInputs.clear();this.userInputs=[];this.taskControl=null;
    let timer;
    try {
      if(!this.client.currentId)await this.client.newThread(this);
      const projectContext=this.client.projectContext?await this.client.projectContext():undefined;
      if(epoch!==this.epoch)throw new Error('语音连接已取消');
      if(this.client.needsResume)throw new Error('请先恢复当前对话');
      const persistence=this.client.markThreadUsed();
      if(persistence)await persistence;
      if(epoch!==this.epoch)throw new Error('语音连接已取消');
      this.threadId=this.client.currentId;this.voiceId=randomUUID();
      const answer=new Promise((resolve,reject)=>{
        this.waiter={resolve,reject};
        timer=setTimeout(()=>reject(new Error('Codex 原生语音连接超时，未自动重试')),this.timeoutMs);
      });
      answer.catch(()=>{});
      this.startRequest=this.client.rpc.request('thread/realtime/start',{
        threadId:this.threadId,outputModality:'audio',version:'v3',voice:'juniper',transport:{type:'webrtc',sdp},
        initialItems:[{role:'developer',text:(language==='en'?'默认用温柔自然的英语说话，用户可要求切换语言。':'默认用自然中文说话。')+'需要执行或核验的项目问题先交给当前 Codex Thread，用 zhiwei_projects 查询本机项目目录和历史，不能仅查看测试目录。'+'你是沈知微。发音清楚自然，语气温和，语速适中。按完整的短句连贯地说，避免逐字停顿、刻意拖音和无必要的中英夹杂。用户插话时停止当前回复并听取新指令。连接建立不是用户指令，请安静等待用户开口。执行任务仍须遵守 Codex 工具审批与工作区限制。'+voiceTaskInstructions}],
        includeStartupContext:false,clientManagedHandoffs:false,flushTranscriptTailOnSessionEnd:false,
        voiceSessionId:this.voiceId,
        realtimeStartInstructions:'你是沈知微。连接建立不是用户指令，请安静等待用户开口。请按本次选择的语言自然简洁地交流。需要执行任务时交给当前 Codex Thread，遵守其工具审批和工作区限制。用户可随时插话；不要因启动或重连而擅自执行任务。'+ignoreFillers+voiceTaskInstructions+
          (projectContext?'\n\n单独询问当前项目的进度时，直接按下方台账回答进展、下一步、证据和更新时间，明确说出待确认项。用户问声纹时只读声纹条目，台账缺失则说不知道。需要执行或另行核验时，委派请带上项目目录、台账和用户在本轮明确说出的范围及验收条件。\n'+projectContext:''),
      },this.timeoutMs);
      await this.startRequest;
      const remote=await answer;
      if(epoch!==this.epoch)throw new Error('语音连接已取消');
      // SDP means negotiation accepted, not an established media connection.
      return {sdp:remote,session:this.voiceId};
    } catch(error){
      if(epoch===this.epoch){await this.stop().catch(()=>{});this.error=safeError(error);if(this.status!=='unknown')this.status='error';this.changed();}
      throw error;
    } finally{clearTimeout(timer);if(epoch===this.epoch)this.waiter=null;}
  }
  connected(session){
    if(session!==this.voiceId||this.status!=='connecting')throw new Error('语音连接已失效');
    this.status='connected';this.changed();
    if(this.captionEngine!=='local')void this.translator.thread().catch(()=>{});
  }
  stop(session){
    if(session&&session!==this.voiceId)return Promise.resolve();
    if(this.stopping)return this.stopping;
    if(!this.active)return Promise.resolve();
    ++this.epoch;this.controlAbort?.abort();this.blockTurns=true;this.waiter?.reject(new Error('语音连接已停止'));this.waiter=null;
    this.status='stopping';this.changed();
    this.stopping=(async()=>{
      try {const request=this.startRequest;await request?.catch(()=>{});if(request&&this.threadId&&this.client.rpc.connected)await this.client.rpc.request('thread/realtime/stop',{threadId:this.threadId},8000);this.status='off';}
      catch(error){this.status='unknown';this.error='未确认原生语音已关闭，请重新连接并恢复会话核对。';throw error;}
      finally{this.sessionId=null;this.startRequest=null;this.live.clear();this.stopping=null;this.changed();}
    })();return this.stopping;
  }
  disconnected(){++this.epoch;this.controlAbort?.abort();this.waiter?.reject(new Error('Codex 连接断开'));this.waiter=null;this.status='off';this.sessionId=null;this.live.clear();this.changed();}
  receiveUserText(id,text){
    if(!text.trim()||isVoiceFiller(text)||this.handledInputs.has(id))return;
    this.handledInputs.add(id);while(this.handledInputs.size>128)this.handledInputs.delete(this.handledInputs.values().next().value);
    const recent=this.userInputs.slice(-4);this.userInputs.push(text);this.userInputs=this.userInputs.slice(-8);
    const directive=voiceTaskControl(text),client=this.client;
    if(directive==='append'){
      if(this.controlAbort&&!this.controlAbort.signal.aborted){
        if(!this.controlDispatched)this.controlTail.push(text);
        else {const epoch=this.epoch;void this.controlWork.then(()=>{if(epoch===this.epoch&&this.active)this.steerUserText(text);});}
        return;
      }
      if(this.blockTurns)this.blockTurns=false;
      this.steerUserText(text);
      return;
    }
    this.controlAbort?.abort();const controller=this.controlAbort=new AbortController();this.controlTail=[];this.controlDispatched=false;
    const epoch=this.epoch;this.blockTurns=true;client.computer?.cancel();this.error=null;
    this.taskControl=directive==='stop'?'已收到，正在停止任务…':'已收到，正在停止旧任务，随后优先处理新请求…';this.changed();
    this.controlWork=(async()=>{
      await client.interrupt({keepRealtime:true});
      await waitUntilStopped(client,45000,controller.signal);
      if(controller.signal.aborted||epoch!==this.epoch||!this.active)return;
      if(directive==='stop'&&!this.controlTail.length){
        await client.rpc.request('thread/realtime/appendText',{threadId:this.threadId,role:'developer',text:'用户已停止任务。旧任务与待办已取消，不得自动恢复，也不要再次委派它们。请简短确认停止。'});
      }else{
        const prompt=`用户已更改任务优先级。旧任务和旧待办暂停，不得自动恢复；已经完成的动作不得重做。只执行最新请求：\n${text}\n${this.controlTail.join('\n')}\n最近语音仅供解析“第几个任务”，不得全部执行：\n${recent.join('\n')}`;
        this.controlDispatched=true;
        await client.send(prompt,this,{signal:controller.signal});
      }
    })().catch(error=>{if(!controller.signal.aborted&&epoch===this.epoch&&this.active){this.error=`任务切换未完成：${safeError(error)}`;this.changed();}}).finally(()=>{if(this.controlAbort===controller){this.controlAbort=null;this.controlTail=[];this.taskControl=null;}this.changed();});
  }
  steerUserText(text){
    const client=this.client;
    if(client.task?.status!=='running'||typeof client.steer!=='function')return;
    if([...client.items.values()].some(item=>item.type==='userMessage'&&item.turnId===client.task.turnId&&item.text.trim()===text.trim()))return;
    // Direct delivery bypasses the voice model's potentially delayed handoff.
    const turnId=client.task.turnId,epoch=this.epoch;
    void client.steer(text,turnId).catch(error=>{if(epoch===this.epoch&&this.active){this.error=`语音补充未送达：${safeError(error)}`;this.changed();}});
  }
  notification(method,p){
    if(!method.startsWith('thread/realtime/')||p.threadId!==this.threadId)return;
    if(method==='thread/realtime/closed'){
      this.controlAbort?.abort();this.taskControl=null;
      this.waiter?.reject(new Error('Codex 语音会话已关闭'));this.waiter=null;this.status='off';this.sessionId=null;this.changed();return;
    }
    if(!this.active||this.status==='stopping')return;
    if(['thread/realtime/item/started','thread/realtime/item/completed'].includes(method)){
      const item=p.item;
      if(item?.type!=='transcriptSegment'||!['user','assistant'].includes(item.role)||typeof item.id!=='string')return;
      const done=method.endsWith('/completed');
      const old=this.live.get(item.role);if(old&&!this.canonicalRoles.has(item.role))this.client.items?.delete(old.id);
      this.canonicalRoles.add(item.role);
      const entry=this.canonical.get(item.id)??{id:item.id,role:item.role,text:old?.text??''};
      if(entry.done)return;
      if(typeof item.text==='string'&&(item.text||done))entry.text=item.text.slice(0,200000);
      entry.done=done;this.canonical.set(item.id,entry);
      while(this.canonical.size>128)this.canonical.delete(this.canonical.keys().next().value);
      this.publish(entry,done);return;
    }
    if(method==='thread/realtime/item/transcript/delta'){
      const entry=this.canonical.get(p.itemId);if(!entry||entry.done||typeof p.delta!=='string')return;
      entry.text=(entry.text+p.delta).slice(0,200000);this.publish(entry,false);return;
    }
    if(method==='thread/realtime/sdp'){if(typeof p.sdp==='string')this.waiter?.resolve(p.sdp);}
    else if(method==='thread/realtime/started')this.sessionId=p.realtimeSessionId;
    else if(method==='thread/realtime/error'){
      this.error=safeError(p.message);this.waiter?.reject(new Error(this.error));
      void this.stop().catch(()=>{}).finally(()=>{if(this.status!=='unknown')this.status='error';this.changed();});
    }
    else if(['thread/realtime/transcript/delta','thread/realtime/transcript/done'].includes(method)&&['user','assistant'].includes(p.role)){
      if(this.canonicalRoles.has(p.role))return;
      const done=method.endsWith('/done'),text=done?p.text:p.delta;
      if(typeof text!=='string')return;
      let entry=this.live.get(p.role);
      if(!entry){entry={id:`voice-${randomUUID()}`,text:''};this.live.set(p.role,entry);}
      entry.text=(done?text:entry.text+text).slice(0,200000);
      this.client.upsert({id:entry.id,type:p.role==='user'?'userMessage':'agentMessage',...(p.role==='user'?{content:[{type:'text',text:entry.text}]}:{text:entry.text})},null,done);
      if(p.role==='assistant')this.translateCaption(entry.id,entry.text,done);
      if(p.role==='user'&&done)this.receiveUserText(entry.id,entry.text);
      if(done)this.live.delete(p.role);
      this.changed();
    }
  }
  publish(entry,done){
    this.client.upsert({id:entry.id,type:entry.role==='user'?'userMessage':'agentMessage',...(entry.role==='user'?{content:[{type:'text',text:entry.text}]}:{text:entry.text})},null,done);
    if(entry.role==='assistant')this.translateCaption(entry.id,entry.text,done);
    if(entry.role==='user'&&done)this.receiveUserText(entry.id,entry.text);
    this.changed();
  }
  translateCaption(id,text,done=false){this.captionSource={id,text,done};if(this.captionEngine!=='local')this.captionPipeline.feed(id,text,done);this.changed();}
}
