import { EventEmitter } from 'node:events';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeFile, readFile, lstat, realpath } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { SystemSkills, skillOps } from './skills.js';
import { WindowsBackend } from './backend.js';
import { readOnly, validate } from './tools.js';
import { WindowsJournal, windowProof } from './journal.js';

const keys = { 'Ctrl+A': '^a', 'Ctrl+C': '^c', Enter: '{ENTER}', Escape: '{ESC}', Tab: '{TAB}', Down: '{DOWN}', Up: '{UP}' };
const canonical = value => JSON.stringify(value, Object.keys(value || {}).sort());
const sameWindow = (a,b) => !!a && !!b && ['id','pid','processStartedAt','className','app','tabRuntimeId'].every(key=>a[key]===b[key]);
export class Computer extends EventEmitter {
  constructor({ workspace, dataDir, backend = new WindowsBackend(), skills = new SystemSkills({ workspace }) }) {
    super(); this.workspace = path.resolve(workspace); this.backend = backend; this.skills = skills;
    this.browserProfile = path.join(path.resolve(dataDir || path.join(this.workspace, '..', 'data')), 'browser-profile');
    this.actions = new Map(); this.pending = new Map(); this.owned = new Map(); this.captures = new Map();
    this.active = false; this.epoch = 0; this.queue = Promise.resolve();
    this.invocations = [];
    this.bindings = new Map();this.journal = dataDir ? new WindowsJournal(dataDir) : null;
    this.registered = new Map();this.workerGeneration=0;
    this.backend.on('exit', () => { this.registered.clear();this.workerGeneration++;this.emit('change'); });
  }
  async start() {
    await this.assertWorkspace();
    if(this.journal) {
      try {
        const saved=await this.journal.load(this.workspaceReal);
        this.actions=new Map(saved.actions.map(a=>[a.id,a]));this.bindings=new Map(saved.bindings.map(b=>[b.id,b]));
        await this.persist();
      } catch(error) {this.storageError=error.message;}
    }
    this.secret = randomBytes(32).toString('hex');
    this.server = http.createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method !== 'POST' || req.url !== '/tool' || req.headers.host !== `127.0.0.1:${this.server.address().port}` || req.headers.origin || req.headers.authorization !== `Bearer ${this.secret}`) { res.writeHead(403); res.end('{}'); return; }
      let raw = ''; req.setEncoding('utf8');
      res.on('close', () => { if (!res.writableEnded) this.cancel(); });
      try {
        for await (const chunk of req) { raw += chunk; if (raw.length > 150000) throw new Error('工具请求过大'); }
        const { name, arguments: args } = JSON.parse(raw);
        validate(name, args);
        const deadline = Date.now() + 3000;
        const epoch = this.epoch;
        let index;
        do {
          index = this.invocations.findIndex(t => t.epoch === epoch && t.name === name && t.params === canonical(args));
          if (index >= 0) break;
          await delay(20);
        } while (this.active && this.epoch === epoch && Date.now() < deadline);
        if (index < 0 || !this.active || this.epoch !== epoch) throw new Error('此工具请求没有当前 Codex Turn 的调用记录，已拒绝过期或未登记请求。');
        this.invocations.splice(index, 1);
        const result = await this.call(name, args);
        res.end(JSON.stringify(result));
      } catch (error) { res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ ok: false, error: error.message, safeToRetry: false }) }], isError: true })); }
    });
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    this.url = `http://127.0.0.1:${this.server.address().port}/tool`;
  }
  config() {
    return { mcp_servers: { zhiwei_windows: { command: process.execPath, args: [fileURLToPath(new URL('./mcp-server.js', import.meta.url))], env: { ZHIWEI_WINDOWS_URL: this.url, ZHIWEI_WINDOWS_CAPABILITY: this.secret }, startup_timeout_sec: 15, tool_timeout_sec: 300 } } };
  }
  async persist() {
    if(!this.journal || this.storageError)return;
    try {await this.journal.save(this.workspaceReal,[...this.actions.values()],[...this.bindings.values()]);}
    catch {this.storageError='Windows 操作记录保存失败，已停止电脑操作；请检查磁盘与目录权限。';this.active=false;this.epoch++;this.rejectPending(this.storageError);this.backend.cancel();this.emit('change');throw new Error(this.storageError);}
  }
  checkpoint() {this.persist().catch(()=>{});}
  savedWindows() {
    return [...this.bindings.values()].map(b=>({id:b.id,app:b.proof.app,documentName:b.proof.documentName||null,updatedAt:b.updatedAt,status:b.status==='closed'?'closed':sameWindow(this.owned.get(b.proof.id),b.proof)?'bound':'needsApproval'}));
  }
  rememberWindow(window) {
    let binding=[...this.bindings.values()].find(b=>b.status!=='closed'&&sameWindow(b.proof,window));
    const now=new Date().toISOString();
    if(!binding)binding={id:randomUUID(),createdAt:now};
    Object.assign(binding,{proof:windowProof(window),updatedAt:now,status:'saved'});
    this.bindings.set(binding.id,binding);
    while(this.bindings.size>20)this.bindings.delete(this.bindings.keys().next().value);
    return binding.id;
  }
  invalidateWindow(window,closed) {
    if(!window)return;
    if(sameWindow(this.owned.get(window.id),window)) {
      this.owned.delete(window.id);this.registered.delete(window.id);
      if(this.currentWindow?.id===window.id)this.currentWindow=null;
    } else if(this.registered.get(window.id)===canonical(windowProof(window)))this.registered.delete(window.id);
    for(const binding of this.bindings.values())if(sameWindow(binding.proof,window)) {
      binding.status=closed?'closed':'saved';binding.updatedAt=new Date().toISOString();
    }
    for(const [id,capture] of this.captures)if(capture.windowId===window.id)this.captures.delete(id);
  }
  async registerWindow(window,epoch) {
    if(!window)throw new Error('窗口授权已失效，请重新申请恢复。');
    const signature=canonical(windowProof(window));
    if(this.registered.get(window.id)===signature)return;
    const generation=this.workerGeneration;
    await this.dispatch('register_windows',{windows:[window]},epoch);
    if(generation!==this.workerGeneration)throw new Error('Windows 工作进程已重启，登记结果无效，请重新观察。');
    this.registered.set(window.id,signature);
  }
  async resolveAction(id,resolution) {
    if(this.storageError)throw new Error(this.storageError);
    const action=this.actions.get(id);
    if(!action||action.status!=='unknown'||!['applied','notApplied','partial'].includes(resolution))throw new Error('只能核实结果未知的操作，并选择已执行、未执行或部分执行。');
    action.resolution=resolution;action.reviewedAt=new Date().toISOString();
    await this.persist();this.emit('change');
  }
  expectInvocation(name, params) { if (this.active && typeof name === 'string' && params && typeof params === 'object' && !Array.isArray(params)) { this.invocations.push({ epoch: this.epoch, name, params: canonical(params) }); this.invocations=this.invocations.slice(-100); } }
  async checkDesktop() {
    this.desktop = await this.backend.call('desktop_status', {});
    this.lastNote = this.desktop.locked ? 'Windows 已锁屏或处于安全桌面，需要本人解锁；没有执行电脑操作。' : '桌面可交互；具体操作仍需逐项授权。';
    this.emit('change');return this.desktop;
  }
  beginTurn() { this.active = true; this.epoch++; this.invocations = []; this.captures.clear(); this.emit('change'); }
  endTurn() { this.cancel(); this.lastNote='本轮任务已结束；未开始的操作已取消，已生效的动作不能回滚。'; this.emit('change'); }
  rejectPending(reason) { for (const p of this.pending.values()) p.resolve(false); this.pending.clear(); this.lastNote = reason; }
  cancel() {
    this.active = false; this.epoch++; this.rejectPending('已停止，未开始的 Windows 操作已取消');
    this.invocations = [];
    if (this.backend.pending?.size) { this.backend.cancel(); this.registered.clear(); }
    this.captures.clear(); this.emit('change');
    this.checkpoint();
  }
  snapshot() {
    const review=a=>a.status==='unknown'&&!a.resolution&&!readOnly.has(a.tool);
    const history=[...this.actions.values()];
    return { available: process.platform === 'win32', active: this.active, currentWindow: this.currentWindow || null, note: this.lastNote || null,
      desktop: this.desktop || {locked:null},
      storageError:this.storageError||null, savedWindows:this.savedWindows(),
      approvals: [...this.pending.values()].map(({ resolve, ...view }) => view), actions: [...history.filter(review),...history.filter(a=>!review(a)).slice(-60)].map(a=>({...a,needsReview:review(a)})) };
  }
  approve(id, decision) {
    const pending = this.pending.get(id);
    if (!pending || !['accept', 'decline'].includes(decision)) throw new Error('Windows 操作审批已失效或决定无效');
    this.pending.delete(id); pending.resolve(decision === 'accept'); this.emit('change');
  }
  async permission(action) {
    return new Promise(resolve => {
      this.pending.set(action.id, { id: action.id, tool: action.tool, params: action.params, target: action.target || null, risk: ['windows_close_window','windows_restore_window'].includes(action.tool) ? 'high' : action.tool === 'windows_capture_window' ? 'screenshot-to-Codex' : 'action', createdAt: action.startedAt, resolve });
      this.emit('change');
    });
  }
  assertTurn(epoch) {
    if (!this.active || epoch !== this.epoch) throw new Error('任务已停止或已切换，本次 Windows 操作不得继续派发。');
  }
  async dispatch(op, params, epoch) {
    this.assertTurn(epoch);
    const result = await this.backend.call(op, params);
    this.assertTurn(epoch);
    return result;
  }
  async assertWorkspace(epoch) {
    const stat = await lstat(this.workspace);
    const resolved = await realpath(this.workspace);
    if (epoch !== undefined) this.assertTurn(epoch);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (this.workspaceReal && resolved !== this.workspaceReal)) throw new Error('测试目录不是原始普通目录或已被重定向，已拒绝文件和应用操作。');
    this.workspaceReal ??= resolved;
  }
  call(name, params) {
    validate(name, params);
    if (name === 'windows_browser_search') params = { ...params, url: `https://www.bing.com/search?q=${encodeURIComponent(params.query)}` };
    if (name === 'windows_get_action_status') {
      const action = this.actions.get(params.actionId);
      return Promise.resolve({ content: [{ type: 'text', text: JSON.stringify(action || { ok: false, error: '操作不存在', safeToRetry: false }) }] });
    }
    if(name==='windows_list_saved_windows')return Promise.resolve({content:[{type:'text',text:JSON.stringify({ok:true,windows:this.savedWindows(),storageError:this.storageError||null})}]});
    if(this.storageError&&name!=='windows_get_desktop_status')throw new Error(this.storageError);
    if (!this.active) throw new Error('Windows 控制已停止，禁止派发新操作。请由用户开始新一轮任务。');
    const epoch = this.epoch;
    const id = randomUUID();
    const known=params.windowId?this.owned.get(params.windowId):params.bindingId?this.bindings.get(params.bindingId)?.proof:null;
    const expectedWindow=known?{...known}:null;
    const binding=[...this.bindings.values()].find(b=>b.status!=='closed'&&sameWindow(b.proof,expectedWindow));
    const scope={...((params.app || name === 'windows_browser_search')?{app:params.app || 'browser'}:{}),...(params.windowId?{windowId:params.windowId}:{}),...(binding?{bindingId:binding.id}:{})};
    const action = { id, tool: name, params, scope, status: 'queued', startedAt: new Date().toISOString(), safeToRetry: false };
    this.actions.set(id, action);
    while (this.actions.size > 100) {
      const old=[...this.actions.values()].find(a=>!['queued','awaitingApproval','running'].includes(a.status)&&!(a.status==='unknown'&&!a.resolution&&!readOnly.has(a.tool)));
      if(!old){this.actions.delete(id);throw new Error('待核实的操作记录过多，请先处理结果未知的操作。');}
      this.actions.delete(old.id);
    }
    this.checkpoint();
    const job = this.queue.then(async () => {
      try {
        if (!this.active || epoch !== this.epoch) { action.status = 'cancelled'; throw new Error('任务已停止，操作未执行'); }
        this.desktop = await this.dispatch('desktop_status', {}, epoch);
        if (this.desktop.locked && name !== 'windows_get_desktop_status') { this.lastNote='Windows 已锁屏或处于安全桌面，需要本人解锁；没有执行电脑操作。'; throw new Error(this.lastNote); }
        if (params.windowId && !this.owned.has(params.windowId)) throw new Error('只允许控制知微新启动并绑定的测试窗口；不接管用户已有窗口。');
        if (params.windowId && !sameWindow(this.owned.get(params.windowId),expectedWindow)) throw new Error('WINDOW_CHANGED: 排队期间窗口授权或身份已变化，请重新观察目标。');
        if(!readOnly.has(name)&&name!=='windows_restore_window'&&!(name==='windows_send_keys'&&params.key==='Escape')) {
          const unresolved=[...this.actions.values()].find(a=>a.id!==id&&a.status==='unknown'&&!a.resolution&&!readOnly.has(a.tool)&&((skillOps.has(name.slice(8))&&a.tool===name&&canonical(a.params)===canonical(params))||(scope.windowId&&a.scope?.windowId===scope.windowId)||(['windows_launch_app','windows_browser_search'].includes(name)&&['windows_launch_app','windows_browser_search'].includes(a.tool)&&a.scope?.app===scope.app)));
          if(unresolved)throw new Error(`此前操作 ${unresolved.id} 的结果未知。请先在操作记录中核实实际结果，再发新指令；不会自动重试。`);
        }
        if(name==='windows_restore_window') {
          const saved=this.bindings.get(params.bindingId);
          if(!saved||saved.status==='closed')throw new Error('没有可恢复的知微窗口记录。');
          const inspected=await this.dispatch('inspect_binding',{window:saved.proof},epoch);
          action.target={name:inspected.window.title,type:'Window',window:inspected.window,observedAt:new Date().toISOString()};
        }
        if (this.owned.get(params.windowId)?.app === 'explorer' && !readOnly.has(name) && !['windows_focus_window','windows_select_element','windows_capture_window','windows_close_window'].includes(name)) throw new Error('本阶段资源管理器仅允许查看测试目录、选择条目和聚焦，不允许执行文件或导航。');
        if(name==='windows_set_text' && expectedWindow?.app !== 'notepad') throw new Error('只能向知微启动的记事本输入文字');
        if(params.windowId)await this.registerWindow(this.owned.get(params.windowId),epoch);
        if (params.windowId && !readOnly.has(name)) {
          if (!params.elementId) {
            const fresh=await this.dispatch('get_window',{windowId:params.windowId},epoch);
            action.target={name:fresh.window.title,type:'Window',window:fresh.window,observedAt:new Date().toISOString()};
          }
        }
        if (params.elementId) {
          action.target = {...await this.dispatch('describe_element', params, epoch),observedAt:new Date().toISOString()};
        }
        if (!readOnly.has(name)) {
          action.status = 'awaitingApproval'; this.checkpoint(); this.emit('change');
          const permitted = await this.permission(action);
          if (!permitted || !this.active || epoch !== this.epoch) { action.status = 'cancelled'; throw new Error('操作未获授权或任务已停止，未执行'); }
        }
        action.status = 'running'; this.emit('change');
        await this.persist();this.assertTurn(epoch);
        const result = await this.execute(name.slice(8), params, epoch);
        if (!this.active || epoch !== this.epoch) { action.status = 'unknown'; throw new Error('操作期间任务停止，结果未知；请观察窗口，不可自动重放。'); }
        action.status = 'completed'; action.completedAt = new Date().toISOString();
        if(result.bindingId)action.scope={...action.scope,bindingId:result.bindingId,windowId:result.window?.id||action.scope.windowId};
        action.summary = { window: result.window || null, source: result.source || null };
        if (result.window) this.currentWindow = result.window;
        await this.persist();
        this.emit('change');
        if (result.data) {
          const { data, ...metadata } = result;
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, actionId: id, ...metadata, safeToRetry: false }) }, { type: 'image', data, mimeType: result.mimeType }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, actionId: id, ...result, safeToRetry: readOnly.has(name) }) }] };
      } catch (error) {
        if(error.message.includes('DESKTOP_LOCKED'))this.desktop={locked:true,observedAt:new Date().toISOString()};
        const windowError=error.message.match(/WINDOW_CLOSED|WINDOW_CHANGED|ACTIVE_DOCUMENT_CHANGED/)?.[0];
        if(windowError){
          this.invalidateWindow(expectedWindow,windowError!=='ACTIVE_DOCUMENT_CHANGED');
          error.message+='。'+({WINDOW_CLOSED:'原测试窗口已关闭，请明确启动新的测试窗口。',WINDOW_CHANGED:'原窗口身份已变化，已撤销旧绑定；请重新启动专用测试窗口。',ACTIVE_DOCUMENT_CHANGED:'测试标签页已变化，已撤销控制；请手动切回原测试标签后申请恢复窗口。'}[windowError]);
        }
        if (!this.active || epoch !== this.epoch) action.status = ['running','completed','unknown'].includes(action.status) ? 'unknown' : 'cancelled';
        if (!['cancelled', 'unknown'].includes(action.status)) action.status = action.status === 'running' ? 'unknown' : 'failed';
        action.error = error.message; action.completedAt = new Date().toISOString(); this.emit('change');
        await this.persist().catch(()=>{});
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, actionId: id, status: action.status, error: error.message, safeToRetry: false }) }] };
      }
    });
    this.queue = job.then(() => undefined, () => undefined); return job;
  }
  async execute(op, params, epoch) {
    this.assertTurn(epoch);
    if (skillOps.has(op)) return this.skills[op](params);
    const run = (operation, args) => this.dispatch(operation, args, epoch);
    if (op === 'get_desktop_status') return this.desktop;
    const args = { ...params };
    if (op === 'browser_search') { op = 'launch_app'; args.app = 'browser'; delete args.query; }
    if(args.windowId)await this.registerWindow(this.owned.get(args.windowId),epoch);
    if(op==='restore_window') {
      const binding=this.bindings.get(args.bindingId);
      if(!binding||binding.status==='closed')throw new Error('窗口记录已失效');
      await this.registerWindow(binding.proof,epoch);
      const result=await run('get_window',{windowId:binding.proof.id});
      this.owned.set(binding.proof.id,{...binding.proof,...result.window});binding.updatedAt=new Date().toISOString();
      return {...result,bindingId:binding.id,restored:true};
    }
    if (op === 'launch_app') {
      await this.assertWorkspace(epoch);
      args.workspace = this.workspace;
      if (args.app === 'browser') { args.profileDir = this.browserProfile; args.url ??= 'https://www.bing.com/'; }
      if (args.app === 'notepad') {
        args.documentPath = path.join(this.workspace, `zhiwei-notepad-${randomUUID().slice(0, 8)}.txt`);
        await writeFile(args.documentPath, '', { flag: 'wx' });
      }
      const result = await run(op, args);
      // A launch result is a newly created window. Reuse of an old HWND starts a new lifetime.
      for(const binding of this.bindings.values())if(binding.proof.id===result.window.id&&binding.status!=='closed')this.invalidateWindow(binding.proof,true);
      this.owned.set(result.window.id, { ...result.window, app: args.app, documentName: result.window.documentName || (args.documentPath ? path.basename(args.documentPath) : null) });
      this.registered.set(result.window.id,canonical(windowProof(this.owned.get(result.window.id))));
      const bindingId=this.rememberWindow(this.owned.get(result.window.id));
      return {...result,bindingId};
    }
    if (op === 'send_keys') {
      // Save/Enter can submit a dialog: approved individually. Never allow Win/Run/terminal chords.
      args.keys = keys[args.key];
    }
    if (op === 'save_notepad') {
      await this.assertWorkspace(epoch);
      if (this.owned.get(args.windowId)?.app !== 'notepad') throw new Error('只能保存知微启动的记事本');
      args.path = path.join(this.workspace, args.filename);
      try { await lstat(args.path); throw new Error('目标文件已存在，禁止自动覆盖。请用户指定新的文件名。'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const result = await run(op, args);
      if (typeof result.expectedText !== 'string') throw new Error('缺少保存前的真实 UIA 文本，不能确认文件内容正确；结果未知，请勿自动重试。');
      // RichEdit-based Notepad may report bare CR line breaks; store them as Windows CRLF.
      const content = result.expectedText.replace(/\r(?!\n)/g, '\r\n');
      if (Buffer.byteLength(content, 'utf8') > 1024 * 1024) throw new Error('保存文本超过 1 MiB 限制');
      await this.assertWorkspace(epoch);
      this.assertTurn(epoch);
      try { await writeFile(args.path, content, { encoding: 'utf8', flag: 'wx' }); }
      catch (error) { if (error.code === 'EEXIST') throw new Error('目标文件已存在，禁止自动覆盖。请用户指定新的文件名。'); throw error; }
      const stat = await lstat(args.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('保存结果不是允许的普通文本文件');
      const bytes = await readFile(args.path);
      const text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8').replace(/^\uFEFF/, '');
      this.assertTurn(epoch);
      if (text !== content) throw new Error('保存文件与操作前真实 UIA 文本不一致，结果未知，请勿自动重试');
      return { ...result, path: args.path, verified: true, text, source: 'UIAutomation.ValuePattern+fs.writeFile(wx)+read-back' };
    }
    if (op === 'capture_window') {
      if (Date.now() - (this.lastCapture || 0) < 2000) throw new Error('截图间隔至少两秒');
      const tree = await run('get_ui_tree', args);
      // Only our test windows are eligible. Screenshot permission was granted separately above.
      const result = await run(op, args);
      const captureId = randomUUID(); this.lastCapture = Date.now();
      this.captures.clear(); this.captures.set(captureId, { windowId: args.windowId, at: Date.now(), width: result.width, height: result.height, bounds: result.window.bounds, title: result.window.title });
      return { ...result, captureId, uiSnapshot: tree.snapshot };
    }
    if (op === 'mouse') {
      const capture = this.captures.get(args.captureId);
      if (!capture || capture.windowId !== args.windowId || Date.now() - capture.at > 15000 || args.x >= capture.width || args.y >= capture.height) throw new Error('截图已过期或坐标超出窗口，请重新观察');
      const fresh = await run('get_window', args);
      if (JSON.stringify(fresh.window.bounds) !== JSON.stringify(capture.bounds) || fresh.window.title !== capture.title) throw new Error('窗口位置、大小或标题已变化，请重新截图');
      args.count = args.kind === 'doubleClick' ? 2 : 1;
    }
    const result = await run(op, args);
    if(op==='close_window'&&result.closed) {
      this.invalidateWindow(this.owned.get(args.windowId),true);
    }
    if (op === 'find_element') result.elements = result.elements.filter(e => [e.name, e.type, e.automationId].some(v => v?.includes(args.query)));
    return result;
  }
  async close() { this.cancel(); this.backend.cancel();await this.persist().catch(()=>{}); if (this.server) await new Promise(resolve => { this.server.close(resolve); this.server.closeAllConnections(); }); }
}
