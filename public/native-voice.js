import {createCaptionPlayback} from './caption-playback.js';
// Browser media goes directly to Codex's negotiated WebRTC peer. No custom ASR/TTS.
export function createNativeVoice({api,onChange=()=>{},onError=()=>{},onLevel=()=>{},onQuality=()=>{},Playback=createCaptionPlayback,media=navigator.mediaDevices,Peer=globalThis.RTCPeerConnection,AudioElement=globalThis.Audio,Context=globalThis.AudioContext,requestFrame=globalThis.requestAnimationFrame,cancelFrame=globalThis.cancelAnimationFrame}={}){
  let epoch=0,peer,mic,audio,session,status='off',pending=false,cancelWait,disconnectTimer,meter,raf,inputMeter,outputMeter,lastMeterAt=0,lastSpeechAt=-Infinity,qualityTimer,previousQuality,captionPlayback,captionSync=false,captionKey='',userText='',playbackPromise,captionOutput=0;
  function attachMeter(stream){
    if(!meter)return null;
    const source=meter.createMediaStreamSource(stream),analyser=meter.createAnalyser();analyser.fftSize=1024;source.connect(analyser);
    return {source,analyser,data:new Float32Array(analyser.fftSize)};
  }
  function rms(probe){
    if(!probe)return 0;probe.analyser.getFloatTimeDomainData(probe.data);
    let sum=0;for(const sample of probe.data)sum+=sample*sample;return Math.sqrt(sum/probe.data.length);
  }
  function readLevels(now){
    if(!meter)return;
    raf=requestFrame(readLevels);
    if(status!=='connected'||now-lastMeterAt<40)return;lastMeterAt=now;
    const input=rms(inputMeter),output=captionSync?captionOutput:rms(outputMeter);
    if(output>0.008)lastSpeechAt=now;
    const state=now-lastSpeechAt<180?'speaking':'listening';
    onLevel({state,level:state==='speaking'?output:input,levelAt:Date.now()});
  }
  function stopMeter(){
    if(raf)cancelFrame?.(raf);raf=0;
    inputMeter?.source.disconnect();outputMeter?.source.disconnect();inputMeter=outputMeter=null;
    void meter?.close().catch(()=>{});meter=null;lastMeterAt=0;lastSpeechAt=-Infinity;
  }
  const update=value=>{status=value;onChange();};
  const cleanup=()=>{captionPlayback?.close();captionPlayback=null;captionKey='';userText='';captionOutput=0;clearInterval(qualityTimer);qualityTimer=null;previousQuality=null;onQuality(null);stopMeter();clearTimeout(disconnectTimer);cancelWait?.();cancelWait=null;mic?.getTracks().forEach(track=>track.stop());mic=null;if(peer){peer.ontrack=null;peer.onconnectionstatechange=null;peer.close();peer=null;}if(audio){audio.pause();audio.srcObject=null;audio=null;}};
  async function stop(){
    ++epoch;cleanup();update('stopping');
    try{await api('realtime/stop',session?{session}:{});session=null;update('off');}
    catch(error){update('error');onError(error.message);}
  }
  async function start({checkOnly=false,language='en',syncCaptions=false,captionEngine='cloud'}={}){
    if(pending||['connecting','connected','stopping'].includes(status))return;
    pending=true;captionSync=syncCaptions&&language==='en'&&!checkOnly;const current=++epoch;update('connecting');
    try{
      if(!Peer||(!checkOnly&&!media?.getUserMedia))throw new Error('当前浏览器不支持实时语音，请使用最新 Edge 或 Chrome 打开本机地址。');
      // Optional visual telemetry. A failed meter never blocks negotiated audio.
      if(!checkOnly&&Context&&requestFrame){try{meter=new Context();void meter.resume().catch(()=>{});}catch{meter=null;}}
      if(!checkOnly){
        const stream=await media.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
        if(current!==epoch){stream.getTracks().forEach(track=>track.stop());return;}
        mic=stream;
        try{inputMeter=attachMeter(stream);raf=requestFrame?.(readLevels)||0;}catch{stopMeter();}
      }
      const connection=peer=new Peer();
      if(mic)for(const track of mic.getAudioTracks())connection.addTrack(track,mic);
      else connection.addTransceiver('audio',{direction:'sendrecv'});
      connection.createDataChannel('oai-events');
      audio=new AudioElement();audio.autoplay=!checkOnly;audio.muted=checkOnly||captionSync;
      connection.ontrack=event=>{
        if(current!==epoch)return;
        // A bounded playout cushion tolerates short network bursts; it cannot recover sustained packet loss.
        try{if(event.receiver&&'jitterBufferTarget' in event.receiver)event.receiver.jitterBufferTarget=240;else if(event.receiver&&'playoutDelayHint' in event.receiver)event.receiver.playoutDelayHint=0.24;}catch{}
        audio.srcObject=event.streams[0]??new MediaStream([event.track]);
        try{outputMeter?.source.disconnect();outputMeter=attachMeter(audio.srcObject);}catch{stopMeter();}
        if(captionSync){const stream=audio.srcObject;playbackPromise=Playback(stream,{onLevel:value=>{if(current===epoch)captionOutput=value;},onError:message=>{if(current===epoch){onError(message);void stop();}}}).then(player=>{if(current!==epoch){player.close();return;}captionPlayback?.close();captionPlayback=player;}).catch(error=>{if(current===epoch){onError(error.message);void stop();}});}
        if(!checkOnly&&!captionSync)void audio.play().catch(()=>{if(current!==epoch)return;onError('浏览器未能播放回复，请检查声音权限后重新连接。');void stop();});
      };
      let resolveConnected,rejectConnected;
      const connected=new Promise((resolve,reject)=>{resolveConnected=resolve;rejectConnected=reject;});connected.catch(()=>{});
      connection.onconnectionstatechange=()=>{
        if(current!==epoch)return;
        if(connection.connectionState==='connected'){clearTimeout(disconnectTimer);resolveConnected();}
        if(connection.connectionState==='disconnected'){clearTimeout(disconnectTimer);disconnectTimer=setTimeout(()=>{if(current===epoch&&connection.connectionState==='disconnected'){onError('音频连接已断开，已释放麦克风');void stop();}},8000);}
        if(['failed','closed'].includes(connection.connectionState)){
          rejectConnected(new Error('Codex 音频通道连接失败，请检查网络。'));
          if(status==='connected'){onError('Codex 音频连接已断开');void stop();}
        }
      };
      await connection.setLocalDescription(await connection.createOffer());
      await new Promise((resolve,reject)=>{
        if(connection.iceGatheringState==='complete')return resolve();
        const done=()=>{if(connection.iceGatheringState==='complete'){clearTimeout(timer);connection.removeEventListener('icegatheringstatechange',done);resolve();}};
        const timer=setTimeout(()=>{connection.removeEventListener('icegatheringstatechange',done);reject(new Error('音频网络协商超时'));},12000);
        cancelWait=()=>{clearTimeout(timer);connection.removeEventListener('icegatheringstatechange',done);reject(new Error('连接已取消'));};
        connection.addEventListener('icegatheringstatechange',done);
      });
      if(current!==epoch)return;
      const result=await api('realtime/start',{sdp:connection.localDescription.sdp,language,captionEngine});
      if(current!==epoch){await api('realtime/stop',{session:result.session});return;}
      session=result.session;
      await connection.setRemoteDescription({type:'answer',sdp:result.sdp});
      if(current!==epoch)return;
      let timer;
      try{await Promise.race([connected,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('音频通道未能连接，请检查网络后重试')),20000);cancelWait=()=>reject(new Error('连接已取消'));})]);}
      finally{clearTimeout(timer);}
      if(current!==epoch)return;
      await playbackPromise,captionOutput=0;if(current!==epoch)return;await api('realtime/connected',{session});if(current!==epoch)return;update('connected');
      if(!checkOnly&&typeof connection.getStats==='function')qualityTimer=setInterval(()=>{
        void connection.getStats().then(stats=>{if(current!==epoch)return;stats.forEach(s=>{
          if(s.type!=='inbound-rtp'||(s.kind||s.mediaType)!=='audio')return;
          const now={received:s.packetsReceived||0,lost:Math.max(0,s.packetsLost||0),concealed:s.concealedSamples||0,total:s.totalSamplesReceived||0};
          if(previousQuality){const received=now.received-previousQuality.received,lost=Math.max(0,now.lost-previousQuality.lost),total=now.total-previousQuality.total;onQuality({loss:lost/Math.max(1,received+lost),concealment:Math.max(0,now.concealed-previousQuality.concealed)/Math.max(1,total),jitter:s.jitter||0});}previousQuality=now;
        });}).catch(()=>{});
      },2000);
      if(checkOnly){await stop();if(status==='off')onChange('连接检查通过：未开启麦克风，也未播放音频。');}
    }catch(error){if(current===epoch){cleanup();await api('realtime/stop',session?{session}:{}).catch(()=>{});update('error');onError(error.message);}}
    finally{cancelWait=null;pending=false;onChange();}
  }
  return {start,stop,updateCaption(caption,assistantText,currentUser){
    if(!captionSync||!captionPlayback)return;
    if(currentUser&&currentUser!==userText){captionPlayback.reset();captionKey='';userText=currentUser;}
    const chinese=/[\u4e00-\u9fff]/.test(assistantText||'');
    const ready=chinese||!!(assistantText&&caption?.status==='ready'&&caption.source?.trimStart()===assistantText.trimStart());
    const key=chinese?assistantText:caption?.id+':'+caption?.source;
    if(ready&&key!==captionKey){captionKey=key;captionPlayback.release();}
    if(!ready)captionPlayback.hold();
  },get status(){return status;},get pending(){return pending;},sync(server){if(['off','error','unknown'].includes(server?.status)&&status==='connected'){++epoch;cleanup();update(server.status==='off'?'off':'error');if(server.error)onError(server.error);}}};
}
