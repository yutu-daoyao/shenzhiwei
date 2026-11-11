import {lstat,realpath} from 'node:fs/promises';
import path from 'node:path';

const fileTools=new Set(['read','edit','write','grep','find','ls']);
export default function approvals(pi){
  pi.on('session_start',(_event,ctx)=>ctx.ui.notify('zhiwei-approval-ready','info'));
  pi.on('tool_call',async(event,ctx)=>{
    if(fileTools.has(event.toolName)){
      const root=await realpath(ctx.cwd);
      let target=path.resolve(root,event.input.path||'.');
      // Verify the nearest existing parent for new files too.
      for(;;){
        try{target=await realpath(target);break;}
        catch(error){
          if(error.code!=='ENOENT'||path.dirname(target)===target)throw error;
          if(await lstat(target).then(stat=>stat.isSymbolicLink(),()=>false))return {block:true,reason:'无法验证链接指向。'};
          target=path.dirname(target);
        }
      }
      const relative=path.relative(root,target);
      if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))return {block:true,reason:'目标不在知微选定的项目目录内。'};
    }else if(event.toolName!=='bash')return {block:true,reason:'此工具未在知微启用。'};
    const message=JSON.stringify({tool:event.toolName,input:event.input});
    if(event.toolName==='bash'&&message.length>1500)return {block:true,reason:'命令过长，无法完整展示供审批。'};
    const preview=message.length>1500?message.slice(0,1500)+'…':message;
    if(!await ctx.ui.confirm('知微工具审批',preview))return {block:true,reason:'本次工具操作未获批准。'};
  });
}
