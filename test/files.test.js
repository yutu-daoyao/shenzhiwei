import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rename, symlink, link } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceFiles } from '../src/server/files.js';
import { start } from '../src/main.js';
import { AppServer } from '../src/codex/process.js';

const workspace = fileURLToPath(new URL('../test-workspace/', import.meta.url));
async function fixture() { await mkdir(workspace, { recursive: true }); return mkdtemp(path.join(workspace, 'files-test-')); }
test('workspace delivery reads real UTF-8/UTF-16 files, preserves download bytes and bounds preview', async () => {
  const directory = await fixture(), files = new WorkspaceFiles(directory); await files.checkRoot();
  await writeFile(path.join(directory, '中文.txt'), '你好，沈知微');
  const utf16 = Buffer.concat([Buffer.from([255, 254]), Buffer.from('真实界面保存内容', 'utf16le')]);
  await writeFile(path.join(directory, 'unicode.md'), utf16);
  const large = '微'.repeat(24000); await writeFile(path.join(directory, 'large.txt'), large);
  assert.equal((await files.read('中文.txt')).text, '你好，沈知微');
  assert.equal((await files.read('unicode.md')).text, '真实界面保存内容');
  assert.deepEqual((await files.read('unicode.md', true)).bytes, utf16);
  const preview = await files.read('large.txt'); assert.equal(preview.truncated, true); assert.ok(!preview.text.includes('\ufffd')); assert.ok(Buffer.byteLength(preview.text) <= 65536);
  assert.equal((await files.read('large.txt', true)).text, large);
});
test('delivery rejects traversal, reserved names, binary/oversized files, links and replaced roots', async () => {
  const parent = await fixture(), directory = path.join(parent, 'root'), outside = path.join(parent, 'outside');
  await mkdir(directory); await mkdir(outside); const files = new WorkspaceFiles(directory); await files.checkRoot();
  for (const name of ['../outside.txt', 'C:\\outside.txt', 'a.txt:stream', '.hidden.txt', 'CON.txt', 'run.cmd', 'bad\n.txt']) await assert.rejects(files.read(name), /只支持/);
  await writeFile(path.join(directory, 'binary.txt'), Buffer.from([0, 1, 2]));
  await writeFile(path.join(directory, 'huge.txt'), Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(files.read('binary.txt'), /二进制/); await assert.rejects(files.read('huge.txt'), /超过/);
  await writeFile(path.join(outside, 'external.txt'), 'ONLY_TEST_DATA');
  await link(path.join(outside, 'external.txt'), path.join(directory, 'linked.txt'));
  await assert.rejects(files.read('linked.txt'), /链接/);
  await symlink(outside, path.join(directory, 'directory.txt'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(files.read('directory.txt'), /链接/);
  assert.ok(!(await files.list()).files.some(f => ['linked.txt', 'directory.txt', 'huge.txt'].includes(f.name)));
  await rename(directory, directory + '-original'); await mkdir(directory);
  await assert.rejects(files.list(), /替换/);
});
test('HTTP file preview/download use the existing origin gate plus a CSRF header and never serve HTML', async t => {
  const directory = await fixture(); await writeFile(path.join(directory, '结果.txt'), '<script>not executable</script>\n知微');
  const rpc = new AppServer({ command: process.execPath, args: [fileURLToPath(new URL('./fixtures/mock-server.mjs', import.meta.url)), 'normal'] });
  const app = await start({ port: 0, workspace: directory, dataDir: path.join(directory, 'state'), rpc }); t.after(() => app.close()); await app.ready;
  const csrf = (await (await fetch(app.origin + '/api/state')).json()).csrf, headers = { 'X-Zhiwei-CSRF': csrf };
  assert.equal((await fetch(app.origin + '/api/files')).status, 403);
  assert.equal((await fetch(app.origin + '/api/files', { headers: { ...headers, Origin: 'https://example.invalid' } })).status, 403);
  const list = await (await fetch(app.origin + '/api/files', { headers })).json(); assert.deepEqual(list.files.map(f => f.name), ['结果.txt']);
  const preview = await fetch(app.origin + '/api/files/preview?name=' + encodeURIComponent('结果.txt'), { headers });
  assert.match(preview.headers.get('content-type'), /application\/json/); assert.equal((await preview.json()).text, '<script>not executable</script>\n知微');
  const download = await fetch(app.origin + '/api/files/download?name=' + encodeURIComponent('结果.txt'), { headers });
  assert.match(download.headers.get('content-disposition'), /^attachment;/); assert.match(download.headers.get('content-disposition'), /filename\*=UTF-8''/); assert.equal(await download.text(), '<script>not executable</script>\n知微');
  assert.equal((await fetch(app.origin + '/api/files/preview?name=..%2Fexternal.txt', { headers })).status, 400);
});
