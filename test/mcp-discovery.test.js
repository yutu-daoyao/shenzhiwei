import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { tools } from '../src/windows/tools.js';

test('MCP stdio discovery advertises exact tool schemas without contacting a broker', { timeout:4000 }, async t => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/windows/mcp-server.js', import.meta.url))], {
    env:{ ...process.env, ZHIWEI_WINDOWS_URL:'http://127.0.0.1:1/tool', ZHIWEI_WINDOWS_CAPABILITY:'fixture' }, stdio:['pipe','pipe','pipe'],
  });
  t.after(() => child.kill()); child.stderr.resume();
  const lines = readline.createInterface({ input:child.stdout });
  const replies = new Map();
  const received = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (replies.size < 3) reject(new Error(`MCP exited before discovery: ${code ?? signal}`));
    });
    lines.on('line', line => {
      try {
        const reply = JSON.parse(line); replies.set(reply.id, reply); if (replies.size === 3) resolve();
      } catch (error) { reject(error); }
    });
  });
  for (const [id, method, params] of [[0, 'initialize', { protocolVersion:'2024-11-05' }], ['list', 'tools/list', {}], ['unsupported', 'unknown', {}]]) child.stdin.write(JSON.stringify({ jsonrpc:'2.0', id, method, params }) + '\n');
  await received;
  assert.equal(replies.get(0).result.protocolVersion, '2024-11-05');
  assert.deepEqual(replies.get(0).result.capabilities, { tools:{ listChanged:false } });
  assert.deepEqual(replies.get('list').result.tools, tools);
  assert.equal(replies.get('unsupported').error.code, -32601);
  const closed = once(child, 'close'); child.stdin.end();
  assert.equal((await closed)[0], 0);
});
