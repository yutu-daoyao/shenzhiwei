import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {EventEmitter,once} from 'node:events';
import {setImmediate as tick} from 'node:timers/promises';
import {Voiceprint,SpeakerFilteredASR} from '../src/voice/voiceprint.js';
import {VoicePipeline} from '../src/voice/pipeline.js';
import {FakeTTS,FakeVAD} from '../src/voice/fake.js';
const pcm=(seconds=3)=>{const b=Buffer.alloc(seconds*32000);for(let i=0;i<b.length;i+=2)b.writeInt16LE(i%4?4000:-4000,i);return b;};
const batch=()=>Array.from({length:3},()=>pcm(12));
async function complete(v){for(let i=0;i<4;i++)await v.enroll(batch(),{consent:true});}
async function profile(t,options={}){const dataDir=await mkdtemp(path.join(tmpdir(),'zhiwei-vp-'));const v=new Voiceprint({dataDir,embedder:async()=>[1,0,0],crypt:async b=>Buffer.from(b),...options});t.after(async()=>{await v.close();await rm(dataDir,{force:true,recursive:true});});return v;}
test('enrollment requires explicit consent, clear three clips and one consistent speaker',async t=>{
  let calls=0;const v=await profile(t,{embedder:async()=>{calls++;return calls===2?[0,1,0]:[1,0,0];}});
  await assert.rejects(v.configure({enabled:true}),/录入/);await assert.rejects(v.enroll([pcm(),pcm(),pcm()]),/同意/);assert.equal(calls,0);
  await assert.rejects(v.enroll([pcm(.2),...batch().slice(1)],{consent:true}),/第 1 段.*8–15/);
  await assert.rejects(v.enroll([Buffer.alloc(384000),...batch().slice(1)],{consent:true}),/第 1 段.*6 秒/);assert.equal(calls,0);
  const clips=batch();await assert.rejects(v.enroll(clips,{consent:true}),/一致性/);assert.ok(clips.every(b=>b.every(x=>x===0)));assert.equal(v.snapshot().enrolled,false);
});
test('profile persists only protected features, stays disabled until requested and can be deleted',async t=>{
  const crypt=async b=>Buffer.from(b).map(x=>x^0xa5),v=await profile(t,{crypt});
  await v.enroll(batch(),{consent:true});assert.equal(v.enabled,false);await assert.rejects(v.configure({enabled:true}),/12 段/);
  const progress=await new Voiceprint({dataDir:path.dirname(v.directory),embedder:v.embedder,crypt}).load();t.after(()=>progress.close());
  assert.equal(progress.snapshot().sampleCount,3);assert.equal(progress.snapshot().voicedMs,36000);
  for(let i=0;i<3;i++)await progress.enroll(batch(),{consent:true});
  const stored=await readFile(v.file);assert.ok(!stored.includes(Buffer.from('vector')));assert.ok(stored.length<2000);
  await progress.configure({enabled:true,threshold:.7});const next=await new Voiceprint({dataDir:path.dirname(v.directory),embedder:async()=>[0,1,0],crypt}).load();t.after(()=>next.close());
  assert.equal(next.enabled,true);assert.equal((await next.verify(pcm())).matched,false);next.embedder=async()=>[1,0,0];assert.equal((await next.verify(pcm())).matched,true);
  assert.equal((await next.verify(pcm(.1))).matched,false);assert.equal('vector' in next.snapshot(),false);await next.remove();assert.equal(next.enabled,false);await assert.rejects(readFile(v.file),{code:'ENOENT'});
});
test('broken profile fails closed and failed replacement retains previous owner settings',async t=>{
  const v=await profile(t);await complete(v);await v.configure({enabled:true});const old=v.profile;
  v.crypt=async()=>{throw Error('disk error');};await assert.rejects(v.enroll(batch(),{consent:true}),/disk error/);assert.equal(v.enabled,true);assert.equal(v.profile,old);
  await writeFile(v.file,'broken');const next=await new Voiceprint({dataDir:path.dirname(v.directory),embedder:async()=>[1,0],crypt:async b=>Buffer.from(b)}).load();assert.equal(next.enabled,true);assert.equal(next.ready,false);await assert.rejects(next.verify(pcm()),/未就绪/);
});
test('new batches recognize a second speaking style without accepting an unrelated speaker',async t=>{
  const v=await profile(t);await complete(v);await v.configure({enabled:true});
  v.embedder=async()=>[0.5,Math.sqrt(0.75),0];
  assert.equal((await v.verify(pcm(1))).matched,false);
  await v.enroll(batch(),{consent:true});
  assert.equal(v.enabled,true);assert.equal(v.snapshot().sampleCount,15);assert.equal(v.snapshot().lastResult,null);
  assert.equal((await v.verify(pcm(1))).matched,true);
  v.embedder=async()=>[0,0,1];
  assert.equal((await v.verify(pcm(1))).matched,false);
  await assert.rejects(v.enroll(batch(),{consent:true}),/一致性/);assert.equal(v.snapshot().sampleCount,15);
});
test('legacy voiceprint still loads and the first longer batch starts a new collection',async t=>{
  const v=await profile(t);await mkdir(v.directory,{recursive:true});
  await writeFile(v.file,JSON.stringify({version:1,model:'eres2net-base-3dspeaker-16k',vector:[1,0,0],enabled:true,threshold:0.7}));
  await v.load();assert.equal(v.snapshot().legacy,true);assert.equal(v.enabled,true);assert.equal((await v.verify(pcm())).matched,true);
  await v.enroll(batch(),{consent:true});assert.equal(v.snapshot().legacy,false);assert.equal(v.snapshot().sampleCount,3);assert.equal(v.enabled,false);
});
test('rejected, cancelled and unavailable speakers never reach remote ASR',async()=>{
  let calls=0,release;const asr={createSession(){calls++;throw Error('must not upload');}};
  for(const verify of [async()=>({matched:false}),async()=>{throw Error('unavailable');}]){const s=new SpeakerFilteredASR(asr,{verify}).createSession({});const done=once(s,verify.toString().includes('throw')?'error':'final');s.write(pcm());s.end();await done;s.close();}
  const s=new SpeakerFilteredASR(asr,{verify:()=>new Promise(r=>release=r)}).createSession({});s.write(pcm());s.end();s.close();release({matched:true});await tick();assert.equal(calls,0);
});
test('only verified audio creates ASR and its bytes survive transfer before local buffers clear',async()=>{
  let uploaded,session;const asr={createSession(){session=new EventEmitter();session.write=b=>uploaded=Buffer.from(b);session.end=()=>session.emit('final',{text:'你好'});session.close=()=>{};return session;}};
  const s=new SpeakerFilteredASR(asr,{verify:async()=>({matched:true})}).createSession({});const source=pcm(),done=once(s,'final');s.write(source);s.end();assert.equal((await done)[0].text,'你好');assert.deepEqual(uploaded,source);s.close();
});
test('unverified noise cannot interrupt an existing answer even without confirmBargeIn setting',async()=>{
  const asr=new SpeakerFilteredASR({createSession(){throw Error('rejected audio uploaded');}},{verify:async()=>({matched:false})});
  const p=new VoicePipeline({asr,tts:new FakeTTS(),vad:new FakeVAD()});let cancelled=0;const controller=new AbortController();p.output={controller,stream:{cancel(){cancelled++;}}};
  p.startSpeech();p.session.write(pcm());p.endSpeech();await tick();assert.equal(controller.signal.aborted,false);assert.equal(cancelled,0);p.close();
});
