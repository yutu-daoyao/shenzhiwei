import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {renderReply} from '../public/reply-view.js';
import {mountWorkSurface,taskSurface} from '../public/work-surface.js';
import {mountDashboard,groupProjects} from '../public/dashboard.js';
import {mountWorkbench} from '../public/workbench-view.js';
import {WeatherForecast,weatherLocation} from '../src/server/weather.js';
import {speechText} from '../src/voice/speech-text.js';
import {VoicePipeline} from '../src/voice/pipeline.js';
import {FakeASR,FakeTTS,FakeVAD} from '../src/voice/fake.js';

function fakeDocument(){
  const nodes=new Map();
  function createElement(tagName='div'){
    let value='';return {tagName:tagName.toUpperCase(),dataset:{},children:[],value:'',hidden:false,
      get textContent(){return value+this.children.map(c=>c.textContent).join('');},set textContent(v){value=String(v);this.children=[];},
      append(...children){this.children.push(...children);},replaceChildren(...children){value='';this.children=children;},setAttribute(k,v){this[k]=v;},removeAttribute(k){delete this[k];}};
  }
  return {createElement,createTextNode:text=>({textContent:text}),getElementById(id){if(!nodes.has(id))nodes.set(id,createElement());return nodes.get(id);}};
}
const projects=Array.from({length:12},(_,i)=>({id:String(i),title:`项目 ${i}`,displayTitle:`项目 ${i}`,cwd:`D:/projects/p${i}`,count:i+1,updatedAt:i}));
test('changing the Agent connects it immediately while idle and blocks the previous model picker',async()=>{
  const document=fakeDocument(),requests=[];
  const $=id=>document.getElementById(id);
  const ui=mountWorkbench({document,api:async(route,body)=>{requests.push({route,body});return {connected:true};},fetch:async()=>({ok:true,json:async()=>({})})});
  const wb={projectId:'p',agent:'codex',agentProjects:{codex:'p',hermes:'h'},projects:[{id:'p',name:'Codex 项目',agents:['codex']},{id:'h',name:'Hermes 项目',agents:['hermes']}],agents:[{id:'codex',name:'Codex',implemented:true},{id:'hermes',name:'Hermes Agent',implemented:true}]};
  ui.update({workbench:wb,task:{status:'idle'},connection:'connected'},'token');
  $('workbench-agent').value='hermes';$('workbench-agent').onchange();
  assert.equal($('model-select').disabled,true);
  await tick();
  assert.deepEqual(requests,[{route:'workbench/select',body:{projectId:'h',agent:'hermes',stopCurrent:false,handoff:false}}]);
  ui.update({workbench:wb,task:{status:'running'},connection:'connected'},'token');
  $('workbench-agent').value='hermes';$('workbench-agent').onchange();
  assert.equal(requests.length,1);ui.destroy();
});
test('a new WorkBuddy selection waits for a WorkBuddy directory before opening an executor',async()=>{
  const document=fakeDocument(),requests=[],$=id=>document.getElementById(id);
  const ui=mountWorkbench({document,api:async(route,body)=>{requests.push({route,body});return {id:'office'};},fetch:async()=>({ok:true,json:async()=>({})})});
  const workbench={projectId:'main',agent:'codex',agentProjects:{codex:'main'},
    projects:[{id:'main',name:'知微 · 主工程',agents:['codex']}],
    agents:[{id:'codex',name:'Codex',implemented:true},{id:'workbuddy',name:'WorkBuddy',implemented:true}]};
  ui.update({workbench,task:{status:'idle'},connection:'connected'},'token');
  $('workbench-agent').value='workbuddy';$('workbench-agent').onchange();
  assert.equal($('workbench-project').value,'');
  assert.equal($('workbench-apply').disabled,false);
  assert.equal($('workbench-apply').textContent,'连接并打开独立工作区');
  assert.equal(requests.length,0);
  ui.setCatalog([{id:'office-task',cwd:'D:/办公文档',title:'办公文档',agent:'workbuddy'}],'workbuddy');
  assert.doesNotMatch($('workbench-project').textContent,/知微/);
  ui.update({workbench,task:{status:'running'},connection:'connected'},'token');
  $('workbench-project').value='catalog:office-task';
  $('workbench-project').onchange();
  assert.equal(requests.length,0);
  ui.update({workbench,task:{status:'idle'},connection:'connected'},'token');
  $('workbench-project').onchange();await tick();
  assert.deepEqual(requests,[
    {route:'workbench/project',body:{cwd:'D:/办公文档',name:'办公文档',agent:'workbuddy'}},
    {route:'workbench/select',body:{projectId:'office',agent:'workbuddy'}},
  ]);
  ui.destroy();
});
test('an Agent without a selected project opens an independent workspace only when asked',async()=>{
  const document=fakeDocument(),requests=[],$=id=>document.getElementById(id);
  const ui=mountWorkbench({document,api:async(route,body)=>{requests.push({route,body});return {connected:true};},fetch:async()=>({ok:true,json:async()=>({})})});
  const workbench={projectId:'main',agent:'codex',projects:[{id:'main',name:'知微 · 主工程',agents:['codex']}],
    agents:[{id:'codex',name:'Codex',implemented:true},{id:'hermes',name:'Hermes',implemented:true}]};
  ui.update({workbench,task:{status:'idle'},connection:'connected'},'token');
  $('workbench-agent').value='hermes';$('workbench-agent').onchange();
  ui.setCatalog([{id:'history',title:'Hermes 旧任务',unscoped:true}],'hermes');
  assert.equal($('workbench-project').children[1].disabled,true);
  assert.equal(requests.length,0);
  $('workbench-apply').onclick();await tick();
  assert.deepEqual(requests,[{route:'workbench/open-agent',body:{agent:'hermes'}}]);
  ui.destroy();
});
test('a WorkBuddy workspace named after its folder shows the native task title in both controls',()=>{
  const document=fakeDocument(),$=id=>document.getElementById(id);
  const ui=mountWorkbench({document,fetch:async()=>({ok:true,json:async()=>({})})});
  const stamp='2026-11-05-17-56-08',cwd='D:/WorkBuddy/'+stamp;
  const workbench={projectId:'office',agent:'workbuddy',projects:[{id:'office',name:stamp,cwd,agents:['workbuddy']}],
    agents:[{id:'workbuddy',name:'WorkBuddy',implemented:true}]};
  ui.update({workbench,task:{status:'idle'},connection:'connected'},'token');
  ui.setCatalog(groupProjects([
    {id:'office',title:stamp,cwd,registered:true},
    {id:'task',title:'整理视频口播稿和资料',cwd,conversation:true,nativeProject:true},
  ]),'workbuddy');
  assert.equal($('workbench-project').value,'office');
  assert.match($('workbench-project').textContent,/整理视频口播稿和资料/);
  assert.doesNotMatch($('workbench-project').textContent,/2026-11-05/);
  assert.equal($('active-project-name').textContent,'整理视频口播稿和资料');
  assert.equal($('active-project-path').textContent,cwd);
  ui.destroy();
});
test('reply renders paragraphs, lists, code and safe links without treating model HTML as markup',()=>{
  const document=fakeDocument(),node=document.createElement('div');
  renderReply(document,node,'## 查找结果\n\n这是 **Mika**。\n\n- [开源项目](https://github.com/wangzan101/Mika)\n- `npm start`\n\n<img src=x onerror=alert(1)>\nhttps://example.com/long/path\nhttp://?');
  const all=n=>[n,...n.children?.flatMap(all)||[]],flat=all(node),anchors=flat.filter(n=>n.tagName==='A');
  assert.equal(anchors.length,2);assert.equal(anchors[0].textContent,'开源项目');assert.equal(anchors[0].href,'https://github.com/wangzan101/Mika');
  assert.equal(anchors[1].textContent,'example.com ↗');assert.ok(flat.some(n=>n.tagName==='STRONG'&&n.textContent==='Mika'));
  assert.ok(node.textContent.includes('<img'));assert.ok(!flat.some(n=>n.tagName==='IMG'));assert.equal(node.children.filter(n=>n.tagName==='UL').length,1);
  renderReply(document,node,'[记录](C:/work/notes.md) [点击](javascript:alert(1))\n\n| 项目 | 进展 |\n| --- | --- |\n| A | 完成 |');
  assert.doesNotMatch(node.textContent,/C:\/|javascript|\[记录\]/);assert.equal(all(node).filter(n=>n.tagName==='TH').length,2);assert.equal(all(node).filter(n=>n.tagName==='TD').length,2);
});
test('right rail keeps execution and project previews separate and ignores obsolete reads',async()=>{
  const document=fakeDocument(),pending=[];
  const surface=mountWorkSurface({document,token:()=> 'token',fetch:()=>new Promise(resolve=>pending.push(resolve))});
  const $=id=>document.getElementById(id);
  const first=surface.openProject(projects[0]),second=surface.openProject(projects[1]);
  pending[1]({ok:true,json:async()=>({messages:[{role:'assistant',text:'最新进展'}]})});await second;
  pending[0]({ok:true,json:async()=>({messages:[{role:'assistant',text:'过时进展'}]})});await first;
  assert.match($('project-preview-detail').textContent,/最新进展/);assert.doesNotMatch($('project-preview-detail').textContent,/过时进展/);
  $('workbench-rail').hidden=true;$('weather-rail').hidden=false;
  surface.update({currentId:'new',task:{status:'running'},plan:{steps:[{title:'检查页面',status:'running'}]},items:[{id:'u1',type:'userMessage',text:'更新网站'},{type:'tool',tool:'fileChange',text:'app.js'}]});
  assert.equal($('workbench-rail').hidden,false);assert.equal($('weather-rail').hidden,true);
  assert.equal($('orb-stage').dataset.surface,undefined);
  assert.match($('project-preview-detail').textContent,/最新进展/);
  assert.match($('surface-content').textContent,/检查页面/);assert.match($('surface-content').textContent,/app.js/);
  $('project-preview-close').onclick();assert.equal($('project-preview').hidden,true);
  assert.match($('surface-content').textContent,/检查页面/);
  assert.equal(groupProjects(projects)[0].id,'11');surface.destroy();
});
test('task surface uses only events following the latest request and exposes real plan steps',()=>{
  const state={task:{status:'running'},plan:{steps:[{title:'读取当前仓库',status:'running'}]},items:[{type:'userMessage',text:'旧任务'},{type:'tool',text:'旧事件'},{type:'userMessage',text:'改项目'},{type:'tool',tool:'fileChange',text:'app.js'},{type:'agentMessage',text:'正在修改'}]};
  const value=taskSurface(state);assert.equal(value.active,true);assert.equal(value.events.length,1);assert.equal(value.events[0].title,'修改文件');assert.equal(value.steps[0].title,'读取当前仓库');
});
const fixture={current:{temperature_2m:14,weather_code:0,is_day:1},daily:{time:['2026-11-06']}};
test('weather validates and rounds coordinates, separates caches and never uses another location on outage',async()=>{
  for(const pair of [['','1'],['NaN','1'],['91','1'],['1',null],['1','181']])assert.throws(()=>weatherLocation(...pair),/坐标/);
  const urls=[];let fail=false;const weather=new WeatherForecast({fetcher:async u=>{urls.push(u);if(fail)throw Error('offline');return {ok:true,json:async()=>fixture};}});
  const a=weatherLocation('31.23456','121.47123'),b=weatherLocation('22.5','114');
  assert.equal(a.latitude,31.23);assert.equal(a.longitude,121.47);
  await Promise.all([weather.read(a),weather.read(a),weather.read(b)]);assert.equal(urls.length,2);assert.equal(urls[0].searchParams.get('timezone'),'auto');
  fail=true;await assert.rejects(weather.read(weatherLocation('40','116')),/无法更新/);
});
test('project previews and refresh keep the explicitly selected tile pinned',async()=>{
  const document=fakeDocument(),opened=[];
  const [testProject,pinned]=[
    {id:'default',title:'测试工作区',cwd:'D:/test',registered:true},
    {id:'main',title:'主工程',cwd:'D:/main',registered:true},
  ];
  let list=[testProject,pinned];
  const dashboard=mountDashboard({document,token:()=> 'token',openProject:item=>opened.push(item.id),
    openProjects(){},permissions:null,setTimer:()=>0,clearTimer(){},
    fetch:async url=>({ok:true,json:async()=>url==='/api/projects'?{threads:list,codexStatus:'ready'}:{city:'测试',current:{},days:[]}})});
  dashboard.update({connection:'connected',workbench:{agent:'codex',projectId:'main',projects:list}});
  await tick();
  const rail=document.getElementById('home-projects');
  assert.match(rail.children[0].textContent,/主工程[\s\S]*当前工作项目/);
  rail.children[1].onclick();assert.deepEqual(opened,['default']);
  assert.equal(rail.children[0]['aria-current'],'true');
  list=[...list,{id:'native',title:'Codex 项目',cwd:'D:/native',codexRoot:true}];
  document.getElementById('home-projects-refresh').onclick();await tick();
  assert.equal(rail.children[0]['aria-current'],'true');
  assert.equal(rail.children.filter(item=>item['aria-current']==='true').length,1);
  assert.equal(rail.children.length,3);
  dashboard.destroy();
});
test('dashboard requests location only on action or existing grant, shows permission failure and loads rounded local weather',async()=>{
  const document=fakeDocument(),paths=[],timers=[];let allow=false,calls=0;
  const dashboard=mountDashboard({document,token:()=> 'token',openProject(){},openProjects(){},permissions:{query:async()=>({state:'prompt'})},geolocation:{getCurrentPosition(ok,bad){calls++;if(allow)ok({coords:{latitude:31.234567,longitude:121.471234}});else bad({code:1});}},setTimer:(fn)=>{timers.push(fn);return timers.length;},clearTimer(){},fetch:async path=>{paths.push(path);return {ok:true,json:async()=>path.startsWith('/api/projects')?{threads:projects}:{city:path.includes('?')?'当前位置':'烟台 · 莱山',current:{temperature:14,code:0,isDay:1},days:[],fetchedAt:0}};}});
  dashboard.update({connection:'connected'});await tick();assert.equal(calls,0);assert.equal(document.getElementById('home-projects').children.length,12);
  document.getElementById('weather-locate').onclick();await tick();assert.match(document.getElementById('weather-location-status').textContent,/权限未开启/);
  allow=true;document.getElementById('weather-locate').onclick();await tick();assert.ok(paths.includes('/api/weather?latitude=31.23&longitude=121.47'));assert.equal(document.getElementById('weather-city').textContent,'当前位置');
  dashboard.destroy();const count=paths.length;for(const fn of timers)fn();await tick();assert.equal(paths.length,count);
});
test('actual synthesis receives the link label and never receives URLs or Markdown markers',async()=>{
  const tts=new FakeTTS(),received=[],original=tts.synthesize.bind(tts);tts.synthesize=(text,options)=>{received.push(text);return original(text,options);};
  const pipeline=new VoicePipeline({asr:new FakeASR(),tts,vad:new FakeVAD()});
  await pipeline.say('看 **Mika**：[项目](https://github.com/wangzan101/Mika)。');
  await pipeline.say('https://example.com/very-long?q=x');
  assert.deepEqual(received,['看 Mika：项目。']);assert.equal(speechText('官网 www.example.com/path'),'官网');pipeline.close();
});
