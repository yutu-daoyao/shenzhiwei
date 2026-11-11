import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import { Zhiwei } from '../src/client.js';
import { FakeASR, FakeTTS, FakeVAD } from '../src/voice/fake.js';
import { FakeCapture, FakePlayback } from '../src/voice/audio.js';
import { VoiceConversation } from '../src/voice/conversation.js';
import { CodexVoiceBrain } from '../src/voice/brain.js';

const tone = () => { const frame = Buffer.alloc(640); frame.writeInt16LE(4000); return frame; };
const silence = () => Buffer.alloc(640);
const until = async predicate => {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > deadline) assert.fail('回放等待超时'); await tick(); }
};
function rig(t, { scripts = [['你好']], playback = new FakePlayback(), asr, tts = new FakeTTS(), brainTimeoutMs = 1000, request } = {}) {
  const capture = new FakeCapture(), vad = new FakeVAD(), starts = [], interrupts = [];
  const rpc = new EventEmitter(); let client, sequence = 0;
  Object.assign(rpc, {
    connected:true, stop:async () => {},
    request:async (method, params) => {
      if (method === 'thread/start') return { thread:{ id:'thread' } };
      if (method === 'turn/start') {
        assert.equal(params.effort,'low','voice uses the supported low reasoning effort without changing typed chat');
        const turn = { id:`turn-${++sequence}`, text:params.input[0].text };
        starts.push(turn);
        if (request) return request(method, turn, client);
        return { turn:{ id:turn.id, status:'inProgress' } };
      }
      if (method === 'turn/interrupt') {
        interrupts.push(params.turnId);
        return request?.(method, params, client) ?? {};
      }
      throw new Error(`unexpected ${method}`);
    },
  });
  client = new Zhiwei({ rpc, dataDir:'.', workspace:'.', voiceOptions:{ config:{ mode:'wake', wakeEnabled:false }, capture, playback, providers:{ asr:asr ?? new FakeASR({ scripts }), tts, vad }, brainTimeoutMs } });
  client.sessions.put = async entry => { client.sessions.entries = [entry]; };
  const voice = client.voice;
  t.after(() => client.close());
  const finish = (text = '你好呀', status = 'completed', id = starts.at(-1)?.id) => client.notification({ method:'turn/completed', params:{ threadId:'thread', turn:{ id, status, items:[{ id:`answer-${id}`, type:'agentMessage', text }] } } });
  return { client, voice, capture, playback, vad, starts, interrupts, finish, ask:() => capture.replay([tone(), silence()]) };
}

test('replay: microphone → ASR → native Codex turn → streaming PCM playback', async t => {
  const r = rig(t), states = [];
  r.voice.on('change', () => states.push(r.voice.state));
  await r.voice.setEnabled(true); await r.ask();
  await until(() => r.starts.length === 1);
  assert.equal(r.starts[0].text, '你好');
  assert.equal(r.voice.state, 'thinking');
  r.finish('回答');
  await until(() => r.voice.state === 'idle');
  assert.equal(r.playback.chunks.length, 2);
  assert.ok(r.playback.chunks.every(chunk => chunk.length === 640));
  for (const state of ['listening', 'thinking', 'speaking', 'idle']) assert.ok(states.includes(state), state);
  assert.equal(r.voice.error, null);
});

class HeldPlayback extends FakePlayback {
  async write(chunk, options) {
    await super.write(chunk, options);
    if (this.held) return;
    this.held = true; this.playing = true;
    this.signal = options.signal;
    await new Promise(resolve => { this.release = resolve; });
    this.playing = false;
  }
  stop() { super.stop(); this.playing = false; this.release?.(); }
}

test('default admits only a leading wake name and room speech cannot barge in', async t => {
  const playback=new HeldPlayback(),runs=[];
  const capture=new FakeCapture();
  const voice=new VoiceConversation({capture,playback,brain:{run:async text=>{runs.push(text);return '回答';}},
    providers:{asr:new FakeASR({scripts:[['志威，读这一句'],[
      {id:1,text:'室友在聊天。',final:true},{id:2,text:'知微，停一下。',final:true},
    ],['知危，停一下'],['知为，第二句']]}),tts:new FakeTTS(),vad:new FakeVAD()},
    config:{spokenModes:true,pipelineOptions:{confirmBargeIn:true}}});
  t.after(()=>voice.close());
  assert.equal(voice.snapshot().mode,'default');
  await voice.setEnabled(true);
  const ask=()=>capture.replay([tone(),silence()]);
  await ask();await until(()=>playback.playing);
  assert.deepEqual(runs,['读这一句']);
  await ask();await tick();
  assert.equal(playback.playing,true);
  assert.equal(playback.signal.aborted,false);
  assert.deepEqual(runs,['读这一句']);
  await ask();await until(()=>!playback.playing);
  assert.equal(voice.state,'idle');
  await ask();await until(()=>runs.length===2);
  assert.equal(runs[1],'第二句');
});

test('spoken modes switch locally, acknowledge by voice, and PTT submits once on release', async t => {
  const runs=[],spoken=[],capture=new FakeCapture(),playback=new FakePlayback();
  let stops=0;
  const tts=new FakeTTS(),voice=new VoiceConversation({capture,playback,
    brain:{run:async text=>{runs.push(text);return '答复';},stop:async()=>{stops++;}},
    providers:{asr:new FakeASR({scripts:[['知微开启对话模式'],['直接对话'],['知微，停一下'],['切换控制模式。'],['按键请求'],['知微停一下'],['知微回到默认模式'],['又听见室友']]}),
      tts:{synthesize(text,options){spoken.push(text);return tts.synthesize(text,options);}},vad:new FakeVAD()},
    config:{spokenModes:true}});
  t.after(()=>voice.close());
  await voice.setEnabled(true);
  const ask=async()=>{await capture.replay([tone(),silence()]);await until(()=>voice.state==='idle');};
  await ask();assert.equal(voice.mode,'dialog');
  await ask();assert.deepEqual(runs,['直接对话']);
  await ask();assert.equal(stops,1);
  await ask();assert.equal(voice.mode,'ptt');
  await ask();assert.deepEqual(runs,['直接对话'],'without a press, no room speech reaches recognition');
  voice.ptt('start');await capture.replay([tone(),silence()]);await tick();assert.equal(runs.length,1);
  voice.ptt('stop');await until(()=>voice.state==='idle');
  assert.deepEqual(runs,['直接对话','按键请求']);
  for(const expected of [2,2]){
    voice.ptt('start');await capture.replay([tone()]);voice.ptt('stop');await until(()=>voice.state==='idle');
    assert.equal(stops,expected);
  }
  assert.equal(voice.mode,'default');
  await ask();assert.equal(runs.length,2);
  assert.deepEqual(spoken,['已切到对话模式','答复','已切到按键模式','答复','已切到默认模式']);
  await voice.setEnabled(false);voice.mode='dialog';await voice.setEnabled(true);
  assert.equal(voice.mode,'default');
});

test('replay: speech barge-in stops the in-flight sink and synthesis immediately', async t => {
  const playback = new HeldPlayback(), source = new FakeTTS(), streams = [];
  const tts = { synthesize(...args) {
    const stream = source.synthesize(...args), cancel = stream.cancel;
    stream.cancelled = false; stream.cancel = () => { stream.cancelled = true; cancel(); };
    streams.push(stream); return stream;
  } };
  const r = rig(t, { scripts:[['第一问'], ['第二问']], playback, tts }), states = [];
  await r.voice.setEnabled(true); r.voice.pipeline.on('state', state => states.push(state));
  await r.ask(); await until(() => r.starts.length === 1); r.finish('很长的一句话');
  await until(() => playback.playing);
  r.capture.emit('frame', tone());
  assert.equal(playback.playing, false);
  assert.equal(playback.signal.aborted, true);
  assert.equal(streams[0].cancelled, true);
  assert.equal(r.voice.state, 'listening');
  assert.ok(states.includes('interrupted'));
  assert.equal(playback.chunks.length, 1);
  r.capture.emit('frame', silence());
  await until(() => r.starts.length === 2); r.finish('好');
  await until(() => r.voice.state === 'idle');
  assert.equal(playback.chunks.length, 2);
  assert.equal(r.interrupts.length, 0); // Completed brain turns need no interrupt.
});

test('replay: barge-in during thinking waits for reliable native stop before next turn', async t => {
  const r = rig(t, { scripts:[['旧问题'], ['新问题']] });
  await r.voice.setEnabled(true); await r.ask(); await until(() => r.starts.length === 1);
  await r.ask(); await until(() => r.interrupts.length === 1);
  await tick(); assert.equal(r.starts.length, 1);
  assert.equal(r.client.task.status, 'stopping');
  r.finish('旧回答不能播放', 'interrupted', 'turn-1');
  await until(() => r.starts.length === 2);
  assert.equal(r.starts[1].text, '新问题');
  assert.equal(r.playback.chunks.length, 0);
  r.finish('新回答'); await until(() => r.voice.state === 'idle');
  assert.equal(r.playback.chunks.length, 3);
  assert.equal(r.client.listenerCount('turnResult'), 0);
});

test('replay: ASR failure never reaches the brain and the next utterance works', async t => {
  const source = new FakeASR({ scripts:[['失败'], ['恢复']] }); let first = true;
  const asr = { createSession(options) {
    const session = source.createSession(options);
    if (first) { first = false; session.write = () => session.emit('error', new Error('ASR 离线失败')); }
    return session;
  } };
  const r = rig(t, { asr });
  await r.voice.setEnabled(true); await r.ask();
  assert.match(r.voice.error, /ASR 离线失败/); assert.equal(r.starts.length, 0);
  assert.equal(r.voice.state, 'idle'); assert.equal(r.voice.enabled, true);
  await r.ask(); await until(() => r.starts.length === 1); assert.equal(r.starts[0].text, '恢复');
  r.finish(); await until(() => r.voice.state === 'idle');
});

test('replay: brain timeout requests reliable stop and never speaks late output', async t => {
  const r = rig(t, { brainTimeoutMs:15 });
  await r.voice.setEnabled(true); await r.ask(); await until(() => r.starts.length === 1);
  await until(() => /大脑响应超时/.test(r.voice.error));
  assert.deepEqual(r.interrupts, ['turn-1']);
  r.finish('迟到的回答'); await tick();
  assert.equal(r.playback.chunks.length, 0); assert.equal(r.voice.state, 'idle');
});

test('replay: continuous rounds share a native thread and release listeners/devices', async t => {
  const r = rig(t, { scripts:[['一'], ['二'], ['三'], ['四']] });
  await r.voice.setEnabled(true);
  for (let i = 0; i < 4; i++) {
    await r.ask(); await until(() => r.starts.length === i + 1); r.finish('好');
    await until(() => r.voice.state === 'idle');
    assert.equal(r.client.listenerCount('turnResult'), 0);
  }
  assert.equal(r.client.sessions.entries.length, 1); assert.equal(r.playback.chunks.length, 4);
  await r.voice.setEnabled(false); await r.voice.setEnabled(false);
  assert.equal(r.capture.active, false); assert.equal(r.capture.listenerCount('frame'), 0);
  assert.equal(r.vad.listenerCount('speechStart'), 0);
  await r.voice.setEnabled(true); assert.equal(r.vad.listenerCount('speechStart'), 1);
});

test('replay: an explicitly interrupted ASR final is ignored, empty finals do no work', async t => {
  const sessions = [];
  const source = new FakeASR({ scripts:[['过期'], ['当前'], ['']] });
  const asr = { createSession(options) {
    const session = source.createSession(options); session.end = () => {};
    sessions.push(session); return session;
  } };
  const r = rig(t, { asr }); await r.voice.setEnabled(true);
  await r.ask(); r.voice.interrupt(); await r.ask();
  sessions[0].emit('final', { text:'过期' }); await tick(); assert.equal(r.starts.length, 0);
  sessions[1].emit('final', { text:'当前' }); await until(() => r.starts.length === 1);
  r.finish(); await until(() => r.voice.state === 'idle');
  await r.ask(); sessions[2].emit('final', { text:' ' }); await tick();
  assert.equal(r.starts.length, 1); assert.equal(r.voice.state, 'idle');
});

test('replay: disabling voice cancels the brain and drops late completion', async t => {
  const r = rig(t); await r.voice.setEnabled(true); await r.ask(); await until(() => r.starts.length === 1);
  await r.voice.setEnabled(false);
  assert.deepEqual(r.interrupts, ['turn-1']); assert.equal(r.capture.active, false);
  r.finish('迟到'); await tick(); assert.equal(r.playback.chunks.length, 0);
  const snapshot = r.voice.snapshot();
  assert.ok(snapshot.interruptedAt > 0, 'interruption remains visible after the coalesced idle update');
  assert.deepEqual(snapshot, { enabled:false, mode:'wake', held:false, state:'idle', level:0, levelAt:0, interruptedAt:snapshot.interruptedAt, error:null, partial:'', changing:false });
});

test('replay: cancel during first native thread creation prevents turn/start', async t => {
  const r = rig(t); let release;
  r.client.rpc.request = async method => {
    if (method === 'thread/start') return new Promise(resolve => { release = resolve; });
    assert.fail(`unexpected ${method}`);
  };
  await r.voice.setEnabled(true); await r.ask(); await until(() => !!release);
  await r.voice.setEnabled(false);
  release({ thread:{ id:'thread' } }); await until(() => !r.client.locked);
  assert.equal(r.client.task.status, 'idle'); assert.equal(r.interrupts.length, 0);
});

test('replay: stop during turn/start reuses deferred-ID interruption exactly once', async t => {
  let release;
  const r = rig(t, { request:(method) => method === 'turn/start' ? new Promise(resolve => { release = resolve; }) : {} });
  await r.voice.setEnabled(true); await r.ask(); await until(() => !!release);
  r.voice.interrupt(); assert.equal(r.client.task.status, 'stopping');
  assert.equal(r.interrupts.length, 0);
  release({ turn:{ id:'turn-1', status:'inProgress' } });
  await until(() => r.interrupts.length === 1); r.finish('', 'interrupted');
  assert.equal(r.playback.chunks.length, 0);
});

test('replay: failed brain turn is visible; voice never interrupts an unrelated task', async t => {
  const r = rig(t, { scripts:[['失败'], ['不能抢任务']] });
  await r.voice.setEnabled(true); await r.ask(); await until(() => r.starts.length === 1);
  r.finish('', 'failed'); await until(() => /大脑回合failed/.test(r.voice.error));
  r.client.task = { status:'running', turnId:'typed-turn' };
  await r.ask(); await until(() => /当前任务尚未结束/.test(r.voice.error));
  assert.equal(r.starts.length, 1); assert.equal(r.interrupts.length, 0);
  r.client.task.status = 'completed';
});

test('replay: manual stop resets VAD so continued speech can start a fresh session', async t => {
  const r = rig(t, { scripts:[['丢弃'], ['新一句']] }); await r.voice.setEnabled(true);
  r.capture.emit('frame', tone()); r.voice.interrupt();
  await r.ask(); await until(() => r.starts.length === 1);
  assert.equal(r.starts[0].text, '新一句'); r.finish();
  await until(() => r.voice.state === 'idle');
});

test('device failure closes capture, synthesis and pending brain without late output', async t => {
  const r = rig(t); await r.voice.setEnabled(true); await r.ask(); await until(() => r.starts.length === 1);
  r.capture.emit('error', new Error('麦克风断开'));
  await until(() => !r.voice.enabled && !r.voice.changing);
  assert.match(r.voice.error, /麦克风断开/); assert.equal(r.capture.active, false);
  r.finish('不能播'); await tick(); assert.equal(r.playback.chunks.length, 0);
});

test('startup failure rolls back and a later explicit enable can retry', async () => {
  const capture = new FakeCapture(), playback = new FakePlayback();
  let fails = true;
  capture.start = async () => { if (fails) throw new Error('没有麦克风'); capture.active = true; };
  const voice = new VoiceConversation({ capture, playback, brain:{ run:async () => '' }, providers:{ asr:new FakeASR(), tts:new FakeTTS(), vad:new FakeVAD() } });
  await assert.rejects(voice.setEnabled(true), /没有麦克风/);
  assert.equal(voice.enabled, false); assert.equal(capture.listenerCount('frame'), 0);
  fails = false; await voice.setEnabled(true); assert.equal(voice.enabled, true); await voice.close();
  await assert.rejects(voice.setEnabled('true'), /布尔值/);
});

test('disabling/closing during blocked microphone startup cancels promptly, queued starts stay cancelled', async () => {
  for (const closing of [false, true]) {
    const capture = new FakeCapture(), playback = new FakePlayback();
    let startupSignal, started;
    const entered = new Promise(resolve => { started = resolve; });
    capture.start = ({ signal }) => { startupSignal = signal; capture.active = true; started(); return new Promise(() => {}); };
    const voice = new VoiceConversation({ capture, playback, brain:{ run:async () => '' }, providers:{ asr:new FakeASR(), tts:new FakeTTS(), vad:new FakeVAD() } });
    const enabling = voice.setEnabled(true); await entered;
    const queued = voice.setEnabled(true);
    const disabled = closing ? voice.close() : voice.setEnabled(false);
    assert.equal(startupSignal.aborted, true);
    await Promise.all([enabling, queued, disabled]);
    assert.equal(capture.active, false); assert.equal(voice.enabled, false);
    assert.equal(capture.listenerCount('frame'), 0); assert.equal(voice.error, null);
    if (closing) await assert.rejects(voice.setEnabled(true), /已退出/);
    await voice.close();
  }
});

test('exact voice stop interrupts a typed task and waits for confirmation without sending another turn', async t => {
  const r = rig(t, { scripts:[['停止任务。']] });
  r.client.currentId = 'thread'; r.client.claimWriter(r.client.currentId); r.client.task = { status:'running', turnId:'typed' };
  await r.voice.setEnabled(true); await r.ask(); await until(() => r.interrupts.length === 1);
  assert.deepEqual(r.interrupts, ['typed']); assert.equal(r.starts.length, 0);
  assert.equal(r.playback.chunks.length, 0);
  r.finish('', 'interrupted', 'typed'); await until(() => r.voice.state === 'idle');
  assert.ok(r.playback.chunks.length > 0);
});

test('embedded stop words remain requests and never control an unrelated task', async t => {
  const r = rig(t, { scripts:[['在文件里写停止任务']] });
  r.client.task = { status:'running', turnId:'typed' };
  await r.voice.setEnabled(true); await r.ask(); await until(() => !!r.voice.error);
  assert.equal(r.interrupts.length, 0); assert.equal(r.starts.length, 0);
  r.client.task.status = 'completed';
});

test('task progress and approval speech run alongside the brain, then yield to the final reply', async t => {
  const source = new FakeTTS(), spoken = [], playback = new HeldPlayback();
  const tts = { synthesize(text, options) { spoken.push(text); return source.synthesize(text, options); } };
  const r = rig(t, { playback, tts });
  r.voice.config.progressIntervalMs = 0;
  await r.voice.setEnabled(true); await r.ask(); await until(() => r.starts.length === 1);
  r.client.notification({ method:'item/started', params:{ threadId:'thread', turnId:'turn-1', item:{ id:'tool', type:'mcpToolCall', status:'inProgress' } } });
  await until(() => playback.playing);
  assert.equal(r.client.task.status, 'running');
  assert.deepEqual(spoken, ['正在调用工具。']);
  r.client.changed(); assert.equal(spoken.length, 1);
  r.finish('最终回复'); await until(() => r.voice.state === 'idle');
  assert.equal(playback.signal.aborted, true);
  assert.deepEqual(spoken, ['正在调用工具。', '最终回复']);
  assert.equal(r.voice.error, null);
  assert.equal(r.client.listenerCount('change'), 0);
});

test('explicit stop timeout does not poison voice after manual recovery and waits for plan shutdown', async () => {
  const client = new EventEmitter();
  Object.assign(client, { busy:false, locked:false, orchestrator:{ active:true }, interrupt:async () => {}, send:async () => ({ turnId:'next' }), waitForTurn:async () => ({ status:'completed', text:'恢复' }) });
  const brain = new CodexVoiceBrain(client, { stopTimeoutMs:5 });
  await assert.rejects(brain.stop(), /停止尚未确认/);
  client.orchestrator.active = false;
  assert.equal(await brain.run('继续'), '恢复');
  brain.close();
});

test('approval waiting is narrated once without delaying the task', async t => {
  const source = new FakeTTS(), spoken = [];
  const r = rig(t, { tts:{ synthesize(text, options) { spoken.push(text); return source.synthesize(text, options); } } });
  await r.voice.setEnabled(true); await r.ask(); await until(() => r.starts.length === 1);
  r.client.serverRequest({ id:1, method:'item/commandExecution/requestApproval', params:{ threadId:'thread', turnId:'turn-1' } });
  await until(() => !r.voice.pipeline.output);
  r.client.changed();
  assert.deepEqual(spoken, ['需要你在界面确认操作，我会等待审批。']);
  assert.equal(r.client.task.status, 'running'); assert.equal(r.client.approvals.size, 1);
  r.finish('完成'); await until(() => r.voice.state === 'idle');
  assert.deepEqual(spoken, ['需要你在界面确认操作，我会等待审批。', '完成']);
});

test('client close during reconnect prevents a late process launch and is idempotent', async () => {
  const rpc = new EventEmitter(); let release, starts = 0, closes = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  Object.assign(rpc, { connected:false, stop:async () => { closes++; if (closes === 1) await blocked; }, start:async () => { starts++; } });
  const client = new Zhiwei({ rpc, dataDir:'.', workspace:'.' });
  const connecting = client.connect();
  const rejected = assert.rejects(connecting, /退出/);
  const closing = client.close(); assert.equal(client.close(), closing);
  release(); await Promise.all([rejected, closing]);
  assert.equal(starts, 0);
  await assert.rejects(client.connect(), /退出/);
  assert.throws(() => client.ready(), /退出/);
});

test('client close while handshake finishes closes the late connection and all resources', async () => {
  const rpc = new EventEmitter(); let release, entered, stops = 0, computerClosed = 0, memoryClosed = 0;
  const starting = new Promise(resolve => { entered = resolve; });
  Object.assign(rpc, { connected:false, stop:async () => { stops++; rpc.connected = false; }, start:async () => { entered(); await new Promise(resolve => { release = resolve; }); rpc.connected = true; } });
  const computer = new EventEmitter();
  Object.assign(computer, { cancel() {}, close:async () => { computerClosed++; } });
  const client = new Zhiwei({ rpc, computer, dataDir:'.', workspace:'.' });
  client.memory = { close() { memoryClosed++; } };
  const connecting = client.connect(); const rejected = assert.rejects(connecting, /退出/);
  await starting; const closing = client.close(); release(); await Promise.all([rejected, closing]);
  assert.equal(rpc.connected, false); assert.equal(computerClosed, 1); assert.equal(memoryClosed, 1);
  assert.ok(stops >= 2); assert.equal(client.reconnectTimer, undefined);
});

test('exact spoken stop uses native task stop; embedded stop words remain requests', async t => {
  const r = rig(t, { scripts:[['停止任务。'], ['请解释停止任务这四个字']] });
  let stopped = 0;
  r.voice.brain.stop = async () => { stopped++; };
  await r.voice.setEnabled(true); await r.ask();
  await until(() => r.voice.state === 'idle');
  assert.equal(stopped, 1); assert.equal(r.starts.length, 0);
  await r.ask(); await until(() => r.starts.length === 1);
  assert.equal(r.starts[0].text, '请解释停止任务这四个字');
  r.finish(); await until(() => r.voice.state === 'idle');
});

test('progress narration is bounded and gives way to the final reply', async t => {
  const texts = [], source = new FakeTTS(), playback = new HeldPlayback();
  const tts = { synthesize(text, options) { texts.push(text); return source.synthesize(text, options); } };
  const r = rig(t, { tts, playback });
  let finish;
  r.voice.brain.run = (_text, { onProgress }) => {
    onProgress('正在执行命令。'); onProgress('正在执行命令。');
    onProgress('正在搜索网页。');
    return new Promise(resolve => { finish = resolve; });
  };
  await r.voice.setEnabled(true); await r.ask();
  await until(() => playback.playing);
  finish('最终回答'); await until(() => r.voice.state === 'idle');
  assert.deepEqual(texts, ['正在执行命令。', '最终回答']);
  assert.equal(playback.signal.aborted, true);
});

test('failed spoken stop does not permanently block a later recovered conversation', async () => {
  const client = new EventEmitter();
  Object.assign(client, { busy:false, locked:false, orchestrator:{ active:false },
    interrupt:() => { throw new Error('停止失败'); },
    send:async () => ({ turnId:'recovered' }),
    waitForTurn:async () => ({ status:'completed', text:'已恢复' }) });
  const brain = new CodexVoiceBrain(client);
  await assert.rejects(brain.stop(), /停止失败/);
  await tick();
  assert.equal(await brain.run('继续'), '已恢复');
  assert.equal(client.listenerCount('change'), 0);
  brain.close();
});

test('real microphone with no key or a removed provider is rejected before capture', async t => {
  const previous = process.env.DASHSCOPE_API_KEY;
  delete process.env.DASHSCOPE_API_KEY;
  t.after(() => {
    if (previous === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = previous;
  });
  for (const [provider, expected] of [['dashscope', /DASHSCOPE_API_KEY/], ['windows', /语音提供方未配置/]]) {
    const capture = new FakeCapture(), playback = new FakePlayback();
    let starts = 0; capture.start = async () => { starts++; };
    const voice = new VoiceConversation({ capture, playback, brain:{ close() {} }, config:{ audio:'windows', provider, asr:provider, tts:provider } });
    assert.equal(voice.snapshot().availability.ready, false);
    await assert.rejects(voice.setEnabled(true), expected);
    assert.equal(starts, 0); assert.equal(voice.enabled, false);
    assert.equal(capture.listenerCount('frame'), 0);
    await voice.close();
  }
});

test('shutdown releases Windows tools and memory even after session persistence fails', async () => {
  const rpc = new EventEmitter(), computer = new EventEmitter();
  let computerClosed = 0, memoryClosed = 0;
  Object.assign(rpc, { connected:false, stop:async () => {} });
  Object.assign(computer, { cancel() {}, close:async () => { computerClosed++; } });
  const client = new Zhiwei({ rpc, computer, dataDir:'.', workspace:'.' });
  client.memory = { close() { memoryClosed++; } };
  client.sessions.queue = Promise.reject(new Error('session write failure'));
  await assert.rejects(client.close(), /session write failure/);
  assert.equal(computerClosed, 1); assert.equal(memoryClosed, 1);
  assert.equal(client.memory, null);
});

test('injected fake devices without audio config can cancel startup and close without readiness', { timeout:1000 }, async t => {
  for (const closing of [false, true]) {
    const capture = new FakeCapture(), playback = new FakePlayback(), rpc = new EventEmitter();
    let entered, startupSignal;
    const started = new Promise(resolve => { entered = resolve; });
    capture.start = ({ signal }) => { startupSignal = signal; entered(); return new Promise(() => {}); };
    Object.assign(rpc, { connected:true, stop:async () => {} });
    const client = new Zhiwei({ rpc, workspace:'.', dataDir:'.', voiceOptions:{ capture, playback,
      config:{ provider:'fake', asr:'fake', tts:'fake', vad:'fake' } } });
    t.after(() => client.close());
    const enabling = client.voice.setEnabled(true);
    // Surface a configuration rejection instead of hanging on an unbounded enabled poll.
    await Promise.race([started, enabling.then(() => assert.fail('microphone startup unexpectedly settled'))]);
    assert.equal(client.voice.enabled, true);
    const stopping = closing ? client.close() : client.voice.setEnabled(false);
    await Promise.all([enabling, stopping]);
    assert.equal(startupSignal.aborted, true);
    assert.equal(client.voice.enabled, false);
    assert.equal(client.voice.error, null);
    assert.equal(capture.listenerCount('frame'), 0);
  }
});

test('real microphone cannot start with fake recognition and reports configuration honestly', async () => {
  const capture = new FakeCapture(), playback = new FakePlayback();
  let starts = 0; capture.start = async () => { starts++; };
  const voice = new VoiceConversation({ capture, playback, brain:{close(){}},
    config:{ audio:'windows', asr:'fake', tts:'fake' } });
  assert.equal(voice.snapshot().availability.ready, false);
  await assert.rejects(voice.setEnabled(true), /测试识别/);
  assert.equal(starts, 0); assert.equal(voice.enabled, false);
  assert.equal(capture.listenerCount('frame'), 0);
  await voice.close();
});

test('complete speech sentences start before Codex turn completion and are not spoken twice',async t=>{
  const texts=[],tts=new FakeTTS(),synthesize=tts.synthesize.bind(tts);
  tts.synthesize=(text,options)=>{texts.push(text);return synthesize(text,options);};
  const r=rig(t,{tts});await r.voice.setEnabled(true);await r.ask();await until(()=>r.starts.length===1);
  const turnId=r.starts[0].id;
  r.client.notification({method:'item/agentMessage/delta',params:{threadId:'thread',turnId,itemId:`answer-${turnId}`,delta:'你好。后半句'}});
  await until(()=>texts.length===1);assert.equal(texts[0],'你好。');assert.equal(r.client.task.status,'running');
  r.finish('你好。后半句');await until(()=>texts.length===2);assert.deepEqual(texts,['你好。','后半句']);
});
