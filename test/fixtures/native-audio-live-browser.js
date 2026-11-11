import {createNativeVoice} from './native-voice.js';
const status=document.querySelector('#status'),button=document.querySelector('#run');
let token,voice,context,processor,source,destination,poll,deadline,metrics,stopping=false,peers=[],element;
async function api(route,body={}){const r=await fetch('/api/'+route,{method:'POST',headers:{Origin:location.origin,'Content-Type':'application/json','X-Zhiwei-CSRF':token},body:JSON.stringify(body)});const value=await r.json();if(!r.ok)throw new Error(value.error||r.status);return value;}
function show(){status.textContent=JSON.stringify(metrics,null,2);}
async function finish(reason){
  if(stopping)return;stopping=true;clearInterval(poll);clearTimeout(deadline);
  metrics.result=reason;show();await voice?.stop();source?.stop();processor?.disconnect();
  destination?.stream.getTracks().forEach(t=>t.stop());await context?.close();
  const state=await(await fetch('/api/state')).json();metrics.closed=state.realtime.status;show();
  button.disabled=state.attempts>=2;
}
document.querySelector('#stop').onclick=()=>void finish('手动停止');
button.onclick=async()=>{
  button.disabled=true;stopping=false;peers=[];
  metrics={phase:'启动',physicalMicrophone:false,physicalSpeaker:false,decodedSamples:0,nonzeroSamples:0,elementPlayResolved:false,elementTime:0,events:[],transcripts:[]};show();
  try{
    const state=await(await fetch('/api/state')).json();token=state.csrf;
    context=new AudioContext();await context.resume();
    const first=await context.decodeAudioData(await(await fetch('/first.wav')).arrayBuffer());
    const second=await context.decodeAudioData(await(await fetch('/interrupt.wav')).arrayBuffer());
    destination=context.createMediaStreamDestination();
    const inject=buffer=>{source=context.createBufferSource();source.buffer=buffer;source.connect(destination);source.start();};
    class Peer extends RTCPeerConnection{
      constructor(){super();peers.push(this);this.addEventListener('track',event=>{
        const remote=context.createMediaStreamSource(event.streams[0]??new MediaStream([event.track]));
        processor=context.createScriptProcessor(2048,1,1);const gain=context.createGain();gain.gain.value=0;
        remote.connect(processor);processor.connect(gain);gain.connect(context.destination);
        processor.onaudioprocess=e=>{
          const data=e.inputBuffer.getChannelData(0);metrics.decodedSamples+=data.length;
          for(const sample of data)if(Math.abs(sample)>0.001){metrics.nonzeroSamples++;metrics.lastNonzeroAt=Math.round(performance.now());}
          if(!metrics.interruptAt&&metrics.nonzeroSamples>context.sampleRate*0.6){metrics.interruptAt=performance.now();metrics.phase='已收到真实回复音频，注入插话';inject(second);show();}
        };
      });}
      createDataChannel(...args){const channel=super.createDataChannel(...args);channel.addEventListener('message',event=>{
        try{const value=JSON.parse(event.data);metrics.events.push({type:value.type,status:value.turn?.status??value.response?.status,role:value.turn?.role,text:value.item?.text??value.turn?.transcript,reason:value.turn?.reason,at:Math.round(performance.now())});metrics.events=metrics.events.slice(-100);show();}catch{}
      });return channel;}
    }
    class SilentAudio extends Audio{
      constructor(){super();this.muted=true;element=this;}
      async play(){this.muted=true;await super.play();metrics.elementPlayResolved=true;metrics.elementTime=this.currentTime;show();}
    }
    voice=createNativeVoice({api,Peer,AudioElement:SilentAudio,media:{getUserMedia:async()=>destination.stream},onError:error=>{metrics.error=error;void finish('失败');}});
    await voice.start();
    if(voice.status!=='connected')throw new Error('未连接');
    metrics.phase='已连接，发送预生成中文音频';inject(first);show();
    poll=setInterval(async()=>{
      try{const s=await(await fetch('/api/state')).json();metrics.transcripts=s.transcripts;metrics.protocol=s.protocol;metrics.elementTime=element?.currentTime;show();
        if(metrics.interruptAt&&performance.now()-metrics.interruptAt>18000){
          const stats=await peers[0].getStats();metrics.rtp=[];
          stats.forEach(r=>{if(r.type==='inbound-rtp'&&r.kind==='audio')metrics.rtp.push({bytesReceived:r.bytesReceived,totalSamplesReceived:r.totalSamplesReceived});});
          await finish('测试已结束，请按转写、解码和中断事件判断，不自动宣称通过');
        }
      }catch(error){metrics.error=error.message;void finish('失败');}
    },500);
    deadline=setTimeout(()=>void finish('90秒超时，未重试'),90000);
  }catch(error){metrics.error=error.message;await finish('失败');}
};
