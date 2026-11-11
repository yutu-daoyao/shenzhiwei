import {guardLiveScript} from './live-guard.js';
guardLiveScript(import.meta.url);
// Opt-in, one-shot Windows acceptance. No retries or checkpoints.
import assert from 'node:assert/strict';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { start, root } from '../src/main.js';

let app, csrf;
async function post(route, body = {}) {
  const response = await fetch(app.origin+'/api/'+route, { method:'POST', headers:{ Origin:app.origin, 'X-Zhiwei-CSRF':csrf, 'Content-Type':'application/json' }, body:JSON.stringify(body) });
  const result = await response.json();
  assert.equal(response.status, 200, result.error);
  return result;
}
try {
  assert.equal(process.platform, 'win32', '此验收只能在 Windows 上运行');
  app = await start({ port:0, dataDir:path.join(root, 'data', 'browser-live-tests') });
  await app.ready;
  assert.equal(app.client.connection, 'connected', app.client.error);
  csrf = (await (await fetch(app.origin+'/api/state')).json()).csrf;
  const c = app.client.computer;
  const desktop = await c.checkDesktop();
  if (desktop.locked) throw Object.assign(new Error('桌面已锁屏，请本人解锁后再运行'), { code:'DESKTOP_LOCKED' });
  const seen = new Set(), before = new Set(c.actions.keys());
  c.on('change', () => {
    for (const p of c.snapshot().approvals) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const allowed = (p.tool === 'windows_launch_app' && p.params.app === 'browser') || p.tool === 'windows_browser_search' ||
        (p.tool === 'windows_click_element' && c.owned.get(p.params.windowId)?.app === 'browser');
      c.approve(p.id, allowed ? 'accept' : 'decline');
    }
  });
  await post('new');
  const { turnId } = await post('send', { text:'知微，打开浏览器搜今天的 AI 新闻，读一下搜索结果，挑三条用中文简单告诉我。只用 zhiwei_windows 的工具。' });
  const deadline = Date.now()+240000;
  while (Date.now() < deadline) {
    if (c.desktop?.locked) throw Object.assign(new Error('桌面已锁屏'), { code:'DESKTOP_LOCKED' });
    for (const approval of app.client.approvals.values()) await post('approval', { id:approval.id, decision:'decline' });
    if (app.client.task.turnId === turnId && ['completed','failed','interrupted'].includes(app.client.task.status)) break;
    assert.equal(app.client.connection, 'connected', app.client.error);
    await delay(100);
  }
  assert.equal(app.client.task.status, 'completed', '任务失败或等待超过四分钟');
  const actions = [...c.actions.values()].filter(a => !before.has(a.id));
  const launched = actions.filter(a => a.status === 'completed' && (a.tool === 'windows_browser_search' || (a.tool === 'windows_launch_app' && a.params.app === 'browser')));
  assert.ok(launched.length, '没有工具成功启动浏览器');
  console.log('PASS：工具已启动专用浏览器窗口');
  const ids = new Set(launched.map(a => a.summary.window.id));
  assert.ok(actions.some(a => a.tool === 'windows_read_text' && a.status === 'completed' && ids.has(a.params.windowId)), '没有成功读取浏览器页面');
  console.log('PASS：已通过 windows_read_text 读取网页');
  const answer = app.client.snapshot().items.filter(i => i.turnId === turnId && i.type === 'agentMessage').map(i => i.text).join('\n');
  assert.ok(answer.trim(), '最终回答为空');
  console.log('PASS：已返回聊天回答\n'+answer);
} catch (error) {
  console.error('FAIL：'+error.message);
  process.exitCode = error.code === 'DESKTOP_LOCKED' ? 2 : 1;
} finally { if (app) await app.close(); }
