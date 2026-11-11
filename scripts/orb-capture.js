// Node 24+, no npm dependencies. Only serves public/; never starts the voice backend.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../public/', import.meta.url));
const defaultOut = path.resolve('work/orb-capture');
const defaultChrome = process.platform === 'win32' ? path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe') : '/usr/bin/google-chrome';

export function staticHandler(publicRoot = root) {
  return async (req, res) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const file = await realpath(path.resolve(publicRoot, `.${pathname === '/' ? '/index.html' : pathname}`));
      const relative = path.relative(await realpath(publicRoot), file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(403); res.end(); return; }
      const bytes = await readFile(file);
      const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png' };
      res.writeHead(200, { 'Content-Type':mime[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch { res.writeHead(404); res.end(); }
  };
}

export class CDP {
  constructor(socket, timeoutMs = 15000) {
    this.socket = socket; this.timeoutMs = timeoutMs; this.sequence = 0; this.pending = new Map(); this.errors = [];
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params.exceptionDetails);
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer); this.pending.delete(message.id);
      if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
    });
    socket.addEventListener('close', () => this.fail(new Error('Chrome DevTools 连接已关闭')));
    socket.addEventListener('error', () => this.fail(new Error('Chrome DevTools 连接失败')));
  }
  fail(error) {
    this.failure = error;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }
  call(method, params = {}, sessionId) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP 超时：${method}`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
}

async function launchChrome(profile, executable) {
  const child = spawn(executable, ['--headless=new', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide:true, stdio:['ignore', 'ignore', 'pipe'] });
  let diagnostic = '';
  try {
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Chrome 启动超时：${diagnostic}`)), 15000);
      const finish = (fn, value) => { clearTimeout(timer); fn(value); };
      child.stderr.on('data', chunk => {
        diagnostic = (diagnostic + chunk.toString()).slice(-12000);
        const match = diagnostic.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) finish(resolve, match[1]);
      });
      child.once('error', error => finish(reject, error));
      child.once('exit', (code, signal) => finish(reject, new Error(`Chrome 退出 code=${code} signal=${signal}：${diagnostic}`)));
    });
    return { child, endpoint };
  } catch (error) { await stopChrome(child); throw error; }
}
async function stopChrome(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise(resolve => child.once('close', resolve));
  child.kill();
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  await closed; clearTimeout(timer);
}
async function encode(out, frames, count, seconds) {
  const video = path.join(out, 'orb-demo.mp4');
  const args = ['-y', '-loglevel', 'error', '-framerate', String(count / seconds), '-i', path.join(frames, 'frame-%05d.jpg'), '-frames:v', String(Math.ceil(seconds * 20)), '-t', String(seconds), '-vf', 'scale=1280:720:in_range=pc:out_range=tv,format=yuv420p', '-r', '20', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-maxrate', '2M', '-bufsize', '4M', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-movflags', '+faststart', video];
  await new Promise((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_BIN || 'ffmpeg', args, { windowsHide:true, stdio:['ignore', 'ignore', 'pipe'] });
    let diagnostic = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('ffmpeg 编码超时')); }, 120000);
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`ffmpeg 失败 (${code})：${diagnostic}`)); });
  });
  const bytes = (await stat(video)).size;
  if (bytes >= 10_000_000) throw new Error(`视频超过 10MB：${bytes} bytes`);
  return { bytes, file:video };
}

export async function captureOrb({ out = defaultOut, chrome = process.env.CHROME_BIN || defaultChrome, screenshotsOnly = false } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('请使用 Node 24 或更新版本');
  await mkdir(out, { recursive:true });
  const profile = await mkdtemp(path.join(tmpdir(), 'zhiwei-orb-capture-'));
  const server = http.createServer(staticHandler());
  let child, socket;
  const startedAt = new Date().toISOString();
  const results = { startedAt, viewport:{ width:1280, height:720, deviceScaleFactor:1 }, renderer:'Chrome headless / ANGLE SwiftShader', states:{}, cycle:[], note:'FPS 来自页面渲染统计；截图和软件渲染会影响实测帧率。captureFps 是采集频率，不是页面 FPS。' };
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const launched = await launchChrome(profile, chrome); child = launched.child;
    socket = new WebSocket(launched.endpoint);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('DevTools WebSocket 连接超时')); }, 10000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once:true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('DevTools WebSocket 连接失败')); }, { once:true });
    });
    const cdp = new CDP(socket);
    const { targetId } = await cdp.call('Target.createTarget', { url:'about:blank' });
    const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten:true });
    const call = (method, params) => cdp.call(method, params, sessionId);
    await call('Page.enable'); await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { ...results.viewport, mobile:false });
    const evaluate = async expression => {
      const result = await call('Runtime.evaluate', { expression, returnByValue:true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const navigate = async mode => {
      const response = await call('Page.navigate', { url:`${origin}/?orbSim=${mode}&orbFps=1` });
      if (response.errorText) throw new Error(response.errorText);
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (await evaluate(`document.readyState === 'complete' && document.body.dataset.orbSim === '${mode}' && !!window.__orbStats`)) return;
        await delay(100);
      }
      throw new Error(`页面未就绪：${mode}`);
    };
    for (const mode of ['idle', 'listening', 'speaking']) {
      await navigate(mode); await delay(3000);
      results.states[mode] = await evaluate('({...window.__orbStats})');
      const screenshot = await call('Page.captureScreenshot', { format:'png' });
      await writeFile(path.join(out, `orb-${mode}.png`), Buffer.from(screenshot.data, 'base64'));
    }
    if (screenshotsOnly) {
      if (cdp.errors.length) throw new Error(`页面脚本错误：${JSON.stringify(cdp.errors)}`);
      await writeFile(path.join(out, 'fps.json'), JSON.stringify(results, null, 2));
      await rm(path.join(out, 'capture-error.json'), { force:true });
      return results;
    }
    const frames = path.join(out, 'frames'); await mkdir(frames, { recursive:true });
    for (const name of await readdir(frames)) if (/^frame-\d{5}\.jpg$/.test(name)) await rm(path.join(frames, name));
    await navigate('cycle');
    const begin = performance.now(); let count = 0;
    while (performance.now() - begin < 10000) {
      const sample = await evaluate('({ ...window.__orbStats, state:document.getElementById("orb-stage").dataset.state })');
      const screenshot = await call('Page.captureScreenshot', { format:'jpeg', quality:78 });
      await writeFile(path.join(frames, `frame-${String(count++).padStart(5, '0')}.jpg`), Buffer.from(screenshot.data, 'base64'));
      results.cycle.push({ elapsedMs:Math.round(performance.now() - begin), ...sample });
      const next = Math.ceil((performance.now() - begin) / 100) * 100;
      await delay(Math.max(0, Math.min(10000, next) - (performance.now() - begin)));
    }
    results.durationSeconds = (performance.now() - begin) / 1000;
    results.frameCount = count; results.captureFps = count / results.durationSeconds;
    if (cdp.errors.length) throw new Error(`页面脚本错误：${JSON.stringify(cdp.errors)}`);
    await writeFile(path.join(out, 'fps.json'), JSON.stringify(results, null, 2));
    results.video = await encode(out, frames, count, results.durationSeconds);
    await writeFile(path.join(out, 'fps.json'), JSON.stringify(results, null, 2));
    await rm(path.join(out, 'capture-error.json'), { force:true });
    console.log(`截图、${count} 帧、FPS 与视频已保存：${out}`);
    return results;
  } catch (error) {
    await writeFile(path.join(out, 'capture-error.json'), JSON.stringify({ startedAt, error:error.message, partial:results }, null, 2)).catch(() => {});
    throw error;
  } finally {
    socket?.close(); await stopChrome(child);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(profile), prefix = path.join(path.resolve(tmpdir()), 'zhiwei-orb-capture-');
    if (!resolved.startsWith(prefix)) throw new Error('浏览器临时目录超出预期范围');
    await rm(resolved, { recursive:true, force:true, maxRetries:5, retryDelay:200 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--out');
  if (process.argv.includes('--help')) console.log('Node 24: node scripts/orb-capture.js [--out DIRECTORY] [--screenshots-only]\n默认输出：' + defaultOut + '\n可选环境变量：CHROME_BIN、FFMPEG_BIN。无需启动后端。');
  else if (index >= 0 && (!process.argv[index + 1] || process.argv[index + 1].startsWith('--'))) { console.error('--out 后需要指定输出目录'); process.exitCode = 1; }
  else captureOrb({ screenshotsOnly:process.argv.includes('--screenshots-only'), ...(index >= 0 ? { out:path.resolve(process.argv[index + 1]) } : {}) }).catch(error => { console.error(`光球采集失败：${error.message}`); process.exitCode = 1; });
}
