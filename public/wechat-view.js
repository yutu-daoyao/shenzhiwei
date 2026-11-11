const terminal=new Set(['done','failed','cancelled']);
const automatic=new Set(['starting','queued','running']);
const labels={
  starting:'已提交，等待手机接收',queued:'手机端排队中',running:'手机正在处理',
  paused:'任务暂停，请查看手机',waiting_for_answer:'请在 Mika 手机上回答问题',
  waiting_on_phone:'请在手机上处理确认步骤',done:'Mika 已结束，请核对下面的结果',
  failed:'Mika 报告任务失败',cancelled:'任务已停止',
};

export function mountWechat({document,api,confirm=message=>window.confirm(message)}){
  const $=id=>document.getElementById('wechat-'+id);
  let task,busy=false,timer;
  const show=text=>{$('status').textContent=text;};
  function update(){
    for(const id of ['read','draft','send','contact','port','token','message'])$(id).disabled=busy||!!task;
    for(const id of ['refresh','cancel','reset'])$(id).disabled=busy||!task;
  }
  function result(value){
    const text=[value.answer,value.progress,value.question,value.reason,value.verification_note,value.error,value.note,...(Array.isArray(value.unconfirmed)?value.unconfirmed:[])].filter(part=>typeof part==='string'&&part.trim());
    $('result').textContent=text.join('\n\n');
    if(terminal.has(value.status))task=null;
    show(labels[value.status]||'Mika 状态待确认，请到手机查看。');
  }
  async function check(action='status'){
    if(!task||busy)return;
    clearTimeout(timer);busy=true;update();
    try{
      const value=await api('daily/wechat',{...task.connection,action,taskId:task.id});
      if(action==='cancel'&&!value.status)show('已请求停止，请刷新确认最终状态。');
      else result(value);
      if(task&&automatic.has(value.status))schedule();
    }catch(error){show(error.message+' 请先在手机或按原任务编号核对。');}
    finally{busy=false;update();}
  }
  function schedule(){clearTimeout(timer);timer=setTimeout(()=>{if(!$('panel').hidden)void check();},2500);}
  async function begin(action){
    if(busy||task)return;
    const contact=$('contact').value.trim(),message=$('message').value;
    const connection={port:Number($('port').value),token:$('token').value.trim()};
    if(!contact||!Number.isInteger(connection.port)||connection.port<1024||connection.port>65535||connection.token.length<20){
      show('请填写本机 Mika USB 端口、令牌和联系人。');return;
    }
    if(action==='send'&&(!message.trim()||!confirm(`确认让 Mika 发给「${contact}」？\n\n${message}`)))return;
    const requestId=crypto.randomUUID();
    task={id:requestId,connection};busy=true;$('result').textContent='';show('正在交给 Mika…');update();
    try{
      const value=await api('daily/wechat',{...connection,action,contact,requestId,
        ...(action==='send'?{message,confirmed:true}:{})});
      task.id=value.task_id;result(value);if(task)schedule();
    }catch(error){show(error.message+' 请刷新原任务状态，或先到手机核对。');}
    finally{busy=false;update();}
  }
  for(const action of ['read','draft','send'])$(action).onclick=()=>void begin(action);
  $('refresh').onclick=()=>void check();
  $('cancel').onclick=()=>void check('cancel');
  $('reset').onclick=()=>{
    if(!task||busy||!confirm('清空这里只会忘记任务编号。已交给手机的任务仍可能在执行。你已在手机核对完毕吗？'))return;
    clearTimeout(timer);task=null;$('result').textContent='';show('已清空本页的任务状态。');update();
  };
  update();
}
