import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { acceptanceFilename, acceptanceItems, offlineArgs, runAcceptance, runChild } from '../scripts/acceptance.js';
import { skillApprovalAllowed, nativeApprovalAllowed, toolResult } from '../scripts/features-live-test.js';

const date = new Date(2026, 9, 30, 9, 8, 7);
async function scenario(outcomes = {}, options = {}) {
  const calls = [], writes = [], logs = [];
  const result = await runAcceptance({
    platform:'win32', version:'v24.18.0', now:() => date, head:'abc123', resultPath:'/tmp/acceptance-result.txt',
    run:async item => {
      calls.push(item);
      const outcome = outcomes[item.id];
      if (outcome instanceof Error) throw outcome;
      return outcome || { code:0, output:item.completion || '', counts:item.id === 'offline' ? '通过 140，失败 0，跳过 4' : '' };
    },
    writeFile:async (...args) => writes.push(args), log:text => logs.push(text), ...options,
  });
  return { ...result, calls, writes, logs };
}
test('items run in order exactly once, with fresh computer filename and no resume', async () => {
  const r = await scenario();
  assert.deepEqual(r.calls.map(i => i.id), ['offline','computer','browser','features']);
  assert.equal(r.exitCode, 0);
  assert.equal(r.filename, 'zhiwei-cu-20261030-090807.txt');
  assert.deepEqual(r.calls[1].args, ['scripts/computer-live-test.js']);
  assert.equal(r.calls[1].env.ZHIWEI_ACCEPTANCE_FILENAME, r.filename);
  assert.equal(acceptanceFilename(new Date(2026, 10, 1, 0, 0, 0)), 'zhiwei-cu-20261101-000000.txt');
  assert.equal(acceptanceItems(r.filename)[0].timeout, 300000);
  assert.ok(r.calls.slice(1).every(i => i.timeout === 600000));
});
test('offline failure skips every live dependency', async () => {
  const r = await scenario({ offline:{ code:1, output:'测试失败' } });
  assert.deepEqual(r.calls.map(i => i.id), ['offline']);
  assert.ok(r.results.slice(2).every(i => i.status === 'skip' && i.reason === '离线测试失败'));
  assert.equal(r.exitCode, 1);
});
test('Codex login or connection failure in first live item skips rest', async () => {
  for (const output of ['Codex 尚未登录。请在终端运行 codex login', '找不到可用的 Codex CLI。', 'CODEX_UNAVAILABLE', "Expected connected; actual error", 'Codex disconnected']) {
    const r = await scenario({ computer:{ code:1, output } });
    assert.deepEqual(r.calls.map(i => i.id), ['offline','computer']);
    assert.ok(r.results.slice(3).every(i => i.status === 'skip' && i.reason.includes('未登录')));
  }
});
test('ordinary live failure continues; completion line required even on exit zero', async () => {
  const r = await scenario({ computer:{ code:0, output:'PASS CU1：启动' }, browser:{ code:1, output:'桌面已锁屏，请本人解锁' } });
  assert.equal(r.calls.length, 4);
  assert.equal(r.results[2].status, 'fail');
  assert.equal(r.results[2].reason, '缺少完成确认');
  assert.equal(r.results[4].status, 'pass');
  assert.match(r.content, /桌面已锁屏，请本人解锁/);
});
test('timeout and thrown timeout are failures, never retried', async () => {
  const r = await scenario({ computer:{ code:0, timedOut:true, output:'中途输出' }, browser:Object.assign(new Error('等待超时'), { code:'ETIMEDOUT' }) });
  assert.equal(r.calls.length, 4);
  assert.ok(r.results.slice(2, 4).every(i => i.status === 'fail' && i.reason === '超时'));
  assert.match(r.content, /✘ 失败  保存 \+ 中途停止  超时/);
});
test('Chinese summary and result include BOM, only CRLF, metadata, counts and failure tail', async () => {
  const r = await scenario({ browser:{ code:1, output:Array.from({ length:60 }, (_, i) => `故障行${i}`).join('\n') } });
  assert.equal(r.writes.length, 1);
  assert.deepEqual(r.writes[0], ['/tmp/acceptance-result.txt', r.content, 'utf8']);
  assert.deepEqual([...Buffer.from(r.content).subarray(0, 3)], [239,187,191]);
  assert.doesNotMatch(r.content, /(?<!\r)\n/);
  assert.match(r.content, /验收时间：.*\r\nNode：v24.18.0\r\ngit HEAD：abc123/);
  assert.match(r.content, /✔ 通过  离线测试  通过 140，失败 0，跳过 4/);
  assert.match(r.content, /✘ 失败  浏览器/);
  assert.match(r.content, /故障行20\r\n/);
  assert.doesNotMatch(r.content, /故障行19\r\n/);
  assert.match(r.logs.join('\n'), /总耗时：.*请把这个结果文件发回。/s);
});
test('Linux runs offline only and skips Windows items; unsupported Node fails environment', async () => {
  const linux = await scenario({}, { platform:'linux' });
  assert.deepEqual(linux.calls.map(i => i.id), ['offline']);
  assert.ok(linux.results.slice(2).every(i => i.status === 'skip' && i.reason.includes('Windows')));
  assert.match(linux.content, /－ 跳过/);
  assert.equal(linux.exitCode, 0);
  for (const version of ['v22.12.0','v20.19.2']) {
    const old = await scenario({}, { version });
    assert.equal(old.calls.length, 0);
    assert.equal(old.exitCode, 1);
    assert.match(old.content, /需要 Node ≥22.13/);
  }
  assert.equal((await scenario({}, { version:'v22.13.0' })).exitCode, 0);
});
test('offline command parses the complete package test list including acceptance, never live', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const args = offlineArgs(pkg.scripts.test);
  assert.equal(args[0], '--test');
  assert.ok(args.includes('test/acceptance.test.js'));
  assert.ok(args.slice(1).every(p => p.startsWith('test/')));
  assert.equal(pkg.scripts.acceptance, 'node scripts/acceptance.js');
  assert.throws(() => offlineArgs('node --test test/a.test.js && node scripts/live-test.js'));
});
test('batch is minimal, quoted, UTF-8 codepage, pause and actual CRLF', async () => {
  const bat = await readFile(new URL('../一键验收.bat', import.meta.url), 'utf8');
  assert.ok(bat.startsWith('@echo off\r\n'));
  for (const text of ['chcp 65001 >nul','cd /d "%~dp0"','node -v','node scripts\\acceptance.js %*','pause']) assert.ok(bat.includes(text));
  assert.doesNotMatch(bat, /(?<!\r)\n/);
  assert.ok(bat.endsWith('\r\n'));
  const attributes = await readFile(new URL('../.gitattributes', import.meta.url), 'utf8');
  assert.match(attributes, /^\*\.bat text eol=crlf$/m);
});
function mockChild() {
  const child = new EventEmitter();
  child.pid = 123;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdout.setEncoding = child.stderr.setEncoding = () => {};
  child.kill = () => {};
  return child;
}
test('runner tees both streams, captures counts and CU proof without spawning processes', async () => {
  const child = mockChild(), streams = [], calls = [];
  const running = runChild({ args:['--test'], timeout:1000 }, {
    platform:'win32', stdout:{ write:s => streams.push(s) }, stderr:{ write:s => streams.push(s) },
    spawnProcess:(...args) => { calls.push(args); return child; },
  });
  child.stdout.emit('data', 'PASS CU1：窗口\n# pass 10\n# fail 0\n');
  child.stderr.emit('data', '中文诊断\n# skipped 4\n');
  child.emit('close', 0);
  const r = await running;
  assert.equal(calls.length, 1); assert.equal(calls[0][0], process.execPath);
  assert.match(r.counts, /通过 10，失败 0，跳过 4/);
  assert.equal(r.evidence, 'PASS CU1：窗口');
  assert.match(r.output, /中文诊断/);
  assert.equal(streams.length, 2);
});
test('runner timeout invokes Windows taskkill tree once', async () => {
  const child = mockChild(), calls = [];
  const result = await runChild({ args:['fake.js'], timeout:1 }, {
    platform:'win32', spawnProcess:(command, args) => {
      calls.push([command, args]);
      if (command === 'taskkill') { setImmediate(() => child.emit('close', 1)); return new EventEmitter(); }
      return child;
    },
  });
  assert.equal(result.timedOut, true);
  assert.deepEqual(calls[1], ['taskkill', ['/pid','123','/T','/F']]);
  assert.equal(calls.length, 2);
});
test('skill approvals match exact tools and read-only parameters', () => {
  const workspace = path.resolve('test-workspace'), filename = '技能验收-unique.txt';
  assert.ok(skillApprovalAllowed({ tool:'windows_volume', params:{ action:'get' } }, workspace, filename));
  assert.ok(skillApprovalAllowed({ tool:'windows_search_files', params:{ query:filename, folder:workspace } }, workspace, filename));
  for (const p of [
    { tool:'windows_volume', params:{ action:'set', level:20 } },
    { tool:'windows_volume', params:{ action:'get', level:20 } },
    { tool:'windows_clipboard_read', params:{} },
    { tool:'windows_search_files_extra', params:{ query:filename, folder:workspace } },
    { tool:'windows_search_files', params:{ query:filename, folder:path.dirname(workspace) } },
  ]) assert.equal(skillApprovalAllowed(p, workspace, filename), false);
});
test('native approvals require workspace scope, exact commands and no network', () => {
  const workspace = path.resolve('test-workspace'), commands = ['node -e "test"'];
  const allowed = (method, p) => nativeApprovalAllowed('item/'+method+'/requestApproval', p, workspace, commands);
  assert.ok(allowed('commandExecution', { cwd:workspace, command:commands[0] }));
  assert.ok(allowed('fileChange', { grantRoot:path.join(workspace, 'test') }));
  for (const p of [{ cwd:workspace, command:'whoami' }, { cwd:path.dirname(workspace), command:commands[0] }, { cwd:workspace, command:commands[0], networkApprovalContext:{} }]) assert.equal(allowed('commandExecution', p), false);
  assert.equal(allowed('fileChange', { grantRoot:path.dirname(workspace) }), false);
  assert.equal(allowed('fileChange', {}), false);
  assert.deepEqual(toolResult({ result:{ content:[{ type:'text', text:'{"ok":true,"level":30}' }] } }), [{ ok:true, level:30 }]);
});
