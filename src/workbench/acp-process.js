import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access,readFile,mkdir,writeFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {homedir} from 'node:os';
import path from 'node:path';
import {safeError} from '../codex/process.js';
import {findLocalCli} from './local-cli.js';
const exec=promisify(execFile);
function exited(child,timeout){if(!child.pid||child.exitCode!==null||child.signalCode!==null)return Promise.resolve(true);return new Promise(resolve=>{const done=()=>{clearTimeout(timer);child.off('exit',done);resolve(true);};const timer=setTimeout(()=>{child.off('exit',done);resolve(child.exitCode!==null||child.signalCode!==null);},timeout);child.once('exit',done);});}

export function dshDesktopModel(text){
  const block=text.split(/(?=^- id:)/m).find(value=>/^- id:\s*agent-default-model\s*$/m.test(value));if(!block)return null;
  const read=key=>block.match(new RegExp('^\\s+'+key+':\\s*[\"\x27]?([a-zA-Z0-9._:/-]+)[\"\x27]?\\s*(?:#.*)?$','m'))?.[1];
  const provider=read('provider'),model=read('model');return provider&&model?{provider,model}:null;
}
export async function acpCommand(agent,dataDir){
  if(agent==='gemini-cli'){
    const file=await findLocalCli(agent);
    return {command:process.execPath,args:[file,'--acp','--approval-mode','default']};
  }
  if(agent==='hermes'||agent==='antigravity'){
    const local=process.env.LOCALAPPDATA||path.join(homedir(),'AppData','Local');
    const windows=process.platform==='win32';
    const launchers={
      hermes:{override:process.env.ZHIWEI_HERMES_CLI,paths:[path.join(local,'hermes/bin/hermes.exe')],command:'hermes',args:['acp']},
      antigravity:{override:process.env.ZHIWEI_AGY_CLI,paths:[path.join(local,'agy/bin/agy.exe')],command:'agy',args:['acp','--sandbox','--disable-telemetry'],
        env:{GEMINI_API_KEY:undefined,GOOGLE_API_KEY:undefined,GOOGLE_APPLICATION_CREDENTIALS:undefined,GOOGLE_GENAI_USE_VERTEXAI:undefined,GOOGLE_GEMINI_BASE_URL:undefined}},
    };
    const {override,paths,command,args,env}=launchers[agent];
    if(override||!windows)return {command:override||command,args,env};
    for(const candidate of paths){
      if(await access(candidate).then(()=>true,()=>false))return {command:candidate,args,env};
    }
    return {command:command+'.exe',args,env};
  }
  if(agent==='dsh'){
    const file=process.env.ZHIWEI_DSH_CLI||path.join(process.env.APPDATA||'','npm/node_modules/@deepseek-ai/dsh/lib/bin.js');
    await access(file).catch(()=>{throw Error('未找到 DeepSeek Harness CLI，请安装 DSH 或设置 ZHIWEI_DSH_CLI。');});
    const args=[file,'--profile','acp'];
    // Inherit only the desktop's chosen route/model, never its credentials or patches.
    if(dataDir){const dshRoot=process.env.DSH_HOME||path.join(process.env.USERPROFILE||'','.dsh');let selected;try{selected=dshDesktopModel(await readFile(path.join(dshRoot,'profiles/desktop/cordis.patch.yml'),'utf8'));}catch{}
      if(selected){await mkdir(dataDir,{recursive:true});const overlay=path.join(dataDir,'dsh-model.patch.json');await writeFile(overlay,JSON.stringify([{id:'acp',config:selected}]));args.push('--patch',overlay);}
    }
    return {command:process.execPath,args,env:{DSH_PERMISSION_MODE:'workspace-write'}};
  }
  if(agent!=='workbuddy')throw Error('不支持的 ACP 执行器');
  let file=process.env.ZHIWEI_WORKBUDDY_CLI;
  if(!file&&process.platform==='win32'){
    const script="$p=Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs/WorkBuddy.lnk'; if(Test-Path -LiteralPath $p){$s=(New-Object -ComObject WScript.Shell).CreateShortcut($p); [Console]::Out.Write($s.TargetPath)}";
    const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000});
    if(stdout.trim())file=path.join(path.dirname(stdout.trim()),'resources/app.asar.unpacked/cli/bin/codebuddy');
  }
  if(!file)throw Error('未找到 WorkBuddy 自带 CLI，请安装 WorkBuddy 或设置 ZHIWEI_WORKBUDDY_CLI。');
  await access(file).catch(()=>{throw Error('WorkBuddy 自带 CLI 不存在，请检查安装或更新 WorkBuddy。');});
  const configDir=path.join(process.env.USERPROFILE||'','.workbuddy');
  return {command:process.execPath,args:[file,'--acp','--permission-mode','default','--strict-mcp-config','--append-system-prompt','你由知微工作台驱动。只在用户选定项目内操作。不得创建子代理、后台任务、定时任务或读取未经请求的凭据。'],env:{CODEBUDDY_CONFIG_DIR:configDir,WORKBUDDY_CONFIG_DIR:configDir,DISABLE_AUTOUPDATER:'1',CODEBUDDY_DISABLE_CRON:'1',CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS:'1'}};
}

export class AcpProcess extends EventEmitter{
  constructor({agent,workspace,dataDir,command}={}){super();Object.assign(this,{agent,workspace,dataDir,command});this.pending=new Map();this.sequence=0;}
  async start(){
    if(this.child)return;
    const spec=this.command||await acpCommand(this.agent,this.dataDir);this.closing=false;
    const child=this.child=spawn(spec.command,spec.args,{cwd:this.workspace,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,...spec.env}});
    let buffer='';
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
      buffer+=chunk;if(buffer.length>4*1024*1024){void this.stop().catch(()=>{});return;}
      let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);let message;try{message=JSON.parse(line);}catch{continue;}
        this.handleMessage(message);
      }
    });
    // stderr may contain provider diagnostics or reasoning. Never forward or persist it.
    child.stderr.resume();child.stdin.on('error',()=>{});
    const disconnected=()=>{if(this.child!==child)return;this.child=null;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('Agent 进程已退出，未重放任务。'));}this.pending.clear();this.emit('disconnected');};
    child.once('error',disconnected);child.once('exit',disconnected);
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',error=>reject(error.code==='ENOENT'?Error('找不到 '+spec.command+'，请安装对应的 Agent CLI。'):error));});
  }
  handleMessage(message){
    if(!message||message.jsonrpc!=='2.0')return;
    if(message.method){this.emit(message.id===undefined?'notification':'serverRequest',message);return;}
    const pending=this.pending.get(String(message.id));if(!pending)return;
    this.pending.delete(String(message.id));clearTimeout(pending.timer);
    if(message.error){const error=Error(safeError(message.error.data?.details||message.error.data?.message||message.error.message));error.code='RPC_ERROR';pending.reject(error);}
    else pending.resolve(message.result);
  }
  request(method,params={},timeout=120000){
    if(!this.child)return Promise.reject(Error('Agent 尚未启动。'));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(String(id));const error=Error('Agent 请求超时，结果尚未确认。');error.code='RPC_TIMEOUT';reject(error);},timeout);this.pending.set(String(id),{resolve,reject,timer});try{this.write({id,method,params});}catch(error){clearTimeout(timer);this.pending.delete(String(id));reject(error);}});
  }
  write(value){if(!this.child?.stdin.writable)throw Error('Agent 连接已关闭。');this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');}
  notify(method,params){this.write({method,params});}
  respond(id,result){this.write({id,result});}
  rejectRequest(id){this.write({id,error:{code:-32601,message:'Unsupported client request'}});}
  async stop(){
    if(this.stopping)return this.stopping;const child=this.child;if(!child)return;
    this.stopping=(async()=>{
      this.closing=true;child.stdin.end();
      if(!await exited(child,1500)){
        if(process.platform==='win32'&&child.pid){try{await exec('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:10000});}catch{if(!await exited(child,2000))throw Error('无法确认 Agent 进程树已经停止。');}}
        else child.kill();
        if(!await exited(child,2000))throw Error('无法确认 Agent 进程已经停止。');
      }
      if(this.child===child){this.child=null;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('Agent 连接已停止。'));}this.pending.clear();this.emit('disconnected');}
    })().finally(()=>{this.stopping=null;});return this.stopping;
  }
}
