import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { PlaybackLevels } from '../level.js';

const abortError = () => new DOMException('音频播放已停止', 'AbortError');

// Binary stdio only: ready byte (1), then capture PCM or one playback ack per packet.
function worker(mode, { spawnProcess = spawn, platform = process.platform, startupTimeoutMs = 20000, waitForStart = false } = {}, onData, onFailure) {
  if (platform !== 'win32') throw new Error('麦克风和扬声器适配器仅支持 Windows；离线回放可使用 fake。');
  const file = fileURLToPath(new URL('./worker.ps1', import.meta.url));
  const child = spawnProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, '-Mode', mode,...(waitForStart?['-WaitForStart']:[])], { windowsHide:true, shell:false, stdio:['pipe', 'pipe', 'pipe'] });
  let ready = false, stopped = false, preparationDone = false, requested = false, diagnostic = '', resolveReady, rejectReady, resolvePrepared, rejectPrepared;
  const started = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const prepared = new Promise((resolve, reject) => { resolvePrepared = resolve; rejectPrepared = reject; });
  prepared.catch(() => {});
  // A newly spawned worker may fail before a caller reaches its await.
  started.catch(() => {});
  const fail = error => {
    if (stopped) return;
    stopped = true; clearTimeout(timer); rejectPrepared(error); rejectReady(error);
    child.kill(); onFailure(error);
  };
  const timeout = () => setTimeout(() => fail(new Error('Windows 音频设备启动超时，请检查麦克风权限及默认设备。')), startupTimeoutMs);
  let timer = timeout();
  child.stdout.on('data', chunk => {
    if (stopped || !chunk.length) return;
    if (!ready && waitForStart && !preparationDone && chunk[0] === 0) {
      preparationDone = true; clearTimeout(timer); resolvePrepared(); chunk = chunk.subarray(1);
      if (!chunk.length) return;
    }
    if (!ready) {
      if (chunk[0] !== 1) { fail(new Error('Windows 音频协议无效')); return; }
      ready = true; clearTimeout(timer); resolvePrepared(); resolveReady(); chunk = chunk.subarray(1);
    }
    if (chunk.length) onData(chunk);
  });
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-4000); });
  child.stdin.on('error', fail);
  child.on('error', fail);
  child.on('close', code => fail(new Error(`Windows 音频进程退出 (${code})：${diagnostic || '请检查默认音频设备及隐私设置'}`)));
  return {
    child, started, prepared,
    async begin() {
      if(waitForStart&&!requested){
        await prepared;
        if(stopped)throw abortError();
        requested=true;timer=timeout();child.stdin.write(Buffer.from([1]));
      }
      return started;
    },
    stop() { if (stopped) return; stopped = true; clearTimeout(timer); rejectPrepared(abortError()); rejectReady(abortError()); child.kill(); },
  };
}

export class WindowsCapture extends EventEmitter {
  constructor(options = {}) { super(); this.options = options; }
  open(waitForStart = false) {
    if (this.worker) return;
    this.pending = Buffer.alloc(0);
    this.worker = worker('capture', {...this.options,waitForStart}, chunk => {
      this.pending = Buffer.concat([this.pending, chunk]);
      while (this.pending.length >= 640) {
        const frame = this.pending.subarray(0, 640);
        this.pending = this.pending.subarray(640);
        this.emit('frame', frame);
      }
    }, error => { this.worker = null; this.emit('error', error); });
  }
  async prepare() {
    this.open(true);
    return this.worker.prepared;
  }
  async start({ sampleRate = 16000, frameMs = 20, signal } = {}) {
    if (sampleRate !== 16000 || frameMs !== 20) throw new Error('Windows 采集需要 16kHz / 20ms PCM16');
    if (signal?.aborted) throw abortError();
    this.open();
    const current = this.worker;
    const abort = () => { if (this.worker === current) void this.close(); };
    signal?.addEventListener('abort', abort, { once:true });
    try { await current.begin(); }
    finally { signal?.removeEventListener('abort', abort); }
  }
  async close() { this.worker?.stop(); this.worker = null; this.pending = Buffer.alloc(0); }
}

export class WindowsPlayback {
  constructor(options = {}) {
    this.options = options; this.reportsLevel = true;
    this.levels = new PlaybackLevels(level => this.onLevel?.(level));
  }
  async write(chunk, { signal, sampleRate = 16000 } = {}) {
    if (sampleRate !== 16000 || !Buffer.isBuffer(chunk) || chunk.length % 2) throw new Error('Windows 播放需要 16kHz PCM16 Buffer');
    if (signal?.aborted) throw abortError();
    if (this.failure) throw this.failure;
    if (this.writing) throw new Error('播放写入必须等待上一块完成');
    const writing = this.writing = {};
    try {
      if (!this.worker) {
        this.worker = worker('playback', this.options, data => {
          for (const ack of data) {
            if (ack !== 1 || !this.pending) {
              const error = new Error('Windows 播放确认协议无效');
              this.pending?.reject(error); this.pending = null; this.stop(); this.failure = error; return;
            }
            this.pending.resolve(); this.pending = null;
          }
        }, error => { this.levels.stop(); this.worker = null; this.failure = error; this.pending?.reject(error); this.pending = null; });
      }
      const current = this.worker;
      const abort = () => { if (this.worker === current) this.stop(); };
      signal?.addEventListener('abort', abort, { once:true });
      try {
        await current.started;
        // Up to 100ms per acknowledged packet avoids an IPC gap every 20ms.
        // stop() still kills only this worker immediately, discarding device audio.
        for (let offset = 0; offset < chunk.length; offset += 3200) {
          if (signal?.aborted || this.worker !== current) throw abortError();
          const frame = chunk.subarray(offset, offset + 3200);
          const header = Buffer.alloc(4); header.writeUInt32LE(frame.length);
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              this.pending = null; this.stop(); reject(new Error('Windows 音频播放超时'));
            }, this.options.writeTimeoutMs ?? 10000);
            this.pending = {
              resolve:() => { clearTimeout(timer); resolve(); },
              reject:error => { clearTimeout(timer); reject(error); },
            };
            this.levels.enqueue(frame); this.levels.start();
            current.child.stdin.write(Buffer.concat([header, frame]), error => {
              if (error && this.worker === current) { this.pending?.reject(error); this.pending = null; this.stop(); }
            });
          });
        }
      } finally { signal?.removeEventListener('abort', abort); }
    } finally { if (this.writing === writing) this.writing = null; }
  }
  // Each write is acknowledged only after waveOut has actually played it.
  async drain() { if (this.failure) throw this.failure; this.levels.stop(); this.onLevel?.(0); }
  stop() {
    this.levels.stop();
    const current = this.worker; this.worker = null;
    // A cancelled write may still be unwinding while a new utterance starts.
    this.writing = null;
    this.pending?.reject(abortError()); this.pending = null;
    current?.stop();
    this.failure = null;
  }
  async close() { this.stop(); }
}
