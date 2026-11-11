import test from 'node:test';
import assert from 'node:assert/strict';
import { staticHandler, CDP } from '../scripts/orb-capture.js';

const response = () => ({ status:0, writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } });
test('capture server serves only public assets and simulation pages without a backend', async () => {
  const handler = staticHandler();
  for (const [url, mime] of [['/?orbSim=idle', 'text/html'], ['/orb.js', 'text/javascript'], ['/style.css', 'text/css'], ['/folder.svg', 'image/svg+xml']]) {
    const res = response(); await handler({ method:'GET', url }, res);
    assert.equal(res.status, 200); assert.ok(res.headers['Content-Type'].startsWith(mime));
  }
  for (const url of ['/api/events', '/%2e%2e%2fpackage.json', '/%2e%2e%2fsrc/main.js']) {
    const res = response(); await handler({ method:'GET', url }, res);
    assert.ok([403, 404].includes(res.status));
  }
  const res = response(); await handler({ method:'POST', url:'/' }, res); assert.equal(res.status, 405);
});
test('CDP correlates out of order replies, propagates errors, bounds timeouts and rejects on disconnect', async () => {
  const listeners = {}, sent = [];
  const client = new CDP({ addEventListener(type, fn) { listeners[type] = fn; }, send(data) { sent.push(JSON.parse(data)); } }, 15);
  const reply = data => listeners.message({ data:JSON.stringify(data) });
  const first = client.call('Page.enable', {}, 'session'), second = client.call('Runtime.enable');
  assert.equal(sent[0].sessionId, 'session');
  reply({ id:sent[1].id, result:{ ok:2 } }); reply({ id:sent[0].id, result:{ ok:1 } });
  assert.deepEqual(await first, { ok:1 }); assert.deepEqual(await second, { ok:2 });
  const failure = assert.rejects(client.call('bad'), /invalid/); reply({ id:sent.at(-1).id, error:{ message:'invalid' } }); await failure;
  await assert.rejects(client.call('stalled'), /CDP 超时/);
  const closed = assert.rejects(client.call('pending'), /已关闭/); listeners.close(); await closed;
  assert.equal(client.pending.size, 0); await assert.rejects(client.call('after-close'), /已关闭/);
});
