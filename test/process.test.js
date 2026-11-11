import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { AppServer } from '../src/codex/process.js';

test('Windows graceful stop clears its timer without killing the tree', async t => {
  t.mock.timers.enable({ apis:['setTimeout'] });
  const server = new AppServer({ platform:'win32' }), child = new EventEmitter();
  child.stdin = { end() { child.emit('close', 0); } };
  server.child = child;
  server.terminateOwnedTree = () => assert.fail('graceful exit must not force termination');
  await server.stop(); t.mock.timers.tick(3000);
  assert.equal(server.child, null);
});

for (const failure of [false, true]) test(`Windows forced stop ${failure ? 'retains the child on tree-kill failure' : 'waits for the owned tree to terminate'}`, async t => {
  t.mock.timers.enable({ apis:['setTimeout'] });
  const server = new AppServer({ platform:'win32' }), child = new EventEmitter();
  child.stdin = { end() {} };
  child.kill = () => assert.fail('Windows stop must terminate descendants too');
  server.child = child; server.connected = true;
  let finish, calls = 0, settled = false;
  const tree = new Promise((resolve, reject) => { finish = failure ? reject : resolve; });
  server.terminateOwnedTree = () => { calls++; if (!failure) child.emit('close', 1); return tree; };
  const stopped = server.stop();
  const checked = failure ? assert.rejects(stopped, /taskkill failed/) : stopped;
  stopped.then(() => { settled = true; }, () => { settled = true; });
  t.mock.timers.tick(3000); await Promise.resolve();
  assert.equal(calls, 1); assert.equal(settled, false);
  finish(failure ? new Error('taskkill failed') : undefined); await checked;
  assert.equal(server.child, failure ? child : null);
});

async function serverFor(t) {
  const server = new AppServer({ command:process.execPath, args:[fileURLToPath(new URL('./fixtures/mock-server.mjs', import.meta.url))], timeout:3000 });
  t.after(() => server.stop());
  await server.start();
  return server;
}
test('expired response cannot resolve a newer RPC and errors retain their code', async t => {
  const server = await serverFor(t);
  const expiredId = server.nextId;
  await assert.rejects(server.request('test/timeout', {}, 10), error => error.code === 'TIMEOUT');
  const next = server.request('test/echo', { value:'new', delay:10 });
  server.receive({ id:expiredId, result:'stale' });
  server.receive({ id:'unknown', result:'foreign' });
  assert.equal((await next).value, 'new');
  await assert.rejects(server.request('test/error', {}), error => error.code === 'RPC_ERROR' && /409/.test(error.message));
  assert.equal(server.pending.size, 0);
});
test('child exit rejects every pending RPC and emits disconnection once', async t => {
  const server = await serverFor(t), events = [];
  server.on('disconnected', message => events.push(message));
  const pending = Array.from({ length:3 }, () => server.request('test/timeout', {}));
  const checked = pending.map(p => assert.rejects(p, /退出/));
  const closed = once(server.child, 'close');
  await server.request('test/exit', {}); await closed; await Promise.all(checked);
  assert.equal(server.pending.size, 0); assert.equal(server.connected, false);
  assert.equal(events.length, 1); assert.match(events[0], /7/);
});
test('intentional stop rejects pending RPCs without a disconnected event', async t => {
  const server = await serverFor(t); let events = 0;
  server.on('disconnected', () => events++);
  const checked = assert.rejects(server.request('test/timeout', {}), /关闭/);
  await server.stop(); await checked;
  assert.equal(events, 0); assert.equal(server.pending.size, 0); assert.equal(server.child, null);
});
for (const [method, message] of [['invalid', /无效 JSON/], ['oversized', /安全上限/]]) test(`stdio ${method} input fails all pending calls`, async t => {
  const server = await serverFor(t);
  const disconnected = once(server, 'disconnected');
  const checked = assert.rejects(server.request('test/timeout', {}), message);
  await assert.rejects(server.request(`test/${method}`, {}), message);
  await checked; assert.match((await disconnected)[0], message);
  assert.equal(server.connected, false); assert.equal(server.pending.size, 0);
});
test('non-Windows tree termination refuses without touching the owned child', { skip:process.platform === 'win32' }, async t => {
  const server = await serverFor(t), child = server.child;
  await assert.rejects(server.terminateOwnedTree(), /此平台未实现/);
  assert.equal(server.child, child); assert.equal(child.killed, false);
  assert.equal(server.stopping, false); assert.equal(server.connected, true);
  assert.equal((await server.request('test/echo', { alive:true })).alive, true);
});
test('incoming requests and notifications keep numeric and string IDs distinct', async () => {
  const server = new AppServer(), requests = [], notifications = [], writes = [];
  server.on('serverRequest', message => requests.push(message));
  server.on('notification', message => notifications.push(message));
  server.write = message => writes.push(message);
  server.receive({ id:0, method:'approval' }); server.receive({ method:'notice' });
  assert.equal(requests[0].id, 0); assert.equal(notifications.length, 1);
  const pending = server.request('echo', {});
  server.receive({ id:'1', result:'wrong type' }); assert.equal(server.pending.size, 1);
  server.receive({ id:1, result:'matched' }); assert.equal(await pending, 'matched');
  server.respond(0, { decision:'decline' }); server.rejectRequest('0');
  assert.deepEqual(writes[1], { id:0, result:{ decision:'decline' } });
  assert.equal(writes[2].id, '0'); assert.equal(writes[2].error.code, -32601);
});
