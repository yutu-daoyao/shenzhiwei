import {guardLiveScript} from './live-guard.js';
guardLiveScript(import.meta.url);
// Opt-in live acceptance test. Uses the existing ChatGPT login and only test-workspace.
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { start, root } from '../src/main.js';

let app;
let csrf;
const results = [];
const report = message => { results.push(message); console.log(message); };
const workspace = path.join(root, 'test-workspace');
const nonce = `ZW${Date.now()}`;
async function boot() {
  app = await start({ port: 0, dataDir: path.join(root, 'data', 'live-tests') });
  await app.ready;
  const state = await (await fetch(`${app.origin}/api/state`)).json();
  csrf = state.csrf;
  assert.equal(state.connection, 'connected', state.error);
  assert.equal(state.account.type, 'chatgpt');
}
async function post(route, body = {}) {
  const response = await fetch(`${app.origin}/api/${route}`, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json', 'X-Zhiwei-CSRF': csrf }, body: JSON.stringify(body) });
  const result = await response.json();
  assert.equal(response.status, 200, result.error);
  return result;
}
async function waitFor(predicate, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = app.client.snapshot();
    if (state.approvals.length) throw new Error('真实测试遇到需要用户本人审批的操作，未自动允许。请从页面恢复会话审批。');
    if (predicate(state)) return state;
    if (state.connection !== 'connected') throw new Error(state.error || 'App Server 断开');
    await delay(100);
  }
  throw new Error(`真实测试等待超时：${app.client.error || app.client.task.status}`);
}
async function turn(text) {
  const { turnId } = await post('send', { text });
  const state = await waitFor(s => s.task.turnId === turnId && ['completed', 'failed', 'interrupted'].includes(s.task.status));
  assert.equal(state.task.status, 'completed', state.error || '任务未成功');
  return state.items.filter(i => i.turnId === turnId && i.type === 'agentMessage').map(i => i.text).join('\n');
}
try {
  await boot();
  report('PASS 1：真实 Codex 连接 + ChatGPT 登录');
  const { id } = await post('new');
  let deltaCount = 0;
  const listener = message => { if (message.method === 'item/agentMessage/delta' && message.params.threadId === id) deltaCount++; };
  app.client.rpc.on('notification', listener);
  const greeting = await turn('你好，请用一句中文介绍自己。不要调用工具。');
  assert.ok(greeting.length > 0);
  assert.ok(deltaCount > 0, '未收到真实增量');
  report(`PASS 2：真实中文回复及流式增量（${deltaCount} 条）：${greeting.slice(0, 120)}`);
  await turn(`请记住本次验收代号 ${nonce}。只回复已记住，不要调用工具。`);
  const remembered = await turn('我刚才让你记住的验收代号是什么？只输出代号，不要调用工具。');
  assert.ok(remembered.includes(nonce), '上下文没有保留');
  report('PASS 3：原生 Thread 多轮上下文');
  const filename = `acceptance-${nonce}.txt`;
  await turn(`请使用你的文件或命令工具，在当前工作目录创建 ${filename}，内容为 ZHIWEI_INITIAL_${nonce}，然后实际读取文件并报告内容。仅操作当前目录，不请求额外权限。`);
  assert.equal((await readFile(path.join(workspace, filename), 'utf8')).trim(), `ZHIWEI_INITIAL_${nonce}`);
  await turn(`请实际读取刚才创建的 ${filename}，将内容改成 ZHIWEI_FINAL_${nonce}，再次读取并核对。仅操作当前目录，不请求额外权限。`);
  assert.equal((await readFile(path.join(workspace, filename), 'utf8')).trim(), `ZHIWEI_FINAL_${nonce}`);
  assert.ok(app.client.snapshot().items.some(i => i.type === 'tool'), '没有工具进度事件');
  report('PASS 4：真实工具创建、读取、修改文件，宿主读取最终内容核验通过');
  const sentinel = `should-not-exist-${nonce}.txt`;
  await post('send', { text: `执行一个可中断验收：只运行一次 PowerShell 命令，先 Start-Sleep -Seconds 30，再向当前目录的 ${sentinel} 写入 MISSED_INTERRUPT。不要提前写文件，不要做其他事。我将在等待期间中断。` });
  await waitFor(s => s.items.some(i => i.turnId === s.task.turnId && i.type === 'tool' && i.tool === 'commandExecution'));
  await delay(1200);
  await post('stop');
  const stopped = await waitFor(s => ['completed', 'failed', 'interrupted'].includes(s.task.status), 30000);
  assert.equal(stopped.task.status, 'interrupted');
  report('PASS 5a：真实执行中通过 HTTP 停止接口发送 turn/interrupt，收到 interrupted');
  if (stopped.logs.some(l => l.message.includes('所属进程树已结束'))) report('PASS 5a-fallback：原生中断遗留命令已由所属进程树兜底终止，会话自动恢复');
  await turn('刚才任务已中断。只回复“可以继续”，不要调用工具。');
  report('PASS 5b：中断后可继续真实对话');
  await app.close(); app = null;
  await boot();
  assert.ok(app.client.sessions.entries.some(s => s.id === id));
  await post('resume', { id });
  assert.ok(app.client.snapshot().items.some(i => i.type === 'agentMessage'), '恢复后无可见历史');
  const afterRestart = await turn('本对话最初的验收代号是什么？只输出代号，不调用工具。');
  assert.ok(afterRestart.includes(nonce));
  report('PASS 6：关闭客户端和所属 App Server 后重启，thread/resume 恢复历史与原上下文');
  await delay(31000); // Independent sentinel check catches a command that merely stopped displaying.
  await assert.rejects(access(path.join(workspace, sentinel)), error => error.code === 'ENOENT');
  report('PASS 5c：等待超过原命令时长后，中断哨兵文件仍不存在');
  console.log('真实联调全部通过。');
} catch (error) {
  console.error(`FAIL：${error.message}`); process.exitCode = 1;
} finally { if (app) await app.close(); }
