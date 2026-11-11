import {guardLiveScript} from './live-guard.js';
guardLiveScript(import.meta.url);
// Opt-in Codex -> MCP -> Windows acceptance. --resume reuses the verified test window.
import assert from 'node:assert/strict';
import {readFile,writeFile,rename,access} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {start,root} from '../src/main.js';
import {validate} from '../src/windows/tools.js';

const snippet='你好，我是沈知微，这是第一次 Windows Computer Use 测试。';
const dataDir=path.join(root,'data','computer-live-tests');
const checkpointFile=path.join(dataDir,'acceptance.json');
const stages=['launched','inputVerified','saved','observed','stopped','complete'];
const resume=process.argv.includes('--resume');
const newFile=process.argv.includes('--new-file');
let filename=process.env.ZHIWEI_ACCEPTANCE_FILENAME||'zhiwei-computer-use.txt';
let app,csrf,c,checkpoint,targetId,approvalError,phase='';
const approved=new Set(),granted=new Set();
const exists=async file=>{try{await access(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
const readSavedText=async file=>{const b=await readFile(file);return b[0]===255&&b[1]===254?b.subarray(2).toString('utf16le'):b.toString('utf8').replace(/^\uFEFF/,'');};
const passed=stage=>checkpoint&&stages.indexOf(checkpoint.stage)>=stages.indexOf(stage);
async function saveCheckpoint(stage,extra={}){
  checkpoint={...checkpoint,...extra,version:1,stage,filename,threadId:app.client.currentId,windowId:targetId,updatedAt:new Date().toISOString()};
  const temporary=checkpointFile+'.tmp';await writeFile(temporary,JSON.stringify(checkpoint,null,2));await rename(temporary,checkpointFile);
}
async function post(route,body={}){
  const response=await fetch(app.origin+'/api/'+route,{method:'POST',headers:{Origin:app.origin,'X-Zhiwei-CSRF':csrf,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();assert.equal(response.status,200,result.error);return result;
}
async function waitFor(predicate,timeout=180000){
  const end=Date.now()+timeout;
  while(Date.now()<end){if(approvalError)throw new Error(approvalError);if(app.client.approvals.size)throw new Error('验收出现计划外的原生命令审批，已停止；不允许绕过 Windows MCP。');if(predicate())return;if(app.client.connection!=='connected')throw new Error(app.client.error||'Codex disconnected');await delay(100);}
  throw new Error(`阶段 ${phase} 等待超时，状态 ${app.client.task.status}；请使用 --resume 保留上下文继续，不自动重放。`);
}
async function turn(text){
  await post('send',{text});await waitFor(()=>['completed','failed','interrupted'].includes(app.client.task.status));assert.equal(app.client.task.status,'completed',app.client.error);
  const answer=app.client.snapshot().items.filter(i=>i.turnId===app.client.task.turnId&&i.type==='agentMessage').map(i=>i.text).join('\n');console.log(answer.slice(0,600));return answer;
}
function authorize(){
  c.on('change',()=>{for(const p of c.snapshot().approvals){
    if(approved.has(p.id))continue;
    const allowed=(phase==='launch'&&p.tool==='windows_launch_app'&&p.params.app==='notepad')||
      (phase==='restore'&&p.tool==='windows_restore_window'&&p.params.bindingId===checkpoint.bindingId)||
      (phase==='cancel'&&p.tool==='windows_send_keys'&&p.params.windowId===targetId&&p.params.key==='Escape')||
      (phase==='input'&&p.tool==='windows_set_text'&&p.params.windowId===targetId&&p.params.text===snippet)||
      (phase==='save'&&p.tool==='windows_save_notepad'&&p.params.windowId===targetId&&p.params.filename===filename);
    if(allowed&&!granted.has(phase)){approved.add(p.id);granted.add(phase);console.log('AUTHORIZED exact test action: '+p.tool);c.approve(p.id,'accept');}
    else if(phase!=='stop'){approved.add(p.id);approvalError=`${phase} 收到计划外或重复授权请求 ${p.tool}，已拒绝，未自动重放。`;c.approve(p.id,'decline');}
  }});
  app.client.rpc.on('notification',({method,params:p})=>{if(method==='item/started'&&p.item?.type==='mcpToolCall')console.log(`MCP ${p.item.server}.${p.item.tool}`);});
}
async function observe(){
  const proof=c.owned.get(targetId);assert.ok(proof,'测试窗口未绑定');
  await c.backend.call('register_windows',{windows:[proof]});
  return c.backend.call('read_text',{windowId:targetId});
}
try{
  if(resume){
    checkpoint=JSON.parse(await readFile(checkpointFile,'utf8'));
    assert.ok(checkpoint.version===1&&stages.includes(checkpoint.stage)&&typeof checkpoint.threadId==='string'&&typeof checkpoint.bindingId==='string'&&/^\d+$/.test(checkpoint.windowId),'断点格式无效');
    if(newFile){
      assert.ok(process.env.ZHIWEI_ACCEPTANCE_FILENAME&&filename!==checkpoint.filename,'--new-file 需要明确指定不同的新文件名');
      validate('windows_save_notepad',{windowId:checkpoint.windowId,filename});
      checkpoint={...checkpoint,previousFilename:checkpoint.filename,savedActionId:undefined,stage:passed('inputVerified')?'inputVerified':checkpoint.stage};
    }else{if(process.env.ZHIWEI_ACCEPTANCE_FILENAME)assert.equal(filename,checkpoint.filename,'切换目标文件需要明确 --new-file');filename=checkpoint.filename;}
    targetId=checkpoint.windowId;
  }
  validate('windows_save_notepad',{windowId:targetId||'1',filename});
  const destination=path.join(root,'test-workspace',filename);
  if(!resume||!passed('saved'))assert.equal(await exists(destination),false,'目标文件已存在，禁止覆盖或把不确定结果当成通过');
  if(passed('saved'))assert.equal(await readSavedText(destination),snippet);
  app=await start({port:0,dataDir});await app.ready;assert.equal(app.client.connection,'connected','CODEX_UNAVAILABLE：'+(app.client.error||'Codex 未连接或未登录'));
  csrf=(await(await fetch(app.origin+'/api/state')).json()).csrf;c=app.client.computer;
  if((await c.checkDesktop()).locked){const e=new Error('Windows 已锁屏；断点已保留，未执行桌面操作。');e.code='DESKTOP_LOCKED';throw e;}
  authorize();console.log('Connected to real Codex; local test client: '+app.origin);
  if(resume){
    await post('resume',{id:checkpoint.threadId});phase='restore';
    await turn(`继续同一专用测试窗口。请调用 windows_restore_window，绑定编号 ${checkpoint.bindingId}。仅恢复这个知微创建的窗口，报告 enabled 状态；不要新开窗口或输入文字。`);
    assert.ok(c.owned.has(targetId),'原窗口恢复失败；不要自动接管其他窗口');
    console.log('PASS CU6：原生 Thread 恢复及额外授权恢复原测试窗口');
    if(c.currentWindow?.enabled===false){
      phase='cancel';await turn(`仅取消测试窗口 ${targetId} 的另存为弹窗：调用 windows_send_keys，key 为 Escape。保留文档，不保存、不关闭记事本。`);
      assert.ok([...c.actions.values()].some(a=>a.tool==='windows_send_keys'&&a.params?.key==='Escape'&&a.status==='completed'),'弹窗取消未被工具确认');
    }
    if(!passed('saved')){
      const observed=await observe();assert.ok(observed.texts.some(t=>t.text===snippet),'恢复后原文不一致，拒绝再次保存');
      assert.equal(await exists(destination),false,'文件结果仍需人工核实，禁止覆盖');
      if(checkpoint.previousFilename){
        validate('windows_save_notepad',{windowId:targetId,filename:checkpoint.previousFilename});
        const prior=path.join(root,'test-workspace',checkpoint.previousFilename);
        if(await exists(prior))assert.equal(await readSavedText(prior),snippet,'原目标文件内容已变化，保留现场');
      }
      for(const action of c.actions.values())if(action.status==='unknown'&&action.tool==='windows_save_notepad'&&action.scope?.windowId===targetId&&!action.resolution){await post('windows/resolve',{id:action.id,resolution:'partial'});console.log('VERIFIED recovery: original text intact, target file absent; previous save retains unknown status with partial-result verification.');}
      if(newFile)await saveCheckpoint(checkpoint.stage);
    }
  }else{
    await post('new');phase='launch';await turn('知微，打开 Windows 记事本。仅使用 zhiwei_windows MCP 工具启动独立测试窗口，不得用 Shell 或代码自行启动。');
    assert.ok(c.currentWindow?.id);targetId=c.currentWindow.id;
    const binding=[...c.bindings.values()].find(b=>b.proof.id===targetId&&b.status!=='closed');assert.ok(binding);
    await saveCheckpoint('launched',{bindingId:binding.id});console.log('PASS CU1：Codex → MCP → 真实独立记事本窗口');
  }
  if(!passed('inputVerified')){
    phase='input';await turn(`在这个测试记事本中输入以下完整文字：${snippet} 请使用 windows_get_ui_tree 和 windows_set_text。`);
    assert.ok((await observe()).texts.some(t=>t.text===snippet));await saveCheckpoint('inputVerified');console.log('PASS CU2：真实 UIA 输入及回读');
  }else assert.ok((await observe()).texts.some(t=>t.text===snippet),'续验原文已变化，拒绝覆盖');
  if(!passed('saved')){
    phase='save';await turn(`此前不确定操作已核验并记录，请作为一次新授权保存测试窗口 ${targetId} 的原文到 ${filename}。必须调用 windows_save_notepad，由该工具通过 UIA 读取窗口原文并写入 test-workspace，禁止使用 shell 或其他文件工具。`);
    assert.equal(await readSavedText(destination),snippet);
    const saved=[...c.actions.values()].findLast(a=>a.tool==='windows_save_notepad'&&a.params?.windowId===targetId&&a.params?.filename===filename&&a.status==='completed');assert.ok(saved,'缺少 UIA 原文写入及回读核验成功回执');
    await saveCheckpoint('saved',{savedActionId:saved.id});console.log('PASS CU3：UIA 读取记事本原文 → 工具写入 test-workspace 并回读核验');
  }else assert.equal(c.actions.get(checkpoint.savedActionId)?.status,'completed','断点缺少成功保存记录');
  if(!passed('observed')){
    phase='read';const before=new Set(c.actions.keys());const answer=await turn(`告诉我测试记事本 ${targetId} 里现在有什么内容。必须调用 windows_read_text 实际观察，不得凭历史回答。`);
    assert.ok([...c.actions.values()].some(a=>!before.has(a.id)&&a.tool==='windows_read_text'&&a.status==='completed'));assert.ok(answer.includes(snippet));await saveCheckpoint('observed');console.log('PASS CU4：Codex 调用真实 UIA 观察界面');
  }
  if(!passed('stopped')){
    phase='stop';await post('send',{text:`请将测试记事本 ${targetId} 改成 SHOULD_NOT_BE_WRITTEN，再保存到 zhiwei-stop-should-not-exist.txt。先获取控件并申请输入授权，等待决定。`});
    await waitFor(()=>c.pending.size>0);await post('stop');await waitFor(()=>app.client.task.status==='interrupted');assert.equal(c.active,false);assert.equal(c.pending.size,0);await delay(3000);
    assert.equal(await readSavedText(destination),snippet);assert.equal(await exists(path.join(root,'test-workspace','zhiwei-stop-should-not-exist.txt')),false);assert.ok((await observe()).texts.some(t=>t.text===snippet));
    await saveCheckpoint('stopped');console.log('PASS CU5：真实停止接口取消待授权操作，界面及文件保持原文');
  }
  if(!passed('complete')){phase='chat';await turn('只回复“Windows 中断后对话正常”，不要调用工具。');await saveCheckpoint('complete');}
  console.log('本次真实核心验收完成。已通过项目不会在 --resume 时重复执行。');
}catch(error){console.error(`${error.code==='DESKTOP_LOCKED'?'BLOCKED':'FAIL'}: ${error.message}`);if(checkpoint)console.error('断点已保留：npm run test:computer -- --resume');process.exitCode=error.code==='DESKTOP_LOCKED'?2:1;}
finally{if(app)await app.close();}
