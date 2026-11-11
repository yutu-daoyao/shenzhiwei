import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { SystemSkills, runPowerShell } from '../src/windows/skills.js';

test('PowerShell stdin is ASCII on code page 936 and preserves Chinese scripts and large JSON', async t => {
  t.mock.timers.enable({ apis:['setTimeout'] });
  const child = new EventEmitter();
  child.stdin = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let wire, invocation, killed = false;
  child.kill = () => { killed = true; };
  child.stdin.end = (data, encoding) => { wire = Buffer.from(data, encoding); };
  const text = '知微\r\n\'"; $(保持原文)'.repeat(10000);
  const script = "if (!$p.text) { throw '没有剪贴板文本' }\n@{text=$p.text}";
  const pending = runPowerShell(script, { input:{ text, path:'C:\\Users\\Example\\中文 目录\\笔记.txt' }, spawn:(...args) => { invocation = args; return child; } });
  assert.ok(wire.every(byte => byte < 128));
  const payloads = [...wire.toString('ascii').matchAll(/FromBase64String\('([^']*)'\)/g)].map(m => Buffer.from(m[1], 'base64').toString('utf8'));
  assert.deepEqual(JSON.parse(payloads[0]), { text, path:'C:\\Users\\Example\\中文 目录\\笔记.txt' });
  assert.equal(payloads[1], script);
  assert.ok(invocation[1].join(' ').length < 32767);
  assert.equal(invocation[2].windowsHide, true);
  const response = Buffer.from('\uFEFF' + JSON.stringify({ text:'中文\r\n末尾换行\r\n' }) + '\r\n');
  const split = response.indexOf(Buffer.from('中')) + 1;
  child.stdout.write(response.subarray(0, split)); child.stdout.write(response.subarray(split));
  child.emit('close', 0);
  assert.deepEqual(await pending, { text:'中文\r\n末尾换行\r\n' });
  t.mock.timers.tick(20000); assert.equal(killed, false);
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'zhiwei-skills-'));
  t.after(() => fs.rm(root, {recursive:true,force:true}));
  const calls = [];
  const skills = new SystemSkills({workspace:root, homeDir:root, run:async (script, options) => { calls.push({script,input:options?.input}); return {launched:options?.input?.target || 'shortcut',level:42}; }});
  return {root,skills,calls};
}
test('open_app maps friendly names, searches Start Menu and refuses shells', async t => {
  const {skills,calls} = await fixture(t);
  for (const [name,target] of [['记事本','notepad.exe'],['calculator','calc.exe'],['paint','mspaint.exe'],['资源管理器','explorer.exe'],['浏览器','msedge.exe'],['设置','ms-settings:'],['任务管理器','taskmgr.exe']]) {
    const result = await skills.open_app({name});
    assert.equal(result.launched,target); assert.match(result.note,/UIA/);
    assert.deepEqual(calls.at(-1).input,{target}); assert.match(calls.at(-1).script,/Start-Process/);
  }
  await skills.open_app({name:'音乐'});
  assert.match(calls.at(-1).script,/ProgramData.*Start Menu/); assert.match(calls.at(-1).script,/APPDATA/);
  assert.match(calls.at(-1).script,/\*\.lnk/); assert.deepEqual(calls.at(-1).input,{name:'音乐'});
  const count = calls.length;
  for (const name of ['cmd','cmd.exe','PowerShell','Windows Terminal','regedit','终端','bash','wsl']) await assert.rejects(skills.open_app({name}),/不允许/);
  assert.equal(calls.length,count);
});
test('open_path expands known folders and refuses executables', async t => {
  const {root,skills,calls} = await fixture(t);
  await fs.mkdir(path.join(root,'Desktop')); await fs.writeFile(path.join(root,'bad.exe'),'');
  await assert.rejects(skills.open_path({path:'bad.exe'}),/不能/);
  await skills.open_path({path:'桌面'}); assert.equal(calls.at(-1).input.path,path.join(root,'Desktop'));
  assert.match(calls.at(-1).script,/explorer.exe/);
  await fs.writeFile(path.join(root,'note.txt'),'hello');
  await skills.open_path({path:'~/note.txt'}); assert.equal(calls.at(-1).input.path,path.join(root,'note.txt'));
  assert.match(calls.at(-1).script,/Start-Process -FilePath \$p.path/);
});
test('clipboard and volume pass data separately to PowerShell scripts', async t => {
  const {skills,calls} = await fixture(t);
  const text = '中文\n\'"; $(bad)';
  await skills.clipboard_write({text}); assert.deepEqual(calls.at(-1).input,{text});
  assert.match(calls.at(-1).script,/Set-Clipboard/); assert.ok(!calls.at(-1).script.includes(text));
  await skills.clipboard_read(); assert.match(calls.at(-1).script,/Get-Clipboard -Raw/);
  await skills.volume({action:'set',level:25}); assert.deepEqual(calls.at(-1).input,{action:'set',level:25});
  assert.match(calls.at(-1).script,/IAudioEndpointVolume|GetMasterVolumeLevelScalar/);
  assert.match(calls.at(-1).script,/SetMasterVolumeLevelScalar/); assert.match(calls.at(-1).script,/SetMute/);
  assert.equal((await skills.volume({action:'get'})).level,42);
  assert.throws(() => skills.volume({action:'set',level:101}),/0-100/);
});
test('search uses name contains/globs, default roots, limits and skips excluded directories', async t => {
  const {root,skills} = await fixture(t);
  for (const dir of ['Desktop','Documents','Downloads','node_modules','.git','.hidden','sub']) await fs.mkdir(path.join(root,dir));
  for (const file of ['Desktop/Report.TXT','Documents/report.pdf','Downloads/report.zip','report.md','node_modules/report.js','.git/report','.hidden/report','sub/other.txt']) await fs.writeFile(path.join(root,file),'abc');
  let result = await skills.search_files({query:'REPORT'});
  assert.equal(result.results.length,4); assert.ok(result.results.every(r => r.size===3 && !r.isDir && r.modified));
  result = await skills.search_files({query:'rep*.txt',folder:'Desktop'}); assert.equal(result.results.length,1);
  result = await skills.search_files({query:'report',limit:2}); assert.equal(result.results.length,2);
  let deep = root;
  for (let i=0;i<8;i++) { deep=path.join(deep,'nested'); await fs.mkdir(deep); }
  await fs.writeFile(path.join(deep,'report.txt'),'');
  assert.equal((await skills.search_files({query:'report',folder:root})).results.length,4);
});
test('organize previews without writes, applies without overwrite, and plans by month', async t => {
  const {root,skills} = await fixture(t);
  await fs.writeFile(path.join(root,'a.txt'),'new'); await fs.writeFile(path.join(root,'b.png'),'image');
  await fs.mkdir(path.join(root,'文档')); await fs.writeFile(path.join(root,'文档/a.txt'),'old');
  const before = await fs.readdir(root);
  const preview = await skills.organize_folder({folder:root,by:'type'});
  assert.equal(preview.moved.length,0); assert.deepEqual(await fs.readdir(root),before);
  assert.ok(preview.plan.some(m => m.to===path.join(root,'文档/a (2).txt')));
  const applied = await skills.organize_folder({folder:root,by:'type',apply:true});
  assert.equal(applied.moved.length,2); assert.equal(await fs.readFile(path.join(root,'文档/a.txt'),'utf8'),'old');
  assert.equal(await fs.readFile(path.join(root,'文档/a (2).txt'),'utf8'),'new');
  await fs.writeFile(path.join(root,'dated.txt'),''); await fs.utimes(path.join(root,'dated.txt'),new Date('2025-03-01'),new Date('2025-03-01'));
  const dated = await skills.organize_folder({folder:root,by:'date'}); assert.equal(dated.plan[0].to,path.join(root,'2025-03/dated.txt'));
});
test('move_path moves files and folders and refuses overwrite', async t => {
  const {root,skills} = await fixture(t);
  await fs.writeFile(path.join(root,'a'),'a'); await fs.writeFile(path.join(root,'b'),'b');
  await assert.rejects(skills.move_path({from:'a',to:'b'}),/禁止覆盖/);
  await skills.move_path({from:'a',to:'c'}); assert.equal(await fs.readFile(path.join(root,'c'),'utf8'),'a');
  await fs.mkdir(path.join(root,'dir')); await skills.move_path({from:'dir',to:'renamed'});
  assert.ok((await fs.stat(path.join(root,'renamed'))).isDirectory());
});
