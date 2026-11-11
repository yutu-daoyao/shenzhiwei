import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Zhiwei} from '../src/client.js';

function fixture(){
  const rpc=new EventEmitter(),responses=[],rejections=[];
  Object.assign(rpc,{respond:(...args)=>responses.push(args),rejectRequest:id=>rejections.push(id)});
  const client=new Zhiwei({workspace:'.',dataDir:'.',rpc,desktopMcp:{command:'desktop.exe',args:['mcp','--headed'],default_tools_approval_mode:'prompt'},projectWorkspace:true});
  client.currentId='thread';client.task={status:'running',turnId:'turn'};
  return {client,rpc,responses,rejections};
}
const request={id:12,method:'tool/requestUserInput',params:{threadId:'thread',turnId:'turn',questions:[{id:'approval',question:'Allow desktop tool?',options:[{label:'Accept',description:'This call only'},{label:'Decline',description:'Reject'}]}]}};
test('desktop MCP uses explicit approval and exposes native approval questions without answering them',async()=>{
  const {client,responses}=fixture(),options=client.threadOptions();
  assert.equal(options.config.mcp_servers['agent-desktop'].default_tools_approval_mode,'prompt');
  assert.match(options.developerInstructions,/agent-desktop/);assert.doesNotMatch(options.developerInstructions,/当前项目未连接 Windows|应用内控制仍仅/);
  client.serverRequest(request);assert.equal(client.snapshot().questions.length,1);assert.equal(responses.length,0);
  await client.answerQuestion({id:'12',answers:[['Accept']]});
  assert.deepEqual(responses,[[12,{answers:{approval:{answers:['Accept']}}}]]);assert.equal(client.questions.size,0);
  await assert.rejects(client.answerQuestion({id:'12',answers:[['Accept']]}),/失效/);
});
test('desktop approval rejects wrong turns and cannot be answered after stop or completion',async()=>{
  const {client,responses,rejections}=fixture();
  client.serverRequest({...request,id:13,params:{...request.params,turnId:'old'}});assert.deepEqual(rejections,[13]);
  client.serverRequest(request);await assert.rejects(client.answerQuestion({id:12,answers:[]}),/格式/);
  client.task.status='stopping';await assert.rejects(client.answerQuestion({id:12,answers:[['Accept']]}),/失效/);assert.equal(responses.length,0);
  client.notification({method:'serverRequest/resolved',params:{requestId:12}});assert.equal(client.questions.size,0);
});
