import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {start} from '../src/main.js';
import {ModelSelection} from '../src/codex/models.js';

test('model picker authenticates writes, persists selection and sends it to native turns without replacing the thread',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'zhiwei-models-')),calls=[];
  const rpc=Object.assign(new EventEmitter(),{connected:true,async stop(){this.connected=false;},async request(method,params){
    calls.push({method,params});
    if(method==='model/list')return {data:[{model:'gpt-6-luna',displayName:'GPT-6-Luna',supportedReasoningEfforts:[{reasoningEffort:'low'}]},{model:'gpt-6.1-terra',displayName:'GPT-6.1 Terra',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]}]};
    if(method==='thread/start')return {thread:{id:'same-thread'}};
    if(method==='turn/start')return {turn:{id:'turn-'+calls.length,status:'completed',items:[]}};
    throw new Error('unexpected '+method);
  }});
  let app;
  try{
    app=await start({port:0,rpc,workspace:dir,dataDir:path.join(dir,'data'),trayEnabled:false});await app.ready;
    const state=await(await fetch(app.origin+'/api/state')).json(),headers={'X-Zhiwei-CSRF':state.csrf,Origin:app.origin,'Content-Type':'application/json'};
    const post=(model,patch={},selection={})=>fetch(app.origin+'/api/model',{method:'POST',headers:{...headers,...patch},body:JSON.stringify({model,...selection})});
    assert.equal((await post('gpt-6.1-terra',{Origin:'https://evil.invalid'})).status,403);
    const catalog=await(await fetch(app.origin+'/api/models',{headers:{'X-Zhiwei-CSRF':state.csrf}})).json();assert.equal(catalog.selected,'gpt-6-luna');
    await app.client.send('第一句\n改动范围：只读文件\n验收条件：引用行号',undefined,{effort:'low'});assert.equal(calls.findLast(c=>c.method==='turn/start').params.model,'gpt-6-luna');
    const attachment=calls.findLast(c=>c.method==='turn/start').params.input[1].text;
    assert.match(attachment,/本次范围：只读文件/);assert.match(attachment,/验收条件：引用行号/);
    assert.ok(attachment.includes(dir));assert.match(attachment,/本机项目台账/);
    assert.equal(calls.findLast(c=>c.method==='turn/start').params.effort,'low');
    assert.equal((await post('unknown')).status,400);
    assert.equal((await post('gpt-6.1-terra',{},{projectId:state.workbench.projectId,agent:'hermes'})).status,400);
    app.client.voice.enabled=true;assert.equal((await post('gpt-6.1-terra')).status,400);app.client.voice.enabled=false;
    assert.equal((await post('gpt-6.1-terra')).status,200);
    assert.equal((await post('gpt-6-luna',{},{effort:'low'})).status,400);
    assert.equal((await post('gpt-6.1-terra',{},{effort:'max'})).status,400);
    const updated=await(await post('gpt-6.1-terra',{},{effort:'high'})).json();assert.equal(updated.effort.selected,'high');
    await app.client.send('第二句');const params=calls.findLast(c=>c.method==='turn/start').params;assert.equal(params.model,'gpt-6.1-terra');assert.equal(params.threadId,'same-thread');assert.equal(calls.filter(c=>c.method==='thread/start').length,1);
    assert.equal(params.effort,'high');
    await app.client.send('语音',undefined,{effort:'low'});assert.equal(calls.findLast(c=>c.method==='turn/start').params.effort,'high');
    assert.equal(JSON.parse(await readFile(app.client.models.file,'utf8')).model,'gpt-6.1-terra');
    const restored=new ModelSelection(app.client,path.join(dir,'data'));await restored.load();assert.equal(restored.selected,'gpt-6.1-terra');assert.equal(restored.effort,'high');
    assert.equal((await post('gpt-6.1-terra',{},{effort:''})).status,200);
    await app.client.send('恢复默认');assert.equal(calls.findLast(c=>c.method==='turn/start').params.effort,undefined);
    app.client.models.selected='removed-model';await assert.rejects(app.client.send('第三句'),/模型不可用/);
  }finally{await app?.close();await rm(dir,{recursive:true,force:true});}
});
