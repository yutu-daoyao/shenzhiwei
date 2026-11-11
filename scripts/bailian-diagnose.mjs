// One explicitly invoked isolated diagnostic, never scheduled. No physical devices.
import {start} from '../src/main.js';
import {readFile,mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import WebSocket from 'ws';
if(!process.argv[2]){console.error('用法：node scripts/bailian-diagnose.mjs 已有中文16kHz单声道PCM16文件');process.exit(1);}
const dataDir=await mkdtemp(path.resolve('data/bailian-diagnose-'));
const app=await start({port:0,dataDir,workspace:path.resolve('test-workspace'),trayEnabled:false});
let ws;const begin=Date.now(),metrics={},mark=k=>{metrics[k]??=Date.now()-begin;};
let audioBytes=0;
try{
  await app.ready;
  const s=await(await fetch(app.origin+'/api/state')).json();
  app.client.on('change',()=>{const c=app.client;
    if(c.voice.partial)mark('recognizedMs');if(c.task.status==='running')mark('codexStartedMs');
    if([...c.items.values()].some(i=>i.type==='agentMessage'&&i.text))mark('textMs');
  });
  ws=new WebSocket(app.origin.replace('http:','ws:')+'/api/voice/audio',['zhiwei-audio',s.csrf],{origin:app.origin});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('socket ready timeout')),10000);
    ws.on('error',()=>reject(new Error('socket failed')));
    ws.on('message',(data,binary)=>{
      if(binary){mark('audioMs');audioBytes+=data.length-4;ws.send(JSON.stringify({type:'played',id:data.readUInt32LE(0)}));}
      else if(JSON.parse(data).type==='ready'){clearTimeout(timer);resolve();}
    });
  });
  const pcm=await readFile(path.resolve(process.argv[2]));
  mark('uploadStartedMs');
  const audio=Buffer.concat([Buffer.alloc(6400),pcm,Buffer.alloc(32000)]);
  for(let i=0;i<audio.length;i+=640){const frame=Buffer.alloc(640);audio.copy(frame,0,i,Math.min(i+640,audio.length));ws.send(frame);await delay(20);}
  const deadline=Date.now()+60000;
  while(Date.now()<deadline){
    if(app.client.voice.error)break;
    if(audioBytes&&app.client.task.status==='completed'&&!app.client.voice.pipeline?.turn)break;
    ws.send(Buffer.alloc(640));await delay(20);
  }
  console.log(JSON.stringify({...metrics,audioBytes,task:app.client.task.status,voice:app.client.voice.state,error:app.client.voice.error??app.client.error,physicalDevices:false}));
}finally{ws?.terminate();await app.close();}
