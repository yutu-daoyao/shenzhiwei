export function sceneForText(text = '') {
  const request=text.trim().replace(/^(?:知微[，、,：:\s]*)?(?:(?:请|帮我|麻烦你|给我)\s*)*/,'');
  return /^(?:导航(?:到|去|至|前往|[，。！？\s]|$)|带我去|(?:打开|开启|启动|开始)(?:地图)?导航(?:到|去|至|前往|[，。！？\s]|$)|navigate to\b|(?:get )?directions to\b|start navigation\b)/i.test(request) ? 'city' : 'mobius';
}

// The city is an illustration for an active navigation request.
export function sceneForState(state) {
  const items=state.items||[];
  const index=items.findLastIndex(item=>item.type==='userMessage'&&item.text?.trim());
  const user=items[index];
  if(sceneForText(user?.text)!=='city')return 'mobius';
  const task=state.task;
  const active=['starting','running'].includes(task?.status);
  const sameTurn=!user.turnId||task?.turnId===user.turnId;
  if(active&&sameTurn)return 'city';
  if(task?.status==='completed'&&task.turnId&&sameTurn)return 'mobius';
  if(!['failed','interrupted','stopping'].includes(task?.status)&&state.realtime?.status==='connected'&&
    index>items.findLastIndex(item=>item.type==='agentMessage'&&item.text?.trim()))return 'city';
  return 'mobius';
}
