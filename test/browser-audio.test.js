import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {start} from '../src/main.js';
import vm from 'node:vm';
import http from 'node:http';
import {once} from 'node:events';
import WebSocket from 'ws';
import {VoiceConversation} from '../src/voice/conversation.js';
import {FakeASR,FakeTTS,FakeVAD} from '../src/voice/fake.js';
import {BrowserPlayback,attachBrowserAudio} from '../src/voice/browser-audio.js';

test('browser playback queues continuously up to 300ms, drains actual played acknowledgements and cancels blocked writes',async()=>{
  const packets=[],ws={readyState:1,bufferedAmount:0,send:p=>packets.push(p)},p=new BrowserPlayback(ws);
  let finished=false;const writing=p.write(Buffer.alloc(12800)).then(()=>finished=true);
  await new Promise(r=>setImmediate(r));assert.equal(packets.filter(Buffer.isBuffer).length,3);assert.equal(finished,false);
  p.ack(1);await writing;assert.equal(packets.filter(Buffer.isBuffer).length,4);
  let drained=false;const drain=p.drain().then(()=>drained=true);await new Promise(r=>setImmediate(r));assert.equal(drained,false);
  for(const id of [2,3,4])p.ack(id);await drain;assert.equal(drained,true);
  const blocked=p.write(Buffer.alloc(16000));const rejected=assert.rejects(blocked,{name:'AbortError'});await new Promise(r=>setImmediate(r));p.stop();await rejected;
  const before=packets.length;p.ack(5);assert.equal(packets.length,before);assert.equal(p.pending.size,0);
});

test('audio socket rejects foreign origin, missing CSRF, occupied voice and unexpected paths before upgrading',()=>{
  const server=new EventEmitter(),client={voice:{enabled:false},realtime:{active:false}};
  const bridge=attachBrowserAudio(server,client,{origin:'http://127.0.0.1:4317',csrf:'test-csrf'});
  for(const patch of [{origin:'https://evil.invalid'},{'sec-websocket-protocol':'zhiwei-audio'},{host:'evil.invalid'}]){
    let rejected=false;server.emit('upgrade',{url:'/api/voice/audio',headers:{host:'127.0.0.1:4317',origin:'http://127.0.0.1:4317','sec-websocket-protocol':'zhiwei-audio, test-csrf',...patch}},{end:text=>{rejected=text.includes('403');}},Buffer.alloc(0));assert.equal(rejected,true);
  }
  bridge.close();
});

test('continuous worklet renders adjacent packets without gaps, flushes short tails and discards reset audio',async()=>{
  let Processor;const messages=[];
  const sandbox={Float32Array,Int16Array,AudioWorkletProcessor:class{constructor(){this.port={postMessage:m=>messages.push(m)};}},registerProcessor:(_name,P)=>Processor=P};
  vm.runInNewContext(await readFile(new URL('../public/voice-worklet.js',import.meta.url),'utf8'),sandbox);
  const p=new Processor();
  const send=data=>p.port.onmessage({data});
  send({type:'audio',id:1,samples:new Float32Array(1600).fill(.25)});send({type:'audio',id:2,samples:new Float32Array(1600).fill(.5)});
  const actual=[];for(let i=0;i<25;i++){const out=new Float32Array(128);p.process([[new Float32Array(128)]],[[out]]);actual.push(...out);}
  assert.ok(actual.slice(0,1600).every(v=>v===.25));assert.ok(actual.slice(1600).every(v=>v===.5));assert.deepEqual(messages.filter(m=>m.type==='played').map(m=>m.id),[1,2]);
  send({type:'audio',id:3,samples:new Float32Array(64).fill(.75)});send({type:'flush'});let out=new Float32Array(128);p.process([],[[out]]);assert.equal(out[63],.75);assert.equal(out[64],0);
  send({type:'audio',id:4,samples:new Float32Array(1600).fill(.9)});send({type:'reset'});out=new Float32Array(128);p.process([],[[out]]);assert.ok(out.every(v=>v===0));assert.ok(!messages.some(m=>m.type==='played'&&m.id===4));
  assert.ok(messages.some(m=>m.type==='mic'&&m.pcm.byteLength===640));
});

test('local socket round trip carries PCM to recognition and reply PCM back, then releases on disconnect',async()=>{
  const voice=new VoiceConversation({brain:{run:async()=> '回复',close(){}},providers:{asr:new FakeASR({scripts:[['你好']]}),tts:new FakeTTS(),vad:new FakeVAD()},config:{mode:'wake',wakeEnabled:false}});
  const server=http.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const bridge=attachBrowserAudio(server,{voice,ready(){},realtime:{active:false}},{origin,csrf:'local-token'});
  const ws=new WebSocket(origin.replace('http:','ws:')+'/api/voice/audio',['zhiwei-audio','local-token'],{origin});
  let bytes=0,ready;const started=new Promise(r=>ready=r);
  const received=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('audio round trip timed out')),4000);ws.on('message',(data,binary)=>{
    if(binary){bytes+=data.length-4;ws.send(JSON.stringify({type:'played',id:data.readUInt32LE(0)}));}
    else {const message=JSON.parse(data);if(message.type==='ready')ready();if(message.type==='flush'){clearTimeout(timer);resolve();}}
  });});
  try{
    await started;const pcm=Buffer.alloc(640);pcm.writeInt16LE(4000);ws.send(pcm);ws.send(Buffer.alloc(640));await received;assert.ok(bytes>0);
    const closed=once(ws,'close');ws.close();await closed;
    await voice.setEnabled(false);assert.equal(voice.enabled,false);
  }finally{ws.terminate();bridge.close();await voice.close();await new Promise(r=>server.close(r));}
});

test('pausing microphone keeps the running reply and later typed replies on the real local audio socket', {timeout:8000}, async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'zhiwei-audio-pause-'));
  const rpc=Object.assign(new EventEmitter(),{connected:true,stop:async()=>{}});
  let turn=0;
  rpc.request=async method=>{
    if(method==='model/list')return {data:[{model:'gpt-6.1-sol',displayName:'Sol',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]};
    if(method==='thread/start')return {thread:{id:'thread'}};
    if(method==='turn/start')return {turn:{id:'turn-'+(++turn),status:'inProgress'}};
    throw Error('unexpected RPC '+method);
  };
  const spoken=[],tts=new FakeTTS();
  const app=await start({port:0,workspace:dir,dataDir:path.join(dir,'data'),rpc,trayEnabled:false,
    voiceOptions:{config:{spokenModes:true},providers:{
      asr:new FakeASR({scripts:[['知微，第一问'],['知微，收音已停不该进入识别']]}),
      tts:{synthesize(text,options){spoken.push(text);return tts.synthesize(text,options);}},vad:new FakeVAD(),
    }}});
  app.client.models.selected='gpt-6.1-sol';
  const state=await(await fetch(app.origin+'/api/state')).json();
  const ws=new WebSocket(app.origin.replace('http:','ws:')+'/api/voice/audio',['zhiwei-audio',state.csrf],{origin:app.origin});
  t.after(async()=>{
    ws.terminate();await app.close();
    assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir())+path.sep));
    await rm(dir,{recursive:true,force:true});
  });
  let ready,played=0;
  const started=new Promise(resolve=>ready=resolve);
  ws.on('message',(data,binary)=>{
    if(binary){played++;ws.send(JSON.stringify({type:'played',id:data.readUInt32LE(0)}));}
    else if(JSON.parse(data).type==='ready')ready();
  });
  await started;
  const voice=app.client.voice;
  const until=async predicate=>{
    const deadline=Date.now()+2500;
    while(!predicate()){assert.ok(Date.now()<deadline,voice.error||'local audio state timed out');await delay(5);}
  };
  const control=(type,enabled)=>ws.send(JSON.stringify({type,enabled}));
  const finish=text=>app.client.notification({method:'turn/completed',params:{threadId:'thread',
    turn:{id:'turn-'+turn,status:'completed',items:[{id:'reply-'+turn,type:'agentMessage',text}]}}});
  const typed=async text=>{
    const response=await fetch(app.origin+'/api/send',{method:'POST',headers:{Origin:app.origin,'X-Zhiwei-CSRF':state.csrf,'Content-Type':'application/json'},body:JSON.stringify({text})});
    assert.equal(response.status,200);return (await response.json()).turnId;
  };
  const pcm=Buffer.alloc(640);pcm.writeInt16LE(4000);
  ws.send(pcm);ws.send(Buffer.alloc(640));
  await until(()=>turn===1);
  control('input',false);await until(()=>!voice.snapshot().inputEnabled);
  assert.equal(voice.snapshot().readingEnabled,true);assert.equal(app.client.task.status,'running');
  ws.send(pcm);ws.send(Buffer.alloc(640));
  finish('语音回答');await until(()=>played>0&&voice.state==='idle');
  assert.equal(turn,1);assert.equal(ws.readyState,1);assert.deepEqual(spoken,['语音回答']);
  const before=played;
  await typed('暂停收音后的文字问题');finish('文字也朗读');await until(()=>played>before&&voice.state==='idle');
  assert.deepEqual(spoken,['语音回答','文字也朗读']);
  await typed('只停止朗读');control('reading',false);await until(()=>!voice.snapshot().readingEnabled);
  assert.equal(app.client.task.status,'running');
  finish('仅保留文字');await delay(30);
  assert.equal(app.client.items.get('reply-3').text,'仅保留文字');
  assert.deepEqual(spoken,['语音回答','文字也朗读']);
  control('reading',true);await until(()=>voice.snapshot().readingEnabled);
  await typed('恢复朗读');finish('重新朗读');await until(()=>spoken.includes('重新朗读'));
  assert.equal(voice.snapshot().inputEnabled,false);
});

test('browser audio is ready before any remote thread creation, including a slow fresh conversation', {timeout:2000}, async t=>{
  const voice=new VoiceConversation({brain:{run:async()=>'',close(){}},providers:{asr:new FakeASR(),tts:new FakeTTS(),vad:new FakeVAD()},config:{mode:'wake',wakeEnabled:false}});
  const server=http.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;let attempted=0,release;
  const client={voice,currentId:null,ready(){},realtime:{active:false},newThread(){attempted++;return new Promise(resolve=>release=resolve);}};
  const bridge=attachBrowserAudio(server,client,{origin,csrf:'test'});
  const ws=new WebSocket(origin.replace('http:','ws:')+'/api/voice/audio',['zhiwei-audio','test'],{origin});
  t.after(async()=>{release?.();ws.terminate();bridge.close();await voice.close();await new Promise(resolve=>server.close(resolve));});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('audio readiness waited for remote thread/start')),500);
    ws.on('error',error=>{clearTimeout(timer);reject(error);});
    ws.on('message',(data,binary)=>{if(!binary&&JSON.parse(data).type==='ready'){clearTimeout(timer);resolve();}});
  });
  assert.equal(attempted,0);assert.equal(voice.enabled,true);
});
