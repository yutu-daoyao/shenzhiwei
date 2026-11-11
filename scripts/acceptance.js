// One-shot acceptance coordinator; importing this module never starts live tests.
import { spawn, execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile as saveFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export function acceptanceFilename(date) {
  const pad = n => String(n).padStart(2, '0');
  return `zhiwei-cu-${date.getFullYear()}${pad(date.getMonth()+1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.txt`;
}
export function acceptanceItems(filename) {
  return [
    { id:'offline', name:'离线测试', timeout:300000 },
    { id:'computer', name:'保存 + 中途停止', windows:true, timeout:600000, args:['scripts/computer-live-test.js'], env:{ ZHIWEI_ACCEPTANCE_FILENAME:filename }, completion:'本次真实核心验收完成。' },
    { id:'browser', name:'浏览器', windows:true, timeout:600000, args:['scripts/browser-live-test.js'] },
    { id:'features', name:'记忆 / 技能 / 多步', windows:true, timeout:600000, args:['scripts/features-live-test.js'] },
  ];
}
const tail = value => String(value || '').split(/\r?\n/).slice(-40).join('\n');
const unavailable = /CODEX_UNAVAILABLE|Codex (?:尚未连接|尚未登录|disconnected)|找不到可用的 Codex|当前不是 ChatGPT 登录|App Server (?:启动失败|已退出)|(?:connection|connected).*?(?:error|disconnected)|(?:登录|连接)(?:失败|状态)/i;
export function summaryLine(result) {
  const label = { pass:'✔ 通过', fail:'✘ 失败', skip:'－ 跳过' }[result.status];
  return `${label}  ${result.name}  ${result.reason}`;
}
export async function runAcceptance({ items, run, platform = process.platform, version = process.version, now = () => new Date(), writeFile = saveFile, resultPath = path.join(root, 'data', 'acceptance-result.txt'), head = '不可用', log = console.log } = {}) {
  const started = now(), filename = acceptanceFilename(started);
  items ??= acceptanceItems(filename);
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  const supported = major > 22 || (major === 22 && minor >= 13);
  const results = [{ id:'environment', name:'环境检查', status:supported ? 'pass' : 'fail', reason:supported ? `${version}，${platform}` : '需要 Node ≥22.13' }];
  let offlineFailed = false, connectionFailed = false;
  for (const item of items) {
    let reason = !supported ? '环境检查失败' : item.windows && platform !== 'win32' ? '仅支持 Windows，当前 '+platform : item.windows && offlineFailed ? '离线测试失败' : item.windows && connectionFailed ? 'Codex 未连接或未登录' : '';
    if (reason) { results.push({ ...item, status:'skip', reason }); continue; }
    log(`\n开始：${item.name}（仅执行一次）`);
    let outcome;
    try { outcome = await run(item); }
    catch (error) { outcome = { code:1, timedOut:error.code === 'ETIMEDOUT', output:error.message }; }
    const output = outcome.output || '';
    const ok = outcome.code === 0 && !outcome.timedOut && (!item.completion || (outcome.completed ?? output.includes(item.completion)));
    reason = outcome.timedOut ? '超时' : ok ? (outcome.counts || '执行完成') : outcome.reason || (item.completion && outcome.code === 0 ? '缺少完成确认' : `退出码 ${outcome.code ?? '未知'}`);
    results.push({ ...item, status:ok ? 'pass' : 'fail', reason, output:tail(output), evidence:outcome.evidence || '' });
    if (item.id === 'offline' && !ok) offlineFailed = true;
    if (item.id === 'computer' && !ok && (outcome.unavailable || unavailable.test(output))) connectionFailed = true;
  }
  const duration = Math.max(0, now()-started)/1000;
  const lines = results.map(summaryLine);
  const details = results.flatMap(r => [...(r.evidence ? [`\n${r.name}：`, r.evidence] : []), ...(r.status === 'fail' && r.output ? [`\n${r.name}：输出末尾`, r.output] : [])]);
  const content = '\uFEFF'+[`验收时间：${started.toISOString()}`, `Node：${version}`, `git HEAD：${head}`, ...lines, `总耗时：${duration.toFixed(1)} 秒`, ...details, ''].join('\n').replace(/\r?\n/g, '\r\n');
  await writeFile(resultPath, content, 'utf8');
  log('\n'+lines.join('\n')+`\n总耗时：${duration.toFixed(1)} 秒`);
  log(`结果文件：${path.resolve(resultPath)}\n请把这个结果文件发回。`);
  return { results, filename, content, exitCode:results.some(r => r.status === 'fail') ? 1 : 0 };
}

// Pipes tee both streams to the console, keeping bounded diagnostic output.
export function runChild(item, { cwd = root, spawnProcess = spawn, platform = process.platform, stdout = process.stdout, stderr = process.stderr } = {}) {
  return new Promise(resolve => {
    let child, timer, fallback, finished = false, timedOut = false, output = '', evidence = [], counts = {}, partial = '', disconnected = false, completed = false;
    const line = text => {
      if (item.completion && text.includes(item.completion)) completed = true;
      if (/PASS CU[1-5]：/.test(text)) evidence.push(text);
      const count = text.match(/^(?:#|ℹ)\s*(pass|fail|skipped)\s+(\d+)/);
      if (count) counts[count[1]] = Number(count[2]);
      if (unavailable.test(text)) disconnected = true;
    };
    const capture = (chunk, stream) => {
      stream.write(chunk);
      output = (output+chunk).slice(-64000);
      partial += chunk;
      const lines = partial.split(/\r?\n/); partial = lines.pop().slice(-64000);
      for (const text of lines) line(text);
    };
    const finish = (code, error) => {
      if (finished) return;
      finished = true; clearTimeout(timer); clearTimeout(fallback); line(partial);
      if (error) output += '\n'+error.message;
      resolve({ code, timedOut, output:tail(output), completed, unavailable:disconnected, evidence:evidence.join('\n'), counts:counts.pass !== undefined ? `通过 ${counts.pass}，失败 ${counts.fail || 0}，跳过 ${counts.skipped || 0}` : '' });
    };
    try {
      child = spawnProcess(process.execPath, item.args, { cwd, env:{ ...process.env, ...item.env }, stdio:['inherit','pipe','pipe'], windowsHide:true, detached:platform !== 'win32' });
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => capture(chunk, stdout)); child.stderr.on('data', chunk => capture(chunk, stderr));
      child.on('error', error => finish(1, error));
      child.on('close', code => finish(code));
      timer = setTimeout(() => {
        timedOut = true;
        if (platform === 'win32') {
          const killer = spawnProcess('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide:true, stdio:'ignore' });
          killer.on('error', error => { output += '\n终止进程树失败：'+error.message; child.kill(); });
        } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); } }
        fallback = setTimeout(() => finish(1), 5000);
      }, item.timeout);
    } catch (error) { finish(1, error); }
  });
}
export function offlineArgs(script) {
  const parts = script.trim().split(/\s+/);
  if (parts.shift() !== 'node' || parts.shift() !== '--test' || !parts.length || parts.some(p => !/^test\/[\w./-]+\.test\.js$/.test(p))) throw new Error('package.json 的 test 脚本必须为 node --test 加测试文件列表');
  return ['--test', ...parts];
}
async function main() {
  await mkdir(path.join(root, 'data'), { recursive:true });
  let head = '不可用';
  try { head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd:root, encoding:'utf8', timeout:5000, stdio:['ignore','pipe','ignore'] }).trim(); } catch {}
  const { scripts } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const result = await runAcceptance({ head, run:item => runChild(item.id === 'offline' ? { ...item, args:offlineArgs(scripts.test) } : item) });
  process.exitCode = result.exitCode;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error('验收启动失败：'+error.message); process.exitCode = 1; });
