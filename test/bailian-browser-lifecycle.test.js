import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

test('unexpected audio socket close reports its reason and releases the microphone instead of silently stopping',async()=>{
  let socket,processor,stopped=false;const errors=[],order=[],levels=[];
  const sandbox={setTimeout,clearTimeout,console,location:{origin:'http://127.0.0.1:4317'},
    navigator:{mediaDevices:{getUserMedia:async()=>{order.push('microphone');return {getTracks:()=>[{stop(){stopped=true;}}]};}}},
    AudioContext:class{constructor(){this.sampleRate=16000;this.audioWorklet={addModule:async()=>{}};}async resume(){order.push('unlock-speaker');}async close(){}createMediaStreamSource(){return {connect(){}};}},
    AudioWorkletNode:class{constructor(){processor=this;this.port={postMessage(){}};}connect(){}disconnect(){}},
    WebSocket:class{constructor(){socket=this;this.readyState=1;queueMicrotask(()=>this.onmessage({data:'{"type":"ready"}'}));}close(){}},
  };
  const code=(await readFile(new URL('../public/bailian-voice.js',import.meta.url),'utf8')).replace('export function','function');
  vm.runInNewContext(code+';this.factory=createBailianVoice;',sandbox);
  const voice=sandbox.factory({token:()=> 'test',onError:e=>errors.push(e),onLevel:value=>levels.push(value)});await voice.start();
  assert.deepEqual(order,['unlock-speaker','microphone']);
  processor.port.onmessage({data:{type:'level',listening:0.5,speaking:0}});
  assert.equal(levels[0].speaking,0);assert.equal(levels[0].listening,0.5);assert.deepEqual(errors,[]);
  socket.onclose({reason:'音频格式无效'});assert.equal(stopped,true);assert.match(errors[0],/音频格式无效/);assert.equal(voice.pending,false);
});


test('stopping browser input releases tracks but keeps playback and reuses the socket on resume',async()=>{
  const tracks=[],packets=[],posted=[];let socket,processor,contexts=0,closed=0;
  const sandbox={setTimeout,clearTimeout,location:{origin:'http://127.0.0.1:4317'},
    navigator:{mediaDevices:{getUserMedia:async()=>{const track={stop(){this.stopped=true;}};tracks.push(track);return {getTracks:()=>[track]};}}},
    AudioContext:class{constructor(){contexts++;this.sampleRate=16000;this.audioWorklet={addModule:async()=>{}};}async resume(){}async close(){closed++;}createMediaStreamSource(){return {connect(){},disconnect(){}};}},
    AudioWorkletNode:class{constructor(){processor=this;this.port={postMessage:message=>posted.push(message)};}connect(){}disconnect(){}},
    WebSocket:class{constructor(){assert.equal(socket,undefined);socket=this;this.readyState=1;queueMicrotask(()=>this.onmessage({data:'{"type":"ready"}'}));}send(packet){packets.push(packet);}close(){this.readyState=3;}},
  };
  const code=(await readFile(new URL('../public/bailian-voice.js',import.meta.url),'utf8')).replace('export function','function');
  vm.runInNewContext(code+';this.factory=createBailianVoice;',sandbox);
  const voice=sandbox.factory({token:()=> 'test'});
  voice.sync({enabled:false,spokenModes:true,mode:'default'});
  await voice.start();const old=posted.at(-1).epoch;
  voice.pauseInput();assert.equal(tracks[0].stopped,true);assert.equal(closed,0);
  assert.deepEqual(JSON.parse(packets.at(-1)),{type:'input',enabled:false});
  processor.port.onmessage({data:{type:'mic',epoch:old,pcm:new ArrayBuffer(640)}});
  assert.equal(packets.length,1);
  socket.onmessage({data:new ArrayBuffer(644)});
  assert.equal(posted.at(-1).type,'audio');
  voice.setReading(false);assert.deepEqual(JSON.parse(packets.at(-1)),{type:'reading',enabled:false});
  await voice.start();assert.equal(contexts,1);assert.equal(tracks.length,2);
  assert.deepEqual(JSON.parse(packets.at(-1)),{type:'input',enabled:true});
  voice.sync({enabled:true,spokenModes:true,mode:'ptt'});
  assert.equal(tracks[1].enabled,false);voice.hold('start');assert.equal(tracks[1].enabled,true);
  const held=posted.at(-1).epoch;
  processor.port.onmessage({data:{type:'mic',epoch:held,pcm:new ArrayBuffer(640)}});
  voice.hold('stop');assert.equal(tracks[1].enabled,false);
  const sent=packets.length;
  processor.port.onmessage({data:{type:'mic',epoch:held,pcm:new ArrayBuffer(640)}});
  assert.equal(packets.length,sent);
  assert.deepEqual(JSON.parse(packets.at(-1)),{type:'hold',action:'stop'});
  await voice.stop();assert.equal(closed,1);assert.equal(tracks[1].stopped,true);
});

test('a pending microphone permission can be cancelled and a late granted track is released',async()=>{
  let grant,stopped=false;const errors=[];
  const sandbox={setTimeout,clearTimeout,location:{origin:'http://127.0.0.1:4317'},
    navigator:{mediaDevices:{getUserMedia:()=>new Promise(r=>grant=r)}},
    AudioContext:class{async resume(){}async close(){}},
  };
  const code=(await readFile(new URL('../public/bailian-voice.js',import.meta.url),'utf8')).replace('export function','function');
  vm.runInNewContext(code+';this.factory=createBailianVoice;',sandbox);
  const voice=sandbox.factory({token:()=> 'test',onError:e=>errors.push(e)}),starting=voice.start();
  await new Promise(r=>setImmediate(r));assert.match(voice.phase,/麦克风权限/);
  await voice.stop();await starting;assert.equal(voice.pending,false);assert.deepEqual(errors,[]);
  grant({getTracks:()=>[{stop(){stopped=true;}}]});await new Promise(r=>setImmediate(r));assert.equal(stopped,true);
});
