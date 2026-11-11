export function weatherLabel(code){if(code===0)return '晴';if([1,2].includes(code))return '晴间多云';if(code===3)return '多云';if([45,48].includes(code))return '雾';if([51,53,55,56,57].includes(code))return '细雨';if([61,63,65,66,67,80,81,82].includes(code))return '有雨';if([71,73,75,77,85,86].includes(code))return '有雪';if([95,96,99].includes(code))return '雷雨';return '天气待更新';}
const unit=(value,suffix='')=>Number.isFinite(value)?Math.round(value)+suffix:'—';
const symbol=code=>code===0?'☀':[71,73,75,77,85,86].includes(code)?'❄':[51,53,55,61,63,65,80,81,82,95,96,99].includes(code)?'☂':'☁';
function weatherArtwork(code,night){
  const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" aria-hidden="true">';
  if(code===0&&night)return svg+'<defs><radialGradient id="moon-surface" cx=".30" cy=".30"><stop stop-color="#fff4da"/><stop offset=".55" stop-color="#ead1a9"/><stop offset="1" stop-color="#92775a"/></radialGradient><radialGradient id="moon-aura"><stop stop-color="#f5d7a6" stop-opacity=".25"/><stop offset="1" stop-color="#f5d7a6" stop-opacity="0"/></radialGradient><mask id="moon-cut"><rect width="100" height="100" fill="white"/><circle cx="66" cy="32" r="33" fill="black"/></mask></defs><circle cx="46" cy="51" r="48" fill="url(#moon-aura)"/><g mask="url(#moon-cut)"><circle cx="47" cy="49" r="33" fill="url(#moon-surface)"/><g fill="#a68b69" opacity=".25"><circle cx="26" cy="45" r="6"/><circle cx="38" cy="65" r="8"/><circle cx="35" cy="28" r="4"/><circle cx="55" cy="73" r="4"/><circle cx="23" cy="58" r="3"/></g><path d="M42 17a33 33 0 1 0 31 50" fill="none" stroke="#fff0ce" stroke-width="1" opacity=".8"/></g></svg>';
  if(code===0)return svg+'<g fill="none" stroke="#e6c287" stroke-width="2"><circle cx="50" cy="50" r="17"/><path d="M50 13v12m0 50v12M13 50h12m50 0h12M24 24l9 9m34 34 9 9M24 76l9-9m34-34 9-9"/></g></svg>';
  return svg+'<path d="M25 67h48c22-1 22-30 3-31-7-27-44-23-48 3-24-1-26 28-3 28Z" fill="#7898b22e" stroke="#c8d8e5" stroke-width="2"/>'+([51,53,55,61,63,65,80,81,82,95,96,99].includes(code)?'<path d="m34 75-5 12m23-12-5 12m23-12-5 12" stroke="#c1d5e5" stroke-width="2"/>':'')+'</svg>';
}
const pathKey=cwd=>cwd.replace(/\\/g,'/').replace(/\/+$/,'').toLocaleLowerCase();
const han=/\p{Script=Han}/u;
export function projectDisplayTitle(project){
  const raw=String(project.title??project.name??'').trim();
  const title=raw.split(/\r?\n/,1)[0].trim();
  const folder=project.cwd?.split(/[\\/]/).filter(Boolean).at(-1);
  if(!title||/^(?:[<#]|[a-z]:[\\/])/i.test(title)||/^\d{4}-\d{2}-\d{2}(?:[-_T ]\d{2}(?:[-:]\d{2}){1,2})?$/.test(title))return '';
  if(/^(?:新(?:建)?对话|未命名(?:工作区|会话|任务)?|new (?:chat|task|session)|untitled)[。.]?$/i.test(title))return '';
  if(title.toLocaleLowerCase()===folder?.toLocaleLowerCase()&&!han.test(title)&&!project.codexRoot)return '';
  if(project.titleSource==='preview'&&(!han.test(title)||title.length>100))return '';
  return title.length>82?title.slice(0,81)+'…':title;
}
function time(value){
  if(typeof value==='number')return Number.isFinite(value)?value:0;
  return Date.parse(value)||0;
}
const recentFirst=(a,b)=>Number(!!b.pinned)-Number(!!a.pinned)||
  (a.pinOrder??Infinity)-(b.pinOrder??Infinity)||time(b.updatedAt)-time(a.updatedAt);
export function groupProjects(threads){
  const workspaces=new Map(),tasks=[];
  for(const entry of threads){
    if(!entry.cwd&&!entry.unscoped||/[\\/]\.codex[\\/]plugins|[\\/]AppData[\\/]Local[\\/]Temp/i.test(entry.cwd))continue;
    const key=entry.cwd?pathKey(entry.cwd):entry.id,displayTitle=projectDisplayTitle(entry);
    if(entry.conversation){
      if(displayTitle)tasks.push({...entry,displayTitle,...(!entry.nativeProject?{previewId:entry.id}:{})});
    }else{
      const previous=workspaces.get(key);
      if(!previous||entry.registered&&!previous.registered)workspaces.set(key,{...entry,displayTitle});
    }
  }
  tasks.sort(recentFirst);
  const firstTask=new Map(),taskLabels=new Map();
  for(const task of tasks){
    const key=task.cwd?pathKey(task.cwd):task.id,unique=key+'\n'+task.displayTitle;
    if(taskLabels.has(unique))continue;
    taskLabels.set(unique,task);
    if(!firstTask.has(key))firstTask.set(key,task);
  }
  const entries=[];
  for(const [key,workspace] of workspaces){
    const task=workspace.displayTitle?taskLabels.get(key+'\n'+workspace.displayTitle):firstTask.get(key);
    if(task&&(workspace.displayTitle||workspace.registered)){
      entries.push({...workspace,displayTitle:task.displayTitle,previewId:task.previewId,
        conversation:true,nativeProject:task.nativeProject,updatedAt:task.updatedAt,pinned:task.pinned,pinOrder:task.pinOrder});
    }else if(workspace.displayTitle||workspace.registered){
      entries.push({...workspace,displayTitle:workspace.displayTitle||'未命名工作区'});
    }
  }
  const workspaceLabels=new Set(entries.map(entry=>pathKey(entry.cwd)+'\n'+entry.displayTitle));
  return [...entries,...[...taskLabels].filter(([key])=>!workspaceLabels.has(key)).map(([,task])=>task)].sort(recentFirst);
}
export function mountDashboard({document,fetch,token,openProject,openProjects,onProjects=()=>{},geolocation=globalThis.navigator?.geolocation,permissions=globalThis.navigator?.permissions,setTimer=globalThis.setInterval,clearTimer=globalThis.clearInterval}={}){
  const $=id=>document.getElementById(id),node=(tag,text,cls)=>{const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;};
  let projects=[],activeProjectId=null,projectSource='',catalogAgent,appliedAgent,codexStatus='',directoryStatus='',truncated=false,started=false,disposed=false,weatherTimer,projectTimer,projectsBusy=false,weatherBusy=false,projectsRequested=false,coordinates=null,locating=false,locationNote='默认城市 · 可使用电脑定位';
  const controller=new AbortController();
  async function request(path){const r=await fetch(path,{headers:{'X-Zhiwei-CSRF':token()},signal:controller.signal});const value=await r.json();if(!r.ok)throw new Error(value.error||'暂时无法读取');return value;}
  function renderProjects(){
    const query=$('home-project-search').value.toLocaleLowerCase().trim();const visible=projects.filter(p=>(p.title+' '+p.displayTitle+' '+p.cwd).toLocaleLowerCase().includes(query)).sort((a,b)=>Number(b.id===activeProjectId)-Number(a.id===activeProjectId));$('home-projects').replaceChildren();
    for(const project of visible){const button=node('button','','project-tile');button.type='button';button.title=project.displayTitle;const active=project.id===activeProjectId;if(active)button.setAttribute('aria-current','true');button.append(node('span',project.displayTitle,'project-tile-name'),node('small',active?'当前工作项目':project.unscoped?'仅查看标题':project.pinned?'置顶任务':project.conversation?'最近任务':project.registered?'已加入工作台':'工作区','project-tile-count'));button.onclick=()=>openProject(project);$('home-projects').append(button);}
    $('home-project-status').textContent=(visible.length?`${visible.length} 个项目与任务`:(query?'没有匹配的项目或任务。':'暂无已命名的项目或任务。'))+(directoryStatus==='manual'?' · 当前只显示手动加入的项目':directoryStatus==='failed'?' · Agent 任务读取失败':codexStatus==='failed'?' · Codex 任务读取失败':codexStatus==='unavailable'?' · Codex 待连接':codexStatus==='partial'?' · 部分 Codex 项目暂不可用':truncated?' · 仅显示最近任务':'');
  }
  async function loadProjects(){
    if(projectsBusy||!token()||disposed)return;
    const source=projectSource,agent=catalogAgent;
    if(agent==='grok-bot'){renderProjects();return;}
    projectsBusy=true;$('home-projects-refresh').disabled=true;$('home-project-status').textContent='正在读取项目目录…';
    try{
      const suffix=agent&&agent!==appliedAgent?'?'+new URLSearchParams({agent}):'';
      const value=await request('/api/projects'+suffix);if(disposed||source!==projectSource||value.agent&&value.agent!==agent)return;
      projects=groupProjects(value.threads||[]);codexStatus=value.codexStatus;directoryStatus=value.directoryStatus;truncated=value.truncated;
      onProjects(projects,agent);renderProjects();
    }catch(e){if(!disposed&&source===projectSource)$('home-project-status').textContent='项目暂不可用，可点击刷新重试。';}
    finally{projectsBusy=false;$('home-projects-refresh').disabled=false;if(!disposed&&source!==projectSource){projectsRequested=true;void loadProjects();}}
  }
  async function loadWeather(){if(weatherBusy||!token()||disposed)return;const point=coordinates;weatherBusy=true;$('weather-refresh').disabled=true;$('weather-status').textContent='正在更新天气…';try{const suffix=point?'?'+new URLSearchParams(point):'';const value=await request('/api/weather'+suffix);if(disposed||point!==coordinates)return;const w=value.current;$('weather-city').textContent=value.city;$('weather-temperature').textContent=unit(w.temperature,'°');$('weather-description').textContent=weatherLabel(w.code);$('weather-symbol').innerHTML=weatherArtwork(w.code,!w.isDay);$('weather-symbol').dataset.weather=String(w.code);$('weather-feels').textContent=unit(w.feelsLike,'°');$('weather-humidity').textContent=unit(w.humidity,'%');$('weather-wind').textContent=unit(w.wind,' km/h');$('weather-days').replaceChildren();
      for(const [i,day] of value.days.entries()){const row=node('div','','forecast-row');const date=new Date(day.date+'T12:00:00Z');row.append(node('span',i===0?'今天':date.toLocaleDateString('zh-CN',{weekday:'short',timeZone:'UTC'})),node('span',symbol(day.code)+' '+weatherLabel(day.code),'forecast-condition'),node('strong',unit(day.low,'°')+' / '+unit(day.high,'°')));$('weather-days').append(row);}
      $('weather-status').textContent=(value.stale?'网络暂不可用 · 显示缓存预报':'更新于 '+new Date(value.fetchedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',timeZone:value.timezone||'Asia/Shanghai'}))+(point?' · 电脑定位':' · 默认城市');
    }catch(e){if(!disposed&&point===coordinates){$('weather-status').textContent='天气暂不可用，点击刷新重试。';$('weather-description').textContent='预报暂未更新';}}finally{weatherBusy=false;$('weather-refresh').disabled=false;if(!disposed&&point!==coordinates)void loadWeather();}}
  async function locate(){
    if(locating||disposed)return;
    if(!geolocation){$('weather-location-status').textContent='此浏览器不支持定位 · 使用默认城市';return;}
    locating=true;$('weather-locate').disabled=true;$('weather-location-status').textContent='正在获取电脑位置…';
    try{const position=await new Promise((resolve,reject)=>geolocation.getCurrentPosition(resolve,reject,{enableHighAccuracy:false,timeout:12000,maximumAge:300000}));if(disposed)return;
      coordinates={latitude:Math.round(position.coords.latitude*100)/100,longitude:Math.round(position.coords.longitude*100)/100};
      locationNote='电脑定位 · 天气每 15 分钟更新';$('weather-locate').textContent='重新定位';
    }catch(error){if(disposed)return;coordinates=null;locationNote=(error.code===1?'定位权限未开启':error.code===3?'定位超时':'暂时无法定位')+' · 使用默认城市';}
    finally{locating=false;if(!disposed){$('weather-locate').disabled=false;$('weather-location-status').textContent=locationNote;$('weather-city').textContent=coordinates?'当前位置':'烟台 · 莱山';for(const id of ['weather-temperature','weather-feels','weather-humidity','weather-wind'])$(id).textContent='—';$('weather-description').textContent='正在更新天气';$('weather-days').replaceChildren();void loadWeather();}}
  }
  $('weather-locate').onclick=()=>void locate();
  $('home-project-search').oninput=renderProjects;$('home-projects-refresh').onclick=()=>void loadProjects();$('home-project-more').onclick=openProjects;$('weather-refresh').onclick=()=>void loadWeather();
  return {update(state,agent=state.workbench?.agent){
    appliedAgent=state.workbench?.agent;
    const active=agent===appliedAgent?state.workbench?.projectId:null;
    if(catalogAgent!==agent){catalogAgent=agent;projects=[];codexStatus=directoryStatus='';truncated=false;onProjects(projects,agent);renderProjects();}
    if(active!==activeProjectId){activeProjectId=active;renderProjects();}
    const source=JSON.stringify([agent,appliedAgent,state.connection,state.workbench?.projects?.map(p=>[p.id,p.agents])]);if(projectSource!==source){projectSource=source;projectsRequested=false;}
    if(!started&&token()){started=true;void loadWeather();weatherTimer=setTimer(()=>void(coordinates?locate():loadWeather()),900000);projectTimer=setTimer(()=>void loadProjects(),60000);void permissions?.query({name:'geolocation'}).then(p=>{if(p.state==='granted'&&!disposed)void locate();}).catch(()=>{});}
    if(token()&&!projectsBusy&&!projectsRequested){projectsRequested=true;void loadProjects();}
  },destroy(){disposed=true;controller.abort();clearTimer(weatherTimer);clearTimer(projectTimer);}};
}
