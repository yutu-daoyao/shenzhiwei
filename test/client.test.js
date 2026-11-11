import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter, once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { AppServer } from '../src/codex/process.js';
import { Sessions } from '../src/codex/sessions.js';
import { Zhiwei } from '../src/client.js';
import { start } from '../src/main.js';

const fixture = fileURLToPath(new URL('./fixtures/mock-server.mjs', import.meta.url));
function rpc(mode = 'normal', timeout = 5000, cwd) { return new AppServer({ command: process.execPath, args: [fixture, mode], timeout, cwd }); }
async function until(predicate, milliseconds = 5000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) { if (predicate()) return; await delay(10); }
  assert.fail('等待状态超时');
}
async function clientFor(t, mode) {
  const directory = await mkdtemp(path.join(tmpdir(), 'zhiwei-test-'));
  const client = new Zhiwei({ workspace: directory, dataDir: path.join(directory, 'data'), rpc: rpc(mode, 5000, directory) });
  t.after(() => client.close());
  await client.init(); return client;
}

test('restored native voice messages show the spoken input without protocol or transcript context', () => {
  const client = new Zhiwei({ rpc:new EventEmitter(), workspace:'.', dataDir:'.' });
  const text = '<realtime_delegation>\n  <input>拜拜，下次聊。</input>\n  <transcript_delta>user: 帮我导航\nassistant: 好的</transcript_delta>\n</realtime_delegation>';
  client.upsert({ id:'voice', type:'userMessage', content:[{type:'text',text}] }, 'turn', true);
  assert.equal(client.items.get('voice').text, '拜拜，下次聊。');
  for (const text of ['请解释 <input> 标签', '<realtime_delegation><input>未完整关闭']) {
    client.upsert({ id:'typed', type:'userMessage', content:[{type:'text',text}] }, 'turn', true);
    assert.equal(client.items.get('typed').text, text);
  }
});

test('close during native startup stops the late child and does not reconnect', async () => {
  const rpc = new EventEmitter(); let release, starts = 0, stops = 0;
  Object.assign(rpc, { connected:false,
    start:async () => { starts++; await new Promise(resolve => { release = resolve; }); rpc.connected = true; },
    stop:async () => { stops++; rpc.connected = false; } });
  const client = new Zhiwei({ rpc, workspace:'.', dataDir:'.' });
  const connecting = assert.rejects(client.connect(), /正在退出/);
  await until(() => !!release);
  const closing = client.close();
  release(); await connecting; await closing;
  assert.equal(starts, 1); assert.equal(rpc.connected, false); assert.ok(stops >= 2);
  rpc.emit('disconnected', 'late exit');
  assert.equal(client.reconnectTimer, undefined);
  await assert.rejects(client.connect(), /正在退出/);
});

test('shutdown closes memory even when the owned App Server cannot stop', async () => {
  const rpc = new EventEmitter();
  Object.assign(rpc, { connected:false, stop:async () => { throw new Error('stop failure'); } });
  const client = new Zhiwei({ rpc, workspace:'.', dataDir:'.' });
  let closed = 0; client.memory = { close() { closed++; } };
  await assert.rejects(client.close(), /stop failure/);
  assert.equal(closed, 1); assert.equal(client.memory, null);
});

test('stdio handshake, response IDs, fragmented UTF-8, RPC error and timeout', async t => {
  const server = rpc(); t.after(() => server.stop());
  await server.start();
  assert.deepEqual(server.account, { type: 'chatgpt', planType: 'plus' });
  const values = await Promise.all([server.request('test/echo', { number: 1, delay: 30 }), server.request('test/echo', { number: 2, delay: 1 })]);
  assert.deepEqual(values.map(v => v.number), [1, 2]);
  assert.equal(await server.request('test/unicode', {}), '知微🙂分段');
  await assert.rejects(server.request('test/error', {}), /fixture failure/);
  await assert.rejects(server.request('test/timeout', {}, 40), /超时/);
  assert.equal(server.pending.size, 0);
});
test('missing CLI, failed startup, auth rejection, malformed protocol, startup timeout', async () => {
  const missing = new AppServer({ command: path.join(tmpdir(), 'zhiwei-nonexistent-executable'), args: [], timeout: 200 });
  await assert.rejects(missing.start(), /启动失败|退出/); await missing.stop();
  for (const [mode, pattern] of [['no-login', /尚未登录/], ['api-key', /禁止 API/], ['bad-json', /无效 JSON/], ['startup-timeout', /超时/]]) {
    const server = rpc(mode, mode === 'startup-timeout' ? 200 : 5000);
    await assert.rejects(server.start(), pattern); await server.stop();
    assert.equal(server.connected, false);
  }
});
test('stream replacement, duplicate-send guard, hidden reasoning filtering, metadata persistence and resume', async t => {
  const client = await clientFor(t);
  const { id } = await client.newThread();
  const sending = client.send('你好');
  await assert.rejects(client.send('duplicate'), /重复点击/);
  await sending;
  await until(() => client.task.status === 'completed');
  const state = client.snapshot();
  assert.equal(state.items.filter(i => i.type === 'agentMessage').map(i => i.text).join(''), '你好');
  assert.ok(!JSON.stringify(state).includes('DO_NOT_EXPOSE'));
  assert.ok(!JSON.stringify(state).includes('PRIVATE_ACCOUNT'));
  const stored = JSON.parse(await readFile(client.sessions.file, 'utf8'));
  assert.equal(stored[0].id, id);
  assert.deepEqual(Object.keys(stored[0]).sort(), ['createdAt', 'id', 'title', 'updatedAt']);
  const reopened = new Sessions(client.sessions.directory); await reopened.load(); assert.equal(reopened.entries[0].id, id);
  await client.resume(id); assert.ok(client.snapshot().items.some(i => i.text === '历史回复'));
  assert.ok(!JSON.stringify(client.snapshot()).includes('DO_NOT_EXPOSE'));
  client.sessions.entries.push({ id: 'missing', title: 'lost', createdAt: 'x', updatedAt: 'x' });
  await assert.rejects(client.resume('missing'), /恢复失败/);
  assert.equal(client.currentId, id);
});
test('first message creates one native Thread under the same duplicate-send lock',async t=>{
  const client=await clientFor(t),request=client.rpc.request.bind(client.rpc),calls=[];
  client.rpc.request=(method,...args)=>{calls.push(method);return request(method,...args);};
  const first=client.send('第一条消息');await assert.rejects(client.send('duplicate'),/重复点击/);await first;
  await until(()=>client.task.status==='completed');
  const id=client.currentId;assert.ok(id);assert.equal(client.sessions.entries.length,1);
  assert.deepEqual(calls.filter(m=>['thread/start','turn/start'].includes(m)),['thread/start','turn/start']);
  await client.send('第二条消息');await until(()=>client.task.status==='completed');assert.equal(client.currentId,id);assert.equal(calls.filter(m=>m==='thread/start').length,1);
  client.needsResume=true;await assert.rejects(client.send('must resume'),/先恢复/);assert.equal(calls.filter(m=>m==='turn/start').length,2);
});

test('restart restores the last selected conversation for typed, Bailian and native voice rounds without another thread', async t => {
  const first = await clientFor(t);
  const { id } = await first.newThread();
  await first.newThread();
  await first.resume(id);
  await first.close();
  const second = new Zhiwei({ workspace:first.workspace, dataDir:first.dataDir, rpc:rpc() });
  t.after(() => second.close());
  const request = second.rpc.request.bind(second.rpc), calls = [];
  second.rpc.request = async (method, params, ...args) => {
    calls.push({ method, params });
    if (method === 'thread/realtime/start') {
      queueMicrotask(() => second.notification({ method:'thread/realtime/sdp', params:{ threadId:id, sdp:'v=0\r\nanswer' } }));
      return {};
    }
    if (method === 'thread/realtime/stop') return {};
    return request(method, params, ...args);
  };
  await second.init();
  assert.equal(second.currentId, id); assert.equal(second.needsResume, false);
  assert.ok(second.snapshot().items.some(item => item.text === '历史回复'));
  assert.equal(calls.filter(c => c.method === 'turn/start').length, 0, 'startup reads history without replaying work');
  await second.send('继续这段对话'); await until(() => second.task.status === 'completed');
  assert.equal(await second.voice.brain.run('百炼语音继续这段对话'), '你好');
  const session = await second.realtime.start('v=0', { captionEngine:'local' });
  assert.equal(second.realtime.threadId, id); await second.realtime.stop(session.session);
  assert.equal(calls.filter(c => c.method === 'thread/start').length, 0);
  assert.ok(calls.filter(c => ['turn/start','thread/realtime/start'].includes(c.method)).every(c => c.params.threadId === id));
});

test('failed startup restore preserves the original conversation and blocks silent replacement', async t => {
  const first = await clientFor(t);
  await first.sessions.put({ id:'missing', title:'保留的对话', createdAt:'2026-01-01', updatedAt:'2026-01-01' });
  await first.close();
  const second = new Zhiwei({ workspace:first.workspace, dataDir:first.dataDir, rpc:rpc() });
  t.after(() => second.close());
  await second.init();
  assert.equal(second.currentId, 'missing'); assert.equal(second.needsResume, true);
  await assert.rejects(second.send('不要另建对话'), /恢复/);
  await assert.rejects(second.realtime.start('v=0'), /恢复/);
  assert.equal(second.sessions.entries.length, 1); assert.equal(second.currentId, 'missing');
});

test('startup skips an unused draft and waits for explicit retry after an active writer conflict', async t => {
  const first = await clientFor(t);
  await first.sessions.put({ id:'saved', title:'上一段对话', createdAt:'2026-01-01', updatedAt:'2026-01-01' });
  const {id:draft} = await first.newThread();
  await first.close();

  const second = new Zhiwei({ workspace:first.workspace, dataDir:first.dataDir, rpc:rpc() });
  t.after(() => second.close());
  const request = second.rpc.request.bind(second.rpc), attempts = [];
  let occupied = true;
  second.rpc.request = (method, params, ...args) => {
    assert.notEqual(method, 'thread/start');
    assert.notEqual(method, 'turn/start');
    if (method === 'thread/resume') {
      attempts.push(params.threadId);
      if (params.threadId === draft) throw Object.assign(new Error(`no rollout found for thread id ${draft}`),{rpcCode:-32600});
      if (occupied) throw Object.assign(new Error('thread saved already has an active writer'),{rpcCode:-32600});
    }
    return request(method, params, ...args);
  };
  await second.init();
  assert.equal(second.currentId, 'saved');
  assert.equal(second.needsResume, true);
  assert.match(second.error, /另一个 Codex 客户端占用/);
  assert.equal(second.snapshot().sessionConflict.threadId, 'saved');
  assert.deepEqual(attempts, [draft, 'saved']);
  await assert.rejects(second.send('不会写入被占用的会话'), /未返回客户端名称/);
  occupied = false;
  await second.resume(second.snapshot().sessionConflict.threadId);
  assert.deepEqual(attempts, [draft, 'saved', 'saved']);
  assert.equal(second.currentId, 'saved');
  assert.equal(second.needsResume, false);
  assert.equal(second.sessions.entries.length, 2);
});

test('idle Codex writer is released; conflict keeps original items and only a new owned chat can write', async t => {
  const client = await clientFor(t);
  const {turnId} = await client.send('测试原对话');
  await client.waitForTurn(turnId);
  const original = client.currentId, transcript = client.snapshot().items;
  await until(() => !client.ownsWriter() && !client.locked, 4000);
  const request = client.rpc.request.bind(client.rpc), calls = [];
  client.rpc.request = (method, params, ...options) => {
    calls.push([method, params?.threadId]);
    if (method === 'thread/resume' && params.threadId === original) {
      throw Object.assign(new Error('thread '+original+' already has an active writer'), {rpcCode:-32600});
    }
    return request(method, params, ...options);
  };
  await assert.rejects(client.send('等会再发'), /稍后重试/);
  await assert.rejects(client.runPlan('不会在原对话创建计划'), /稍后重试/);
  assert.equal(client.currentId, original);
  assert.deepEqual(client.snapshot().items, transcript);
  assert.deepEqual(calls, [['thread/resume', original]]);
  assert.equal(client.snapshot().sessionConflict.threadId, original);
  const {id:newId} = await client.newThread();
  assert.notEqual(newId, original);
  assert.ok(client.sessions.entries.some(entry => entry.id === original && entry.title === '测试原对话'));
  assert.equal(client.snapshot().sessionConflict, null);
  await client.send('在新对话继续');
  assert.deepEqual(calls.slice(1), [['thread/start', undefined], ['turn/start', newId]]);
});
test('restart releases only an explicitly unused Codex draft when its rollout is missing', async t => {
  const first = await clientFor(t);
  const {id} = await first.newThread();
  await first.close();

  const reopen = async () => {
    const second = new Zhiwei({workspace:first.workspace, dataDir:first.dataDir, rpc:rpc()});
    t.after(() => second.close());
    const request = second.rpc.request.bind(second.rpc);
    second.rpc.request = async (method, params, ...args) => {
      if (method === 'thread/resume') {
        assert.equal(params.threadId,id);
        throw Object.assign(new Error(`no rollout found for thread id ${id}`),{rpcCode:-32600});
      }
      assert.notEqual(method,'turn/start','recovery must not replay any turn');
      assert.notEqual(method,'thread/start','recovery must not create a replacement');
      return request(method,params,...args);
    };
    await second.init();
    return second;
  };

  const draft = await reopen();
  assert.equal(draft.currentId,null);
  assert.equal(draft.needsResume,false);
  assert.equal(draft.sessions.entries[0].id,id);
  const {draft:unused,...used}=draft.sessions.entries[0];
  assert.equal(unused,true);
  await draft.sessions.put(used);
  await draft.close();

  const usedSession = await reopen();
  assert.equal(usedSession.currentId,id);
  assert.equal(usedSession.needsResume,true);
  assert.equal(usedSession.snapshot().missingSession,true);
  assert.match(usedSession.error,/新建对话继续/);
});

test('failed first-thread creation or persistence does not send a turn or select an unsaved session',async t=>{
  const client=await clientFor(t),request=client.rpc.request.bind(client.rpc),put=client.sessions.put.bind(client.sessions);let failRpc=true,turns=0,threads=0;
  client.rpc.request=(method,...args)=>{if(method==='turn/start')turns++;if(method==='thread/start'){threads++;if(failRpc)throw new Error('fixture thread failure');}return request(method,...args);};
  await assert.rejects(client.send(' '),/请输入/);assert.equal(threads,0);
  await assert.rejects(client.send('keep my message'),/thread failure/);assert.ok(!client.currentId);assert.equal(turns,0);assert.equal(client.task.status,'idle');
  failRpc=false;client.sessions.put=async()=>{throw new Error('fixture disk failure');};
  await assert.rejects(client.send('keep my message'),/disk failure/);assert.ok(!client.currentId);assert.equal(turns,0);assert.equal(client.sessions.entries.length,0);
  client.sessions.put=put;await client.send('retry explicitly');await until(()=>client.task.status==='completed');assert.equal(turns,1);assert.equal(client.sessions.entries.length,1);
});

test('official interrupt confirms interrupted and allows next turn', async t => {
  const client = await clientFor(t, 'slow'); await client.newThread(); await client.send('safe task');
  await assert.rejects(client.send('duplicate'), /正在执行/);
  await client.interrupt(); await until(() => client.task.status === 'interrupted');
  assert.ok(client.snapshot().items.some(i => i.type === 'tool' && !i.text.endsWith('inProgress')));
  await client.send('next'); await client.interrupt();
  await until(() => client.task.status === 'interrupted');
});
test('Windows fallback ends only the owned process tree when native interrupt leaves a command alive', { skip: process.platform !== 'win32' }, async t => {
  const client = await clientFor(t, 'lingering'); await client.newThread(); await client.send('lingering command');
  await until(() => client.runningCommands.size > 0);
  await client.interrupt();
  await until(() => client.task.status === 'interrupted' && client.connection === 'connected' && !client.stopRequest?.escalating);
  assert.equal(client.task.status, 'interrupted'); assert.equal(client.connection, 'connected');
  assert.ok(client.logs.some(l => l.message.includes('所属进程树已结束')));
  await delay(4200);
  await assert.rejects(access(path.join(client.workspace, 'mock-interrupt-sentinel.txt')), error => error.code === 'ENOENT');
  await client.send('next turn');
  await until(() => client.runningCommands.size > 0);
  await client.close();
  await delay(4200);
  await assert.rejects(access(path.join(client.workspace, 'mock-interrupt-sentinel.txt')), error => error.code === 'ENOENT');
});
test('native approval waits for explicit user decision; unsupported request grants no permissions', async t => {
  const client = await clientFor(t, 'approval'); await client.newThread(); await client.send('approval');
  await until(() => client.approvals.size === 1);
  assert.throws(() => client.approve('approval-1', 'acceptForSession'), /无效/);
  client.approve('approval-1', 'decline'); assert.equal(client.approvals.size, 0);
  assert.throws(() => client.approve('approval-1', 'accept'), /失效/);
  await client.interrupt();
});
test('turn failure is visible; uncertain send timeout stays blocked until native resume', async t => {
  const failed = await clientFor(t, 'turn-failed'); await failed.newThread(); await failed.send('network');
  await until(() => failed.task.status === 'failed'); assert.match(failed.error, /网络连接失败/);
  const timed = await clientFor(t, 'turn-timeout'); await timed.newThread(); timed.rpc.timeout = 100;
  await assert.rejects(timed.send('timeout'), /超时/); assert.equal(timed.task.status, 'unknown');
  await assert.rejects(timed.send('do not replay'), /正在执行/);
  await timed.resume(timed.currentId); assert.equal(timed.task.status, 'idle');
});
test('unexpected exit rejects pending calls and reconnects once without replaying a task', async t => {
  const client = await clientFor(t, 'slow'); await client.newThread(); await client.send('long');
  const disconnected = once(client.rpc, 'disconnected');
  const pending = client.rpc.request('test/timeout', {});
  const rejected = assert.rejects(pending, /退出/);
  await client.rpc.request('test/exit', {}); await disconnected; await rejected;
  assert.equal(client.task.status, 'unknown');
  await until(() => client.connection === 'connected', 7000);
  assert.equal(client.needsResume, true);
  await assert.rejects(client.send('do not replay'), /恢复/);
  await client.resume(client.currentId); assert.equal(client.needsResume, false);
});
test('atomic metadata writes serialize; corrupt file is preserved', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'zhiwei-store-')); const store = new Sessions(directory); await store.load();
  await Promise.all(Array.from({ length: 12 }, (_, n) => store.put({ id: String(n), title: String(n), createdAt: 'x', updatedAt: 'x' })));
  assert.equal(JSON.parse(await readFile(store.file, 'utf8')).length, 12);
  await writeFile(store.file, '{broken'); const broken = new Sessions(directory);
  await assert.rejects(broken.load(), /不会覆盖/);
  assert.equal(await readFile(store.file, 'utf8'), '{broken');
});
test('loopback HTTP: origin/Host/CSRF validation, malformed inputs, streaming snapshot', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'zhiwei-http-'));
  const app = await start({ port: 0, workspace: directory, dataDir: path.join(directory, 'data'), rpc: rpc() });
  t.after(() => app.close()); await app.ready;
  assert.equal(app.server.address().address, '127.0.0.1');
  const stateResponse = await fetch(`${app.origin}/api/state`); const state = await stateResponse.json();
  assert.equal(state.connection, 'connected');
  assert.match(stateResponse.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const approvalModule=await fetch(`${app.origin}/approval-view.js`);assert.equal(approvalModule.status,200);assert.match(approvalModule.headers.get('content-type'),/javascript/);assert.match(await approvalModule.text(),/export function approvalView/);
  const cross = await fetch(`${app.origin}/api/state`, { headers: { Origin: 'https://evil.invalid' } }); assert.equal(cross.status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(`${app.origin}/api/state`, { headers: { Host: 'evil.invalid' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(badHostStatus, 403);
  const headers = { Origin: app.origin, 'Content-Type': 'application/json', 'X-Zhiwei-CSRF': state.csrf };
  assert.equal((await fetch(`${app.origin}/api/new`, { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await fetch(`${app.origin}/api/new`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.invalid' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${app.origin}/api/new`, { method: 'POST', headers, body: '{bad' })).status, 400);
  assert.equal((await fetch(`${app.origin}/api/new`, { method: 'POST', headers, body: '{}' })).status, 200);
  assert.equal((await fetch(`${app.origin}/api/send`, { method: 'POST', headers, body: JSON.stringify({ text: '中文🙂' }) })).status, 200);
  await until(() => app.client.task.status === 'completed');
  const controller = new AbortController();
  const eventResponse = await fetch(`${app.origin}/api/events`, { signal: controller.signal });
  const reader = eventResponse.body.getReader();
  const { value } = await reader.read(); const eventText = new TextDecoder().decode(value);
  assert.ok(eventText.includes('中文🙂')); assert.ok(!eventText.includes('DO_NOT_EXPOSE'));
  await reader.cancel(); controller.abort();
  assert.equal((await fetch(`${app.origin}/../package.json`)).status, 404);
});

// Stop lifecycle tests use an in-memory RPC; no listener or process termination.
function stopClient(t, request) {
  const server = new EventEmitter();
  Object.assign(server, { connected: true, request, stop: async () => {}, terminateOwnedTree: async () => {} });
  const computer = new EventEmitter();
  Object.assign(computer, { cancelled: 0, beginTurn() {}, expectInvocation() {}, cancel() { this.cancelled++; }, endTurn() { this.cancel(); }, close: async () => {} });
  const client = new Zhiwei({ dataDir: path.join(tmpdir(), 'zhiwei-stop-mock'), rpc: server, computer, stopTimeout: 15, commandStopTimeout: 10, interruptTimeout: 30 });
  client.currentId = 'thread';
  client.claimWriter('thread');
  client.sessions.entries = [{ id: 'thread', title: 'test' }];
  client.sessions.put = async () => {};
  t.after(() => client.close());
  return client;
}
function finishStop(client, status = 'interrupted') {
  client.notification({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status, items: [] } } });
}

test('stop during starting interrupts once when either response or notification supplies the ID', async t => {
  for (const source of ['response', 'notification']) {
    let resolveStart, interrupts = 0;
    const client = stopClient(t, async method => {
      if (method === 'turn/start') return new Promise(resolve => { resolveStart = resolve; });
      if (method === 'turn/interrupt') { interrupts++; finishStop(client); return {}; }
    });
    const sending = client.send('start');
    assert.equal(client.task.status, 'starting');
    await client.interrupt(); await client.interrupt();
    assert.ok(client.computer.cancelled >= 1);
    assert.equal(interrupts, 0);
    if (source === 'notification') client.notification({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn' } } });
    resolveStart({ turn: { id: 'turn', status: 'inProgress' } });
    await sending;
    await until(() => client.task.status === 'interrupted');
    await client.interrupt();
    assert.equal(interrupts, 1);
    assert.match(client.logs.at(-1).message, /任务已结束/);
  }
});

test('stopping during the project attachment read does not send a Codex turn', async t => {
  const calls = [];
  const client = stopClient(t, async method => { calls.push(method); return {}; });
  let resolveContext;
  client.projectContext = () => new Promise(resolve => { resolveContext = resolve; });
  const sending = assert.rejects(client.send('start'), /发送前停止/);
  assert.equal(client.task.status, 'starting');
  await client.interrupt();
  resolveContext('项目台账');
  await sending;
  assert.equal(client.task.status, 'interrupted');
  assert.deepEqual(calls, []);
});

test('stop watchdog escalates once, reconnects and resumes; unsupported termination stays unknown', async t => {
  for (const unsupported of [false, true]) {
    let interrupts = 0, kills = 0, connects = 0, resumes = 0;
    const client = stopClient(t, async () => { interrupts++; return {}; });
    client.task = { status: 'running', turnId: 'turn' };
    client.rpc.terminateOwnedTree = async () => { kills++; if (unsupported) throw new Error('此平台未实现进程树终止'); };
    client.connect = async () => { connects++; };
    client.resume = async id => { assert.equal(id, 'thread'); resumes++; };
    await Promise.all([client.interrupt(), client.interrupt()]);
    await client.interrupt();
    await until(() => client.task.status === (unsupported ? 'unknown' : 'interrupted'));
    await client.interrupt(); await delay(30);
    assert.equal(interrupts, 1); assert.equal(kills, 1);
    assert.equal(connects, unsupported ? 0 : 1); assert.equal(resumes, connects);
    assert.ok(client.logs.some(l => l.message.includes(unsupported ? '此平台未实现' : '任务已强制中断')));
    client.task.status = 'idle';
  }
});

test('lingering command escalates once despite native completion and repeated stop', async t => {
  let kills = 0, interrupts = 0;
  const client = stopClient(t, async () => { interrupts++; finishStop(client); return {}; });
  client.task = { status: 'running', turnId: 'turn' };
  client.runningCommands.add('cmd');
  client.rpc.terminateOwnedTree = async () => { kills++; };
  client.connect = async () => {};
  client.resume = async () => {};
  const stopping = client.interrupt(); await client.interrupt(); await stopping;
  await delay(30); await client.interrupt();
  assert.equal(kills, 1); assert.equal(interrupts, 1);
  assert.equal(client.task.status, 'interrupted'); assert.equal(client.runningCommands.size, 0);
});

test('interrupt cancels Windows actions and completion finalizes MCP and fileChange items', async t => {
  const client = stopClient(t, async () => { finishStop(client); return {}; });
  client.task = { status: 'running', turnId: 'turn' };
  for (const type of ['mcpToolCall', 'fileChange']) client.notification({ method: 'item/started', params: {
    threadId: 'thread', turnId: 'turn', item: { id: type, type, server: 'zhiwei_windows', status: 'inProgress' },
  } });
  await client.interrupt();
  assert.ok(client.computer.cancelled >= 2);
  assert.equal(client.task.status, 'interrupted');
  for (const item of client.items.values()) { assert.match(item.text, /已中断/); assert.ok(client.completed.has(item.id)); }
});

for (const outcome of ['finished', 'running', 'failure', 'blocked']) test(`late interrupted completion re-checks command: ${outcome}`, async t => {
  let kills = 0, connects = 0, resumes = 0, release;
  const client = stopClient(t, async () => ({}));
  client.stopTimeout = 200;
  client.task = { status: 'running', turnId: 'turn' };
  await client.interrupt(); // performInterrupt has returned before the command notification.
  assert.equal(client.stopRequest.completed, false);
  const command = method => client.notification({ method, params: { threadId: 'thread', turnId: 'turn', item: { id: 'late-command', type: 'commandExecution', status: method === 'item/started' ? 'inProgress' : 'completed' } } });
  command('item/started');
  client.rpc.terminateOwnedTree = async () => {
    kills++;
    if (outcome === 'failure') throw new Error('fixture termination failed');
    if (outcome === 'blocked') await new Promise(resolve => { release = resolve; });
  };
  client.connect = async () => { connects++; };
  client.resume = async id => { assert.equal(id, 'thread'); resumes++; };
  finishStop(client);
  assert.equal(client.task.status, 'stopping');
  if (outcome === 'finished') command('item/completed');
  if (outcome === 'blocked') {
    await until(() => !!release);
    await client.interrupt(); await client.interrupt();
    assert.equal(kills, 1); assert.equal(connects, 0);
    assert.equal(client.task.status, 'stopping');
    release();
  }
  await until(() => client.task.status === (outcome === 'failure' ? 'unknown' : 'interrupted'));
  assert.equal(kills, outcome === 'finished' ? 0 : 1);
  assert.equal(connects, ['running', 'blocked'].includes(outcome) ? 1 : 0);
  assert.equal(resumes, connects);
  if (outcome === 'failure') assert.match(client.error, /fixture termination failed/);
  else assert.equal(client.runningCommands.size, 0);
  client.task.status = 'idle';
});

test('memory thread options merge on Linux and Windows; completed turns record once', async t => {
  const { openMemory } = await import('../src/memory/store.js');
  const directory = await mkdtemp(path.join(tmpdir(), 'zhiwei-memory-client-'));
  const client = stopClient(t, async () => ({ turn: { id: 'memory-turn', status: 'inProgress' } }));
  client.memory = await openMemory(directory);
  const complete = () => client.notification({ method: 'turn/completed', params: { threadId: client.currentId, turn: { id: 'memory-turn', status: 'completed', items: [{ id: 'reply', type: 'agentMessage', text: '你好' }] } } });
  client.memory.setPreference('语言', '中文');
  let options = client.threadOptions();
  assert.equal(options.config.mcp_servers.zhiwei_memory.command, process.execPath);
  assert.equal(options.config.mcp_servers.zhiwei_memory.env.ZHIWEI_MEMORY_DB, client.memory.file);
  assert.match(options.developerInstructions, /关于用户的长期记忆/);
  assert.match(options.developerInstructions, /语言：中文/);
  client.computer = { url: 'fixture', config: () => ({ other: true, mcp_servers: { zhiwei_windows: { command: 'fixture' } } }) };
  options = client.threadOptions();
  assert.equal(options.config.other, true);
  assert.equal(options.config.mcp_servers.zhiwei_windows.command, 'fixture');
  assert.ok(options.config.mcp_servers.zhiwei_memory);
  client.computer = null;
  await client.send('记住这个任务'); complete();
  const task = client.memory.recentTasks(1)[0];
  assert.equal(task.request, '记住这个任务'); assert.equal(task.outcome, '你好');
  assert.equal(task.status, 'completed'); assert.equal(task.threadId, client.currentId);
  client.notification({ method: 'turn/completed', params: { threadId: client.currentId, turn: { id: task.turnId, status: 'completed' } } });
  assert.equal(client.memory.recentTasks().length, 1);
  client.memory.contextSummary = () => { throw new Error('fixture read'); };
  assert.doesNotThrow(() => client.threadOptions());
  client.memory.recordTask = () => { throw new Error('fixture write'); };
  await client.send('继续'); complete();
  assert.ok(client.logs.some(log => log.message.includes('长期记忆写入失败')));
});

test('native voice task attaches only this round screen image without replacing the user request',async t=>{
  const client=await clientFor(t),calls=[],request=client.rpc.request.bind(client.rpc);
  client.rpc.request=(method,params,...rest)=>{if(method==='turn/start')calls.push(params);return request(method,params,...rest);};
  await client.send('把当前段落改正式一点',undefined,{screenContext:{title:'测试文档',text:'当前段落',image:'data:image/jpeg;base64,AAA='}});
  const input=calls[0].input;
  assert.equal(input[0].text,'把当前段落改正式一点');
  assert.ok(input.some(item=>item.type==='text'&&item.text.includes('只供参考')));
  assert.deepEqual(input.find(item=>item.type==='image'),{type:'image',url:'data:image/jpeg;base64,AAA='});
  assert.ok(!JSON.stringify(client.snapshot()).includes('AAA='));
});
