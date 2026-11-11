import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { VoiceConversation } from '../src/voice/conversation.js';
import { FakeASR, FakeTTS, FakeVAD } from '../src/voice/fake.js';
import { FakeCapture, FakePlayback } from '../src/voice/audio.js';
import { KeywordWakeDetector, WakeGate } from '../src/voice/wake.js';
import { correctAssistantName } from '../src/voice/name-corrections.js';

const frame = Buffer.alloc(640, 1);
async function settle() { for (let n = 0; n < 30; n++) await tick(); }
async function rig(t, { scripts = [], delayed = false, config = {} } = {}) {
  const capture = new FakeCapture(), playback = new FakePlayback(), asr = new FakeASR({ scripts });
  const sessions = [], heard = [], spoken = [], source = new FakeTTS();
  const create = asr.createSession.bind(asr);
  asr.createSession = options => {
    const session = create(options);
    const write = session.write;
    session.frames = [];
    session.write = data => { session.frames.push(Buffer.from(data)); write(data); };
    session.finish = session.end;
    if (delayed) session.end = () => {};
    sessions.push(session); return session;
  };
  const voice = new VoiceConversation({ capture, playback, config,
    providers:{ asr, vad:new FakeVAD(), tts:{ synthesize(text, options) { spoken.push(text); return source.synthesize(text, options); } } },
    brain:{ run:async text => { heard.push(text); return '完成'; } },
  });
  t.after(() => voice.close());
  await voice.setEnabled(true);
  return { voice, capture, playback, sessions, heard, spoken };
}

test('PTT defaults on, discards idle frames, and waits for release plus final before one command', async t => {
  const r = await rig(t, { delayed:true, scripts:[[
    { id:0, text:'帮我创建', final:true }, { id:1, text:'一个桌面的文件夹', final:true },
  ]] });
  assert.equal(r.voice.snapshot().mode, 'ptt');
  assert.equal(r.voice.snapshot().wakeWord, undefined);
  await r.capture.replay([frame, frame]);
  assert.equal(r.sessions.length, 0, 'no idle ASR connection or audio');
  r.voice.ptt('start'); r.voice.ptt('start');
  await r.capture.replay([frame, Buffer.alloc(640)]); await settle();
  assert.equal(r.sessions.length, 1);
  assert.equal(r.voice.state, 'listening', 'silence never releases PTT');
  assert.equal(r.voice.partial, '帮我创建一个桌面的文件夹');
  assert.deepEqual(r.heard, [], 'sentence_end cannot execute while held');
  r.voice.ptt('stop'); r.voice.ptt('stop');
  await r.capture.replay([frame, frame]); await settle();
  assert.equal(r.sessions[0].frames.length, 2, 'no pre-roll or post-release audio');
  assert.deepEqual(r.heard, [], 'release still waits for ASR final');
  r.sessions[0].finish(); await settle();
  assert.deepEqual(r.heard, ['帮我创建一个桌面的文件夹']);
  assert.deepEqual(r.spoken, ['完成']);
  assert.ok(r.playback.chunks.length);
  r.sessions[0].emit('final', { text:'重复' }); await settle();
  assert.equal(r.heard.length, 1);
});

test('empty, punctuation-only and one-character PTT results show retry and never reach brain', async t => {
  const r = await rig(t, { scripts:[[], ['。！？'], ['嗯。'], ['创建文件夹']] });
  for (let n = 0; n < 3; n++) {
    r.voice.ptt('start'); r.voice.ptt('stop'); await settle();
    assert.deepEqual(r.heard, []);
    assert.equal(r.voice.error, '没听清，请再按住说一次');
  }
  r.voice.ptt('start'); assert.equal(r.voice.error, null);
  r.voice.ptt('stop'); await settle();
  assert.deepEqual(r.heard, ['创建文件夹']);
});

test('press stops playback immediately and cancels pending recognition from the previous hold', async t => {
  const r = await rig(t, { delayed:true, scripts:[['旧命令'], ['新命令']] });
  r.voice.ptt('start'); r.voice.ptt('stop');
  const speaking = r.voice.pipeline.say('正在播报一段很长的话');
  assert.ok(r.voice.pipeline.output);
  const stops = r.playback.stops;
  r.voice.ptt('start');
  assert.equal(r.playback.stops, stops + 1);
  assert.equal(r.voice.pipeline.output, null);
  assert.equal(r.voice.snapshot().held, true);
  r.sessions[0].emit('final', { text:'旧命令' }); await settle();
  assert.deepEqual(r.heard, []);
  r.voice.ptt('stop'); r.sessions[1].finish(); await speaking; await settle();
  assert.deepEqual(r.heard, ['新命令']);
});

test('PTT rotation merges segments in capture order into one command after all finals', async t => {
  t.mock.timers.enable({ apis:['setTimeout'] });
  const r = await rig(t, { delayed:true, scripts:[['帮我'], ['创建文件夹']] });
  r.voice.ptt('start'); r.capture.emit('frame', frame);
  t.mock.timers.tick(15000);
  assert.equal(r.sessions.length, 2);
  r.capture.emit('frame', frame);
  assert.equal(r.voice.partial, '帮我创建文件夹', 'partial display spans rotated sessions');
  r.voice.ptt('stop');
  r.sessions[1].finish(); await settle(); assert.deepEqual(r.heard, []);
  r.sessions[0].finish(); await settle();
  assert.deepEqual(r.heard, ['帮我创建文件夹']);
  t.mock.timers.tick(15000);
  assert.equal(r.sessions.length, 2);
});

test('failed or timed-out PTT segments discard the whole command and allow retry', async t => {
  t.mock.timers.enable({ apis:['setTimeout'] });
  const r = await rig(t, { delayed:true, scripts:[['前半句'], ['后半句'], ['重试']] });
  r.voice.ptt('start'); t.mock.timers.tick(15000);
  r.sessions[1].emit('error', new Error('识别失败')); await settle();
  assert.deepEqual(r.heard, []); assert.equal(r.voice.snapshot().held, false);
  r.sessions[0].emit('final', { text:'不完整命令' });
  r.voice.ptt('start'); r.voice.ptt('stop');
  t.mock.timers.tick(5000); await settle();
  assert.match(r.voice.error, /最终结果超时/);
  r.sessions[2].emit('final', { text:'迟到结果' }); await settle();
  assert.deepEqual(r.heard, []);
});

test('PTT rotation startup failure discards already finalized segments rather than executing a fragment', async t => {
  t.mock.timers.enable({ apis:['setTimeout'] });
  const r = await rig(t, { scripts:[['只收到前半句']] });
  const asr = r.voice.pipeline.asr;
  r.voice.ptt('start'); r.capture.emit('frame', frame);
  t.mock.method(asr, 'createSession', () => { throw new Error('续开识别失败'); });
  t.mock.timers.tick(15000); await settle();
  assert.equal(r.voice.error, '续开识别失败');
  assert.equal(r.voice.snapshot().held, false);
  assert.equal(r.voice.pipeline.sessions.size, 0);
  r.voice.ptt('stop'); await settle();
  assert.deepEqual(r.heard, []);
});

test('disabling or explicitly interrupting PTT discards held audio and rearms safely', async t => {
  const r = await rig(t, { delayed:true, scripts:[['丢弃'], ['丢弃'], ['可执行']] });
  assert.throws(() => r.voice.ptt('other'), /start 或 stop/);
  r.voice.ptt('start'); r.voice.interrupt(); r.voice.ptt('stop');
  r.sessions[0].emit('final', { text:'丢弃' });
  r.voice.ptt('start'); await r.voice.setEnabled(false);
  r.sessions[1].emit('final', { text:'丢弃' }); await settle();
  assert.deepEqual(r.heard, []);
  assert.throws(() => r.voice.ptt('start'), /先开启语音/);
  r.voice.ptt('stop');
  await r.voice.setEnabled(true);
  r.capture.emit('frame', frame); assert.equal(r.sessions.length, 2);
  r.voice.ptt('start'); r.voice.ptt('stop'); r.sessions[2].finish(); await settle();
  assert.deepEqual(r.heard, ['可执行']);
});

test('environment selects wake mode; old gate and PTT mode validation remain explicit', async t => {
  const previous = process.env.ZHIWEI_VOICE_MODE;
  t.after(() => { if (previous === undefined) delete process.env.ZHIWEI_VOICE_MODE; else process.env.ZHIWEI_VOICE_MODE = previous; });
  process.env.ZHIWEI_VOICE_MODE = 'wake';
  const r = await rig(t, { scripts:[['室友说话'], ['志薇你好，帮我创建文件夹']] });
  assert.equal(r.voice.snapshot().mode, 'wake');
  assert.throws(() => r.voice.ptt('start'), /唤醒词模式/);
  await r.capture.replay([frame, Buffer.alloc(640)]); await settle();
  assert.deepEqual(r.heard, []);
  await r.capture.replay([frame, Buffer.alloc(640)]); await settle();
  assert.deepEqual(r.heard, ['帮我创建文件夹']);
  assert.throws(() => new VoiceConversation({ config:{ mode:'other' } }), /ptt 或 wake/);
});

test('all requested homophones plus name-before-greeting route only direct addresses', () => {
  for (const first of '知志芝之智') for (const last of '微薇威') {
    const name = first + last;
    const gate = new WakeGate({ detector:new KeywordWakeDetector({ cooldownMs:0 }) });
    for (const command of ['帮我创建文件夹', '创建文件夹']) {
      assert.deepEqual(gate.route(`${name}你好，${command}`), { action:'wake', command });
      assert.equal(correctAssistantName(`${name}你好，${command}`), `知微你好，${command}`);
    }
    assert.deepEqual(gate.route(`${name}你好`), { action:'wake', command:'' });
  }
  const detector = new KeywordWakeDetector();
  for (const name of ['认位', '智慧', '只为', '知道']) {
    assert.equal(detector.matches(`${name}你好，帮我创建文件夹`), false);
    assert.equal(correctAssistantName(`${name}你好，帮我创建文件夹`), `${name}你好，帮我创建文件夹`);
  }
  for (const text of ['他说志薇你好，帮我创建文件夹', '“志薇你好，帮我创建文件夹”', '志薇公司']) assert.equal(detector.matches(text), false);
});
