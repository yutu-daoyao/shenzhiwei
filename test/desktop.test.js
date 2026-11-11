import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {DesktopVoice} from '../src/desktop/controller.js';
import {screenText} from '../src/desktop/screen.js';

async function rig(t,{deferred=false}={}){
  const dir=await mkdtemp(path.join(tmpdir(),'zhiwei-desktop-'));
  const tray=new EventEmitter(),overlays=[],voices=[],calls=[],screens=[];
  tray.setOverlay=value=>overlays.push(value);tray.setDesktopEnabled=value=>calls.push(['enabled',value]);
  const active={items:new Map(),approvals:new Map(),questions:new Map(),connectionStages:{agent:'codex'}};
  const wb=new EventEmitter();Object.assign(wb,{active,project:{id:'test'},voice:{enabled:false,config:{provider:'fake',asr:'fake'}},realtime:{active:false},
    ready(){},assertSelection(a,p){assert.equal(a,this.active);assert.equal(p,this.project);},validateProject:async()=>{},
    modeReply:()=>null,controlReply:async()=>null,answerProgress:async()=>null,
    brain:()=>({run:async(text,options)=>{calls.push(['send',text,options.screenContext]);return '已经处理';},stop:async()=>{}})});
  let resume;
  const desk=await new DesktopVoice({workbench:wb,tray,dataDir:dir,platform:'win32',createCapture:()=>null,settleMs:2,
    captureScreen:async(id,opts)=>{screens.push([id,opts.image]);return {title:'测试文档',text:'第一段',image:'data:image/jpeg;base64,AAA='};},
    createVoice:options=>{
      const voice=new EventEmitter();Object.assign(voice,{options,config:options.config,pipeline:{held:false},state:'idle',
        capture:{close:async()=>{calls.push(['mic-close']);}},
        setEnabled:async()=>{voice.changing=true;if(deferred)await new Promise(resolve=>{resume=resolve;});voice.enabled=true;voice.changing=false;},
        ptt(action){this.pipeline.held=action==='start';this.state=action==='start'?'listening':'thinking';calls.push(['ptt',action]);this.emit('change');},
        close:async()=>{voice.closed=true;voice.enabled=false;calls.push(['voice-close']);},
      });voices.push(voice);return voice;
    }}).load();
  desk.settings.screenContext=true;
  t.after(async()=>{await desk.close();await rm(dir,{recursive:true,force:true,maxRetries:3});});
  return {desk,tray,wb,active,overlays,voices,calls,screens,dir,releaseStartup:()=>resume()};
}
test('desktop key events use one PTT round, release capture and pass real screen evidence only to the selected Agent',async t=>{
  const r=await rig(t);await r.desk.key({action:'start',windowId:'123'});
  await r.desk.key({action:'start',windowId:'123'});assert.equal(r.voices.length,1);
  assert.equal(r.voices[0].config.mode,'ptt');assert.equal(r.voices[0].config.spokenModes,false);
  assert.deepEqual(r.calls,[['ptt','start']]);
  r.desk.release();assert.deepEqual(r.calls.slice(-2),[['ptt','stop'],['mic-close']]);
  const signal=new AbortController().signal;
  assert.equal(await r.voices[0].options.brain.run('改正式一点',{signal}),'已经处理');
  assert.equal(r.calls.at(-1)[0],'send');assert.equal(r.calls.at(-1)[2].title,'测试文档');
  assert.equal(r.screens[0][1],true);
  assert.ok(!JSON.stringify(r.desk.snapshot()).includes('AAA='));
  r.voices[0].state='idle';r.voices[0].emit('change');await delay(10);
  assert.equal(r.desk.voice,null);assert.equal(r.overlays.at(-1).state,'hidden');
});
test('a quick key release during startup closes the microphone without submitting an utterance',async t=>{
  const r=await rig(t,{deferred:true});
  const starting=r.desk.key({action:'start',windowId:'123'});
  await delay(0);r.desk.release();r.releaseStartup();await starting;
  assert.equal(r.desk.voice,null);assert.ok(!r.calls.some(call=>call[0]==='ptt'));
});
test('disabled screen context does not capture; settings are atomic and reject changes during voice',async t=>{
  const r=await rig(t);await r.desk.configure({enabled:true,screenContext:false});
  assert.deepEqual(JSON.parse(await readFile(path.join(r.dir,'desktop-settings.json'),'utf8')),{enabled:true,screenContext:false});
  await r.desk.key({action:'start',windowId:'123'});assert.equal(r.screens.length,0);
  await assert.rejects(r.desk.configure({enabled:false,screenContext:false}),/结束后台语音/);
  await r.desk.stop();await r.desk.configure({enabled:false,screenContext:false});
  await r.desk.key({action:'start',windowId:'123'});assert.equal(r.voices.length,1);
});
test('desktop PTT does not take over a browser microphone and rejects an Agent switch during screenshot capture',async t=>{
  const r=await rig(t);r.wb.voice.enabled=true;await r.desk.key({action:'start',windowId:'123'});
  assert.equal(r.voices.length,0);assert.match(r.desk.error,/主界面/);
  r.wb.voice.enabled=false;await r.desk.key({action:'start',windowId:'123'});
  const original=r.wb.project;
  r.wb.project={id:'different'};
  await assert.rejects(r.voices[0].options.brain.run('当前文档',{signal:new AbortController().signal}));
  r.wb.project=original;r.active.currentId='new-conversation';
  await assert.rejects(r.voices[0].options.brain.run('原对话',{signal:new AbortController().signal}),/对话已切换/);
  assert.ok(!r.calls.some(call=>call[0]==='send'));
});
test('screen context explicitly labels UI text as reference and never includes absent images',()=>{
  assert.match(screenText({title:'文档',text:'段落'}),/只供参考/);
  assert.equal(screenText(null),'');
});
