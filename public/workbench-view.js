import {projectDisplayTitle} from './dashboard.js';

export function mountWorkbench({document,fetch,api,onPrompt=()=>{},onFiles=()=>{},onError=()=>{},onSelection=()=>{},onGrokBot=()=>{},audioPending=()=>false}){
  const $=id=>document.getElementById(id),make=(tag,text,cls)=>{const node=document.createElement(tag);if(text)node.textContent=text;if(cls)node.className=cls;return node;};
  let state,csrf,signature='',projectSignature='',questionSignature='',changing=false,changeKey='',epoch=0,lastProject,lastAgent,lastSelection,catalog=[],catalogAgent;
  const controller=new AbortController();
  let projectFormMode='join';
  function projectForm(mode){
    projectFormMode=mode;
    const creating=mode==='create';
    $('project-add-toggle').textContent=creating?'＋ 新建项目':'＋ 加入本地项目';
    $('project-directory-label').hidden=creating;
    $('project-directory').hidden=creating;
    $('project-directory').required=!creating;
    $('project-name').required=creating;
    $('project-name-label').textContent=creating?'项目名称':'项目名称（可选）';
    $('project-add-submit').textContent=creating?'创建并打开':'加入并打开';
    $('project-add-status').textContent=creating?'为 '+($('workbench-agent').selectedOptions?.[0]?.textContent?.split(' · ')[0]||'所选 Agent')+' 创建本机项目目录。':'';
  }
  function openProjectForm(){
    if($('workbench-new-project').disabled)return;
    projectForm('create');
    $('project-add').open=true;
    $('project-name').focus?.();
  }
  function workspaceTitle(project,agent){
    return (catalogAgent===agent&&catalog.find(entry=>entry.registered&&entry.id===project.id)?.displayTitle)
      ||projectDisplayTitle(project)||'未命名工作区';
  }
  function renderProjects(wb,agent,preferred){
    const picker=$('workbench-project');
    const registered=wb.projects.filter(project=>project.agents?.includes(agent)??((project.agent||wb.agent)===agent));
    const native=catalogAgent===agent?catalog.filter(project=>!project.registered):[];
    const options=[...registered.map(project=>({id:project.id,title:workspaceTitle(project,agent)})),
      ...native.map(project=>({id:'catalog:'+project.id,title:(project.displayTitle||project.title)+(project.unscoped?' · 仅查看':''),disabled:project.unscoped}))];
    const key=JSON.stringify([agent,options,preferred]);if(key===projectSignature)return;projectSignature=key;
    picker.replaceChildren();
    const blank=make('option','请选择项目或任务');blank.value='';picker.append(blank);
    for(const project of options){const option=make('option',project.title);option.value=project.id;option.disabled=!!project.disabled;picker.append(option);}
    picker.value=options.some(project=>project.id===preferred)?preferred:'';
  }
  async function select(handoff=false){
    if(changing||audioPending()||!state?.workbench||$('workbench-agent').value==='grok-bot')return;
    const projectId=$('workbench-project').value,agent=$('workbench-agent').value;
    if(!projectId&&(handoff||agent==='codex'))return;
    const native=catalogAgent===agent&&catalog.find(project=>'catalog:'+project.id===projectId);
    if(native)return native.unscoped?undefined:addProject({cwd:native.cwd,name:native.displayTitle||native.title,agent});
    changing=true;update(state,csrf);
    $('model-select').disabled=true;
    $('effort-select').disabled=true;
    $('model-refresh').disabled=true;
    try{
      const result=projectId?await api('workbench/select',{projectId,agent,stopCurrent:handoff,handoff})
        :await api('workbench/open-agent',{agent});
      $('workbench-status').textContent=result?.error|| (handoff?'已准备交接材料，检查后再发送。':'已切换工作区。');
      if(result?.error)onError(result.error);
    }catch(error){onError(error.message);$('workbench-status').textContent=error.message;}
    finally{changing=false;if(state)update(state,csrf);}
  }
  async function addProject(project,create=false){
    if(changing||audioPending())return;changing=true;if(state)update(state,csrf);
    const agent=project.agent||$('workbench-agent').value;
    if(agent!==$('workbench-agent').value||agent==='grok-bot'){changing=false;if(state)update(state,csrf);return;}
    try{const result=await api(create?'workbench/project/new':'workbench/project',{...project,agent});const selection=await api('workbench/select',{projectId:result.id,agent});if(selection?.error)onError(selection.error);$('project-add').open=false;$('project-directory').value='';$('project-name').value='';projectForm('join');}
    catch(error){onError(error.message);$('project-add-status').textContent=error.message;}
    finally{changing=false;if(state)update(state,csrf);}
  }
  async function refreshChanges(){
    if(!csrf||!state?.workbench)return;const request=++epoch,projectId=state.workbench.projectId;
    $('changes-refresh').disabled=true;$('changes-status').textContent='正在读取实际文件状态…';
    try{const response=await fetch('/api/workbench/changes',{headers:{'X-Zhiwei-CSRF':csrf},signal:controller.signal});const value=await response.json();if(request!==epoch||projectId!==state?.workbench?.projectId)return;if(!response.ok)throw new Error(value.error||'无法读取改动');
      $('changes-status').textContent=value.note||'';$('changes-files').textContent=value.status;$('changes-diff').textContent=value.diff||'暂无可展示的文本差异。';$('changes-truncated').hidden=!value.truncated;
    }catch(error){if(request===epoch)$('changes-status').textContent=error.message;}
    finally{if(request===epoch)$('changes-refresh').disabled=false;}
  }
  function renderQuestions(){
    const questions=state.questions||[],key=JSON.stringify(questions);if(key===questionSignature)return;questionSignature=key;const target=$('agent-questions');target.replaceChildren();target.hidden=!questions.length;
    for(const request of questions){const form=make('form','','agent-question'),inputs=[];
      for(const question of request.questions){const section=make('fieldset'),legend=make('legend',question.question||question.header||'需要你补充');section.append(legend);const choices=[];
        for(const option of question.options||[]){const label=make('label'),input=make('input');input.type=question.multiple?'checkbox':'radio';input.name=request.id+'-'+inputs.length;input.value=option.label;label.append(input,make('span',option.label));if(option.description)label.append(make('small',option.description));section.append(label);choices.push(input);}
        const other=make('textarea');other.rows=2;other.maxLength=4000;other.setAttribute('aria-label',question.question||'补充回答');other.placeholder='也可以直接输入回答';section.append(other);inputs.push({choices,other});form.append(section);
      }
      const submit=make('button','回答并继续');submit.type='submit';const reject=make('button','取消问题');reject.type='button';form.append(submit,reject);
      form.onsubmit=async event=>{event.preventDefault();const answers=inputs.map(({choices,other})=>[...choices.filter(i=>i.checked).map(i=>i.value),...(other.value.trim()?[other.value.trim()]:[])]);if(answers.some(a=>!a.length)){onError('请先回答每个问题。');return;}submit.disabled=true;try{await api('workbench/question',{id:request.id,answers});}catch(error){onError(error.message);submit.disabled=false;}};
      reject.onclick=async()=>{reject.disabled=true;try{await api('workbench/question',{id:request.id,reject:true});}catch(error){onError(error.message);reject.disabled=false;}};target.append(form);
    }
  }
  function update(value,token){
    state=value;csrf=token;const wb=state.workbench;$('workbench-bar').hidden=!wb;if(!wb)return;
    const blocked=changing||state.desktop?.active||audioPending()||wb.switching||state.voice?.enabled||state.voice?.changing||['connecting','connected','stopping','unknown'].includes(state.realtime?.status);
    const key=JSON.stringify([wb.agent,wb.agents.map(a=>[a.id,a.detected])]);
    if(key!==signature){
      signature=key;
      const agentPicker=$('workbench-agent'),chosenAgent=wb.agent===lastAgent?agentPicker.value:wb.agent;
      agentPicker.replaceChildren();
      for(const agent of wb.agents){
        const available=agent.implemented||agent.external;
        const suffix=agent.detected===true?(available?' · 已检测到':' · 已检测到，尚未接入'):agent.detected===false?' · 未检测到':'';
        const option=make('option',agent.name+suffix);option.value=agent.id;option.disabled=!available;agentPicker.append(option);
      }
      agentPicker.value=wb.agents.some(a=>a.id===chosenAgent&&(a.implemented||a.external))?chosenAgent:wb.agent||'';
      lastAgent=wb.agent;
    }
    const chosenAgent=$('workbench-agent').value;
    const applied=wb.agent+':'+wb.projectId;
    const preferred=chosenAgent==='grok-bot'?'':lastSelection!==applied
      ? (chosenAgent===wb.agent?wb.projectId:wb.agentProjects?.[chosenAgent])
      : $('workbench-project').value;
    renderProjects(wb,chosenAgent,preferred);
    lastSelection=applied;
    const project=wb.projects.find(p=>p.id===wb.projectId),agent=wb.agents.find(a=>a.id===wb.agent);
    $('workbench-current').textContent=`${agent?.name||wb.agent} · ${({connected:'已连接',connecting:'正在连接',error:'连接异常',disconnected:'未连接'})[state.connection]||state.connection}`;
    $('active-project-name').textContent=project?workspaceTitle(project,wb.agent):'当前项目';$('active-project-path').textContent=project?.cwd||'';
    const model=state.models?.options?.find(option=>option.id===state.models.selected)?.name||state.models?.selected;
    const grokBot=$('workbench-agent').value==='grok-bot';
    const pending=chosenAgent!==wb.agent||$('workbench-project').value!==wb.projectId;
    const needsWorkspace=!$('workbench-project').value;
    const stageNode=$('connection-stages');
    const names={startup:'启动 Agent',login:'检查登录',models:'读取模型',session:'恢复会话'};
    const steps=state.connectionStages||[];
    const summary=steps.map(({stage,status,detail,elapsedMs})=>names[stage]+'：'+(status==='running'?'进行中…':status==='skipped'?'未执行':(status==='failed'?'失败 ':'')+(elapsedMs/1000).toFixed(3)+' 秒')+(detail?'（'+detail+'）':'')).join(' ｜ ');
    if(stageNode.textContent!==summary)stageNode.textContent=summary;
    stageNode.hidden=!summary;
    $('workbench-status').textContent=changing||wb.switching?'正在打开所选项目并连接 Agent…':blocked?'语音中可直接说「切换到 WorkBuddy」。手动选择需结束语音。':grokBot?'在文字框写好任务后，复制并打开 Grok Bot，在桌面端选择 Bot 并发送。':pending?(needsWorkspace?'可选择已有任务，或先打开该 Agent 的独立工作区。':'所选项目尚未打开。'):wb.error||(state.connection==='error'&&state.error)||`对话和任务由 ${agent?.name||wb.agent} 处理${model?' · '+model:''}`;
    for(const id of ['workbench-project','workbench-agent','workbench-apply','workbench-handoff','project-add-submit'])$(id).disabled=!!blocked;
    $('workbench-new-project').disabled=$('conversation-new-project').disabled=!!blocked||grokBot||state.locked||['starting','running','stopping','unknown'].includes(state.task?.status);
    $('workbench-apply').disabled=blocked||chosenAgent==='codex'&&needsWorkspace;
    $('workbench-handoff').disabled=blocked||grokBot||!state.currentId||$('workbench-project').value!==wb.projectId;
    $('workbench-apply').textContent=changing||wb.switching?'切换中…':grokBot?'打开 Grok Bot':needsWorkspace?'连接并打开独立工作区':!pending&&state.connection!=='connected'?'重新连接':'打开所选项目';
    $('handoff-panel').hidden=!wb.handoff||wb.handoff.projectId!==wb.projectId;$('handoff-text').textContent=wb.handoff?.text||'';
    $('handoff-use').disabled=blocked||!wb.handoff||wb.handoff.to!==wb.agent||wb.handoff.projectId!==wb.projectId;
    renderQuestions();
    const terminal=['completed','failed','interrupted','idle'].includes(state.task?.status);
    const nextKey=wb.projectId+':'+(terminal?state.task?.turnId||'idle':'running');
    if(lastProject!==wb.projectId){lastProject=wb.projectId;epoch++;$('changes-files').textContent='';$('changes-diff').textContent='';}
    if(nextKey!==changeKey&&terminal){changeKey=nextKey;void refreshChanges();}
  }
  $('agent-detect').onclick=async()=>{
    const button=$('agent-detect');if(button.disabled)return;button.disabled=true;button.textContent='正在检测…';
    try{
      const result=await api('workbench/agents/scan',{});
      button.textContent=`检测本机 Agent（${result.agents.filter(a=>a.detected).length}）`;
    }catch(error){onError(error.message);button.textContent='重新检测本机 Agent';}
    finally{button.disabled=false;}
  };
  $('workbench-apply').onclick=()=>void ($('workbench-agent').value==='grok-bot'?onGrokBot():select(false));$('workbench-handoff').onclick=()=>void select(true);
  function openSelectedWhenIdle(){
    const agent=$('workbench-agent').value,project=$('workbench-project').value,wb=state?.workbench;
    if(!wb||!project||agent==='grok-bot'||$('workbench-apply').disabled||(agent===wb.agent&&project===wb.projectId))return;
    if(state.locked||['starting','running','stopping','unknown'].includes(state.task?.status)||['planning','running','stopping'].includes(state.plan?.status)){
      $('workbench-status').textContent='任务结束后可打开所选项目，或先准备交接。';
      return;
    }
    void select(false);
  }
  $('workbench-agent').onchange=()=>{
    const agent=$('workbench-agent').value,wb=state?.workbench;if(!wb)return;
    renderProjects(wb,agent,agent===wb.agent?wb.projectId:wb.agentProjects?.[agent]);
    update(state,csrf);
    onSelection();
    openSelectedWhenIdle();
  };
  $('workbench-project').onchange=()=>{if(state)update(state,csrf);onSelection();openSelectedWhenIdle();};
  $('workbench-new-project').onclick=openProjectForm;
  $('project-add-toggle').onclick=()=>{if(!$('project-add').open)projectForm('join');};
  $('project-add-form').onsubmit=event=>{
    event.preventDefault();
    const name=$('project-name').value;
    if(projectFormMode==='create')void addProject({name},true);
    else void addProject({cwd:$('project-directory').value,name});
  };
  $('changes-refresh').onclick=()=>void refreshChanges();$('workbench-files').onclick=onFiles;
  $('handoff-use').onclick=()=>{const packet=state?.workbench?.handoff;if(packet)onPrompt(packet.text+'\n\n我现在的具体要求：');};
  $('show-weather').onclick=()=>{$('workbench-rail').hidden=true;$('weather-rail').hidden=false;};
  $('show-work').onclick=()=>{$('workbench-rail').hidden=false;$('weather-rail').hidden=true;};
  return {update,addProject,openProjectForm,setCatalog(projects,agent){catalog=projects;catalogAgent=agent;if(state)update(state,csrf);},destroy(){epoch++;controller.abort();}};
}
