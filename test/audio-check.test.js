import test from 'node:test';
import assert from 'node:assert/strict';
import {createAudioCheck} from '../public/audio-check.js';

function harness({value=0.1,pending=false,denied=false}={}){
  let stopped=0,closed=0,resolve,callback,outputConnections=0;
  const updates=[],stream={getTracks:()=>[{stop(){stopped++;}}]};
  class Context {
    constructor(){this.destination={};this.currentTime=0;}
    async resume(){} async close(){closed++;}
    createMediaStreamSource(){return {connect:target=>{if(!target.getFloatTimeDomainData)outputConnections++;}};}
    createAnalyser(){return {fftSize:1024,getFloatTimeDomainData:data=>data.fill(value)};}
    createGain(){return {connect(){},gain:{setValueAtTime(){},linearRampToValueAtTime(){}}};}
    createOscillator(){return {frequency:{},connect(){},start(){},stop(){}};}
  }
  const check=createAudioCheck({Context,media:{getUserMedia:()=>denied?Promise.reject(Object.assign(new Error(),{name:'NotAllowedError'})):pending?new Promise(r=>{resolve=r;}):Promise.resolve(stream)},
    onChange:update=>updates.push(update),setTimer:fn=>{callback=fn;return 1;},clearTimer:()=>{callback=null;}});
  return {check,updates,tick:()=>callback?.(),resolve:()=>resolve(stream),counts:()=>({stopped,closed,outputConnections})};
}

test('microphone check detects sound, never routes mic to speakers, and releases after five seconds',async()=>{
  const h=harness();await h.check.start('mic');assert.equal(h.check.busy,true);
  for(let i=0;i<49;i++)h.tick();
  assert.equal(h.check.busy,false);assert.match(h.updates.at(-1).message,/已检测到声音/);
  assert.deepEqual(h.counts(),{stopped:1,closed:1,outputConnections:0});
});
test('silent microphone reports uncertainty rather than passing the check',async()=>{
  const h=harness({value:0});await h.check.start('mic');for(let i=0;i<49;i++)h.tick();
  assert.match(h.updates.at(-1).message,/未检测到明显声音/);assert.equal(h.counts().stopped,1);
});
test('cancel while permission is pending releases late tracks and never revives the check',async()=>{
  const h=harness({pending:true}),start=h.check.start('mic');await Promise.resolve();
  h.check.stop();const count=h.updates.length;h.resolve();await start;
  assert.equal(h.updates.length,count);assert.equal(h.check.busy,false);assert.equal(h.counts().stopped,1);
});
test('permission denial is actionable and speaker playback does not claim the user heard it',async()=>{
  const h=harness({denied:true});await h.check.start('mic');assert.match(h.updates.at(-1).message,/权限未开启/);assert.equal(h.check.busy,false);
  await h.check.start('speaker');h.tick();assert.equal(h.check.busy,false);assert.match(h.updates.at(-1).message,/没听到请检查/);assert.equal(h.counts().stopped,0);
});
