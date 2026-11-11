import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Computer } from '../src/windows/computer.js';
import { validate } from '../src/windows/tools.js';
import { WindowsBackend } from '../src/windows/backend.js';
import { WindowsJournal } from '../src/windows/journal.js';

class Backend extends EventEmitter {
  constructor() { super(); this.calls=[]; this.pending=new Map(); }
  async call(op,params) {
    this.calls.push({op,params});
    if(op==='desktop_status')return {locked:!!this.locked};
    if(op==='launch_app') return {window:{id:'123',pid:8,title:'test',className:'Notepad'},app:params.app};
    if(op==='get_window') return {window:{id:params.windowId,pid:8,title:'Fresh test window',className:'Notepad'}};
    if(op==='get_ui_tree') return {window:{id:'123'},elements:[],snapshot:'snapshot'};
    if(op==='capture_window') return {window:{id:'123',bounds:{x:0,y:0,width:100,height:100}},width:100,height:100,data:'aW1hZ2U=',mimeType:'image/png'};
    return {window:{id:'123'},source:'mock',windows:[]};
  }
  cancel(){this.cancelled=true;}
}
async function create(t,backend=new Backend()) {
  const workspace=await mkdtemp(path.join(tmpdir(),'zhiwei-computer-'));
  const c=new Computer({workspace,backend}); await c.start(); c.beginTurn(); t.after(()=>c.close());return c;
}
async function wait(predicate) { for(let n=0;n<200;n++){if(predicate())return;await delay(10);}assert.fail('timeout'); }
const unpack=result=>JSON.parse(result.content[0].text);
test('strict tool schemas reject program injection, foreign paths, unknown keys and out-of-range input',()=>{
  assert.throws(()=>validate('windows_launch_app',{app:'powershell'}));
  assert.throws(()=>validate('windows_launch_app',{app:'notepad',command:'evil'}));
  assert.throws(()=>validate('windows_save_notepad',{windowId:'123',filename:'../personal.txt'}));
  assert.throws(()=>validate('windows_send_keys',{windowId:'123',key:'Win+R'}));
  assert.throws(()=>validate('windows_set_text',{windowId:'123',snapshot:'a',elementId:'1',text:'x'.repeat(10001)}));
  for(const filename of ['CON.txt','prn.txt','AUX.txt','NUL.txt','COM1.txt','LPT9.txt']) assert.throws(()=>validate('windows_save_notepad',{windowId:'123',filename}),/保留/);
});
test('explicit one-action approval, owned-window guard, denial and cancellation of queued side effects',async t=>{
  const c=await create(t);
  const launching=c.call('windows_launch_app',{app:'notepad'});
  await wait(()=>c.pending.size===1); assert.equal(c.backend.calls.filter(c=>c.op!=='desktop_status').length,0);
  c.approve([...c.pending.keys()][0],'accept'); assert.equal(unpack(await launching).ok,true);
  assert.equal(unpack(await c.call('windows_get_window',{windowId:'999'})).ok,false);
  const first=c.call('windows_send_keys',{windowId:'123',key:'Ctrl+A'});
  const second=c.call('windows_send_keys',{windowId:'123',key:'Enter'});
  await wait(()=>c.pending.size===1); c.cancel();
  assert.equal(unpack(await first).status,'cancelled'); assert.equal(unpack(await second).status,'cancelled');
  assert.equal(c.backend.calls.filter(call=>call.op==='send_keys').length,0);
  assert.throws(()=>c.call('windows_launch_app',{app:'notepad'}),/停止/);
});
test('screenshots require separate authorization; image content is not replaced by text or retained in action logs',async t=>{
  const c=await create(t); c.owned.set('123',{id:'123',app:'notepad'});
  const pending=c.call('windows_capture_window',{windowId:'123'}); await wait(()=>c.pending.size===1);
  assert.equal(c.snapshot().approvals[0].risk,'screenshot-to-Codex'); assert.ok(!c.backend.calls.some(c=>c.op==='capture_window'));
  c.approve([...c.pending.keys()][0],'accept'); const result=await pending;
  assert.equal(result.content[1].type,'image'); assert.equal(result.content[1].data,'aW1hZ2U=');
  assert.ok(!JSON.stringify(c.snapshot()).includes('aW1hZ2U='));
});
test('loopback broker rejects missing capability, wrong Origin and stale-turn calls',async t=>{
  const c=await create(t);
  const body=JSON.stringify({name:'windows_list_windows',arguments:{}});
  assert.equal((await fetch(c.url,{method:'POST',body})).status,403);
  assert.equal((await fetch(c.url,{method:'POST',headers:{Authorization:`Bearer ${c.secret}`,Origin:'https://example.invalid'},body})).status,403);
  c.cancel();const reply=await fetch(c.url,{method:'POST',headers:{Authorization:`Bearer ${c.secret}`},body});
  assert.equal((await reply.json()).isError,true); assert.equal(c.backend.calls.length,0);
});
test('real stdio MCP handshake, tool discovery and result delivery pass through the host gate',async t=>{
  const c=await create(t);
  const child=spawn(process.execPath,[fileURLToPath(new URL('../src/windows/mcp-server.js',import.meta.url))],{env:{...process.env,ZHIWEI_WINDOWS_URL:c.url,ZHIWEI_WINDOWS_CAPABILITY:c.secret},stdio:['pipe','pipe','pipe'],windowsHide:true});
  t.after(()=>child.kill());const pending=new Map();
  readline.createInterface({input:child.stdout}).on('line',line=>{const m=JSON.parse(line);pending.get(m.id)?.(m);});
  let id=0;const call=(method,params)=>new Promise(resolve=>{pending.set(++id,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  assert.equal((await call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'1'}})).result.serverInfo.name,'zhiwei-windows');
  assert.ok((await call('tools/list',{})).result.tools.some(t=>t.name==='windows_set_text'));
  c.expectInvocation('windows_list_windows',{});
  assert.equal(unpack((await call('tools/call',{name:'windows_list_windows',arguments:{}})).result).ok,true);
});
test('locked desktop blocks observation and mutation before permission or any UI operation',async t=>{
  const c=await create(t);c.backend.locked=true;
  const result=unpack(await c.call('windows_launch_app',{app:'notepad'}));
  assert.equal(result.ok,false);assert.match(result.error,/锁屏/);assert.equal(c.pending.size,0);
  assert.deepEqual(c.backend.calls.map(c=>c.op),['desktop_status']);
  assert.equal(unpack(await c.call('windows_get_desktop_status',{})).locked,true);
});
test('stop cancels an in-flight backend and reports unknown instead of claiming rollback',async t=>{
  const c=await create(t);c.owned.set('123',{id:'123',app:'notepad'});
  const original=c.backend.call.bind(c.backend);let rejectOperation;let dispatched=0;
  c.backend.call=(op,params)=>{
    if(op!=='focus_window')return original(op,params);
    dispatched++;c.backend.pending.set('active',true);return new Promise((_,reject)=>{rejectOperation=reject;});
  };
  c.backend.cancel=()=>{c.backend.pending.clear();rejectOperation?.(new Error('operation cancelled; effect unknown'));};
  const result=c.call('windows_focus_window',{windowId:'123'});await wait(()=>c.pending.size===1);
  c.approve([...c.pending.keys()][0],'accept');await wait(()=>dispatched===1);
  c.cancel();assert.equal(unpack(await result).status,'unknown');assert.equal(dispatched,1);assert.equal(c.active,false);
});
test('a late desktop check from an old Turn cannot dispatch reads or create new approvals',async t=>{
  for(const name of ['windows_get_window','windows_focus_window']) {
    const c=await create(t);c.owned.set('123',{id:'123',app:'notepad'});
    const original=c.backend.call.bind(c.backend);let release;
    c.backend.call=(op,params)=>op==='desktop_status'?new Promise(resolve=>{release=resolve;}):original(op,params);
    const result=c.call(name,{windowId:'123'});await wait(()=>!!release);
    c.cancel();c.beginTurn();release({locked:false});
    assert.equal(unpack(await result).status,'cancelled');assert.equal(c.pending.size,0);
    assert.equal(c.backend.calls.length,0);
  }
});
test('stop during control revalidation cannot leave an orphan approval or dispatch text',async t=>{
  const c=await create(t);c.owned.set('123',{id:'123',app:'notepad'});
  const original=c.backend.call.bind(c.backend);let release;
  c.backend.call=(op,params)=>op==='describe_element'?new Promise(resolve=>{release=resolve;}):original(op,params);
  const result=c.call('windows_set_text',{windowId:'123',snapshot:'snapshot',elementId:'2',text:'test'});
  await wait(()=>!!release);c.cancel();release({name:'editor'});
  assert.equal(unpack(await result).status,'cancelled');assert.equal(c.pending.size,0);
  assert.ok(!c.backend.calls.some(c=>c.op==='set_text'));
});
test('stop during worker rebinding cancels before approval or any side effect',async t=>{
  const c=await create(t);c.owned.set('123',{id:'123',app:'notepad'});
  const original=c.backend.call.bind(c.backend);let release;
  c.backend.call=(op,params)=>op==='register_windows'?new Promise(resolve=>{release=resolve;}):original(op,params);
  const result=c.call('windows_focus_window',{windowId:'123'});await wait(()=>!!release);assert.equal(c.pending.size,0);
  c.cancel();release({registered:1});
  assert.equal(unpack(await result).status,'cancelled');assert.ok(!c.backend.calls.some(c=>c.op==='focus_window'));
});

test('approval uses freshly observed window identity and stop during observation creates no orphan approval',async t=>{
  const c=await create(t);c.owned.set('123',{id:'123',app:'notepad',title:'STALE TITLE'});
  const closing=c.call('windows_close_window',{windowId:'123'});await wait(()=>c.pending.size===1);
  const approval=c.snapshot().approvals[0];assert.equal(approval.target.window.title,'Fresh test window');assert.equal(approval.target.window.pid,8);assert.ok(approval.target.observedAt);assert.equal(approval.risk,'high');
  c.approve(approval.id,'decline');await closing;assert.ok(!c.backend.calls.some(call=>call.op==='close_window'));
  const original=c.backend.call.bind(c.backend);let release;
  c.backend.call=(op,params)=>op==='get_window'?new Promise(resolve=>{release=resolve;}):original(op,params);
  const pending=c.call('windows_send_keys',{windowId:'123',key:'Enter'});await wait(()=>!!release);c.cancel();release({window:{id:'123',title:'late'}});
  assert.equal(unpack(await pending).status,'cancelled');assert.equal(c.pending.size,0);assert.ok(!c.backend.calls.some(call=>call.op==='send_keys'));
});
test('stop between capture preflight and capture does not collect an image',async t=>{
  const c=await create(t);c.owned.set('123',{id:'123',app:'notepad'});
  const original=c.backend.call.bind(c.backend);let release;
  c.backend.call=(op,params)=>op==='get_ui_tree'?new Promise(resolve=>{release=resolve;}):original(op,params);
  const result=c.call('windows_capture_window',{windowId:'123'});await wait(()=>c.pending.size===1);
  c.approve([...c.pending.keys()][0],'accept');await wait(()=>!!release);c.cancel();release({snapshot:'old'});
  assert.equal(unpack(await result).status,'unknown');assert.ok(!c.backend.calls.some(c=>c.op==='capture_window'));
});
test('save writes UIA text and rejects missing evidence, overwrite and oversized text',async t=>{
  const c=await create(t);c.owned.set('123',{id:'123',app:'notepad',documentName:'original.txt'});
  const original=c.backend.call.bind(c.backend);let saveCount=0;
  const text='知微测试\r\n第二行\r\n';
  c.backend.call=async(op,params)=>{
    if(op!=='save_notepad')return original(op,params);
    saveCount++;
    return {expectedText:params.filename==='missing.txt'?null:params.filename==='oversized.txt'?'中'.repeat(350000):params.filename==='cr.txt'?'甲\r乙':text};
  };
  async function save(filename) {
    const result=c.call('windows_save_notepad',{windowId:'123',filename});await wait(()=>c.pending.size===1);
    c.approve([...c.pending.keys()][0],'accept');return unpack(await result);
  }
  const result=await save('utf8.txt');assert.equal(result.ok,true);assert.equal(result.verified,true);assert.equal(result.text,text);
  assert.equal(result.path,path.join(c.workspace,'utf8.txt'));assert.equal(result.source,'UIAutomation.ValuePattern+fs.writeFile(wx)+read-back');
  assert.deepEqual(await readFile(result.path),Buffer.from(text,'utf8'));assert.equal(c.owned.get('123').documentName,'original.txt');
  const bare=await save('cr.txt');assert.equal(bare.ok,true);assert.equal(await readFile(bare.path,'utf8'),'甲\r\n乙');
  const missing=await save('missing.txt');assert.equal(missing.status,'unknown');assert.match(missing.error,/真实 UIA 文本/);
  await assert.rejects(readFile(path.join(c.workspace,'missing.txt')),{code:'ENOENT'});await c.resolveAction(missing.actionId,'partial');
  await writeFile(path.join(c.workspace,'keep.txt'),'original');
  const before=saveCount;const existing=await save('keep.txt');assert.equal(existing.ok,false);assert.match(existing.error,/目标文件已存在/);assert.equal(saveCount,before);
  assert.equal(await readFile(path.join(c.workspace,'keep.txt'),'utf8'),'original');await c.resolveAction(existing.actionId,'partial');
  const oversized=await save('oversized.txt');assert.equal(oversized.status,'unknown');assert.match(oversized.error,/1 MiB/);
  await assert.rejects(readFile(path.join(c.workspace,'oversized.txt')),{code:'ENOENT'});
});
test('a replaced workspace junction is rejected before app launch', {skip:process.platform!=='win32'},async t=>{
  const c=await create(t);const elsewhere=await mkdtemp(path.join(tmpdir(),'zhiwei-other-'));
  await rename(c.workspace,c.workspace+'-original');await symlink(elsewhere,c.workspace,'junction');
  const result=c.call('windows_launch_app',{app:'notepad'});await wait(()=>c.pending.size===1);
  c.approve([...c.pending.keys()][0],'accept');const value=unpack(await result);
  assert.equal(value.ok,false);assert.match(value.error,/目录|重定向/);assert.ok(!c.backend.calls.some(c=>c.op==='launch_app'));
});
function worker(t) {
  const backend=new WindowsBackend({command:process.execPath,args:[fileURLToPath(new URL('./fixtures/windows-worker.mjs',import.meta.url))]});
  t.after(()=>backend.cancel());return backend;
}
test('worker timeout retains its real cause and old child output cannot break a replacement',async t=>{
  const b=worker(t);assert.deepEqual(await b.call('echo',{text:'你好'}),{text:'你好'});
  const old=b.child;
  await assert.rejects(b.call('timeout',{},40),/超时/);assert.equal(b.pending.size,0);assert.equal(b.child,null);
  const replacement=b.call('echo',{text:'new worker'});
  old.stdout.emit('data','broken old output\n');old.stderr.emit('data',Buffer.from('old diagnostic'));
  assert.deepEqual(await replacement,{text:'new worker'});assert.equal(b.diagnostic,'');
});
test('invalid worker protocol and unexpected exit fail pending requests without crashing the host',async t=>{
  const b=worker(t);await assert.rejects(b.call('invalid',{}),/无效响应/);assert.equal(b.child,null);
  await assert.rejects(b.call('exit',{}),/退出/);assert.equal(b.pending.size,0);
  assert.deepEqual(await b.call('echo',{recovered:true}),{recovered:true});
});

const proof={id:'123',pid:8,processStartedAt:'2026-10-29T00:00:00.000Z',className:'Notepad',app:'notepad',documentName:'safe.txt',tabRuntimeId:'1,2,3'};
test('journal stores metadata only and reconciles interrupted operations on restart',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'zhiwei-journal-'));const journal=new WindowsJournal(directory);await journal.load('workspace');
  await journal.save('workspace',[
    {id:'running',tool:'windows_set_text',status:'running',params:{text:'DO_NOT_STORE'},error:'DO_NOT_STORE',scope:{windowId:'123',text:'DO_NOT_STORE'}},
    {id:'queued',tool:'windows_launch_app',status:'queued'},
    {id:'approval',tool:'windows_focus_window',status:'awaitingApproval'}
  ],[{id:'binding',proof:{...proof,title:'DO_NOT_STORE'},status:'saved',title:'DO_NOT_STORE'}]);
  assert.ok(!(await readFile(journal.file,'utf8')).includes('DO_NOT_STORE'));
  const saved=await journal.load('workspace');assert.deepEqual(saved.actions.map(a=>a.status),['unknown','cancelled','cancelled']);assert.equal(saved.bindings[0].proof.processStartedAt,proof.processStartedAt);
});
test('restarted bindings require fresh identity validation and explicit approval before control',async t=>{
  const workspace=await mkdtemp(path.join(tmpdir(),'zhiwei-binding-'));const dataDir=path.join(workspace,'state');
  const backend=new Backend();const original=backend.call.bind(backend);
  backend.call=async(op,params)=>{if(op==='launch_app'||op==='inspect_binding'||op==='get_window'){backend.calls.push({op,params});if(backend.stale&&op==='inspect_binding')throw new Error('WINDOW_CHANGED');return {window:{...proof,title:'Dedicated test window'}};}return original(op,params);};
  const first=new Computer({workspace,dataDir,backend});await first.start();first.beginTurn();
  const launch=first.call('windows_launch_app',{app:'notepad'});await wait(()=>first.pending.size===1);first.approve([...first.pending.keys()][0],'accept');const bindingId=unpack(await launch).bindingId;await first.close();
  const next=new Computer({workspace,dataDir,backend});await next.start();next.beginTurn();t.after(()=>next.close());
  assert.equal(next.owned.size,0);assert.equal(unpack(await next.call('windows_list_saved_windows',{})).windows[0].status,'needsApproval');
  const restore=next.call('windows_restore_window',{bindingId});await wait(()=>next.pending.size===1);
  assert.equal(next.snapshot().approvals[0].risk,'high');assert.equal(next.owned.size,0);next.approve([...next.pending.keys()][0],'accept');
  assert.equal(unpack(await restore).restored,true);assert.equal(next.owned.get('123').processStartedAt,proof.processStartedAt);
  backend.stale=true;const rejected=unpack(await next.call('windows_restore_window',{bindingId}));assert.match(rejected.error,/WINDOW_CHANGED/);assert.equal(next.pending.size,0);
});
test('unresolved mutations remain visible and block replay until the operator records a result',async t=>{
  const c=await create(t);c.owned.set('123',{...proof});
  c.actions.set('unknown',{id:'unknown',tool:'windows_set_text',status:'unknown',scope:{windowId:'123'}});
  for(let n=0;n<65;n++)await c.call('windows_get_window',{windowId:'123'});
  assert.ok(c.snapshot().actions.find(a=>a.id==='unknown')?.needsReview);
  const blocked=unpack(await c.call('windows_focus_window',{windowId:'123'}));assert.equal(blocked.ok,false);assert.match(blocked.error,/先.*核实/);assert.equal(c.pending.size,0);
  await c.resolveAction('unknown','partial');assert.equal(c.actions.get('unknown').status,'unknown');assert.equal(c.actions.get('unknown').resolution,'partial');
  const pending=c.call('windows_focus_window',{windowId:'123'});await wait(()=>c.pending.size===1);c.approve([...c.pending.keys()][0],'decline');await pending;
  assert.ok(!c.backend.calls.some(call=>call.op==='focus_window'));
});
test('a damaged Windows journal is preserved and disables controls without crashing the broker',async t=>{
  const workspace=await mkdtemp(path.join(tmpdir(),'zhiwei-corrupt-'));const dataDir=path.join(workspace,'state');const journal=new WindowsJournal(dataDir);await journal.load(workspace);await writeFile(journal.file,'invalid JSON');
  const c=new Computer({workspace,dataDir,backend:new Backend()});await c.start();c.beginTurn();t.after(()=>c.close());
  assert.ok(c.snapshot().storageError);assert.throws(()=>c.call('windows_launch_app',{app:'notepad'}),/记录/);assert.ok(unpack(await c.call('windows_list_saved_windows',{})).storageError);
  assert.equal(await readFile(journal.file,'utf8'),'invalid JSON');
});

class RegistryBackend extends EventEmitter {
  constructor(){super();this.calls=[];this.pending=new Map();this.windows=new Map();this.registered=new Map();}
  verify(window){
    const actual=this.windows.get(window?.id);if(!actual)throw new Error('WINDOW_CLOSED');
    if(['pid','processStartedAt','className'].some(k=>actual[k]!==window[k]))throw new Error('WINDOW_CHANGED');
    if(actual.tabRuntimeId!==window.tabRuntimeId)throw new Error('ACTIVE_DOCUMENT_CHANGED');return actual;
  }
  restart(){this.registered.clear();this.emit('exit');}
  cancel(){this.restart();}
  async call(op,params){
    this.calls.push({op,params});
    if(op==='desktop_status')return {locked:false};
    if(op==='list_windows')return {windows:[...this.windows.values()]};
    if(op==='inspect_binding')return {window:{...this.verify(params.window)}};
    if(op==='register_windows'){for(const w of params.windows){this.verify(w);this.registered.set(w.id,{...w});}return {registered:this.registered.size};}
    if(op==='launch_app'){const window={...this.next,app:params.app};this.windows.set(window.id,window);this.registered.set(window.id,window);return {window};}
    const actual=this.verify(this.registered.get(params.windowId));return {window:{...actual}};
  }
}
async function registry(t,windows){
  const backend=new RegistryBackend(),c=await create(t,backend);
  for(const window of windows){backend.windows.set(window.id,{...window});c.owned.set(window.id,{...window});c.rememberWindow(window);}return c;
}
async function accept(c,job){await wait(()=>c.pending.size===1);c.approve([...c.pending.keys()][0],'accept');return unpack(await job);}
test('worker recovery registers only the requested live window and a new launch does not hide other missing registrations',async t=>{
  const a={...proof},b={...proof,id:'456',pid:9},c=await registry(t,[a,b]);c.backend.windows.delete(b.id);
  assert.equal(unpack(await c.call('windows_get_window',{windowId:a.id})).ok,true);
  assert.deepEqual(c.backend.calls.filter(x=>x.op==='register_windows').map(x=>x.params.windows.map(w=>w.id)),[[a.id]]);
  await c.call('windows_get_window',{windowId:a.id});assert.equal(c.backend.calls.filter(x=>x.op==='register_windows').length,1);
  c.backend.restart();c.backend.next={...proof,id:'789',pid:10,className:'Calculator',tabRuntimeId:null};
  assert.equal((await accept(c,c.call('windows_launch_app',{app:'calculator'}))).ok,true);
  assert.equal(unpack(await c.call('windows_get_window',{windowId:a.id})).ok,true);
  assert.deepEqual(c.backend.calls.filter(x=>x.op==='register_windows').map(x=>x.params.windows.map(w=>w.id)),[[a.id],[a.id]]);
  assert.equal(unpack(await c.call('windows_get_window',{windowId:b.id})).ok,false);assert.equal(c.savedWindows().find(w=>w.app==='notepad'&&w.id!==c.savedWindows()[0].id)?.status,'closed');
});
test('observed closure clears current window and a changed document needs explicit restoration',async t=>{
  const c=await registry(t,[proof]);const bindingId=c.savedWindows()[0].id;
  await c.call('windows_get_window',{windowId:proof.id});c.backend.windows.get(proof.id).tabRuntimeId='different-document';
  const changed=unpack(await c.call('windows_get_window',{windowId:proof.id}));assert.match(changed.error,/ACTIVE_DOCUMENT_CHANGED/);assert.equal(c.owned.size,0);assert.equal(c.currentWindow,null);assert.equal(c.savedWindows()[0].status,'needsApproval');
  c.backend.windows.set(proof.id,{...proof});assert.equal((await accept(c,c.call('windows_restore_window',{bindingId}))).restored,true);
  c.backend.windows.delete(proof.id);await c.call('windows_get_window',{windowId:proof.id});assert.equal(c.savedWindows()[0].status,'closed');assert.equal(c.currentWindow,null);
});
test('a reused HWND gets a separate binding and failed restoration of the old proof cannot revoke the new window',async t=>{
  const c=await registry(t,[proof]),oldId=c.savedWindows()[0].id;
  await c.call('windows_get_window',{windowId:proof.id});c.backend.next={...proof,pid:19,processStartedAt:'2026-10-29T01:00:00Z',tabRuntimeId:'new-tab'};
  const fresh=await accept(c,c.call('windows_launch_app',{app:'notepad'}));assert.notEqual(fresh.bindingId,oldId);assert.equal(c.savedWindows().find(w=>w.id===oldId).status,'closed');
  c.bindings.get(oldId).status='saved'; // Simulate a stale catalog entry beside a newer owned window.
  const restored=unpack(await c.call('windows_restore_window',{bindingId:oldId}));assert.match(restored.error,/WINDOW_CHANGED/);assert.equal(c.owned.get(proof.id).pid,19);
  assert.equal(c.savedWindows().find(w=>w.id===fresh.bindingId).status,'bound');assert.equal(unpack(await c.call('windows_get_window',{windowId:proof.id})).ok,true);
});
test('queued control never switches to a newer window that reused its target handle',async t=>{
  const c=await registry(t,[proof]);c.backend.next={...proof,pid:30,processStartedAt:'2026-10-29T02:00:00Z',tabRuntimeId:'new'};
  const launch=c.call('windows_launch_app',{app:'notepad'}),stale=c.call('windows_close_window',{windowId:proof.id});
  assert.equal((await accept(c,launch)).ok,true);const result=unpack(await stale);assert.match(result.error,/WINDOW_CHANGED/);assert.equal(c.owned.get(proof.id).pid,30);assert.equal(c.pending.size,0);assert.ok(!c.backend.calls.some(x=>x.op==='close_window'));
});
test('a registration response from an exited worker cannot populate the replacement cache',async t=>{
  const c=await registry(t,[proof]),original=c.backend.call.bind(c.backend);let restart=true;
  c.backend.call=async(op,params)=>{const result=await original(op,params);if(op==='register_windows'&&restart){restart=false;c.backend.restart();}return result;};
  const first=unpack(await c.call('windows_get_window',{windowId:proof.id}));assert.match(first.error,/登记结果无效/);assert.equal(c.backend.calls.filter(x=>x.op==='register_windows').length,1);assert.ok(!c.backend.calls.some(x=>x.op==='get_window'));
  assert.equal(unpack(await c.call('windows_get_window',{windowId:proof.id})).ok,true);assert.equal(c.backend.calls.filter(x=>x.op==='register_windows').length,2);
});
test('PowerShell registration dispatcher preserves the prior proof when a proposed proof fails validation',{skip:process.platform!=='win32'},async()=>{
  const result=await promisify(execFile)('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./fixtures/registration.ps1',import.meta.url))],{windowsHide:true,timeout:10000});
  assert.deepEqual(JSON.parse(result.stdout.trim()),{rejected:2,oldPreserved:true,newRemoved:true,validAdded:true});
});

test('save-field verification waits for delayed input, rejects mismatch/lock and routes only bounded modal Escape',{skip:process.platform!=='win32'},async()=>{
  const result=await promisify(execFile)('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./fixtures/save-dialog.ps1',import.meta.url))],{windowsHide:true,timeout:12000});
  assert.deepEqual(JSON.parse(result.stdout.trim()),{delayedMatch:true,wrongRejected:true,lockedRejected:true,noReadWhileLocked:true,cancelRouted:true,otherKeyBlocked:true});
});

test('unknown save permits one separately approved Escape recovery but still blocks save replay',async t=>{
  const c=await create(t);c.owned.set('123',{...proof});c.actions.set('uncertain',{id:'uncertain',tool:'windows_save_notepad',status:'unknown',scope:{windowId:'123'}});
  const recovery=c.call('windows_send_keys',{windowId:'123',key:'Escape'});await wait(()=>c.pending.size===1);assert.ok(!c.backend.calls.some(x=>x.op==='send_keys'));c.approve([...c.pending.keys()][0],'accept');assert.equal(unpack(await recovery).ok,true);
  assert.equal(c.actions.get('uncertain').status,'unknown');assert.equal(c.actions.get('uncertain').resolution,undefined);
  const replay=unpack(await c.call('windows_save_notepad',{windowId:'123',filename:'retry.txt'}));assert.equal(replay.ok,false);assert.match(replay.error,/核实/);assert.equal(c.pending.size,0);
});

test('a lock detected inside a worker action updates desktop status without another observation',async t=>{
  const c=await create(t);c.owned.set('123',{...proof});const original=c.backend.call.bind(c.backend);
  c.backend.call=async(op,params)=>{if(op==='register_windows')throw new Error('DESKTOP_LOCKED');return original(op,params);};
  const result=unpack(await c.call('windows_focus_window',{windowId:'123'}));assert.equal(result.ok,false);assert.equal(c.snapshot().desktop.locked,true);assert.equal(c.pending.size,0);assert.ok(!c.backend.calls.some(x=>x.op==='focus_window'));
});
