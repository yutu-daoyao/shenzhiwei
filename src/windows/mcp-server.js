// Stdio MCP adapter. It has no desktop access itself; all actions pass through the host broker.
import readline from 'node:readline';
import { readFileSync } from 'node:fs';
import { tools } from './tools.js';
const url = process.env.ZHIWEI_WINDOWS_URL;
const capability = process.env.ZHIWEI_WINDOWS_CAPABILITY;
if (!url?.startsWith('http://127.0.0.1:') || !capability) process.exit(1);
const input = readline.createInterface({ input: process.stdin });
const pending = new Map();
const version = JSON.parse(readFileSync(new URL('../../package.json',import.meta.url),'utf8')).version;
let closing = false;
function send(message) { if(!closing)process.stdout.write(JSON.stringify(message) + '\n'); }
function cancel(request) {
  if(!request)return;
  request.cancelled=true;clearTimeout(request.timer);request.controller.abort();
}
function close() {
  if(closing)return;
  closing=true;for(const request of pending.values())cancel(request);
  input.close();process.stdin.destroy();
}
input.on('close',close);
process.stdin.on('error',close);
process.stdout.on('error',close);
input.on('line', async line => {
  let message,request;
  try {
    if(closing)return;
    message = JSON.parse(line);
    // MCP 2024-11-05: cancellation is a notification, never an initialize request.
    if(message.method==='notifications/cancelled'&&message.id===undefined){cancel(pending.get(message.params?.requestId));return;}
    if (message.id === undefined) return;
    let result;
    switch (message.method) {
      case 'initialize': result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'zhiwei-windows', version } }; break;
      case 'ping': result = {}; break;
      case 'tools/list': result = { tools }; break;
      case 'tools/call': {
        if(pending.has(message.id))return; // Duplicate in-flight IDs must not dispatch twice.
        request={controller:new AbortController(),cancelled:false};
        request.timer=setTimeout(()=>request.controller.abort(),300000);request.timer.unref();
        pending.set(message.id,request);
        const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${capability}`, 'Content-Type': 'application/json' }, body: JSON.stringify(message.params), signal: request.controller.signal });
        if(!response.ok)throw new Error('Broker rejected request');
        result = await response.json(); break;
      }
      default: send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported MCP method' } }); return;
    }
    if(!request?.cancelled)send({ jsonrpc: '2.0', id: message.id, result });
  } catch (error) { if (message?.id !== undefined&&!request?.cancelled) send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Windows 工具请求失败或超时，结果可能未知。请核对操作记录，禁止自动重放。', data:{safeToRetry:false} } }); }
  finally {if(request){clearTimeout(request.timer);if(pending.get(message.id)===request)pending.delete(message.id);}}
});
