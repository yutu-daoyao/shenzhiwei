import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { Computer } from '../src/windows/computer.js';

function computer(t) {
  const backend = new EventEmitter(); backend.calls = [];
  backend.call = async op => { backend.calls.push(op); return op === 'desktop_status' ? { locked:false } : { window:{ id:'123' }, text:'observed' }; };
  backend.cancel = () => {};
  const c = new Computer({ workspace:process.cwd(), backend });
  c.beginTurn(); t.after(() => c.close()); return c;
}
const unpack = result => JSON.parse(result.content[0].text);
async function approval(c) {
  // Subscribe before the queue starts; no polling or listener is needed.
  await new Promise(resolve => {
    const changed = () => { if (c.pending.size) { c.off('change', changed); resolve(); } };
    c.on('change', changed); changed();
  });
  return [...c.pending.keys()][0];
}
for (const decision of ['decline', 'stop']) test(`${decision} while approval is pending cancels without launching the backend`, async t => {
  const c = computer(t), result = c.call('windows_launch_app', { app:'calculator' });
  const id = await approval(c);
  assert.equal(c.actions.get(id).status, 'awaitingApproval');
  if (decision === 'stop') c.cancel(); else c.approve(id, 'decline');
  const response = unpack(await result);
  assert.equal(response.status, 'cancelled'); assert.equal(response.safeToRetry, false);
  assert.deepEqual(c.backend.calls, ['desktop_status']); assert.equal(c.pending.size, 0);
  assert.throws(() => c.approve(id, 'accept'), /失效/);
});
test('unresolved mutation blocks same-window effects while permitting reads', async t => {
  const c = computer(t);
  c.owned.set('123', { id:'123', pid:8, app:'notepad', className:'Notepad' });
  c.actions.set('unknown', { id:'unknown', tool:'windows_set_text', status:'unknown', scope:{ windowId:'123' } });
  const blocked = unpack(await c.call('windows_focus_window', { windowId:'123' }));
  assert.equal(blocked.status, 'failed'); assert.match(blocked.error, /结果未知/);
  assert.equal(c.pending.size, 0); assert.ok(!c.backend.calls.includes('focus_window'));
  const read = unpack(await c.call('windows_read_text', { windowId:'123' }));
  assert.equal(read.ok, true); assert.equal(read.text, 'observed');
  assert.ok(c.backend.calls.includes('read_text'));
  assert.equal(c.actions.get('unknown').status, 'unknown');
});
test('browser search uses one approval and launches Bing with a dedicated profile', async t => {
  const c = computer(t), calls = [];
  const original = c.backend.call;
  c.backend.call = async (op, params) => { calls.push({ op, params }); return original(op, params); };
  const query = '今天的 AI 新闻 & GPT';
  const result = c.call('windows_browser_search', { query });
  const id = await approval(c);
  assert.equal(c.pending.size, 1);
  assert.equal(c.pending.get(id).params.url, `https://www.bing.com/search?q=${encodeURIComponent(query)}`);
  c.approve(id, 'accept');
  assert.equal(unpack(await result).ok, true);
  const launch = calls.find(c => c.op === 'launch_app');
  assert.equal(launch.params.app, 'browser');
  assert.equal(launch.params.url, `https://www.bing.com/search?q=${encodeURIComponent(query)}`);
  assert.equal(launch.params.profileDir, c.browserProfile);
  assert.ok(launch.params.profileDir.endsWith(path.join('data','browser-profile')));
  assert.equal(c.owned.get('123').app, 'browser');
});
test('browser operations tolerate navigation title changes and reject set_text', async t => {
  const c = computer(t);
  c.owned.set('123', { id:'123', pid:8, app:'browser', className:'Chrome_WidgetWin_1', title:'Search' });
  c.rememberWindow(c.owned.get('123'));
  c.owned.get('123').title = 'Article';
  assert.equal(c.savedWindows()[0].status, 'bound');
  c.backend.call = async (op, params) => {
    c.backend.calls.push(op);
    if (op === 'desktop_status') return { locked:false };
    return { window:{ id:'123', title:'Article', bounds:{} }, elements:[], snapshot:'s', width:10, height:10, data:op === 'capture_window' ? 'aW1hZ2U=' : undefined, mimeType:'image/png' };
  };
  for (const op of ['read_text','get_ui_tree','find_element','click_element','focus_window','capture_window','send_keys','close_window']) {
    const params = { windowId:'123', ...(op === 'find_element' ? { query:'AI' } : {}), ...(op === 'click_element' ? { snapshot:'s', elementId:'1' } : {}), ...(op === 'send_keys' ? { key:'Down' } : {}) };
    const result = c.call('windows_'+op, params);
    if (['click_element','focus_window','capture_window','send_keys','close_window'].includes(op)) c.approve(await approval(c), 'accept');
    assert.equal(unpack(await result).ok, true, op);
    assert.ok(c.backend.calls.includes(op));
  }
  const denied = unpack(await c.call('windows_set_text', { windowId:'123', snapshot:'s', elementId:'1', text:'bad' }));
  assert.equal(denied.ok, false);
  assert.match(denied.error, /记事本/);
  assert.ok(!c.backend.calls.includes('set_text'));
});
test('system skills use approval and dispatch without owned windows', async t => {
  const c = computer(t), calls = [];
  const { SystemSkills } = await import('../src/windows/skills.js');
  c.skills = new SystemSkills({workspace:process.cwd(),run:async (script,{input}) => { calls.push({script,input}); return {launched:input.target}; }});
  const result = c.call('windows_open_app',{name:'记事本'});
  const id = await approval(c);
  assert.equal(c.pending.get(id).tool,'windows_open_app'); assert.equal(calls.length,0);
  c.approve(id,'accept');
  assert.equal(unpack(await result).launched,'notepad.exe');
  assert.equal(c.actions.get(id).status,'completed'); assert.equal(c.owned.size,0);
  assert.deepEqual(c.backend.calls,['desktop_status']); assert.equal(calls.length,1);
});
test('interrupted system skill is unknown and cannot be replayed before review', async t => {
  const c = computer(t); let finish, started;
  const running = new Promise(resolve => { started=resolve; });
  c.skills = {clipboard_write:() => { started(); return new Promise(resolve => { finish=resolve; }); }};
  const result = c.call('windows_clipboard_write',{text:'hello'});
  const id = await approval(c); c.approve(id,'accept'); await running;
  c.cancel(); finish({written:5});
  assert.equal(unpack(await result).status,'unknown');
  c.beginTurn();
  const blocked = unpack(await c.call('windows_clipboard_write',{text:'hello'}));
  assert.equal(blocked.status,'failed'); assert.match(blocked.error,/结果未知/); assert.equal(c.pending.size,0);
});
