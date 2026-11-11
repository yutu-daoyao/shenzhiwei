// Explicit one-night test harness. Never imported by production or npm test.
// Serves generated public WAVs as a synthetic microphone; no physical audio devices.
import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Zhiwei } from '../../src/client.js';
import { safeError } from '../../src/codex/process.js';
const root=fileURLToPath(new URL('../../',import.meta.url)),origin='http://127.0.0.1:4320';
const csrf=randomBytes(32).toString('hex');let attempts=process.argv.includes('--used-one')?1:0;
const client=new Zhiwei({workspace:path.join(root,'test-workspace'),dataDir:path.join(root,'data/night-native-audio')});
const protocol=[];
client.rpc.on('notification',({method,params:p={}})=>{
  if(!method.startsWith('thread/realtime/')||method.endsWith('/sdp')||method.includes('outputAudio'))return;
  protocol.push({method,role:p.role,keys:Object.keys(p),itemType:p.item?.type,itemRole:p.item?.role});
  if(protocol.length>80)protocol.shift();
});
await client.init();
const files={'/':['test/fixtures/native-audio-live.html','text/html'],
  '/test.js':['test/fixtures/native-audio-live-browser.js','text/javascript'],
  '/native-voice.js':['public/native-voice.js','text/javascript'],
  '/first.wav':['test-workspace/voice-night-first.wav','audio/wav'],
  '/interrupt.wav':['test-workspace/voice-night-interrupt.wav','audio/wav']};
const server=http.createServer(async(req,res)=>{
  const json=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  try{
    if(req.headers.host!=='127.0.0.1:4320'||(req.headers.origin&&req.headers.origin!==origin))return json(403,{});
    if(req.method==='GET'&&files[req.url]){const [file,mime]=files[req.url];res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-store'});res.end(await readFile(path.join(root,file)));return;}
    if(req.method==='GET'&&req.url==='/api/state')return json(200,{csrf,attempts,protocol,realtime:client.realtime.snapshot(),task:client.task.status,
      transcripts:[...client.items.values()].filter(i=>['userMessage','agentMessage'].includes(i.type)).map(i=>({role:i.type,text:i.text}))});
    if(req.method!=='POST'||req.headers.origin!==origin||req.headers['x-zhiwei-csrf']!==csrf)return json(403,{});
    let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>150000)return json(413,{});}
    const body=JSON.parse(raw||'{}');let result;
    if(req.url==='/api/realtime/start'){if(++attempts>2)return json(409,{error:'本测试最多两次，已停止'});result=await client.realtime.start(body.sdp);}
    else if(req.url==='/api/realtime/connected')client.realtime.connected(body.session);
    else if(req.url==='/api/realtime/stop')await client.realtime.stop(body.session);
    else return json(404,{});
    json(200,result??{ok:true});
  }catch(error){json(400,{error:safeError(error)});}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(4320,'127.0.0.1',resolve);});
console.log('NATIVE_AUDIO_TEST '+origin+'; max 2 attempts; no real microphone or speaker');
async function close(){await client.close();server.close();}
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
// Cleanup deadline only; never schedules another run.
setTimeout(()=>void close(),12*60*1000).unref();
