import test from 'node:test';
import assert from 'node:assert/strict';
import { mountMemory } from '../public/memory-view.js';

function fixture() {
  class Node {
    children = []; textContent = ''; value = ''; open = true;
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
  }
  const nodes = new Map();
  const $ = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const calls = [], confirmations = [];
  let allow = false, failure = false, csrf = 'token';
  const entry = { type: 'memory', id: 1, kind: 'fact', text: '<script>纯文本</script>', tags: '标签', time: '2026-10-30T00:00:00Z' };
  const panel = mountMemory({ document: { getElementById: $, createElement: () => new Node() }, token: () => csrf,
    confirm: message => { confirmations.push(message); return allow; },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: !failure, json: async () => failure ? { error: '数据库不可用' } : options.method === 'POST' ? { ok: true } : { entries: [entry], hasMore: true } };
    } });
  return { $, panel, calls, confirmations, allow: () => { allow = true; }, fail: () => { failure = true; }, noToken: () => { csrf = ''; } };
}

test('memory panel searches, pages, renders literal text and confirms before deleting', async () => {
  const f = fixture(), { $, calls } = f;
  await $('memory-panel').ontoggle();
  assert.equal(calls[0].options.headers['X-Zhiwei-CSRF'], 'token');
  assert.equal($('memory-list').children[0].children[1].textContent, '<script>纯文本</script>');
  const deleteButton = () => $('memory-list').children[0].children.at(-1);
  await deleteButton().onclick();
  assert.equal(calls.length, 1); assert.match(f.confirmations[0], /无法恢复/);
  await $('memory-next').onclick(); assert.match(calls.at(-1).url, /offset=20/);
  await $('memory-prev').onclick(); assert.match(calls.at(-1).url, /offset=0/);
  $('memory-query').value = '茶%';
  await $('memory-search').onsubmit({ preventDefault() {} });
  assert.match(calls.at(-1).url, /q=%E8%8C%B6%25&offset=0/);
  f.allow(); await deleteButton().onclick();
  assert.equal(calls.at(-2).url, '/api/memory/delete');
  assert.deepEqual(JSON.parse(calls.at(-2).options.body), { type: 'memory', id: 1 });
  assert.match(calls.at(-1).url, /offset=0/);
  f.fail(); await $('memory-search').onsubmit({ preventDefault() {} });
  assert.equal($('memory-status').textContent, '数据库不可用');
  assert.equal($('memory-list').children.length, 0);
  assert.equal($('memory-refresh').disabled, false);
  f.noToken(); f.panel.update(); assert.equal($('memory-refresh').disabled, true);
});
