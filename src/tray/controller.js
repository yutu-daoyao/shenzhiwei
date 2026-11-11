import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../../scripts/start-background.ps1', import.meta.url));
const literal = value => "'" + value.replaceAll("'", "''") + "'";
export function autostartCommand(executable = process.execPath, entry = fileURLToPath(new URL('../main.js', import.meta.url))) {
  // PowerShell literals protect paths containing spaces, quotes, $ and backticks.
  const script = `& ${literal(launcher)} -NodePath ${literal(executable)} -EntryPath ${literal(entry)}`;
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
}

export class TrayController extends EventEmitter {
  constructor({ platform = process.platform, spawnProcess = spawn, killTree = async child => {
    await exec('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide:true, timeout:5000 });
  }, timeoutMs = 12000 } = {}) {
    super(); Object.assign(this, { platform, spawnProcess, killTree, timeoutMs });
  }
  async start({ origin, listening = false, autostart = false, desktopEnabled = true } = {}) {
    if (this.platform !== 'win32') return false;
    if (this.child) throw new Error('托盘已经启动');
    const url = new URL(origin);
    if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('托盘界面地址无效');
    const child = this.spawnProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./worker.ps1', import.meta.url))], { windowsHide:true, shell:false, stdio:['pipe', 'pipe', 'pipe'] });
    this.child = child; this.stopping = false; this.ready = false;
    this.closed = new Promise(resolve => child.once('close', resolve));
    let buffer = '';
    let failed = false;
    let rejectStart;
    const started = new Promise((resolve, reject) => {
      rejectStart = reject;
      this.resolveStart = resolve;
    });
    const fail = error => {
      if (this.child !== child || failed) return;
      failed = true;
      rejectStart(error);
      if (!this.stopping) {
        this.emit('failure', error);
        void this.close().catch(failure => this.emit('failure', failure));
      }
    };
    const timer = setTimeout(() => fail(new Error('托盘启动超时')), this.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (this.stopping || this.child !== child || failed) return;
      buffer += chunk;
      if (buffer.length > 16384) { fail(new Error('托盘协议过长')); void this.close().catch(error => this.emit('failure', error)); return; }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        if (this.stopping || this.child !== child || failed) return;
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try {
          const message = JSON.parse(line);
          if (message?.type === 'ready' && !this.ready) { this.ready = true; this.resolveStart(true); }
          else if (message?.type === 'desktop-ready' && this.ready && typeof message.ready === 'boolean') this.emit('desktop-ready',{ready:message.ready,error:message.error?'Ctrl＋空格已被其他程序占用，请先释放该快捷键。':null});
          else if (message?.type === 'hotkey' && this.ready && ['start','stop','cancel'].includes(message.action) && (message.action!=='start'||/^[1-9][0-9]{0,18}$/.test(message.windowId))) this.emit('hotkey',{action:message.action,windowId:message.windowId});
          else if (message?.type === 'action' && this.ready && ['open', 'start', 'stop', 'exit'].includes(message.action)) this.emit('action', message.action);
          else throw new Error('托盘协议无效');
        } catch (error) { fail(error); void this.close().catch(error => this.emit('failure', error)); return; }
      }
    });
    child.stderr.on('data', () => {});
    child.stdin.on('error', fail); child.on('error', fail);
    child.on('close', () => fail(new Error('托盘进程已退出')));
    try {
      this.send({ type:'configure', origin:url.origin, listening:!!listening, autostart:!!autostart, desktopEnabled:!!desktopEnabled, command:autostartCommand() });
      return await started;
    } catch (error) { await this.close(); throw error; }
    finally { clearTimeout(timer); }
  }
  send(message) {
    if (!this.child || this.child.stdin.destroyed) throw new Error('托盘未运行');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  setListening(listening) { if (this.ready && !this.stopping && this.child) this.send({ type:'listening', value:!!listening }); }
  setDesktopEnabled(value) { if(this.ready&&!this.stopping&&this.child)this.send({type:'desktop-enabled',value:!!value}); }
  setOverlay({state,text,level=0}) {
    if(!['hidden','starting','listening','thinking','speaking','idle','interrupted','error','approval'].includes(state))return;
    if(this.ready&&!this.stopping&&this.child)this.send({type:'overlay',state,text:String(text||'').slice(0,160),level:Math.max(0,Math.min(1,Number(level)||0))});
  }
  close() {
    if (this.closing) return this.closing;
    this.closing = this.stop().finally(() => { this.closing = null; });
    return this.closing;
  }
  async stop() {
    const child = this.child;
    if (!child) return;
    this.stopping = true; this.ready = false;
    this.resolveStart?.(false);
    try { this.send({ type:'quit' }); child.stdin.end(); } catch { /* Force cleanup below. */ }
    let timer;
    const exited = await Promise.race([this.closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), this.timeoutMs); })]);
    clearTimeout(timer);
    if (!exited) await this.killTree(child);
    if (this.child === child) this.child = null;
  }
}
