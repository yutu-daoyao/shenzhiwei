import test from 'node:test';import assert from 'node:assert/strict';import {setImmediate as tick} from 'node:timers/promises';
import {createLocalCaptions} from '../public/local-captions.js';import {dashscopeFailure} from '../src/voice/dashscope/protocol.js';

test('local captions translate phrases without RPC and deduplicate render feedback',async()=>{
 let calls=0;const updates=[];const local=createLocalCaptions({Translator:{availability:async()=>'available',create:async()=>({translate:async text=>{calls++;return text.includes('Take')?'慢慢来。':'我可以帮你。';}})},onChange:c=>updates.push(c)});
 assert.equal(await local.prepare(),true);const source={id:'a',text:'Take your time. I can help.',done:true};local.feed(source);local.feed(source);await tick();await tick();assert.equal(calls,2);assert.equal(local.caption.status,'ready');assert.match(local.caption.text,/慢慢来。\n我可以帮你。/);
 local.reset();assert.equal(local.caption,null);
});
test('download is explicit and missing browser API reports unavailable without claiming success',async()=>{
 let creates=0;const status=[];const local=createLocalCaptions({Translator:{availability:async()=>'downloadable',create:async()=>{creates++;return {translate:async()=>''};}},onStatus:s=>status.push(s)});assert.equal(await local.prepare(),false);assert.equal(creates,0);assert.equal(await local.prepare({download:true}),true);assert.equal(creates,1);
 const missing=createLocalCaptions({Translator:null,onStatus:s=>status.push(s)});assert.equal(await missing.prepare(),false);assert.match(status.at(-1),/不支持/);
});
test('Bailian billing and auth errors are actionable without echoing raw provider diagnostics',()=>{
 assert.match(dashscopeFailure({error_code:'Arrearage'}),/余额不足/);assert.match(dashscopeFailure({error_code:'Throttling.AllocationQuota'}),/额度/);assert.match(dashscopeFailure({error_code:'InvalidApiKey'}),/鉴权/);assert.ok(!dashscopeFailure({error_code:'Unknown',error_message:'sk-secret'}).includes('sk-secret'));
});
