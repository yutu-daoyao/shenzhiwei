export function isVoiceFiller(text) {
  return typeof text==='string'&&/^(?:[嗯呃额啊唔哦欸诶哼]|u+m+|u+h+|h+m+)+$/iu.test(text.replace(/[\p{P}\s~～]/gu,''));
}

// Only explicit task controls preempt work. Quoted examples remain ordinary speech.
export function voiceTaskControl(text) {
  if(typeof text!=='string')return 'append';
  const value=text.normalize('NFKC').trim();
  if(/[“”「」『』"']/.test(value)||/^(?:比如|例如|如果|假如|解释|翻译|重复|他说|她说)/u.test(value))return 'append';
  const compact=value.replace(/[，。！？,.!?\s]/gu,'').replace(/^(?:沈)?知微/u,'');
  if(['停','停止','停下','停一下','停止任务','取消任务','别做了','全部停止','取消所有任务'].includes(compact))return 'stop';
  if(/(?:先|优先|马上|立即)(?:帮我|给我|去)?(?:做|完成|处理|执行|打开)/u.test(value)
    ||/(?:前面|之前|刚才|原来|一二|第一|第二).{0,16}(?:不用管|不要管|别管|不用做|不要做|别做|取消|暂停)/u.test(value))return 'replace';
  return 'append';
}

// Match only at the beginning, using an explicit set of known ASR spellings.
const leadingWake=/^(?:沈)?(知微|志威|知危|知为|知威|知薇|志微|志薇|芝微|芝薇|芝威|芷微|芷薇|智微|智威|智薇|之微|之威|之薇)/u;
export const spokenModeLabels={default:'默认',dialog:'对话',ptt:'按键'};
export function spokenModeText(text,mode,continuation=false){
  if(typeof text!=='string')return '';
  const value=text.normalize('NFKC').trim();
  const address=continuation?null:value.match(leadingWake);
  if(mode==='default'&&!address)return '';
  const command=address?value.slice(address[0].length).replace(/^[\p{P}\s]+/u,''):value;
  return isVoiceFiller(command)?'':command;
}
export function requestedSpokenMode(text,{requireWake=true}={}){
  const command=spokenModeText(text,requireWake?'default':'dialog').replace(/\s+/gu,'').replace(/[。！？.!?]+$/u,'');
  const match=command.match(/^(?:请)?(?:帮我|给我)?(?:切换(?:到|成|为)?|切到|切成|改成|开启|进入|回到|恢复)(默认|唤醒|自由对话|对话|按键|控制)模式(?:[（(]按键[）)])?吧?$/u);
  return {默认:'default',唤醒:'default',自由对话:'dialog',对话:'dialog',按键:'ptt',控制:'ptt'}[match?.[1]];
}

const agentNames=new Map(Object.entries({
  codex:'codex',opencode:'opencode',workbuddy:'workbuddy',deepseekharness:'dsh',dsh:'dsh',
  hermes:'hermes',hermesagent:'hermes',反重力:'antigravity',antigravity:'antigravity',
  pi:'pi',geminicli:'gemini-cli',
}));
function localCommand(text){return spokenModeText(text,'dialog').replace(/\s+/gu,'').replace(/[。！？.!?]+$/u,'').toLowerCase();}
export function requestedAgentSwitch(text){
  const match=localCommand(text).match(/^(?:请)?(?:帮我|给我)?(?:把(?:agent|执行器))?(?:切换(?:一下)?(?:agent|执行器)?(?:到|成|为)?|切到|换成)([\p{L}-]+?)(?:agent|执行器)?吧?$/u);
  return agentNames.get(match?.[1].replaceAll('-',''));
}
export function requestedBrowser(text){
  const command=localCommand(text);
  const direct=command.match(/^(?:请)?(?:帮我|给我)?(?:打开|启动)(?:我的)?(微软(?:的)?(?:edge(?:浏览器)?|浏览器)|(?:microsoft)?edge(?:浏览器)?|(?:google)?chrome(?:浏览器)?|谷歌(?:的)?浏览器)吧?$/u);
  if(direct)return /chrome|谷歌/u.test(direct[1])?'chrome':'edge';
  if(/^(?:请)?(?:帮我|给我)?打开(?:我的)?浏览器吧?[,，]?(?:就)?用(?:微软(?:的)?浏览器|(?:microsoft)?edge)吧?$/u.test(command))return 'edge';
}

export const voiceTaskInstructions='用户一次说出多个要求时，全部保留并逐项反馈，不得只执行第一项。用户补充说明时及时更新当前任务。用户说优先/先做新任务或前面的不用管时，以最新指令为准，停止旧任务和旧待办，不自动恢复；只有用户明确要求继续时才恢复。转写与委派中的同一条语音是同一个请求，不重复执行。语音回答简短自然，只说结论和下一步，不朗读网址、域名、链接路径、Markdown标记或大段代码。链接与代码留在文字界面，必要时只说“链接已放在界面”。';
