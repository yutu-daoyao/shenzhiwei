// Local-only device checks: no recording, network request, or speech provider.
export function createAudioCheck({media=globalThis.navigator?.mediaDevices, Context=globalThis.AudioContext,
  onChange=()=>{}, setTimer=setTimeout, clearTimer=clearTimeout}={}) {
  let epoch=0, stream, context, timer, busy=false;
  function release(){
    clearTimer(timer);timer=null;
    stream?.getTracks().forEach(track=>track.stop());stream=null;
    const old=context;context=null;void old?.close().catch(()=>{});
  }
  function stop(){++epoch;release();busy=false;onChange({busy:false,level:0,message:'检查已停止，麦克风已释放。'});}
  async function start(kind){
    if(busy)return;
    const current=++epoch;busy=true;
    onChange({busy:true,level:0,message:kind==='mic'?'请允许麦克风，然后说一句话。检查仅在本机进行。':'正在播放轻柔提示音，请确认扬声器音量。'});
    try {
      if(!Context)throw new Error('浏览器不支持音频检查，请使用 Edge 或 Chrome。');
      context=new Context();await context.resume();
      if(current!==epoch)return;
      if(kind==='mic'){
        if(!media?.getUserMedia)throw new Error('浏览器无法访问麦克风。');
        const input=await media.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}});
        if(current!==epoch){input.getTracks().forEach(track=>track.stop());return;}
        stream=input;
        const source=context.createMediaStreamSource(stream),analyser=context.createAnalyser();
        analyser.fftSize=1024;source.connect(analyser); // Never connect microphone to speakers.
        const data=new Float32Array(analyser.fftSize);let peak=0,count=0;
        const sample=()=>{
          if(current!==epoch)return;
          analyser.getFloatTimeDomainData(data);
          const level=Math.sqrt(data.reduce((sum,value)=>sum+value*value,0)/data.length);peak=Math.max(peak,level);
          onChange({busy:true,level:Math.min(1,level*8),message:'对着麦克风说句话 · '+Math.ceil((50-count)/10)+' 秒后结束'});
          if(++count<50)timer=setTimer(sample,100);
          else {release();busy=false;onChange({busy:false,level:0,message:peak>0.008?'已检测到声音，麦克风已释放。接下来可开始语音对话。':'未检测到明显声音，麦克风已释放。请检查系统输入设备、静音开关或靠近麦克风重试。'});}
        };sample();
      }else{
        const gain=context.createGain();gain.connect(context.destination);
        const now=context.currentTime;
        gain.gain.setValueAtTime(0,now);gain.gain.linearRampToValueAtTime(0.08,now+0.08);gain.gain.linearRampToValueAtTime(0,now+0.9);
        const oscillator=context.createOscillator();oscillator.frequency.value=440;oscillator.connect(gain);oscillator.start(now);oscillator.stop(now+1);
        timer=setTimer(()=>{if(current!==epoch)return;release();busy=false;onChange({busy:false,level:0,message:'提示音已播放。听到了就说明输出正常；没听到请检查系统音量和输出设备。'});},1100);
      }
    }catch(error){
      if(current!==epoch)return;
      release();busy=false;
      onChange({busy:false,level:0,message:error.name==='NotAllowedError'?'麦克风权限未开启，请在浏览器网站权限中允许麦克风后重试。':error.name==='NotFoundError'?'未找到麦克风，请连接输入设备后重试。':error.message});
    }
  }
  return {start,stop,get busy(){return busy;}};
}
