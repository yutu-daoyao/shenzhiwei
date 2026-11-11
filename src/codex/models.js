import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export class ModelSelection {
  constructor(client,directory){this.client=client;this.file=path.join(directory,'model-settings.json');this.selected='gpt-6-luna';this.models=[];}
  async load(){
    try{const value=JSON.parse(await readFile(this.file,'utf8'));if(typeof value.model!=='string'||!/^[\w.-]{1,100}$/.test(value.model))throw new Error('invalid');this.selected=value.model;this.effort=typeof value.effort==='string'?value.effort:'';}
    catch(error){if(error.code!=='ENOENT')throw new Error('本机模型设置无法读取，请检查 data/model-settings.json；原文件未覆盖。');}
  }
  snapshot(){
    const levels=this.models.find(model=>model.id===this.selected)?.efforts??[];
    const effort={selected:levels.includes(this.effort)?this.effort:'',options:levels.map(id=>({id,name:id})),canReset:true};
    return {selected:this.selected,options:this.models,effort,error:this.error??null};
  }
  async refresh(){
    if(this.refreshing)return this.refreshing;
    this.refreshing=(async()=>{
      try{
        const models=[];let cursor;
        for(let page=0;page<10;page++){
          const response=await this.client.rpc.request('model/list',{limit:100,...(cursor?{cursor}:{})});
          if(!Array.isArray(response.data))throw new Error('Codex 没有返回可选模型列表');
          for(const m of response.data)if(typeof m.model==='string'&&typeof m.displayName==='string')models.push({id:m.model,name:m.displayName,efforts:[...new Set((m.supportedReasoningEfforts??[]).map(x=>x.reasoningEffort).filter(id=>typeof id==='string'&&id))]});
          cursor=response.nextCursor;if(!cursor)break;
        }
        this.models=[...new Map(models.map(m=>[m.id,m])).values()];this.error=null;this.client.changed();return this.snapshot();
      }catch(error){this.error='无法读取 Codex 模型列表，请重新连接后重试。';throw error;}
      finally{this.refreshing=null;}
    })();return this.refreshing;
  }
  async current(){
    if(!this.models.length)await this.refresh();
    const model=this.models.find(m=>m.id===this.selected);
    if(!model)throw new Error('当前选择的模型不可用，请在页面重新选择；不会偷偷切换其他模型。');
    return {...model,effort:model.efforts.includes(this.effort)?this.effort:undefined};
  }
  async select(id,{effort}={}){
    return this.client.exclusive(async()=>{
      if(this.client.busy||this.client.voice.enabled||this.client.voice.changing||this.client.realtime.active)throw new Error('请先停止任务并关闭语音，再切换模型。');
      this.client.ready();if(!this.models.length)await this.refresh();
      const model=this.models.find(m=>m.id===id);
      if(!model)throw new Error('请选择 Codex 列表中可用的模型。');
      if(effort!==undefined&&(id!==this.selected||effort!==''&&!model.efforts.includes(effort)))throw new Error('请为当前模型选择可用的思考强度。');
      const level=effort??(id===this.selected?this.effort:'');
      await mkdir(path.dirname(this.file),{recursive:true});const temporary=this.file+'.'+randomUUID()+'.tmp';
      try{await writeFile(temporary,JSON.stringify({model:id,...(level?{effort:level}:{})}),{mode:0o600});await rename(temporary,this.file);}finally{await unlink(temporary).catch(()=>{});}
      this.selected=id;this.effort=level;this.client.changed();return this.snapshot();
    });
  }
}
