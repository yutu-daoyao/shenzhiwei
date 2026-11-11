export async function createCaptionPlayback(stream,{Context=globalThis.AudioContext,Node=globalThis.AudioWorkletNode,onError=()=>{},onLevel=()=>{}}={}){
  if(!Context||!Node)throw new Error('当前浏览器不支持字幕同步播放，请选择立即播放或使用最新 Edge。');
  const context=new Context();let closed=false,node,source;
  const close=()=>{if(closed)return;closed=true;source?.disconnect();node?.disconnect();void context.close().catch(()=>{});};
  try{
    await context.resume();await context.audioWorklet.addModule('/caption-playback-worklet.js');
    node=new Node(context,'zhiwei-caption-playback',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2]});
    node.port.onmessage=({data})=>{if(data.type==='level')onLevel(data.value);if(data.type==='overflow'){close();onError('字幕等待音频超过两分钟，已停止语音。请重连或选择立即播放。');}};
    source=context.createMediaStreamSource(stream);source.connect(node);node.connect(context.destination);
    return {close,release:()=>node.port.postMessage({type:'release'}),hold:()=>node.port.postMessage({type:'hold'}),reset:()=>node.port.postMessage({type:'reset'})};
  }catch(error){close();throw error;}
}
