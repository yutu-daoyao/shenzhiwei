import {StreamingCaption} from './caption-pipeline.js';
export function createLocalCaptions({Translator=globalThis.Translator,onChange=()=>{},onStatus=()=>{}}={}){
  let session,preparing,lastKey='',caption;
  const pipeline=new StreamingCaption({async translate(text,onDelta,isCurrent){
    if(!session)throw new Error('本地字幕尚未准备好');if(!isCurrent())throw new Error('旧字幕已跳过');
    const result=await session.translate(text);onDelta(result);return result;
  }},value=>{caption=value;onChange(value);});
  async function prepare({download=false}={}){
    if(session)return true;if(preparing)return preparing;
    if(!Translator){onStatus('当前浏览器不支持本地字幕；从桌面「知微」打开可使用 Chrome。');return false;}
    preparing=(async()=>{
      const availability=await Translator.availability({sourceLanguage:'en',targetLanguage:'zh'});
      if(availability==='unavailable'){onStatus('本地英中翻译不可用，云端字幕可能滞后。');return false;}
      if(availability!=='available'&&!download){onStatus('首次需要准备本地语言包，完成后字幕无需云端翻译。');return false;}
      onStatus(availability==='available'?'正在载入本地字幕…':'正在准备本地语言包…');
      session=await Translator.create({sourceLanguage:'en',targetLanguage:'zh',monitor(m){m.addEventListener('downloadprogress',e=>onStatus('本地语言包 '+Math.round(e.loaded*100)+'%'));}});
      onStatus('本地中文字幕已就绪 · 不调用翻译 API');return true;
    })().catch(error=>{onStatus('本地字幕未就绪：'+error.message);return false;}).finally(()=>{preparing=null;});return preparing;
  }
  return {prepare,get ready(){return !!session;},get caption(){return caption;},reset(){pipeline.reset();lastKey='';caption=null;},feed(source){if(!session||!source)return;const key=JSON.stringify(source);if(key===lastKey)return;lastKey=key;pipeline.feed(source.id,source.text,source.done);}};
}
