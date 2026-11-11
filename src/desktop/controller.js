import {EventEmitter} from 'node:events';
import path from 'node:path';
import {VoiceConversation} from '../voice/conversation.js';
import {readJson,writeJson} from '../workbench/storage.js';
import {WindowsCapture} from '../voice/windows/audio.js';
import {readScreen} from './screen.js';

export class DesktopVoice extends EventEmitter {
  constructor({workbench,tray,dataDir,createVoice=options=>new VoiceConversation(options),captureScreen=readScreen,platform=process.platform,createCapture=()=>new WindowsCapture(),settleMs=1400}){
    super();Object.assign(this,{workbench,tray,createVoice,captureScreen,platform,createCapture,settleMs});
    this.file=path.join(dataDir,'desktop-settings.json');
    this.settings={enabled:true,screenContext:false};
    this.onWorkbench=()=>this.updateOverlay();workbench.on('change',this.onWorkbench);
    this.onKey=event=>{void this.key(event).catch(()=>{});};
    tray?.on('hotkey',this.onKey);
    tray?.on('desktop-ready',value=>{this.hotkeyReady=value.ready;this.error=value.error||null;this.changed();});
  }
  async load(){
    const value=await readJson(this.file,this.settings);this.validate(value);this.settings=value;
    this.newCapture();
    this.prepareCapture();
    return this;
  }
  newCapture(){
    const capture=this.capture=this.createCapture();
    capture?.on('error',()=>{if(this.capture===capture){this.error='后台麦克风准备失败，请检查设备后重试。';this.changed();}});
  }
  prepareCapture(){
    if(this.closing||!this.settings.enabled||!this.capture)return;
    if(this.voice&&this.voice.capture===this.capture&&!this.capture.worker)this.newCapture();
    this.warm=this.capture.prepare().catch(()=>{});
  }
  validate(value){if(typeof value?.enabled!=='boolean'||typeof value?.screenContext!=='boolean'||Object.keys(value).some(key=>!['enabled','screenContext'].includes(key)))throw Error('后台设置无效。');}
  snapshot(){return {supported:this.platform==='win32',settings:this.settings,active:!!this.voice,held:!!this.held,hotkeyReady:!!this.hotkeyReady,error:this.error||null,state:this.voice?.state||'idle'};}
  changed(){this.emit('change');}
  async configure(value){
    this.validate(value);if(this.voice)throw Error('请先结束后台语音再修改设置。');
    await writeJson(this.file,value);this.settings={...value};this.tray?.setDesktopEnabled?.(value.enabled);if(value.enabled)this.prepareCapture();else await this.capture?.close();this.changed();
  }
  imageSupported(client){
    if(client.connectionStages?.agent==='codex')return true;
    if(client.init)return client.init.agentCapabilities?.promptCapabilities?.image===true;
    return client.modelOptions?.find(model=>model.id===client.selectedModel)?.images===true;
  }
  show(state,text){
    const overlay={state,text:String(text||'').slice(0,160),level:Math.round((this.voice?.level||0)*20)/20};
    const signature=JSON.stringify(overlay);if(this.lastOverlay===signature)return;
    this.lastOverlay=signature;this.tray?.setOverlay?.(overlay);
  }
  async key({action,windowId}){
    if(this.closing||!this.settings.enabled)return;
    if(action==='stop'){this.release();return;}
    if(action==='cancel'){await this.stop();return;}
    if(action!=='start'||this.held)return;
    this.held=true;this.releasedDuringStop=false;this.error=null;clearTimeout(this.settleTimer);
    try{
      const wb=this.workbench;
      if(wb.voice.enabled||wb.voice.changing||wb.realtime.active)throw Error('请先结束主界面的语音，再使用后台快捷键。');
      wb.ready();
      this.show('starting','正在准备麦克风…');
      await this.warm;if(this.closing||!this.held)return;
      if(this.voice){
        await this.stop({hide:false});
        if(this.closing)return;
        // A release received during teardown must not start another microphone.
        if(this.releasedDuringStop)return;
        this.held=true;
      }
      const active=wb.active,project=wb.project,session=active.currentId;
      this.requestScope=new AbortController();
      let screen;
      if(this.settings.screenContext){
        if(!this.imageSupported(active))this.screenWarning='当前 Agent 使用窗口文字，未发送截图。';
        this.screenWork=this.captureScreen(windowId,{signal:this.requestScope.signal,image:this.imageSupported(active)}).then(value=>{screen=value;}).catch(()=>{this.screenWarning='当前窗口未能读取，本次只发送语音文字。';screen={title:'当前窗口未读取',text:'未取得本次屏幕画面。不得推断用户屏幕内容；需要画面时请让用户保持目标窗口在前台再试。'};});
      }
      const brain={
        stop:options=>wb.brain().stop(options),
        run:async(text,options)=>{
          const local=wb.modeReply(text)||await wb.controlReply(text,{...options,voiceCommand:true})||await wb.answerProgress(text,options);
          if(local)return local;
          wb.assertSelection(active,project);await wb.validateProject(project);
          await this.screenWork;options.signal.throwIfAborted();wb.assertSelection(active,project);
          if(active.currentId!==session)throw Error('对话已切换，请重新按住快捷键说话。');
          const evidence=screen;screen=undefined;this.screenWork=null;
          return wb.brain().run(text,{...options,screenContext:evidence});
        },
      };
      this.show('starting','正在准备麦克风…');
      const config={...wb.voice.config,mode:'ptt',spokenModes:false,audio:'windows',pipelineOptions:{...wb.voice.config.pipelineOptions,confirmBargeIn:false}};
      const voice=this.voice=this.createVoice({brain,config,...(this.capture?{capture:this.capture}:{})});
      voice.on('change',()=>this.update());
      voice.on('level',()=>this.updateOverlay());
      await voice.setEnabled(true);
      if(this.closing||this.voice!==voice)return;
      if(!this.held){await this.stop();return;}
      voice.ptt('start');this.update();
    }catch(error){
      this.error=error.message;await this.stop({hide:false});this.show('error',this.error);this.changed();
    }
  }
  release(){
    this.releasedDuringStop=true;this.held=false;
    const voice=this.voice;
    if(!voice)this.show('hidden','');
    if(voice?.pipeline?.held){voice.ptt('stop');void voice.capture?.close().then(()=>this.prepareCapture()).catch(()=>{});}
    this.update();
  }
  updateOverlay(){
    const voice=this.voice;if(!voice)return;
    const states={listening:'正在听，松开发送',thinking:'正在处理',speaking:'正在回答',idle:'本次对话已结束',interrupted:'已打断'};
    const item=[...this.workbench.active.items.values()].findLast(item=>item.type==='agentMessage');
    const pending=this.workbench.active.approvals?.size||this.workbench.active.questions?.size;
    const state=voice.changing?'starting':pending?'approval':voice.error?'error':voice.state;
    const text=pending?'需要确认，请从托盘打开知微查看':voice.error||this.screenWarning||(state==='speaking'?item?.text:'')||voice.partial||states[state]||'正在准备…';
    this.show(state,text);
  }
  update(){
    if(this.voice?.error)this.error=this.voice.error;
    this.updateOverlay();this.changed();clearTimeout(this.settleTimer);
    if(this.voice&&!this.held&&!this.voice.changing&&this.voice.state==='idle'){
      this.settleTimer=setTimeout(()=>{void this.stop();},this.voice.error?4500:this.settleMs);this.settleTimer.unref?.();
    }
  }
  async stop({hide=true}={}){
    clearTimeout(this.settleTimer);this.held=false;this.requestScope?.abort();this.requestScope=null;
    const voice=this.voice;this.voice=null;
    await voice?.close().catch(()=>{});
    await this.screenWork;this.screenWork=null;this.screenWarning=null;
    this.prepareCapture();
    if(hide)this.show('hidden','');
    this.changed();
  }
  async close(){this.closing=true;this.tray?.off('hotkey',this.onKey);this.workbench.off('change',this.onWorkbench);await this.stop();await this.capture?.close();await this.warm;}
}
