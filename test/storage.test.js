import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Sessions } from '../src/codex/sessions.js';
import { WindowsJournal } from '../src/windows/journal.js';

async function directory(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhiwei-storage-'));
  t.after(() => rm(dir, { recursive:true, force:true })); return dir;
}
test('session loader strips foreign fields and preserves invalid indexes', async t => {
  const store = new Sessions(await directory(t));
  const entry = { id:'one', title:'title', createdAt:'a', updatedAt:'b' };
  await writeFile(store.file, JSON.stringify([{ ...entry, secret:'private' }]));
  await store.load(); assert.deepEqual(store.entries, [entry]);
  for (const invalid of [{}, [{ ...entry, title:4 }], [{ id:'incomplete' }]]) {
    const raw = JSON.stringify(invalid); await writeFile(store.file, raw);
    await assert.rejects(store.load(), /不会覆盖/);
    assert.equal(await readFile(store.file, 'utf8'), raw);
    assert.deepEqual(store.entries, [entry]);
  }
});
test('session write failure preserves memory and the queue accepts a later retry', async t => {
  const dir = await directory(t), store = new Sessions(dir);
  await store.load();
  const entry = { id:'one', title:'title', createdAt:'a', updatedAt:'b' };
  await store.put(entry);
  await mkdir(store.file + '.blocked');
  const file = store.file; store.file = path.join(store.file + '.blocked', 'missing', 'sessions.json');
  await assert.rejects(store.put({ ...entry, title:'failed' }), { code:'ENOENT' });
  assert.deepEqual(store.entries, [entry]); assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), [entry]);
  store.file = file; await store.put({ ...entry, title:'retry' });
  assert.equal(store.entries.length, 1); assert.equal(store.entries[0].title, 'retry');
  assert.ok(!(await readdir(dir)).some(name => name.endsWith('.tmp')));
});
test('journal serializes atomic saves, limits records and reconciles restart states', async t => {
  const dir = await directory(t), journal = new WindowsJournal(dir);
  assert.deepEqual(await journal.load('workspace'), { actions:[], bindings:[] });
  const actions = Array.from({ length:104 }, (_, n) => ({ id:String(n), tool:'windows_set_text', status:['running','queued','awaitingApproval','completed'][n % 4], params:{ text:'PRIVATE' } }));
  const bindings = Array.from({ length:24 }, (_, n) => ({ id:String(n), status:'bound', proof:{ id:String(n), pid:n, processStartedAt:'time', className:n % 2 ? 'Chrome_WidgetWin_1' : 'Notepad', app:n % 2 ? 'browser' : 'notepad', secret:'PRIVATE' } }));
  await Promise.all([journal.save('workspace', [], []), journal.save('workspace', actions, bindings)]);
  const raw = await readFile(journal.file, 'utf8'); assert.ok(!raw.includes('PRIVATE'));
  const saved = JSON.parse(raw); assert.equal(saved.actions.length, 100); assert.equal(saved.bindings.length, 20);
  assert.equal(saved.actions[0].id, '4'); assert.equal(saved.bindings[0].id, '4');
  const loaded = await journal.load('workspace');
  assert.deepEqual(loaded.actions.slice(0, 4).map(a => a.status), ['unknown','cancelled','cancelled','completed']);
  assert.ok(loaded.bindings.every(b => b.status === 'saved'));
  assert.ok(loaded.bindings.some(b => b.proof.app === 'browser'));
  assert.deepEqual(await readdir(dir), ['windows-state.json']);
});
test('journal rejects corrupt, foreign and invalid records without changing their bytes', async t => {
  const journal = new WindowsJournal(await directory(t));
  const base = { version:1, workspace:'workspace', actions:[], bindings:[] };
  for (const value of ['{broken', JSON.stringify({ ...base, workspace:'foreign' }), JSON.stringify({ ...base, actions:[{ id:'1', tool:'tool', status:'invalid' }] }), JSON.stringify({ ...base, bindings:[{ id:'1', proof:{ app:'terminal' } }] }), JSON.stringify({ ...base, actions:[{ id:'1', tool:'tool', status:'unknown', resolution:'retry' }] })]) {
    await writeFile(journal.file, value);
    await assert.rejects(journal.load('workspace'), /已保留原文件/);
    assert.equal(await readFile(journal.file, 'utf8'), value);
  }
});
