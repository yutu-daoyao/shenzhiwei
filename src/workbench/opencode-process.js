import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access,mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {EventEmitter} from 'node:events';
import path from 'node:path';
import {safeError} from '../codex/process.js';
const exec=promisify(execFile);

export async function findOpenCode({verify=true,exclude}={}){
  const candidates=[];
  if(process.env.OPENCODE_BIN)candidates.push(process.env.OPENCODE_BIN);
  else{
    try{const {stdout}=await exec(process.platform==='win32'?'where.exe':'which',['opencode'],{windowsHide:true});candidates.push(...stdout.trim().split(/\r?\n/).filter(p=>process.platform!=='win32'||/\.exe$/i.test(p)));}catch{}
    if(process.platform==='win32')candidates.push(path.join(process.env.APPDATA||'','npm/node_modules/opencode-ai/bin/opencode.exe'));
  }
  for(const file of candidates){if(exclude&&path.relative(exclude,file)==='')continue;try{await access(file);if(!verify)return {file};const {stdout}=await exec(file,['--version'],{windowsHide:true,timeout:10000});if(/\d+\.\d+\.\d+/.test(stdout))return {file,version:stdout.trim().slice(0,80)};}catch{}}
  throw new Error('未找到 OpenCode。请安装 OpenCode，或设置 OPENCODE_BIN 为可执行文件路径，然后重新连接。');
}

export class OpenCodeProcess extends EventEmitter{
  constructor({workspace,dataDir,command,desktopMcp}={}){super();Object.assign(this,{workspace,dataDir,command,desktopMcp});}
  async start(){
    if(this.origin)return this;
    const info=this.command?{file:this.command}:await findOpenCode({verify:false});
    try{return await this.launch(info);}
    catch(error){
      if(this.command||process.env.OPENCODE_BIN)throw error;
      const alternate=await findOpenCode({exclude:info.file}).catch(()=>null);
      if(!alternate)throw error;
      return this.launch(alternate);
    }
  }
  async launch(info){
    this.info=info;
    await mkdir(this.dataDir,{recursive:true});const password=randomBytes(32).toString('hex');
    this.authorization='Basic '+Buffer.from('opencode:'+password).toString('base64');
    const child=this.child=spawn(info.file,['serve','--pure','--hostname','127.0.0.1','--port','0'],{cwd:this.workspace,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,
      XDG_DATA_HOME:path.join(this.dataDir,'runtime-data'),XDG_CACHE_HOME:path.join(this.dataDir,'runtime-cache'),
      OPENCODE_SERVER_USERNAME:'opencode',OPENCODE_SERVER_PASSWORD:password,
      OPENCODE_CONFIG_CONTENT:JSON.stringify({autoupdate:false,share:'disabled',permission:{'*':'ask',external_directory:'deny'},...(this.desktopMcp?{mcp:{'agent-desktop':{type:'local',command:[this.desktopMcp.command,...this.desktopMcp.args],environment:this.desktopMcp.env,enabled:true,timeout:120000}}}:{})})}});
    let output='',diagnostic='';
    try{this.origin=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('OpenCode 启动超时，请检查安装与运行环境。')),45000);
      const fail=error=>{clearTimeout(timer);reject(error);};
      child.once('error',error=>fail(new Error('OpenCode 启动失败：'+safeError(error))));
      child.once('exit',()=>{this.origin=null;this.emit('disconnected');fail(new Error('OpenCode 已退出：'+safeError(diagnostic||'请重新连接')));});
      child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk).slice(-2500);});
      child.stdout.on('data',chunk=>{output=(output+chunk).slice(-4096);const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});
    });this.startEvents();return this;}catch(error){await this.stop();throw error;}
  }
  startEvents(){
    if(this.eventsController||!this.origin)return;
    const controller=this.eventsController=new AbortController(),url=new URL('/event',this.origin);url.searchParams.set('directory',this.workspace);
    this.eventsTask=(async()=>{
      try{const response=await fetch(url,{headers:{Authorization:this.authorization,Accept:'text/event-stream'},signal:controller.signal,redirect:'error'});if(!response.ok)return;
        const decoder=new TextDecoder();let buffer='';
        for await(const chunk of response.body){buffer+=decoder.decode(chunk,{stream:true}).replaceAll('\r\n','\n');if(buffer.length>2*1024*1024)throw Error('事件过大');let end;
          while((end=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);const raw=block.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');let event;try{event=JSON.parse(raw);}catch{continue;}if(event.type==='session.error')this.emit('sessionError',event.properties);}
        }
      }catch{/* Observation failures must not replay model requests. */}
      finally{if(this.eventsController===controller)this.eventsController=null;}
    })();
  }
  async request(route,{method='GET',body,signal,timeout=15000}={}){
    if(!this.origin)throw new Error('OpenCode 尚未连接。');
    if(!this.eventsController)this.startEvents();
    const url=new URL(route,this.origin);url.searchParams.set('directory',this.workspace);
    const response=await fetch(url,{method,headers:{Authorization:this.authorization,'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout),redirect:'error'});
    if(!response.ok){let message;try{const value=await response.json();message=value.data?.message||value.message||value.error;}catch{}throw new Error(`OpenCode 请求失败（${response.status}）：${safeError(message||'请检查服务状态')}`);}
    if(response.status===204)return null;return response.json();
  }
  async stop(){
    this.eventsController?.abort();this.eventsController=null;
    const child=this.child;this.child=null;this.origin=null;this.authorization=null;
    if(!child||child.exitCode!==null)return;
    if(process.platform==='win32'&&child.pid){try{await exec('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:10000});}catch{if(child.exitCode===null)child.kill();}}
    else child.kill();
  }
}
