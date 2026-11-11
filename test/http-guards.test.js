import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { start } from '../src/main.js';
import { FakeCapture, FakePlayback } from '../src/voice/audio.js';

test('HTTP guards reject forged writes, wrong methods and oversized UTF-8 bodies before dispatch', async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'zhiwei-guards-'));
  let app;
  t.after(async () => { await app?.close(); await rm(workspace, { recursive:true, force:true }); });
  const rpc = new EventEmitter(); let calls = 0;
  Object.assign(rpc, { connected:true, stop:async () => {}, request:async () => { calls++; throw new Error('unexpected dispatch'); } });
  app = await start({ port:0, workspace, dataDir:path.join(workspace, 'data'), rpc });
  assert.equal(app.tray, null, 'injected RPC must not launch a real Windows tray');
  await app.ready;
  const animation = await fetch(app.origin + '/artwork-motion.js');
  assert.equal(animation.status, 200);
  assert.match(animation.headers.get('content-type'), /javascript/);
  assert.match(await animation.text(), /export function createArtworkSurface/);
  const csrf = (await (await fetch(app.origin + '/api/state')).json()).csrf;
  const headers = { Origin:app.origin, 'X-Zhiwei-CSRF':csrf, 'Content-Type':'application/json' };
  assert.equal(animation.headers.get('permissions-policy'),'geolocation=(self)');
  for(const module of ['/reply-view.js','/work-surface.js']){const response=await fetch(app.origin+module);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/javascript/);await response.text();}
  assert.equal((await fetch(app.origin+'/api/weather?latitude=91&longitude=1',{headers})).status,400);
  assert.equal((await fetch(app.origin+'/api/weather?latitude=31',{headers})).status,400);
  assert.equal((await fetch(app.origin+'/api/weather?latitude=31&longitude=121')).status,403);
  for (const patch of [{ Origin:'' }, { Origin:'null' }, { 'X-Zhiwei-CSRF':'wrong' }, { 'Content-Type':'text/plain' }]) {
    const response = await fetch(app.origin + '/api/new', { method:'POST', headers:{ ...headers, ...patch }, body:'{}' });
    assert.equal(response.status, 403); await response.arrayBuffer();
  }
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const response = await fetch(app.origin + '/api/new', { method, headers });
    assert.equal(response.status, 404); await response.arrayBuffer();
  }
  for (const body of ['[]', 'null', '42', '{broken']) {
    const response = await fetch(app.origin + '/api/new', { method:'POST', headers, body });
    assert.equal(response.status, 400); await response.arrayBuffer();
  }
  const large = await fetch(app.origin + '/api/new', { method:'POST', headers, body:JSON.stringify({ text:'微'.repeat(50000) }) });
  assert.equal(large.status, 413); await large.arrayBuffer();
  await writeFile(path.join(workspace, 'invalid.txt'), Buffer.from([0xff]));
  for (const suffix of ['/api/files/preview?name=missing.txt', '/api/files/preview?name=invalid.txt', '/api/files/download?name=..%2Fsecret.txt']) {
    const response = await fetch(app.origin + suffix, { headers });
    assert.equal(response.status, 400); await response.arrayBuffer();
  }
  assert.equal(calls, 0);
});

test('memory HTTP routes enforce guards and support list/search/delete without Codex', async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'zhiwei-memory-http-'));
  let app;
  t.after(async () => { await app?.close(); await rm(workspace, { recursive:true, force:true }); });
  const rpc = new EventEmitter();
  Object.assign(rpc, { connected: true, stop: async () => {}, request: async () => { throw new Error('offline'); } });
  app = await start({ port: 0, workspace, dataDir: path.join(workspace, 'data'), rpc });
  await app.ready;
  const fact = app.client.memory.remember('HTTP测试', '关键词');
  const csrf = (await (await fetch(app.origin + '/api/state')).json()).csrf;
  const headers = { Origin: app.origin, 'X-Zhiwei-CSRF': csrf, 'Content-Type': 'application/json' };
  const get = (suffix, custom = headers) => fetch(app.origin + suffix, { headers: custom });
  assert.equal((await get('/api/memory', {})).status, 403);
  assert.equal((await get('/api/memory', { ...headers, Origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await get('/api/memory', { ...headers, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const list = await (await get('/api/memory?q=' + encodeURIComponent('关键词'))).json();
  assert.equal(list.entries[0].id, fact.id);
  assert.equal((await get('/api/memory?offset=-1')).status, 400);
  const remove = (body, custom = headers) => fetch(app.origin + '/api/memory/delete', { method: 'POST', headers: custom, body: JSON.stringify(body) });
  for (const patch of [{ Origin: '' }, { 'X-Zhiwei-CSRF': 'bad' }, { 'Content-Type': 'text/plain' }]) assert.equal((await remove({ type: 'memory', id: fact.id }, { ...headers, ...patch })).status, 403);
  assert.equal(app.client.memory.search('HTTP测试').length, 1);
  assert.equal((await remove({ type: 'memory', id: '1' })).status, 400);
  assert.equal((await get('/api/memory/delete')).status, 404);
  assert.equal((await remove({ type: 'memory', id: fact.id })).status, 200);
  assert.equal((await remove({ type: 'memory', id: fact.id })).status, 404);
  assert.equal((await (await get('/api/memory')).json()).entries.length, 0);
});

// Requires loopback permission; written for Windows, not run in the no-port sandbox.
test('voice HTTP switch uses existing guards, validates booleans and exposes lifecycle', async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'zhiwei-voice-http-'));
  let app;
  t.after(async () => { await app?.close(); await rm(workspace, { recursive:true, force:true }); });
  const rpc = new EventEmitter();
  Object.assign(rpc, { connected:true, stop:async () => {}, request:async () => { throw new Error('unexpected Codex call'); } });
  app = await start({ port:0, workspace, dataDir:path.join(workspace, 'data'), rpc, voiceEnabled:true,
    voiceOptions:{ config:{ mode:'ptt', audio:'fake', provider:'fake', asr:'fake', tts:'fake', vad:'fake' } } });
  await app.ready;
  const state = await (await fetch(app.origin + '/api/state')).json();
  assert.equal(state.voice.enabled, true); assert.equal(state.voice.state, 'idle');
  const headers = { Origin:app.origin, 'X-Zhiwei-CSRF':state.csrf, 'Content-Type':'application/json' };
  const toggle = (enabled, custom = headers) => fetch(app.origin + '/api/voice', { method:'POST', headers:custom, body:JSON.stringify({ enabled }) });
  assert.equal((await toggle(false, { ...headers, 'X-Zhiwei-CSRF':'wrong' })).status, 403);
  assert.equal(app.client.voice.enabled, true);
  assert.equal((await toggle('false')).status, 400);
  assert.equal((await toggle(false)).status, 200);
  assert.equal(app.client.voice.capture.active, false);
  assert.equal((await toggle(true)).status, 200);
  const ptt = (action, custom = headers) => fetch(app.origin + '/api/voice/ptt', { method:'POST', headers:custom, body:JSON.stringify({ action }) });
  assert.equal((await ptt('start', { ...headers, Origin:'https://evil.invalid' })).status, 403);
  assert.equal((await ptt('start')).status, 200);
  assert.equal(app.client.voice.snapshot().held, true);
  app.client.voice.pipeline.session.end = () => {}; // Hold final until the explicit stop below.
  assert.equal((await ptt('stop')).status, 200);
  assert.equal(app.client.voice.snapshot().held, false);
  const stop = await fetch(app.origin + '/api/stop', { method:'POST', headers, body:'{}' });
  assert.equal(stop.status, 200); assert.equal(app.client.voice.enabled, true);
  assert.equal((await toggle(false)).status, 200);
});

// Requires loopback permission; run on Windows with the rest of the HTTP checks.
test('exit during automatic microphone startup releases the HTTP server and memory', async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'zhiwei-exit-http-'));
  const rpc = new EventEmitter(), capture = new EventEmitter();
  let app, started = false;
  t.after(async () => { await app?.close(); await rm(workspace, { recursive:true, force:true }); });
  Object.assign(rpc, { connected:true, stop:async () => {} });
  Object.assign(capture, { start:() => { started = true; return new Promise(() => {}); }, close:async () => {} });
  app = await start({ port:0, workspace, dataDir:path.join(workspace, 'data'), rpc, voiceEnabled:true,
    voiceOptions:{ capture, config:{ audio:'fake', provider:'fake', vad:'fake' } } });
  for (let n = 0; !started && n < 100; n++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, true);
  await app.close();
  assert.equal(app.server.listening, false);
  assert.equal(app.client.memory, null);
  assert.equal(capture.listenerCount('frame'), 0);
});

test('tray actions share voice lifecycle and exit closes the application once', async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'zhiwei-tray-http-'));
  let app;
  t.after(async () => { await app?.close(); await rm(workspace, { recursive:true, force:true }); });
  const rpc = new EventEmitter(), tray = new EventEmitter();
  let trayClosed = 0, startup;
  Object.assign(rpc, { connected:true, stop:async () => {}, request:async () => { throw new Error('unexpected Codex call'); } });
  Object.assign(tray, { start:async options => { startup = options; }, setListening:value => { tray.listening = value; }, close:async () => { trayClosed++; } });
  app = await start({ port:0, workspace, dataDir:path.join(workspace, 'data'), rpc, tray, autostart:true,
    voiceOptions:{ config:{ audio:'fake', provider:'fake', asr:'fake', tts:'fake', vad:'fake' } } });
  await app.ready;
  assert.equal(startup.origin, app.origin); assert.equal(startup.autostart, true);
  async function waitFor(predicate) {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('tray action timed out');
  }
  tray.emit('action', 'start'); await waitFor(() => app.client.voice.enabled && !app.client.voice.changing);
  assert.equal(tray.listening, true);
  tray.emit('action', 'stop'); await waitFor(() => !app.client.voice.enabled && !app.client.voice.changing);
  assert.equal(tray.listening, false);
  tray.emit('action', 'exit'); await app.close();
  assert.equal(trayClosed, 1); assert.equal(app.server.listening, false);
});

// Requires loopback permission. Keep for Windows; device startup itself is fake.
test('HTTP can cancel a pending microphone enable and app shutdown does not await device readiness', async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'zhiwei-mic-http-'));
  t.after(() => rm(workspace, { recursive:true, force:true }));
  const rpc = new EventEmitter(), capture = new FakeCapture();
  Object.assign(rpc, { connected:true, stop:async () => {} });
  capture.start = () => new Promise(() => {});
  const app = await start({ port:0, workspace, dataDir:path.join(workspace, 'data'), rpc, trayEnabled:false,
    voiceOptions:{ capture, playback:new FakePlayback(), config:{ provider:'fake', asr:'fake', tts:'fake', vad:'fake' } } });
  t.after(() => app.close()); await app.ready;
  const { csrf } = await (await fetch(app.origin + '/api/state')).json();
  const toggle = enabled => fetch(app.origin + '/api/voice', { method:'POST', headers:{ Origin:app.origin, 'X-Zhiwei-CSRF':csrf, 'Content-Type':'application/json' }, body:JSON.stringify({ enabled }) });
  const enabling = toggle(true);
  while (!app.client.voice.enabled) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await toggle(false)).status, 200);
  assert.equal((await enabling).status, 200); assert.equal(app.client.voice.enabled, false);
  const again = app.client.voice.setEnabled(true);
  await new Promise(resolve => setTimeout(resolve, 5));
  await app.close(); await again;
  assert.equal(app.server.listening, false);
});
