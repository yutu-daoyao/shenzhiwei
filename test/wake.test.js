import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { KeywordWakeDetector, WakeGate } from '../src/voice/wake.js';
import { VoiceConversation } from '../src/voice/conversation.js';
import { FakeASR, FakeVAD, FakeTTS } from '../src/voice/fake.js';
import { FakeCapture, FakePlayback } from '../src/voice/audio.js';

test('keyword sentences require a leading direct address, support config and cooldown', () => {
  let now = 0;
  const detector = new KeywordWakeDetector({ now:() => now });
  for (const text of ['', '我说知微了吗', '知微删除文件', '不知道']) assert.equal(detector.accept(text), false);
  assert.equal(detector.accept('你好，知微！'), true);
  assert.equal(detector.accept('知微'), false);
  now = 3000; assert.equal(detector.accept('知微。'), true);
  assert.equal(new KeywordWakeDetector({ keyword:'小微' }).accept('嘿，小微'), true);
  assert.throws(() => new KeywordWakeDetector({ keyword:'' }));
});

test('gate consumes wake and duplicates, expires idle sessions and accepts fake detectors', () => {
  let now = 0;
  const gate = new WakeGate({ now:() => now, idleMs:100, detector:new KeywordWakeDetector({ now:() => now }) });
  assert.equal(gate.accept('环境谈话'), 'sleep');
  assert.equal(gate.accept('知微'), 'wake');
  assert.equal(gate.accept('知微'), 'sleep');
  assert.equal(gate.accept('打开记事本'), 'command');
  now = 100; assert.equal(gate.accept('删除'), 'sleep');
  now = 3000; assert.equal(gate.accept('知微'), 'wake');
  gate.sleep(); assert.equal(gate.accept('删除'), 'sleep');
  const fake = new WakeGate({ detector:{ accept:text => text === 'fake' } });
  assert.equal(fake.accept('fake'), 'wake'); assert.equal(fake.accept('任务'), 'command');
});

test('wake uses corrected full and short names without accepting embedded names', () => {
  const detector = new KeywordWakeDetector({ cooldownMs:0 });
  for (const text of ['沈志威', '沈知威', '沈志微', '沈芝薇', '知威', '志威', '志微', '沈知微', '你好，沈志威！', '嘿，志威。', '沈志威，打开记事本']) {
    assert.equal(detector.accept(text), true, text);
  }
  for (const text of ['我认识沈志威', '“志威”', '志威公司', '请叫志微过来']) {
    assert.equal(detector.accept(text), false, text);
  }
  assert.equal(new KeywordWakeDetector({ keyword:'小微' }).accept('沈志威'), false);
  const gate = new WakeGate({ detector });
  assert.equal(gate.accept('你好，沈志威'), 'wake');
  assert.equal(gate.accept('打开记事本'), 'command');
});

test('address parsing preserves command casing and cooldown never swallows an awake command', () => {
  let now = 0;
  const gate = new WakeGate({ now:() => now, detector:new KeywordWakeDetector({ now:() => now }), singleCommand:true });
  assert.equal(gate.accept('知微'), 'wake');
  now = 100;
  assert.deepEqual(gate.route('知微，帮我新建 README.md 和 TestCase 文件夹'),
    { action:'command', command:'帮我新建 README.md 和 TestCase 文件夹' });
  assert.equal(gate.accept('室友说话'), 'sleep');
  assert.equal(new KeywordWakeDetector({ keyword:'你好助手' }).accept('你好助手'), true);
  assert.equal(new KeywordWakeDetector().parse('志威，搜索 AI 新闻').command, '搜索 AI 新闻');
});

test('fake audio reaches brain only after wake; disabling and re-enabling rearms gate', async t => {
  const capture = new FakeCapture(), heard = [];
  const voice = new VoiceConversation({ config:{ mode:'wake' }, capture, playback:new FakePlayback(), brain:{ run:async text => { heard.push(text); return ''; } },
    providers:{ asr:new FakeASR({ scripts:[['环境谈话'], ['fake'], ['打开记事本'], ['未唤醒']] }), vad:new FakeVAD(), tts:new FakeTTS() },
    wakeDetector:{ accept:text => text === 'fake' },
  });
  t.after(() => voice.close());
  await voice.setEnabled(true);
  async function ask() {
    const frame = Buffer.alloc(640); frame.writeInt16LE(4000);
    await capture.replay([frame, Buffer.alloc(640)]);
    for (let i = 0; i < 10; i++) await tick();
  }
  await ask(); assert.deepEqual(heard, []);
  await ask(); assert.deepEqual(heard, []);
  await ask(); assert.deepEqual(heard, ['打开记事本']);
  await voice.setEnabled(false); await voice.setEnabled(true);
  await ask(); assert.deepEqual(heard, ['打开记事本']);
});

test('leading requests wake and extract commands; common words, quotes and room chatter stay asleep', t => {
  const detector = new KeywordWakeDetector({ cooldownMs:0 });
  for (const name of ['知微', '知威', '志威', '芝微', '芷薇', '智微', '智威', '之微']) {
    for (const greeting of ['', '你好，', '嘿']) {
      const text = `${greeting}${name}，帮我新建一个叫测试的文件夹`;
      assert.equal(detector.accept(text), true, text);
      assert.equal(detector.parse(text).command, '帮我新建一个叫测试的文件夹');
    }
  }
  for (const text of ['认位', '认位。对不对？我刚进宿舍楼就开始出汗。', '认位，帮我打开文件',
    '喂，你好。', '刚才是被窗外的雷声吓到的，知道吧？', '智慧', '智慧，帮我打开文件', '只为', '只为你好', '知道',
    '不知道知微是谁', '他说知微，帮我打开文件', '“知微，帮我打开文件”', '「志威」',
    '嘿，“知微”，帮我打开文件', '知微公司', '知微是我的同学', '知微，昨天和小王聊天了']) {
    assert.equal(detector.accept(text), false, text);
  }
  const previous = process.env.ZHIWEI_WAKE_ALIASES;
  t.after(() => { if (previous === undefined) delete process.env.ZHIWEI_WAKE_ALIASES; else process.env.ZHIWEI_WAKE_ALIASES = previous; });
  process.env.ZHIWEI_WAKE_ALIASES = '小知,阿微, ,a.b';
  const aliases = new KeywordWakeDetector({ cooldownMs:0 });
  assert.equal(aliases.accept('你好小知，帮我打开文件'), true);
  assert.equal(aliases.accept('阿微'), true);
  assert.equal(aliases.accept('a.b'), true);
  assert.equal(aliases.accept('axb'), false, 'aliases are literal, never regular expressions');
  assert.equal(aliases.accept('他叫阿微'), false);
});

test('single-command mode is optional and consumes inline and following commands once', t => {
  const previous = process.env.ZHIWEI_WAKE_SINGLE_COMMAND;
  t.after(() => { if (previous === undefined) delete process.env.ZHIWEI_WAKE_SINGLE_COMMAND; else process.env.ZHIWEI_WAKE_SINGLE_COMMAND = previous; });
  delete process.env.ZHIWEI_WAKE_SINGLE_COMMAND;
  const continuous = new WakeGate();
  assert.equal(continuous.singleCommand, false);
  assert.equal(continuous.accept('知微'), 'wake');
  assert.equal(continuous.accept('第一句'), 'command');
  assert.equal(continuous.accept('室友说话'), 'command');
  process.env.ZHIWEI_WAKE_SINGLE_COMMAND = '1';
  const single = new WakeGate({ detector:new KeywordWakeDetector({ cooldownMs:0 }) });
  assert.equal(single.accept('知微'), 'wake');
  assert.equal(single.accept('第一句'), 'command');
  assert.equal(single.accept('室友说话'), 'sleep');
  assert.deepEqual(single.route('知微，帮我打开文件'), { action:'wake', command:'帮我打开文件' });
  assert.equal(single.accept('室友说话'), 'sleep');
  assert.equal(single.accept('知微'), 'wake');
  assert.equal(single.accept('第二句'), 'command');
});

test('dorm timeline: completed sentences wake and reach brain before VAD end, with no aggregate replay', async t => {
  t.mock.timers.enable({ apis:['setTimeout'] });
  const capture = new FakeCapture(), heard = [], spoken = [], source = new FakeTTS();
  // Times relative to 21:15:55; no silence, just roommate speech and wind.
  const script = [
    { at:0, text:'仲', final:false },
    { at:1000, id:0, text:'认位。', final:true },
    { at:2000, id:1000, text:'对不对？', final:true },
    { at:4000, id:2000, text:'我刚进宿舍楼就开始出汗。', final:true },
    { at:12000, id:4000, text:'刚才是被窗外的雷声吓到的，知道吧？', final:true },
  ];
  const second = [
    { at:15000, id:0, text:'喂，你好。', final:true },
    { at:16000, id:1000, text:'知微，帮我新建一个叫测试的文件夹', final:true },
    { at:17000, id:1000, text:'知微，帮我新建一个叫测试的文件夹', final:true },
    { at:18000, id:2000, text:'室友还在聊天。', final:true },
  ];
  const asr = new FakeASR({ scripts:[script, second, []] });
  const sessions = [], create = asr.createSession.bind(asr);
  asr.createSession = options => { const session = create(options); sessions.push(session); return session; };
  const voice = new VoiceConversation({ capture, playback:new FakePlayback(),
    config:{ mode:'wake', pipelineOptions:{ preRollMs:0 }, wakeGateOptions:{ singleCommand:true } },
    brain:{ run:async text => { heard.push(text); return ''; } },
    providers:{ asr, vad:new FakeVAD(), tts:{ synthesize(text, options) { spoken.push(text); return source.synthesize(text, options); } } },
  });
  t.after(() => voice.close());
  await voice.setEnabled(true);
  const frame = Buffer.alloc(640); frame.writeInt16LE(4000);
  let time = 0;
  for (const item of [...script, ...second]) {
    t.mock.timers.tick(item.at - time); time = item.at;
    capture.emit('frame', frame);
    for (let i = 0; i < 15; i++) await tick();
    if (time < 16000) assert.deepEqual(heard, []);
  }
  assert.equal(sessions.length, 2, 'continuous speech rotates at 15 seconds');
  assert.equal(voice.pipeline.vad.speech, true);
  assert.deepEqual(heard, ['帮我新建一个叫测试的文件夹']);
  assert.deepEqual(spoken, ['我在，请说。']);
  // Defend at pipeline level too, even if a provider repeats a sentence event.
  sessions[1].emit('sentence', { id:1000, text:'知微，帮我新建一个叫测试的文件夹' });
  capture.emit('frame', Buffer.alloc(640));
  for (let i = 0; i < 15; i++) await tick();
  assert.deepEqual(heard, ['帮我新建一个叫测试的文件夹']);
  t.mock.timers.tick(34000 - time);
  assert.equal(sessions.length, 2, 'VAD end clears the rotation timer');
});

test('single-command conversation consumes first command and stays asleep after brain finishes', async t => {
  const capture = new FakeCapture(), heard = [], asr = new FakeASR({ scripts:[[
    { id:0, text:'知微。', final:true },
    { id:1, text:'打开记事本', final:true },
    { id:2, text:'室友说话', final:true },
  ]] });
  const voice = new VoiceConversation({ capture, playback:new FakePlayback(),
    config:{ mode:'wake', pipelineOptions:{ preRollMs:0 }, wakeGateOptions:{ singleCommand:true } },
    brain:{ run:async text => { heard.push(text); return ''; } }, providers:{ asr, vad:new FakeVAD(), tts:new FakeTTS() },
  });
  t.after(() => voice.close()); await voice.setEnabled(true);
  const frame = Buffer.alloc(640); frame.writeInt16LE(4000);
  for (let n = 0; n < 3; n++) {
    capture.emit('frame', frame);
    for (let i = 0; i < 15; i++) await tick();
  }
  assert.deepEqual(heard, ['打开记事本']);
});
