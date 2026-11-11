import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { safeError } from '../codex/process.js';

export class WindowsBackend extends EventEmitter {
  constructor({ command, args } = {}) { super(); this.command=command; this.args=args; this.nextId = 1; this.pending = new Map(); }
  start() {
    if (this.child) return;
    if (!this.command && process.platform !== 'win32') throw new Error('Windows UIA 仅在 Windows 上可用');
    const file = fileURLToPath(new URL('./worker.ps1', import.meta.url));
    const child = spawn(this.command || 'powershell.exe', this.args || ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-File', file], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.diagnostic = '';
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (this.child !== child) return;
      buffer += chunk;
      if (buffer.length > 24 * 1024 * 1024) { this.cancel(new Error('Windows UIA 响应超过大小限制，连接已关闭')); return; }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { this.cancel(new Error('Windows UIA 返回了无效响应，连接已关闭')); return; }
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.result); else pending.reject(new Error(message.error));
      }
    });
    child.stderr.on('data', chunk => { if (this.child === child) this.diagnostic = safeError(this.diagnostic + chunk.toString()); });
    child.stdin.on('error', error => { if (this.child === child) this.fail(error); });
    child.on('error', error => { if (this.child === child) this.fail(error); });
    child.on('close', () => { if (this.child !== child) return; this.child = null; this.fail(new Error(this.diagnostic || 'Windows UIA 服务已退出；结果未知，不可自动重放操作')); this.emit('exit'); });
  }
  call(op, params, timeout = 20000) {
    this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.cancel(new Error('Windows 操作超时，结果未知；请观察实际界面，禁止自动重放')), timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.child.stdin.write(JSON.stringify({ id, op, params }) + '\n'); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  fail(error) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); }
  cancel(reason = new Error('Windows 操作已取消；已开始的输入可能已生效，不能自动回滚或重放')) {
    this.fail(reason);
    const child = this.child; this.child = null;
    // Kill only the UIA worker, NEVER its application children or unrelated desktop windows.
    if (child && child.exitCode === null) child.kill();
    this.emit('exit');
  }
}
