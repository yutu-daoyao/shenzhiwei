// Translate completed short phrases as speech arrives, without waiting for a whole reply.
export class StreamingCaption {
  constructor(translator,onChange){this.translator=translator;this.onChange=onChange;}
  reset(){this.current=null;}
  feed(id,source,done=false){
    source=source.trimStart();
    if(!source.trim()||!/[a-z]{3}/i.test(source)||/[\u4e00-\u9fff]/.test(source))return;
    let job=this.current;
    const protectedEnd=job?Math.max(job.offset,job.processingEnd||0):0;
    const preservesPrefix=job&&protectedEnd>0&&source.startsWith(job.source.slice(0,protectedEnd));
    if(job&&job.id!==id&&(source.startsWith(job.source)||preservesPrefix))job.id=id;
    if(!job||job.id!==id){job=this.current={id,source:'',offset:0,text:'',done:false,running:false,status:'pending'};}
    // A corrected transcript can invalidate translated prefixes; restart rather than splice wrong text.
    if(!source.startsWith(job.source)&&!preservesPrefix){job=this.current={id,source:'',offset:0,text:'',done:false,running:false,status:'pending'};}
    job.source=source;job.done=done;this.publish(job);void this.drain(job);
  }
  publish(job,partial=''){
    if(this.current!==job)return;
    this.onChange({id:job.id,source:job.source,text:job.text+partial,status:job.status,error:job.error});
  }
  async drain(job){
    if(job.running||job.status==='error')return;
    job.running=true;
    try{
      while(this.current===job){
        const rest=job.source.slice(job.offset);if(!rest.trim())break;
        const boundary=rest.match(/^([\s\S]*?[.!?](?:\s|$))/);
        let length=boundary?.[0].length||0;
        if(!length&&rest.length>=180){length=rest.lastIndexOf(' ',160);if(length<40)length=160;}
        if(!length&&job.done)length=rest.length;
        if(!length)break;
        length=Math.min(length,600);
        const chunk=rest.slice(0,length),base=job.text;job.processingEnd=job.offset+length;
        const translation=await this.translator.translate(chunk,delta=>{if(this.current===job){job.status='translating';this.publish(job,delta);}},()=>this.current===job);
        if(this.current!==job)return;
        job.offset+=length;job.text=base+translation+'\n';job.status='translating';this.publish(job);
      }
      if(this.current===job){job.status=job.done&&job.offset>=job.source.length?'ready':'pending';this.publish(job);}
    }catch(error){if(this.current===job){job.status='error';job.error=error.message;this.publish(job);}}
    finally{job.running=false;}
  }
}
