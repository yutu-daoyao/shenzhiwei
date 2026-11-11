import {renderReply} from './reply-view.js';

const tools={commandExecution:'运行命令',fileChange:'修改文件',webSearch:'搜索资料',mcpToolCall:'调用工具',dynamicToolCall:'调用工具'};
const steps={ok:'已完成',running:'进行中',pending:'待处理',failed:'失败',skipped:'已跳过'};
const activeStatuses=['starting','running','stopping','unknown'];

export function taskSurface(state={}) {
  const items=state.items||[],index=items.findLastIndex(item=>item.type==='userMessage');
  const user=items[index],plan=state.plan;
  const active=activeStatuses.includes(state.task?.status)||['planning','running'].includes(plan?.status);
  const turn=state.task?.turnId;
  const current=!user?.turnId||user.turnId===turn||!active&&!turn;
  const recent=current&&user?items.slice(index+1):items.filter(item=>turn&&item.turnId===turn);
  const events=recent.filter(item=>item.type==='tool').slice(-4).map(item=>({
    title:tools[item.tool]||'处理请求',
    detail:String(item.text||'').split('\n').find(Boolean)?.slice(0,160)||'',
  }));
  return {active,title:plan?.text||(current?user?.text:'')||'',steps:plan?.steps||[],events};
}

export function mountWorkSurface({document,fetch,token,openWorkspace}) {
  const $=id=>document.getElementById(id);
  const make=(tag,text,cls)=>{const node=document.createElement(tag);if(text)node.textContent=text;if(cls)node.className=cls;return node;};
  const controller=new AbortController();
  let signature='',wasActive=false,neededAttention=false,project,epoch=0;
  function showWorkbench(){
    $('weather-rail').hidden=true;
    $('workbench-rail').hidden=false;
  }
  function update(state){
    const task=taskSurface(state);
    const attention=!!(state.approvals?.length||state.computer?.approvals?.length||state.questions?.length);
    if(task.active&&!wasActive||attention&&!neededAttention)showWorkbench();
    wasActive=task.active;neededAttention=attention;
    $('project-preview-use').disabled=!!(task.active||state.locked||state.workbench?.switching||state.voice?.enabled||state.voice?.changing);
    const key=JSON.stringify(task);if(key===signature)return;signature=key;
    const heading=$('surface-title');
    heading.textContent=task.title.slice(0,180);heading.hidden=!task.title;
    const content=$('surface-content');content.replaceChildren();
    if(task.steps.length){
      const list=make('ol','','surface-steps');
      for(const step of task.steps){
        const row=make('li');row.dataset.status=step.status;
        row.append(make('span',steps[step.status]||'待处理'),make('strong',step.title));
        if(step.error)row.append(make('small',String(step.error).slice(0,160)));
        list.append(row);
      }
      content.append(list);
    }
    for(const event of task.events){
      const row=make('div','','surface-event');
      row.append(make('strong',event.title),make('p',event.detail));
      content.append(row);
    }
    if(!task.steps.length&&!task.events.length)
      content.append(make('p',task.active?'正在处理，进展会显示在这里。':task.title?'可在对话记录里查看回复。':'收到任务后，这里会显示执行进展。','surface-empty'));
  }
  function closeProject(){project=null;epoch++;$('project-preview').hidden=true;}
  $('project-preview-close').onclick=closeProject;
  $('project-preview-use').onclick=()=>{if(project&&!project.unscoped&&openWorkspace)openWorkspace(project);};
  async function openProject(selected){
    project=selected;const request=++epoch;showWorkbench();
    $('project-preview').hidden=false;
    $('project-preview-title').textContent=project.displayTitle||project.title;
    $('project-preview-path').textContent=project.cwd||'未记录工作目录';
    $('project-preview-use').hidden=!!project.unscoped;
    $('project-preview-use').textContent=project.conversation?'使用此任务的工作目录':'使用此项目';
    const detail=$('project-preview-detail');
    function show(text){renderReply(document,detail,text);}
    if(project.unscoped){show(project.scopeReason||'这条任务没有绑定本地目录。要开始新任务，请先选择项目或打开独立工作区。');return;}
    if(project.nativeProject||project.codexRoot&&!project.previewId){
      show(project.conversation?'这是该任务使用的工作目录。':'可将此目录作为所选 Agent 的工作项目。');return;
    }
    show('正在读取最近进展…');
    try{
      const query=new URLSearchParams({id:project.previewId||project.id});
      if(project.agent)query.set('agent',project.agent);
      const response=await fetch('/api/projects/read?'+query,{headers:{'X-Zhiwei-CSRF':token()},signal:controller.signal});
      const result=await response.json();
      if(request!==epoch)return;
      if(!response.ok)throw new Error(result.error||'暂时无法读取');
      const latest=result.messages?.findLast(message=>message.role==='assistant')?.text||result.messages?.at(-1)?.text;
      show(latest?.slice(0,1800)||'这个项目暂时没有可显示的进展。');
    }catch(error){if(request===epoch&&!controller.signal.aborted)show('读取失败：'+error.message);}
  }
  return {update,openProject,setAgent(agent){if(project?.agent&&project.agent!==agent)closeProject();},destroy(){epoch++;controller.abort();}};
}
