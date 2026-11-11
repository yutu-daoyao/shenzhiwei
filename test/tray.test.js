import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { TrayController, autostartCommand } from '../src/tray/controller.js';

function fake({ ready = true, exits = true } = {}) {
  const packets = [], calls = [], killed = [];
  let child;
  const tray = new TrayController({ platform:'win32', timeoutMs:15,
    spawnProcess(...args) {
      calls.push(args);
      child = new EventEmitter();
      Object.assign(child, { pid:1234, stdout:new PassThrough(), stderr:new PassThrough() });
      child.stdin = new Writable({ write(chunk, encoding, done) {
        const message = JSON.parse(chunk.toString()); packets.push(message); done();
        if (message.type === 'configure' && ready) queueMicrotask(() => child.stdout.write('{"type":"rea'));
        if (message.type === 'configure' && ready) queueMicrotask(() => child.stdout.write('dy"}\n'));
        if (message.type === 'quit' && exits) queueMicrotask(() => child.emit('close', 0));
      } });
      return child;
    },
    killTree:async owned => { killed.push(owned.pid); child.emit('close', 1); },
  });
  return { tray, packets, calls, killed, get child() { return child; } };
}

test('non Windows has no process or autostart side effects', async () => {
  const tray = new TrayController({ platform:'linux', spawnProcess:() => assert.fail() });
  assert.equal(await tray.start(), false); await tray.close();
});

test('tray JSON lines, actions, state and graceful idempotent shutdown use fake child', async () => {
  const r = fake(), actions = [], failures = [];
  r.tray.on('action', action => actions.push(action)); r.tray.on('failure', error => failures.push(error));
  assert.equal(await r.tray.start({ origin:'http://127.0.0.1:4317' }), true);
  assert.equal(r.packets[0].autostart, false);
  assert.equal(r.calls[0][2].shell, false); assert.ok(r.calls[0][1].includes('-STA'));
  r.child.stdout.write('{"type":"action","action":"start"}\n{"type":"action","action":"stop"}\n');
  assert.deepEqual(actions, ['start', 'stop']);
  r.tray.setListening(true); assert.deepEqual(r.packets.at(-1), { type:'listening', value:true });
  await Promise.all([r.tray.close(), r.tray.close()]); await r.tray.close();
  assert.equal(r.packets.filter(p => p.type === 'quit').length, 1);
  assert.deepEqual(r.killed, []); assert.deepEqual(failures, []);
});

test('startup timeout and stuck shutdown kill only the owned process tree', async () => {
  const r = fake({ ready:false, exits:false });
  await assert.rejects(r.tray.start({ origin:'http://127.0.0.1:4317' }), /超时/);
  assert.deepEqual(r.killed, [1234]);
});

test('malformed or oversized protocol triggers cleanup without dispatching actions', async () => {
  for (const data of ['{"type":"action","action":"shell"}\n', 'x'.repeat(16385), 'null\n']) {
    const r = fake(), errors = [];
    r.tray.on('failure', error => errors.push(error));
    await r.tray.start({ origin:'http://127.0.0.1:4317' });
    r.child.stdout.write(data); await r.tray.close();
    assert.equal(errors.length, 1);
  }
});

test('spawn failure, child exit and stdin failure do not hang startup', async () => {
  for (const event of ['error', 'close', 'stdin']) {
    const r = fake({ ready:false });
    const started = r.tray.start({ origin:'http://127.0.0.1:4317' });
    if (event === 'stdin') r.child.stdin.emit('error', new Error('broken stdin'));
    else r.child.emit(event, event === 'error' ? new Error('spawn failed') : 1);
    await assert.rejects(started);
  }
});

test('autostart quotes executable and entry paths as literals and rejects remote UI', async () => {
  const command = autostartCommand("C:\\user's $folder\\node.exe", 'C:\\my app\\src\\main.js');
  const decoded = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le');
  assert.ok(decoded.includes("'C:\\user''s $folder\\node.exe'"));
  assert.ok(decoded.includes("'C:\\my app\\src\\main.js'"));
  await assert.rejects(fake().tray.start({ origin:'https://example.com' }), /无效/);
});

test('late output and exit from a replaced tray cannot close its replacement', async () => {
  const r = fake({ exits:false }), errors = [];
  r.tray.on('failure', error => errors.push(error));
  // Simulate taskkill finishing before Node delivers the old close event.
  r.tray.killTree = async child => { r.killed.push(child.pid); };
  await r.tray.start({ origin:'http://127.0.0.1:4317' });
  const old = r.child;
  await r.tray.close();
  await r.tray.start({ origin:'http://127.0.0.1:4317' });
  const current = r.child;
  old.stdout.write('invalid late output\n'); old.emit('error', new Error('late failure')); old.emit('close', 1);
  assert.equal(r.tray.child, current); assert.equal(r.tray.ready, true);
  assert.equal(errors.length, 0);
  await r.tray.close();
});

test('unexpected tray exit reports one failure and clears the owned child', async () => {
  const r = fake(), errors = [];
  r.tray.on('failure', error => errors.push(error));
  await r.tray.start({ origin:'http://127.0.0.1:4317' });
  r.child.emit('close', 1); await r.tray.close();
  assert.equal(errors.length, 1); assert.equal(r.tray.child, null);
});

test('tray stops dispatching the remainder of a packet as soon as exit begins', async () => {
  const r = fake(), actions = [];
  r.tray.on('action', action => { actions.push(action); if (action === 'exit') void r.tray.close(); });
  await r.tray.start({ origin:'http://127.0.0.1:4317' });
  r.child.stdout.write('{"type":"action","action":"exit"}\n{"type":"action","action":"start"}\n');
  await r.tray.close();
  assert.deepEqual(actions, ['exit']);
});
