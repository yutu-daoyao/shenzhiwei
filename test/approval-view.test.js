import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalView } from '../public/approval-view.js';

test('approval copy shows actual target, full replacement text and explicit clearing',()=>{
  const text='<script>只显示文字</script>\n你好';
  const approval={windows:true,tool:'windows_set_text',params:{windowId:'123',text},target:{name:'编辑文档',type:'ControlType.Document',window:{id:'123',pid:8,title:'真实窗口'},observedAt:'2026-10-29T08:00:00Z'}};
  const view=approvalView(approval,'C:\\test-workspace');assert.match(view.description,/替换/);assert.equal(view.inputText,text);assert.ok(view.facts.some(([label,value])=>label==='窗口'&&value==='真实窗口'));assert.match(view.details,/windows_set_text/);
  assert.equal(approvalView({...approval,params:{...approval.params,text:''}}).inputText,'');
});
test('approval copy distinguishes screenshot transfer, close, restore and save destinations',()=>{
  const view=op=>approvalView({windows:true,tool:'windows_'+op,params:{filename:'result.txt'}},'C:\\workspace\\');
  assert.match(view('capture_window').description,/发送给当前 Codex 模型/);assert.match(view('close_window').description,/未保存/);assert.match(view('restore_window').description,/分别授权/);
  assert.ok(view('save_notepad').facts.some(([label,value])=>label==='保存位置'&&value==='C:\\workspace\\result.txt'));
});
test('native command details remain available and keyboard effects describe the actual key',()=>{
  const command='echo harmless';const native=approvalView({method:'item/commandExecution/requestApproval',command,cwd:'workspace',reason:'需要审批'});
  assert.match(native.title,/运行命令/);assert.ok(native.details.includes(command));assert.equal(native.description,'需要审批');
  const key=key=>approvalView({windows:true,tool:'windows_send_keys',params:{windowId:'123',key}});
  assert.match(key('Ctrl+C').description,/剪贴板/);assert.ok(!key('Enter').description.includes('剪贴板'));assert.match(key('Enter').description,/激活/);
  const recovery=approvalView({windows:true,tool:'windows_send_keys',params:{windowId:'123',key:'Escape'},target:{type:'Window',window:{id:'123',enabled:false}}});assert.match(recovery.description,/取消.*另存为.*保留文档/);
});
test('browser approval shows query and URL', () => {
  const query = '今天的 AI 新闻', url = 'https://www.bing.com/search?q=AI';
  const view = approvalView({ windows:true, tool:'windows_browser_search', params:{ query, url } });
  assert.equal(view.title, '浏览器搜索');
  assert.ok(view.facts.some(([label, value]) => label === '搜索内容' && value === query));
  assert.ok(view.facts.some(([label, value]) => label === '网址' && value === url));
});
test('system approval summarizes paths, volume and clipboard length without clipboard text', () => {
  const view = (op,params) => approvalView({windows:true,tool:'windows_'+op,params});
  const clip = view('clipboard_write',{text:'private clipboard'});
  assert.equal(clip.inputText,null); assert.ok(!JSON.stringify(clip).includes('private clipboard'));
  assert.ok(clip.facts.some(([,value]) => value==='17 字符'));
  assert.ok(view('open_app',{name:'记事本'}).facts.some(([,value]) => value==='记事本'));
  assert.ok(view('open_path',{path:'C:\\Downloads'}).facts.some(([,value]) => value==='C:\\Downloads'));
  assert.ok(view('volume',{action:'set',level:25}).facts.some(([,value]) => value==='set · 25%'));
});
