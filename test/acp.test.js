import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import http from 'node:http';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {AcpExecutor} from '../src/workbench/acp.js';
import {OpenCodeExecutor} from '../src/workbench/opencode.js';
import {dshDesktopModel,AcpProcess} from '../src/workbench/acp-process.js';
import {OpenCodeProcess} from '../src/workbench/opencode-process.js';
import {PiProcess} from '../src/workbench/pi-process.js';
import piApproval from '../src/workbench/pi-approval.js';
test('DSH inherits only the explicit desktop model block, never unrelated config or executable YAML',()=>{
  assert.deepEqual(dshDesktopModel('- id: other\n  config:\n    provider: wrong\n- id: agent-default-model\n  config:\n    provider: deepseek-account\n    model: deepseek-flash\n    apiKey: DO_NOT_COPY\n- id: ui-settings\n  config:\n    model: wrong'),{provider:'deepseek-account',model:'deepseek-flash'});
  assert.equal(dshDesktopModel('- id: agent-default-model\n  config:\n    provider: !!js process.env.PROVIDER\n    model: unknown'),null);
});
const config={configOptions:[
  {id:'model',category:'model',currentValue:'configured-model',options:[{group:'provider',options:[{value:'configured-model',name:'当前配置模型'},{value:'another-model',name:'另一个模型'}]}]},
  {id:'reasoning_effort',category:'thought_level',currentValue:'low',options:[{value:'low',name:'Low'},{value:'high',name:'High'}]},
]};
class FakeAcp extends EventEmitter{
  constructor(){super();this.calls=[];this.pending=[];this.responses=[];this.counter=0;this.configOptions=config.configOptions;}
  async start(){}async stop(){this.stopped=true;if(this.stopFails)throw Error('owned process remains');}
  async request(method,params){this.calls.push({method,params});
    if(method==='initialize')return {agentCapabilities:{sessionCapabilities:{resume:{}}}};
    if(method==='session/new'){if(this.blockNew)await this.blockNew;return {sessionId:'session-'+(++this.counter),...config};}
    if(method==='session/resume')return config;
    if(method==='session/set_config_option'){
      this.configOptions=this.configOptions.map(option=>option.id===params.configId?{...option,currentValue:params.value}:option);
      return {configOptions:this.configOptions};
    }
    if(method==='session/prompt')return new Promise((resolve,reject)=>this.pending.push({params,resolve,reject}));
    throw Error('Unexpected '+method);
  }
  notify(method){if(method==='session/cancel'&&!this.cancelHangs)this.pending.at(-1)?.resolve({stopReason:'cancelled'});}
  respond(id,result){this.responses.push({id,result});}
  rejectRequest(id){this.responses.push({id,rejected:true});}
  update(sessionId,update){this.emit('notification',{method:'session/update',params:{sessionId,update}});}
}
async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'zhiwei-acp-')),transport=new FakeAcp(),agent=new AcpExecutor({agent:'dsh',workspace:root,dataDir:path.join(root,'data'),transport,stopTimeoutMs:15});t.after(async()=>{await agent.close().catch(()=>{});if(path.dirname(path.resolve(root))!==path.resolve(tmpdir()))throw Error('Unexpected cleanup');await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});await agent.connect();return {root,transport,agent};}
test('ACP streams visible answers, uses configured models and restores only owned history',async t=>{
  const {agent,transport}=await fixture(t);assert.equal(agent.selectedModel,'configured-model');assert.equal(agent.modelOptions.length,2);
  const {turnId}=await agent.send('你好');transport.update(agent.currentId,{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'HIDDEN_REASONING'}});transport.update(agent.currentId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'你好。'}});transport.pending[0].resolve({stopReason:'end_turn'});
  assert.deepEqual(await agent.waitForTurn(turnId),{turnId,status:'completed',error:null,text:'你好。'});assert.ok(!JSON.stringify(agent.snapshot()).includes('HIDDEN_REASONING'));
  const session=agent.currentId;await agent.historyQueue;await agent.resume(session);assert.ok(agent.snapshot().items.some(i=>i.text==='你好。'));await assert.rejects(agent.resume('foreign'),/不属于/);
  await agent.models.select('another-model');assert.equal(agent.selectedModel,'another-model');
  await assert.rejects(agent.models.select('configured-model',{effort:'high'}),/当前模型/);
  await assert.rejects(agent.models.select('another-model',{effort:'max'}),/思考强度/);
  const models=await agent.models.select('another-model',{effort:'high'});assert.equal(models.effort.selected,'high');assert.equal(models.selected,'another-model');
});
test('ACP connection measures startup, session and model handling, without claiming a login check',async t=>{
  const {agent,transport}=await fixture(t);
  const initial=agent.snapshot().connectionStages;
  assert.deepEqual(initial.map(s=>[s.stage,s.status]),[['startup','done'],['login','skipped'],['session','done'],['models','done']]);
  assert.match(initial[2].detail,/建立新会话/);
  const originalId=agent.currentId;await agent.connect();await agent.connectionStages.pending;
  assert.equal(agent.currentId,originalId);assert.ok(transport.calls.some(call=>call.method==='session/resume'));
  const steps=agent.snapshot().connectionStages;assert.match(steps[2].detail,/恢复已有会话/);
  const log=(await readFile(path.join(agent.dataDir,'agent-connection.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(log.slice(-4).map(({agent,time,...step})=>step),steps);
  assert.ok(log.every(row=>row.agent==='dsh'&&(row.status==='skipped'?row.elapsedMs===undefined:row.elapsedMs>=0)));
});
test('ACP permission waits, accepts only allow_once and rejects stale or foreign approvals',async t=>{
  const {agent,transport}=await fixture(t);await agent.send('写入测试文件');const event={id:7,method:'session/request_permission',params:{sessionId:agent.currentId,toolCall:{toolCallId:'write',title:'Write fixture'},options:[{optionId:'once',kind:'allow_once'},{optionId:'forever',kind:'allow_always'}]}};
  agent.serverRequest(event);assert.equal(transport.responses.length,0);assert.equal(agent.snapshot().approvals.length,1);await agent.approve('7','accept');assert.deepEqual(transport.responses[0],{id:7,result:{outcome:{outcome:'selected',optionId:'once'}}});
  await assert.rejects(agent.approve('7','accept'),/失效/);agent.serverRequest({...event,id:8,params:{...event.params,sessionId:'foreign'}});assert.equal(transport.responses.at(-1).result.outcome.outcome,'cancelled');
  agent.serverRequest({...event,id:9,params:{...event.params,options:[{optionId:'forever',kind:'allow_always'}]}});await assert.rejects(agent.approve('9','accept'),/没有提供/);await agent.interrupt();assert.equal(agent.approvals.size,0);
});
test('opt-in ACP approval allows only an ordinary file in the current project',async t=>{
  const {agent,root,transport}=await fixture(t);
  await writeFile(path.join(root,'note.txt'),'fixture');
  await writeFile(path.join(root,'.env'),'private fixture');
  await agent.send('读取项目说明');
  const request=(id,filePath,toolName='Read')=>agent.serverRequest({id,method:'session/request_permission',params:{
    sessionId:agent.currentId,toolCall:{rawInput:{file_path:filePath},_meta:{'codebuddy.ai/toolName':toolName}},
    options:[{optionId:'once',kind:'allow_once'}],
  }});
  await request(1,'note.txt');
  assert.equal(agent.approvals.size,1);
  agent.autoApproveRead=()=>true;
  await request(2,'note.txt');
  assert.deepEqual(transport.responses.at(-1),{id:2,result:{outcome:{outcome:'selected',optionId:'once'}}});
  await request(3,'.env');
  await request(4,'../foreign.txt');
  await request(5,'note.txt','Bash');
  assert.deepEqual([...agent.approvals.keys()],['1','3','4','5']);
});
test('ACP cancellation settles before handoff; failed process termination stays unknown without replay',async t=>{
  const {agent,transport}=await fixture(t);const first=await agent.send('第一轮');await agent.interrupt();assert.equal((await agent.waitForTurn(first.turnId)).status,'interrupted');
  transport.cancelHangs=true;transport.stopFails=true;await agent.send('第二轮');await assert.rejects(agent.interrupt(),/owned process/);assert.equal(agent.task.status,'unknown');await assert.rejects(agent.send('不应重放'),/停止/);assert.equal(transport.pending.length,2);
  transport.stopFails=false;await agent.interrupt();assert.equal(agent.task.status,'interrupted');
});
test('stop while ACP session creation is pending cannot dispatch a late prompt',async t=>{
  const {agent,transport}=await fixture(t);agent.currentId=null;let release;transport.blockNew=new Promise(resolve=>release=resolve);
  const sending=agent.send('不应发送');sending.catch(()=>{});await delay(1);await agent.interrupt();release();await assert.rejects(sending,/已停止/);assert.equal(transport.pending.length,0);assert.equal(agent.locked,false);
});
test('ACP output-limit and native errors do not masquerade as a completed answer',async t=>{
  const {agent,transport}=await fixture(t);const {turnId}=await agent.send('测试');transport.pending[0].resolve({stopReason:'max_tokens'});assert.equal((await agent.waitForTurn(turnId)).status,'failed');
  const next=await agent.send('再测试');const error=Error('provider failure');error.code='RPC_ERROR';transport.pending[1].reject(error);assert.match((await agent.waitForTurn(next.turnId)).error,/provider failure/);
});
test('an expired ACP request is not proof of remote cancellation; owned process must stop first',async t=>{
  const {agent,transport}=await fixture(t);await agent.send('测试超时');const error=Error('transport timeout');error.code='RPC_TIMEOUT';transport.pending[0].reject(error);await delay(1);assert.equal(agent.task.status,'unknown');transport.stopped=false;
  await agent.interrupt();assert.equal(transport.stopped,true);assert.equal(agent.needsResume,true);assert.equal(agent.task.status,'interrupted');assert.equal(transport.pending.length,1);
});
test('OpenCode quota event reports the actual model failure after confirmed backend cancellation',async()=>{
  const transport=new EventEmitter();Object.assign(transport,{request:async route=>route.endsWith('/abort')?true:route==='/session/status'?{}:route.includes('/message?')?[]:[]});
  const agent=new OpenCodeExecutor({workspace:'.',dataDir:'.',transport,pollMs:1});agent.currentId='session';agent.task={status:'running',turnId:'turn'};
  transport.emit('sessionError',{sessionID:'other',error:{data:{message:'Free usage limit reached'}}});assert.equal(agent.task.status,'running');
  transport.emit('sessionError',{sessionID:'session',error:{data:{message:'Free usage limit reached'}}});const result=await agent.waitForTurn('turn');assert.equal(result.status,'failed');assert.match(result.error,/免费模型额度已用尽/);assert.equal(agent.inFlight,undefined);
});
test('ACP stdio timeout does not replay requests and EOF stops its owned child',async()=>{
  const script="let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='echo')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.params})+'\\n');}});";
  const p=new AcpProcess({workspace:process.cwd(),command:{command:process.execPath,args:['-e',script]}});
  try{await p.start();assert.deepEqual(await p.request('echo',{text:'中文分段'}),{text:'中文分段'});await assert.rejects(p.request('pending',{},15),/超时/);assert.equal(p.pending.size,0);const child=p.child;await p.stop();assert.notEqual(child.exitCode,null);assert.equal(p.child,null);}finally{await p.stop();}
});
test('Pi waits for tool approval and the final settled event before completing',async()=>{
  const transport=new PiProcess({dataDir:'.'}),writes=[],updates=[];
  transport.approvalReady=true;transport.sessionId='session';
  transport.call=async()=>({disposition:'started'});
  transport.child={stdin:{writable:true,write:line=>writes.push(JSON.parse(line))}};
  transport.on('notification',event=>updates.push(event.params.update));
  const request=once(transport,'serverRequest');
  const running=transport.prompt({sessionId:'session',prompt:[{text:'测试'}]},2000);
  transport.handleMessage({type:'extension_ui_request',method:'confirm',title:'知微工具审批',id:'permission',message:'编辑项目文件'});
  const [permission]=await request;
  assert.equal(permission.params.options[0].kind,'allow_once');
  assert.equal(writes.length,0);
  transport.respond(permission.id,{outcome:{outcome:'selected',optionId:'allow'}});
  assert.deepEqual(writes[0],{type:'extension_ui_response',id:'permission',confirmed:true});
  transport.handleMessage({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'可见回答'}});
  transport.handleMessage({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'可见回答'}]}});
  let done=false;running.then(()=>{done=true;});
  transport.handleMessage({type:'agent_end'});
  await delay(1);assert.equal(done,false);
  transport.handleMessage({type:'agent_settled'});
  assert.deepEqual(await running,{stopReason:'end_turn'});
  assert.deepEqual(updates.map(update=>update.content?.text),['可见回答']);
});

test('Pi file approval blocks paths outside the selected project and denies an unapproved shell command',async()=>{
  const hooks=new Map(),calls=[];
  piApproval({on:(event,callback)=>hooks.set(event,callback)});
  const ctx={cwd:process.cwd(),ui:{confirm:async(...args)=>{calls.push(args);return false;}}};
  const tool=hooks.get('tool_call');
  assert.equal((await tool({toolName:'read',input:{path:path.resolve('..')}},ctx)).block,true);
  assert.equal(calls.length,0);
  assert.equal((await tool({toolName:'bash',input:{command:'git status'}},ctx)).block,true);
  assert.match(calls[0][1],/git status/);
});

test('OpenCode SSE reads provider errors through the authenticated observation channel',async()=>{
  const event={type:'session.error',properties:{sessionID:'fixture',error:{data:{message:'Free usage limit reached'}}}};
  const server=http.createServer((req,res)=>{assert.equal(req.headers.authorization,'Basic fixture');assert.equal(new URL(req.url,'http://localhost').pathname,'/event');res.writeHead(200,{'Content-Type':'text/event-stream'});const data='data: '+JSON.stringify(event)+'\n\n';res.write(data.slice(0,23));setImmediate(()=>res.write(data.slice(23)));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const p=new OpenCodeProcess({workspace:process.cwd()});p.origin='http://127.0.0.1:'+server.address().port;p.authorization='Basic fixture';
  try{const received=once(p,'sessionError',{signal:AbortSignal.timeout(3000)});p.startEvents();assert.deepEqual((await received)[0],event.properties);}finally{await p.stop();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
