import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTick } from 'node:timers/promises';
import { FakeASR, FakeTTS, FakeVAD, EnergyVAD } from '../src/voice/fake.js';
import { createVoiceProviders } from '../src/voice/interfaces.js';
import { VoicePipeline } from '../src/voice/pipeline.js';

test('wake audio ignores filler and provisional transcripts while thinking, but accepts a confirmed interruption',async t=>{
  const submitted=[];
  let finish;
  const p=new VoicePipeline({
    asr:new FakeASR(),tts:new FakeTTS(),vad:new FakeVAD(),confirmBargeIn:true,
    onUserText:text=>{submitted.push(text);if(text==='原问题')return new Promise(resolve=>finish=resolve);},
  });
  t.after(()=>{finish?.();p.close();});
  const utterance=(partial,final)=>{
    p.startSpeech();
    p.session.emit('partial',{text:partial});
    const signal=p.turn?.controller.signal;
    p.session.emit('final',{text:final});
    p.endSpeech();
    return signal;
  };
  utterance('原问题','原问题');await nextTick();
  const current=p.turn.controller.signal;
  utterance('听起来','嗯嗯……');
  utterance('啊','啊！');
  await nextTick();
  assert.equal(current.aborted,false);
  assert.deepEqual(submitted,['原问题']);
  assert.equal(p.sessions.size,0);
  assert.equal(p.state,'thinking');

  utterance('知微停','知微，停一下');
  await nextTick();
  assert.equal(current.aborted,true);
  assert.deepEqual(submitted,['原问题','知微，停一下']);
  utterance('嗯我','嗯，我还有个问题');await nextTick();
  assert.equal(submitted.at(-1),'嗯，我还有个问题');
});

function tone() {
  const frame = Buffer.alloc(640);
  for (let i = 0; i < 320; i++) frame.writeInt16LE(Math.round(4000 * Math.sin(i * Math.PI / 20)), i * 2);
  return frame;
}
const silence = () => Buffer.alloc(640);

// Alternating PCM samples give an exact RMS with no DC offset.
function level(rms) {
  const frame = Buffer.alloc(640);
  for (let i = 0; i < 320; i++) frame.writeInt16LE(i % 2 ? rms : -rms, i * 2);
  return frame;
}
function feed(target, rms, ms) {
  for (let i = 0; i < ms / 20; i++) (target.write ?? target.process).call(target, level(rms));
}
const adaptiveVAD = () => new EnergyVAD({ threshold:null, hangoverMs:900 });

test('adaptive VAD tracks idle noise, rejects 25-40 RMS noise and isolated peaks', () => {
  const vad = adaptiveVAD(), events = [];
  vad.on('speechStart', () => events.push('start'));
  feed(vad, 25, 2000);
  const quietFloor = vad.noiseFloor;
  feed(vad, 40, 10000);
  assert.ok(vad.noiseFloor > quietFloor + 10);
  assert.equal(vad.threshold, 60);
  feed(vad, 50, 10000);
  assert.ok(vad.threshold > 70, 'opening threshold follows a higher idle noise floor');
  feed(vad, 25, 2000);
  assert.equal(vad.threshold, 60);
  feed(vad, 800, 20); feed(vad, 35, 100);
  feed(vad, 70, 40); feed(vad, 35, 100);
  assert.deepEqual(events, []);
  feed(vad, 65, 60);
  assert.equal(vad.speech, true);
  vad.reset();
  assert.equal(vad.speech, false);
  assert.equal(vad.candidateMs, 0);
});

test('low-level PCM with 200-500ms pauses produces one complete ASR utterance', async t => {
  const vad = adaptiveVAD(), events = [], texts = [], states = [];
  vad.on('speechStart', () => events.push('start'));
  vad.on('speechEnd', result => events.push(result));
  const asr = new FakeASR({ scripts:[['你', '你好知微']] });
  const create = t.mock.method(asr, 'createSession');
  const pipeline = new VoicePipeline({ asr, tts:new FakeTTS(), vad, onUserText:text => texts.push(text) });
  t.after(() => pipeline.close());
  pipeline.on('state', state => states.push(state));
  feed(pipeline, 35, 2000);
  feed(pipeline, 70, 80); feed(pipeline, 50, 280);
  feed(pipeline, 35, 200);
  feed(pipeline, 65, 100); feed(pipeline, 50, 200);
  feed(pipeline, 35, 500);
  feed(pipeline, 60, 120); feed(pipeline, 50, 180);
  feed(pipeline, 35, 880);
  assert.equal(pipeline.state, 'listening');
  assert.equal(events.length, 1);
  assert.deepEqual(texts, []);
  feed(pipeline, 35, 20);
  await nextTick();
  assert.equal(create.mock.callCount(), 1);
  assert.deepEqual(events, ['start', { voicedMs:960, valid:true }]);
  assert.deepEqual(texts, ['你好知微']);
  assert.equal(states.filter(state => state === 'listening').length, 1);
  assert.equal(pipeline.state, 'idle');
});

test('short fragments discard even an early final, then the next utterance works', async t => {
  const asr = new FakeASR({ scripts:[['你'], ['你好知微']] }), texts = [];
  const create = asr.createSession.bind(asr);
  let count = 0;
  asr.createSession = options => {
    const session = create(options);
    if (++count === 1) session.write = () => session.emit('final', { text:'你' });
    return session;
  };
  const pipeline = new VoicePipeline({ asr, tts:new FakeTTS(), vad:adaptiveVAD(), onUserText:text => texts.push(text) });
  t.after(() => pipeline.close());
  feed(pipeline, 70, 100);
  await nextTick(); assert.deepEqual(texts, []);
  feed(pipeline, 35, 900);
  await nextTick();
  assert.deepEqual(texts, []);
  assert.equal(pipeline.sessions.size, 0);
  feed(pipeline, 70, 400); feed(pipeline, 35, 900);
  await nextTick();
  assert.deepEqual(texts, ['你好知微']);
});

test('FakeVAD still starts on one nonzero frame and ends on one zero frame', () => {
  const vad = new FakeVAD(), events = [];
  vad.on('speechStart', () => events.push('start'));
  vad.on('speechEnd', () => events.push('end'));
  assert.equal(vad.process(level(1)).speech, true);
  assert.equal(vad.process(silence()).speech, false);
  assert.deepEqual(events, ['start', 'end']);
});

test('VAD environment overrides are optional, validated, and do not change FakeVAD', t => {
  const names = ['ZHIWEI_VAD_THRESHOLD', 'ZHIWEI_VAD_HANGOVER_MS'];
  const previous = names.map(name => process.env[name]);
  t.after(() => names.forEach((name, i) => {
    if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i];
  }));
  for (const name of names) delete process.env[name];
  assert.equal(new EnergyVAD().fixedThreshold, null);
  assert.equal(new EnergyVAD().hangoverMs, 600);
  process.env.ZHIWEI_VAD_THRESHOLD = '75'; process.env.ZHIWEI_VAD_HANGOVER_MS = '1000';
  const vad = new EnergyVAD();
  assert.equal(vad.threshold, 75); assert.equal(vad.hangoverMs, 1000);
  feed(vad, 70, 100); assert.equal(vad.speech, false);
  feed(vad, 80, 60); assert.equal(vad.speech, true);
  feed(vad, 35, 980); assert.equal(vad.speech, true);
  feed(vad, 35, 20); assert.equal(vad.speech, false);
  const fake = new FakeVAD();
  assert.equal(fake.threshold, 0); assert.equal(fake.hangoverMs, 0);
  assert.equal(new EnergyVAD({ threshold:90 }).threshold, 90);
  for (const name of names) {
    const valid = process.env[name];
    for (const value of ['bad', '-1', 'Infinity']) {
      process.env[name] = value; assert.throws(() => new EnergyVAD(), /Invalid VAD/);
    }
    process.env[name] = valid;
  }
});

test('EnergyVAD supports explicit legacy thresholds and hangover', () => {
  const vad = new EnergyVAD({ threshold:500, hangoverMs:300, startMs:0, minSpeechMs:0 }), events = [];
  vad.on('speechStart', () => events.push('start'));
  vad.on('speechEnd', () => events.push('end'));
  assert.equal(vad.process(silence()).speech, false);
  assert.equal(vad.process(tone()).speech, true);
  vad.process(tone());
  for (let i = 0; i < 14; i++) assert.equal(vad.process(silence()).speech, true);
  assert.equal(vad.process(silence()).speech, false);
  assert.deepEqual(events, ['start', 'end']);
});

test('FakeASR emits ordered partials and exactly one final; close aborts', () => {
  const asr = new FakeASR({ scripts:[['你', '你好'], ['取消']] });
  const session = asr.createSession(), events = [];
  for (const name of ['partial', 'final']) session.on(name, ({ text }) => events.push([name, text]));
  session.write(tone()); session.end(); session.end(); session.write(tone());
  assert.deepEqual(events, [['partial', '你'], ['partial', '你好'], ['final', '你好']]);
  const aborted = asr.createSession();
  aborted.on('final', () => assert.fail('closed session emitted final'));
  aborted.close(); aborted.end();
});

test('FakeTTS streams deterministic PCM chunks and cancel stops pending chunks', async () => {
  const tts = new FakeTTS(), chunks = [];
  for await (const chunk of tts.synthesize('你好', { sampleRate:16000, format:'pcm16' })) chunks.push(chunk);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every(chunk => Buffer.isBuffer(chunk) && chunk.length === 640 && chunk.every(n => n === 0)));
  const stream = tts.synthesize('取消测试'), iterator = stream[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).done, false);
  const pending = iterator.next(); stream.cancel();
  assert.equal((await pending).done, true);
});

test('pipeline gates sessions, delivers final once, and streams reply', async () => {
  const texts = [], chunks = [], states = [];
  const pipeline = new VoicePipeline({
    ...createVoiceProviders({ asr:'fake', tts:'fake', vad:'energy', vadOptions:{ threshold:500, hangoverMs:300, startMs:0, minSpeechMs:0 }, asrOptions:{ scripts:[['测', '测试']] } }),
    onUserText:text => texts.push(text), speak:chunk => chunks.push(chunk),
  });
  pipeline.on('state', state => states.push(state));
  pipeline.write(silence()); assert.equal(pipeline.state, 'idle');
  pipeline.write(tone()); assert.equal(pipeline.state, 'listening');
  for (let i = 0; i < 16; i++) pipeline.write(silence());
  assert.equal(pipeline.state, 'thinking');
  await nextTick();
  assert.deepEqual(texts, ['测试']);
  await pipeline.say('回复');
  assert.equal(chunks.length, 2);
  assert.equal(pipeline.state, 'idle');
  assert.ok(states.includes('speaking'));
  pipeline.close();
});

test('barge-in cancels TTS while sink is processing a chunk', async () => {
  let release, started, cancelled = 0, chunks = 0;
  const ready = new Promise(resolve => { started = resolve; });
  const tts = new FakeTTS();
  const pipeline = new VoicePipeline({
    ...createVoiceProviders({ asr:'fake', tts:'fake', vad:'fake' }),
    tts:{ synthesize(...args) {
      const stream = tts.synthesize(...args), cancel = stream.cancel;
      stream.cancel = () => { cancelled++; cancel(); };
      return stream;
    } },
    speak:async () => { chunks++; started(); await new Promise(resolve => { release = resolve; }); },
  });
  let barges = 0;
  pipeline.on('bargeIn', () => barges++);
  const speaking = pipeline.say('较长的语音回复');
  await ready;
  pipeline.write(tone());
  assert.equal(cancelled, 1);
  assert.equal(barges, 1);
  assert.equal(pipeline.state, 'listening');
  release(); await speaking;
  assert.equal(chunks, 1);
  pipeline.close();
  pipeline.write(tone());
  assert.equal(pipeline.state, 'idle');
});

test('registry defaults to fake and rejects unknown names', () => {
  const defaults = createVoiceProviders({ asr:'fake', tts:'fake', vad:'fake' });
  assert.ok(defaults.asr instanceof FakeASR);
  for (const kind of ['asr', 'tts', 'vad']) {
    for (const name of ['remote', 'toString']) {
      assert.throws(() => createVoiceProviders({ asr:'fake', tts:'fake', vad:'fake', [kind]:name }), /未配置/);
    }
  }
});

test('pipeline waits for asynchronous ASR final and closes pending sessions', async () => {
  const asr = new FakeASR({ scripts:[['延迟'], ['关闭']] });
  const sessions = [], texts = [];
  const pipeline = new VoicePipeline({
    ...createVoiceProviders({ asr:'fake', tts:'fake', vad:'fake' }),
    asr:{ createSession(options) {
      const session = asr.createSession(options), end = session.end;
      session.end = () => {};
      sessions.push({ session, finish:end });
      return session;
    } },
    onUserText:text => texts.push(text),
  });
  pipeline.write(tone()); pipeline.write(silence());
  assert.equal(pipeline.state, 'thinking');
  sessions[0].finish(); await nextTick();
  assert.deepEqual(texts, ['延迟']);
  assert.equal(pipeline.state, 'idle');
  pipeline.write(tone()); pipeline.write(silence());
  pipeline.close(); sessions[1].finish(); await nextTick();
  assert.deepEqual(texts, ['延迟']);
  assert.equal(pipeline.state, 'idle');
});

test('a newer utterance preserves pending ASR finals and delivers them in input order', async t => {
  const asr = new FakeASR({ scripts:[['你好知微'], ['请帮我']] }), sessions = [], texts = [];
  const create = asr.createSession.bind(asr);
  asr.createSession = options => {
    const session = create(options), finish = session.end;
    session.end = () => {};
    const close = t.mock.method(session, 'close');
    sessions.push({ session, finish, close });
    return session;
  };
  const pipeline = new VoicePipeline({ asr, tts:new FakeTTS(), vad:new FakeVAD(), onUserText:text => texts.push(text) });
  t.after(() => pipeline.close());
  pipeline.write(tone()); pipeline.write(silence());
  pipeline.write(tone());
  assert.equal(sessions[0].close.mock.callCount(), 0);
  sessions[1].finish(); await nextTick();
  assert.deepEqual(texts, []);
  pipeline.write(silence()); await nextTick();
  assert.deepEqual(texts, []);
  sessions[0].finish(); await nextTick();
  assert.deepEqual(texts, ['你好知微', '请帮我']);
  assert.equal(pipeline.state, 'idle');
  assert.equal(pipeline.sessions.size, 0);
});

test('VAD end gives ASR a separate final timeout and an explicit interrupt cancels it', async t => {
  t.mock.timers.enable({ apis:['setTimeout'] });
  const asr = new FakeASR(), sessions = [], errors = [], texts = [];
  const create = asr.createSession.bind(asr);
  asr.createSession = options => {
    const session = create(options), finish = session.end;
    session.end = () => {};
    sessions.push({ session, finish });
    return session;
  };
  const pipeline = new VoicePipeline({ asr, tts:new FakeTTS(), vad:new FakeVAD(),
    asrTimeoutMs:10000, asrFinalTimeoutMs:5000, onUserText:text => texts.push(text) });
  t.after(() => pipeline.close());
  pipeline.on('error', error => errors.push(error));
  pipeline.write(tone());
  t.mock.timers.tick(9000);
  pipeline.write(silence());
  t.mock.timers.tick(4999);
  assert.equal(pipeline.state, 'thinking');
  assert.equal(errors.length, 0);
  t.mock.timers.tick(1);
  assert.match(errors[0].message, /最终结果超时/);
  assert.equal(pipeline.state, 'idle');
  sessions[0].session.emit('final', { text:'迟到' });
  pipeline.write(tone()); pipeline.write(silence());
  pipeline.interrupt(); sessions[1].finish();
  t.mock.timers.tick(5000); await nextTick();
  assert.deepEqual(texts, []);
  assert.equal(errors.length, 1);
});

test('an already received final does not time out while waiting for an earlier turn', async t => {
  t.mock.timers.enable({ apis:['setTimeout'] });
  const source = new FakeASR(), sessions = [], texts = [], errors = [];
  const asr = { createSession(options) {
    const session = source.createSession(options);
    session.end = () => {};
    sessions.push(session); return session;
  } };
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const pipeline = new VoicePipeline({ asr, tts:new FakeTTS(), vad:new FakeVAD(),
    asrFinalTimeoutMs:5000, onUserText:async text => { texts.push(text); if (text === '第一句') await pending; } });
  t.after(() => pipeline.close());
  pipeline.on('error', error => errors.push(error));
  pipeline.write(tone()); pipeline.write(silence());
  t.mock.timers.tick(1000);
  pipeline.write(tone()); sessions[1].emit('final', { text:'第二句' }); pipeline.write(silence());
  sessions[0].emit('final', { text:'第一句' });
  await nextTick();
  t.mock.timers.tick(5000);
  assert.equal(errors.length, 0);
  assert.deepEqual(texts, ['第一句']);
  release();
  await nextTick();
  assert.deepEqual(texts, ['第一句', '第二句']);
  assert.equal(pipeline.state, 'idle');
});

test('15-second rotation preserves running commands, drains final once, and continues recognition', async t => {
  t.mock.timers.enable({ apis:['setTimeout'] });
  const asr = new FakeASR({ scripts:[[{ id:0, text:'第一句', final:true }], [{ id:0, text:'第二句', final:true }]] });
  const sessions = [], texts = [], create = asr.createSession.bind(asr);
  asr.createSession = options => { const session = create(options); sessions.push(session); return session; };
  let release, signal;
  const pending = new Promise(resolve => { release = resolve; });
  const pipeline = new VoicePipeline({ asr, vad:new FakeVAD(), tts:new FakeTTS(), preRollMs:0,
    onUserText:async (text, options) => { texts.push(text); signal = options.signal; if (text === '第一句') await pending; } });
  t.after(() => pipeline.close());
  pipeline.write(tone()); await nextTick();
  assert.deepEqual(texts, ['第一句']);
  t.mock.timers.tick(14999); assert.equal(sessions.length, 1);
  t.mock.timers.tick(1); assert.equal(sessions.length, 2);
  assert.equal(signal.aborted, false, 'rotation does not interrupt the brain');
  pipeline.write(tone()); await nextTick();
  assert.deepEqual(texts, ['第一句']);
  release(); await nextTick();
  assert.deepEqual(texts, ['第一句', '第二句']);
  assert.equal(pipeline.vad.speech, true);
  pipeline.write(silence()); await nextTick();
  assert.deepEqual(texts, ['第一句', '第二句']);
  assert.equal(pipeline.sessions.size, 0);
  pipeline.close(); t.mock.timers.tick(30000);
  assert.equal(sessions.length, 2);
});

test('offline PCM duration also bounds continuous ASR sessions to 15 seconds', async t => {
  const asr = new FakeASR({ scripts:[[], []] }), create = t.mock.method(asr, 'createSession');
  const pipeline = new VoicePipeline({ asr, vad:new FakeVAD(), tts:new FakeTTS(), preRollMs:0 });
  t.after(() => pipeline.close());
  feed(pipeline, 70, 14980); assert.equal(create.mock.callCount(), 1);
  feed(pipeline, 70, 20); assert.equal(create.mock.callCount(), 2);
  assert.equal(pipeline.vad.speech, true);
  pipeline.write(silence()); await nextTick();
  assert.equal(pipeline.sessions.size, 0);
});

test('priority speech bypasses a blocked sentence, drops old queued work and rejects late ASR', async t => {
  const asr=new FakeASR({scripts:[[],[]]}),sessions=[],texts=[],signals=[];let release;
  const create=asr.createSession.bind(asr);asr.createSession=options=>{const s=create(options);s.end=()=>{};sessions.push(s);return s;};
  const pipeline=new VoicePipeline({asr,vad:new FakeVAD(),tts:new FakeTTS(),preRollMs:0,onUserText:(text,{signal})=>{
    texts.push(text);signals.push(signal);if(text==='查导航')return new Promise(resolve=>{release=resolve;});
  }});
  t.after(()=>{release?.();pipeline.close();});
  pipeline.write(tone());sessions[0].emit('sentence',{id:0,text:'查导航'});await nextTick();
  sessions[0].emit('sentence',{id:1,text:'打开 Codex'});
  pipeline.rotateSession(sessions[0]);sessions[1].emit('sentence',{id:0,text:'前面的不用管，先打开微信'});await nextTick();
  assert.equal(signals[0].aborted,true);assert.deepEqual(texts,['查导航','前面的不用管，先打开微信']);
  sessions[0].emit('final',{text:'查导航，打开 Codex'});release();await nextTick();
  assert.deepEqual(texts,['查导航','前面的不用管，先打开微信']);
});

test('sentence results remain ordered across a rotated session waiting for its final', async t => {
  const asr = new FakeASR({ scripts:[[], []] }), sessions = [], texts = [], create = asr.createSession.bind(asr);
  asr.createSession = options => {
    const session = create(options); session.end = () => {}; sessions.push(session); return session;
  };
  const pipeline = new VoicePipeline({ asr, vad:new FakeVAD(), tts:new FakeTTS(), preRollMs:0, onUserText:text => texts.push(text) });
  t.after(() => pipeline.close());
  pipeline.write(tone()); pipeline.rotateSession(sessions[0]);
  sessions[1].emit('sentence', { id:0, text:'第二段' }); await nextTick();
  assert.deepEqual(texts, []);
  sessions[0].emit('sentence', { id:0, text:'第一段' });
  sessions[0].emit('final', { text:'第一段' }); await nextTick();
  assert.deepEqual(texts, ['第一段', '第二段']);
  pipeline.interrupt();
  sessions[1].emit('sentence', { id:1, text:'迟到' });
  await nextTick(); assert.deepEqual(texts, ['第一段', '第二段']);
});

test('an empty final from the previous segment never delays a new completed sentence', async t => {
  const asr = new FakeASR({ scripts:[[], []] }), sessions = [], texts = [], create = asr.createSession.bind(asr);
  asr.createSession = options => {
    const session = create(options); session.end = () => {}; sessions.push(session); return session;
  };
  const pipeline = new VoicePipeline({ asr, vad:new FakeVAD(), tts:new FakeTTS(), preRollMs:0, onUserText:text => texts.push(text) });
  t.after(() => pipeline.close());
  pipeline.write(tone()); pipeline.rotateSession(sessions[0]);
  sessions[1].emit('sentence', { id:0, text:'知微，帮我打开文件' });
  sessions[0].emit('final', { text:'' }); await nextTick();
  assert.deepEqual(texts, ['知微，帮我打开文件']);
  assert.equal(pipeline.vad.speech, true);
});
