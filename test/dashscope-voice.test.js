import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import { DashScopeASR } from '../src/voice/dashscope/asr.js';
import { DashScopeTTS } from '../src/voice/dashscope/tts.js';
import { createSocket } from '../src/voice/dashscope/socket.js';
import { ENDPOINT, MISSING_KEY, runTTS } from '../src/voice/dashscope/protocol.js';
import { FakeASR, FakeTTS } from '../src/voice/fake.js';
import { createVoiceProviders } from '../src/voice/interfaces.js';
import { createVoicePipeline } from '../src/voice/pipeline.js';
import { ReplaySocket } from './fixtures/dashscope/replay-socket.js';
import { correctAssistantName, NAME_CORRECTIONS } from '../src/voice/name-corrections.js';
import { Zhiwei } from '../src/client.js';
import { FakeCapture, FakePlayback } from '../src/voice/audio.js';

test('TTS rate uses the documented multiplier and rejects invalid ranges',()=>{
  assert.equal(runTTS('rate-test',{rate:1.2}).payload.parameters.rate,1.2);
  assert.equal(Object.hasOwn(runTTS('rate-test').payload.parameters,'rate'),false);
  for(const rate of [0,3,NaN,'1.2'])assert.throws(()=>runTTS('rate-test',{rate}),RangeError);
});

const audio = Buffer.from('AQACAAMA', 'base64');
function replay(name, overrides = {}, expectedRun = {}) {
  let socket;
  return {
    options:{ timeoutMs:1000, socketFactory(url, options) {
      assert.equal(url, ENDPOINT);
      assert.deepEqual(options, { headers:{ Authorization:`bearer ${process.env.DASHSCOPE_API_KEY}` } });
      socket = new ReplaySocket(name);
      const run = JSON.parse(socket.rows[1].text);
      if (expectedRun.model) run.payload.model = expectedRun.model;
      if (expectedRun.voice) run.payload.parameters.voice = expectedRun.voice;
      if (expectedRun.vocabularyId) run.payload.parameters.vocabulary_id = expectedRun.vocabularyId;
      socket.rows[1].text = JSON.stringify(run);
      return socket;
    }, ...overrides },
    get socket() { return socket; },
  };
}

test('assistant homophones are corrected only in direct addresses', () => {
  for (const [alias, name] of Object.entries(NAME_CORRECTIONS)) {
    for (const [input, expected] of [
      [alias, name], [`你好，${alias}！`, `你好，${name}！`],
      [`${alias}帮我打开记事本`, `${name}帮我打开记事本`],
      [`${alias}，请停止任务`, `${name}，请停止任务`],
      [`你好。${alias}。`, `你好。${name}。`],
    ]) {
      assert.equal(correctAssistantName(input), expected);
      assert.equal(correctAssistantName(expected), expected, 'correction is idempotent');
    }
  }
  for (const text of ['', '知微', '沈知微', '我认识沈志威', '请搜索志威公司',
    '志威公司今天上市', '沈志威是我的同事', '志微小说', '“沈志威”', '他说：“志威，帮我打开文件”',
    '把沈志威写进文件', '志威的电话是多少', '志威 公司介绍', '沈志威，男，三十岁', '他说：“你好。志威。”']) {
    assert.equal(correctAssistantName(text), text);
  }
});

test('DashScope offline protocol and lifecycle', { timeout:10000 }, async t => {
  // Environment changes are scoped to this sequential suite, never a real key.
  const originalEnv = { ...process.env };
  const setEnv = (name, value) => { process.env[name] = value; };
  t.after(() => {
    for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name];
    Object.assign(process.env, originalEnv);
  });
  setEnv('DASHSCOPE_API_KEY', 'offline-test-key');
  setEnv('ZHIWEI_VOICE_PROVIDER', 'fake');
  setEnv('ZHIWEI_VOICE_ASR', 'fake');
  setEnv('ZHIWEI_VOICE_TTS', 'fake');
  setEnv('ZHIWEI_VOICE_VAD', 'fake');
  setEnv('ZHIWEI_VOICE_ASR_MODEL', 'paraformer-realtime-v2');
  setEnv('ZHIWEI_VOICE_TTS_MODEL', 'cosyvoice-v2');
  setEnv('ZHIWEI_VOICE_TTS_VOICE', 'longxiaochun_v2');
  delete process.env.ZHIWEI_ASR_VOCABULARY_ID;

  for (const mode of ['wake', 'ptt']) await t.test(`${mode} real-audio wiring sends Paraformer text to Codex and plays CosyVoice PCM`, async t => {
    const names = ['ZHIWEI_VOICE_PROVIDER', 'ZHIWEI_VOICE_ASR', 'ZHIWEI_VOICE_TTS', 'ZHIWEI_VOICE_TTS_VOICE'];
    const previous = names.map(name => process.env[name]);
    for (const name of names) delete process.env[name];
    t.after(() => {
      for (const [i, name] of names.entries()) {
        if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i];
      }
    });
    const asr = replay('asr-normal'), tts = replay('tts-normal', {}, { voice:'longwan_v2' });
    const rpc = new EventEmitter(), capture = new FakeCapture(), playback = new FakePlayback(), sent = [];
    const client = new Zhiwei({ rpc, dataDir:'.', workspace:'.', voiceOptions:{ capture, playback,
      config:{ mode, audio:'windows', wakeEnabled:false, vad:'fake', pipelineOptions:{ preRollMs:0 }, asrOptions:asr.options, ttsOptions:tts.options } } });
    t.after(() => client.close());
    client.currentId = 'offline-thread';
    client.claimWriter(client.currentId);
    client.sessions.entries = [{ id:client.currentId, title:'离线对话' }];
    client.sessions.put = async () => {};
    Object.assign(rpc, { connected:true, stop:async () => {}, request:async (method, params) => {
      assert.equal(method, 'turn/start'); sent.push(params.input[0].text);
      queueMicrotask(() => client.notification({ method:'turn/completed', params:{ threadId:client.currentId,
        turn:{ id:'offline-turn', status:'completed', items:[{ id:'reply', type:'agentMessage', text:'你好，知微。' }] } } }));
      return { turn:{ id:'offline-turn', status:'inProgress' } };
    } });
    assert.equal(client.voice.snapshot().provider, 'dashscope');
    assert.equal(client.voice.snapshot().availability.ready, true);
    await client.voice.setEnabled(true);
    if (mode === 'ptt') client.voice.ptt('start');
    await capture.replay(mode === 'ptt' ? [audio] : [audio, Buffer.alloc(audio.length)]);
    if (mode === 'ptt') client.voice.ptt('stop');
    const deadline = Date.now() + 2000;
    while (!tts.socket?.closed || client.voice.state !== 'idle') {
      if (client.voice.error) assert.fail(client.voice.error);
      if (Date.now() > deadline) assert.fail('DashScope 自动对话回放超时');
      await tick();
    }
    assert.deepEqual(sent, mode === 'ptt' ? ['你好。知微。'] : ['你好。', '知微。']);
    assert.deepEqual(Buffer.concat(playback.chunks), Buffer.from('010002000300040005000600'.repeat(mode === 'ptt' ? 1 : 2), 'hex'));
    asr.socket.verify(); tts.socket.verify();
  });

  await t.test('ASR buffers before start, emits cumulative partials and one final after task-finished', async () => {
    const r = replay('asr-normal'), session = new DashScopeASR(r.options).createSession();
    const partials = [], finals = [], sentences = [];
    session.on('partial', ({ text }) => partials.push(text));
    session.on('final', ({ text }) => finals.push(text));
    session.on('sentence', result => sentences.push(result));
    const result = once(session, 'final');
    session.write(audio); session.end(); session.end(); session.write(audio);
    assert.deepEqual(await result, [{ text:'你好。知微。' }]);
    assert.deepEqual(partials, ['你好', '你好。', '你好。知微', '你好。知微。']);
    assert.deepEqual(finals, ['你好。知微。']);
    assert.deepEqual(sentences, [{ id:0, text:'你好。' }, { id:600, text:'知微。' }]);
    session.close(); r.socket.verify();
  });

  await t.test('ASR task-failed is a safe Chinese error', async () => {
    const r = replay('asr-task-failed'), session = new DashScopeASR(r.options).createSession();
    const [error] = await once(session, 'error');
    assert.match(error.message, /语音任务失败/);
    assert.ok(!error.message.includes('offline-test-key'));
    session.end(); session.close(); r.socket.verify();
  });

  await t.test('sentence_end is delivered before end or task-finished and duplicate finals stay consumed', async () => {
    const socket = new EventTarget(), sentences = [], finals = [];
    let taskId;
    socket.readyState = 1; socket.close = () => {};
    const emit = (event, payload = {}) => socket.dispatchEvent(new MessageEvent('message', {
      data:JSON.stringify({ header:{ task_id:taskId, event }, payload }),
    }));
    socket.send = data => {
      if (typeof data !== 'string') return;
      const { header } = JSON.parse(data); taskId = header.task_id;
      if (header.action === 'run-task') emit('task-started');
      if (header.action === 'finish-task') emit('task-finished');
    };
    const session = new DashScopeASR({ socketFactory() {
      queueMicrotask(() => socket.dispatchEvent(new Event('open'))); return socket;
    } }).createSession();
    session.on('sentence', result => sentences.push(result));
    session.on('final', result => finals.push(result));
    await tick();
    const sentence = { begin_time:0, text:'志威，帮我打开 README.md', sentence_end:false };
    emit('result-generated', { output:{ sentence } });
    assert.deepEqual(sentences, []);
    sentence.sentence_end = true;
    emit('result-generated', { output:{ sentence } });
    emit('result-generated', { output:{ sentence } });
    assert.deepEqual(sentences, [{ id:0, text:'知微，帮我打开 README.md' }]);
    assert.deepEqual(finals, []);
    session.end();
    assert.deepEqual(finals, [{ text:'知微，帮我打开 README.md' }]);
    session.close();
  });

  await t.test('ASR keeps partials for display but only sentence_end text becomes final', async () => {
    for (const confirmed of [true, false]) {
      const r = replay('asr-normal');
      const socketFactory = r.options.socketFactory;
      r.options.socketFactory = (...args) => {
        const socket = socketFactory(...args);
        for (const row of socket.rows) {
          if (row.direction !== 'receive' || !row.text) continue;
          const event = JSON.parse(row.text), sentence = event.payload?.output?.sentence;
          if (sentence && (!confirmed || sentence.begin_time === 600)) sentence.sentence_end = false;
          row.text = JSON.stringify(event);
        }
        return socket;
      };
      const session = new DashScopeASR(r.options).createSession(), partials = [];
      session.on('partial', ({ text }) => partials.push(text));
      const final = once(session, 'final');
      session.write(audio); session.end();
      assert.deepEqual(await final, [{ text:confirmed ? '你好。' : '' }]);
      assert.equal(partials.at(-1), '你好。知微。');
      session.close(); r.socket.verify();
    }
  });

  await t.test('ASR corrects cumulative partial and final output from raw homophones', async () => {
    const r = replay('asr-normal');
    const socketFactory = r.options.socketFactory;
    r.options.socketFactory = (...args) => {
      const socket = socketFactory(...args);
      for (const row of socket.rows) {
        if (row.direction === 'receive' && row.text) row.text = row.text.replaceAll('知微', '沈志威');
      }
      return socket;
    };
    const session = new DashScopeASR(r.options).createSession(), partials = [];
    session.on('partial', ({ text }) => partials.push(text));
    const final = once(session, 'final');
    session.write(audio); session.end();
    assert.deepEqual(await final, [{ text:'你好。沈知微。' }]);
    assert.deepEqual(partials, ['你好', '你好。', '你好。沈知微', '你好。沈知微。']);
    session.close(); r.socket.verify();
  });

  await t.test('optional vocabulary env reaches run-task and is omitted when absent or empty', async () => {
    for (const vocabularyId of ['vocab-offline-zhiwei', '', undefined]) {
      if (vocabularyId === undefined) delete process.env.ZHIWEI_ASR_VOCABULARY_ID;
      else setEnv('ZHIWEI_ASR_VOCABULARY_ID', vocabularyId);
      const r = replay('asr-normal', {}, { vocabularyId });
      const session = new DashScopeASR(r.options).createSession(), final = once(session, 'final');
      session.write(audio); session.end(); await final;
      const { parameters } = JSON.parse(r.socket.sent[0]).payload;
      if (vocabularyId) assert.equal(parameters.vocabulary_id, vocabularyId);
      else assert.equal(Object.hasOwn(parameters, 'vocabulary_id'), false);
      session.close(); r.socket.verify();
    }
  });

  await t.test('TTS sends exact commands and streams binary frames in order', async () => {
    const r = replay('tts-normal'), chunks = [];
    for await (const chunk of new DashScopeTTS(r.options).synthesize('你好，知微。')) {
      chunks.push(chunk.toString('base64'));
      await tick();
    }
    assert.deepEqual(chunks, ['AQACAAMA', 'BAAFAA==', 'BgA=']);
    r.socket.verify();
  });

  await t.test('configured models and per-call voice override reach run-task parameters', async () => {
    const asr = replay('asr-normal', { model:'custom-asr' }, { model:'custom-asr' });
    const session = new DashScopeASR(asr.options).createSession(), final = once(session, 'final');
    session.write(audio); session.end(); await final; session.close(); asr.socket.verify();
    const tts = replay('tts-normal', { model:'custom-tts', voice:'constructor-voice' }, { model:'custom-tts', voice:'call-voice' });
    for await (const _ of new DashScopeTTS(tts.options).synthesize('你好，知微。', { voice:'call-voice' })) {}
    tts.socket.verify();
  });

  await t.test('TTS cancellation drops future frames and wakes a waiting consumer', async () => {
    const r = replay('tts-cancel'), stream = new DashScopeTTS(r.options).synthesize('你好，知微。');
    const iterator = stream[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value.toString('base64'), 'AQACAAMA');
    const pending = iterator.next(); stream.cancel(); stream.cancel();
    assert.equal((await pending).done, true);
    r.socket.dispatchEvent(new MessageEvent('message', { data:audio }));
    assert.equal((await iterator.next()).done, true);
    r.socket.verify();
  });

  await t.test('connection interruption rejects TTS instead of silently truncating audio', async () => {
    const r = replay('connection-interrupted'), iterator = new DashScopeTTS(r.options).synthesize('你好，知微。')[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).done, false);
    await assert.rejects(iterator.next(), /连接意外关闭/);
    r.socket.verify();
  });

  await t.test('pipeline barge-in and close cancel real providers', async () => {
    const r = replay('tts-cancel'), chunks = [];
    let release, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const pipeline = createVoicePipeline({
      config:{ asr:'fake', tts:'dashscope', vad:'fake', ttsOptions:r.options },
      speak:async chunk => { chunks.push(chunk); entered(); await new Promise(resolve => { release = resolve; }); },
    });
    const speaking = pipeline.say('你好，知微。');
    await ready;
    pipeline.write(audio);
    assert.equal(r.socket.closed, true);
    pipeline.close(); release(); await speaking;
    assert.equal(chunks.length, 1);
    assert.equal(pipeline.state, 'idle'); r.socket.verify();
  });

  await t.test('timeouts, transport exceptions, task-failed and malformed events terminate both providers', async () => {
    for (const mode of ['timeout', 'started-timeout', 'error', 'failed', 'invalid', 'close', 'throw', 'send-throw']) {
      let socket, closed = 0;
      const options = { timeoutMs:10, socketFactory() {
        if (mode === 'throw') throw new Error('offline-test-key');
        socket = new EventTarget(); socket.readyState = 1; socket.close = () => { closed++; };
        socket.send = text => {
          if (mode === 'send-throw') throw new Error('offline-test-key');
          const { header } = JSON.parse(text);
          queueMicrotask(() => {
            if (mode === 'started-timeout' && header.action === 'run-task') socket.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({ header:{ task_id:header.task_id, event:'task-started' } }) }));
            if (mode === 'error') socket.dispatchEvent(new Event('error'));
            if (mode === 'close') socket.dispatchEvent(new Event('close'));
            if (mode === 'invalid') socket.dispatchEvent(new MessageEvent('message', { data:'invalid offline-test-key' }));
            if (mode === 'failed') socket.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({ header:{ task_id:header.task_id, event:'task-failed', error_message:'offline-test-key' } }) }));
          });
        };
        queueMicrotask(() => socket.dispatchEvent(new Event('open')));
        return socket;
      } };
      const session = new DashScopeASR(options).createSession();
      const [error] = await once(session, 'error');
      assert.match(error.message, /DashScope/);
      assert.ok(!error.message.includes('offline-test-key'));
      assert.equal(closed, mode === 'throw' ? 0 : 1);
      closed = 0;
      await assert.rejects(async () => { for await (const _ of new DashScopeTTS(options).synthesize('测试')) {} }, error => !error.message.includes('offline-test-key'));
      assert.equal(closed, mode === 'throw' ? 0 : 1);
    }
  });

  await t.test('ASR writes after startup, ignores foreign tasks, and closes without late output', async () => {
    const socket = new EventTarget(), sent = [], results = [];
    let started, taskId, closed = 0;
    const ready = new Promise(resolve => { started = resolve; });
    socket.readyState = 1;
    socket.close = () => { closed++; };
    const emit = (id, event, payload = {}) => socket.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({ header:{ task_id:id, event }, payload }) }));
    socket.send = data => {
      sent.push(data);
      if (typeof data !== 'string') return;
      taskId = JSON.parse(data).header.task_id;
      queueMicrotask(() => { emit(taskId, 'task-started'); started(); });
    };
    const session = new DashScopeASR({ socketFactory() {
      queueMicrotask(() => socket.dispatchEvent(new Event('open')));
      return socket;
    } }).createSession();
    session.on('partial', result => results.push(result));
    session.on('final', result => results.push(result));
    session.write(audio); await ready; session.write(audio);
    emit('another-task', 'task-failed');
    assert.equal(closed, 0);
    session.close(); session.close(); session.end(); session.write(audio);
    emit(taskId, 'result-generated', { output:{ sentence:{ text:'迟到', begin_time:0, sentence_end:true } } });
    emit(taskId, 'task-finished');
    assert.equal(closed, 1); assert.equal(sent.length, 3);
    assert.deepEqual(sent.slice(1), [audio, audio]); assert.deepEqual(results, []);
  });

  await t.test('ASR close before startup and TTS cancel before iteration create no socket', async () => {
    const options = { socketFactory() { assert.fail('cancelled task opened a socket'); } };
    const session = new DashScopeASR(options).createSession();
    session.on('final', () => assert.fail('cancelled ASR emitted a final'));
    session.close(); session.end();
    const stream = new DashScopeTTS(options).synthesize('测试'); stream.cancel();
    assert.deepEqual(await Array.fromAsync(stream), []);
    await tick();
  });

  await t.test('missing key: direct providers report Chinese errors and configured pipeline falls back', async () => {
    const previous = process.env.DASHSCOPE_API_KEY;
    delete process.env.DASHSCOPE_API_KEY;
    try {
      const options = { socketFactory() { assert.fail('no key must not connect'); } };
      const session = new DashScopeASR(options).createSession();
      assert.equal((await once(session, 'error'))[0].message, MISSING_KEY);
      await assert.rejects(async () => { for await (const _ of new DashScopeTTS(options).synthesize('测试')) {} }, { message:MISSING_KEY });
      const warnings = [], providers = createVoiceProviders({ asr:'dashscope', tts:'dashscope', onWarning:message => warnings.push(message) });
      assert.ok(providers.asr instanceof FakeASR); assert.ok(providers.tts instanceof FakeTTS);
      assert.equal(warnings.length, 1); assert.match(warnings[0], /已回落到 fake/);
      assert.throws(() => createVoiceProviders({ asr:'dashscope', tts:'dashscope', requireReal:true }), /真实语音未开启/);
      // Unobserved EventEmitter errors must not crash a direct caller.
      new DashScopeASR(options).createSession(); await tick();
      const logs = [];
      const log = t.mock.method(console, 'log', message => logs.push(message));
      try { await import('../scripts/voice-live-test.js'); } finally { log.mock.restore(); }
      assert.deepEqual(logs, ['未设置 DASHSCOPE_API_KEY，跳过']);
    } finally { process.env.DASHSCOPE_API_KEY = previous; }
  });

  await t.test('provider env selection, model/voice overrides and native headers factory', async () => {
    const previous = [process.env.ZHIWEI_VOICE_PROVIDER, process.env.ZHIWEI_VOICE_ASR, process.env.ZHIWEI_VOICE_TTS];
    process.env.ZHIWEI_VOICE_PROVIDER = 'dashscope';
    delete process.env.ZHIWEI_VOICE_ASR; delete process.env.ZHIWEI_VOICE_TTS;
    try {
      const providers = createVoiceProviders();
      assert.ok(providers.asr instanceof DashScopeASR); assert.ok(providers.tts instanceof DashScopeTTS);
      assert.ok(createVoiceProviders({ provider:'fake' }).asr instanceof FakeASR);
      const calls = [];
      const mockedSocket = t.mock.method(globalThis, 'WebSocket', function (...args) { calls.push(args); });
      createSocket(ENDPOINT, { headers:{ Authorization:'bearer offline-test-key' } });
      assert.deepEqual(calls, [[ENDPOINT, { headers:{ Authorization:'bearer offline-test-key' } }]]);
      mockedSocket.mock.restore();
      assert.equal(new DashScopeASR({ model:'custom-asr' }).options.model, 'custom-asr');
      assert.equal(new DashScopeTTS({ voice:'custom-voice' }).options.voice, 'custom-voice');
    } finally {
      for (const [i, name] of ['ZHIWEI_VOICE_PROVIDER', 'ZHIWEI_VOICE_ASR', 'ZHIWEI_VOICE_TTS'].entries()) {
        if (previous[i] === undefined) delete process.env[name];
        else process.env[name] = previous[i];
      }
    }
  });

  await t.test('Node native WebSocket actually forwards Authorization without opening a network connection', async () => {
    let authorization;
    const socket = createSocket(ENDPOINT, {
      headers:{ Authorization:'bearer offline-test-key' },
      dispatcher:{ dispatch(options, handler) {
        authorization = options.headers.Authorization;
        queueMicrotask(() => handler.onError(new Error('offline transport')));
        return true;
      } },
    });
    const closed = new Promise(resolve => socket.addEventListener('close', resolve, { once:true }));
    socket.addEventListener('error', () => {});
    await closed;
    assert.equal(authorization, 'bearer offline-test-key');
  });
});
