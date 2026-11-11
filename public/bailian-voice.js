export function createBailianVoice({token,onError=()=>{},onChange=()=>{},onLevel=()=>{}}){
  let epoch=0,context,mic,source,node,socket,pending=false,phase='',cancelStart,mode,held=false,captureEpoch=0;
  const setMic=()=>{
    const enabled=!!mic&&(mode!=='ptt'||held);
    for(const track of mic?.getTracks()??[])track.enabled=enabled;
    node?.port.postMessage({type:'capture',enabled,epoch:++captureEpoch});
  };
  function hold(action){
    if(socket?.readyState!==1||!mic||mode!=='ptt')return false;
    socket.send(JSON.stringify({type:'hold',action}));
    held=action==='start';setMic();return true;
  }
  function releaseInput(){
    held=false;source?.disconnect?.();source=null;
    mic?.getTracks().forEach(track=>track.stop());mic=null;setMic();
  }
  function control(type,enabled){
    if(socket?.readyState!==1)return false;
    socket.send(JSON.stringify({type,enabled}));return true;
  }
  function pauseInput(){
    if(!mic||!control('input',false))return false;
    releaseInput();onChange();return true;
  }
  const release=()=>{releaseInput();socket?.close();socket=null;node?.disconnect();node=null;void context?.close().catch(()=>{});context=null;};
  async function stop(){++epoch;cancelStart?.();cancelStart=null;release();pending=false;phase='';onChange();}
  async function start(){
    if(pending||mic)return;
    const existing=socket,current=existing?epoch:++epoch;
    pending=true;phase='正在准备扬声器…';onChange();
    try{
      // Unlock output inside the click gesture, before the microphone permission wait.
      const ctx=context??=new AudioContext({sampleRate:16000,latencyHint:'interactive'});
      let resumeTimer;
      try{await Promise.race([ctx.resume(),new Promise((_,reject)=>{resumeTimer=setTimeout(()=>reject(new Error('浏览器未允许声音播放，请点击页面后重新开启语音。')),4000);})]);}finally{clearTimeout(resumeTimer);}
      if(current!==epoch)return;
      phase='正在等待麦克风权限，请允许此页面使用麦克风；可点停止取消。';onChange();
      let cancelled=false;
      const acquisition=navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1}});
      acquisition.then(stream=>{if(current!==epoch||cancelled)stream.getTracks().forEach(t=>t.stop());},()=>{});
      let micTimer,stream,cancel;
      try{stream=await Promise.race([acquisition,new Promise((_,reject)=>{cancelStart=cancel=()=>reject(new Error('语音启动已取消'));micTimer=setTimeout(()=>reject(new Error('麦克风权限等待超时。请允许此页面使用麦克风，或在Edge/Chrome中打开本机地址。')),15000);})]);}catch(error){cancelled=true;throw error;}finally{clearTimeout(micTimer);if(cancelStart===cancel)cancelStart=null;}
      if(current!==epoch){stream.getTracks().forEach(t=>t.stop());return;}mic=stream;setMic();
      if(ctx.sampleRate!==16000)throw new Error('此浏览器未能建立16kHz音频，请使用最新Edge或Chrome。');
      if(existing){
        source=ctx.createMediaStreamSource(stream);
        if(!control('input',true))throw new Error('音频连接已断开，请重新开启语音');
        source.connect(node);return;
      }
      phase='正在连接本机音频…';onChange();
      await ctx.audioWorklet.addModule('/voice-worklet.js');if(current!==epoch)return;
      const processor=node=new AudioWorkletNode(ctx,'zhiwei-duplex',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});
      setMic();
      processor.onprocessorerror=()=>{if(current===epoch){onError('浏览器音频处理停止，已释放麦克风，请重新开启语音。');void stop();}};
      const ws=socket=new WebSocket(location.origin.replace(/^http/,'ws')+'/api/voice/audio',['zhiwei-audio',token()]);ws.binaryType='arraybuffer';
      processor.port.onmessage=({data})=>{
        if(current!==epoch||ws.readyState!==1)return;
        if(data.type==='mic'){if(data.epoch!==captureEpoch||!mic||(mode==='ptt'&&!held))return;if(ws.bufferedAmount>64000){onError('音频上传拥塞，已停止语音');void stop();return;}ws.send(data.pcm);}
        else if(data.type==='played')ws.send(JSON.stringify(data));
        else if(data.type==='level')onLevel(data);
        else {onError('音频播放缓冲区异常，已停止语音');void stop();}
      };
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('本机音频连接超时')),10000);
        ws.onerror=()=>{clearTimeout(timer);reject(new Error('本机音频连接失败'));};
        ws.onclose=event=>{clearTimeout(timer);const message='音频连接已关闭'+(event.reason?'：'+event.reason.slice(0,120):'，请重新开启语音');reject(new Error(message));if(current===epoch){onError(message);void stop();}};
        ws.onmessage=event=>{
          if(current!==epoch)return;
          if(typeof event.data==='string'){
            const message=JSON.parse(event.data);
            if(message.type==='ready'){clearTimeout(timer);resolve();}
            else if(message.type==='input-paused'){cancelStart?.();releaseInput();onChange();}
            else if(['reset','flush'].includes(message.type))processor.port.postMessage(message);
            else if(message.type==='error'){clearTimeout(timer);reject(new Error(message.message));onError(message.message);void stop();}
          }else{
            const view=new DataView(event.data),samples=new Float32Array((view.byteLength-4)/2);
            for(let i=0;i<samples.length;i++)samples[i]=view.getInt16(4+i*2,true)/32768;
            processor.port.postMessage({type:'audio',id:view.getUint32(0,true),samples},[samples.buffer]);
          }
        };
      });
      if(current!==epoch)return;
      source=ctx.createMediaStreamSource(stream);
      source.connect(processor);processor.connect(ctx.destination);
    }catch(error){
      if(current===epoch){
        onError(error.message);
        if(existing){control('input',false);releaseInput();}
        else await stop();
      }
    }
    finally{if(current===epoch){pending=false;phase='';}onChange();}
  }
  return {start,stop,hold,pauseInput,setReading:enabled=>control('reading',enabled),get pending(){return pending;},get phase(){return phase;},sync(voice){
    if(voice?.spokenModes&&mode!==voice.mode){mode=voice.mode;held=false;setMic();}
    if(!voice?.enabled&&!voice?.changing&&socket&&!pending)void stop();
  }};
}
