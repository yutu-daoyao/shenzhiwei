import {EventEmitter} from 'node:events';
import {Worker} from 'node:worker_threads';
import {existsSync} from 'node:fs';
import {readFile,writeFile,mkdir,rename,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import path from 'node:path';
const MODEL='eres2net-base-3dspeaker-16k';
const BATCH_SIZE=3, MIN_SAMPLES=12, MAX_SAMPLES=24, MIN_VOICED_MS=6000;
export function normalize(vector){if(!Array.isArray(vector)||vector.length<2||vector.length>4096||vector.some(v=>typeof v!=='number'||!Number.isFinite(v)))throw Error('声纹特征无效');const length=Math.hypot(...vector);if(length<1e-8)throw Error('声纹特征为空');return vector.map(v=>v/length);}
export function similarity(a,b){if(a.length!==b.length)throw Error('声纹模型不匹配，请重新录入');return a.reduce((sum,value,i)=>sum+value*b[i],0);}
function quality(pcm,enroll=false){
  if(!Buffer.isBuffer(pcm)||pcm.length%2||pcm.length>(enroll?480000:1440000)||pcm.length<(enroll?256000:25600))throw Error(enroll?'请录制 8–15 秒完整清晰语音':'语音太短，未通过声纹筛选');
  let voiced=0;for(let start=0;start+640<=pcm.length;start+=640){let power=0;for(let i=start;i<start+640;i+=2)power+=(pcm.readInt16LE(i)/32768)**2;if(Math.sqrt(power/320)>0.006)voiced+=20;}
  if(voiced<(enroll?MIN_VOICED_MS:400))throw Error(enroll?'需要至少 6 秒有声片段，请自然连续地说':'有效说话时长不足或音量过低');
  return voiced;
}
function closestMean(samples,vector,count=3){
  const scores=samples.map(sample=>similarity(sample.vector,vector)).sort((a,b)=>b-a).slice(0,count);
  return scores.reduce((sum,score)=>sum+score,0)/scores.length;
}
function loadSamples(samples){
  if(!Array.isArray(samples)||!samples.length||samples.length>MAX_SAMPLES||samples.length%BATCH_SIZE)throw Error('profile');
  const checked=samples.map(({vector,voicedMs})=>{
    if(!Number.isInteger(voicedMs)||voicedMs<MIN_VOICED_MS||voicedMs>15000)throw Error('profile');
    return {vector:normalize(vector),voicedMs};
  });
  if(checked.some(sample=>sample.vector.length!==checked[0].vector.length))throw Error('profile');
  return checked;
}
function protect(bytes,decrypt=false){
  if(process.platform!=='win32')return Promise.resolve(Buffer.from(bytes));
  return new Promise((resolve,reject)=>{const method=decrypt?'Unprotect':'Protect',script='Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::'+method+'($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))';
    const child=execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000,maxBuffer:4*1024*1024},(error,stdout)=>error?reject(Error('本机声纹资料加密/解密失败')):resolve(Buffer.from(stdout.trim(),'base64')));child.stdin.on('error',()=>{});child.stdin.end(bytes.toString('base64'));
  });
}
export class Voiceprint extends EventEmitter{
  constructor({dataDir,embedder,crypt=protect}={}){super();this.directory=path.join(dataDir,'voiceprint');this.file=path.join(this.directory,'profile.bin');this.model=path.join(this.directory,'speaker.onnx');this.embedder=embedder;this.crypt=crypt;this.enabled=false;this.threshold=0.6;this.generation=0;this.pending=new Map();this.sequence=0;}
  get available(){return !!this.embedder||existsSync(this.model);}
  get ready(){return this.available&&!!this.profile&&!this.error;}
  get canEnable(){return this.ready&&(this.profile.version===1||this.profile.samples.length>=MIN_SAMPLES);}
  snapshot(){
    const samples=this.profile?.samples??[];
    return {available:this.available,enrolled:!!this.profile,enabled:this.enabled,ready:this.ready,canEnable:this.canEnable,
      legacy:this.profile?.version===1,sampleCount:samples.length,voicedMs:samples.reduce((sum,sample)=>sum+sample.voicedMs,0),
      batchSize:BATCH_SIZE,minSamples:MIN_SAMPLES,maxSamples:MAX_SAMPLES,threshold:this.threshold,
      createdAt:this.profile?.createdAt||null,error:this.error||null,lastResult:this.lastResult||null};
  }
  changed(){this.emit('change');}
  async load(){
    try{
      const decoded=await this.crypt(await readFile(this.file),true);
      let value;
      try{value=JSON.parse(decoded);}finally{decoded.fill(0);}
      const {version,model,enabled,threshold,createdAt}=value;
      if(![1,2].includes(version)||model!==MODEL||typeof enabled!=='boolean'||![0.5,0.6,0.7].includes(threshold))throw Error('profile');
      if(version===1)this.profile={version,createdAt,vector:normalize(value.vector)};
      else {
        const samples=loadSamples(value.samples);
        if(enabled&&samples.length<MIN_SAMPLES)throw Error('profile');
        this.profile={version,createdAt,samples};
      }
      this.enabled=enabled;
      this.threshold=threshold;
    }catch(error){if(error.code!=='ENOENT'){this.enabled=true;this.error='声纹资料无法读取，请重新录入或删除后再设置。';}}
    return this;
  }
  async prepare(){
    if(this.embedder||this.workerReady)return;if(this.starting)return this.starting;if(!this.available)throw Error('本地声纹模型尚未准备。');
    this.starting=new Promise((resolve,reject)=>{let failed=false;const worker=this.worker=new Worker(new URL('./speaker-worker.js',import.meta.url),{workerData:{model:this.model},execArgv:[]});const timer=setTimeout(()=>fail(Error('本地声纹模型启动超时')),30000);
      const fail=error=>{if(failed)return;failed=true;clearTimeout(timer);this.workerReady=false;this.worker=null;void worker.terminate();this.error='本地声纹引擎不可用，请检查安装。';for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error(this.error));}this.pending.clear();reject(error);if(!this.closed)this.changed();};
      worker.on('error',fail);worker.on('exit',()=>fail(Error('声纹引擎已退出')));worker.on('message',m=>{if(failed)return;if(m.ready){clearTimeout(timer);this.workerReady=true;this.error=null;resolve();this.changed();return;}const p=this.pending.get(m.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(m.id);try{if(m.error)throw Error(m.error);p.resolve(normalize(m.embedding));}catch(error){p.reject(error);}});
    }).finally(()=>{this.starting=null;});return this.starting;
  }
  async embed(pcm){await this.prepare();if(this.embedder)return normalize(await this.embedder(pcm));if(this.pending.size>=4)throw Error('声纹计算繁忙，请稍后再说');const id=++this.sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('声纹校验超时，未发送语音。'));},15000);this.pending.set(id,{resolve,reject,timer});this.worker.postMessage({id,pcm:Uint8Array.from(pcm)});});}
  async save(){await mkdir(this.directory,{recursive:true});const plain=Buffer.from(JSON.stringify({...this.profile,model:MODEL,enabled:this.enabled,threshold:this.threshold}));let encrypted;try{encrypted=await this.crypt(plain,false);}finally{plain.fill(0);}const temporary=this.file+'.tmp';try{await writeFile(temporary,encrypted,{mode:0o600});await rename(temporary,this.file);}finally{encrypted.fill(0);await rm(temporary,{force:true});}}
  async enroll(samples,{consent=false}={}){
    if(consent!==true)throw Error('请先同意仅在本机保存本人声纹特征');
    if(!Array.isArray(samples)||samples.length!==BATCH_SIZE)throw Error('每批请录制三段本人语音');
    const previous=this.profile?.samples??[], batch=[];
    try{
      if(previous.length+BATCH_SIZE>MAX_SAMPLES)throw Error('声纹样本已达到上限');
      const durations=samples.map((pcm,i)=>{
        try{return quality(pcm,true);}catch(error){throw Error(`第 ${i+1} 段：${error.message}`);}
      });
      for(const [i,pcm] of samples.entries())batch.push({vector:await this.embed(pcm),voicedMs:durations[i]});
      for(const [i,sample] of batch.entries()){
        if(batch.slice(i+1).some(other=>similarity(sample.vector,other.vector)<0.4)
          ||previous.length&&closestMean(previous,sample.vector,2)<0.4)throw Error('这批样本与本人声音一致性不足，请在安静环境重新录制本批');
      }
    }finally{for(const pcm of samples)if(Buffer.isBuffer(pcm))pcm.fill(0);}
    const old={profile:this.profile,error:this.error,enabled:this.enabled};
    this.profile={version:2,createdAt:previous.length?this.profile.createdAt:new Date().toISOString(),samples:[...previous,...batch]};
    this.error=null;
    if(!previous.length)this.enabled=false;
    try{await this.save();}catch(error){Object.assign(this,old);throw error;}
    this.lastResult=null;
    this.generation++;
    this.changed();
    return this.snapshot();
  }
  async configure({enabled,threshold=this.threshold}){if(typeof enabled!=='boolean'||![0.5,0.6,0.7].includes(threshold))throw Error('声纹设置无效');if(enabled&&!this.canEnable)throw Error(`请先完成本人声纹录入，至少保存 ${MIN_SAMPLES} 段有效样本`);if(enabled)await this.prepare();const old={enabled:this.enabled,threshold:this.threshold};this.enabled=enabled;this.threshold=threshold;try{if(this.profile)await this.save();}catch(error){Object.assign(this,old);throw error;}this.generation++;this.changed();return this.snapshot();}
  async verify(pcm,{signal}={}){
    if(!this.ready)throw Error('本人声纹尚未就绪');signal?.throwIfAborted();const generation=this.generation;let result;
    try{quality(pcm);const embedding=await this.embed(pcm);signal?.throwIfAborted();if(generation!==this.generation)throw Error('声纹设置已改变');const score=this.profile.version===1?similarity(this.profile.vector,embedding):closestMean(this.profile.samples,embedding);result={matched:score>=this.threshold,score:Math.round(score*1000)/1000,reason:score>=this.threshold?'匹配本人':'未匹配本人，已忽略'};}
    catch(error){if(signal?.aborted)throw error;if(/太短|音量|时长/.test(error.message))result={matched:false,score:null,reason:error.message};else throw error;}
    this.lastResult={...result,at:new Date().toISOString()};this.changed();return result;
  }
  async remove(){await rm(this.file,{force:true});this.profile=null;this.enabled=false;this.error=null;this.lastResult=null;this.generation++;this.changed();return this.snapshot();}
  async close(){this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('声纹引擎已关闭'));}this.pending.clear();await this.worker?.terminate();}
}

export class SpeakerFilteredASR{
  constructor(asr,voiceprint){Object.assign(this,{asr,voiceprint});this.requiresVerification=true;}
  createSession(options){
    const session=new EventEmitter(),controller=new AbortController();let chunks=[],bytes=0,closed=false,ended=false,inner;
    session.on('error',()=>{});const clear=()=>{for(const b of chunks)b.fill(0);chunks=[];bytes=0;};
    const close=()=>{if(closed)return;closed=true;controller.abort();clear();inner?.close();};
    session.write=chunk=>{if(closed||ended)return;if(!Buffer.isBuffer(chunk)||chunk.length%2)throw Error('声纹需要 PCM16 音频');if(bytes+chunk.length>1440000)throw Error('单句过长，请分句说话');chunks.push(Buffer.from(chunk));bytes+=chunk.length;};
    session.end=endOptions=>{if(closed||ended)return;ended=true;void(async()=>{let pcm;try{pcm=Buffer.concat(chunks);clear();const result=await this.voiceprint.verify(pcm,{signal:controller.signal});if(closed)return;if(!result.matched){session.emit('final',{text:''});return;}inner=this.asr.createSession(options);for(const event of ['partial','sentence','final','error'])inner.on(event,value=>{if(!closed)session.emit(event,value);});inner.write(pcm);inner.end(endOptions);}catch(error){if(!closed)session.emit('error',error);}finally{pcm?.fill(0);}})();};
    session.close=close;return session;
  }
}
