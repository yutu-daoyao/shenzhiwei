import { randomUUID } from 'node:crypto';
import { ENDPOINT, MISSING_KEY, parseEvent, dashscopeFailure } from './protocol.js';

// Node's bundled Undici accepts WebSocketInit as the SECOND argument.
// Kept replaceable for offline replay and runtimes without header support.
export function createSocket(url, options) {
  if (typeof globalThis.WebSocket !== 'function') throw new Error('DashScope 语音需要 Node.js 22.13 或更新版本');
  return new globalThis.WebSocket(url, options);
}

// One socket per task. Start asynchronously so ASR callers can attach listeners.
// Never forward raw socket/server errors: these may contain credentials.
export function createTask({ socketFactory = createSocket, timeoutMs = 60000 } = {}, callbacks) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('DashScope 任务超时必须大于 0');
  const id = randomUUID();
  let socket, timer, stopped = false, started = false;
  const listeners = [];
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    for (const [name, listener] of listeners) socket.removeEventListener(name, listener);
    try { socket?.close(); } catch { /* Already disconnected. */ }
  };
  const fail = message => {
    if (stopped) return;
    stop();
    callbacks.error(new Error(message));
  };
  const send = data => {
    if (stopped) return;
    if (socket?.readyState !== 1) { fail('DashScope 语音连接尚未就绪'); return; }
    if (socket.bufferedAmount > 8 * 1024 * 1024) { fail('DashScope 语音发送缓冲区已满'); return; }
    try { socket.send(typeof data === 'object' && !Buffer.isBuffer(data) ? JSON.stringify(data) : data); }
    catch { fail('DashScope 语音发送失败'); }
  };
  const task = { id, send, close:stop, fail, get stopped() { return stopped; } };
  queueMicrotask(() => {
    if (stopped) return;
    const key = process.env.DASHSCOPE_API_KEY?.trim();
    if (!key) { fail(MISSING_KEY); return; }
    timer = setTimeout(() => fail('DashScope 语音任务超时'), timeoutMs);
    try {
      socket = socketFactory(ENDPOINT, { headers:{ Authorization:`bearer ${key}` } });
      socket.binaryType = 'arraybuffer'; // Synchronous conversion preserves audio frame order.
      const listen = (name, listener) => { socket.addEventListener(name, listener); listeners.push([name, listener]); };
      listen('open', () => { if (!stopped) send(callbacks.run(id)); });
      listen('error', () => fail('DashScope 语音连接失败，请检查网络和密钥配置'));
      listen('close', () => fail('DashScope 语音连接意外关闭'));
      listen('message', ({ data }) => {
        if (stopped) return;
        if (typeof data !== 'string') {
          if (!started) { fail('DashScope 在任务启动前返回了音频'); return; }
          try { callbacks.audio?.(Buffer.from(data)); }
          catch { fail('DashScope 返回了无效的音频帧'); }
          return;
        }
        let event;
        try { event = parseEvent(data, id); }
        catch { fail('DashScope 返回了无效的协议事件'); return; }
        if (!event) return;
        switch (event.header.event) {
          case 'task-started':
            if (!started) { started = true; callbacks.started?.(); }
            break;
          case 'result-generated': if (started) callbacks.result?.(event); break;
          case 'task-failed': fail(dashscopeFailure(event.header)); break;
          case 'task-finished':
            if (!started) { fail('DashScope 任务未启动就结束'); return; }
            stop(); callbacks.finished(); break;
        }
      });
    } catch { fail('DashScope 语音连接初始化失败，请检查 Node.js 版本和密钥配置'); }
  });
  return task;
}
