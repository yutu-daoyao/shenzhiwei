import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export function safeError(value) {
  return String(value?.message || value || '未知错误')
    .replace(/Bearer\s+\S+|\bsk-[\w-]+|\beyJ[\w.-]+/gi, '[已隐藏凭据]')
    .replace(/((?:access_token|refresh_token|api_key|authorization|cookie|password)\s*[=:]\s*)[^\s,;]+/gi, '$1[已隐藏]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[已隐藏邮箱]').slice(0, 1600);
}

function childEnv() {
  const env = { ...process.env };
  // Use Codex-managed ChatGPT login only; never fall back to separately billed API credentials.
  for (const key of Object.keys(env)) {
    if (/^(OPENAI_API_KEY|CODEX_API_KEY|ACCESS_TOKEN|OPENAI_BASE_URL|CODEX_THREAD_ID)$/i.test(key)) delete env[key];
  }
  return env;
}

export async function findCodex({verify=true}={}) {
  const candidates = [];
  if (process.env.CODEX_BIN) candidates.push(process.env.CODEX_BIN);
  else {
    try {
      const { stdout } = await exec(process.platform === 'win32' ? 'where.exe' : 'which', ['codex'], { windowsHide: true });
      candidates.push(...stdout.trim().split(/\r?\n/).filter(p => process.platform !== 'win32' || /\.exe$/i.test(p)));
    } catch { /* Continue with official desktop and npm installation locations. */ }
    if (process.platform === 'win32') {
      const bin = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
      try {
        const dirs = await readdir(bin, { withFileTypes: true });
        for (const dir of dirs.filter(d => d.isDirectory())) candidates.push(path.join(bin, dir.name, 'codex.exe'));
      } catch { /* Desktop install is optional. */ }
      const modules = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai');
      for (const root of [path.join(modules, 'codex'), path.join(modules, 'codex', 'node_modules', '@openai', 'codex-win32-x64'), path.join(modules, 'codex-win32-x64')]) {
        candidates.push(path.join(root, 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe'));
      }
    }
  }
  let incompleteDesktop=false;
  for (const file of candidates) {
    try {
      await access(file);
      if (process.platform === 'win32' && !/\.exe$/i.test(file)) continue;
      if(process.platform==='win32'&&/[\\/]OpenAI[\\/]Codex[\\/]bin[\\/]/i.test(file)){
        try{await access(path.join(path.dirname(file),'codex-code-mode-host.exe'));}
        catch{incompleteDesktop=true;continue;}
      }
      if(!verify)return {file};
      const { stdout } = await exec(file, ['--version'], { windowsHide: true, timeout: 10000, env: childEnv() });
      if (/codex-cli/.test(stdout)) return { file, version: stdout.trim() };
    } catch { /* Broken PATH shims must not hide a working desktop binary. */ }
  }
  if(incompleteDesktop)throw new Error('找到的 Codex 桌面组件缺少 codex-code-mode-host.exe。请选择完整的 Codex 安装，再重新连接。');
  throw new Error('找不到可用的 Codex CLI。请安装官方 @openai/codex，或设置 CODEX_BIN 为 codex.exe 的完整路径，再点击重新连接。');
}

export class AppServer extends EventEmitter {
  constructor({ cwd, command, args, timeout = 30000, platform = process.platform, nativeRealtime = false } = {}) {
    super();
    Object.assign(this, { cwd, command, args, timeout, platform });
    this.nativeRealtime = nativeRealtime;
    this.pending = new Map();
    this.nextId = 1;
    this.connected = false;
    this.stopping = false;
  }

  async start(stage = (_name, operation) => operation()) {
    if (this.child) throw new Error('App Server 已经启动');
    try {
      const info = await stage('startup', () => this.launch());
      await stage('login', () => this.checkAccount());
      return { ...info, account: this.account };
    } catch (error) { await this.stop(); throw error; }
  }

  async launch() {
    this.stopping = false;
    const info = this.command ? { file: this.command, version: 'test' } : await findCodex();
    this.info = info;
    const child = spawn(info.file, this.args || ['--no-daemon', '-c', 'thread_unload_delay_secs=1', ...(this.nativeRealtime ? ['--enable','realtime_conversation'] : []), 'app-server', '--listen', 'stdio://'], {
      cwd: this.cwd, env: childEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    this.child = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 16 * 1024 * 1024) return this.fail(new Error('App Server 协议消息超过安全上限'));
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try { this.receive(JSON.parse(line)); }
        catch { this.fail(new Error('App Server 返回了无效 JSON 协议消息，请重新连接')); return; }
      }
    });
    // Never forward raw diagnostics: they may contain local paths, account info or tokens.
    child.stderr.on('data', () => this.emit('diagnostic', 'App Server 有诊断输出（原文未记录，以免包含隐私）。'));
    child.stdin.on('error', error => this.fail(error));
    child.on('error', error => this.fail(new Error(`App Server 启动失败：${safeError(error)}`)));
    child.on('close', code => {
      if (this.child === child) this.child = null;
      this.fail(new Error(`App Server 已退出（代码 ${code ?? '未知'}），请重新连接并恢复对话。`));
    });
    await this.request('initialize', { clientInfo: { name: 'zhiwei_desktop', title: '沈知微 Zhiwei', version: '0.2.0' }, ...(this.nativeRealtime ? {capabilities:{experimentalApi:true}} : {}) });
    this.notify('initialized', {});
    return info;
  }

  async checkAccount() {
    const auth = await this.request('account/read', { refreshToken: false });
    // Read only the public account type/plan. No credential file is read by this client.
    if (auth.account?.type !== 'chatgpt') {
      throw new Error(auth.account ? '当前不是 ChatGPT 登录，已禁止 API 计费模式。请在终端运行 Codex 官方 login，选择 ChatGPT。' : 'Codex 尚未登录。请在终端运行 codex login，通过官方浏览器登录 ChatGPT 后重新连接。');
    }
    this.connected = true;
    this.account = { type: 'chatgpt', planType: auth.account.planType || null };
  }

  receive(message) {
    if (message.method) {
      this.emit(message.id === undefined ? 'notification' : 'serverRequest', message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return; // Late response to an expired request.
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      const error = new Error(`Codex 请求 ${pending.method} 失败：${safeError(message.error.message)}（${message.error.code}）`);
      error.code = 'RPC_ERROR';
      error.rpcCode = message.error.code;
      pending.reject(error);
    } else pending.resolve(message.result);
  }

  write(message) {
    if (!this.child || this.child.stdin.destroyed || !this.child.stdin.writable) throw new Error('Codex 连接已断开，请重新连接');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method, params, timeout = this.timeout) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`请求 ${method} 超时。执行结果未知，请先恢复会话核对状态，不要重复发送。`);
        error.code = 'TIMEOUT';
        reject(error);
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  notify(method, params) { this.write({ method, params }); }
  respond(id, result) { this.write({ id, result }); }
  rejectRequest(id) { this.write({ id, error: { code: -32601, message: 'Zhiwei does not support this request; no permission granted.' } }); }

  async terminateOwnedTree() {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (this.platform !== 'win32') throw new Error('此平台未实现进程树终止，无法确认遗留命令已停止。');
    // The PID comes ONLY from our shell:false spawn with --no-daemon, never a user-supplied PID.
    // Killing just the parent on Windows can leave its PowerShell command alive.
    this.stopping = true;
    const closed = new Promise(resolve => child.once('close', resolve));
    try {
      await exec('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
      await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('所属 App Server 退出确认超时')), 5000).unref())]);
      this.connected = false;
      if (this.child === child) this.child = null;
    } catch (error) {
      this.stopping = false;
      throw new Error(`无法确认遗留命令已停止：${safeError(error)}。请勿继续发送任务。`);
    }
  }

  fail(error) {
    const wasConnected = this.connected;
    this.connected = false;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    if (wasConnected && !this.stopping) this.emit('disconnected', safeError(error));
  }

  async stop() {
    this.stopping = true;
    this.connected = false;
    const child = this.child;
    if (!child) return;
    this.fail(new Error('连接已关闭'));
    await new Promise((resolve, reject) => {
      let forcing = false;
      const timer = setTimeout(() => {
        forcing = true;
        if (this.platform === 'win32') this.terminateOwnedTree().then(resolve, reject);
        else { child.kill(); resolve(); }
      }, 3000);
      child.once('close', () => { clearTimeout(timer); if (!forcing) resolve(); });
      child.stdin.end();
    });
    if (this.child === child) this.child = null;
  }
}
