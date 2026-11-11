export function mountVoiceprint({document,api,onChange=()=>{},isBlocked=()=>false}){
  const $=id=>document.getElementById('voiceprint-'+id);
  if(!$('record'))return {update(){},stop(){},get busy(){return false;}};
  const phrases=[
    '用平常聊天的声音介绍一下今天的安排。说说你想先做什么、下午有什么事、晚上准备怎么休息。',
    '像平时问知微一样，连续问几个问题。例如今天的项目进展怎么样、还有哪几件事、我应该先处理哪一件。',
    '自然地说几句常用指令。例如先暂停一下，帮我把这段内容整理成提纲，然后提醒我检查最后一项。',
    '说说最近读过的一篇文章。它讲了什么，你记住了哪个观点，还有哪里想再了解一下？',
    '用稍轻的声音描述手边的两三样东西。它们放在哪里，平时怎么用，哪一样用得最多？',
    '像和熟人聊天一样，讲一讲你最近完成的一件小事。说说经过，以及下次打算怎样做。',
    '用平常报信息的语气，说几个日期、时间和数字，再解释这些数字分别指什么。',
    '稍快一点，说说你准备怎样规划明天的时间。说到需要留出空档时，可以短暂停顿。',
    '想象你正在解释一个问题。说说事情的起因、你试过的方法，以及你目前的判断。',
    '换一个平时说话的姿势或坐在常用的位置，说说你今天最想让知微帮你完成什么。',
    '读一句自己刚写的话，再用自己的话复述一遍，说说最重要的地方在哪里。',
    '按平时的语速自由说几句。可以问候、提问，再补充一句你平时容易说得比较轻的话。',
  ];
  let state,posting=false,recording=false,dirty=false,note='',drafts=[],epoch=0,cancel;
  let retryIndex=null;
  const busy=()=>posting||recording;
  const blocked=()=>isBlocked()||state?.voice?.enabled||state?.voice?.changing||state?.workbench?.switching||state?.locked||['starting','running','stopping','unknown'].includes(state?.task?.status)||['connecting','connected','stopping','unknown'].includes(state?.realtime?.status);
  const discard=()=>{drafts.forEach(b=>b.fill(0));drafts=[];retryIndex=null;};
  function render(){
    const v=state?.voice?.voiceprint||{},locked=!state||blocked()||busy();
    const batchSize=v.batchSize||3,count=v.sampleCount||0,target=v.minSamples||12,max=v.maxSamples||24;
    const clipNumber=Math.min(max,count+Math.min(batchSize,(retryIndex??drafts.length)+1));
    const readyToSave=drafts.length===batchSize&&retryIndex===null;
    $('record').disabled=locked||!v.available||!$('consent').checked||readyToSave||count>=max;
    $('enroll').disabled=locked||!$('consent').checked||!readyToSave||count>=max;
    $('test').disabled=locked||!v.ready;
    $('delete').disabled=locked||(!v.enrolled&&!v.error);
    $('save').disabled=locked||(!v.enrolled&&!v.error);
    $('enabled').disabled=locked||!v.canEnable;$('threshold').disabled=locked||!v.enrolled;$('consent').disabled=locked;
    $('cancel').disabled=posting||(!recording&&!drafts.length);
    $('record').textContent=recording?'正在本机录音…':`${retryIndex===null?'录制':'重录'}第 ${clipNumber} 段 · 12 秒`;
    const phrase=phrases[clipNumber-1]||'用日常语气说一段新的话。可以换时间、语速或常用说话位置。';
    $('prompt').textContent=count>=max?'已录满。可以用日常说话方式测试。':readyToSave?'本批已录好，请保存。':
      retryIndex===null?phrase:`请重录第 ${clipNumber} 段，其余录音已保留。${phrase}`;
    $('progress').textContent=v.legacy?`正在使用旧声纹。保存首批会开始建立新资料，累计 ${target} 段后可重新开启筛选。`:
      `已保存 ${count} 段 · 约 ${Math.floor((v.voicedMs||0)/1000)} 秒有声。累计 ${target} 段可开启筛选，最多保存 ${max} 段。`;
    $('status').textContent=note||v.error||(v.canEnable?`${v.enabled?'只响应本人已开启':'筛选未开启'}。可以用平时的短句测试匹配。`:'每段尽量自然地说满 12 秒，至少需要 6 秒有声片段。');
  }
  function stop(){epoch++;cancel?.();cancel=null;recording=false;discard();note='已停止录入，临时录音已清除。';render();onChange();}
  async function capture(durationMs){
    const current=++epoch;recording=true;let context,stream,processor,timer,permissionTimer,done=false,frames=[];
    render();onChange();
    try{return await new Promise((resolve,reject)=>{
      const finish=(error,pcm)=>{if(done){pcm?.fill(0);return;}done=true;clearTimeout(timer);clearTimeout(permissionTimer);processor?.disconnect();stream?.getTracks().forEach(t=>t.stop());void context?.close().catch(()=>{});frames.forEach(b=>b.fill(0));frames=[];cancel=null;error?reject(error):resolve(pcm);};
      cancel=()=>finish(Error('已取消录音'));
      permissionTimer=setTimeout(()=>finish(Error('麦克风准备超时，请重新点击录制')),15000);
      void(async()=>{try{
        context=new AudioContext({sampleRate:16000});await context.resume();if(done)return;
        stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
        if(done||current!==epoch){stream.getTracks().forEach(t=>t.stop());return;}
        if(context.sampleRate!==16000)throw Error('设备不支持 16kHz 声纹录音');
        await context.audioWorklet.addModule('/voice-worklet.js');if(done)return;
        processor=new AudioWorkletNode(context,'zhiwei-duplex');
        processor.port.onmessage=({data})=>{if(!done&&data.type==='mic')frames.push(new Uint8Array(data.pcm));};
        context.createMediaStreamSource(stream).connect(processor);processor.connect(context.destination);clearTimeout(permissionTimer);
        timer=setTimeout(()=>{const count=frames.reduce((sum,b)=>sum+b.length,0),pcm=new Uint8Array(count);let offset=0;for(const frame of frames){pcm.set(frame,offset);offset+=frame.length;}finish(null,pcm);},durationMs);
      }catch(error){finish(error);}})();
    });}finally{recording=false;render();onChange();}
  }
  function base64(pcm){let text='';for(let i=0;i<pcm.length;i+=16384)text+=String.fromCharCode(...pcm.subarray(i,i+16384));return btoa(text);}
  async function send(body){posting=true;render();onChange();try{return await api('voiceprint',body);}finally{posting=false;render();onChange();}}
  $('record').onclick=async()=>{
    if($('record').disabled)return;
    const current=epoch+1;
    try{
      const pcm=await capture(12000);
      if(current!==epoch){pcm.fill(0);return;}
      if(retryIndex===null)drafts.push(pcm);
      else {
        drafts[retryIndex].fill(0);
        drafts[retryIndex]=pcm;
        retryIndex=null;
      }
      note=`本批已录好 ${drafts.length} 段，保存后计入总数。`;
    }catch(error){note=error.message;}
    render();
  };
  $('enroll').onclick=async()=>{
    if($('enroll').disabled)return;
    const savedCount=state?.voice?.voiceprint?.sampleCount||0;
    try{
      const v=await send({action:'enroll',consent:$('consent').checked,samples:drafts.map(base64)});
      discard();
      dirty=false;
      note=v.canEnable?'本批已保存。试说一句日常短句，看看是否匹配。':`本批已保存，还需 ${v.minSamples-v.sampleCount} 段即可开启筛选。可以下次继续录入。`;
    }catch(error){
      const rejected=error.message.match(/^第 (\d+) 段[：:](.*)$/u);
      const index=Number(rejected?.[1])-1;
      if(index>=0&&index<drafts.length){
        retryIndex=index;
        note=`第 ${savedCount+index+1} 段（本批第 ${index+1} 段）：${rejected[2].trim()}`;
      }else note=error.message;
    }
    render();
  };
  $('test').onclick=async()=>{if($('test').disabled)return;let pcm;const current=epoch+1;try{note='请说一句新的日常短句，例如「知微，今天进度怎么样？」';pcm=await capture(7000);if(current!==epoch)return;const result=await send({action:'test',sample:base64(pcm)});note=result.matched?`测试匹配本人（相似度 ${result.score}）。`:`测试未通过：${result.reason}。`;}catch(error){note=error.message;}finally{pcm?.fill(0);render();}};
  $('save').onclick=async()=>{if($('save').disabled)return;try{await send({action:'configure',enabled:$('enabled').checked,threshold:Number($('threshold').value)});dirty=false;note='声纹设置已保存。开启后请使用网易/百炼语音线路。';}catch(error){note=error.message;}render();};
  $('delete').onclick=async()=>{if($('delete').disabled)return;try{await send({action:'delete'});discard();dirty=false;note='本机声纹已删除，筛选已关闭。';}catch(error){note=error.message;}render();};
  for(const id of ['enabled','threshold'])$(id).onchange=()=>{dirty=true;note='设置尚未保存。';render();};
  $('consent').onchange=()=>{if(!$('consent').checked)discard();render();};$('cancel').onclick=stop;
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&(recording||drafts.length))stop();});globalThis.addEventListener?.('pagehide',stop);
  return {update(value){state=value;const v=state.voice?.voiceprint;if(v&&!dirty&&!posting){$('enabled').checked=v.enabled;$('threshold').value=String(v.threshold);}if(blocked()&&recording)stop();render();},stop,get busy(){return busy();},get pending(){return drafts.length>0;}};
}
