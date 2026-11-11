import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationExport } from '../public/conversation-export.js';

test('conversation export preserves visible text order and excludes internal and account data', () => {
  const state = { currentId:'t', sessions:[{id:'t',title:'中文对话'}], account:{email:'PRIVATE'},
    items:[{type:'userMessage',text:'问题\n第二行'}, {type:'reasoning',text:'HIDDEN'},
      {type:'tool',text:'PRIVATE_COMMAND'}, {type:'agentMessage',text:'<script>原样文字</script>'}], task:{status:'running'} };
  const file = conversationExport(state, new Date('2026-10-30T06:00:00Z'));
  assert.match(file.text,/中文对话/);
  assert.ok(file.text.indexOf('问题\n第二行') < file.text.indexOf('<script>原样文字</script>'));
  assert.doesNotMatch(file.text,/HIDDEN|PRIVATE/);
  assert.match(file.text,/不会停止正在执行的任务/);
  assert.doesNotMatch(file.filename,/[\\/:*?"<>|]/);
  assert.equal(state.task.status,'running');
  assert.throws(()=>conversationExport({items:[{type:'reasoning',text:'secret'}]}),/没有可导出/);
});
