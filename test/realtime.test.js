import test from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeVoice } from '../src/voice/realtime.js';
import { createNativeVoice } from '../public/native-voice.js';
import { EventEmitter } from 'node:events';
import { Zhiwei } from '../src/client.js';
import {voiceTaskControl} from '../src/voice/task-control.js';

test('spoken task controls distinguish replacement, stop, quoted examples and additions',()=>{
  for(const text of ['前面的不用管，先帮我打开微信','你要先完成第三个任务，一二个不用管','先处理刚才的第三件'])assert.equal(voiceTaskControl(text),'replace');
  assert.equal(voiceTaskControl('取消所有任务'),'stop');
  for(const text of ['然后帮我打开 Codex','比如先打开微信再说你好','把“先做第三件”翻译成英文'])assert.equal(voiceTaskControl(text),'append');
});

async function priorityHost(t){
  const rpc=new EventEmitter(),calls=[];let releaseStop,sequence=0;
  const c=new Zhiwei({rpc,workspace:'.',dataDir:'.'});c.currentId='thread';c.claimWriter(c.currentId);
  c.sessions.entries=[{id:'thread',title:'已有会话'}];c.sessions.put=async()=>{};
  Object.assign(rpc,{connected:true,stop:async()=>{rpc.connected=false;},request:async(method,params)=>{
    calls.push({method,params});
    if(method==='thread/realtime/start')c.notification({method:'thread/realtime/sdp',params:{threadId:'thread',sdp:'v=0\r\nanswer'}});
    if(method==='turn/interrupt')await new Promise(resolve=>{releaseStop=()=>{
      c.notification({method:'turn/completed',params:{threadId:'thread',turn:{id:params.turnId,status:'interrupted',items:[]}}});resolve({});
    };});
    if(method==='turn/start')return {turn:{id:`replacement-${++sequence}`,status:'inProgress'}};
    return {};
  }});
  const connection=await c.realtime.start('v=0',{captionEngine:'local'});c.realtime.connected(connection.session);
  c.task={status:'running',turnId:'navigation'};
  t.after(async()=>{releaseStop?.();c.task.status='completed';await c.close();});
  return {c,voice:c.realtime,calls,release:()=>releaseStop()};
}

test('native follow-up reaches an active turn immediately and canonical completion is deduplicated',async t=>{
  const r=await priorityHost(t);
  r.voice.receiveUserText('filler','嗯嗯……');
  assert.equal(r.calls.filter(c=>c.method==='turn/steer').length,0);
  const event={threadId:'thread',item:{id:'second',type:'transcriptSegment',role:'user',text:'然后帮我打开 Codex'}};
  r.c.notification({method:'thread/realtime/item/completed',params:event});
  r.c.notification({method:'thread/realtime/item/completed',params:event});
  const steers=r.calls.filter(c=>c.method==='turn/steer');assert.equal(steers.length,1);
  assert.equal(steers[0].params.expectedTurnId,'navigation');assert.match(steers[0].params.input[0].text,/打开 Codex/);
  assert.equal(r.calls.filter(c=>c.method==='turn/start').length,0);
});

test('priority speech interrupts first, preserves the live microphone session, and carries follow-up details',async t=>{
  const r=await priorityHost(t);
  r.voice.receiveUserText('third','前面两个不用管，先帮我打开微信');
  r.voice.receiveUserText('detail','只打开主窗口');
  assert.equal(r.calls.filter(c=>c.method==='turn/start').length,0);
  r.release();await r.voice.controlWork;
  const starts=r.calls.filter(c=>c.method==='turn/start');assert.equal(starts.length,1);
  assert.match(starts[0].params.input[0].text,/只执行最新请求：[\s\S]*打开微信[\s\S]*只打开主窗口/);
  assert.equal(r.voice.status,'connected');assert.ok(!r.calls.some(c=>c.method==='thread/realtime/stop'));
});

test('latest priority wins during stop acknowledgement; stopping voice prevents a delayed replacement',async t=>{
  const r=await priorityHost(t);
  r.voice.receiveUserText('wechat','先打开微信');const obsolete=r.voice.controlWork;
  r.voice.receiveUserText('calculator','先打开计算器');const latest=r.voice.controlWork;
  r.release();await Promise.all([obsolete,latest]);
  const starts=r.calls.filter(c=>c.method==='turn/start');assert.equal(starts.length,1);
  assert.match(starts[0].params.input[0].text.split('最近语音')[0],/计算器/);
  assert.doesNotMatch(starts[0].params.input[0].text.split('最近语音')[0],/微信/);
  r.voice.receiveUserText('another','先打开微信');const pending=r.voice.controlWork;
  await r.voice.stop();r.release();await pending;
  assert.equal(r.calls.filter(c=>c.method==='turn/start').length,1);
});

function host(){
  const calls=[],items=new Map();
  const client={items,voice:{enabled:false},currentId:null,busy:false,locked:false,ready(){},changed(){},
    async newThread(owner){assert.equal(owner,voice);this.currentId='thread';},
    markThreadUsed(){},
    upsert(item){items.set(item.id,item);},rpc:{connected:true,async request(method,params){
      calls.push({method,params});
      if(method==='thread/realtime/start'){
        voice.notification('thread/realtime/started',{threadId:'thread',realtimeSessionId:'native'});
        voice.notification('thread/realtime/sdp',{threadId:'thread',sdp:'v=0\r\nanswer'});
      }
      return {};
    }}};
  const voice=new RealtimeVoice(client,{timeoutMs:100});return {client,voice,calls,items};
}
test('native negotiation uses same thread, handles early SDP, and waits for actual media connection',async()=>{
  const h=host(),result=await h.voice.start('v=0\r\noffer');
  assert.equal(h.voice.status,'connecting');assert.equal(result.sdp,'v=0\r\nanswer');
  const p=h.calls[0].params;
  assert.equal(p.threadId,'thread');assert.equal(p.version,'v3');assert.equal(p.transport.type,'webrtc');
  assert.equal(p.voice,'juniper');assert.equal(p.initialItems[0].role,'developer');assert.match(p.initialItems[0].text,/英语/);
  assert.equal(p.includeStartupContext,false);assert.equal(p.flushTranscriptTailOnSessionEnd,false);
  assert.throws(()=>h.voice.connected('old'),/失效/);
  h.voice.connected(result.session);assert.equal(h.voice.status,'connected');
  assert.ok(!JSON.stringify(h.voice.snapshot()).includes('answer'));
  await h.voice.stop('old');assert.equal(h.voice.status,'connected');
  await h.voice.stop(result.session);assert.equal(h.voice.status,'off');
});
test('native transcripts replace deltas and reject hidden roles, foreign threads and late output',async()=>{
  const h=host();await h.voice.start('v=0');
  for(const [method,text] of [['delta','你'],['delta','好'],['done','你好！']])h.voice.notification(`thread/realtime/transcript/${method}`,{threadId:'thread',role:'assistant',delta:text,text});
  h.voice.notification('thread/realtime/transcript/done',{threadId:'foreign',role:'user',text:'FOREIGN'});
  h.voice.notification('thread/realtime/transcript/done',{threadId:'thread',role:'reasoning',text:'HIDDEN'});
  assert.equal(h.items.size,1);assert.equal([...h.items.values()][0].text,'你好！');
  await h.voice.stop();h.voice.notification('thread/realtime/transcript/done',{threadId:'thread',role:'assistant',text:'late'});
  assert.equal(h.items.size,1);
});
test('cancel during start waits for native request before stopping and never reports connected',async()=>{
  const h=host();let release;
  h.client.currentId='thread';h.client.rpc.request=async(method)=>{
    h.calls.push(method);if(method==='thread/realtime/start')await new Promise(resolve=>{release=resolve;});return {};
  };
  const starting=assert.rejects(h.voice.start('v=0'),/停止/);
  const stopping=h.voice.stop();assert.equal(h.calls.length,1);
  release();await starting;await stopping;
  assert.deepEqual(h.calls,['thread/realtime/start','thread/realtime/stop']);assert.equal(h.voice.status,'off');
});
test('stopping while reading the project ledger avoids a late native start',async()=>{
  const h=host();h.client.currentId='thread';let release;
  h.client.projectContext=()=>new Promise(resolve=>{release=resolve;});
  const starting=assert.rejects(h.voice.start('v=0'),/取消/);
  await h.voice.stop();
  release('项目台账');
  await starting;
  assert.deepEqual(h.calls,[]);assert.equal(h.voice.status,'off');
});
test('native failures are visible and do not fall back to an independent speech service',async()=>{
  const h=host();h.client.currentId='thread';
  h.client.rpc.request=async method=>{if(method.endsWith('/start'))throw new Error('Voice unavailable');return {};};
  await assert.rejects(h.voice.start('v=0'),/Voice unavailable/);
  assert.equal(h.voice.status,'error');assert.match(h.voice.error,/Voice unavailable/);
  await assert.rejects(h.voice.start('bad SDP'),/无效/);
});

test('canonical speech segments replace legacy partials and ignore duplicate completion or hidden roles',async()=>{
  const h=host();await h.voice.start('v=0');
  const emit=(method,p)=>h.voice.notification('thread/realtime/'+method,{threadId:'thread',...p});
  emit('transcript/delta',{role:'assistant',delta:'旧片段'});
  emit('item/started',{item:{id:'segment',type:'transcriptSegment',role:'assistant',text:''}});
  emit('item/transcript/delta',{itemId:'segment',delta:'你好'});
  emit('item/completed',{item:{id:'segment',type:'transcriptSegment',role:'assistant',text:'你好！'}});
  emit('item/transcript/delta',{itemId:'segment',delta:'晚到'});
  emit('item/completed',{item:{id:'segment',type:'transcriptSegment',role:'assistant',text:'重复'}});
  emit('transcript/done',{role:'assistant',text:'旧协议重复'});
  emit('item/started',{item:{id:'hidden',type:'transcriptSegment',role:'reasoning',text:'隐藏'}});
  assert.equal(h.items.size,1);assert.equal(h.items.get('segment').text,'你好！');
  await h.voice.stop();
});

test('stop during browser connected acknowledgement cannot resurrect playback or connected state',async()=>{
  let release,ack;const reached=new Promise(resolve=>ack=resolve),errors=[],tracks=[];
  class Peer{
    constructor(){this.iceGatheringState='complete';}addTrack(){} createDataChannel(){}
    async createOffer(){return {sdp:'v=0'};}async setLocalDescription(value){this.localDescription=value;}
    async setRemoteDescription(){this.connectionState='connected';this.onconnectionstatechange();}
    close(){this.closed=true;}
  }
  class Audio{pause(){}}
  const voice=createNativeVoice({Peer,AudioElement:Audio,onError:e=>errors.push(e),
    media:{async getUserMedia(){const t={stop(){t.stopped=true;}};tracks.push(t);return {getTracks:()=>tracks,getAudioTracks:()=>tracks};}},
    async api(route){if(route.endsWith('/start'))return {session:'s',sdp:'v=0'};if(route.endsWith('/connected')){ack();await new Promise(resolve=>release=resolve);}return {};}});
  const starting=voice.start();await reached;await voice.stop();release();await starting;
  assert.equal(voice.status,'off');assert.equal(tracks[0].stopped,true);assert.deepEqual(errors,[]);
});

function browser(){
  const calls=[],tracks=[],peers=[],errors=[];
  class Peer{
    constructor(){peers.push(this);this.iceGatheringState='complete';}
    addTrack(){} addTransceiver(){calls.push('transceiver');}createDataChannel(name){assert.equal(name,'oai-events');}
    async createOffer(){return {type:'offer',sdp:'v=0\r\noffer'};}
    async setLocalDescription(value){this.localDescription=value;}
    async setRemoteDescription(){this.connectionState='connected';this.onconnectionstatechange();}
    close(){this.closed=true;}
  }
  class Audio{pause(){}}
  const voice=createNativeVoice({Peer,AudioElement:Audio,onError:message=>errors.push(message),
    media:{async getUserMedia(options){calls.push(options);const track={stop(){track.stopped=true;}};tracks.push(track);return {getTracks:()=>[track],getAudioTracks:()=>[track]};}},
    async api(route,body){calls.push({route,body});if(route.endsWith('/start'))return {session:'native',sdp:'v=0\r\nanswer'};return {};}});
  return {voice,calls,tracks,peers,errors};
}
test('browser uses echo cancellation and releases its media on stop; check-only never opens microphone',async()=>{
  const b=browser();await b.voice.start();assert.equal(b.voice.status,'connected');
  assert.equal(b.calls[0].audio.echoCancellation,true);await b.voice.stop();
  assert.equal(b.tracks[0].stopped,true);assert.equal(b.peers[0].closed,true);
  const c=browser();await c.voice.start({checkOnly:true});assert.equal(c.tracks.length,0);assert.equal(c.voice.status,'off');assert.equal(c.errors.length,0);
});

test('native delegated turns use the existing tool gate; text stays native and stopped late turns are interrupted',async()=>{
  const rpc=new EventEmitter(),computer=new EventEmitter(),calls=[];let began=0;
  Object.assign(computer,{beginTurn(){began++;},endTurn(){},cancel(){},close(){},snapshot:()=>({actions:[]})});
  const c=new Zhiwei({rpc,computer,workspace:'.',dataDir:'.'});c.currentId='thread';c.claimWriter(c.currentId);
  Object.assign(rpc,{connected:true,stop:async()=>{rpc.connected=false;},request:async(method,params)=>{
    calls.push({method,params});
    if(method==='thread/realtime/start')c.notification({method:'thread/realtime/sdp',params:{threadId:'thread',sdp:'v=0\r\nanswer'}});
    if(method==='turn/interrupt')queueMicrotask(()=>c.notification({method:'turn/completed',params:{threadId:'thread',turn:{id:params.turnId,status:'interrupted',items:[]}}}));
    return {};
  }});
  try{
    const result=await c.realtime.start('v=0');c.realtime.connected(result.session);
    await assert.rejects(c.newThread(),/关闭原生语音/);
    await c.send('语音中的文字追问');assert.equal(calls.at(-1).method,'thread/realtime/appendText');
    c.notification({method:'turn/started',params:{threadId:'thread',turn:{id:'native-task'}}});assert.equal(began,1);
    c.serverRequest({id:'approval',method:'item/fileChange/requestApproval',params:{threadId:'thread',turnId:'native-task'}});
    assert.equal(c.approvals.size,1,'native work retains explicit approvals');
    c.notification({method:'turn/completed',params:{threadId:'thread',turn:{id:'native-task',status:'completed',items:[]}}});
    await c.realtime.stop();
    c.notification({method:'turn/started',params:{threadId:'thread',turn:{id:'late-native-task'}}});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(began,1);assert.ok(calls.some(call=>call.method==='turn/interrupt'&&call.params.turnId==='late-native-task'));
  }finally{await c.close();}
});

test('browser-local subtitles publish source without creating cloud translation turns',async()=>{
 const h=host();const result=await h.voice.start('v=0',{captionEngine:'local'});h.voice.connected(result.session);
 h.voice.notification('thread/realtime/transcript/done',{threadId:'thread',role:'assistant',text:'Take your time.'});
 assert.equal(h.voice.snapshot().captionEngine,'local');assert.equal(h.voice.snapshot().captionSource.text,'Take your time.');assert.equal(h.voice.snapshot().caption,null);assert.ok(!h.calls.some(c=>['thread/start','turn/start'].includes(c.method)));await h.voice.stop();
});
