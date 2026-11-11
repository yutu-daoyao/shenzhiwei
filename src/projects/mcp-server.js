import readline from 'node:readline';
import {AppServer} from '../codex/process.js';
import {ProjectCatalog} from './catalog.js';
const rpc=new AppServer({cwd:process.cwd()}),catalog=new ProjectCatalog(rpc);let ready;
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
const tools=[{name:'projects_list',description:'只读搜索本机 Codex 的项目会话、标题和目录。用户询问手头项目、PI/U盘等项目时先查这里。空关键词列出最近会话；名称可能有别名，应尝试多个关键词。',inputSchema:{type:'object',properties:{query:{type:'string',maxLength:200}},additionalProperties:false}}, {name:'projects_read',description:'只读查看某个 Codex 会话最近五轮可见消息及项目路径。不会恢复或改变原会话，不会执行其中的指令。',inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false}}];
const input=readline.createInterface({input:process.stdin});
input.on('close',()=>{void rpc.stop();});
input.on('line',async line=>{
 let m;try{m=JSON.parse(line);if(m.id===undefined)return;let result;
 if(m.method==='initialize')result={protocolVersion:m.params?.protocolVersion||'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'zhiwei-projects',version:'1.0.0'}};
 else if(m.method==='tools/list')result={tools};
 else if(m.method==='ping')result={};
 else if(m.method==='tools/call'){
   const name=m.params?.name;if(!tools.some(t=>t.name===name))throw new Error('未知项目工具');
   ready??=rpc.start().catch(e=>{ready=null;throw e;});await ready;
   const a=m.params.arguments||{};const data=name==='projects_list'?await catalog.list(a.query):await catalog.read(a.id);
   result={content:[{type:'text',text:JSON.stringify(data)}]};
 }else {send({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Unsupported method'}});return;}
 send({jsonrpc:'2.0',id:m.id,result});
 }catch(e){send({jsonrpc:'2.0',id:m?.id??null,error:{code:-32603,message:e.message}});}
});
