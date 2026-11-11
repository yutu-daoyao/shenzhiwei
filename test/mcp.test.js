import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Computer } from '../src/windows/computer.js';

class Backend extends EventEmitter {
  constructor(){super();this.pending=new Map();this.calls=[];}
  async call(op){
    this.calls.push(op);if(op==='desktop_status')return {locked:false};
    if(op==='launch_app')return new Promise((resolve,reject)=>{this.pending.set('launch',true);this.reject=reject;});
    return {};
  }
  cancel(){this.pending.clear();this.reject?.(new Error('mock effect unknown'));this.emit('exit');}
}
async function wait(predicate){for(let n=0;n<200;n++){if(predicate())return;await delay(15);}assert.fail('MCP state wait timed out');}
async function setup(t,shortTimeout=false){
  const parent=fileURLToPath(new URL('../test-workspace/',import.meta.url));await mkdir(parent,{recursive:true});
  const workspace=await mkdtemp(path.join(parent,'mcp-test-')),backend=new Backend(),computer=new Computer({workspace,backend});await computer.start();computer.beginTurn();t.after(()=>computer.close());
  const args=shortTimeout?['--import',new URL('./fixtures/mcp-timeout.mjs',import.meta.url).href]:[];
  args.push(fileURLToPath(new URL('../src/windows/mcp-server.js',import.meta.url)));
  const child=spawn(process.execPath,args,{env:{...process.env,ZHIWEI_WINDOWS_URL:computer.url,ZHIWEI_WINDOWS_CAPABILITY:computer.secret},stdio:['pipe','pipe','pipe'],windowsHide:true});t.after(()=>child.kill());child.stdin.on('error',()=>{});child.stderr.resume();
  const replies=[],pending=new Map(),diagnostics=[];child.stderr.on('data',chunk=>diagnostics.push(chunk.toString()));
  readline.createInterface({input:child.stdout}).on('line',line=>{const response=JSON.parse(line);replies.push(response);pending.get(response.id)?.(response);pending.delete(response.id);});
  const send=message=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n');
  const request=(id,method,params={})=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('MCP reply timeout: '+diagnostics.join('')));},4000);pending.set(id,message=>{clearTimeout(timer);resolve(message);});send({id,method,params});});
  await request('init','initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'offline-test',version:'1'}});
  const start=()=>{computer.expectInvocation('windows_launch_app',{app:'notepad'});send({id:0,method:'tools/call',params:{name:'windows_launch_app',arguments:{app:'notepad'}}});};
  const cancel=requestId=>send({method:'notifications/cancelled',params:{requestId}});
  return {computer,backend,child,replies,request,send,start,cancel};
}
test('MCP cancellation preserves ID types, ignores malformed notices and cancels queued approval without a late response',async t=>{
  const m=await setup(t);m.start();await wait(()=>m.computer.pending.size===1);const approval=[...m.computer.pending.keys()][0];
  m.cancel('0');m.send({method:'notifications/cancelled',params:{}});m.cancel('unknown');await m.request('barrier','ping');assert.equal(m.computer.pending.size,1);
  m.cancel(0);await m.request('cancelled-barrier','ping');await wait(()=>!m.computer.active&&m.computer.pending.size===0);await delay(40);
  assert.ok(!m.replies.some(r=>r.id===0));assert.ok(!m.backend.calls.includes('launch_app'));assert.throws(()=>m.computer.approve(approval,'accept'),/失效/);
});
test('MCP cancellation during a dispatched action closes the gate and preserves unknown effects',async t=>{
  const m=await setup(t);m.start();await wait(()=>m.computer.pending.size===1);m.computer.approve([...m.computer.pending.keys()][0],'accept');await wait(()=>m.backend.pending.size===1);
  m.cancel(0);await m.request('barrier','ping');await wait(()=>!m.computer.active&&[...m.computer.actions.values()].some(a=>a.status==='unknown'));assert.equal(m.backend.pending.size,0);assert.equal(m.backend.calls.filter(op=>op==='launch_app').length,1);
  assert.throws(()=>m.computer.call('windows_launch_app',{app:'notepad'}),/停止/);await delay(40);assert.ok(!m.replies.some(r=>r.id===0));
});
test('MCP stdin closure aborts outstanding fetches and exits without approving or reporting cancelled requests',async t=>{
  const m=await setup(t);m.start();await wait(()=>m.computer.pending.size===1);const exited=once(m.child,'close');m.child.stdin.end();await exited;
  await wait(()=>!m.computer.active&&m.computer.pending.size===0);assert.ok(!m.backend.calls.includes('launch_app'));assert.ok(!m.replies.some(r=>r.id===0));
});
test('MCP deadline aborts the broker request, reports uncertain results and never retries',async t=>{
  const m=await setup(t,true);m.computer.expectInvocation('windows_launch_app',{app:'notepad'});
  const reply=m.request(0,'tools/call',{name:'windows_launch_app',arguments:{app:'notepad'}});await wait(()=>m.computer.pending.size===1);
  const result=await reply;assert.equal(result.error.code,-32603);assert.match(result.error.message,/结果可能未知.*禁止自动重放/);assert.equal(result.error.data.safeToRetry,false);await wait(()=>!m.computer.active&&m.computer.pending.size===0);
  assert.ok(!m.backend.calls.includes('launch_app'));assert.equal(m.computer.actions.size,1);
});
test('duplicate in-flight MCP request IDs dispatch at most one operation',async t=>{
  const m=await setup(t);m.start();await wait(()=>m.computer.pending.size===1);m.send({id:0,method:'tools/call',params:{name:'windows_launch_app',arguments:{app:'notepad'}}});await m.request('barrier','ping');
  assert.equal(m.computer.actions.size,1);assert.equal(m.computer.pending.size,1);m.cancel(0);await wait(()=>!m.computer.active);
});
