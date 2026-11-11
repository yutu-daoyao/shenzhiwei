import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
const exec=promisify(execFile),root=fileURLToPath(new URL('../',import.meta.url));
const script=path.join(root,'scripts/open-zhiwei.ps1');
const launch=(port,extra=[],env={})=>exec('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-NoOpen','-Port',String(port),...extra],{cwd:root,windowsHide:true,timeout:45000,env:{...process.env,...env}});

test('one-click launcher starts once on concurrent clicks and reuses the live service', {skip:process.platform!=='win32',timeout:60000},async t=>{
  const probe=http.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const directory=await mkdtemp(path.join(tmpdir(),'zhiwei-launcher-')),pidFile=path.join(directory,'pid');
  t.after(async()=>{try{const pid=Number(await readFile(pidFile,'utf8'));if(Number.isInteger(pid)&&pid>0)await exec('taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true});}catch{}});
  const args=['-NodePath',process.execPath,'-EntryPath',path.join(root,'test/fixtures/launcher-server.mjs')],env={ZHIWEI_LAUNCH_TEST_PID_FILE:pidFile};
  const results=await Promise.all([launch(port,args,env),launch(port,args,env)]);
  assert.ok(results.every(result=>result.stdout.includes('Zhiwei ready:')));
  const pid=await readFile(pidFile,'utf8');await launch(port,args,env);assert.equal(await readFile(pidFile,'utf8'),pid);
  const state=await(await fetch(`http://127.0.0.1:${port}/api/state`)).json();assert.equal(state.workspace,path.join(root,'test-workspace'));
});

test('one-click launcher refuses a foreign service on the requested port', {skip:process.platform!=='win32',timeout:10000},async t=>{
  const server=http.createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end('{"workspace":"unrelated-app"}');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  await assert.rejects(launch(server.address().port),error=>error.code!==0&&/其他服务/.test(error.stderr));
});

test('one-click launcher reuses its workbench after the active project changes', {skip:process.platform!=='win32',timeout:15000},async t=>{
  const state={workspace:path.join(root,'another-project'),voice:{enabled:false},task:{status:'idle'},workbench:{projects:[{id:'default',cwd:path.join(root,'test-workspace')}]}};
  const server=http.createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(state));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const result=await launch(server.address().port,['-EntryPath',path.join(root,'does-not-exist.js')]);
  assert.match(result.stdout,/Zhiwei ready:/,'reuse succeeds without starting another backend');
  state.workbench.projects[0].cwd=path.join(root,'different-installation');
  await assert.rejects(launch(server.address().port),error=>error.code!==0&&/其他服务/.test(error.stderr));
});
