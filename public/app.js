import {sceneForState} from './task-scene.js';
import {mountWorkSurface} from './work-surface.js';
import {mountWorkbench} from './workbench-view.js';
import {mountWechat} from './wechat-view.js';
import {renderReply} from './reply-view.js';
import {groupProjects,mountDashboard} from './dashboard.js';
import {createLocalCaptions} from './local-captions.js';
import { createAudioCheck } from './audio-check.js';
import {appNames,operationNames,approvalView} from './approval-view.js';
import { mountMemory } from './memory-view.js';
import { conversationExport } from './conversation-export.js';
import { createNativeVoice } from './native-voice.js';
import { createBailianVoice } from './bailian-voice.js';
import {mountVoiceprint} from './voiceprint-view.js';
import { mountOrb, simulationMode } from './orb.js';
const $ = id => document.getElementById(id);
const orbSim = simulationMode(location.search);
let layout={projects:true,agent:true,details:true};
try { const saved=JSON.parse(localStorage.getItem('zhiwei.layout')||'null');if(saved)for(const key of Object.keys(layout))if(typeof saved[key]==='boolean')layout[key]=saved[key]; } catch {}
function renderLayout(){
  for(const key of Object.keys(layout)){
    document.body.dataset['show'+key[0].toUpperCase()+key.slice(1)]=String(layout[key]);
    $('layout-'+key).setAttribute('aria-pressed',String(layout[key]));
  }
  const focused=Object.values(layout).every(value=>!value);
  $('layout-focus').setAttribute('aria-pressed',String(focused));
  $('layout-focus').textContent=focused?'恢复面板':'专注';
}
function toggleLayout(key){
  if(key==='focus'){const show=Object.values(layout).every(value=>!value);for(const name of Object.keys(layout))layout[name]=show;}
  else layout[key]=!layout[key];
  try{localStorage.setItem('zhiwei.layout',JSON.stringify(layout));}catch{}
  renderLayout();
}
for(const key of ['projects','agent','details','focus'])$('layout-'+key).onclick=()=>toggleLayout(key);
for(const [id,key] of [['hide-projects','projects'],['hide-agent','agent'],['hide-details','details'],['hide-weather','details']])$(id).onclick=()=>toggleLayout(key);
renderLayout();
$('subtitle-expand').onclick=()=>{
  const expanded=$('subtitle-expand').getAttribute('aria-expanded')!=='true';
  $('subtitle-expand').setAttribute('aria-expanded',String(expanded));
  $('subtitle-expand').textContent=expanded?'收起回答':'展开回答';
  document.body.dataset.expandedReply=String(expanded);
};
$('desktop-save').onclick=async()=>{
  try{await api('desktop/settings',{enabled:$('desktop-enabled').checked,screenContext:$('desktop-screen').checked});$('desktop-status').textContent='后台设置已保存。';}
  catch(error){$('desktop-status').textContent=error.message;}
};
const orb = mountOrb({ canvas:$('orb-canvas'), stage:$('orb-stage'), label:$('orb-label'), simulation:orbSim, showFps:new URLSearchParams(location.search).get('orbFps') === '1' });
const panels = [['sessions-toggle','conversation-panel'],['inspector-toggle','inspector-panel'],['conversation-toggle','conversation-panel'],['wechat-toggle','wechat-panel'],['setup-toggle','setup-panel']];
let activePanelTrigger;
let voiceprintUI;
mountWechat({document,api:(...args)=>api(...args)});
function closePanels(){
  for(const [button,panel] of panels){$(panel).hidden=true;$(button).setAttribute('aria-expanded','false');}
  activePanelTrigger=undefined;
  if(audioCheck.busy)audioCheck.stop();
  if(voiceprintUI?.busy||voiceprintUI?.pending)voiceprintUI.stop();
}
for(const [button,panel] of panels)$(button).onclick=()=>{
  const opening=$(panel).hidden;closePanels();
  if(opening){
    $(panel).hidden=false;
    activePanelTrigger=button;
    for(const [trigger,target] of panels)if(target===panel)$(trigger).setAttribute('aria-expanded','true');
  }
};
for(const button of document.querySelectorAll('[data-close]'))button.onclick=()=>{
  const trigger=activePanelTrigger||button.dataset.close;
  closePanels();
  $(trigger).focus();
};
document.addEventListener('keydown',event=>{
  if(event.key!=='Escape')return;
  const trigger=activePanelTrigger;closePanels();if(trigger)$(trigger).focus();
});
let voiceRoute='bailian';
try{if(globalThis.localStorage?.getItem('zhiwei.voice-route')==='native')voiceRoute='native';}catch{}
$('voice-route').value=voiceRoute;
$('caption-sync').checked=false;
// Immediate speech is the default; the old wait-for-subtitles preference is intentionally not restored.
$('caption-sync').onchange=()=>render();
$('voice-language').onchange=()=>render();
$('voice-route').onchange=()=>{
  if($('voice-route').disabled)return;
  voiceRoute=$('voice-route').value==='bailian'?'bailian':'native';
  try{globalThis.localStorage?.setItem('zhiwei.voice-route',voiceRoute);}catch{}
  render();
};
const audioCheck=createAudioCheck({onChange:value=>{
  $('check-status').textContent=value.message;$('check-level').value=value.level;
  $('check-stop').hidden=!value.busy;render();
}});
$('check-mic').onclick=()=>{if(!$('check-mic').disabled)void audioCheck.start('mic');};
$('check-speaker').onclick=()=>{if(!$('check-speaker').disabled)void audioCheck.start('speaker');};
$('check-stop').onclick=()=>audioCheck.stop();
voiceprintUI=mountVoiceprint({document,api:(...args)=>api(...args),onChange:()=>render(),isBlocked:()=>orbSim||!streamOnline||audioCheck.busy||bailianVoice.pending||nativeVoice.pending});

const taskLabels = { idle: '空闲', starting: '正在发送', running: '执行中', stopping: '正在停止，等待确认', completed: '已完成', failed: '失败', interrupted: '已中断', unknown: '执行状态未知，请恢复会话核对' };
const connectionLabels = { disconnected: '已断开', connecting: '正在连接', connected: '已连接 · ChatGPT', error: '连接失败' };
let state;
let csrf;
const workSurface=mountWorkSurface({document,fetch:(...args)=>fetch(...args),token:()=>csrf,openWorkspace:project=>void workbenchUI.addProject({cwd:project.cwd,name:project.displayTitle||project.title,agent:project.agent})});
const workbenchUI=mountWorkbench({document,fetch:(...args)=>fetch(...args),api:(...args)=>api(...args),onError:showError,onPrompt:usePrompt,onSelection:()=>{grokBotStatus='';render();},onGrokBot:()=>openGrokBot(),audioPending:()=>bailianVoice.pending||nativeVoice.pending,onFiles:()=>{if($('inspector-panel').hidden)$('inspector-toggle').onclick();void refreshFiles();}});
$('conversation-new-project').onclick=()=>{closePanels();workbenchUI.openProjectForm();};
const dashboard=orbSim?null:mountDashboard({document,fetch:(...args)=>fetch(...args),token:()=>csrf,onProjects:(projects,agent)=>{workSurface.setAgent(agent);workbenchUI.setCatalog(projects,agent);},openProject:project=>void workSurface.openProject(project),openProjects:()=>{if($('inspector-panel').hidden)$('inspector-toggle').onclick();$('projects-query').focus();}});
const memoryPanel = mountMemory({ document, fetch: (...args) => fetch(...args), token: () => csrf, confirm: message => window.confirm(message) });
let posting = false;
let planPosting = false;
const pendingApprovals = new Set();
let stopPosting = false;
let filesLoading = false;
let filesRefreshPending = false;
let voicePosting = false;
let voiceRequest = 0;
let voiceStopping = false;
let voiceModePosting = false;
let pttSource = null;
let pttEpoch = 0;
let pttQueue = Promise.resolve();
let streamOnline = false;
let localError = '';
let selected = '';
let sessionSignature = '';
let approvalSignature = '';
let windowsSignature = '';
let nativeNote = '',localPreparing=false;
let modelSignature='',modelsLoading=false,modelPosting=false,modelRequested=false,modelRequestEpoch=0;
const effortLabels={none:'关闭',off:'关闭',minimal:'最低',low:'低',medium:'中',high:'高',extra:'很高',xhigh:'很高',max:'最高',ultra:'超高',enabled:'开启（默认）'};
let grokBotStatus='';
let recognitionSignature='',recognitionDirty=false,recognitionPosting=false,recognitionNote='';
let autoApprovalPosting=false,autoApprovalNote='';
$('auto-approve-reads').onchange=async()=>{
  if(autoApprovalPosting)return;
  autoApprovalPosting=true;autoApprovalNote='';render();
  try{
    const value=await api('workbench/approval-policy',{enabled:$('auto-approve-reads').checked});
    state.workbench.autoApproveReads=value.enabled;
    autoApprovalNote=value.enabled?'已开启。':'已关闭。';
  }catch(error){autoApprovalNote=error.message;}
  finally{autoApprovalPosting=false;render();}
};
$('recognition-select').onchange=$('recognition-consent').onchange=()=>{recognitionDirty=true;recognitionNote='';render();};
$('recognition-save').onclick=async()=>{
  if(recognitionPosting)return;
  const asr=$('recognition-select').value,useInstalledSession=asr==='bageshuo'&&$('recognition-consent').checked;
  if(asr==='bageshuo'&&!useInstalledSession){recognitionNote='请先阅读并勾选本机叭哥说登录会话的使用说明；未读取登录信息。';render();return;}
  recognitionPosting=true;render();
  try{const value=await api('voice/recognition',{asr,useInstalledSession});state.voice.recognition=value;recognitionDirty=false;recognitionSignature='';recognitionNote=asr==='bageshuo'?'网易登录已验证。请开始或恢复语音输入。':'已切回百炼识别；已清除知微内存中的网易会话。';}
  catch(error){recognitionNote=error.message;}
  finally{recognitionPosting=false;render();}
};
const workspaceDrafts=new Map();
const draftKey=value=>value?.workbench?value.workbench.projectId+':'+value.workbench.agent:'';
const grokBotSelected=()=> $('workbench-agent').value==='grok-bot';
async function openGrokBot(){
  if(posting||!streamOnline)return;
  const text=$('input').value.trim();
  posting=true;grokBotStatus='';showError('');render();
  try{
    if(text){
      const projectId=$('workbench-project').value||state.workbench?.projectId;
      const project=state.workbench?.projects?.find(item=>item.id===projectId)?.name;
      await navigator.clipboard.writeText(project?`项目：${project}\n\n${text}`:text);
    }
    await api('workbench/grok-bot/open');
    grokBotStatus=text?'任务草稿已复制，到 Grok Bot 粘贴并发送。':'已打开 Grok Bot 桌面版。';
  }catch(error){showError(error.message);}
  finally{posting=false;render();}
}
async function loadModels(){
  if(modelsLoading||!csrf)return;const request=++modelRequestEpoch;modelsLoading=true;render();
  try{const response=await fetch('/api/models',{headers:{'X-Zhiwei-CSRF':csrf}}),value=await response.json();if(request!==modelRequestEpoch)return;if(!response.ok)throw new Error(value.error);state.models=value;render();}
  catch(error){if(request===modelRequestEpoch)showError(error.message);}finally{if(request===modelRequestEpoch){modelsLoading=false;render();}}
}
let localVoiceLevel, nativeVoiceLevel;
const localCaptions=createLocalCaptions({onChange:()=>render(),onStatus:message=>{$('local-caption-status').textContent=message;if(message.includes('已就绪'))render();}});
$('voice-settings-open').onclick=()=>{if($('setup-panel').hidden)$('setup-toggle').onclick();};
$('prepare-local-captions').onclick=()=>{void localCaptions.prepare({download:true});};
if(!orbSim)void localCaptions.prepare();
function updateOrb() {
  const nativeActive = nativeVoice.status === 'connected';
  let voice = state?.voice || { state:'idle' };
  if (nativeActive) voice = nativeVoiceLevel || { state:'listening' };
  else if (!voice.enabled || voice.state === 'idle') voice = { ...voice, state:isBusy() ? 'thinking' : state?.task.status === 'interrupted' ? 'interrupted' : 'idle' };
  const local = !nativeActive && localVoiceLevel && localVoiceLevel.state === voice?.state && Date.now() - localVoiceLevel.levelAt < 600 ? localVoiceLevel : {};
  orb.setVoice({ ...voice, ...local });
}
const nativeVoice = createNativeVoice({api:(route,body)=>api(route,body,{keepalive:route.endsWith('/stop')}),
  onChange:message=>{if(message)nativeNote=message;if(nativeVoice.status!=='connected')nativeVoiceLevel=null;render();},onError:showError,
  onLevel:voice=>{nativeVoiceLevel=voice;updateOrb();},onQuality:quality=>{const poor=quality&&(quality.loss>0.05||quality.concealment>0.1);$('voice-quality').hidden=!poor;$('voice-quality').textContent=poor?'音频网络不稳 · 可能出现断续或电音；可结束后重连，或手动选择百炼。':'';}});
const bailianVoice=createBailianVoice({token:()=>csrf,onError:showError,onChange:()=>{localVoiceLevel=null;render();},
  onLevel:levels=>{const phase=state?.voice?.state;if(!state?.voice?.enabled||!['listening','speaking'].includes(phase))return;
    localVoiceLevel={state:phase,level:levels[phase],levelAt:Date.now()};updateOrb();}});
const operationStates={queued:'排队中',awaitingApproval:'等待授权',running:'执行中',completed:'已完成',cancelled:'已取消',failed:'失败',unknown:'结果未知'};
function usePrompt(text){
  if ($('conversation-panel').hidden) $('conversation-toggle').onclick();
  $('input').value=text;$('input').focus();
}
const rows = new Map();
const planActive = () => ['planning', 'running'].includes(state?.plan?.status);
const isBusy = () => planActive() || ['starting', 'running', 'stopping', 'unknown'].includes(state?.task.status);
function showError(message) { localError = message; $('error').hidden = !message; $('error').textContent = message; }
async function api(route, body = {}, options = {}) {
  if (orbSim) throw new Error('当前为光球预览模式');
  const response = await fetch(`/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zhiwei-CSRF': csrf }, body: JSON.stringify(body), ...options });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '本地请求失败');
  return result;
}
async function action(route, body = {}) {
  // Approval may arrive before turn/start responds. It must not wait for that send.
  if (route === 'approval' || route === 'windows/approval') {
    const key = `${route}:${body.id}`;
    if (pendingApprovals.has(key)) return;
    pendingApprovals.add(key); showError(''); render();
    try { return await api(route, body); }
    catch (error) { showError(error.message); return; }
    finally { pendingApprovals.delete(key); render(); }
  }
  const isPlan = route === 'plan';
  if (posting || (isPlan && planPosting)) return;
  if (isPlan) planPosting = true; else posting = true;
  showError(''); render();
  try { return await api(route, body); }
  catch (error) { showError(error.message); }
  finally { if (isPlan) planPosting = false; else posting = false; render(); }
}
function element(tag, text, className) { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; }
function render() {
  if (!state) return;
  workbenchUI.update(state,csrf);
  dashboard?.update(state,$('workbench-agent').value||state.workbench?.agent);
  const grokBot=grokBotSelected();
  const pendingAgent=state.workbench?.switching||state.workbench&&($('workbench-agent').value!==state.workbench.agent||$('workbench-project').value!==state.workbench.projectId);
  const models=pendingAgent?null:state.models,modelSelect=$('model-select'),effortSelect=$('effort-select'),effort=models?.effort;
  const signature=grokBot?'grok-bot-managed':JSON.stringify(models);
  if(signature!==modelSignature){modelSignature=signature;modelSelect.replaceChildren();
    if(!models?.options?.length)modelSelect.append(new Option(grokBot?'Grok Bot 自动选择':'连接后读取执行器模型…',''));
    else {if(!models.selected)modelSelect.append(new Option('请选择模型（未自动启用）',''));for(const m of models.options)modelSelect.append(new Option(m.name,m.id));}
    if(models?.selected){if(!models.options.some(m=>m.id===models.selected))modelSelect.append(new Option(models.selected+'（尚未确认可用）',models.selected));modelSelect.value=models.selected;}
    effortSelect.replaceChildren();
    if(!effort?.options?.length)effortSelect.append(new Option(grokBot||models?.selected?'由 Agent 管理':'选择模型后显示',''));
    else {
      if(effort.canReset)effortSelect.append(new Option('默认',''));
      else if(!effort.options.some(option=>option.id===effort.selected))effortSelect.append(new Option('选择强度',''));
      for(const option of effort.options)effortSelect.append(new Option(Object.hasOwn(effortLabels,option.id)?effortLabels[option.id]:option.name,option.id));
      effortSelect.value=effort.selected??'';
    }
  }
  modelSelect.disabled=!streamOnline||!!pendingAgent||state.connection!=='connected'||modelsLoading||modelPosting||!models?.options?.length||isBusy()||state.locked||bailianVoice.pending||nativeVoice.pending||state.voice?.enabled||state.voice?.changing||['connecting','connected','stopping','unknown'].includes(state.realtime?.status);
  effortSelect.disabled=modelSelect.disabled||!effort?.options?.length;
  $('model-refresh').disabled=!streamOnline||!!pendingAgent||modelsLoading||modelPosting||state.connection!=='connected';
  $('model-status').textContent=grokBot?grokBotStatus||'模型由 Grok Bot 自动选择':pendingAgent?'应用所选 Agent 后显示模型':modelPosting?'正在保存设置…':modelsLoading?'正在读取模型…':models?.error||(models?.options?.length?'模型和思考强度下一轮生效':'连接 Agent 后显示可用模型');
  $('connection').textContent = streamOnline ? (state.connection==='connected'&&state.workbench?'已连接 · '+(state.workbench.agents.find(a=>a.id===state.workbench.agent)?.name||state.workbench.agent):connectionLabels[state.connection] || state.connection) : '本地网页连接已断开，正在重连（任务可能仍在执行）';
  $('connection').dataset.status=streamOnline?state.connection:'disconnected';
  $('current-title').textContent=state.sessions.find(s=>s.id===state.currentId)?.title||'新对话';
  $('empty-state').hidden=state.items.length>0;
  $('task').textContent = taskLabels[state.task.status] || state.task.status;
  const voice = state.voice;
  const archivedChat=state.archivedChat||[];
  $('everyday-archive').hidden=!archivedChat.length;
  $('everyday-history').textContent=archivedChat.map(m=>(m.role==='user'?'你：':'知微：')+m.text).join('\n\n');
  voiceprintUI.update(state);
  const recognition=voice?.recognition||{asr:'dashscope',useInstalledSession:false},recognitionKey=JSON.stringify(recognition);
  if(recognitionKey!==recognitionSignature&&!recognitionDirty&&!recognitionPosting){recognitionSignature=recognitionKey;$('recognition-select').value=recognition.asr==='bageshuo'?'bageshuo':'dashscope';$('recognition-consent').checked=recognition.useInstalledSession===true;}
  const recognitionBlocked=orbSim||!streamOnline||recognitionPosting||isBusy()||state.locked||state.workbench?.switching||voice?.changing||bailianVoice.pending||nativeVoice.pending||['connecting','connected','stopping','unknown'].includes(state.realtime?.status);
  const canReprepare=voice?.spokenModes&&voice.inputEnabled===false&&voice.state==='idle'&&recognition.asr==='bageshuo'&&recognition.useInstalledSession&&$('recognition-select').value==='bageshuo'&&$('recognition-consent').checked;
  $('recognition-select').disabled=!!(recognitionBlocked||voice?.enabled);
  $('recognition-consent').disabled=$('recognition-select').disabled;
  $('recognition-save').disabled=!!(recognitionBlocked||voice?.enabled&&!canReprepare);
  $('recognition-consent-label').hidden=$('recognition-select').value!=='bageshuo';
  $('recognition-save').textContent=$('recognition-select').value==='bageshuo'?'验证并保存网易识别':'保存识别方式';
  $('recognition-status').textContent=recognitionPosting?'正在验证识别设置…':recognitionNote||`当前识别：${recognition.asr==='bageshuo'?'网易叭哥说（说话时自动连接）':'百炼 Paraformer'}。更换线路前请结束语音连接。`;
  updateOrb();
  let lastUser = '', lastAssistant = '',lastAssistantId='',lastUserId='';
  for (const item of state.items) {
    if (item.type === 'userMessage' && item.text?.trim()) { lastUser = item.text;lastUserId=item.id; lastAssistant = '';lastAssistantId=''; }
    if (item.type === 'agentMessage' && item.text?.trim()){lastAssistant = item.text;lastAssistantId=item.id;}
  }
  orb.setScene?.(sceneForState(state));
  workSurface.update(state);
  if(state.realtime?.captionEngine==='local')localCaptions.feed(state.realtime.captionSource);
  const caption=state.realtime?.captionEngine==='local'?localCaptions.caption:state.realtime?.caption;
  const foreignSpeech=(nativeVoice.status==='connected'||caption?.id===lastAssistantId)&&/[a-z]{3}/i.test(lastAssistant)&&!/[\u4e00-\u9fff]/.test(lastAssistant);
  const chineseCaption=foreignSpeech?(caption?.id===lastAssistantId?(caption.text|| (caption.status==='error'?'中文字幕暂时不可用：'+caption.error:'正在翻译中文字幕…')):'正在整理中文字幕…'):lastAssistant;
  $('subtitle-translation-status').textContent=foreignSpeech&&caption?.id===lastAssistantId?(caption.status==='error'?'翻译未完成：'+caption.error:caption.status!=='ready'?'中文字幕更新中…':''):'';
  $('subtitle-original').hidden=!foreignSpeech;$('subtitle-original-text').textContent=foreignSpeech?lastAssistant:'';
  nativeVoice.updateCaption?.(caption,lastAssistant,lastUser);
  const partial = voice?.enabled && ['listening', 'thinking'].includes(voice.state) ? voice.partial : '';
  const waiting = isBusy() || voice?.state === 'thinking' ? '正在生成回答，请稍候…'
    : state.task.status === 'interrupted' ? '本轮已停止，尚未生成回复。' : '我在，今天想先处理哪个项目？';
  for (const [id, text] of [['subtitle-user', partial || lastUser || '说说你想做的事，或从左侧选择项目。'], ['subtitle-assistant', chineseCaption || waiting]]) {
    const node=$(id),key=id==='subtitle-user'?lastUserId:lastAssistantId;
    if(node.dataset.message!==key){node.dataset.message=key;node.dataset.follow='true';}
    if (node.dataset.source !== text) {if(id==='subtitle-assistant')renderReply(document,node,text);else{node.textContent=text;node.dataset.source=text;}if(node.dataset.follow!=='false')node.scrollTop=node.scrollHeight;}
    node.onscroll=()=>{node.dataset.follow=String(node.scrollHeight-node.scrollTop-node.clientHeight<24);};
  }

  const desktopActive=!!state.desktop?.active;
  const nativeActive = ['connecting','connected','stopping'].includes(nativeVoice.status) || ['connecting','connected','stopping','unknown'].includes(state.realtime?.status);
  const nativeAvailable=state.workbench?.nativeVoice!==false&&!voice?.spokenModes;
  $('native-toggle').textContent = nativeActive ? '结束语音对话' : '开始语音对话';
  $('native-toggle').disabled = localPreparing || !streamOnline || nativeVoice.status==='stopping' || (!nativeActive && (nativeVoice.pending || bailianVoice.pending || voicePosting || state.connection!=='connected' || isBusy() || state.locked || state.needsResume || !!state.sessionConflict || voice?.enabled || voice?.changing));
  if(desktopActive||!nativeAvailable||(!nativeActive&&(pendingAgent||grokBot||voice?.voiceprint?.enabled||voiceprintUI.busy)))$('native-toggle').disabled=true;
  $('native-check').disabled = nativeActive || nativeVoice.pending || $('native-toggle').disabled;
  $('native-status').textContent = nativeNote || ({off:'Codex 原生语音 · Juniper 女声：说话自动回应，支持插话。',connecting:'正在连接 Codex 实时音频…',connected:'Juniper 女声 · 实时对话中 · 可直接说话',stopping:'正在关闭实时语音…',error:'实时语音未连接，请查看错误提示。'}[nativeVoice.status] || '');
  const voiceUnavailable = voice?.availability?.ready === false;
  const inputOn=voice?.inputEnabled??voice?.enabled;
  $('voice-toggle').textContent = voice?.enabled ? (voice.spokenModes?(inputOn?'停止语音输入':'恢复语音输入'):'关闭语音对话') : voiceUnavailable ? (recognition.asr==='bageshuo'?'网易识别尚未就绪':'百炼语音未配置') : recognition.asr==='bageshuo'?'开始语音对话（网易识别）':'开始语音对话（百炼女声）';
  $('voice-toggle').setAttribute('aria-pressed', String(!!inputOn));
  $('voice-toggle').disabled = voiceStopping || bailianVoice.pending || !streamOnline || (!voice?.enabled && (voicePosting || voice?.changing || isBusy() || state.locked || (state.needsResume && !state.sessionConflict) || state.connection !== 'connected' || voiceUnavailable));
  if(desktopActive||nativeActive||grokBot||voiceprintUI.busy||!inputOn&&pendingAgent||voice?.spokenModes&&!inputOn&&voiceUnavailable)$('voice-toggle').disabled=true;
  $('voice-reading').hidden=!voice?.spokenModes||!voice.enabled;
  $('voice-reading').disabled=!streamOnline||voice?.changing;
  $('voice-reading').textContent=voice?.readingEnabled?'停止朗读':'恢复朗读';
  $('voice-end').hidden=$('voice-reading').hidden||inputOn||voice?.readingEnabled;
  $('voice-end').disabled=!streamOnline||isBusy()||voice?.state!=='idle';
  $('voice-ptt').hidden = voice?.mode !== 'ptt';
  $('voice-ptt').title=voice?.spokenModes?'按住空格说话，松开后发送；输入框内空格照常使用':'按住鼠标、触摸或空格说话，松开后发送';
  $('voice-ptt').disabled = !inputOn || voice.changing || voiceStopping || !streamOnline || state.connection !== 'connected';
  $('voice-ptt').setAttribute('aria-pressed', String(!!pttSource || !!voice?.held));
  $('voice-ptt').textContent = pttSource || voice?.held ? '正在听…' : voice?.spokenModes?'按住空格说话':'按住说话';
  const voiceIdleHint=voice?.mode==='ptt'?(voice.spokenModes?'按住空格说话':'按住说话')
    :voice?.spokenModes&&voice.mode==='default'?'聆听中 · 请以「知微」开头'
    :voice?.wakeWord?`聆听中（唤醒词：${voice.wakeWord}）`:'可直接说话，自动发送；支持插话';
  $('voice-state').textContent = (recognition.asr==='bageshuo'?'网易识别 · 龙婉女声 · ':'百炼 · 龙婉女声 · ') + (voice?.enabled ? ({ idle:voiceIdleHint, listening:'正在听…', thinking:'当前 Agent 正在思考', speaking:'正在说', interrupted:'已打断' }[voice.state] || voice.state) : '语音已关闭') + (voice?.error ? ` · ${voice.error}` : '') + (voice?.partial ? ` · ${voice.partial}` : '');
  if(voice?.spokenModes&&voice.enabled&&!inputOn)$('voice-state').textContent=(voice.readingEnabled?'收音已停 · 朗读开启':'收音和朗读已停')+(voice.error?' · '+voice.error:voiceUnavailable?' · '+voice.availability.reason:'');
  if (!voice?.enabled && voiceUnavailable) $('voice-state').textContent = voice.error||voice.availability.reason;
  if(bailianVoice.pending)$('voice-state').textContent=bailianVoice.phase;
  const usingNative=nativeActive || (nativeAvailable&&!voice?.voiceprint?.enabled&&!voice?.enabled&&!bailianVoice.pending&&voiceRoute==='native');
  $('native-toggle').hidden=!usingNative;$('voice-toggle').hidden=usingNative;
  $('native-toggle').setAttribute('aria-pressed',String(nativeActive));
  $('voice-route').value=usingNative?'native':'bailian';
  $('voice-route-native').disabled=!nativeAvailable||!!voice?.voiceprint?.enabled;
  $('voice-route').disabled=orbSim||nativeActive||nativeVoice.pending||voice?.enabled||voicePosting||bailianVoice.pending||audioCheck.busy;
  $('caption-sync').disabled=$('voice-route').disabled;
  $('caption-sync').parentElement?.toggleAttribute('hidden',!usingNative||$('voice-language').value==='zh');
  $('voice-language').hidden=!usingNative;$('voice-language').disabled=$('voice-route').disabled;
  if(!nativeAvailable||voice?.voiceprint?.enabled){$('native-check').disabled=true;}
  $('voice-cost').hidden=usingNative;
  $('voice-cost').textContent=usingNative?($('caption-sync').checked?'字幕优先 · 中文准备好后再播放英语，开口会稍晚；不调用百炼。':(localCaptions.ready?'英语直接回答 · 中文字幕在本机生成，不调用百炼。':'英语直接回答 · 云端中文字幕可能滞后；可准备本地字幕，不调用百炼。')):'百炼语音 · 识别与朗读产生 API 用量，费用以百炼账单为准。';
  if(usingNative)$('voice-state').textContent=state.realtime?.taskControl||nativeNote||({off:'点击开始，让知微听见你',connecting:'正在建立语音连接…',connected:'正在聆听 · 直接说话即可',stopping:'正在结束语音…',error:'语音未连接，可在「设置与检查」排查声音'}[nativeVoice.status]||'语音已关闭');
  if(usingNative&&nativeActive&&$('caption-sync').checked&&foreignSpeech&&caption?.status!=='ready')$('voice-state').textContent=caption?.status==='error'?'翻译未完成，英语已暂停；可结束后选择立即播放。':'正在准备中文，随后播放英语…';
  $('voice-mode-select').hidden=!voice?.spokenModes;
  $('voice-mode-select').disabled=!streamOnline||voice?.changing||bailianVoice.pending||voiceModePosting;
  if(!voiceModePosting)$('voice-mode-select').value=voice?.mode||'default';
  $('mode-summary').textContent=voice?.spokenModes?({default:'默认模式 · 以「知微」开头',dialog:'对话模式 · 直接说话',ptt:'控制模式 · 按住空格说话'}[voice.mode]):usingNative?($('voice-language').value==='zh'?'原生语音 · 中文回答':localCaptions.ready?'原生英文 · 本地中文字幕':'原生英文 · 中文字幕'):recognition.asr==='bageshuo'?'网易识别（实验）· 龙婉中文女声':'百炼语音 · 龙婉中文女声';
  if(!usingNative&&recognition.asr==='bageshuo')$('voice-cost').textContent='录音由网易叭哥说处理，朗读使用百炼龙婉；用量和限制以各服务商为准。';
  const checkingBlocked=desktopActive||orbSim||audioCheck.busy||nativeActive||nativeVoice.pending||voice?.enabled||voicePosting||bailianVoice.pending;
  $('check-mic').disabled=!!checkingBlocked||voiceprintUI.busy;$('check-speaker').disabled=!!checkingBlocked||voiceprintUI.busy;
  if(audioCheck.busy){$('native-toggle').disabled=true;$('native-check').disabled=true;$('voice-toggle').disabled=true;}
  $('setup-connection').textContent=!streamOnline?'本地连接已断开，请等待重连。':state.connection==='connected'?'已连接，可以开始对话。':'尚未连接当前 Agent，请在「项目与文件 → 连接信息」中检查并重新连接。';
  if(!autoApprovalPosting)$('auto-approve-reads').checked=state.workbench?.autoApproveReads===true;
  $('auto-approve-reads').disabled=orbSim||!streamOnline||autoApprovalPosting||!state.workbench;
  $('auto-approve-status').textContent=autoApprovalPosting?'正在保存…':autoApprovalNote;
  const approvalCount=state.approvals.length+(state.computer?.approvals?.length||0);
  const planning=state.plan?.status==='planning';
  const taskStatus=planning?'starting':state.plan?.status==='running'&&state.task.status==='idle'?'running':state.task.status;
  $('task-overview').textContent=approvalCount?`等待你授权 · ${approvalCount} 项`:planning?'正在规划':taskLabels[taskStatus]||taskStatus;
  $('task-overview').dataset.status=approvalCount?'approval':taskStatus;
  $('started').textContent = state.task.startedAt ? `开始 ${new Date(state.task.startedAt).toLocaleTimeString()}` : '';
  $('version').textContent = state.version || '';
  $('workspace').textContent = `专用工作区：${state.workspace}`;
  $('new').disabled = posting || planPosting || !!pendingAgent || state.locked || isBusy() || state.connection !== 'connected' || !streamOnline;
  if(nativeActive)$('new').disabled=true;
  $('multi-step').disabled=nativeActive||grokBot||!!pendingAgent;
  $('connect').disabled = posting || state.connection === 'connecting' || state.connection === 'connected';
  $('connect').textContent='重新连接 '+(state.workbench?.agents.find(a=>a.id===state.workbench.agent)?.name||'Agent');
  $('send').disabled = posting || planPosting || !streamOnline || (!grokBot&&(!!pendingAgent||state.locked||isBusy()||(state.needsResume&&!state.sessionConflict)||state.connection!=='connected'));
  $('send').textContent=grokBot?'复制任务并打开 Grok Bot':state.currentId?'发送 ↑':'开始对话 ↑';
  const voiceActive = voice?.enabled && voice.state !== 'idle';
  $('stop').disabled = stopPosting || !streamOnline || (!voiceActive && ((!planActive() && !state.task.turnId && state.task.status !== 'starting') || !isBusy() || state.task.status === 'stopping')) || state.connection !== 'connected';
  if(nativeActive&&streamOnline&&!stopPosting)$('stop').disabled=false;
  if(bailianVoice.pending&&streamOnline&&!stopPosting)$('stop').disabled=false;
  if(state.workbench?.agent!=='codex'&&state.task.status==='unknown'&&state.currentId&&streamOnline&&!stopPosting)$('stop').disabled=false;
  $('files-refresh').disabled = filesLoading || !csrf;
  $('export-chat').disabled = !state.items.some(item => ['userMessage', 'agentMessage'].includes(item.type));
  memoryPanel.update();
  const error = localError || state.realtime?.error || state.error;
  $('error').textContent = error || ''; $('error').hidden = !error;
  $('retry-session').hidden = !state.sessionConflict && (!state.currentId || !state.needsResume || !!state.missingSession);
  $('retry-session').textContent = state.sessionConflict ? '稍后重试' : '恢复原对话';
  $('retry-session').disabled = posting || planPosting || !!pendingAgent || state.locked || !streamOnline || nativeActive || state.connection !== 'connected' || (isBusy() && state.task.status !== 'unknown');
  $('missing-session-new').hidden = !state.missingSession && !state.sessionConflict;
  $('missing-session-new').disabled = $('new').disabled;
  const desktop=state.desktop;
  if(desktop){
    const dsig=JSON.stringify(desktop.settings);
    if($('desktop-save').dataset.saved!==dsig){
      $('desktop-enabled').checked=!!desktop.settings.enabled;
      $('desktop-screen').checked=!!desktop.settings.screenContext;
      $('desktop-save').dataset.saved=dsig;
    }
    $('desktop-status').textContent=desktop.error||(!desktop.supported?'后台快捷键仅支持 Windows。':!desktop.settings.enabled?'后台快捷键已关闭。':desktop.hotkeyReady?'Ctrl＋空格已就绪 · '+(desktop.active?'后台语音进行中':'按住说话，松开发送'):'正在准备后台快捷键…');
    $('desktop-save').disabled=!!desktop.active;
  }
  const sig = JSON.stringify([state.sessions, state.currentId, isBusy(), posting, planPosting, state.locked, state.needsResume, streamOnline,nativeActive,pendingAgent]);
  if (sig !== sessionSignature) {
    sessionSignature = sig; $('sessions').replaceChildren();
    for (const session of state.sessions) {
      const button = element('button', session.title + (session.id === state.currentId && state.needsResume ? '（需要恢复）' : ''));
      button.setAttribute('aria-current', String(session.id === state.currentId));
      button.disabled = posting || planPosting || !!pendingAgent || state.locked || !streamOnline || (isBusy() && state.task.status !== 'unknown');
      if(nativeActive)button.disabled=true;
      button.title = new Date(session.updatedAt).toLocaleString();
      button.onclick = () => action('resume', { id: session.id });
      $('sessions').append(button);
    }
  }
  if (selected !== state.currentId) { rows.clear(); $('chat').replaceChildren(); selected = state.currentId; }
  const chat = $('chat');
  const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 100;
  const keep = new Set();
  for (const item of state.items) {
    keep.add(item.id);
    let row = rows.get(item.id);
    if (!row) {
      row = element('article', '', `message ${item.type}`);
      row.append(element('strong', item.type === 'userMessage' ? '你' : item.type === 'agentMessage' ? '知微' : '执行事件'), element(item.type==='agentMessage'?'div':'pre','','reply-content'));
      if (item.type === 'agentMessage') {
        const copy = element('button', '复制', 'text-button');
        copy.type = 'button';
        copy.onclick = async () => {
          try { await navigator.clipboard.writeText(row.dataset.source||''); copy.textContent = '已复制'; }
          catch { showError('复制失败，请选中回复文字后按 Ctrl+C。'); }
        };
        row.append(copy);
      }
      rows.set(item.id, row); chat.append(row);
    }
    const content = row.querySelector(item.type==='agentMessage'?'div':'pre');
    if (row.dataset.source !== item.text) {
      row.dataset.source=item.text;
      if(item.type==='agentMessage')renderReply(document,content,item.text);else content.textContent = item.text;
      const copy = row.querySelector('button'); if (copy) copy.textContent = '复制';
    }
  }
  for (const [id, row] of rows) if (!keep.has(id)) { row.remove(); rows.delete(id); }
  if (atBottom) chat.scrollTop = chat.scrollHeight;
  const allApprovals = [...state.approvals, ...(state.computer?.approvals || []).map(a => ({ ...a, windows: true }))];
  const hadApprovals=!$('approval-panel').hidden;
  $('approval-panel').hidden = allApprovals.length === 0;
  if(allApprovals.length&&!hadApprovals)$('approval-panel').open=true;
  $('approval-summary').textContent = `待审批 · ${allApprovals.length} 项（展开处理）`;
  const asig = JSON.stringify([allApprovals, [...pendingApprovals], streamOnline]);
  if (asig !== approvalSignature) {
    approvalSignature = asig; $('approvals').replaceChildren();
    for (const approval of allApprovals) {
      const card = element('div', '', 'approval');
      const view=approvalView(approval,state.workspace);
      card.append(element('strong',view.title));
      if(approval.windows)card.append(element('p',approval.risk==='high'?'需要额外确认 · 请核对实际窗口':approval.risk==='screenshot-to-Codex'?'截图发送授权 · 仅此一次':'Windows 操作授权 · 仅此一次','approval-risk'));
      card.append(element('p',view.description));
      const facts=element('dl','','approval-facts');
      for(const [label,value] of view.facts){const pair=element('div');pair.append(element('dt',label),element('dd',value));facts.append(pair);}card.append(facts);
      if(view.inputText!==null&&view.inputText!==undefined){card.append(element('p',`输入内容（${view.inputText.length} 个字符）`),element('pre',view.inputText||'（清空文本）'));}
      const details=element('details');details.append(element('summary',approval.windows?'查看完整参数':'查看请求详情'),element('pre',view.details));card.append(details);
      const actions = element('div', '', 'actions');
      for (const [decision, label] of [['accept', '允许本次'], ['decline', '拒绝']]) {
        const button = element('button', label);
        const route = approval.windows ? 'windows/approval' : 'approval';
        button.disabled = !streamOnline || pendingApprovals.has(`${route}:${approval.id}`);
        button.onclick = () => action(route, { id: approval.id, decision });
        actions.append(button);
      }
      card.append(actions); $('approvals').append(card);
    }
  }
  $('logs').replaceChildren(...state.logs.map(log => element('div', `${new Date(log.time).toLocaleTimeString()} ${log.message}`, 'log')));
  const computer=state.computer;
  $('windows-state').textContent=computer?`${computer.desktop?.locked===true?'Windows 已锁屏，请本人解锁后操作':computer.desktop?.locked===false?'桌面可交互':'桌面状态尚未检查'}。${computer.currentWindow?' 最近核验窗口：'+computer.currentWindow.title:' 请在操作时重新核验目标窗口。'}${computer.storageError?' '+computer.storageError:''}`:'Windows 工具未启用';
  $('windows-check').disabled=posting||!streamOnline||!computer;
  const wsig=JSON.stringify([computer?.actions?.map(a=>[a.id,a.status,a.resolution,a.error]),computer?.savedWindows,posting,isBusy(),streamOnline,state.currentId,state.needsResume,state.connection]);
  if(wsig!==windowsSignature){
    windowsSignature=wsig;$('windows-actions').replaceChildren();$('windows-saved').replaceChildren();
    const actions=computer?.actions||[];
    // Keep unresolved results visible even when newer read-only events arrive.
    const visible=[...actions.filter(a=>a.needsReview),...actions.filter(a=>!a.needsReview).slice(-12).reverse()];
    if(!visible.length)$('windows-actions').append(element('p','还没有电脑操作。执行后，这里会留下记录。','empty-note'));
    for(const a of visible){
      const row=element('div','','action-row');const title=element('div','','action-title');
      const status=element('span',operationStates[a.status]||a.status,'action-status');status.dataset.status=a.status;
      title.append(element('span',operationNames[a.tool.replace(/^windows_/,'')]||a.tool),status);row.append(title);
      if(a.startedAt)row.append(element('p',new Date(a.startedAt).toLocaleTimeString()));
      if(a.error)row.append(element('p',a.error));
      if(a.resolution)row.append(element('p',`用户核实：${{applied:'已执行',notApplied:'未执行',partial:'部分执行'}[a.resolution]||a.resolution}。未自动重试。`));
      if(a.needsReview){row.append(element('p','请查看实际结果，再记录你的核实结论；这不会重新执行操作。'));const buttons=element('div','','review-buttons');
        for(const [resolution,label] of [['applied','已执行'],['notApplied','未执行'],['partial','部分执行']]){const button=element('button',label);button.disabled=posting||!streamOnline;button.onclick=()=>action('windows/resolve',{id:a.id,resolution});buttons.append(button);}row.append(buttons);}
      $('windows-actions').append(row);
    }
    const windows=computer?.savedWindows||[];
    if(!windows.length)$('windows-saved').append(element('p','知微创建的窗口会显示在这里，之后可以申请继续。','empty-note'));
    for(const window of windows){
      const row=element('div','','window-row');row.append(element('strong',appNames[window.app]||window.app),element('p',window.documentName||'专用测试窗口'));
      row.append(element('p',{bound:'本次已授权',needsApproval:'需要重新授权',closed:'已关闭'}[window.status]||window.status));
      if(window.status==='needsApproval'){const button=element('button','申请恢复');button.disabled=posting||isBusy()||!streamOnline||!state.currentId||state.needsResume||state.connection!=='connected';button.onclick=()=>usePrompt(`请恢复知微此前创建的${appNames[window.app]||window.app}窗口，绑定编号为 ${window.id}。请先验证窗口身份，再请求本次恢复授权。`);row.append(button);}
      $('windows-saved').append(row);
    }
  }
}
$('new').onclick = () => action('new');
$('missing-session-new').onclick = $('new').onclick;
$('retry-session').onclick = () => action('resume', { id: state.sessionConflict?.threadId || state.currentId });
$('native-toggle').onclick=async()=>{
  nativeNote='';showError('');
  if(['connecting','connected','stopping','unknown'].includes(state?.realtime?.status)||['connecting','connected'].includes(nativeVoice.status)){void nativeVoice.stop();return;}
  if(localPreparing)return;localPreparing=true;render();
  try{
    const language=$('voice-language').value||'en';
    if(language==='en'&&!localCaptions.ready)await Promise.race([localCaptions.prepare({download:true}),new Promise(resolve=>setTimeout(resolve,1500))]);
    localCaptions.reset();localPreparing=false;await nativeVoice.start({language,syncCaptions:$('caption-sync').checked,captionEngine:localCaptions.ready?'local':'cloud'});
  }finally{localPreparing=false;render();}
};
$('native-check').onclick=()=>{nativeNote='';showError('');void nativeVoice.start({checkOnly:true});};
let projectsLoading=false;
$('projects-search').onsubmit=async event=>{
  event.preventDefault();if(projectsLoading||!csrf||orbSim)return;
  const agent=$('workbench-agent').value||state?.workbench?.agent;
  if(agent==='grok-bot')return;
  const query=new URLSearchParams({query:$('projects-query').value||''});if(agent)query.set('agent',agent);
  projectsLoading=true;$('projects-status').textContent='正在查找所选 Agent 的项目…';
  try{
    const response=await fetch('/api/projects?'+query,{headers:{'X-Zhiwei-CSRF':csrf}}),result=await response.json();if(!response.ok)throw new Error(result.error);
    if(agent!==($('workbench-agent').value||state?.workbench?.agent))return;
    $('projects-list').replaceChildren();$('project-detail').hidden=true;
    const projects=groupProjects(result.threads);
    for(const thread of projects){const row=element('div','','project-row');row.append(element('strong',thread.displayTitle));const button=element('button','读取最近进展');button.type='button';
      if(thread.nativeProject||thread.codexRoot&&!thread.previewId){
        button.textContent='查看工作目录';button.onclick=()=>void workSurface.openProject(thread);row.append(button);$('projects-list').append(row);continue;
      }
      button.onclick=async()=>{
      const params=new URLSearchParams({id:thread.previewId||thread.id});if(agent)params.set('agent',agent);
      button.disabled=true;try{const r=await fetch('/api/projects/read?'+params,{headers:{'X-Zhiwei-CSRF':csrf}}),data=await r.json();if(!r.ok)throw new Error(data.error);if(agent!==($('workbench-agent').value||state?.workbench?.agent))return;$('project-detail').textContent=thread.displayTitle+'\n'+(data.cwd||thread.cwd||'')+'\n\n'+data.messages.map(m=>(m.role==='user'?'你：':'助理：')+m.text).join('\n\n');$('project-detail').hidden=false;}catch(e){$('projects-status').textContent=e.message;}finally{button.disabled=false;}};row.append(button);$('projects-list').append(row);}
    $('projects-status').textContent=`找到 ${projects.length} 个项目与任务。${result.truncated?'结果未列完，请用更具体的关键词。':''}`;
  }catch(error){$('projects-status').textContent=error.message;}finally{projectsLoading=false;}
};
let previewSequence=0;
async function fileRequest(route,name){
  if (orbSim) throw new Error('当前为光球预览模式');
  const project=state?.workbench?.projectId;const query=new URLSearchParams();if(name!==undefined)query.set('name',name);if(project)query.set('projectId',project);
  const response=await fetch(`/api/files${route}${query.size?'?'+query:''}`,{headers:{'X-Zhiwei-CSRF':csrf}});
  if(project!==state?.workbench?.projectId)throw new Error('项目已切换，请刷新文件列表。');
  if(!response.ok){const failure=await response.json();throw new Error(failure.error||'文件读取失败，请刷新。');}
  return response;
}
async function previewFile(name){
  const sequence=++previewSequence;$('files-status').textContent='正在读取文件…';
  try{
    const file=await(await fileRequest('/preview',name)).json();if(sequence!==previewSequence)return;
    $('file-title').textContent=file.name;$('file-content').textContent=file.text;
    $('file-info').textContent=`${file.size} 字节 · ${new Date(file.modifiedAt).toLocaleString()}${file.truncated?' · 仅预览前 64 KB，下载可获取完整文件':''}`;
    $('file-preview').hidden=false;$('file-preview').open=true;$('files-status').textContent='已读取实际文件内容。';
  }catch(error){if(sequence===previewSequence){$('file-preview').hidden=true;$('file-content').textContent='';$('files-status').textContent=error.message;}}
}
async function downloadFile(name,button){
  button.disabled=true;
  try{const response=await fileRequest('/download',name);const url=URL.createObjectURL(await response.blob());
    const link=element('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch(error){$('files-status').textContent=error.message;}finally{button.disabled=false;}
}
async function refreshFiles(){
  if(filesLoading){filesRefreshPending=true;return;}filesLoading=true;$('files-refresh').disabled=true;$('files-status').textContent='正在检查工作文件…';
  try{const result=await(await fileRequest('')).json();$('files-list').replaceChildren();
    for(const file of result.files){const row=element('div','','file-row');const preview=element('button',file.name,'file-name');preview.title='预览 '+file.name;preview.onclick=()=>previewFile(file.name);
      const download=element('button','下载');download.setAttribute('aria-label','下载 '+file.name);download.onclick=()=>downloadFile(file.name,download);row.append(preview,download);$('files-list').append(row);}
    $('files-status').textContent=result.truncated?'仅显示部分符合条件的文件；可让知微整理工作目录。':result.files.length?`${result.files.length} 个可预览文件 · 每个最多 1 MB`:'暂时没有符合条件的文本文件。';
  }catch(error){$('files-status').textContent=error.message;}finally{filesLoading=false;$('files-refresh').disabled=!csrf;if(filesRefreshPending){filesRefreshPending=false;void refreshFiles();}}
}
$('files-refresh').onclick=refreshFiles;
$('export-chat').onclick=()=>{
  try {
    const file=conversationExport(state), url=URL.createObjectURL(new Blob(['\uFEFF',file.text],{type:'text/plain;charset=utf-8'}));
    const link=element('a');link.href=url;link.download=file.filename;document.body.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  } catch(error){showError(error.message);}
};
$('file-close').onclick=()=>{previewSequence++;$('file-preview').hidden=true;$('file-content').textContent='';};
for(const button of document.querySelectorAll('[data-prompt]'))button.onclick=()=>usePrompt(button.dataset.prompt);
$('windows-check').onclick = () => action('windows/status');
$('connect').onclick = () => action('connect');
function pttRequest(action, epoch = pttEpoch) {
  // Serialize a quick release behind its press, including across separate HTTP connections.
  pttQueue = pttQueue.then(() => api('voice/ptt', { action }, { keepalive:true })).catch(async error => {
    if (epoch === pttEpoch) pttSource = null;
    showError(error.message);
    if (action === 'stop') {
      try { await api('voice', { enabled:false }, { keepalive:true }); }
      catch { /* Keep the original visible transport error. */ }
    }
  }).finally(render);
  return pttQueue;
}
function beginPtt(source) {
  if (pttSource || $('voice-ptt').disabled || state?.voice?.mode !== 'ptt') return;
  if(state?.voice?.spokenModes&&!bailianVoice.hold('start'))return;
  pttEpoch++; pttSource = source; showError(''); render();
  if(!state?.voice?.spokenModes)void pttRequest('start');
}
function endPtt(discard=false) {
  if (!pttSource) return;
  pttSource = null; render();
  if(state?.voice?.spokenModes)bailianVoice.hold(discard?'cancel':'stop');else void pttRequest('stop');
}
$('voice-ptt').onpointerdown = event => {
  if (state?.voice?.spokenModes || event.button !== 0 || pttSource || $('voice-ptt').disabled) return;
  event.preventDefault();
  $('voice-ptt').setPointerCapture(event.pointerId);
  beginPtt(`pointer:${event.pointerId}`);
};
const releasePointer = event => { if (pttSource === `pointer:${event.pointerId}`) endPtt(); };
$('voice-ptt').onpointerup = releasePointer;
$('voice-ptt').onpointercancel = releasePointer;
$('voice-ptt').onlostpointercapture = releasePointer;
$('voice-ptt').oncontextmenu = event => event.preventDefault();
document.onkeydown = event => {
  if (event.target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
  if (event.code === 'Space' && pttSource === 'keyboard') { event.preventDefault(); return; }
  if (event.code !== 'Space' || event.repeat || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey ||
    $('voice-ptt').disabled || state?.voice?.mode !== 'ptt') return;
  event.preventDefault(); beginPtt('keyboard');
};
document.onkeyup = event => { if (event.code === 'Space' && pttSource === 'keyboard') { event.preventDefault(); endPtt(); } };
globalThis.onblur = () => endPtt(true);
globalThis.onpagehide = () => {dashboard?.destroy();workSurface.destroy();workbenchUI.destroy();audioCheck.stop();endPtt(true);void bailianVoice.stop();if(['connecting','connected'].includes(nativeVoice.status))void nativeVoice.stop();};
document.onvisibilitychange = () => { if (document.hidden) {endPtt(true);if(audioCheck.busy)audioCheck.stop();} };
$('voice-mode-select').onchange=async()=>{
  const picker=$('voice-mode-select');
  if(picker.disabled||voiceModePosting)return;
  voiceModePosting=true;
  picker.disabled=true;
  try{
    const value=await api('voice/mode',{mode:picker.value});
    if(state?.voice){state.voice.mode=value.mode;bailianVoice.sync(state.voice);}
    if(value.mode==='ptt'&&document.activeElement===picker)picker.blur();
    showError('');
  }catch(error){showError(error.message);}
  finally{voiceModePosting=false;render();}
};
$('voice-reading').onclick=()=>{
  if(!($('voice-reading').hidden||$('voice-reading').disabled))bailianVoice.setReading(!state.voice.readingEnabled);
};
$('voice-end').onclick=()=>{
  if(!($('voice-end').hidden||$('voice-end').disabled))void bailianVoice.stop();
};
$('voice-toggle').onclick = async () => {
  if (voiceStopping || (voicePosting && !state.voice?.enabled)) return;
  const managed=state.voice?.spokenModes;
  const enabled = !(managed?state.voice.inputEnabled:state.voice?.enabled), request = ++voiceRequest;
  if(managed&&!enabled){
    pttSource=null;
    bailianVoice.pauseInput();
    render();return;
  }
  if (!enabled) endPtt();
  voiceStopping = !enabled;
  voicePosting = true; showError(''); render();
  try { if(enabled)await bailianVoice.start();else {await bailianVoice.stop();await api('voice',{enabled:false});} }
  catch (error) { showError(error.message); }
  finally { if (request === voiceRequest) { voicePosting = false; voiceStopping = false; render(); } }
};
$('stop').onclick = async () => {
  if(stopPosting)return;stopPosting=true;render();
  endPtt(true);
  if(bailianVoice.pending)await bailianVoice.stop();
  try { await Promise.all([(['connecting','connected'].includes(nativeVoice.status)||['connecting','connected','unknown'].includes(state?.realtime?.status))?nativeVoice.stop():Promise.resolve(),api('stop')]); }
  catch (error) { showError(error.message); }
  finally { stopPosting=false;render(); }
};
$('composer').onsubmit = async event => {
  event.preventDefault();
  if ($('send').disabled || !$('input').value.trim()) return;
  if(grokBotSelected())return openGrokBot();
  const text = $('input').value;
  const result = await action($('multi-step').checked && !$('multi-step').disabled ? 'plan' : 'send', { text, agent:state.workbench?.agent, projectId:state.workbench?.projectId });
  if (result && $('input').value === text) $('input').value = '';
};
$('input').onkeydown = event => { if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); $('composer').requestSubmit(); } };
if (orbSim) {
  document.body.dataset.orbSim = orbSim;document.body.dataset.showAgent='false';
  const previewScene = new URLSearchParams(location.search).get('scene');
  if (previewScene==='city')orb.setScene?.('city');
  $('subtitle-user').textContent = '今天，帮我把想做的事理一理。';
  $('subtitle-assistant').textContent = '我在。我们从最重要的一件开始。';
  $('connection').textContent = '光球预览';
  // No EventSource, API calls, or automatic backend reconnect in simulation.
  for (const id of ['new', 'connect', 'windows-check','check-mic','check-speaker','voice-route','workbench-files']) $(id).disabled = true;
} else {
const events = new EventSource('/api/events');
events.addEventListener('voice-level', event => {
  const voice = JSON.parse(event.data);
  if (!state?.voice?.enabled || state.voice.state !== voice.state) return;
  Object.assign(state.voice, voice); updateOrb();
});
$('model-refresh').onclick=()=>void loadModels();
async function saveModelSelection(model,effort){
  modelPosting=true;const key=draftKey(state),selection=state.workbench;render();
  try{const value=await api('model',{model,effort,projectId:selection?.projectId,agent:selection?.agent});if(key===draftKey(state)){state.models=value;showError('');}}
  catch(error){if(key===draftKey(state)){showError(error.message);modelSignature=null;}}
  finally{modelPosting=false;render();}
}
$('model-select').onchange=()=>{
  if(!modelPosting&&!$('model-select').disabled)return saveModelSelection($('model-select').value);
};
$('effort-select').onchange=()=>{
  if(!modelPosting&&!$('effort-select').disabled)return saveModelSelection(state.models.selected,$('effort-select').value);
};
events.onmessage = event => {
  const previous=state;state=JSON.parse(event.data);csrf=state.csrf;streamOnline=true;
  if(previous?.needsResume&&!state.needsResume&&localError===previous.error)localError='';
  if(previous?.workbench?.projectId!==state.workbench?.projectId||previous?.workbench?.agent!==state.workbench?.agent){
    if(draftKey(previous)){workspaceDrafts.set(draftKey(previous),$('input').value);$('input').value=workspaceDrafts.get(draftKey(state))||'';}
    modelRequestEpoch++;modelsLoading=false;modelRequested=false;modelSignature='';previewSequence++;$('files-list').replaceChildren();$('file-preview').hidden=true;localError='';
  }else if(previous?.connection==='connected'&&state.connection!=='connected'){
    modelRequestEpoch++;modelsLoading=false;modelRequested=false;
  }
  nativeVoice.sync(state.realtime);bailianVoice.sync(state.voice);render();
  if(state.connection==='connected'&&!state.workbench?.switching&&!modelRequested){modelRequested=true;if(!state.connectionStages?.some(step=>step.stage==='models'))void loadModels();}
  const terminal=['completed','failed','interrupted'].includes(state.task.status);
  if(!previous || (terminal && (previous.task.turnId!==state.task.turnId || previous.task.status!==state.task.status))) void refreshFiles();
};
events.onerror = () => { streamOnline = false;endPtt();if(['connecting','connected'].includes(nativeVoice.status))void nativeVoice.stop();render(); };

}
