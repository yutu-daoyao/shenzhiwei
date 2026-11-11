import {guardLiveScript} from './live-guard.js';
guardLiveScript(import.meta.url);
// Opt-in Windows acceptance. No settings changes, clipboard access, or retries.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { start, root } from '../src/main.js';

export function skillApprovalAllowed(p, workspace, filename) {
  return (p.tool === 'windows_volume' && p.params.action === 'get' && p.params.level === undefined) ||
    (p.tool === 'windows_search_files' && p.params.query === filename && typeof p.params.folder === 'string' && path.resolve(workspace, p.params.folder) === workspace);
}
export function nativeApprovalAllowed(method, p, workspace, commands) {
  if (p.networkApprovalContext) return false;
  if (method === 'item/fileChange/requestApproval') {
    const target = p.grantRoot || p.cwd;
    if (!target || !path.isAbsolute(target)) return false;
    const relative = path.relative(workspace, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }
  return method === 'item/commandExecution/requestApproval' && p.cwd === workspace && commands.includes(p.command);
}
export function toolResult(item) {
  return (item.result?.content || []).filter(c => c.type === 'text').flatMap(c => {
    try { return [JSON.parse(c.text)]; } catch { return []; }
  });
}
async function waitTurn(client, turnId) {
  while (true) {
    assert.equal(client.connection, 'connected', client.error || 'Codex disconnected');
    if (client.task.turnId === turnId && ['completed','failed','interrupted'].includes(client.task.status)) {
      assert.equal(client.task.status, 'completed', client.error || '任务未完成');
      return client.snapshot().items.filter(i => i.turnId === turnId && i.type === 'agentMessage').map(i => i.text).join('\n');
    }
    await delay(100);
  }
}
async function turn(client, text) {
  const { turnId } = await client.send(text+' 每个操作仅执行一次，失败即报告，不得重试。');
  return waitTurn(client, turnId);
}
async function main() {
  assert.equal(process.platform, 'win32', '此验收只能在 Windows 上运行');
  const base = path.join(root, 'data');
  await mkdir(base, { recursive:true });
  const dataDir = await mkdtemp(path.join(base, 'features-live-'));
  const workspace = await mkdtemp(path.join(root, 'test-workspace', 'features-'));
  const nonce = path.basename(dataDir), filename = `技能验收-${nonce}.txt`, planfile = `plan-${nonce}.txt`, token = `ZW_PREFERENCE_${nonce}`;
  let failures = 0;
  const checks = [
    ['记忆', async (client, calls) => {
      await client.newThread();
      await turn(client, `我的稳定偏好“验收代号”是 ${token}，请调用 zhiwei_memory.memory_set_preference 保存，key 为“验收代号”，value 为代号。不要使用其他工具。`);
      assert.ok(calls.some(i => i.server === 'zhiwei_memory' && i.tool === 'memory_set_preference' && i.status === 'completed'), '未成功调用记忆 MCP');
      assert.ok(client.memory?.getPreferences().some(p => p.key === '验收代号' && p.value === token), 'SQLite 未保存偏好');
      const previous = client.currentId;
      await client.newThread();
      assert.notEqual(client.currentId, previous, '没有新建独立对话');
      const answer = await turn(client, '我的偏好“验收代号”是什么？可查询 zhiwei_memory，只回复代号，不要调用其他工具。');
      assert.ok(answer.includes(token), '新对话未回忆出偏好');
    }],
    ['技能', async (client, calls) => {
      await writeFile(path.join(workspace, filename), '技能验收', { flag:'wx' });
      await client.newThread();
      await turn(client, `请仅调用一次 windows_volume，action=get，获取音量；再仅调用一次 windows_search_files，query=${filename}，folder=${workspace}。告诉我结果。禁止调节音量、访问剪贴板或调用其他工具。`);
      const completed = name => calls.filter(i => i.server === 'zhiwei_windows' && i.tool === name && i.status === 'completed');
      const volumes = completed('windows_volume'), searches = completed('windows_search_files');
      assert.equal(volumes.length, 1, '音量工具须成功执行一次');
      assert.equal(searches.length, 1, '搜索工具须成功执行一次');
      assert.ok(toolResult(volumes[0]).some(r => r.ok && Number.isFinite(r.level) && r.level >= 0 && r.level <= 100), '音量工具没有返回 level');
      assert.ok(toolResult(searches[0]).some(r => r.ok && r.results?.some(f => path.resolve(f.path) === path.join(workspace, filename))), '搜索结果没有测试文件');
    }],
    ['多步', async client => {
      await client.newThread();
      await client.runPlan(`严格拆为两步且不重试：第一步在当前工作目录创建 ${planfile}，UTF-8 内容为“你好”；第二步读取此文件并告诉我内容。仅操作这个文件。优先使用原生文件工具；如使用命令，仅允许以下原样命令：${commands.join(' 或 ')}。`, { maxAttempts:1 });
      assert.equal(client.plan.status, 'done', client.plan.report);
      assert.equal(client.plan.steps.length, 2, '未拆成两步');
      assert.ok(client.plan.steps.every(s => s.attempts === 1), '步骤被重试');
      assert.equal((await readFile(path.join(workspace, planfile), 'utf8')).trim(), '你好');
    }],
  ];
  const commands = [
    `node -e "require('node:fs').writeFileSync('${planfile}','你好',{flag:'wx'})"`,
    `node -e "console.log(require('node:fs').readFileSync('${planfile}','utf8'))"`,
  ];
  for (const [name, check] of checks) {
    let app, timer, expired = false, approvalError = '';
    const calls = [], seen = new Set(), granted = new Set();
    try {
      const operation = (async () => {
        app = await start({ port:0, workspace, dataDir:path.join(dataDir, name) });
        if (expired) { await app.close(); return; }
        await app.ready;
        if (expired) return;
        const client = app.client, computer = client.computer;
        assert.equal(client.connection, 'connected', 'CODEX_UNAVAILABLE：'+(client.error || 'Codex 未连接或未登录'));
        if ((await computer.checkDesktop()).locked) throw new Error('桌面已锁屏，请本人解锁后再运行');
        computer.on('change', () => {
          for (const p of computer.snapshot().approvals) {
            if (seen.has(p.id)) continue;
            seen.add(p.id);
            const allowed = name === '技能' && !expired && !granted.has(p.tool) && skillApprovalAllowed(p, workspace, filename);
            if (allowed) granted.add(p.tool);
            else approvalError = '已拒绝计划外 Windows 工具：'+p.tool;
            computer.approve(p.id, allowed ? 'accept' : 'decline');
          }
        });
        client.rpc.on('serverRequest', ({ id, method, params:p = {} }) => {
          if (!client.approvals.has(String(id))) return;
          const allowed = name === '多步' && !expired && nativeApprovalAllowed(method, p, workspace, commands);
          if (!allowed) approvalError = '已拒绝计划外原生审批：'+method;
          client.approve(String(id), allowed ? 'accept' : 'decline');
        });
        client.rpc.on('notification', ({ method, params:p }) => {
          if (method === 'item/completed' && p.item?.type === 'mcpToolCall') calls.push(p.item);
        });
        await check(client, calls);
        assert.equal(approvalError, '', approvalError);
      })();
      await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Error('超时（3 分钟），未重试')); }, 180000);
      })]);
      console.log('PASS：'+name);
    } catch (error) { failures++; console.error('FAIL：'+name+'：'+error.message); }
    finally { expired = true; clearTimeout(timer); if (app) await app.close(); }
  }
  // Only remove our two temporary files; keep logs and any failure evidence.
  await rm(path.join(workspace, filename), { force:true });
  await rm(path.join(workspace, planfile), { force:true });
  process.exitCode = failures ? 1 : 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error('FAIL：'+error.message); process.exitCode = 1; });
