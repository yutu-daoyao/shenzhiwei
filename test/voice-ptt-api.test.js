import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../src/main.js';

test('real PTT HTTP handler preserves Host/Origin/CSRF guards without opening a port', async t => {
  let handler;
  // Only replace the listening socket; execute the real request handler and voice lifecycle.
  t.mock.method(http, 'createServer', callback => {
    handler = callback;
    return Object.assign(new EventEmitter(), {
      listen(_port, _host, ready) { ready(); }, address:() => ({ port:4317 }),
      close(done) { done(); }, closeIdleConnections() {},
    });
  });
  const workspace = await mkdtemp(path.join(tmpdir(), 'zhiwei-ptt-api-'));
  let app;
  t.after(async () => { await app?.close(); await rm(workspace, { recursive:true, force:true }); });
  const rpc = Object.assign(new EventEmitter(), { connected:true, stop:async () => {} });
  app = await start({ workspace, dataDir:path.join(workspace, 'data'), rpc, voiceEnabled:true,
    voiceOptions:{ config:{ audio:'fake', provider:'fake', asr:'fake', tts:'fake', vad:'fake' } } });
  await app.ready;
  const send = async ({ method = 'POST', url = '/api/voice/ptt', headers = {}, body = '{}' } = {}) => {
    const request = Object.assign(Readable.from([body]), { method, url, headers:{ host:'127.0.0.1:4317', ...headers } });
    let status, result;
    await handler(request, { setHeader() {}, writeHead(code) { status = code; }, end(text) { result = JSON.parse(text); } });
    return { status, body:result };
  };
  const state = await send({ method:'GET', url:'/api/state' });
  const headers = { origin:app.origin, 'x-zhiwei-csrf':state.body.csrf, 'content-type':'application/json' };
  const call = (action, patch = {}) => send({ headers:{ ...headers, ...patch }, body:JSON.stringify({ action }) });
  const ptt = t.mock.method(app.client.voice, 'ptt');
  for (const patch of [{ origin:undefined }, { origin:'' }, { origin:'null' }, { origin:'https://evil.invalid' },
    { host:'evil.invalid' }, { 'sec-fetch-site':'cross-site' }, { 'x-zhiwei-csrf':undefined },
    { 'x-zhiwei-csrf':'bad' }, { 'content-type':'text/plain' }]) {
    for (const action of ['start', 'stop']) assert.equal((await call(action, patch)).status, 403);
  }
  assert.equal(ptt.mock.callCount(), 0, 'forged requests never reach voice');
  for (const method of ['GET', 'PUT', 'DELETE']) assert.equal((await send({ method, headers })).status, 404);
  for (const body of ['null', '[]', '{bad', '"start"']) assert.equal((await send({ headers, body })).status, 400);
  for (const action of [undefined, 'other', 1]) assert.equal((await call(action)).status, 400);
  assert.equal((await call('start')).status, 200);
  assert.equal(app.client.voice.snapshot().held, true);
  // Prevent fake recognized text from becoming an actual Codex request.
  app.client.voice.pipeline.session.end = () => {};
  assert.equal((await call('stop')).status, 200);
  assert.equal(app.client.voice.snapshot().held, false);
  await app.client.voice.setEnabled(false);
  assert.equal((await call('start')).status, 400);
  assert.equal((await call('stop')).status, 200);
});
