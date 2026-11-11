// Protocol fixture only; never imported by the production entry point.
import readline from 'node:readline';
import { writeFileSync } from 'node:fs';
const mode = process.argv[2] || 'normal';
let threadNumber = 0;
let turnNumber = 0;
let last;
let timer;
let active;
let handshake = false;
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
function event(method, params) { send({ method, params }); }
function thread(id = 'thread-1') { return { id, historyMode: 'legacy', status: { type: 'idle' }, turns: [{ id: 'old-turn', status: 'completed', items: [{ id: 'old-msg', type: 'agentMessage', text: '历史回复' }, { id: 'private', type: 'reasoning', content: ['DO_NOT_EXPOSE'], summary: [] }] }] }; }
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (!m.method || m.id === undefined) return;
  last = m;
  if (m.method === 'initialize') {
    if (mode === 'startup-timeout') return;
    if (mode === 'bad-json') { process.stdout.write('not JSON\n'); return; }
    handshake = true; send({ id: m.id, result: { userAgent: 'fixture' } }); return;
  }
  if (!handshake) { send({ id: m.id, error: { code: -32000, message: 'Not initialized' } }); return; }
  switch (m.method) {
    case 'account/read': send({ id: m.id, result: { account: mode === 'no-login' ? null : { type: mode === 'api-key' ? 'apiKey' : 'chatgpt', planType: 'plus', email: 'PRIVATE_ACCOUNT' } } }); break;
    case 'test/echo': setTimeout(() => send({ id: m.id, result: m.params }), m.params.delay || 0); break;
    case 'test/unicode': {
      const bytes = Buffer.from(JSON.stringify({ id: m.id, result: '知微🙂分段' }) + '\n');
      const middle = bytes.indexOf(Buffer.from('知')) + 1;
      process.stdout.write(bytes.subarray(0, middle)); setTimeout(() => process.stdout.write(bytes.subarray(middle)), 10); break;
    }
    case 'test/error': send({ id: m.id, error: { code: 409, message: 'fixture failure' } }); break;
    case 'test/timeout': break;
    case 'test/invalid': process.stdout.write('not JSON\n'); break;
    case 'test/oversized': process.stdout.write('x'.repeat(16 * 1024 * 1024 + 1)); break;
    case 'test/exit': send({ id: m.id, result: {} }); setTimeout(() => process.exit(7), 10); break;
    case 'model/list': send({id:m.id,result:{data:[{model:'gpt-6-luna',displayName:'GPT-6-Luna',supportedReasoningEfforts:[{reasoningEffort:'low'}]}],nextCursor:null}});break;
    case 'thread/start': send({ id: m.id, result: { thread: thread(`thread-${++threadNumber}`) } }); break;
    case 'thread/unsubscribe': send({id:m.id,result:{status:'unsubscribed'}});break;
    case 'thread/resume':
      if (m.params.threadId === 'missing') send({ id: m.id, error: { code: 404, message: 'thread not found' } });
      else send({ id: m.id, result: { thread: thread(m.params.threadId) } });
      break;
    case 'turn/start': {
      active = { id: `turn-${++turnNumber}`, threadId: m.params.threadId };
      const { id: turnId, threadId } = active;
      event('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
      event('item/started', { threadId, turnId, item: { id: `user-${turnId}`, type: 'userMessage', content: m.params.input } });
      event('item/started', { threadId, turnId, item: { id: `reason-${turnId}`, type: 'reasoning', content: ['DO_NOT_EXPOSE'], summary: ['DO_NOT_EXPOSE'] } });
      const itemId = `agent-${turnId}`;
      if (mode === 'turn-timeout') return;
      send({ id: m.id, result: { turn: { id: turnId, status: 'inProgress' } } });
      event('item/started', { threadId, turnId, item: { id: `tool-${turnId}`, type: 'commandExecution', status: 'inProgress' } });
      if (mode === 'approval') { send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'cmd', command: 'echo harmless', cwd: process.cwd() } }); return; }
      event('item/agentMessage/delta', { threadId, turnId, itemId, delta: '你' });
      event('item/agentMessage/delta', { threadId, turnId, itemId, delta: '好' });
      timer = setTimeout(() => {
        if (mode === 'lingering') writeFileSync('mock-interrupt-sentinel.txt', 'MISSED_INTERRUPT');
        event('item/completed', { threadId, turnId, item: { id: `tool-${turnId}`, type: 'commandExecution', status: 'completed' } });
        event('item/completed', { threadId, turnId, item: { id: itemId, type: 'agentMessage', text: '你好' } });
        event('turn/completed', { threadId, turn: { id: turnId, status: mode === 'turn-failed' ? 'failed' : 'completed', items: [], error: mode === 'turn-failed' ? { message: '网络连接失败，请检查网络' } : null } });
        event('item/agentMessage/delta', { threadId, turnId, itemId, delta: 'LATE_DUPLICATE' });
      }, mode === 'slow' ? 30000 : mode === 'lingering' ? 4000 : 80);
      break;
    }
    case 'turn/interrupt':
      if (mode !== 'lingering') {
        clearTimeout(timer);
        event('item/completed', { threadId: m.params.threadId, turnId: m.params.turnId, item: { id: `tool-${m.params.turnId}`, type: 'commandExecution', status: 'declined' } });
      }
      send({ id: m.id, result: {} });
      event('turn/completed', { threadId: m.params.threadId, turn: { id: m.params.turnId, status: 'interrupted', items: [] } });
      break;
    default: send({ id: m.id, error: { code: -32601, message: 'unknown method' } });
  }
});
process.stdin.on('end', () => { clearTimeout(timer); process.exit(0); });
