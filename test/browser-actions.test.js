import { sceneForState } from '../public/task-scene.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { setImmediate as tick } from 'node:timers/promises';
import { approvalView } from '../public/approval-view.js';
import { simulationMode } from '../public/orb.js';

async function page({ render = false, search = '', savedSync = null } = {}) {
  const nodes = new Map(), requests = [], copied = [];
  const createElement = (tagName = '') => ({ tagName, dataset:{}, hidden:true, setAttribute(name,value) { this[name] = value; }, getAttribute(name){ return this[name]; }, replaceChildren() {}, children:[], append(...children) { this.children.push(...children); }, querySelector(tag) { return this.children.find(child => child.tagName === tag) || null; }, remove() {}, setPointerCapture() {}, focus() {} });
  const node = id => { if (!nodes.has(id)) nodes.set(id, createElement()); return nodes.get(id); };
  const voices = [], listeners = {}, documentListeners = {};
  const context = vm.createContext({
    approvalView, sceneForState, clearTimeout,
    mountWorkSurface:()=>({setAgent(){},update(){},destroy(){},openProject(){}}),
    mountWorkbench:()=>({update(){},destroy(){},addProject(){}}),
    renderReply:(_document,node,text)=>{node.textContent=text;node.dataset.source=text;},
    mountDashboard:()=>({update(){},destroy(){}}),
    createLocalCaptions:()=>({ready:false,prepare:async()=>false,reset(){},feed(){}}),
    createAudioCheck:()=>({busy:false,stop(){},start(){}}),
    mountVoiceprint:()=>({busy:false,update(){},stop(){}}),
    setTimeout,
    localStorage:{getItem:key=>key==='zhiwei.caption-sync'?savedSync:null,setItem(){}},
    Date, Option:class {constructor(text,value){this.text=text;this.value=value;}},
    navigator:{clipboard:{writeText:async text=>copied.push(text)}},
    createNativeVoice:options=>({status:'off',pending:false,sync(){},stop:async()=>{},options}),
    mountWechat:()=>{},
    createBailianVoice:options=>({pending:false,sync(){},stop:async()=>{},start:()=>new Promise(resolve=>{requests.push({url:'browser-voice-start',options:{},resolve:()=>resolve()});}),options}),
    document:{body:createElement(),getElementById:node,querySelectorAll:()=>[],createElement,addEventListener(type,fn){documentListeners[type]=fn;}}, mountMemory:()=>({update(){}}),
    location:{search}, URLSearchParams, simulationMode, mountOrb:()=>({setVoice:voice=>voices.push(voice)}),
    EventSource:class { constructor(){listeners.connections=(listeners.connections??0)+1;} addEventListener(type,fn){listeners[type]=fn;} }, fetch:(url, options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject})),
  });
  const source = (await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
  vm.runInContext(source + (render ? '' : '\nrender=()=>{};') + '\nglobalThis.actions={action,usePrompt,nativeVoice,bailianVoice,setState(value){state=value;csrf=state.csrf;streamOnline=true;render();}};',context);
  return {requests,node,voices,listeners,documentListeners,copied,document:context.document,blur:context.onblur,...context.actions};
}
const finish = request => request.resolve({ok:true,json:async()=>({ok:true})});

test('effort picker saves the level for the current model and disables unsupported choices',async()=>{
  const p=await page({render:true});
  const models={selected:'model-a',options:[{id:'model-a',name:'Model A'}],effort:{selected:'low',options:[{id:'low',name:'Low'},{id:'high',name:'High'}]}};
  const state={csrf:'test',connection:'connected',task:{status:'idle'},sessions:[],items:[],approvals:[],logs:[],models,voice:{enabled:false,state:'idle'}};
  p.setState(state);
  const picker=p.node('effort-select');
  assert.equal(picker.disabled,false);
  picker.value='high';
  const saving=picker.onchange();
  assert.equal(picker.disabled,true);
  assert.equal(p.requests[0].url,'/api/model');
  assert.deepEqual(JSON.parse(p.requests[0].options.body),{model:'model-a',effort:'high'});
  p.requests[0].resolve({ok:true,json:async()=>({...models,effort:{...models.effort,selected:'high'}})});
  await saving;
  assert.equal(picker.value,'high');
  p.setState({...state,models:{...models,effort:null}});
  assert.equal(picker.disabled,true);
});

test('Grok Bot copies the project draft and opens the app without sending to the active Agent',async()=>{
  const p=await page({render:true});
  p.node('workbench-agent').value='grok-bot';
  p.setState({csrf:'test',connection:'connected',task:{status:'idle'},sessions:[],items:[],approvals:[],logs:[],
    workbench:{agent:'codex',projectId:'p',projects:[{id:'p',name:'知微'}],agents:[{id:'codex',name:'Codex'}]},
    voice:{enabled:false,state:'idle'}});
  assert.equal(p.node('model-select').disabled,true);
  assert.equal(p.node('model-select').children.at(-1).text,'Grok Bot 自动选择');
  p.node('input').value='核对项目进度';
  const opening=p.node('composer').onsubmit({preventDefault(){}});
  await tick();
  assert.deepEqual(p.copied,['项目：知微\n\n核对项目进度']);
  assert.deepEqual(p.requests.map(request=>request.url),['/api/workbench/grok-bot/open']);
  finish(p.requests[0]);await opening;
  assert.match(p.node('model-status').textContent,/任务草稿已复制/);
});

test('recognition chooser requires an explicit consent check and never opens the microphone on save',async()=>{
  const p=await page({render:true});p.setState({csrf:'offline-token',connection:'connected',task:{status:'idle'},sessions:[],items:[],approvals:[],logs:[],voice:{enabled:false,state:'idle',recognition:{asr:'dashscope',useInstalledSession:false}}});
  p.node('recognition-select').value='bageshuo';p.node('recognition-select').onchange();
  assert.equal(p.node('recognition-consent').checked,false);await p.node('recognition-save').onclick();assert.equal(p.requests.length,0);
  p.node('recognition-consent').checked=true;p.node('recognition-consent').onchange();const saving=p.node('recognition-save').onclick();
  assert.equal(p.requests.length,1);assert.equal(p.requests[0].url,'/api/voice/recognition');assert.deepEqual(JSON.parse(p.requests[0].options.body),{asr:'bageshuo',useInstalledSession:true});
  p.requests[0].resolve({ok:true,json:async()=>({asr:'bageshuo',useInstalledSession:true})});await saving;assert.equal(p.requests.length,1);assert.equal(p.node('recognition-consent').checked,true);
});

test('real page action handler submits approvals during pending sends and plans without replay', async()=>{
  for(const route of ['send','plan']) {
    const p=await page(), sending=p.action(route,{text:'任务'});
    assert.equal(p.requests.length,1);
    for(const approvalRoute of ['approval','windows/approval']) {
      const approving=p.action(approvalRoute,{id:'same',decision:'accept'});
      assert.equal(p.requests.at(-1).url,`/api/${approvalRoute}`);
      const count=p.requests.length;
      await p.action(approvalRoute,{id:'same',decision:'decline'});
      assert.equal(p.requests.length,count,'same approval cannot be submitted twice');
      finish(p.requests.at(-1));await approving;
    }
    if(route==='send') {await p.action('send',{text:'重复'});assert.equal(p.requests.length,3);}
    finish(p.requests[0]);await sending;
  }
});

test('real page stop handler releases its request guard after transport failure',async()=>{
  const p=await page();
  const stopping=p.node('stop').onclick();
  await p.node('stop').onclick();assert.equal(p.requests.length,1);
  p.requests[0].reject(new Error('本地连接断开'));await stopping;
  assert.equal(p.node('error').textContent,'本地连接断开');
  const retry=p.node('stop').onclick();assert.equal(p.requests.length,2);
  finish(p.requests[1]);await retry;
});

test('real page allows cancelling voice startup and keeps unavailable voice disabled', async () => {
  const p = await page({ render:true });
  const state = { connection:'connected', task:{status:'idle'}, sessions:[], items:[], approvals:[], logs:[],
    voice:{enabled:false, state:'idle', availability:{ready:true}} };
  p.setState(state);
  p.node('voice-route').value='bailian';p.node('voice-route').onchange();
  const enabling = p.node('voice-toggle').onclick();
  assert.equal(p.node('voice-toggle').disabled, true);
  state.voice = { ...state.voice, enabled:true, changing:true };
  p.setState(state);
  assert.equal(p.node('voice-toggle').disabled, false, 'pending microphone startup can be cancelled');
  const disabling = p.node('voice-toggle').onclick();
  await tick(); // Browser microphone teardown completes before the POST.
  assert.equal(p.requests.length, 2);
  assert.equal(JSON.parse(p.requests[1].options.body).enabled, false);
  finish(p.requests[0]); await enabling;
  assert.equal(p.node('voice-toggle').disabled, true, 'late enable response cannot release stop guard');
  finish(p.requests[1]); await disabling;
  state.voice = { enabled:false, availability:{ready:false, reason:'未设置 DASHSCOPE_API_KEY'} };
  p.setState(state);
  assert.equal(p.node('voice-toggle').disabled, true);
  assert.equal(p.node('voice-state').textContent, '未设置 DASHSCOPE_API_KEY');
});

test('active writer leaves Bailian and typing available and keeps the draft through retry or new chat', async () => {
  const p=await page({render:true});
  const conflict={threadId:'original',message:'另一个 Codex 客户端占用；可稍后重试。'};
  p.setState({connection:'connected',currentId:'original',needsResume:true,sessionConflict:conflict,error:conflict.message,task:{status:'idle'},sessions:[],items:[],approvals:[],logs:[],voice:{enabled:false,state:'idle',availability:{ready:true}}});
  p.node('voice-route').value='bailian';p.node('voice-route').onchange();
  assert.equal(p.node('voice-toggle').disabled,false);
  assert.equal(p.node('send').disabled,false);
  assert.equal(p.node('retry-session').hidden,false);
  assert.equal(p.node('retry-session').textContent,'稍后重试');
  assert.equal(p.node('missing-session-new').hidden,false);
  p.node('input').value='原草稿';
  const rejected=p.node('composer').onsubmit({preventDefault(){}});
  p.requests.at(-1).resolve({ok:false,json:async()=>({error:conflict.message})});await rejected;
  assert.equal(p.node('input').value,'原草稿');
  const retry=p.node('retry-session').onclick();
  assert.equal(p.requests.at(-1).url,'/api/resume');
  assert.equal(JSON.parse(p.requests.at(-1).options.body).id,'original');
  finish(p.requests.at(-1));await retry;
  const create=p.node('missing-session-new').onclick();
  assert.equal(p.requests.at(-1).url,'/api/new');
  finish(p.requests.at(-1));await create;
  assert.equal(p.node('input').value,'原草稿');
});

const pttState = () => ({ csrf:'page-token', connection:'connected', task:{status:'idle'}, sessions:[], items:[], approvals:[], logs:[],
  voice:{mode:'ptt', enabled:true, held:false, state:'idle'} });
const pointer = (pointerId = 1) => ({ pointerId, button:0, preventDefault() {} });
const space = (extra = {}) => ({ code:'Space', preventDefault() { this.prevented = true; }, ...extra });

test('top bar mode picker works with the microphone off and updates the wake hint when listening', async () => {
  const p=await page({render:true}), state=pttState();
  state.voice={spokenModes:true,enabled:false,inputEnabled:false,state:'idle',mode:'default'};
  p.setState(state);
  const picker=p.node('voice-mode-select');
  assert.equal(picker.hidden,false);
  assert.equal(picker.disabled,false);
  picker.value='ptt';
  const changing=picker.onchange();
  assert.equal(picker.disabled,true);
  assert.deepEqual(p.requests.map(request=>request.url),['/api/voice/mode']);
  assert.deepEqual(JSON.parse(p.requests[0].options.body),{mode:'ptt'});
  p.requests[0].resolve({ok:true,json:async()=>({mode:'ptt'})});await changing;
  assert.equal(picker.value,'ptt');
  state.voice={...state.voice,enabled:true,inputEnabled:true,mode:'default'};
  p.setState(state);
  assert.match(p.node('voice-state').textContent,/以「知微」开头/);
});

test('real page PTT pointer release serializes behind press and shows mode-specific state', async () => {
  const p = await page({ render:true }), state = pttState();
  p.setState(state);
  assert.equal(p.node('voice-state').textContent, '百炼 · 龙婉女声 · 按住说话');
  assert.equal(p.node('voice-ptt').hidden, false);
  p.node('voice-ptt').onpointerdown(pointer()); await tick();
  assert.equal(p.node('voice-ptt').textContent, '正在听…');
  assert.equal(p.requests.length, 1);
  assert.equal(p.requests[0].url, '/api/voice/ptt');
  assert.equal(p.requests[0].options.headers['X-Zhiwei-CSRF'], 'page-token');
  assert.equal(JSON.parse(p.requests[0].options.body).action, 'start');
  p.node('voice-ptt').onpointerup(pointer(2));
  p.node('voice-ptt').onpointerup(pointer());
  p.node('voice-ptt').onlostpointercapture(pointer());
  await tick(); assert.equal(p.requests.length, 1, 'stop waits for pending start');
  finish(p.requests[0]); await tick();
  assert.equal(p.requests.length, 2);
  assert.equal(JSON.parse(p.requests[1].options.body).action, 'stop');
  finish(p.requests[1]); await tick();
  state.voice.mode = 'wake'; state.voice.wakeWord = '知微'; p.setState(state);
  assert.equal(p.node('voice-ptt').hidden, true);
  assert.equal(p.node('voice-state').textContent, '百炼 · 龙婉女声 · 聆听中（唤醒词：知微）');
  p.document.onkeydown(space()); await tick();
  assert.equal(p.requests.length, 2);
});

test('real page PTT leaves editable spaces alone and releases keyboard on blur or visibility loss', async () => {
  const p = await page({ render:true }); p.setState(pttState());
  const input = space({ target:{ closest:() => ({}) } });
  p.document.onkeydown(input); await tick();
  assert.equal(input.prevented, undefined); assert.equal(p.requests.length, 0);
  const event = space(); p.document.onkeydown(event); await tick();
  assert.equal(event.prevented, true); assert.equal(p.requests.length, 1);
  const repeat = space({ repeat:true }); p.document.onkeydown(repeat);
  assert.equal(repeat.prevented, true);
  const editingRepeat = space({ repeat:true, target:{ closest:() => ({}) } });
  p.document.onkeydown(editingRepeat); assert.equal(editingRepeat.prevented, undefined);
  finish(p.requests[0]); await tick();
  p.blur(); await tick();
  assert.equal(JSON.parse(p.requests[1].options.body).action, 'stop');
  finish(p.requests[1]); await tick();
  p.document.onkeyup(space()); await tick(); assert.equal(p.requests.length, 2);
  p.document.onkeydown(space()); await tick(); finish(p.requests[2]); await tick();
  p.document.hidden = true; p.document.onvisibilitychange(); await tick();
  assert.equal(JSON.parse(p.requests[3].options.body).action, 'stop');
  finish(p.requests[3]); await tick();
});

test('real page space keyup ends recognition exactly once', async () => {
  const p = await page({ render:true }); p.setState(pttState());
  p.document.onkeydown(space()); await tick(); finish(p.requests[0]); await tick();
  const released = space(); p.document.onkeyup(released); p.document.onkeyup(space()); await tick();
  assert.equal(released.prevented, true);
  assert.equal(p.requests.length, 2);
  assert.equal(JSON.parse(p.requests[1].options.body).action, 'stop');
  finish(p.requests[1]); await tick();
});

test('real page touch cancel releases PTT; failed release closes voice and exposes the error', async () => {
  const p = await page({ render:true }); p.setState(pttState());
  p.node('voice-ptt').onpointerdown(pointer()); await tick();
  finish(p.requests[0]); await tick();
  p.node('voice-ptt').onpointercancel(pointer()); await tick();
  assert.equal(JSON.parse(p.requests[1].options.body).action, 'stop');
  assert.equal(p.requests[1].options.keepalive, true);
  p.requests[1].reject(new Error('松开请求失败')); await tick();
  assert.equal(p.requests[2].url, '/api/voice');
  assert.equal(JSON.parse(p.requests[2].options.body).enabled, false);
  finish(p.requests[2]); await tick();
  assert.equal(p.node('error').textContent, '松开请求失败');
});

test('a failed previous press cannot lose the release of a newer hold', async () => {
  const p = await page({ render:true }); p.setState(pttState());
  p.node('voice-ptt').onpointerdown(pointer()); await tick();
  p.node('voice-ptt').onpointerup(pointer());
  p.node('voice-ptt').onpointerdown(pointer(2));
  p.requests[0].resolve({ ok:false, json:async () => ({ error:'前一次按下失败' }) }); await tick();
  finish(p.requests[1]); await tick(); // old release
  finish(p.requests[2]); await tick(); // new press
  p.node('voice-ptt').onpointerup(pointer(2)); await tick();
  assert.equal(p.requests.length, 4);
  assert.equal(JSON.parse(p.requests[3].options.body).action, 'stop');
  finish(p.requests[3]); await tick();
});

test('spoken modes show the active mode and use only the Space key for PTT',async()=>{
  const p=await page({render:true}),state=pttState(),holds=[];
  p.bailianVoice.hold=action=>{holds.push(action);return true;};
  state.voice.spokenModes=true;state.voice.mode='default';p.setState(state);
  assert.match(p.node('mode-summary').textContent,/默认模式/);
  assert.equal(p.node('native-toggle').disabled,true);
  state.voice.mode='dialog';p.setState(state);
  assert.match(p.node('mode-summary').textContent,/对话模式/);
  state.voice.mode='ptt';p.setState(state);
  assert.match(p.node('mode-summary').textContent,/按住空格/);
  p.node('voice-ptt').onpointerdown(pointer());assert.deepEqual(holds,[]);
  const press={code:'Space',target:{closest:()=>null},preventDefault(){}};
  p.document.onkeydown({...press,target:{closest:()=>true}});assert.deepEqual(holds,[]);
  p.document.onkeydown(press);p.document.onkeydown({...press,repeat:true});
  p.document.onkeyup(press);assert.deepEqual(holds,['start','stop']);
  p.document.onkeydown(press);p.blur();
  assert.deepEqual(holds,['start','stop','start','cancel']);
  assert.equal(p.requests.length,0);
});

test('orb preview never opens EventSource or sends backend actions in all simulation modes', async () => {
  for (const mode of ['idle', 'listening', 'speaking', 'cycle']) {
    const p = await page({ search:`?orbSim=${mode}` });
    assert.equal(p.listeners.connections, undefined);
    await p.action('connect');
    assert.equal(p.requests.length, 0);
    assert.equal(p.document.body.dataset.orbSim, mode);
  }
});

test('orb receives lightweight SSE levels without rerendering voice controls or losing real silence', async () => {
  const p = await page({ render:true }), state = pttState();
  state.voice.state = 'listening'; p.setState(state);
  const caption = p.node('voice-state').textContent;
  p.listeners['voice-level']({ data:JSON.stringify({ state:'listening', level:0, levelAt:123 }) });
  assert.equal(p.voices.at(-1).level, 0);
  assert.equal(state.voice.levelAt, 123);
  assert.equal(p.node('voice-state').textContent, caption);
  assert.equal(p.requests.length, 0);
});

test('corner panels retain accessible toggle and Escape controls', async () => {
  const p = await page();
  p.node('sessions-toggle').onclick();
  assert.equal(p.node('conversation-panel').hidden, false);
  assert.equal(p.node('conversation-toggle')['aria-expanded'], 'true');
  assert.equal(p.node('sessions-toggle')['aria-expanded'], 'true');
  p.node('inspector-toggle').onclick();
  assert.equal(p.node('conversation-panel').hidden, true);
  assert.equal(p.node('inspector-panel').hidden, false);
  p.documentListeners.keydown({ key:'Escape' });
  assert.equal(p.node('inspector-panel').hidden, true);
  assert.equal(p.node('inspector-toggle')['aria-expanded'], 'false');
});

test('subtitles select latest real messages, follow partial recognition, and clear on a new conversation', async () => {
  const p = await page({ render:true }), state = pttState();
  state.items = [
    { id:'1', type:'userMessage', text:'旧问题' }, { id:'2', type:'agentMessage', text:'旧回复' },
    { id:'3', type:'userMessage', text:'最新问题<script>' }, { id:'4', type:'agentMessage', text:'最新回复' },
    { id:'5', type:'reasoning', text:'不应显示' },
  ];
  p.setState(state);
  assert.equal(p.node('subtitle-user').textContent, '最新问题<script>');
  assert.equal(p.node('subtitle-assistant').textContent, '最新回复');
  state.voice = { ...state.voice, state:'listening', partial:'正在识别的句子' }; p.setState(state);
  assert.equal(p.node('subtitle-user').textContent, '正在识别的句子');
  state.voice.state = 'speaking'; p.setState(state);
  assert.equal(p.node('subtitle-user').textContent, '最新问题<script>');
  state.items = []; state.voice.partial = ''; state.voice.state = 'idle'; p.setState(state);
  assert.equal(p.node('subtitle-user').textContent, '说说你想做的事，或从左侧选择项目。');
  p.node('conversation-toggle').onclick();
  assert.equal(p.node('conversation-panel').hidden, false);
  p.documentListeners.keydown({ key:'Escape' });
  assert.equal(p.node('conversation-panel').hidden, true);
});

test('window recovery prompt opens text drawer and keeps it open for subsequent prompts', async () => {
  const p = await page();
  p.node('inspector-toggle').onclick();
  p.usePrompt('请恢复此前窗口');
  assert.equal(p.node('conversation-panel').hidden, false);
  assert.equal(p.node('inspector-panel').hidden, true);
  assert.equal(p.node('input').value, '请恢复此前窗口');
  p.usePrompt('另一条提示');
  assert.equal(p.node('conversation-panel').hidden, false);
  assert.equal(p.node('input').value, '另一条提示');
});

test('orb uses rendered Bailian levels, rejects obsolete phases and keeps native WebRTC levels in control', async () => {
  const p=await page({render:true}),state=pttState();state.voice.state='speaking';p.setState(state);
  p.bailianVoice.options.onLevel({listening:0.9,speaking:0});
  assert.equal(p.voices.at(-1).level,0,'actual playback silence wins over synthesis arrival');
  const count=p.voices.length;
  p.listeners['voice-level']({data:JSON.stringify({state:'listening',level:1,levelAt:Date.now()})});
  assert.equal(p.voices.length,count,'old phase cannot resurrect listening');
  p.nativeVoice.status='connected';
  p.nativeVoice.options.onLevel({state:'listening',level:0.25,levelAt:Date.now()});
  assert.equal(p.voices.at(-1).state,'listening');assert.equal(p.voices.at(-1).level,0.25);
  p.bailianVoice.options.onLevel({listening:0,speaking:1});
  assert.equal(p.voices.at(-1).state,'listening');assert.equal(p.voices.at(-1).level,0.25);
  p.nativeVoice.status='off';state.voice.enabled=false;p.setState(state);
  const disabled=p.voices.length;
  p.listeners['voice-level']({data:JSON.stringify({state:'speaking',level:1,levelAt:Date.now()})});
  assert.equal(p.voices.length,disabled,'disabled voice ignores late telemetry');
});

test('text work shows thinking without enabling audio and interruption survives an idle voice snapshot',async()=>{
  const p=await page({render:true}),state=pttState();state.voice.enabled=false;state.task.status='running';p.setState(state);
  assert.equal(p.voices.at(-1).state,'thinking');
  state.task.status='interrupted';state.voice.interruptedAt=123;p.setState(state);
  assert.equal(p.voices.at(-1).state,'interrupted');assert.equal(p.voices.at(-1).interruptedAt,123);
});

test('assistant subtitles show a standby greeting, then real waiting and interruption states',async()=>{
  const p=await page({render:true}),state=pttState();p.setState(state);
  assert.equal(p.node('subtitle-assistant').textContent,'我在，今天想先处理哪个项目？');
  state.task.status='running';p.setState(state);
  assert.equal(p.node('subtitle-assistant').textContent,'正在生成回答，请稍候…');
  state.task.status='interrupted';p.setState(state);
  assert.equal(p.node('subtitle-assistant').textContent,'本轮已停止，尚未生成回复。');
});


test('new user question clears an old answer while the new response is pending',async()=>{
  const p=await page({render:true}),state=pttState();
  state.items=[{id:'1',type:'userMessage',text:'旧问题'},{id:'2',type:'agentMessage',text:'旧回答'},{id:'3',type:'userMessage',text:'新问题'}];
  state.task.status='running';p.setState(state);
  assert.equal(p.node('subtitle-assistant').textContent,'正在生成回答，请稍候…');
});

test('current-agent voice is the default and active Bailian remains stoppable',async()=>{
  const p=await page({render:true}),state=pttState();state.voice.enabled=false;p.setState(state);
  assert.equal(p.node('native-toggle').hidden,true);assert.equal(p.node('voice-toggle').hidden,false);
  assert.match(p.node('voice-cost').textContent,/API 用量/);
  p.node('voice-route').value='native';p.node('voice-route').onchange();
  assert.equal(p.node('native-toggle').hidden,false);assert.match(p.node('voice-cost').textContent,/不调用百炼/);
  state.workbench={agent:'dsh',agents:[{id:'dsh',name:'DeepSeek Harness'}],nativeVoice:false};p.setState(state);
  assert.equal(p.node('voice-route').value,'bailian');assert.equal(p.node('voice-toggle').hidden,false);
  state.workbench=undefined;
  state.voice.enabled=true;p.setState(state);assert.equal(p.node('voice-route').disabled,true);
  assert.equal(p.node('voice-toggle').hidden,false);assert.equal(p.node('native-toggle').hidden,true);
});

test('native task switching shows immediate acknowledgement and surfaces a failed switch',async()=>{
  const p=await page({render:true}),state=pttState();state.voice.enabled=false;p.nativeVoice.status='connected';
  state.realtime={status:'connected',taskControl:'已收到，正在停止旧任务…'};p.setState(state);
  assert.equal(p.node('voice-state').textContent,state.realtime.taskControl);
  state.realtime.taskControl=null;state.realtime.error='任务切换未完成：停止尚未确认';p.setState(state);
  assert.equal(p.node('error').hidden,false);assert.equal(p.node('error').textContent,state.realtime.error);
});

test('setup panel closes other panels without issuing backend requests',async()=>{
  const p=await page({render:true}),state=pttState();p.setState(state);
  p.node('conversation-toggle').onclick();p.node('setup-toggle').onclick();
  assert.equal(p.node('conversation-panel').hidden,true);assert.equal(p.node('setup-panel').hidden,false);
  p.documentListeners.keydown({key:'Escape'});assert.equal(p.node('setup-panel').hidden,true);
  assert.equal(p.requests.length,0);
});


test('new approvals open visibly and never submit a decision automatically',async()=>{
  const p=await page({render:true}),state=pttState();p.setState(state);
  state.approvals=[{id:'approve-1',method:'item/commandExecution/requestApproval',params:{command:'echo test'}}];p.setState(state);
  assert.equal(p.node('approval-panel').open,true);assert.equal(p.node('approval-panel').hidden,false);
  assert.match(p.node('task-overview').textContent,/等待你授权/);assert.equal(p.requests.length,0);
  p.node('approval-panel').open=false;p.setState(state);assert.equal(p.node('approval-panel').open,false);
});


test('English speech shows its linked Chinese translation while preserving original text',async()=>{
 const p=await page({render:true}),state=pttState();state.voice.enabled=false;state.realtime={status:'connected',caption:{id:'en',source:'Take your time.',status:'ready',text:'慢慢来。'}};state.items=[{id:'en',type:'agentMessage',text:'Take your time.'}];p.setState(state);
 assert.equal(p.node('subtitle-assistant').textContent,'慢慢来。');assert.equal(p.node('subtitle-original-text').textContent,'Take your time.');
 state.items=[{id:'new',type:'agentMessage',text:'Another response.'}];p.nativeVoice.status='connected';p.setState(state);assert.equal(p.node('subtitle-assistant').textContent,'正在整理中文字幕…');
});


test('speech starts immediately by default even after the older subtitle-first preference',async()=>{
 const p=await page({render:true,savedSync:'true'}),state=pttState();state.voice.enabled=false;p.setState(state);assert.equal(p.node('caption-sync').checked,false);
});


test('voice providers are selected in settings and remain locked during a live voice session',async()=>{
  const p=await page({render:true});
  const state={connection:'connected',task:{status:'idle'},sessions:[],items:[],approvals:[],logs:[],voice:{enabled:false,state:'idle'}};
  p.setState(state);
  p.node('voice-route').value='native';p.node('voice-route').onchange();
  assert.equal(p.node('voice-route').value,'native');
  p.node('voice-route').value='bailian';p.node('voice-route').onchange();
  state.voice={enabled:true,state:'listening'};p.setState(state);
  assert.equal(p.node('voice-route').disabled,true);
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  assert.ok(!html.includes('id="provider-native"')&&!html.includes('id="provider-bailian"'));
});
test('panel visibility and compact replies can be changed independently without backend actions',async()=>{
  const p=await page();
  assert.equal(p.node('layout-projects')['aria-pressed'],'true');
  p.node('hide-projects').onclick();
  assert.equal(p.document.body.dataset.showProjects,'false');
  assert.equal(p.document.body.dataset.showDetails,'true');
  p.node('layout-focus').onclick();
  assert.deepEqual({...p.document.body.dataset},{showProjects:'false',showAgent:'false',showDetails:'false'});
  p.node('layout-focus').onclick();
  assert.equal(p.document.body.dataset.showProjects,'true');
  assert.equal(p.document.body.dataset.showDetails,'true');
  p.node('subtitle-expand').onclick();
  assert.equal(p.document.body.dataset.expandedReply,'true');
  p.node('subtitle-expand').onclick();
  assert.equal(p.document.body.dataset.expandedReply,'false');
  assert.equal(p.requests.length,0);
});
