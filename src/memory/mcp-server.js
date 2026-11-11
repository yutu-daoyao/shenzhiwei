import readline from 'node:readline';
import path from 'node:path';
import { openMemory } from './store.js';

const file = process.env.ZHIWEI_MEMORY_DB;
if (!file) process.exit(1);
const store = await openMemory(path.dirname(file), { file });
if (!store) process.exit(1);
const string = { type: 'string' }, number = { type: 'integer' };
const definitions = [
  ['memory_remember', '保存用户明确陈述的稳定事实或笔记', { text: string, tags: { anyOf: [string, { type: 'array', items: string }] } }, ['text'], a => store.remember(a.text, a.tags)],
  ['memory_search', '查找长期记忆', { query: string, limit: number }, ['query'], a => store.search(a.query, a.limit)],
  ['memory_forget', '删除记忆', { id: number }, ['id'], a => store.forget(a.id)],
  ['memory_set_preference', '保存用户偏好', { key: string, value: string }, ['key', 'value'], a => { store.setPreference(a.key, a.value); return { saved: true }; }],
  ['memory_list_preferences', '列出用户偏好', {}, [], () => store.getPreferences()],
  ['memory_recent_tasks', '查看最近任务', { limit: number }, [], a => store.recentTasks(a.limit)],
];
const tools = definitions.map(([name, description, properties, required]) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } }));
const input = readline.createInterface({ input: process.stdin });
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
input.on('close', () => store.close());
input.on('line', line => {
  let message;
  try {
    message = JSON.parse(line);
    if (message.id === undefined) return;
    let result;
    switch (message.method) {
      case 'initialize': result = { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'zhiwei-memory', version: '1.0.0' } }; break;
      case 'ping': result = {}; break;
      case 'tools/list': result = { tools }; break;
      case 'tools/call': {
        const tool = definitions.find(([name]) => name === message.params?.name);
        if (!tool) throw new Error('未知记忆工具');
        const args = message.params.arguments || {};
        for (const key of tool[3]) if (args[key] === undefined) throw new Error(`缺少参数：${key}`);
        result = { content: [{ type: 'text', text: JSON.stringify(tool[4](args)) }] }; break;
      }
      default: send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported MCP method' } }); return;
    }
    send({ jsonrpc: '2.0', id: message.id, result });
  } catch (error) {
    send({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32603, message: error.message } });
  }
});
