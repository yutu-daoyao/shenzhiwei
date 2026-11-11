import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';

const cancelled=()=>new DOMException('音频已停止','AbortError');
export class BrowserPlayback {
  constructor(socket){this.reportsLevel=true;this.socket=socket;this.pending=new Map();this.samples=0;this.sequence=0;this.epoch=0;this.waiters=new Set();}
  notify(){for(const wake of this.waiters)wake();this.waiters.clear();}
  ack(id){const n=this.pending.get(id);if(n===undefined)return;this.pending.delete(id);this.samples-=n;this.notify();}
  async wait(signal,epoch){
    if(signal?.aborted||epoch!==this.epoch)throw cancelled();
    await new Promise((resolve,reject)=>{
      const done=error=>{clearTimeout(timer);this.waiters.delete(wake);signal?.removeEventListener('abort',abort);error?reject(error):resolve();};
      const wake=()=>done(),abort=()=>done(cancelled());
      const timer=setTimeout(()=>done(new Error('浏览器音频播放确认超时')),10000);
      this.waiters.add(wake);signal?.addEventListener('abort',abort,{once:true});
    });
    if(signal?.aborted||epoch!==this.epoch)throw cancelled();
  }
  async write(chunk,{signal,sampleRate=16000}={}){
    if(sampleRate!==16000||!Buffer.isBuffer(chunk)||chunk.length%2)throw new Error('需要16kHz PCM16音频');
    const epoch=this.epoch;
    for(let offset=0;offset<chunk.length;offset+=3200){
      const frame=chunk.subarray(offset,offset+3200),samples=frame.length/2;
      while(this.samples+samples>4800)await this.wait(signal,epoch);
      if(signal?.aborted||epoch!==this.epoch)throw cancelled();
      if(this.socket.readyState!==1||this.socket.bufferedAmount>256000)throw new Error('浏览器音频连接已断开或拥塞');
      const id=++this.sequence,packet=Buffer.allocUnsafe(frame.length+4);packet.writeUInt32LE(id);frame.copy(packet,4);
      this.pending.set(id,samples);this.samples+=samples;this.socket.send(packet);
    }
  }
  async drain({signal}={}){const epoch=this.epoch;if(this.socket.readyState===1)this.socket.send(JSON.stringify({type:'flush'}));while(this.pending.size)await this.wait(signal,epoch);}
  stop(){++this.epoch;this.pending.clear();this.samples=0;this.notify();if(this.socket.readyState===1)this.socket.send(JSON.stringify({type:'reset'}));}
  async close(){this.stop();}
}

export function attachBrowserAudio(server,client,{origin,csrf,closing=()=>false}){
  const sockets=new WebSocketServer({noServer:true,maxPayload:4096,perMessageDeflate:false,handleProtocols:()=> 'zhiwei-audio'});
  let active;
  server.on('upgrade',(request,socket,head)=>{
    const protocols=String(request.headers['sec-websocket-protocol']??'').split(',').map(s=>s.trim());
    if(closing()||request.url!=='/api/voice/audio'||request.headers.host!==new URL(origin).host||request.headers.origin!==origin||!protocols.includes(csrf)||!protocols.includes('zhiwei-audio')||active||client.voice.enabled||client.voice.changing||client.realtime.active){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    sockets.handleUpgrade(request,socket,head,ws=>sockets.emit('connection',ws));
  });
  sockets.on('connection',ws=>{
    active=ws;const capture=new EventEmitter(),playback=new BrowserPlayback(ws);
    let running=false,frames=0,windowStart=Date.now(),closed=false;
    capture.start=async()=>{running=true;ws.send(JSON.stringify({type:'ready'}));};
    capture.close=async()=>{running=false;ws.close();};
    capture.pauseInput=()=>{if(running&&ws.readyState===1)ws.send(JSON.stringify({type:'input-paused'}));};
    client.voice.capture=capture;client.voice.playback=playback;
    ws.on('error',()=>{});
    ws.on('message',(data,binary)=>{
      if(closed||!running)return;
      if(Date.now()-windowStart>=1000){frames=0;windowStart=Date.now();}
      if(++frames>180){ws.close(1008,'音频发送过快');return;}
      if(binary){if(data.length!==640){ws.close(1008,'音频格式无效');return;}capture.emit('frame',data);}
      else {
        try{
          const message=JSON.parse(data);
          if(message.type==='played'&&Number.isSafeInteger(message.id))playback.ack(message.id);
          else if(message.type==='hold'&&client.voice.config.spokenModes&&['start','stop','cancel'].includes(message.action)){
            if(client.voice.mode==='ptt'&&client.voice.inputEnabled){
              if(message.action==='cancel'){client.voice.pipeline?.discardInput();client.voice.changed();}
              else client.voice.ptt(message.action);
            }
          }else if(message.type==='input'&&client.voice.config.spokenModes&&typeof message.enabled==='boolean'){
            if(message.enabled&&(client.switching||!client.voice.setInput(true)))capture.pauseInput();
            else if(!message.enabled)client.voice.setInput(false);
          }else if(message.type==='reading'&&client.voice.config.spokenModes&&typeof message.enabled==='boolean'){
            client.voice.setReading(message.enabled);
          }else ws.close(1008,'音频确认无效');
        }catch{ws.close(1008,'音频协议无效');}
      }
    });
    ws.on('close',()=>{closed=true;running=false;playback.stop();void client.voice.setEnabled(false).finally(()=>{if(active===ws)active=null;}).catch(()=>{});});
    // Audio readiness must not wait for a remote thread/start. The voice brain's
    // existing send path creates the thread when the first utterance arrives.
    Promise.resolve().then(()=>{client.ready();if(closed)return;return client.voice.setEnabled(true);}).catch(()=>{if(ws.readyState===1)ws.send(JSON.stringify({type:'error',message:'语音启动失败，请查看页面配置提示。'}));ws.close();});
  });
  return {close(){active?.terminate();sockets.close();}};
}
