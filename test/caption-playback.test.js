import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
async function processor(){let Processor;const messages=[];vm.runInNewContext(await readFile(new URL('../public/caption-playback-worklet.js',import.meta.url),'utf8'),{sampleRate:1000,Float32Array,Math,AudioWorkletProcessor:class{constructor(){this.port={postMessage:m=>messages.push(m)};}},registerProcessor:(_,p)=>Processor=p});const p=new Processor();return {p,messages,command:type=>p.port.onmessage({data:{type}}),render:value=>{const out=[new Float32Array(100),new Float32Array(100)];p.process([[new Float32Array(100).fill(value)]],[out]);return out[0];}};}

test('caption playback holds all speech until Chinese is ready, then plays retained audio in order',async()=>{
 const h=await processor();assert.ok(h.render(0.25).every(x=>x===0));assert.ok(h.render(0.5).every(x=>x===0));
 h.command('release');assert.ok(h.render(0).every(x=>x===0.25));assert.ok(h.render(0).every(x=>x===0.5));assert.ok(h.messages.some(m=>m.type==='level'&&m.value>0));
});
test('hold pauses without dropping speech, reset discards interrupted speech, and long silence does not overflow',async()=>{
 const h=await processor();h.render(0.5);h.command('hold');assert.ok(h.render(0).every(x=>x===0));h.command('reset');h.command('release');assert.ok(h.render(0).every(x=>x===0));
 h.command('reset');h.render(0.25);for(let i=0;i<1300;i++)h.render(0);assert.ok(!h.messages.some(m=>m.type==='overflow'));
 h.command('release');assert.ok(h.render(0).every(x=>x===0.25));
});

import {createNativeVoice} from '../public/native-voice.js';
test('native subtitle-priority mutes direct stream, releases only matching Chinese and clears audio on stop',async()=>{
 const commands=[],stream={getTracks:()=>[{stop(){commands.push('mic-stop');}}],getAudioTracks:()=>[]};let audio;
 class Peer{constructor(){this.iceGatheringState='complete';}createDataChannel(){}addTrack(){}close(){}async createOffer(){return {sdp:'v=0'};}async setLocalDescription(d){this.localDescription=d;}async setRemoteDescription(){this.ontrack({streams:[stream]});this.connectionState='connected';this.onconnectionstatechange();}}
 const voice=createNativeVoice({media:{getUserMedia:async()=>stream},Peer,Context:null,AudioElement:class{constructor(){audio=this;}play(){throw new Error('Direct audio must not play');}pause(){}},Playback:async()=>({release:()=>commands.push('release'),hold:()=>commands.push('hold'),reset:()=>commands.push('reset'),close:()=>commands.push('close')}),api:async r=>r==='realtime/start'?{session:'s',sdp:'v=0'}:{}});
 await voice.start({language:'en',syncCaptions:true});assert.equal(audio.muted,true);
 voice.updateCaption({id:'old',source:'Old.',status:'ready'},'','New question');assert.equal(commands.includes('release'),false);
 voice.updateCaption({id:'a',source:'Take your time.',status:'pending'},'Take your time.','New question');assert.equal(commands.includes('release'),false);
 voice.updateCaption({id:'a',source:'Take your time.',text:'慢慢来',status:'ready'},'Take your time.','New question');assert.equal(commands.filter(c=>c==='release').length,1);
 voice.updateCaption({id:'a',source:'Take your time.',text:'慢慢来',status:'ready'},'Take your time.','New question');assert.equal(commands.filter(c=>c==='release').length,1);
 await voice.stop();assert.ok(commands.includes('close'));assert.ok(commands.includes('mic-stop'));
});
