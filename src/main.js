import {DesktopVoice} from './desktop/controller.js';
import {WeatherForecast,weatherLocation} from './server/weather.js';
import {ProjectCatalog} from './projects/catalog.js';
import http from 'node:http';
import {spawn} from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TrayController } from './tray/controller.js';
import { Zhiwei } from './client.js';
import { safeError } from './codex/process.js';
import { Computer } from './windows/computer.js';
import { WorkspaceFiles } from './server/files.js';
import { memoryList, memoryDelete } from './server/memory.js';
import { attachBrowserAudio } from './voice/browser-audio.js';
import { ModelSelection } from './codex/models.js';
import {Workbench} from './workbench/hub.js';
import {readJson,writeJson} from './workbench/storage.js';
import {clearInstalledSession,installedSessionReady} from './voice/bageshuo/auth.js';
import {prepareBageshuo} from './voice/bageshuo/asr.js';
import {agentDesktopConfig} from './agent-desktop.js';
import {Voiceprint} from './voice/voiceprint.js';
import {sharedMemoryFile} from './memory/shared.js';
import {grokBotPath} from './workbench/discovery.js';
import {mikaWechat} from './server/mika-wechat.js';

export const root = fileURLToPath(new URL('../', import.meta.url));
export async function start({ port = Number(process.env.PORT || 4317), dataDir = path.join(root, 'data'), workspace = path.join(root, 'test-workspace'), rpc, computer: suppliedComputer, voiceOptions, createExecutor, prepareRecognition=prepareBageshuo, voiceEnabled = process.env.ZHIWEI_VOICE_ENABLED === '1', tray: suppliedTray, trayEnabled = process.platform === 'win32', autostart = process.env.ZHIWEI_AUTOSTART === '1' } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT 必须为有效端口号');
  await mkdir(workspace, { recursive: true });
  const files = new WorkspaceFiles(workspace);
  const weather=new WeatherForecast();
  await files.checkRoot();
  const recognitionFile=path.join(dataDir,'voice-recognition.json');
  const recognition=voiceOptions?{asr:'dashscope',useInstalledSession:false}:await readJson(recognitionFile,{asr:'dashscope',useInstalledSession:false});
  if(!['dashscope','bageshuo'].includes(recognition.asr)||typeof recognition.useInstalledSession!=='boolean')throw new Error('语音识别设置无效，原设置未覆盖。');
  const computer = suppliedComputer ?? (!rpc && process.platform === 'win32' ? new Computer({ workspace, dataDir:path.join(dataDir,'windows') }) : null);
  if (computer) await computer.start();
  const client = new Zhiwei({ workspace, dataDir, rpc, computer, desktopMcp:rpc?null:agentDesktopConfig(dataDir), voiceOptions:voiceOptions ?? {config:{provider:'dashscope',asr:recognition.asr,asrOptions:{useInstalledSession:recognition.useInstalledSession},tts:'dashscope',spokenModes:true,pipelineOptions:{confirmBargeIn:true},ttsOptions:{model:'cosyvoice-v2',voice:'longwan_v2',rate:1.2}}} });
  const voiceprint=await new Voiceprint({dataDir}).load();client.voice.config.voiceprint=voiceprint;voiceprint.on('change',()=>client.voice.changed());
  const browserVoiceOnly=!voiceOptions;
  let storageError;
  try { await client.sessions.load(); }
  catch (error) { storageError = safeError(error); client.error = storageError; client.connection = 'error'; }
  client.models=new ModelSelection(client,dataDir);
  try{await client.models.load();}catch(error){storageError=safeError(error);client.error=storageError;client.connection='error';}
  client.memoryFile=await sharedMemoryFile(dataDir);await client.openMemory();
  const workbench=new Workbench({client,dataDir,createExecutor});
  try{await workbench.load();}catch(error){storageError=safeError(error);workbench.storageError=storageError;client.error=storageError;client.connection='error';}
  const oldChat=await readJson(path.join(dataDir,'everyday.json'),null).catch(()=>null);
  const archivedChat=Array.isArray(oldChat?.messages)
    ? oldChat.messages.slice(-20).filter(m=>['user','assistant'].includes(m?.role)&&typeof m.text==='string').map(({role,text})=>({role,text}))
    : [];
  const csrf = randomBytes(32).toString('hex');
  const streams = new Set();
  let origin;
  let desktop;
  let flushTimer;
  let closePromise;
  const snapshot = () => ({ ...workbench.snapshot(), desktop:desktop?.snapshot(), archivedChat, memory:{directory:path.dirname(client.memoryFile),shared:true},csrf });
  const push = response => {
    // Complete snapshots make EventSource reconnects idempotent: no replay/duplicate deltas.
    if (response.writableLength > 2 * 1024 * 1024) { response.destroy(); return; }
    response.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  };
  workbench.on('change', () => {
    if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; for (const response of streams) push(response); }, 40);
  });
  client.voice.on('level', voice => {
    const event = `event: voice-level\ndata: ${JSON.stringify(voice)}\n\n`;
    for (const response of streams) {
      if (response.writableLength > 2 * 1024 * 1024) { response.destroy(); continue; }
      response.write(event);
    }
  });
  const staticFiles = {
    '/scene-mobius.png':['scene-mobius.png','image/png'],
    '/scene-city.png':['scene-city.png','image/png'],
    '/folder.svg':['folder.svg','image/svg+xml'],
    '/waves.svg':['waves.svg','image/svg+xml'],
    '/mic.svg':['mic.svg','image/svg+xml'],
    '/keyboard.svg':['keyboard.svg','image/svg+xml'],
    '/stop.svg':['stop.svg','image/svg+xml'],
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/audio-check.js': ['audio-check.js', 'text/javascript; charset=utf-8'],
    '/caption-playback.js':['caption-playback.js','text/javascript; charset=utf-8'],
    '/caption-playback-worklet.js':['caption-playback-worklet.js','text/javascript; charset=utf-8'],
    '/local-captions.js':['local-captions.js','text/javascript; charset=utf-8'],
    '/caption-pipeline.js':['caption-pipeline.js','text/javascript; charset=utf-8'],
    '/task-scene.js':['task-scene.js','text/javascript; charset=utf-8'],
    '/reply-view.js':['reply-view.js','text/javascript; charset=utf-8'],
    '/work-surface.js':['work-surface.js','text/javascript; charset=utf-8'],
    '/workbench-view.js':['workbench-view.js','text/javascript; charset=utf-8'],
    '/wechat-view.js':['wechat-view.js','text/javascript; charset=utf-8'],
    '/dashboard.js':['dashboard.js','text/javascript; charset=utf-8'],
    '/orb.js': ['orb.js', 'text/javascript; charset=utf-8'],
    '/artwork-motion.js': ['artwork-motion.js', 'text/javascript; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/approval-view.js': ['approval-view.js', 'text/javascript; charset=utf-8'],
    '/memory-view.js': ['memory-view.js', 'text/javascript; charset=utf-8'],
    '/conversation-export.js': ['conversation-export.js', 'text/javascript; charset=utf-8'],
    '/native-voice.js': ['native-voice.js', 'text/javascript; charset=utf-8'],
    '/bailian-voice.js': ['bailian-voice.js', 'text/javascript; charset=utf-8'],
    '/voiceprint-view.js':['voiceprint-view.js','text/javascript; charset=utf-8'],
    '/voice-worklet.js': ['voice-worklet.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'],
  };
  const tray = suppliedTray ?? (trayEnabled && !rpc ? new TrayController() : null);
  try {
    desktop=await new DesktopVoice({workbench,tray,dataDir,...(rpc||!tray?{createCapture:()=>null}:{})}).load();
  } catch(error) { await workbench.close();await voiceprint.close();throw error; }
  workbench.desktop=desktop;
  desktop.on('change',()=>workbench.changed());
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy','geolocation=(self)');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
    try {
      if (closePromise) return json(503, { error:'知微正在退出' });
      if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin) || request.headers['sec-fetch-site'] === 'cross-site') return json(403, { error: '访问来源不允许，请从本机启动地址打开页面。' });
      const url = new URL(request.url, origin);
      if (request.method === 'GET' && staticFiles[url.pathname]) {
        const [file, mime] = staticFiles[url.pathname];
        const body = await readFile(path.join(root, 'public', file));
        response.writeHead(200, { 'Content-Type': mime }); response.end(body); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/state') return json(200, snapshot());
      if(request.method==='GET'&&url.pathname==='/api/workbench/ledger'){
        if(request.headers['x-zhiwei-csrf']!==csrf)return json(403,{error:'项目台账访问校验失败。'});
        return json(200,await workbench.readLedger());
      }
      if(request.method==='GET'&&url.pathname==='/api/workbench/changes'){
        if(request.headers['x-zhiwei-csrf']!==csrf)return json(403,{error:'改动访问校验失败'});
        return json(200,await workbench.changes());
      }
      if(request.method==='GET'&&url.pathname==='/api/weather'){
        if(request.headers['x-zhiwei-csrf']!==csrf)return json(403,{error:'天气访问校验失败'});
        try{return json(200,await weather.read(weatherLocation(url.searchParams.get('latitude'),url.searchParams.get('longitude'))));}
        catch(error){return json(/坐标/.test(error.message)?400:502,{error:error.message});}
      }
      if(request.method==='GET'&&['/api/projects','/api/projects/read'].includes(url.pathname)){
        if(request.headers['x-zhiwei-csrf']!==csrf)return json(403,{error:'项目访问校验失败'});
        const agent=url.searchParams.get('agent')??undefined;
        return json(200,url.pathname.endsWith('/read')?await workbench.readProject(url.searchParams.get('id'),agent):await workbench.catalog(url.searchParams.get('query')||'',agent));
      }
      if(request.method==='GET'&&url.pathname==='/api/models'){
        if(request.headers['x-zhiwei-csrf']!==csrf)return json(403,{error:'模型访问校验失败，请刷新页面。'});
        workbench.ready();return json(200,await workbench.active.models.refresh());
      }
      if (request.method === 'GET' && url.pathname === '/api/memory') {
        if (request.headers['x-zhiwei-csrf'] !== csrf) return json(403, { error: '记忆访问校验失败，请刷新页面。' });
        const result = memoryList(client.memory, url.searchParams);
        return json(result.status, result.body);
      }
      if (request.method === 'GET' && ['/api/files', '/api/files/preview', '/api/files/download'].includes(url.pathname)) {
        if (request.headers['x-zhiwei-csrf'] !== csrf) return json(403, { error: '文件访问校验失败，请刷新页面。' });
        if(url.searchParams.has('projectId')&&url.searchParams.get('projectId')!==workbench.project?.id)return json(409,{error:'项目已切换，请刷新文件列表。'});
        try {
          const activeFiles=await workbench.files();
          if (url.pathname === '/api/files') return json(200, await activeFiles.list());
          const { bytes, ...metadata } = await activeFiles.read(url.searchParams.get('name'), url.pathname.endsWith('/download'));
          if (!url.pathname.endsWith('/download')) return json(200, metadata);
          const encoded = encodeURIComponent(metadata.name).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
          response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="zhiwei-output.txt"; filename*=UTF-8''${encoded}`, 'Content-Length': bytes.length });
          response.end(bytes); return;
        } catch(error) {
          if(error.code) return json(400,{error:error.code==='ENOENT'?'文件已移动或不存在，请刷新工作文件列表。':'文件暂时无法读取，请检查工作目录及文件权限后刷新。'});
          throw error;
        }
      }
      if (request.method === 'GET' && url.pathname === '/api/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        streams.add(response); push(response);
        const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 15000);
        response.on('close', () => { clearInterval(heartbeat); streams.delete(response); });
        return;
      }
      if (request.method !== 'POST' || !url.pathname.startsWith('/api/')) return json(404, { error: '接口不存在' });
      if (request.headers.origin !== origin || request.headers['x-zhiwei-csrf'] !== csrf || request.headers['content-type'] !== 'application/json') return json(403, { error: '本地写接口校验失败，请刷新页面后重试。' });
      if (storageError) return json(503, { error: storageError });
      request.setEncoding('utf8');
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
        if (Buffer.byteLength(raw) > (url.pathname==='/api/voiceprint'?2000000:150000)) return json(413, { error: '请求过大' });
      }
      let body;
      try { body = JSON.parse(raw || '{}'); }
      catch { return json(400, { error: '请求必须为有效 JSON。' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: '请求格式错误' });
      let result;
      switch (url.pathname) {
        case '/api/voiceprint':{
          workbench.guardSwitch();if(workbench.busyClient())throw Error('请先结束任务和语音，再设置声纹');
          const decode=value=>{if(typeof value!=='string'||value.length>640000||!value.length||value.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw Error('声纹音频格式无效');return Buffer.from(value,'base64');};
          workbench.switching=true;workbench.changed();
          try{
            if(body.action==='configure')result=await voiceprint.configure(body);
            else if(body.action==='delete')result=await voiceprint.remove();
            else if(body.action==='enroll'){if(body.consent!==true||!Array.isArray(body.samples)||body.samples.length!==3)throw Error('请同意本机声纹保存并录制三段本人语音');const samples=[];try{for(const sample of body.samples)samples.push(decode(sample));result=await voiceprint.enroll(samples,{consent:true});}finally{samples.forEach(s=>s.fill(0));}}
            else if(body.action==='test'){const pcm=decode(body.sample);try{result=await voiceprint.verify(pcm);}finally{pcm.fill(0);}}
            else throw Error('声纹操作无效');
          }finally{workbench.switching=false;workbench.changed();}
          break;
        }
        case '/api/workbench/project': result=await workbench.register(body);break;
        case '/api/workbench/project/new': result=await workbench.createProject(body);break;
        case '/api/workbench/open-agent': result=await workbench.openAgent(body.agent);break;
        case '/api/workbench/select': result=await workbench.select(body);break;
        case '/api/daily/wechat': result=await mikaWechat(body);break;
        case '/api/workbench/agents/scan': await workbench.refreshAgents();result={agents:workbench.snapshot().workbench.agents};break;
        case '/api/workbench/grok-bot/open': {
          if(process.platform!=='win32')throw Error('请从桌面打开 Grok Bot。');
          const exe=grokBotPath();
          await new Promise((resolve,reject)=>{
            const child=spawn(exe,[],{detached:true,stdio:'ignore'});
            child.once('error',()=>reject(Error('无法启动 Grok Bot，请确认桌面版已安装。')));
            child.once('spawn',()=>{child.unref();resolve();});
          });
          result={opened:true};break;
        }
        case '/api/workbench/question':
          if(!workbench.active.answerQuestion)throw new Error('当前执行器没有待回答问题');
          result=await workbench.active.answerQuestion(body);break;
        case '/api/model': result=await workbench.selectModel(body.model,body);break;
        case '/api/memory/delete': {
          const result = memoryDelete(client.memory, body);
          return json(result.status, result.body);
        }
        case '/api/connect': await workbench.connect(); break;
        case '/api/new': result = await workbench.newThread(); break;
        case '/api/resume': result = await workbench.resume(body.id); break;
        case '/api/plan': workbench.assertDispatch(body); result = await workbench.runPlan(body.text); break;
        case '/api/memory/remember':
          if(!client.memory)throw Error('长期记忆不可用');if(typeof body.text!=='string'||!body.text.trim()||body.text.length>2000)throw Error('请填写 1–2000 字明确需要保存的事实或偏好');result=client.memory.remember(body.text.trim(),'用户手动保存');workbench.changed();break;
        case '/api/send': workbench.assertDispatch(body); result = await workbench.send(body.text); break;
        case '/api/stop': await desktop?.stop();await workbench.interrupt(); break;
        case '/api/desktop/settings': await desktop.configure(body);break;
        case '/api/realtime/start':
          if(desktop.voice)throw Error('请先结束后台语音。');
          if(voiceprint.enabled)throw Error('本人声纹用于网易或百炼识别，请切换语音线路。');
          if(client.voice.config.spokenModes)throw Error('请使用网易或百炼语音。原生 Juniper 无法在回答前应用本机唤醒规则。');
          if(client.voice.enabled||client.voice.changing)throw new Error('请先关闭百炼语音');
          if(workbench.project?.agent==='codex')await workbench.active.exclusive(()=>workbench.active.acquireWriter());
          result=await workbench.realtime.start(body.sdp,{language:body.language,captionEngine:body.captionEngine}); break;
        case '/api/realtime/connected': workbench.realtime.connected(body.session); break;
        case '/api/realtime/stop':
          if(body.session!==undefined&&typeof body.session!=='string')throw new Error('语音会话编号无效');
          await workbench.realtime.stop(body.session); break;
        case '/api/voice':
          if (typeof body.enabled !== 'boolean') throw new Error('语音开关必须为布尔值');
          if(body.enabled&&browserVoiceOnly)throw new Error('请在网页点击开始语音对话，使用带回声消除的浏览器麦克风。');
          if (body.enabled) workbench.ready();
          if (body.enabled && desktop.voice)throw Error('请先结束后台语音。');
          if (body.enabled && workbench.realtime.active) throw new Error('请先关闭 Codex 原生语音');
          await client.voice.setEnabled(body.enabled); break;
        case '/api/voice/mode': result={text:client.voice.setSpokenMode(body.mode),mode:client.voice.mode};break;
        case '/api/voice/recognition':{
          if(!['dashscope','bageshuo'].includes(body.asr)||typeof body.useInstalledSession!=='boolean')throw new Error('请选择有效的语音识别方式，并明确是否允许使用叭哥说登录。');
          if(body.asr==='bageshuo'&&body.useInstalledSession!==true)throw new Error('选择网易叭哥说前，请明确勾选使用本机叭哥说登录会话。');
          const next={asr:body.asr,useInstalledSession:body.asr==='bageshuo'&&body.useInstalledSession};
          const refreshingPaused=next.asr==='bageshuo'&&client.voice.config.asr===next.asr&&client.voice.config.asrOptions?.useInstalledSession===true;
          workbench.guardSwitch({allowPausedVoice:refreshingPaused});
          if(workbench.busyClient())throw new Error('请先停止当前任务，再更换语音识别方式。');
          workbench.switching=true;workbench.changed();
          try{
            if(next.asr==='bageshuo')await prepareRecognition({authorized:true});
            await writeJson(recognitionFile,next);
            if(next.asr!=='bageshuo')clearInstalledSession();
            client.voice.config.asr=next.asr;client.voice.config.asrOptions={...client.voice.config.asrOptions,useInstalledSession:next.useInstalledSession};client.voice.error=null;
            result={...next,sessionReady:installedSessionReady()};
          }catch(error){
            if(next.asr==='bageshuo'&&client.voice.config.asr===next.asr)client.voice.error=safeError(error);
            throw error;
          }finally{workbench.switching=false;workbench.changed();}
          break;
        }
        case '/api/voice/ptt':
          if (body.action === 'start') workbench.ready();
          client.voice.ptt(body.action); break;
        case '/api/approval': await workbench.approve(body.id, body.decision); break;
        case '/api/workbench/approval-policy': result=await workbench.setAutoApproveReads(body.enabled);break;
        case '/api/windows/approval':
          if (!workbench.computer) throw new Error('当前项目未连接 Windows 工具');
          workbench.computer.approve(body.id, body.decision); break;
        case '/api/windows/status':
          if (!workbench.computer) throw new Error('当前项目未连接 Windows 工具');
          result = await workbench.computer.checkDesktop(); break;
        case '/api/windows/resolve':
          if(!workbench.computer)throw new Error('当前项目未连接 Windows 工具');
          await workbench.computer.resolveAction(body.id,body.resolution);break;
        default: return json(404, { error: '接口不存在' });
      }
      json(200, result || { ok: true });
    } catch (error) { json(400, { error: safeError(error) }); }
  });
  server.requestTimeout = 45000;
  server.headersTimeout = 10000;
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
  catch (error) { await desktop.close(); await client.close(); throw error; }
  origin = `http://127.0.0.1:${server.address().port}`;
  const browserAudio=attachBrowserAudio(server,workbench,{origin,csrf,closing:()=>!!closePromise||!!desktop?.voice});
  let acceptingTrayActions = false;
  const updateTray = () => tray?.setListening(client.voice.inputEnabled??client.voice.enabled);
  const trayAction = action => {
    if (!acceptingTrayActions) return;
    if (action === 'exit') { void close().catch(error => console.error(safeError(error))); return; }
    if (!['start', 'stop'].includes(action)) return;
    if(action==='stop'&&desktop.voice){void desktop.stop();return;}
    if(action==='start'&&browserVoiceOnly){client.log('后台语音：按住 Ctrl＋空格说话，松开发送。');return;}
    if(browserVoiceOnly){
      if(action==='start')client.log('请在网页点击开始语音输入，使用浏览器回声消除。');
      else {client.voice.setInput(false);client.voice.capture?.pauseInput?.();}
      return;
    }
    Promise.resolve().then(() => {
      if (action === 'start') { if (storageError) throw new Error(storageError); workbench.ready(); }
      return client.voice.setEnabled(action === 'start');
    }).catch(error => client.log(`托盘聆听失败：${safeError(error)}`));
  };
  if (tray) {
    tray.on('failure', error => client.log(`托盘不可用：${safeError(error)}`));
    tray.on('action', trayAction);
    client.voice.on('change', updateTray);
    try { await tray.start({ origin, listening:client.voice.enabled, autostart, desktopEnabled:desktop.settings.enabled }); }
    catch (error) { client.log(`托盘启动失败：${safeError(error)}`); }
  }
  const ready = storageError ? Promise.resolve() : workbench.connect().then(async () => {
    if (voiceEnabled && !closePromise && !browserVoiceOnly) await client.voice.setEnabled(true);
  }).catch(error => { if (voiceEnabled) client.log(`语音启动失败：${safeError(error)}`); });
  if(!rpc)void workbench.refreshAgents().catch(()=>{});
  acceptingTrayActions = true;
  function close() {
    return closePromise ??= (async () => {
      acceptingTrayActions = false;
      clearInstalledSession();
      await desktop.close();
      browserAudio.close();
      client.voice.off('change', updateTray);
      tray?.off('action', trayAction);
      // Mark the client closing now; pending connection/voice startup cannot revive it.
      const results = await Promise.allSettled([tray?.close(), workbench.close(), ready]);
      await voiceprint.close();
      clearTimeout(flushTimer);
      for (const response of streams) response.end();
      await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    })();
  }
  return { server, client, workbench, origin, ready, close, tray, desktop };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const app = await start();
    console.log(`沈知微 Zhiwei：${app.origin}`);
    console.log('使用 ChatGPT 官方登录；Ctrl+C 正常退出。首次连接状态请查看网页。');
    let closing = false;
    const shutdown = async () => { if (closing) return; closing = true; await app.close(); process.exit(0); };
    process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  } catch (error) { console.error(`启动失败：${safeError(error)}。如端口占用，可设置 PORT=4318。`); process.exitCode = 1; }
}
