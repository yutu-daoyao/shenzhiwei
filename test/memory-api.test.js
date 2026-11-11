import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openMemory } from '../src/memory/store.js';
import { memoryList, memoryDelete } from '../src/server/memory.js';

test('memory API lists all categories, pages, searches literal keywords and persists targeted deletion', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhiwei-memory-api-'));
  const store = await openMemory(dir), other = await openMemory(dir);
  t.after(async () => { other.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  store.setPreference('语言', '中文');
  const fact = store.remember('<script>茶</script>', '100%_\\');
  store.remember('中文笔记', '', 'note');
  store.recordTask({ request: '中文任务', outcome: '已完成', status: 'completed' });
  const list = q => memoryList(store, new URLSearchParams(q));
  assert.equal(list('').body.entries.length, 4);
  assert.deepEqual(new Set(list('').body.entries.map(e => e.kind)), new Set(['fact', 'note', 'preference', 'task']));
  assert.equal(list('q=中文').body.entries.length, 3);
  for (const q of ['%', '_', '\\']) assert.equal(list({ q }).body.entries[0].id, fact.id);
  assert.equal(list({ q: "' OR 1=1 --" }).body.entries.length, 0);
  for (let i = 0; i < 24; i++) store.remember(`分页${i}`);
  const first = list('').body, second = list('offset=20').body;
  assert.equal(first.entries.length, 20); assert.equal(first.hasMore, true);
  assert.equal(second.entries.length, 8); assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.entries, ...second.entries].map(e => `${e.type}:${e.id}`)).size, 28);
  for (const entry of list('q=中文').body.entries) {
    assert.equal(memoryDelete(store, entry).status, 200);
    assert.equal(memoryDelete(store, entry).status, 404);
  }
  assert.equal(other.listEntries('中文').entries.length, 0);
  assert.equal(other.search('茶').length, 1);
  assert.equal(memoryDelete(store, { type: 'memory', id: fact.id }).status, 200);
  assert.equal(other.search('茶').length, 0);
  const reopened = await openMemory(dir);
  try {
    assert.equal(reopened.getPreferences().length, 0);
    assert.equal(reopened.recentTasks().length, 0);
    assert.equal(reopened.search('茶').length, 0);
  } finally { reopened.close(); }
  for (const offset of ['-1', '1.5', 'NaN', '9007199254740992', '']) assert.equal(list({ offset }).status, 400);
  assert.equal(list({ q: 'a'.repeat(2001) }).status, 400);
  for (const body of [{}, { type: 'memory', id: '1' }, { type: 'task', id: -1 }, { type: 'task', id: 1.5 }, { type: 'preference', id: 1 }, { type: 'preference', id: '' }, { type: 'invalid', id: 1 }]) assert.equal(memoryDelete(store, body).status, 400);
  assert.equal(memoryList(null, new URLSearchParams()).status, 503);
  assert.equal(memoryDelete(null, { type: 'task', id: 1 }).status, 503);
});
