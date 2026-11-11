import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {setImmediate as tick} from 'node:timers/promises';
async function page({pending=false,rejectFirstBatch=false,saved=0}={}){
  const nodes=new Map(),requests=[],timers=new Map();let processor,grant,stopped=0,id=0;
  const node=id=>{if(!nodes.has(id))nodes.set(id,{checked:false,disabled:false,value:''});return nodes.get(id);};
  const stream={getTracks:()=>[{stop(){stopped++;}}]},document={getElementById:node,addEventListener(){}};
  const sandbox={document,Uint8Array,console,btoa:s=>Buffer.from(s,'binary').toString('base64'),
    setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
    navigator:{mediaDevices:{getUserMedia:()=>pending?new Promise(r=>grant=r):Promise.resolve(stream)}},
    AudioContext:class{constructor(){this.sampleRate=16000;this.audioWorklet={addModule:async()=>{}};this.destination={};}async resume(){}async close(){}createMediaStreamSource(){return {connect(){}};}},
    AudioWorkletNode:class{constructor(){processor=this;this.port={};}connect(){}disconnect(){}},
  };
  const source=(await readFile(new URL('../public/voiceprint-view.js',import.meta.url),'utf8')).replace('export function','function');vm.runInNewContext(source+';this.factory=mountVoiceprint;',sandbox);
  const state={voice:{voiceprint:{available:true,enrolled:false,ready:false,enabled:false,canEnable:false,sampleCount:saved,minSamples:12,threshold:.6}},task:{status:'idle'}};
  const ui=sandbox.factory({document,api:async(route,body)=>{
    requests.push({route,body});
    if(rejectFirstBatch&&requests.length===1)throw Error('第 1 段：需要至少 6 秒有声片段，请自然连续地说');
    const v=state.voice.voiceprint;Object.assign(v,{enrolled:true,ready:true,sampleCount:v.sampleCount+3,voicedMs:18000});ui.update(state);return v;
  }});ui.update(state);
  return {ui,state,node:id=>node('voiceprint-'+id),requests,tick:async()=>{await tick();},frame:(value=0)=>processor.port.onmessage({data:{type:'mic',pcm:new Uint8Array(384000).fill(value).buffer}}),finish:()=>[...timers.values()].find(t=>t.ms===12000).fn(),grant:()=>grant(stream),get stopped(){return stopped;}};
}
test('owner enrollment requires consent and three explicit recordings, sends only on save and discards clips',async()=>{
  const p=await page();assert.equal(p.node('record').disabled,true);p.node('consent').checked=true;p.node('consent').onchange();
  for(let i=0;i<3;i++){const recording=p.node('record').onclick();await p.tick();p.frame();p.finish();await recording;assert.equal(p.requests.length,0);}
  assert.equal(p.node('enroll').disabled,false);await p.node('enroll').onclick();assert.equal(p.requests[0].route,'voiceprint');assert.equal(p.requests[0].body.samples.length,3);assert.equal(p.requests[0].body.consent,true);assert.equal(p.ui.pending,false);assert.equal(p.stopped,3);
  assert.match(p.node('progress').textContent,/3 段.*18 秒/);assert.match(p.node('record').textContent,/第 4 段/);
  assert.equal(p.node('record').disabled,false);assert.equal(p.node('test').disabled,false);assert.equal(p.node('enabled').disabled,true);
});
test('cancelled enrollment releases a late microphone permission and cannot upload or revive',async()=>{
  const p=await page({pending:true});p.node('consent').checked=true;p.node('consent').onchange();const recording=p.node('record').onclick();await p.tick();p.ui.stop();await recording;p.grant();await p.tick();assert.equal(p.stopped,1);assert.equal(p.ui.busy,false);assert.equal(p.ui.pending,false);assert.equal(p.requests.length,0);
});
test('a rejected clip can be rerecorded without replacing the rest of the batch',async()=>{
  const p=await page({rejectFirstBatch:true,saved:3});
  p.node('consent').checked=true;p.node('consent').onchange();
  async function record(value){
    const recording=p.node('record').onclick();
    await p.tick();p.frame(value);p.finish();await recording;
  }
  await record(1);await record(2);await record(3);
  await p.node('enroll').onclick();
  assert.equal(p.node('record').disabled,false);
  assert.match(p.node('record').textContent,/重录第 4 段/);
  assert.equal(p.node('enroll').disabled,true);
  await record(4);
  await p.node('enroll').onclick();
  const [first,second]=p.requests.map(request=>request.body.samples);
  assert.notEqual(second[0],first[0]);assert.deepEqual(second.slice(1),first.slice(1));
  assert.equal(p.state.voice.voiceprint.sampleCount,6);
  assert.equal(p.ui.pending,false);
});
