// Protocol adapted from rhinoc/douvo, Copyright (c) 2026 rhinoc, MIT.
// See docs/third-party/Douvo-MIT.txt. This is an experimental private-protocol adapter.
import {EventEmitter} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import {loadInstalledAuth,clearInstalledSession} from './auth.js';

export const BAGESHUO_AUTH_REJECTED='BAGESHUO_AUTH_REJECTED';
const ticketEndpoint='https://dict-typeless.youdao.com/api/v1/realtime/tickets';
export function signedParameters(deviceId,now=Date.now()){
  const bucket=[...Buffer.from(deviceId)].reduce((hash,byte)=>(Math.imul(hash,31)+byte)>>>0,0)%10;
  // Published macOS client identity used by the reference implementation. It has
  // not yet been verified against this Windows account; no binary patching is used.
  const params={product:'typeless',appVersion:'1.0.30',client:'mac',mid:'macosaarch64',vendor:'direct',screen:'1920x1200',model:'aarch64',imei:deviceId,network:'wifi',keyfrom:'typeless.1.0.30.mac',abtest:String(bucket),yduuid:deviceId,keyid:'typeless_mac_main',mysticTime:String(now)};
  const keys=Object.keys(params).sort();
  params.sign=createHash('md5').update(keys.map(key=>key+'='+params[key]).concat('key=1TNWxQEtUtTg1XkhvJvQJl84TmtLXmCe').join('&')).digest('hex');
  params.pointParam=keys.concat('key').join(',');return params;
}

export function validateTicket(value){
  function find(item){if(!item||typeof item!=='object')return null;if(item.websocketUrl&&item.ticket)return item;for(const child of Object.values(item)){const found=find(child);if(found)return found;}return null;}
  const ticket=find(value);if(!ticket)throw new Error('网易没有返回有效的识别连接。');
  let url;try{url=new URL(ticket.websocketUrl);}catch{throw new Error('网易识别地址格式无效。');}
  if(url.protocol!=='wss:'||url.username||url.password||url.port&&url.port!=='443'||!(url.hostname==='youdao.com'||url.hostname.endsWith('.youdao.com'))||url.searchParams.get('ticket')!==ticket.ticket)throw new Error('网易返回了未允许的识别地址，连接已拒绝。');
  const audio=ticket.audioPolicy;
  if(ticket.protocolVersion!==1||audio?.encoding!=='PCM_S16LE'||audio.sampleRateHz!==16000||audio.channels!==1)throw new Error('网易识别协议或音频格式已变化，需要更新适配器。');
  const limit=ticket.limits?.maxAudioFrameBytes??65536;
  if(!Number.isInteger(limit)||limit<2||limit>1024*1024)throw new Error('网易音频帧限制无效。');
  return {url:url.href,maxFrame:limit-limit%2};
}

async function requestTicket(auth,{signal,fetcher=fetch}={}){
  const response=await fetcher(ticketEndpoint+'?'+new URLSearchParams(signedParameters(auth.deviceId)),{method:'POST',redirect:'error',signal,headers:{'Content-Type':'application/json',Accept:'application/json',Cookie:auth.cookie,'X-Typeless-User':auth.userId,Origin:'https://dict.youdao.com'},body:JSON.stringify({protocolVersion:1,capabilities:{generationStreaming:true}})});
  if(!response.ok){
    if(response.status===401){
      clearInstalledSession();
      const error=new Error('网易拒绝了知微复用的叭哥说会话（HTTP 401）。即使叭哥说客户端显示已登录，知微也可能需要重新验证会话。');
      error.code=BAGESHUO_AUTH_REJECTED;
      throw error;
    }
    if(response.status===403)throw new Error('网易拒绝了识别请求，当前私有协议签名可能不兼容。');
    throw new Error('网易识别连接申请失败，请稍后重试。');
  }
  return validateTicket(await response.json());
}

// Verify the same ticket endpoint as recognition, without opening a socket or sending audio.
export async function prepareBageshuo({authorized=false,loadAuth=loadInstalledAuth,fetcher}={}){
  const auth=await loadAuth({authorized});
  try{
    await requestTicket(auth,{signal:AbortSignal.timeout(12000),fetcher});
  }catch(error){
    clearInstalledSession();
    if(error.code===BAGESHUO_AUTH_REJECTED||error.message.startsWith('网易'))throw error;
    throw new Error('暂时无法验证网易识别登录，请检查连接后重试。');
  }finally{auth.cookie='';}
}

export class BageshuoASR{
  constructor(options={}){this.options=options;}
  createSession({sampleRate=16000}={}){
    if(sampleRate!==16000)throw new Error('网易叭哥说需要 16kHz 单声道 PCM16。');
    const session=new EventEmitter();session.on('error',()=>{});
    const options=this.options,controller=new AbortController(),utteranceId=randomUUID();
    let socket,closed=false,ready=false,started=false,ended=false,endSent=false,bytesSent=0,maxFrame=65536,queue=[],queued=0;
    let acceptLocalTranscript;
    const timeoutMs=options.timeoutMs??90000;
    const close=()=>{if(closed)return;closed=true;clearTimeout(timer);controller.abort();queue=[];queued=0;if(socket){socket.removeAllListeners();socket.on('error',()=>{});try{socket.close();}catch{}}};
    const fail=message=>{if(closed)return;close();session.emit('error',message instanceof Error?message:new Error(message));};
    const timer=setTimeout(()=>fail('网易识别超时，未将不完整的文字交给 Agent。'),timeoutMs);
    const send=value=>{
      if(closed)return false;
      if(socket?.readyState!==1||socket.bufferedAmount>2*1024*1024){fail('网易音频连接未就绪或发送拥塞。');return false;}
      try{socket.send(Buffer.isBuffer(value)?value:JSON.stringify(value));return true;}catch{fail('网易音频发送失败。');return false;}
    };
    const control=(type,payload)=>send({v:1,type,requestId:randomUUID(),utteranceId,payload});
    const drain=()=>{
      if(!ready||closed)return;
      while(queue.length){const chunk=queue.shift();queued-=chunk.length;for(let offset=0;offset<chunk.length;offset+=maxFrame){const part=chunk.subarray(offset,offset+maxFrame);if(!send(part))return;bytesSent+=part.length;}}
      if(ended&&!endSent){endSent=true;control('utterance.end',{audioBytesSent:bytesSent,audioDurationMs:Math.round(bytesSent/32)});}
    };
    Object.assign(session,{
      write(chunk){if(closed||ended)return;if(!Buffer.isBuffer(chunk)||chunk.length%2)throw new Error('网易识别需要完整 PCM16 音频帧。');if(queued+chunk.length>2*1024*1024){fail('网易识别等待连接的音频已超过缓冲上限。');return;}queue.push(Buffer.from(chunk));queued+=chunk.length;drain();},
      end(endOptions){if(closed||ended)return;ended=true;acceptLocalTranscript=endOptions?.acceptLocalTranscript;drain();},close,
    });
    queueMicrotask(async()=>{
      try{
        let auth;
        try {
          auth=await (options.authProvider??(()=>loadInstalledAuth({authorized:options.useInstalledSession===true})))();
        } catch (error) {
          const message=/^(需要你明确允许|请先在网易|本机叭哥说|叭哥说登录|当前 Windows|无法读取叭哥说)/.test(error.message)
            ? error.message : '无法读取叭哥说登录会话，请检查客户端登录。';
          throw Object.assign(new Error(message),{code:BAGESHUO_AUTH_REJECTED});
        }
        if(closed){auth.cookie='';return;}
        let ticket;try{ticket=await requestTicket(auth,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(12000)]),fetcher:options.fetcher});}finally{auth.cookie='';}
        if(closed)return;maxFrame=ticket.maxFrame;
        socket=(options.socketFactory??(url=>new WebSocket(url,{followRedirects:false,maxPayload:1024*1024,handshakeTimeout:12000})))(ticket.url);
        socket.on('error',()=>fail('网易语音连接失败。'));socket.on('close',()=>fail('网易连接在返回完整结果前关闭，未执行部分识别内容。'));
        socket.on('message',(data,isBinary)=>{
          if(closed)return;
          if(isBinary){fail('网易识别返回了不支持的数据格式。');return;}
          let event;try{event=JSON.parse(data.toString());}catch{fail('网易识别返回了无效事件。');return;}
          if(event.v!==1){fail('网易识别协议版本已变化。');return;}
          if(event.utteranceId&&event.utteranceId!==utteranceId)return;
          const payload=event.payload??{};
          switch(event.type){
            case 'connection.ready':if(started)return;started=true;control('utterance.start',{operation:'POLISH',sourceLanguage:'AUTO',targetLanguage:null,selectedText:null,audio:{encoding:'PCM_S16LE',sampleRateHz:16000,channels:1}});break;
            case 'utterance.ready':
              if(!started||ready)return;
              if(payload.maxAudioFrameBytes!==undefined){const limit=payload.maxAudioFrameBytes;if(!Number.isInteger(limit)||limit<2){fail('网易音频帧限制无效。');return;}maxFrame=Math.min(maxFrame,limit-limit%2);}
              ready=true;drain();break;
            case 'transcript.partial':case 'transcript.final':{
              const text=payload.fullText??payload.rawText;
              if(typeof text!=='string'||text.length>30000)break;
              // Only an ended utterance with a complete local command can skip polishing.
              if(event.type==='transcript.final'&&endSent&&acceptLocalTranscript?.(text)){
                close();session.emit('final',{text});break;
              }
              session.emit('partial',{text});break;
            }
            case 'generation.completed':
              if(!endSent||typeof payload.resultText!=='string'||payload.resultText.length>30000){fail('网易未返回完整终稿，未执行部分识别内容。');return;}
              close();session.emit('final',{text:payload.resultText});break;
            case 'generation.failed':fail('网易未能完成文字整理，本句未发送。');break;
            case 'utterance.failed':fail('网易未能完成语音转写，本句未发送。');break;
            case 'error':fail('网易识别服务返回错误，本句未发送。');break;
          }
        });
      }catch(error){if(!closed)fail(error.code===BAGESHUO_AUTH_REJECTED?error:/^(需要你明确允许|请先在网易|本机叭哥说|叭哥说登录|当前 Windows|无法读取叭哥说|网易)/.test(error.message)?error.message:'网易语音连接初始化失败，请检查账号与网络。');}
    });
    return session;
  }
}
