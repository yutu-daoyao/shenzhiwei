import test from 'node:test';import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';import {mkdtemp,mkdir,rm,readFile,rename,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';import {setTimeout as delay} from 'node:timers/promises';
import {Workbench} from '../src/workbench/hub.js';import {OpenCodeExecutor} from '../src/workbench/opencode.js';
import {start} from '../src/main.js';
import {mikaWechat} from '../src/server/mika-wechat.js';
import {desktopProjectDirectories} from '../src/workbench/project-directories.js';
import {requestedBrowser} from '../src/voice/task-control.js';

const until=async predicate=>{for(let i=0;i<200&&!predicate();i++)await delay(5);assert.ok(predicate(),'expected state did not arrive');};
async function temp(t){const root=await mkdtemp(path.join(tmpdir(),'zhiwei-workbench-'));t.after(async()=>{if(!path.resolve(root).startsWith(path.resolve(tmpdir())+path.sep))throw Error('Unexpected cleanup path');await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});return root;}
class FakeExecutor extends EventEmitter{
  constructor(workspace){super();this.workspace=workspace;this.connection='connected';this.task={status:'idle'};this.orchestrator={active:false};this.items=new Map();this.sessions={entries:[]};this.voice={enabled:false,brain:{run:async text=>text,stop:async()=>{},close(){}},snapshot:()=>({enabled:false,state:'idle'})};this.realtime={active:false,snapshot:()=>({status:'off'})};this.models={snapshot:()=>({selected:'test',options:[]})};this.rpc={connected:false};this.sendCount=0;}
  get busy(){return ['running','stopping','unknown'].includes(this.task.status);}
  snapshot(){return {workspace:this.workspace,connection:this.connection,currentId:this.currentId,items:[...this.items.values()],sessions:this.sessions.entries,approvals:[],task:this.task,models:this.models.snapshot()};}
  ready(){}async connect(){this.connectCount=(this.connectCount||0)+1;this.connection='connected';this.emit('change');}
  async interrupt(){this.task.status='interrupted';this.emit('change');}
  async send(text){this.sendCount++;return {turnId:'test-turn',text};}async waitForTurn(){return {status:'completed',text:'来自所选执行器的回复'};}async close(){}changed(){this.emit('change');}
}
test('project and executor selection persist independently; unavailable agents never dispatch and Codex is optional',async t=>{
  const root=await temp(t),workspace=path.join(root,'default'),projectDir=path.join(root,'project');await Promise.all([mkdir(workspace),mkdir(projectDir)]);
  const legacy=new FakeExecutor(workspace),created=[];const factory=async({workspace,agent})=>{const c=new FakeExecutor(workspace);created.push({agent,client:c});return c;};
  const hub=new Workbench({client:legacy,dataDir:root,createExecutor:factory});await hub.load();
  const project=await hub.register({cwd:projectDir,name:'测试项目'});await hub.select({projectId:project.id,agent:'opencode'});
  assert.equal(hub.active,created[0].client);await hub.send('你好');assert.equal(legacy.sendCount,0);assert.equal(hub.active.sendCount,1);
  const voiceReply=await legacy.voice.brain.run('用语音发送');assert.equal(voiceReply,'来自所选执行器的回复');assert.equal(legacy.sendCount,0);assert.equal(hub.active.sendCount,2);
  await assert.rejects(hub.select({agent:'unavailable-agent'}),/尚未接入/);assert.equal(hub.project.agent,'opencode');
  const restored=new Workbench({client:new FakeExecutor(workspace),dataDir:root,createExecutor:factory,projectDirectories:async()=>null});await restored.load();assert.equal(restored.project.id,project.id);assert.equal(restored.project.agent,'opencode');assert.equal(restored.legacy.connectCount,undefined);
  assert.deepEqual((await restored.catalog()).threads.map(project=>project.id),[project.id]);await hub.close();await restored.close();
});
test('busy work cannot switch; explicit stop precedes handoff, handoff is reviewable and performs no model request',async t=>{
  const root=await temp(t),legacy=new FakeExecutor(root);const target=new FakeExecutor(root);const hub=new Workbench({client:legacy,dataDir:path.join(root,'data'),createExecutor:async()=>target});await hub.load();
  legacy.currentId='old';legacy.items.set('u',{type:'userMessage',text:'实现按钮'});legacy.items.set('a',{type:'agentMessage',text:'已修改，测试尚未跑'});legacy.task={status:'running',turnId:'old-turn'};
  await assert.rejects(hub.select({projectId:'default',agent:'opencode'}),/尚未结束/);assert.equal(hub.project.agent,'codex');
  let release;legacy.interrupt=async()=>{legacy.task.status='stopping';await new Promise(r=>release=r);legacy.task.status='interrupted';legacy.emit('change');};
  const switching=hub.select({projectId:'default',agent:'opencode',stopCurrent:true,handoff:true});await until(()=>!!release);await assert.rejects(hub.send('不得派发'),/切换/);assert.equal(target.connectCount,undefined);release();await switching;
  assert.equal(hub.project.agent,'opencode');assert.equal(target.sendCount,0);assert.match(hub.handoff.text,/测试尚未跑/);assert.match(hub.handoff.text,/不能据此宣称测试通过/);assert.equal(hub.handoff.fromSession,'old');
  const packet=JSON.parse(await readFile(path.join(root,'data/handoffs',hub.handoff.id+'.json'),'utf8'));assert.equal(packet.to,'opencode');await hub.close();
});
test('failed stop and live voice block switching; project identity replacement is rejected',async t=>{
  const root=await temp(t),workspace=path.join(root,'workspace');await mkdir(workspace);const legacy=new FakeExecutor(workspace);const hub=new Workbench({client:legacy,dataDir:path.join(root,'data'),createExecutor:async()=>new FakeExecutor(workspace)});await hub.load();
  legacy.voice.enabled=true;await assert.rejects(hub.select({agent:'opencode'}),/语音/);legacy.voice.enabled=false;
  legacy.task={status:'running'};legacy.interrupt=async()=>{throw Error('stop failed');};await assert.rejects(hub.select({projectId:'default',agent:'opencode',stopCurrent:true}),/stop failed/);assert.equal(hub.project.agent,'codex');legacy.task={status:'idle'};
  await hub.files();await rename(workspace,workspace+'-old');await mkdir(workspace);await assert.rejects(hub.send('不要写入'),/替换|重定向/);assert.equal(legacy.sendCount,0);await hub.close();
});

test('DSH and WorkBuddy selection persist and voice follows the selected executor',async t=>{
  const root=await temp(t),factory=async({workspace})=>new FakeExecutor(workspace);
  const hub=new Workbench({client:new FakeExecutor(root),dataDir:path.join(root,'data'),createExecutor:factory});await hub.load();
  for(const agent of ['dsh','workbuddy']){await hub.select({projectId:'default',agent});assert.equal(hub.snapshot().workbench.agent,agent);assert.equal(hub.snapshot().workbench.nativeVoice,false);assert.equal(await hub.voice.brain.run('测试语音路由'),'来自所选执行器的回复');}
  const restored=new Workbench({client:new FakeExecutor(root),dataDir:path.join(root,'data'),createExecutor:factory});await restored.load();assert.equal(restored.project.agent,'workbuddy');
  for(const id of ['hermes','antigravity']){
    await restored.select({projectId:'default',agent:id});assert.equal(restored.snapshot().workbench.agent,id);
    assert.equal(await restored.voice.brain.run('测试语音路由'),'来自所选执行器的回复');
  }
  await hub.close();await restored.close();
});

test('WorkBuddy lists its own folders and routes voice and text only after selecting one',async t=>{
  const root=await temp(t),office=path.join(root,'办公文档'),mainPath=fileURLToPath(new URL('../',import.meta.url));await mkdir(office);
  const legacy=new FakeExecutor(root),created=[];
  legacy.rpc={connected:true,request(){assert.fail('WorkBuddy must not query Codex');}};
  const options={dataDir:path.join(root,'data'),createExecutor:async({agent,workspace})=>{
    const executor=new FakeExecutor(workspace);created.push({agent,executor});return executor;
  },projectDirectories:async agent=>{assert.equal(agent,'workbuddy');return [office,mainPath,path.dirname(path.resolve(mainPath))];}};
  const hub=new Workbench({client:legacy,...options});await hub.load();
  const main=await hub.register({cwd:mainPath,name:'知微 · 主工程',agent:'codex'});
  await assert.rejects(hub.select({agent:'workbuddy'}),/选择项目目录/);
  await assert.rejects(hub.select({agent:'workbuddy',projectId:main.id}),/只交给 Codex/);
  await assert.rejects(hub.register({cwd:mainPath,agent:'workbuddy'}),/只交给 Codex/);
  const catalog=await hub.catalog('','workbuddy');
  assert.deepEqual(catalog.threads.map(project=>project.cwd),[office]);
  assert.equal(hub.project.id,'default');assert.equal(created.length,0);
  const folder=await hub.register({cwd:office,agent:'workbuddy'});
  await hub.select({projectId:folder.id,agent:'workbuddy'});
  assert.deepEqual(created.map(({agent,executor})=>[agent,executor.workspace]),[['workbuddy',office]]);
  await hub.send('修改这个项目里的 Word');
  assert.equal(await hub.voice.brain.run('继续修改这个项目里的 Word'),'来自所选执行器的回复');
  assert.equal(hub.active.sendCount,2);assert.equal(legacy.sendCount,0);
  const restored=new Workbench({client:new FakeExecutor(root),...options});await restored.load();
  assert.equal(restored.project.id,folder.id);
  await restored.select({agent:'codex'});assert.equal(restored.project.id,'default');
  await restored.select({agent:'workbuddy'});assert.equal(restored.project.id,folder.id);
  await hub.close();await restored.close();
});

test('WorkBuddy uses native task titles and preserves the session workspace',async t=>{
  const root=await temp(t),home=path.join(root,'.workbuddy'),workDir=path.join(root,'2026-11-05-17-56-08');
  await mkdir(path.join(home,'app'),{recursive:true});
  await writeFile(path.join(home,'app','sessions.json'),JSON.stringify({sessions:[{conversationId:'task',userId:'local',workDir}]}));
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(path.join(home,'workbuddy.db'));
  try{
    db.exec('CREATE TABLE sessions (id TEXT,cwd TEXT,title TEXT,custom_title TEXT,updated_at INT,deleted_at INT,is_background_automation INT,is_playground INT,user_id TEXT)');
    const insert=db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,NULL,0,1,?)');
    insert.run('task',workDir,'原始标题','整理视频口播稿和资料',2,'local');
    insert.run('second',workDir,'山东普惠托育调研方案设计',null,1,'local');
    insert.run('other',workDir,'其他账号的标题',null,3,'another');
  }finally{db.close();}
  const entries=await desktopProjectDirectories('workbuddy',root);
  assert.deepEqual(entries,[
    {id:'task',cwd:workDir,title:'整理视频口播稿和资料',updatedAt:2},
    {id:'second',cwd:workDir,title:'山东普惠托育调研方案设计',updatedAt:1},
    workDir,
  ]);
});

test('an external Agent gets its own workspace and can retry a failed connection in place',async t=>{
  const root=await temp(t),workspace=path.join(root,'codex'),standalone=path.join(root,'standalone');await mkdir(workspace);
  const legacy=new FakeExecutor(workspace);
  let executor;
  const hub=new Workbench({client:legacy,dataDir:path.join(root,'data'),agentWorkspaceRoot:standalone,
    projectDirectories:async()=>[{id:'history',title:'Hermes 历史任务',unscoped:true}],
    createExecutor:async({agent,workspace})=>{
      assert.equal(agent,'hermes');assert.equal(workspace,path.join(standalone,agent));
      executor=new FakeExecutor(workspace);
      executor.connect=async()=>{
        if(!executor.connectCount++){executor.connection='error';throw Error('fixture connection failure');}
        executor.connection='connected';
      };
      executor.connectCount=0;
      return executor;
    }});
  await hub.load();
  const catalog=await hub.catalog('','hermes');assert.ok(catalog.threads[0].unscoped);
  assert.equal((await hub.openAgent('hermes')).connected,false);
  assert.equal(hub.project.agent,'hermes');
  assert.equal(hub.active,executor);
  assert.equal((await hub.select({projectId:hub.project.id,agent:'hermes'})).connected,true);
  assert.equal(executor.connectCount,2);assert.equal(legacy.sendCount,0);
  await assert.rejects(hub.openAgent('codex'),/外部 Agent/);
  await hub.close();
});

test('creating a named project gives the selected Agent a fresh directory without switching the current project',async t=>{
  const root=await temp(t),managed=path.join(root,'managed'),legacy=new FakeExecutor(root);
  const hub=new Workbench({client:legacy,dataDir:path.join(root,'data'),agentWorkspaceRoot:managed});
  await hub.load();
  await assert.rejects(hub.createProject({name:' ',agent:'opencode'}),/项目名称/);
  const first=await hub.createProject({name:' 调研/报告 ',agent:'opencode'});
  const second=await hub.createProject({name:'调研/报告',agent:'opencode'});
  assert.equal(first.name,'调研/报告');
  assert.deepEqual(first.agents,['opencode']);
  assert.equal(path.dirname(first.cwd),path.join(managed,'opencode','projects'));
  assert.notEqual(first.cwd,second.cwd);
  assert.equal(hub.project.id,'default');
  await hub.validateProject(first);
  legacy.task.status='running';
  await assert.rejects(hub.createProject({name:'执行中',agent:'opencode'}),/先停止/);
  await hub.close();
});

class FakeTransport extends EventEmitter{
  constructor(){super();this.calls=[];this.messages=[];this.status={};this.pending=[];this.permissions=[];this.questions=[];this.info={version:'test'};}
  async start(){}async stop(){}
  async request(route,options={}){
    this.calls.push({route,...options});
    if(route==='/global/health')return {healthy:true};
    if(route==='/config/providers')return {providers:[{id:'domestic',name:'本机配置',key:'secret-not-for-ui',models:{chat:{id:'chat',name:'对话',variants:{low:{},high:{}},capabilities:{toolcall:true,input:{text:true}}}}}]};
    if(route==='/session'&&options.method==='POST'){this.directory=this.directory||options.directory;return {id:'ses_test',directory:this.directory};}
    if(route==='/session/status')return this.status;
    if(route==='/permission')return this.permissions;
    if(route==='/question')return this.questions;
    if(route==='/session/ses_test/message'&&options.method==='POST'){
      const id=options.body.messageID;this.messages.push({info:{id,role:'user'},parts:options.body.parts});this.status.ses_test={type:'busy'};
      return new Promise((resolve,reject)=>this.pending.push({id,resolve,reject}));
    }
    if(route.startsWith('/session/ses_test/message?'))return this.messages;
    if(route==='/session/ses_test/abort'){if(this.abortFails)throw Error('abort failed');this.status={};return true;}
    if(route==='/session/ses_test')return {id:'ses_test',directory:this.directory};
    if(route.startsWith('/permission/')){this.permissions=[];return true;}
    if(route.startsWith('/question/')){this.questions=[];return true;}
    throw Error('Unexpected '+route);
  }
  finish(index,text='回复'){const pending=this.pending[index];this.messages.push({info:{id:'answer-'+index,role:'assistant',parentID:pending.id,time:{completed:1}},parts:[{type:'text',text},{type:'reasoning',text:'private thinking'}]});this.status={};pending.resolve({info:{},parts:[]});}
}
async function openCodeRig(t){const root=await temp(t),transport=new FakeTransport();transport.directory=root;const agent=new OpenCodeExecutor({workspace:root,dataDir:path.join(root,'data'),transport,pollMs:5,stopTimeoutMs:50});await agent.connect();t.after(()=>agent.close());return {agent,transport};}
test('OpenCode requires an explicit model, sanitizes provider metadata and streams only visible messages',async t=>{
  const {agent,transport}=await openCodeRig(t);await assert.rejects(agent.send('你好'),/先.*选择/);assert.equal(transport.pending.length,0);assert.ok(!JSON.stringify(agent.snapshot()).includes('secret-not-for-ui'));
  await agent.models.select('domestic/chat');
  await assert.rejects(agent.models.select('domestic/chat',{effort:'max'}),/思考强度/);
  await agent.models.select('domestic/chat',{effort:'high'});
  const {turnId}=await agent.send('读取项目');assert.equal(transport.pending.length,1);assert.deepEqual(transport.calls.find(c=>c.route==='/session').body.permission.at(-1),{permission:'external_directory',pattern:'*',action:'deny'});
  assert.equal(transport.calls.find(c=>c.route==='/session/ses_test/message'&&c.method==='POST').body.variant,'high');
  transport.finish(0,'已读取');const result=await agent.waitForTurn(turnId);assert.equal(result.status,'completed');assert.equal(result.text,'已读取');assert.ok(!JSON.stringify(agent.snapshot()).includes('private thinking'));
});
test('OpenCode confirms backend idle before handoff and late old completion cannot overwrite a new task',async t=>{
  const {agent,transport}=await openCodeRig(t);await agent.models.select('domestic/chat');await agent.send('第一件');await agent.interrupt();assert.equal(agent.task.status,'interrupted');
  const second=await agent.send('第二件');transport.finish(0,'旧回复');await delay(10);assert.equal(agent.task.turnId,second.turnId);assert.equal(agent.task.status,'running');
  transport.finish(1,'新回复');assert.equal((await agent.waitForTurn(second.turnId)).text,'新回复');
});
test('OpenCode failed cancellation keeps unknown state, never retries mutations, and approvals allow once only',async t=>{
  const {agent,transport}=await openCodeRig(t);await agent.models.select('domestic/chat');await agent.send('写文件');transport.abortFails=true;await assert.rejects(agent.interrupt(),/abort failed/);assert.equal(agent.task.status,'unknown');await assert.rejects(agent.send('重来'),/尚未结束/);assert.equal(transport.pending.length,1);
  transport.permissions=[{id:'per1',sessionID:'ses_test',permission:'edit',patterns:['test.txt'],metadata:{file:'test.txt'}}];await agent.syncRequests();await agent.approve('per1','accept');assert.deepEqual(transport.calls.find(c=>c.route==='/permission/per1/reply').body,{reply:'once'});
  transport.abortFails=false;await agent.interrupt();transport.finish(0);await delay(10);assert.equal(agent.task.status,'interrupted');
});
test('stop while OpenCode creates a session prevents a delayed model request and releases the startup lock',async t=>{
  const {agent,transport}=await openCodeRig(t);await agent.models.select('domestic/chat');let release;const original=transport.request.bind(transport);
  transport.request=async(route,options)=>{if(route==='/session'&&options.method==='POST')await new Promise(resolve=>release=resolve);return original(route,options);};
  const sending=agent.send('不应派发');sending.catch(()=>{});await until(()=>!!release);assert.equal(agent.task.status,'starting');const stopping=agent.interrupt();release();await stopping;await assert.rejects(sending,{name:'AbortError'});assert.equal(agent.locked,false);assert.equal(agent.task.status,'interrupted');assert.equal(transport.pending.length,0);
});
test('typed voice mode commands and direct selection stay inside Zhiwei',async t=>{
  const root=await temp(t),client=new FakeExecutor(root);
  client.voice.config={spokenModes:true};
  client.voice.setSpokenMode=mode=>{client.voice.mode=mode;return '已切到'+mode;};
  const hub=new Workbench({client,dataDir:path.join(root,'data')});await hub.load();
  assert.deepEqual(await hub.send('切换控制模式。'),{text:'已切到ptt'});
  assert.equal(client.voice.mode,'ptt');
  assert.equal(client.sendCount,0);
  assert.deepEqual(await hub.runPlan('请切换到对话模式'),{text:'已切到dialog'});
  assert.equal(client.sendCount,0);
  await hub.send('请解释怎么切换控制模式。');
  assert.equal(client.sendCount,1);
});

test('direct voice command selects the remembered Agent project without sending a model request',async t=>{
  const root=await temp(t),cwd=path.join(root,'office');await mkdir(cwd);
  const client=new FakeExecutor(root);
  const hub=new Workbench({client,dataDir:path.join(root,'state'),createExecutor:async({workspace})=>new FakeExecutor(workspace)});
  await hub.load();
  const project=await hub.register({cwd,name:'办公文档',agent:'workbuddy'});
  hub.agentProjects.workbuddy=project.id;
  client.voice.enabled=true;
  assert.match(await client.voice.localCommand('请把 Agent 切换到 WorkBuddy。',{}),/已切换到 WorkBuddy/);
  assert.equal(hub.project.id,project.id);
  assert.equal(hub.active.sendCount,0);
  assert.equal(client.sendCount,0);
  assert.equal(client.voice.enabled,true);
  assert.equal(await client.voice.localCommand('解释一下如何切换到 Codex',{}),undefined);
  assert.equal(requestedBrowser('打开我的浏览器吧,就用微软的浏览器。'),'edge');
  assert.equal(requestedBrowser('打开 Edge 然后发送资料'),undefined);
  await hub.close();
});

test('project catalog uses the selected Codex connection without changing the pinned project',async t=>{
  const root=await temp(t),workspace=path.join(root,'workspace');await mkdir(workspace);
  const legacy=new FakeExecutor(root),current=new FakeExecutor(workspace),calls=[];
  current.rpc={connected:true,request:async(method,params)=>{
    calls.push([method,params]);
    if(method==='project/list')return {data:[{id:'native-project',name:'Codex 原生项目',roots:[{path:workspace}],updatedAt:1}]};
    if(method==='thread/list')return {data:[{id:'recent',cwd:workspace,updatedAt:2}]};
    return {thread:{id:params.threadId,cwd:workspace,turns:[]}};
  }};
  const dataDir=path.join(root,'data');
  const hub=new Workbench({client:legacy,dataDir,createExecutor:async()=>current});
  await hub.load();const project=await hub.register({cwd:workspace,name:'已固定'});
  assert.equal(hub.project.id,'default');
  await hub.select({projectId:project.id});
  for(let i=0;i<2;i++){
    const list=await hub.catalog();
    assert.equal(list.codexStatus,'ready');
    assert.ok(list.threads.some(item=>item.codexRoot&&item.title==='Codex 原生项目'));
    assert.ok(list.threads.some(item=>item.id==='recent'));
    assert.equal((await hub.readProject('recent')).id,'recent');
    assert.equal(hub.project.id,project.id);
  }
  assert.ok(calls.some(([method])=>method==='project/list'));
  assert.ok(calls.some(([method,params])=>method==='thread/list'&&params.useStateDbOnly===true));
  const restored=new Workbench({client:legacy,dataDir,createExecutor:async()=>current});
  await restored.load();assert.equal(restored.project.id,project.id);
});

test('Mika WeChat exposes separate read, draft and explicitly confirmed send goals',async()=>{
  const args={port:8765,token:'local-test-token-0123456789',contact:'测试联系人',requestId:'00000000-0000-4000-8000-000000000001'};
  const calls=[];
  const fetcher=async(url,options)=>{
    assert.equal(url,'http://127.0.0.1:8765/mcp');assert.equal(options.redirect,'error');
    const request=JSON.parse(options.body);
    if(request.method==='notifications/initialized')return new Response(null,{status:202});
    const output=request.method==='initialize'?{protocolVersion:'2025-06-18'}:{
      content:[{type:'text',text:JSON.stringify({task_id:args.requestId,status:'running'})}],
    };
    if(request.method==='tools/call')calls.push(request.params);
    return Response.json({jsonrpc:'2.0',id:request.id,result:output});
  };
  await assert.rejects(mikaWechat({...args,action:'send',message:'测试回复'},fetcher),/确认发送/);
  await assert.rejects(mikaWechat({...args,action:'read',port:'https://example.test'},fetcher),/本机端口/);
  assert.equal(calls.length,0);
  await mikaWechat({...args,action:'read'},fetcher);
  await mikaWechat({...args,action:'draft'},fetcher);
  await mikaWechat({...args,action:'send',message:'测试回复',confirmed:true},fetcher);
  await mikaWechat({...args,action:'status',taskId:args.requestId},fetcher);
  assert.match(calls[0].arguments.goal,/不发送[\s\S]*测试联系人/);
  assert.match(calls[1].arguments.goal,/不发送[\s\S]*回复草稿/);
  assert.match(calls[2].arguments.goal,/再次核对[\s\S]*测试回复/);
  assert.equal(calls[2].arguments.request_id,args.requestId);
  assert.equal(calls[3].name,'mika_task_status');
});

test('workbench HTTP routes require origin and CSRF, route messages to the selected executor and reject stale file scope',async t=>{
  const root=await temp(t),workspace=path.join(root,'workspace'),project=path.join(root,'project');await Promise.all([mkdir(workspace),mkdir(project)]);
  const dataDir=path.join(root,'data'),archivedChat=[{role:'user',text:'旧聊天记录'}];
  await mkdir(dataDir);await writeFile(path.join(dataDir,'everyday.json'),JSON.stringify({mode:'gemini',messages:archivedChat}));
  const rpc=new EventEmitter();Object.assign(rpc,{connected:true,stop:async()=>{},request:async()=>{throw Error('unexpected Codex dispatch');}});
  const executors=[];const app=await start({port:0,workspace,dataDir:path.join(root,'data'),rpc,createExecutor:async({workspace})=>{const client=new FakeExecutor(workspace);executors.push(client);return client;}});try{await app.ready;
  const snapshot=await(await fetch(app.origin+'/api/state')).json();const headers={Origin:app.origin,'X-Zhiwei-CSRF':snapshot.csrf,'Content-Type':'application/json'};
  const post=(route,body,custom=headers)=>fetch(app.origin+route,{method:'POST',headers:custom,body:JSON.stringify(body)});
  assert.deepEqual(snapshot.archivedChat,archivedChat);
  assert.equal((await post('/api/everyday/configure',{mode:'gemini'})).status,404);
  assert.equal((await post('/api/everyday/send',{text:'不得发给 Gemini'})).status,404);
  assert.equal((await post('/api/workbench/project',{cwd:project},{})).status,403);assert.equal((await post('/api/workbench/select',{agent:'unavailable-agent'})).status,400);
  const added=await(await post('/api/workbench/project',{cwd:project,name:'HTTP 项目'})).json();assert.ok(added.id);
  assert.equal((await post('/api/workbench/select',{projectId:added.id,agent:'opencode'})).status,200);
  assert.equal((await fetch(app.origin+'/api/workbench/ledger')).status,403);
  const ledger=await(await fetch(app.origin+'/api/workbench/ledger',{headers})).json();
  assert.equal(ledger.项目名,'HTTP 项目');assert.equal(ledger.目标,'不知道');assert.equal(ledger.现在做到哪[0].状态,'待确认');
  const savedLedger=JSON.parse(await readFile(path.join(dataDir,'project-ledger.json'),'utf8'));
  assert.deepEqual(savedLedger.projects[added.id],ledger);
  assert.equal((await post('/api/send',{text:'过时的请求',agent:'codex',projectId:'default'})).status,400);
  assert.equal((await post('/api/send',{text:'只到 OpenCode',agent:'opencode',projectId:added.id})).status,200);assert.equal(executors[0].sendCount,1);
  assert.equal(await app.client.voice.brain.run('旧设置不能接管语音'),'来自所选执行器的回复');assert.equal(executors[0].sendCount,2);
  const main=await(await post('/api/workbench/project',{cwd:fileURLToPath(new URL('../',import.meta.url)),name:'知微 · 主工程',agent:'codex'})).json();
  assert.ok(main.id);
  const records=JSON.parse(await readFile(path.join(dataDir,'project-ledger.json'),'utf8'));
  Object.assign(records.projects[main.id],{
    现在做到哪:[
      {主题:'工作台',状态:'已验证',说明:'本地台账已存档',证据:'工作台测试'},
      {主题:'声纹',状态:'待确认',说明:'真人短句效果不知道',证据:'缺少真人实测'},
    ],
    下一步:[{主题:'声纹',说明:'试用一条新短句'}],更新时间:'2026-11-07 23:00:00 +08:00',
  });
  await writeFile(path.join(dataDir,'project-ledger.json'),JSON.stringify(records));
  const progress=await(await post('/api/send',{text:'知微做到哪了？'})).json();
  assert.match(progress.text,/已验证.*本地台账已存档[\s\S]*工作台测试[\s\S]*23:00:00/);
  const voiceProgress=await app.client.voice.brain.run('请问，声纹做到哪了。');
  assert.match(voiceProgress,/待确认.*真人短句效果不知道[\s\S]*缺少真人实测[\s\S]*试用一条新短句/);
  assert.doesNotMatch(voiceProgress,/工作台测试/);
  const progressState=await(await fetch(app.origin+'/api/state')).json();
  assert.equal(progressState.items.at(-1).text,voiceProgress);
  assert.equal(executors[0].sendCount,2);
  const unknownProgress=await(await post('/api/send',{text:'当前项目做到哪了？'})).json();
  assert.match(unknownProgress.text,/HTTP 项目[\s\S]*待确认.*不知道/);
  assert.equal((await post('/api/send',{text:'声纹做到哪了？请先实际读文件再回答。'})).status,200);
  assert.equal(executors[0].sendCount,3);
  assert.equal((await fetch(app.origin+'/api/files?projectId=default',{headers})).status,409);
  assert.equal((await fetch(app.origin+'/api/workbench/changes')).status,403);
  const state=await(await fetch(app.origin+'/api/state')).json();assert.equal(state.workbench.agent,'opencode');assert.equal(state.workbench.nativeVoice,false);
  assert.equal((await post('/api/realtime/start',{sdp:'v=0\r\n'})).status,400);
  }finally{await app.close();}
});
