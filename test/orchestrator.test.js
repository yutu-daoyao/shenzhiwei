import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Zhiwei } from '../src/client.js';
import { parsePlan } from '../src/orchestrator.js';

const steps = [{ title: '搜索', instruction: '搜索新闻' }, { title: '保存', instruction: '保存标题' }];
class MockRPC extends EventEmitter {
  connected = true;
  calls = [];
  async request(method, params) {
    if (method === 'thread/start') return { thread: { id: 'thread' } };
    if (method === 'turn/interrupt') return {};
    assert.equal(method, 'turn/start');
    const index = this.calls.push(params.input[0].text) - 1;
    const turn = { id: `turn-${index}`, status: 'inProgress' };
    this.onTurn?.(turn, index);
    return { turn };
  }
  finish(turn, text, status = 'completed', error) {
    this.emit('notification', { method: 'turn/completed', params: { threadId: 'thread', turn: { ...turn, status, error: error ? { message: error } : undefined, items: [{ id: `${turn.id}-message`, type: 'agentMessage', text }] } } });
  }
  async stop() { this.connected = false; }
}
async function setup(t, outcomes, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhiwei-plan-'));
  const rpc = new MockRPC();
  const client = new Zhiwei({ workspace: dir, dataDir: dir, rpc, ...options });
  client.memory = { recordTask: data => records.push(data), close() {} };
  const records = [];
  await client.sessions.load();
  rpc.onTurn = (turn, index) => {
    const outcome = index === 0 ? { text: JSON.stringify({ steps }) } : outcomes[index - 1];
    if (outcome) rpc.finish(turn, outcome.text ?? 'STEP_RESULT: ok', outcome.status, outcome.error);
  };
  t.after(async () => { await client.close(); await rm(dir, { recursive: true, force: true }); });
  return { client, rpc, records };
}

test('parse fenced JSON and surrounding text; garbage falls back; truncate to eight', () => {
  assert.deepEqual(parsePlan('说明\n```json\n' + JSON.stringify({ steps }) + '\n```\n结束', '任务'), steps);
  for (const output of ['garbage', '{}', '{"steps":[]}', '{"steps":[{}]}']) assert.deepEqual(parsePlan(output, '任务'), [{ title: '任务', instruction: '任务' }]);
  assert.equal(parsePlan(JSON.stringify({ steps: Array(10).fill(steps[0]) }), '任务').length, 8);
});
test('two steps complete; early completion notifications are retained; memory records overall task once', async t => {
  const { client, rpc, records } = await setup(t, [{}, {}]);
  const { report } = await client.runPlan('整理新闻');
  assert.equal(client.snapshot().plan.status, 'done');
  assert.deepEqual(client.plan.steps.map(s => [s.status, s.attempts]), [['ok', 1], ['ok', 1]]);
  assert.match(report, /共 2 步/);
  assert.equal([...client.items.values()].at(-1).text, report);
  assert.equal(rpc.calls.length, 3);
  assert.equal(records.length, 1); assert.equal(records[0].request, '整理新闻');
});
test('failed marker retries once with reason then succeeds', async t => {
  const { client, rpc } = await setup(t, [{ text: 'STEP_RESULT: failed 找不到按钮' }, {}, {}]);
  await client.runPlan('整理新闻');
  assert.equal(client.plan.status, 'done'); assert.equal(client.plan.steps[0].attempts, 2);
  assert.match(rpc.calls[2], /上次失败原因：找不到按钮，换一种方法重试一次/);
  assert.equal(rpc.calls.length, 4);
});
test('two failed turns skip later steps', async t => {
  const { client, rpc } = await setup(t, [{ status: 'failed', error: '网络失败' }, { status: 'interrupted', text: '' }]);
  await client.runPlan('整理新闻');
  assert.equal(client.plan.status, 'failed');
  assert.deepEqual(client.plan.steps.map(s => [s.status, s.attempts]), [['failed', 2], ['skipped', 0]]);
  assert.equal(rpc.calls.length, 3);
});
test('completed without marker is accepted', async t => {
  const { client } = await setup(t, [{ text: '完成' }, {}]);
  await client.runPlan('整理新闻'); assert.equal(client.plan.status, 'done');
});
test('user stop aborts waiting step immediately without retry or completion notification', async t => {
  const { client, rpc } = await setup(t, []);
  const running = client.runPlan('整理新闻');
  while (rpc.calls.length < 2 || client.locked) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(client.send('插入消息'), /多步任务/);
  await assert.rejects(client.newThread(), /多步任务/);
  await client.interrupt();
  await running;
  assert.equal(client.plan.status, 'stopped'); assert.match(client.plan.report, /已停止/);
  assert.equal(client.plan.steps[0].attempts, 1); assert.equal(rpc.calls.length, 2);
});
test('unknown Windows action never retries even with an ok marker', async t => {
  const computer = new EventEmitter();
  Object.assign(computer, { beginTurn() {}, endTurn() {}, cancel() {}, close() {}, snapshot: () => ({ actions: [{ needsReview: true, tool: 'windows_click', error: '结果未知' }] }) });
  const { client, rpc } = await setup(t, [{}], { computer });
  await client.runPlan('整理新闻');
  assert.equal(client.plan.status, 'failed'); assert.equal(client.plan.steps[0].attempts, 1);
  assert.equal(client.plan.steps[1].status, 'skipped'); assert.equal(rpc.calls.length, 2);
  assert.match(client.plan.report, /结果未知/);
});
test('planning stop does not execute steps', async t => {
  const { client, rpc } = await setup(t, []);
  rpc.onTurn = () => {};
  const running = client.runPlan('整理新闻');
  while (!client.task.turnId || client.locked) await new Promise(resolve => setImmediate(resolve));
  await client.interrupt(); await running;
  assert.equal(client.plan.status, 'stopped'); assert.equal(rpc.calls.length, 1);
});
test('stop while turn/start response is pending reports immediately and never starts another turn', async t => {
  const { client, rpc } = await setup(t, []);
  const request = rpc.request.bind(rpc);
  let release;
  rpc.request = async (method, params) => {
    const result = await request(method, params);
    if (method === 'turn/start' && rpc.calls.length === 2) await new Promise(resolve => { release = resolve; });
    return result;
  };
  const running = client.runPlan('整理新闻');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await client.interrupt(); await running;
  assert.equal(client.plan.status, 'stopped'); assert.equal(rpc.calls.length, 2);
  release();
  while (client.locked) await new Promise(resolve => setImmediate(resolve));
  rpc.finish({ id: 'turn-1' }, 'STEP_RESULT: failed 已停止', 'interrupted');
  assert.equal(rpc.calls.length, 2);
});
test('planning garbage executes original request as one step', async t => {
  const { client, rpc } = await setup(t, [{}]);
  const onTurn = rpc.onTurn;
  rpc.onTurn = (turn, index) => index === 0 ? rpc.finish(turn, 'garbage') : onTurn(turn, index);
  await client.runPlan('原始任务');
  assert.equal(client.plan.steps.length, 1); assert.equal(client.plan.status, 'done');
  assert.match(rpc.calls[1], /第 1\/1 步：原始任务/);
});
test('more than eight planned steps execute only eight turns', async t => {
  const { client, rpc } = await setup(t, Array.from({ length: 8 }, () => ({})));
  const onTurn = rpc.onTurn;
  rpc.onTurn = (turn, index) => index === 0 ? rpc.finish(turn, JSON.stringify({ steps: Array(10).fill(steps[0]) })) : onTurn(turn, index);
  await client.runPlan('任务');
  assert.equal(client.plan.steps.length, 8); assert.equal(rpc.calls.length, 9); assert.equal(client.plan.status, 'done');
});
test('stop during first thread creation preserves stopped report and never sends planning turn', async t => {
  const { client, rpc } = await setup(t, []);
  const request = rpc.request.bind(rpc);
  let release;
  rpc.request = async (method, params) => {
    if (method === 'thread/start') await new Promise(resolve => { release = resolve; });
    return request(method, params);
  };
  const running = client.runPlan('任务');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await client.interrupt(); await running;
  const report = client.plan.report;
  release();
  while (client.locked) await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.plan.status, 'stopped'); assert.equal(rpc.calls.length, 0);
  assert.equal([...client.items.values()].at(-1).text, report);
});

test('acceptance can disable retries: failed step executes once and skips rest', async t => {
  const { client, rpc } = await setup(t, [{ text:'STEP_RESULT: failed 验收不重试' }, {}]);
  await client.runPlan('验收两步', { maxAttempts:1 });
  assert.equal(client.plan.status, 'failed');
  assert.equal(client.plan.steps[0].attempts, 1);
  assert.equal(client.plan.steps[1].status, 'skipped');
  assert.equal(rpc.calls.length, 2);
});
