import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createNativeVoice } from '../public/native-voice.js';
import { start } from '../src/main.js';
import { FakeCapture, FakePlayback } from '../src/voice/audio.js';
import { FakeASR, FakeTTS, FakeVAD } from '../src/voice/fake.js';

test('worklet meters device input/output at 25Hz; queued audio is silent until rendered and reset discards it', async () => {
  let Processor; const messages = [];
  vm.runInNewContext(await readFile(new URL('../public/voice-worklet.js', import.meta.url), 'utf8'), {
    Float32Array, Int16Array,
    AudioWorkletProcessor:class { constructor() { this.port = { postMessage:m => messages.push(m) }; } },
    registerProcessor:(_name, value) => { Processor = value; },
  });
  const p = new Processor();
  const render = () => p.process([[new Float32Array(128).fill(0.25)]], [[new Float32Array(128)]]);
  p.port.onmessage({ data:{ type:'audio', id:1, samples:new Float32Array(640).fill(0.5) } });
  for (let i=0;i<5;i++) render();
  let levels = messages.filter(m => m.type==='level');
  assert.equal(levels.length, 1); assert.equal(levels[0].listening, 0.25); assert.equal(levels[0].speaking, 0, 'below jitter cushion');
  p.port.onmessage({ data:{ type:'flush' } });
  for (let i=0;i<5;i++) render();
  assert.equal(messages.filter(m => m.type==='level').at(-1).speaking, 0.5);
  assert.ok(messages.some(m => m.type==='played' && m.id===1));
  p.port.onmessage({ data:{ type:'audio', id:2, samples:new Float32Array(1600).fill(0.75) } });
  p.port.onmessage({ data:{ type:'reset' } });
  for (let i=0;i<115;i++) render();
  levels = messages.filter(m => m.type==='level');
  assert.equal(levels.length, 25); assert.equal(levels.at(-1).speaking, 0);
  assert.ok(!messages.some(m => m.type==='played' && m.id===2));
});

function nativeHarness({ brokenMeter = false } = {}) {
  const probes = [], levels = []; let callback, closed = 0, stopped = 0, cancelled = 0;
  const stream = { getTracks:() => [{stop() { stopped++; }}], getAudioTracks:() => [] };
  class Context {
    async resume() {} async close() { closed++; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() {
      if (brokenMeter) throw new Error('meter unavailable');
      const probe = { value:0, getFloatTimeDomainData(data) { data.fill(this.value); } }; probes.push(probe); return probe;
    }
  }
  class Peer {
    constructor() { this.iceGatheringState='complete'; }
    createDataChannel() {} addTrack() {} close() {}
    async createOffer() { return { type:'offer', sdp:'v=0' }; }
    async setLocalDescription(value) { this.localDescription=value; }
    async setRemoteDescription() { this.ontrack({streams:[stream]}); this.connectionState='connected'; this.onconnectionstatechange(); }
  }
  const voice = createNativeVoice({ Context, Peer, AudioElement:class { async play() {} pause() {} },
    media:{ getUserMedia:async () => stream }, onLevel:level => levels.push(level),
    requestFrame:fn => { callback=fn; return 1; }, cancelFrame:() => { cancelled++; },
    api:async route => route==='realtime/start' ? { session:'native', sdp:'v=0' } : {},
  });
  return {voice,probes,levels,frame:now=>callback(now),counts:()=>({closed,stopped,cancelled})};
}

test('native WebRTC meter selects actual remote speech then microphone, and teardown cannot revive it', async () => {
  const h = nativeHarness(); await h.voice.start(); assert.equal(h.voice.status, 'connected');
  h.probes[0].value=0.25; h.frame(100); assert.equal(h.levels.at(-1).state,'listening'); assert.equal(h.levels.at(-1).level,0.25);
  h.probes[1].value=0.5; h.frame(150); assert.equal(h.levels.at(-1).state,'speaking'); assert.equal(h.levels.at(-1).level,0.5);
  h.probes[1].value=0; h.frame(400); assert.equal(h.levels.at(-1).state,'listening');
  await h.voice.stop(); const count=h.levels.length; h.frame(500);
  assert.equal(h.levels.length,count); assert.deepEqual(h.counts(),{closed:1,stopped:1,cancelled:1});
});

test('native audio still connects when optional analyser initialization fails', async () => {
  const h = nativeHarness({brokenMeter:true}); await h.voice.start(); assert.equal(h.voice.status,'connected');
  await h.voice.stop(); assert.equal(h.counts().closed,1); assert.equal(h.counts().stopped,1);
});

test('server serves orb module and publishes compact SSE levels without serializing chat history', async t => {
  const directory=await mkdtemp(path.join(tmpdir(),'zhiwei-orb-test-'));
  const rpc=new EventEmitter(); Object.assign(rpc,{connected:true,stop:async()=>{},request:async()=>{throw new Error('offline fixture');}});
  const app=await start({port:0,workspace:directory,dataDir:path.join(directory,'data'),rpc,
    voiceOptions:{brain:{run:async()=>''},capture:new FakeCapture(),playback:new FakePlayback(),config:{mode:'ptt'},
      providers:{asr:new FakeASR(),tts:new FakeTTS(),vad:new FakeVAD()}}});
  let reader;
  t.after(async()=>{await reader?.cancel();await app.close();assert.ok(directory.startsWith(path.join(tmpdir(),'zhiwei-orb-test-')));await rm(directory,{recursive:true,force:true});});
  await app.ready;
  const module=await fetch(app.origin+'/orb.js'); assert.equal(module.status,200); assert.match(await module.text(),/mountOrb/);
  await app.client.voice.setEnabled(true);app.client.voice.ptt('start');
  reader=(await fetch(app.origin+'/api/events')).body.getReader();await reader.read();
  app.client.voice.reportLevel('listening',0.25);
  let data='';while(!data.includes('event: voice-level')){data+=new TextDecoder().decode((await reader.read()).value);}
  assert.match(data,/"level":0.25/);assert.ok(!data.includes('"items"'));
});
