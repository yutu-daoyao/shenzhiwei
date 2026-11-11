import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ProjectCatalog} from '../src/projects/catalog.js';
import {CaptionTranslator} from '../src/voice/captions.js';

test('project discovery pages across all sources and reads visible messages without resuming other sessions',async()=>{
 const calls=[];const rpc={request:async(m,p)=>{calls.push([m,p]);if(m==='thread/list')return p.cursor?{data:[{id:'b',name:'PI U盘',cwd:'E:/PI'}]}:{data:[{id:'a',preview:'项目 A'}],nextCursor:'next'};return {thread:{id:'b',name:'PI U盘',turns:[{items:[{type:'reasoning',text:'secret'},{type:'commandExecution',text:'raw'},{type:'agentMessage',text:'最近完成备份'}]}]}};}};
 const c=new ProjectCatalog(rpc),list=await c.list('PI');assert.equal(list.threads.length,1);assert.deepEqual(calls[0][1].sourceKinds,[]);
 const result=await c.read('b');assert.deepEqual(result.messages,[{role:'assistant',text:'最近完成备份'}]);assert.ok(calls.every(([m])=>['thread/list','thread/read'].includes(m)));
 await assert.rejects(c.read('../auth'),/编号无效/);
 const titled=await c.list('优化',{desktop:{titles:new Map([['b','优化 Personal Pi 四项体验']]),pins:new Map([['b',2]])}});
 assert.deepEqual(titled.threads.map(({id,title,pinOrder})=>[id,title,pinOrder]),[['b','优化 Personal Pi 四项体验',2]]);
});

test('subtitle translation uses an ephemeral Luna text thread and does not alter the voice conversation',async()=>{
 const rpc=new EventEmitter(),calls=[];
 rpc.request=async(m,p)=>{calls.push([m,p]);if(m==='thread/start')return {thread:{id:'translation'}};queueMicrotask(()=>rpc.emit('notification',{method:'item/completed',params:{threadId:'translation',item:{type:'agentMessage',text:'慢慢来。'}}}));queueMicrotask(()=>rpc.emit('notification',{method:'turn/completed',params:{threadId:'translation',turn:{status:'completed'}}}));return {turn:{id:'t'}};};
 const text=await new CaptionTranslator(rpc).translate('Take your time.');assert.equal(text,'慢慢来。');assert.equal(calls[0][1].ephemeral,true);assert.equal(calls[0][1].model,'gpt-6-luna');assert.ok(calls.every(([m])=>!m.startsWith('thread/realtime')));assert.equal(rpc.listenerCount('notification'),0);
});
import {StreamingCaption} from '../src/voice/captions.js';
import {setImmediate as tick} from 'node:timers/promises';

test('short sentences translate before reply completion and expose deltas before the translation turn ends',async()=>{
 const pending=[],updates=[];
 const pipeline=new StreamingCaption({translate:(text,delta)=>new Promise(resolve=>pending.push({text,delta,resolve}))},c=>updates.push(c));
 pipeline.feed('a','Take your time. I can help',false);assert.equal(pending.length,1);assert.equal(pending[0].text,'Take your time. ');
 pending[0].delta('慢慢');assert.equal(updates.at(-1).text,'慢慢');
 pipeline.feed('a','Take your time. I can help you.',true);pending[0].resolve('慢慢来。');await tick();
 assert.equal(pending.length,2);pending[1].delta('我可以');assert.match(updates.at(-1).text,/慢慢来。\n我可以/);
 pending[1].resolve('我可以帮你。');await tick();assert.equal(updates.at(-1).status,'ready');assert.equal(updates.at(-1).text,'慢慢来。\n我可以帮你。\n');
});

test('late translations cannot overwrite a newer reply',async()=>{
 const pending=[],updates=[];
 const pipeline=new StreamingCaption({translate:(text,delta)=>new Promise(resolve=>pending.push({text,delta,resolve}))},c=>updates.push(c));
 pipeline.feed('old','Old reply.',true);pipeline.feed('new','New reply.',true);
 pending[0].delta('旧');pending[0].resolve('旧回复');await tick();assert.equal(updates.at(-1).id,'new');assert.ok(!updates.at(-1).text.includes('旧'));
 pending[1].resolve('新回复');await tick();assert.equal(updates.at(-1).text,'新回复\n');
});

test('multiple subtitle phrases reuse one thread and stream text without waiting for completed',async()=>{
 const rpc=new EventEmitter(),calls=[],deltas=[];
 rpc.request=async(m,p)=>{calls.push(m);if(m==='thread/start')return {thread:{id:'translation'}};
 queueMicrotask(()=>{rpc.emit('notification',{method:'item/agentMessage/delta',params:{threadId:'translation',delta:'中文'}});assert.equal(deltas.at(-1),'中文');rpc.emit('notification',{method:'turn/completed',params:{threadId:'translation',turn:{status:'completed'}}});});return {turn:{id:'t'}};};
 const translator=new CaptionTranslator(rpc);await translator.translate('One.',s=>deltas.push(s));await translator.translate('Two.',s=>deltas.push(s));assert.equal(calls.filter(m=>m==='thread/start').length,1);assert.equal(rpc.listenerCount('notification'),0);
});

test('canonical transcript promotion reuses in-flight translation instead of starting the same phrase again',async()=>{
 const pending=[],updates=[];
 const pipeline=new StreamingCaption({translate:(text,delta)=>new Promise(resolve=>pending.push({text,delta,resolve}))},c=>updates.push(c));
 pipeline.feed('legacy',' Take your time.',false);pipeline.feed('canonical','Take your time. I can help.',true);
 assert.equal(pending.length,1);pending[0].delta('慢慢来');assert.equal(updates.at(-1).id,'canonical');pending[0].resolve('慢慢来。');await tick();assert.equal(pending.length,2);assert.equal(pending[1].text,' I can help.');pending[1].resolve('我可以帮你。');await tick();assert.equal(updates.at(-1).status,'ready');
});

test('corrections in untranslated suffix do not throw away an already translating first sentence',async()=>{
 const pending=[],updates=[];const pipeline=new StreamingCaption({translate:(text,delta)=>new Promise(resolve=>pending.push({text,delta,resolve}))},c=>updates.push(c));
 pipeline.feed('a',"Take your time. I'll show",false);pipeline.feed('b','Take your time. I will show you.',true);assert.equal(pending.length,1);
 pending[0].delta('慢慢来');assert.equal(updates.at(-1).id,'b');pending[0].resolve('慢慢来。');await tick();assert.equal(pending[1].text,'I will show you.');pending[1].resolve('我来展示。');await tick();assert.equal(updates.at(-1).status,'ready');
});
