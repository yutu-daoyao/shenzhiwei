import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {lstat,mkdir,mkdtemp,realpath,rmdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Zhiwei} from '../client.js';
import {ModelSelection} from '../codex/models.js';
import {CodexVoiceBrain,waitUntilStopped} from '../voice/brain.js';
import {WorkspaceFiles} from '../server/files.js';
import {codexSidebarMetadata,ProjectCatalog} from '../projects/catalog.js';
import {safeError} from '../codex/process.js';
import {OpenCodeExecutor} from './opencode.js';
import {readJson,writeJson} from './storage.js';
import {agentDesktopConfig,openDesktopBrowser} from '../agent-desktop.js';
import {AcpExecutor,ACP_AGENT_NAMES} from './acp.js';
import {sharedContext} from '../memory/shared.js';
import {requestedAgentSwitch,requestedBrowser,requestedSpokenMode} from '../voice/task-control.js';
import {detectLocalAgents} from './discovery.js';
import {desktopProjectDirectories} from './project-directories.js';
import {formatLedgerProgress,progressTopic,readProjectLedger,syncProjectLedger,taskLedgerContext} from './ledger.js';
const exec=promisify(execFile);
const mainWorkspace=path.resolve(fileURLToPath(new URL('../../',import.meta.url)));
const agents=[{id:'codex',name:'Codex'},{id:'opencode',name:'OpenCode'},...Object.entries(ACP_AGENT_NAMES).map(([id,name])=>({id,name}))].map(agent=>({...agent,implemented:true}));
const inactiveRealtime={active:false,snapshot:()=>({status:'off'}),start(){throw new Error('当前 Agent 不支持 Codex 原生语音，请手动选择百炼线路。');},stop:async()=>{}};
const pathKey=directory=>process.platform==='win32'?path.resolve(directory).toLowerCase():path.resolve(directory);
function containsDirectory(parent,child){
  const relative=path.relative(pathKey(parent),pathKey(child));
  return relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);
}
const codexOnly=directory=>containsDirectory(mainWorkspace,directory)||containsDirectory(directory,mainWorkspace);

export class Workbench extends EventEmitter{
  constructor({client,dataDir,createExecutor,projectDirectories=desktopProjectDirectories,
    agentWorkspaceRoot=path.join(process.env.LOCALAPPDATA||path.join(homedir(),'.local','share'),'Zhiwei','agent-workspaces')}={}){
    super();this.legacy=client;this.dataDir=dataDir;this.file=path.join(dataDir,'workbench.json');this.projects=[];this.clients=new Map([['default:codex',client]]);this.filesByProject=new Map();this.saveQueue=Promise.resolve();this.brains=new Map([[client,client.voice.brain]]);this.createExecutor=createExecutor;
    this.ledgerFile=path.join(dataDir,'project-ledger.json');
    this.projectDirectories=projectDirectories;this.agentProjects={};this.agentWorkspaceRoot=agentWorkspaceRoot;
    this.watch(client,'default','codex');
    client.voice.localCommand=(text,options)=>this.controlReply(text,{...options,voiceCommand:true});
    client.voice.brain={run:async(text,options)=>{const active=this.active,project=this.project;const reply=await this.answerProgress(text,options);if(reply)return reply;this.assertSelection(active,project);await this.validateProject(project);this.assertSelection(active,project);this.clearProgress();return this.brain().run(text,options);},stop:(...args)=>this.brain().stop?.(...args)||this.active.interrupt(),close:()=>{for(const brain of this.brains.values())brain.close?.();}};
  }
  get voice(){return this.legacy.voice;}
  get project(){return this.projects.find(p=>p.id===this.selectedProject);}
  get mainProject(){return this.projects.find(p=>pathKey(p.cwd)===pathKey(mainWorkspace));}
  get active(){return this.clients.get(`${this.project?.id||'default'}:${this.project?.agent||'codex'}`)||this.legacy;}
  get realtime(){return this.project?.agent==='codex'?this.active.realtime:inactiveRealtime;}
  get computer(){return this.active.computer;}
  brain(){const active=this.active;if(!this.brains.has(active))this.brains.set(active,new CodexVoiceBrain(active));return this.brains.get(active);}
  watch(client,projectId,agent){
    client.projectContext=text=>{
      const project=this.projects.find(item=>item.id===projectId);
      return project?taskLedgerContext(this.ledgerFile,project,text):undefined;
    };
    client.on('change',()=>{const project=this.projects.find(p=>p.id===projectId);if(project&&client.currentId&&project.sessions[agent]!==client.currentId){project.sessions[agent]=client.currentId;void this.save().catch(error=>{this.storageError=safeError(error);this.changed();});}this.changed();});
  }
  changed(){this.emit('change');}
  assertAgentProject(agent,directory){
    if(agent!=='codex'&&codexOnly(directory))throw Error('知微自身的工程只交给 Codex。请选择这个 Agent 自己的工作目录。');
  }
  async load(){
    const value=await readJson(this.file,null);
    this.autoApproveReads=value?.autoApproveReads===true;
    const previous=value&&JSON.stringify([value.projects,value.agentProjects]);
    if(value){if(value.version!==1||!Array.isArray(value.projects)||!value.projects.length||value.projects.some(p=>typeof p.id!=='string'||!/^[-\w]{1,100}$/.test(p.id)||typeof p.name!=='string'||typeof p.cwd!=='string'||!path.isAbsolute(p.cwd)||!agents.some(a=>a.id===p.agent&&a.implemented)||!p.sessions||typeof p.sessions!=='object')||!value.projects.some(p=>p.id===value.selectedProject)||new Set(value.projects.map(p=>p.id)).size!==value.projects.length)throw new Error('工作台项目记录格式无效，原文件未覆盖。');this.projects=value.projects;this.selectedProject=value.selectedProject;this.handoff=value.handoff||null;}
    else{this.projects=[{id:'default',name:'知微测试工作区',cwd:path.resolve(this.legacy.workspace),agent:'codex',sessions:{}}];this.selectedProject='default';}
    if(!this.project)throw new Error('工作台未找到所选项目');
    for(const project of this.projects){
      const assigned=[...(Array.isArray(project.agents)?project.agents:[]),project.agent,...Object.keys(project.sessions)];
      if(codexOnly(project.cwd))project.agent='codex';
      project.agents=codexOnly(project.cwd)?['codex']:agents.filter(agent=>assigned.includes(agent.id)).map(agent=>agent.id);
    }
    for(const {id} of agents){
      const remembered=this.projects.find(p=>p.id===value?.agentProjects?.[id]&&p.agents.includes(id));
      const project=remembered||this.projects.find(p=>p.agent===id)||this.projects.find(p=>p.agents.includes(id));
      if(project)this.agentProjects[id]=project.id;
    }
    this.agentProjects[this.project.agent]=this.project.id;
    const legacyProject=this.projects.find(p=>p.id==='default');if(legacyProject&&path.resolve(legacyProject.cwd)!==path.resolve(this.legacy.workspace))throw new Error('原测试工作区位置发生变化，请核对工作台记录。');
    if(previous!==JSON.stringify([this.projects,this.agentProjects]))await this.save();
    await this.ensure(this.project,this.project.agent);
    await syncProjectLedger(this.ledgerFile,this.projects).catch(error=>this.legacy.log?.(safeError(error)));
  }
  save(){const job=this.saveQueue.then(()=>writeJson(this.file,{version:1,projects:this.projects,selectedProject:this.selectedProject,agentProjects:this.agentProjects,handoff:this.handoff||null,autoApproveReads:this.autoApproveReads===true}));this.saveQueue=job.catch(()=>{});return job;}
  async validateProject(project){
    const stat=await lstat(project.cwd);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('请选择真实项目目录，不能使用链接或被重定向的目录。');
    if(!this.filesByProject.has(project.id))this.filesByProject.set(project.id,new WorkspaceFiles(project.cwd));
    const files=this.filesByProject.get(project.id);
    if(pathKey(await files.checkRoot())!==pathKey(project.cwd))throw Error('项目路径被重定向，请使用实际目录。');
    return files;
  }
  async files(){return this.validateProject(this.project);}
  async readLedger(project=this.project){return readProjectLedger(this.ledgerFile,project);}
  async ensure(project,agent){
    this.assertAgentProject(agent,project.cwd);
    const key=project.id+':'+agent;if(this.clients.has(key))return this.clients.get(key);
    await this.validateProject(project);const dataDir=path.join(this.dataDir,'executors',agent,project.id);
    const desktopMcp=this.legacy.desktopMcp?agentDesktopConfig(dataDir):null;
    const client=this.createExecutor?await this.createExecutor({agent,workspace:project.cwd,dataDir}):agent==='opencode'?new OpenCodeExecutor({workspace:project.cwd,dataDir,desktopMcp}):agent==='codex'?new Zhiwei({workspace:project.cwd,dataDir,projectWorkspace:true,desktopMcp}):new AcpExecutor({agent,workspace:project.cwd,dataDir,desktopMcp});
    client.memoryContext=()=>sharedContext(this.legacy.memory);
    client.autoApproveRead=()=>this.autoApproveReads===true&&this.active===client;
    if(agent==='codex'){client.memoryFile=this.legacy.memory?.file;if(client.openMemory)await client.openMemory();}
    if(agent==='codex'&&!client.models){await client.sessions.load();client.models=new ModelSelection(client,dataDir);await client.models.load();}
    this.clients.set(key,client);this.watch(client,project.id,agent);return client;
  }
  busyClient(){return [...this.clients.values()].find(c=>c.busy||c.locked||c.orchestrator.active||c.stopRequest?.escalating);}
  guardSwitch({allowPausedVoice=false,voiceCommand=false}={}){if(this.closing)throw new Error('工作台正在退出');if(this.storageError)throw new Error(this.storageError);if(this.switching)throw new Error('工作台正在切换，请稍候。');if(this.desktop?.voice&&!voiceCommand)throw new Error('请先结束后台语音再手动切换项目或 Agent。');if((this.voice.enabled&&!voiceCommand&&!(allowPausedVoice&&this.voice.inputEnabled===false&&this.voice.state==='idle'))||this.voice.changing||[...this.clients.values()].some(c=>c.realtime?.active))throw new Error('请先结束语音对话，再切换项目或执行器。');}
  async register({cwd,name,agent=this.project?.agent||'codex'}={},options){
    this.guardSwitch(options);options?.signal?.throwIfAborted();this.switching=true;this.changed();try{if(typeof cwd!=='string'||cwd.length>1000||!path.isAbsolute(cwd)||cwd.startsWith('\\\\'))throw new Error('请输入本机项目目录的完整路径。');
    const resolved=path.resolve(cwd);if(resolved===path.parse(resolved).root)throw new Error('请选择具体项目目录，不能把整个磁盘作为项目。');
    if(!agents.some(item=>item.id===agent))throw Error('此 Agent 尚未接入。');
    this.assertAgentProject(agent,resolved);
    const existing=this.projects.find(p=>pathKey(p.cwd)===pathKey(resolved));
    if(existing){
      if(!existing.agents.includes(agent)){
        await this.validateProject(existing);
        existing.agents.push(agent);try{await this.save();}catch(error){existing.agents.pop();throw error;}
      }
      return existing;
    }
    const project={id:'project-'+randomUUID(),name:typeof name==='string'&&name.trim()?name.trim().slice(0,100):path.basename(resolved),cwd:resolved,agent,agents:[agent],sessions:{}};
    await this.validateProject(project);
    await syncProjectLedger(this.ledgerFile,[project]);
    this.projects.push(project);try{await this.save();}catch(error){this.projects.pop();throw error;}this.changed();return project;
    }finally{this.switching=false;this.changed();}
  }
  async createProject({name,agent=this.project?.agent}={}){
    this.guardSwitch();
    if(this.busyClient())throw Error('请先停止当前任务，再新建项目。');
    if(!agents.some(item=>item.id===agent))throw Error('请选择已接入的 Agent。');
    if(typeof name!=='string'||!name.trim()||name.length>100)throw Error('请输入项目名称，最多 100 个字符。');
    const parent=path.join(this.agentWorkspaceRoot,agent,'projects');
    this.assertAgentProject(agent,parent);
    await mkdir(parent,{recursive:true});
    if(pathKey(await realpath(parent))!==pathKey(parent))throw Error('项目目录被重定向，请检查本机工作区。');
    const label=name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g,'-').slice(0,60).replace(/[. ]+$/,'');
    const cwd=await mkdtemp(path.join(parent,(label||'项目')+'-'));
    try{return await this.register({cwd,name:name.trim(),agent});}
    catch(error){await rmdir(cwd).catch(()=>{});throw error;}
  }
  async openAgent(agent,options){
    const supported=agents.find(item=>item.id===agent&&item.id!=='codex');
    if(!supported)throw Error('请选择已接入的外部 Agent。');
    this.guardSwitch(options);
    if(this.busyClient())throw Error('请先停止当前任务，再连接另一个 Agent。');
    const cwd=path.join(this.agentWorkspaceRoot,agent);
    this.assertAgentProject(agent,cwd);
    await mkdir(cwd,{recursive:true});
    const project=await this.register({cwd,name:supported.name+' · 独立工作区',agent},options);
    return this.select({projectId:project.id,agent},options);
  }
  async select({projectId,agent,stopCurrent=false,handoff=false}={},options){
    this.guardSwitch(options);
    options?.signal?.throwIfAborted();
    if(agent!==undefined&&!agents.some(a=>a.id===agent&&a.implemented))throw new Error('此执行器尚未接入，未切换或发送任何任务。');
    projectId??=agent&&agent!==this.project?.agent?this.agentProjects[agent]:this.project?.id;
    const target=this.projects.find(p=>p.id===projectId);if(!target)throw new Error('请先为所选 Agent 选择项目目录。');agent??=target.agent;
    if(!agents.some(a=>a.id===agent&&a.implemented))throw new Error('此执行器尚未接入，未切换或发送任何任务。');
    this.assertAgentProject(agent,target.cwd);
    if(typeof stopCurrent!=='boolean'||typeof handoff!=='boolean')throw new Error('切换参数无效');
    const source=this.active,sourceProject=this.project,sourceAgent=sourceProject.agent;
    this.switching=true;this.changed();try{
      const busy=this.busyClient();if(busy){if(!stopCurrent)throw new Error('当前有任务尚未结束，请先停止，或选择“停止并准备交接”。');await busy.interrupt();await waitUntilStopped(busy,45000,new AbortController().signal);}
      await this.validateProject(target);const destination=await this.ensure(target,agent);
      options?.signal?.throwIfAborted();
      if(source===destination){
        if(destination.connection==='connected')return {changed:false,connected:true};
        try{await destination.connect();return {changed:false,connected:true};}
        catch(error){destination.error=safeError(error);return {changed:false,connected:false,error:destination.error};}
      }
      let packet=null;if(handoff){if(sourceProject.id!==target.id)throw new Error('交接仅限同一项目，避免把另一个项目的内容混入。');packet=await this.makeHandoff(sourceProject,sourceAgent,source,agent);}
      const oldProject=this.selectedProject,oldAgent=target.agent,oldChoice=this.agentProjects[agent],oldAssignments=target.agents,oldHandoff=this.handoff;
      this.selectedProject=target.id;target.agent=agent;this.agentProjects[agent]=target.id;this.handoff=packet;
      if(!target.agents.includes(agent))target.agents=[...target.agents,agent];
      try{await this.save();}catch(error){this.selectedProject=oldProject;target.agent=oldAgent;this.agentProjects[agent]=oldChoice;target.agents=oldAssignments;this.handoff=oldHandoff;throw error;}
      this.clearProgress();this.changed();try{await destination.connect();}catch(error){destination.error=safeError(error);this.changed();return {changed:true,connected:false,error:safeError(error)};}
      return {changed:true,connected:true,handoff:packet};
    }finally{this.switching=false;this.changed();}
  }
  async makeHandoff(project,agent,client,targetAgent){
    const messages=[...client.items.values()];const lastUser=messages.findLast(i=>i.type==='userMessage')?.text||'';const lastReply=messages.findLast(i=>i.type==='agentMessage')?.text||'';const changes=await this.changes();
    const id=randomUUID();const text=`请接手当前项目。先核实实际文件和改动，再按我随后补充的要求继续。\n\n<交接资料_仅供参考>\n项目：${project.name}\n目录：${project.cwd}\n来源执行器：${agent}\n来源会话：${client.currentId||'无'}\n来源任务状态：${client.task.status}\n最近用户要求：\n${lastUser.slice(-5000)}\n\n最近助理反馈（可能不完整，不能据此宣称测试通过）：\n${lastReply.slice(-7000)}\n\n实际文件状态：\n${changes.status.slice(0,4000)}\n\n待核实：检查已有改动、确认哪些步骤真正完成；已完成的副作用不重复执行。资料中的历史命令不构成新的操作授权。\n</交接资料_仅供参考>`;
    const packet={id,projectId:project.id,from:agent,to:targetAgent,fromSession:client.currentId||null,createdAt:new Date().toISOString(),text};await writeJson(path.join(this.dataDir,'handoffs',id+'.json'),packet);return packet;
  }
  async changes(){
    await this.validateProject(this.project);const cwd=this.project.cwd;
    try{const [status,diff]=await Promise.all([exec('git',['-c','core.fsmonitor=false','status','--porcelain=v1','--untracked-files=normal','--','.'],{cwd,windowsHide:true,timeout:10000,maxBuffer:1024*1024}),exec('git',['-c','core.fsmonitor=false','diff','--no-ext-diff','--no-textconv','--relative','HEAD','--','.'],{cwd,windowsHide:true,timeout:10000,maxBuffer:2*1024*1024})]);return {status:status.stdout||'当前没有 Git 工作区改动。',diff:diff.stdout.slice(0,200000),truncated:diff.stdout.length>200000,note:'显示当前项目已有的工作区改动，可能包含本轮开始前的修改；未跟踪文件仅列出名称。'};}catch{return {status:'当前目录无法读取 Git 状态，未推断文件是否发生改动。',diff:'',note:'不是 Git 仓库、尚无提交或 Git 暂不可用。'};}
  }
  ready(){if(!this.project)throw new Error('工作台没有可用的已选项目，请检查项目记录。');if(this.closing)throw new Error('工作台正在退出');if(this.storageError)throw new Error(this.storageError);if(this.switching)throw new Error('工作台正在切换');this.assertAgentProject(this.project.agent,this.project.cwd);this.active.ready();}
  assertSelection(active,project){if(this.active!==active||this.project!==project)throw new Error('工作区已切换，请核对当前项目后重新发送。');this.ready();}
  assertDispatch({agent,projectId}){
    if(agent!==undefined&&agent!==this.project?.agent||projectId!==undefined&&projectId!==this.project?.id)
      throw Error('所选 Agent 或项目已切换，请核对后再发送。');
  }
  async connect(){if(this.closing)throw new Error('工作台正在退出');if(!this.project||this.storageError)throw new Error(this.storageError||'工作台没有可用的已选项目。');return this.active.connect();}
  async answerProgress(text,{signal}={}){
    const topic=progressTopic(text);
    if(!topic)return;
    const active=this.active,selected=this.project,session=active.currentId;
    if(this.closing||this.switching)throw new Error('工作台正在切换或退出，请稍候。');
    const current=['当前项目','这个项目','项目'].includes(topic);
    const project=current?selected:this.mainProject;
    const record=project?await this.readLedger(project).catch(()=>null):null;
    signal?.throwIfAborted();
    if(this.closing||this.switching||this.active!==active||this.project!==selected||active.currentId!==session)throw new Error('工作区或会话已切换，请重新查询。');
    const reply=formatLedgerProgress(record,{voiceprint:topic==='声纹',name:project?.name});
    return this.localReply(text,reply);
  }
  localReply(text,reply){
    const active=this.active,session=active.currentId,id=randomUUID();
    this.progressExchange={active,session,items:[
      {id:id+'-user',type:'userMessage',text,turnId:id},
      {id:id+'-reply',type:'agentMessage',text:reply,turnId:id},
    ]};
    this.changed();
    return reply;
  }
  clearProgress(){if(this.progressExchange){this.progressExchange=null;this.changed();}}
  modeReply(text){
    if(!this.voice.config?.spokenModes)return;
    const mode=requestedSpokenMode(text,{requireWake:false});
    if(mode)return this.localReply(text,this.voice.setSpokenMode(mode));
  }
  async controlReply(text,{signal,voiceCommand=false}={}){
    const agent=requestedAgentSwitch(text);
    const browser=requestedBrowser(text);
    if(!agent&&!browser)return;
    signal?.throwIfAborted();
    if(browser)return this.localReply(text,await openDesktopBrowser(this.legacy.desktopMcp,browser,{signal}));
    const name=agents.find(item=>item.id===agent).name;
    if(this.project.agent===agent&&this.active.connection==='connected')return this.localReply(text,'当前已经是 '+name+'。');
    const options={signal,voiceCommand};
    const projectId=this.agentProjects[agent];
    const result=projectId?await this.select({projectId,agent},options):await this.openAgent(agent,options);
    const reply=result.connected?'已切换到 '+name+'，当前项目是'+this.project.name+'。':'切换到 '+name+' 后连接失败。'+result.error;
    return this.localReply(text,reply);
  }
  async send(text,owner,options){
    const active=this.active,project=this.project;
    const reply=this.modeReply(text)||await this.controlReply(text,options)||await this.answerProgress(text,options);
    if(reply){if(!owner)this.voice.readReply?.(()=>reply);return {text:reply};}
    this.assertSelection(active,project);await this.validateProject(project);this.assertSelection(active,project);this.clearProgress();
    const sending=active.send(text,owner,options);
    if(!owner)this.voice.readReply?.(async signal=>{
      const sent=await sending.catch(()=>null);
      if(!sent?.turnId||signal.aborted)return;
      const result=await active.waitForTurn(sent.turnId,signal);
      if(result.status==='completed'&&this.active===active&&this.project===project)return result.text;
    });
    return sending;
  }
  async newThread(){const active=this.active,project=this.project;this.ready();await this.validateProject(project);this.assertSelection(active,project);this.clearProgress();return active.newThread();}
  async resume(id){const active=this.active,project=this.project;this.ready();await this.validateProject(project);this.assertSelection(active,project);this.clearProgress();return active.resume(id);}
  async runPlan(text){
    const modeReply=this.modeReply(text);
    if(modeReply){this.voice.readReply?.(()=>modeReply);return {text:modeReply};}
    const active=this.active,project=this.project;
    this.ready();await this.validateProject(project);this.assertSelection(active,project);this.clearProgress();
    const running=active.runPlan(text);
    this.voice.readReply?.(async()=>{
      const result=await running.catch(()=>null);
      if(active.plan?.status!=='stopped'&&this.active===active&&this.project===project)return result?.report;
    });
    return running;
  }
  async interrupt(){this.voice.interrupt();return this.active.interrupt();}
  async approve(id,decision){return this.active.approve(id,decision);}
  async setAutoApproveReads(enabled){
    if(typeof enabled!=='boolean')throw Error('请选择是否自动批准本项目的只读操作。');
    const previous=this.autoApproveReads;
    this.autoApproveReads=enabled;
    try{await this.save();}catch(error){if(this.autoApproveReads===enabled)this.autoApproveReads=previous;throw error;}
    this.changed();
    return {enabled};
  }
  async selectModel(model,{projectId=this.project.id,agent=this.project.agent,effort}={}){this.guardSwitch();if(projectId!==this.project.id||agent!==this.project.agent)throw new Error('Agent 或项目已切换，请重新选择模型。');if(this.busyClient())throw new Error('请先停止当前任务');return this.active.models.select(model,{effort});}
  async refreshAgents(){
    if(!this.agentScan){
      this.agentScan=detectLocalAgents().then(inventory=>{
        if(!this.closing){this.agentInventory=inventory;this.changed();}
      }).finally(()=>{this.agentScan=null;});
    }
    await this.agentScan;
  }
  catalogRpc(){
    return this.project?.agent==='codex'&&this.active.rpc?.connected?this.active.rpc:
      [...this.clients].find(([key,client])=>key.endsWith(':codex')&&client.rpc?.connected)?.[1].rpc;
  }
  async catalog(query='',agent=this.project?.agent){
    if(typeof query!=='string'||query.length>200)throw new Error('项目关键词过长');
    if(!agents.some(item=>item.id===agent))throw Error('此 Agent 尚未接入项目目录。');
    const needle=query.trim().toLocaleLowerCase();
    const matches=(title,cwd)=>`${title} ${cwd}`.toLocaleLowerCase().includes(needle);
    const local=this.projects.filter(p=>p.agents.includes(agent)&&matches(p.name,p.cwd))
      .map(p=>({id:p.id,title:p.name,cwd:p.cwd,agent,registered:true,updatedAt:0,status:'local'}));
    if(agent!=='codex'){
      try{
        const executor=this.project?.agent===agent&&this.active.rpc?.connected?this.active:null;
        const desktop=await this.projectDirectories(agent);
        const native=desktop??await executor?.listProjectDirectories?.()??null;
        const threads=[];
        const seen=new Set(local.map(p=>pathKey(p.cwd))),validDirectories=new Map();
        for(const entry of native??[]){
          const directory=typeof entry==='string'?entry:entry?.cwd;
          const hasTitle=typeof entry?.id==='string'&&typeof entry.title==='string'&&!!entry.title.trim();
          const conversation=hasTitle&&entry.conversation!==false;
          const named={id:agent+':'+entry?.id,title:entry?.title,titleSource:entry?.titleSource||'native',
            conversation,pinned:!!entry?.pinned,updatedAt:entry?.updatedAt};
          if(entry?.unscoped&&conversation&&matches(entry.title,'')){
            threads.push({...named,cwd:'',agent,nativeProject:true,unscoped:true});continue;
          }
          if(typeof directory!=='string'||!path.isAbsolute(directory)||directory.startsWith('\\\\'))continue;
          const cwd=path.resolve(directory),key=pathKey(cwd);
          const title=hasTitle?entry.title:path.basename(cwd);
          if(!title||!conversation&&seen.has(key)||!matches(title,cwd))continue;
          if(codexOnly(cwd)){
            if(conversation)threads.push({...named,cwd,agent,nativeProject:true,unscoped:true,scopeReason:'此任务的目录属于知微自身工程的保护范围。'});
            continue;
          }
          if(!validDirectories.has(key)){
            const stat=await lstat(cwd).catch(()=>null);
            validDirectories.set(key,!!stat?.isDirectory()&&!stat.isSymbolicLink()&&pathKey(await realpath(cwd).catch(()=>''))===key);
          }
          if(!validDirectories.get(key))continue;
          seen.add(key);
          threads.push({...(hasTitle?named:{id:'native:'+key}),title,cwd,agent,nativeProject:true});
        }
        return {threads:[...local,...threads],agent,directoryStatus:native?'ready':'manual',truncated:false};
      }catch{
        return {threads:local,agent,directoryStatus:'failed',truncated:false};
      }
    }
    const rpc=this.catalogRpc();
    if(!rpc)return {threads:local,agent,codexStatus:'unavailable',truncated:false};
    const catalog=new ProjectCatalog(rpc);
    const indexed=codexSidebarMetadata().then(desktop=>catalog.list(query,{stateDbOnly:true,desktop}).then(list=>
      !query.trim()&&!list.threads.some(thread=>thread.cwd)?catalog.list(query,{desktop}):list,()=>catalog.list(query,{desktop})));
    const [roots,history]=await Promise.allSettled([catalog.roots(query),indexed]);
    return {
      threads:[...local,...[...(roots.value?.projects||[]),...(history.value?.threads||[])].map(project=>({...project,agent}))],agent,
      codexStatus:roots.status===history.status?(roots.status==='fulfilled'?'ready':'failed'):'partial',
      truncated:!!(roots.value?.truncated||history.value?.truncated),
    };
  }
  async readProject(id,agent=this.project?.agent){
    const project=this.projects.find(p=>p.id===id);
    if(!project){
      if(agent!=='codex')throw Error('这个 Agent 的目录可用于派发，暂未开放历史预览。');
      const rpc=this.catalogRpc();if(!rpc)throw new Error('Codex 尚未连接，暂时无法预览会话。');
      return new ProjectCatalog(rpc).read(id);
    }
    if(!project.agents.includes(agent))throw Error('项目不属于当前 Agent。');
    const client=this.clients.get(project.id+':'+agent);
    return {id,title:project.name,cwd:project.cwd,messages:client?[...client.items.values()].filter(i=>['userMessage','agentMessage'].includes(i.type)).slice(-10).map(i=>({role:i.type==='userMessage'?'user':'assistant',text:i.text})):[]};
  }
  snapshot(){
    const active=this.active,snapshot=active.snapshot();
    const detected=this.agentInventory?.supported;
    const options=agents.map(a=>({...a,detected:detected?.[a.id],status:this.clients.get(this.project?.id+':'+a.id)?.connection||'disconnected'}));
    if(process.platform==='win32')options.push({id:'grok-bot',name:'Grok Bot（桌面交接）',external:true,detected:detected?.['grok-bot'],status:'desktop'});
    options.push(...(this.agentInventory?.other||[]));
    const exchange=this.progressExchange;
    const items=exchange?.active===active&&exchange.session===active.currentId?[...snapshot.items,...exchange.items]:snapshot.items;
    return {...snapshot,items,voice:this.voice.snapshot(),realtime:this.realtime.snapshot(),questions:snapshot.questions||[],workbench:{projectId:this.project?.id,agent:this.project?.agent,projects:this.projects,agentProjects:this.agentProjects,agents:options,switching:!!this.switching,error:this.storageError||null,nativeVoice:this.project?.agent==='codex',handoff:this.handoff||null,autoApproveReads:this.autoApproveReads===true}};
  }
  async close(){this.closing=true;const results=await Promise.allSettled([...this.brains.values()].map(async brain=>brain.close?.()).concat([...this.clients.values()].map(c=>c.close())));await this.saveQueue;const failure=results.find(r=>r.status==='rejected');if(failure)throw failure.reason;}
}
