import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {setImmediate as tick} from 'node:timers/promises';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {BageshuoASR,BAGESHUO_AUTH_REJECTED,prepareBageshuo,signedParameters,validateTicket} from '../src/voice/bageshuo/asr.js';
import {loadInstalledAuth,SESSION_CONSENT,accountFingerprint} from '../src/voice/bageshuo/auth.js';
import {createVoiceProviders,voiceAvailability} from '../src/voice/interfaces.js';
import {DashScopeTTS} from '../src/voice/dashscope/tts.js';
import {VoicePipeline} from '../src/voice/pipeline.js';
import {VoiceConversation} from '../src/voice/conversation.js';
import {FakeASR,FakeTTS,FakeVAD} from '../src/voice/fake.js';
import {FakeCapture,FakePlayback} from '../src/voice/audio.js';
import {start} from '../src/main.js';

const validTicket=()=>({data:{ticketInfo:{websocketUrl:'wss://dict-typeless.youdao.com/realtime?ticket=offline-ticket',ticket:'offline-ticket',protocolVersion:1,audioPolicy:{encoding:'PCM_S16LE',sampleRateHz:16000,channels:1},limits:{maxAudioFrameBytes:4}}}});
const auth=()=>({cookie:'DICT_UT=offline-secret',userId:'offline-user',deviceId:'offline-device'});
test('reopening the same NetEase account does not discard prepared auth when refresh fields change',()=>{
  const login={userId:'account-a',loggedInAt:1,pc:'old',pci:'old',tp:'old'};
  const before=accountFingerprint(login,'device-a');
  assert.equal(accountFingerprint({...login,loggedInAt:2,pc:'new',pci:'new',tp:'new'},'device-a'),before);
  assert.notEqual(accountFingerprint({...login,userId:'account-b'},'device-a'),before);
  assert.notEqual(accountFingerprint(login,'device-b'),before);
});
async function until(check){for(let i=0;i<200;i++){if(check())return;await tick();}assert.fail('offline event did not arrive');}
function harness(overrides={}){
  const controls=[],audio=[];let socket,requests=0,closed=0;
  return {
    options:{authProvider:async()=>auth(),fetcher:async(url,options)=>{requests++;assert.equal(new URL(url).hostname,'dict-typeless.youdao.com');assert.equal(options.redirect,'error');assert.equal(options.headers.Cookie,'DICT_UT=offline-secret');return {ok:true,json:async()=>validTicket()};},socketFactory:()=>{
      socket=new EventEmitter();socket.readyState=1;socket.bufferedAmount=0;socket.close=()=>{closed++;};socket.send=value=>{
        if(Buffer.isBuffer(value)){audio.push(Buffer.from(value));return;}
        const event=JSON.parse(value);controls.push(event);
        if(event.type==='utterance.start')queueMicrotask(()=>socket.emit('message',Buffer.from(JSON.stringify({v:1,type:'utterance.ready',payload:{maxAudioFrameBytes:4}})),false));
      };queueMicrotask(()=>socket.emit('message',Buffer.from('{"v":1,"type":"connection.ready"}'),false));return socket;
    },...overrides},
    controls,audio,get requests(){return requests;},get closed(){return closed;},
    event(type,payload={},extra={}){socket.emit('message',Buffer.from(JSON.stringify({v:1,type,payload,...extra})),false);},
  };
}

test('Bageshuo requires explicit installed-session consent before accessing any file',async()=>{
  let reads=0;await assert.rejects(loadInstalledAuth({authorized:false,read:async()=>{reads++;}}),error=>error.message===SESSION_CONSENT);assert.equal(reads,0);
  const session=new BageshuoASR().createSession();const [error]=await once(session,'error');assert.equal(error.message,SESSION_CONSENT);
});

test('Bageshuo rejects foreign or incompatible ticket endpoints and signs deterministically',()=>{
  assert.deepEqual(signedParameters('test-device',1700000000000),signedParameters('test-device',1700000000000));
  assert.match(signedParameters('test-device').sign,/^[a-f0-9]{32}$/);
  for(const url of ['ws://dict-typeless.youdao.com/?ticket=offline-ticket','wss://youdao.com.evil.example/?ticket=offline-ticket','wss://evil.example/?ticket=offline-ticket','wss://u:p@dict-typeless.youdao.com/?ticket=offline-ticket','wss://dict-typeless.youdao.com:444/?ticket=offline-ticket','wss://dict-typeless.youdao.com/?ticket=wrong']){
    const ticket=validTicket();ticket.data.ticketInfo.websocketUrl=url;assert.throws(()=>validateTicket(ticket),/未允许/);
  }
  const incompatible=validTicket();incompatible.data.ticketInfo.audioPolicy.sampleRateHz=48000;assert.throws(()=>validateTicket(incompatible),/已变化/);
});

test('Bageshuo preserves buffered PCM order, sends one end and waits for the polished final',async()=>{
  const h=harness(),session=new BageshuoASR(h.options).createSession(),partials=[],finals=[];
  session.on('partial',v=>partials.push(v.text));session.on('final',v=>finals.push(v.text));
  const first=Buffer.from([1,0,2,0,3,0]);session.write(first);first.fill(0);session.write(Buffer.from([4,0]));session.end();session.end();
  await until(()=>h.controls.some(e=>e.type==='utterance.end'));
  assert.deepEqual(Buffer.concat(h.audio),Buffer.from([1,0,2,0,3,0,4,0]));assert.ok(h.audio.every(a=>a.length<=4));
  assert.deepEqual(h.controls.map(e=>e.type),['utterance.start','utterance.end']);assert.equal(h.controls[1].payload.audioBytesSent,8);assert.equal(h.controls[0].payload.audio.encoding,'PCM_S16LE');
  h.event('transcript.partial',{fullText:'临时错词'});h.event('transcript.final',{rawText:'尚未整理的文字'});
  assert.equal(finals.length,0);assert.equal(partials.length,2);
  h.event('generation.completed',{resultText:'知微，请继续当前项目。'});h.event('generation.completed',{resultText:'不能重复'});
  assert.deepEqual(finals,['知微，请继续当前项目。']);assert.equal(h.requests,1);assert.equal(h.closed,1);
});

test('Bageshuo cancellation while authenticating never requests a ticket or opens a socket',async()=>{
  let resolveAuth;const h=harness({authProvider:()=>new Promise(resolve=>{resolveAuth=resolve;})});
  const session=new BageshuoASR(h.options).createSession();await until(()=>resolveAuth);session.write(Buffer.alloc(640));session.close();resolveAuth(auth());await tick();assert.equal(h.requests,0);assert.equal(h.controls.length,0);
});

test('Bageshuo connection failures and timeouts never emit or leak an incomplete result',async()=>{
  const session=new BageshuoASR({authProvider:async()=>auth(),fetcher:async()=>{throw new Error('DICT_UT=offline-secret');}}).createSession();
  const [error]=await once(session,'error');assert.doesNotMatch(error.message,/offline-secret|DICT_UT/);
  const h=harness({timeoutMs:40}),timed=new BageshuoASR(h.options).createSession(),finals=[];timed.on('final',v=>finals.push(v));const failure=once(timed,'error');
  await until(()=>h.controls.length);h.event('transcript.final',{rawText:'不能执行'});const [timeout]=await failure;assert.match(timeout.message,/超时/);h.event('generation.completed',{resultText:'晚到'});assert.deepEqual(finals,[]);
});

test('preparing recognition checks the NetEase ticket before reporting ready',async()=>{
  let requests=0;
  const loadAuth=async({authorized})=>{assert.equal(authorized,true);return auth();};
  const denied=async()=>{requests++;return {ok:false,status:401};};
  await assert.rejects(prepareBageshuo({authorized:true,loadAuth,fetcher:denied}),{code:BAGESHUO_AUTH_REJECTED});
  await prepareBageshuo({authorized:true,loadAuth,fetcher:async()=>{requests++;return {ok:true,json:async()=>validTicket()};}});
  assert.equal(requests,2);
});

test('NetEase 401 pauses capture but keeps browser playback and reports the reason',async()=>{
  const capture=new FakeCapture(),playback=new FakePlayback();let paused=0;
  capture.pauseInput=()=>{paused++;};
  const asr=new BageshuoASR({authProvider:async()=>auth(),fetcher:async()=>({ok:false,status:401}),socketFactory:()=>assert.fail('must not open a socket')});
  const voice=new VoiceConversation({capture,playback,brain:{run:()=>assert.fail('must not dispatch')},providers:{asr,tts:new FakeTTS(),vad:new FakeVAD()},config:{spokenModes:true}});
  try{
    await voice.setEnabled(true);
    const pcm=Buffer.alloc(640);pcm.writeInt16LE(4000);
    await capture.replay([pcm,Buffer.alloc(640)]);await until(()=>paused===1);
    const state=voice.snapshot();
    assert.equal(state.inputEnabled,false);
    assert.equal(state.readingEnabled,true);
    assert.match(state.error,/网易拒绝了知微复用的叭哥说会话（HTTP 401）/);
  }finally{await voice.close();}
});

test('Bageshuo stream integrates with the voice pipeline without executing interim text',async()=>{
  const h=harness(),sent=[];
  const pipeline=new VoicePipeline({asr:new BageshuoASR(h.options),tts:new FakeTTS(),vad:new FakeVAD(),mode:'ptt',onUserText:async text=>sent.push(text)});
  pipeline.startHold();pipeline.write(Buffer.alloc(640));pipeline.stopHold();await until(()=>h.controls.some(e=>e.type==='utterance.end'));
  h.event('transcript.partial',{fullText:'错误操作'});h.event('transcript.final',{rawText:'错误操作'});await tick();assert.deepEqual(sent,[]);
  h.event('generation.completed',{resultText:'只讨论，不执行。'});await until(()=>sent.length===1);assert.deepEqual(sent,['只讨论，不执行。']);pipeline.close();
});

test('an ended NetEase transcript can switch modes before polishing only with the default wake phrase',async t=>{
  const h=harness(),capture=new FakeCapture(),tts=new FakeTTS();
  const voice=new VoiceConversation({
    capture,playback:new FakePlayback(),brain:{run:()=>assert.fail('mode command must stay local')},
    providers:{asr:new BageshuoASR(h.options),tts,vad:new FakeVAD()},config:{spokenModes:true},
  });
  t.after(()=>voice.close());
  await voice.setEnabled(true);
  const pcm=Buffer.alloc(640);pcm.writeInt16LE(4000);
  const speak=async count=>{
    await capture.replay([pcm,Buffer.alloc(640)]);
    await until(()=>h.controls.filter(e=>e.type==='utterance.end').length===count);
  };
  await speak(1);
  h.event('transcript.partial',{fullText:'知微，切换到控制模式'});
  h.event('transcript.final',{rawText:'切换到控制模式'});
  assert.equal(voice.mode,'default');
  h.event('generation.failed');
  await until(()=>/文字整理/.test(voice.error));
  assert.equal(voice.mode,'default');

  await speak(2);
  h.event('transcript.final',{rawText:'知微，切换到控制模式。'});
  await until(()=>voice.mode==='ptt');
  assert.equal(voice.error,null);
  assert.equal(h.closed,2);
});

test('Bageshuo changes only recognition and keeps the configured DashScope voice',()=>{
  const before=process.env.DASHSCOPE_API_KEY;process.env.DASHSCOPE_API_KEY='offline-key';
  try{
    const config={provider:'dashscope',asr:'bageshuo',tts:'dashscope',asrOptions:{useInstalledSession:false}};
    assert.equal(voiceAvailability(config).ready,false);assert.match(voiceAvailability(config).reason,/明确允许/);
    config.asrOptions.useInstalledSession=true;
    assert.equal(voiceAvailability(config).ready,true,'a saved authorization is sufficient before the first utterance');
    const providers=createVoiceProviders({...config,requireReal:true});
    assert.ok(providers.asr instanceof BageshuoASR);assert.ok(providers.tts instanceof DashScopeTTS);
  }finally{if(before===undefined)delete process.env.DASHSCOPE_API_KEY;else process.env.DASHSCOPE_API_KEY=before;}
});

test('recognition settings require CSRF, consent and idle voice; store no credentials',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'zhiwei-bage-settings-'));let app;
  try{
    const rpc=new EventEmitter();Object.assign(rpc,{connected:true,stop:async()=>{},request:async()=>{throw new Error('offline');}});
    let preparations=0;
    app=await start({port:0,workspace:directory,dataDir:path.join(directory,'data'),rpc,prepareRecognition:async options=>{assert.equal(options.authorized,true);preparations++;},voiceOptions:{capture:new FakeCapture(),playback:new FakePlayback(),providers:{asr:new FakeASR(),tts:new FakeTTS(),vad:new FakeVAD()},config:{audio:'fake',mode:'ptt'}}});await app.ready;
    const state=await(await fetch(app.origin+'/api/state')).json(),headers={'Content-Type':'application/json',Origin:app.origin,'X-Zhiwei-CSRF':state.csrf};
    const save=(body,custom=headers)=>fetch(app.origin+'/api/voice/recognition',{method:'POST',headers:custom,body:JSON.stringify(body)});
    assert.equal((await save({asr:'bageshuo',useInstalledSession:true},{...headers,'X-Zhiwei-CSRF':'wrong'})).status,403);
    assert.equal((await save({asr:'bageshuo',useInstalledSession:false})).status,400);
    assert.equal(preparations,0);
    assert.equal((await save({asr:'bageshuo',useInstalledSession:true})).status,200);
    assert.equal(preparations,1);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory,'data/voice-recognition.json'),'utf8')),{asr:'bageshuo',useInstalledSession:true});
    await app.client.voice.setEnabled(true);
    assert.equal((await save({asr:'bageshuo',useInstalledSession:true})).status,400);
    assert.equal((await save({asr:'dashscope',useInstalledSession:false})).status,400);
    app.client.voice.setInput(false);
    assert.equal((await save({asr:'bageshuo',useInstalledSession:true})).status,200);
    assert.equal(preparations,2);
    assert.equal((await save({asr:'dashscope',useInstalledSession:false})).status,400);
    await app.client.voice.setEnabled(false);
    assert.equal((await save({asr:'dashscope',useInstalledSession:false})).status,200);
    assert.equal(app.client.voice.config.asrOptions.useInstalledSession,false);
  }finally{await app?.close();if(path.dirname(path.resolve(directory))===path.resolve(tmpdir()))await rm(directory,{recursive:true,force:true,maxRetries:4,retryDelay:100});}
});
