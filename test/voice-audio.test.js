import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import { WindowsCapture, WindowsPlayback } from '../src/voice/windows/audio.js';
import { micLevel } from '../scripts/mic-level.mjs';

function transport({ autoReady = true, autoAck = false } = {}) {
  const children = [], packets = [], calls = [];
  return {
    children, packets, calls, platform:'win32', startupTimeoutMs:50,
    spawnProcess(...args) {
      calls.push(args);
      const child = new EventEmitter(); children.push(child);
      Object.assign(child, { stdout:new PassThrough(), stderr:new PassThrough(), kills:0, kill() { this.kills++; } });
      child.stdin = new Writable({ write(packet, encoding, done) {
        packets.push(packet); done(); if (autoAck) queueMicrotask(() => child.stdout.write(Buffer.from([1])));
      } });
      if (autoReady) queueMicrotask(() => child.stdout.write(Buffer.from([1])));
      return child;
    },
  };
}

test('Windows capture reassembles fragmented PCM into 20ms frames without a real process', async () => {
  const io = transport(), capture = new WindowsCapture(io), frames = [], errors = [];
  capture.on('frame', frame => frames.push(frame)); capture.on('error', error => errors.push(error));
  await capture.start();
  const input = Buffer.alloc(1280, 42), child = io.children[0];
  child.stdout.write(input.subarray(0, 3)); child.stdout.write(input.subarray(3, 999)); child.stdout.write(input.subarray(999));
  assert.equal(frames.length, 2); assert.deepEqual(Buffer.concat(frames), input);
  const [command, args, options] = io.calls[0];
  assert.equal(command, 'powershell.exe'); assert.equal(options.shell, false);
  assert.equal(args.at(-1), 'capture');
  await capture.close(); child.emit('close', 1);
  assert.equal(child.kills, 1); assert.equal(errors.length, 0);
});

test('mic-level uses capture worker and prints 100 RMS/VAD windows before cleaning up', async () => {
  const io = transport(), capture = new WindowsCapture(io), lines = [];
  const running = micLevel({ capture, log:line => lines.push(line) });
  await tick();
  const pcm = Buffer.alloc(640 * 500);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(i % 4 ? 35 : -35, i);
  const child = io.children[0];
  // Fragmented stdio including odd byte boundaries must still produce exact windows.
  child.stdout.write(pcm.subarray(0, 101));
  child.stdout.write(pcm.subarray(101));
  await running;
  assert.equal(lines.length, 101);
  assert.match(lines[1], /^0\.1s RMS=35\.0 VAD=idle threshold=60\.0 noise=/);
  assert.match(lines.at(-1), /^10\.0s RMS=35\.0 VAD=idle/);
  assert.equal(io.calls[0][1].at(-1), 'capture');
  assert.equal(child.kills, 1);
  assert.equal(capture.listenerCount('frame'), 0);
  assert.equal(capture.listenerCount('error'), 0);
});

test('mic-level releases capture when aborted', async () => {
  const io = transport(), capture = new WindowsCapture(io), controller = new AbortController();
  const running = micLevel({ capture, signal:controller.signal, log:() => {} });
  await tick(); controller.abort();
  await assert.rejects(running, { name:'AbortError' });
  assert.equal(io.children[0].kills, 1);
  assert.equal(capture.listenerCount('frame'), 0);
});

test('Windows playback waits for hardware acknowledgements and bounds packets to 100ms', async () => {
  const io = transport(), playback = new WindowsPlayback(io);
  let finished = false;
  const writing = playback.write(Buffer.alloc(6400, 7)).then(() => { finished = true; });
  await tick(); assert.equal(io.packets.length, 1); assert.equal(finished, false);
  assert.equal(io.packets[0].readUInt32LE(), 3200);
  io.children[0].stdout.write(Buffer.from([1])); await tick();
  assert.equal(io.packets.length, 2); assert.equal(finished, false);
  io.children[0].stdout.write(Buffer.from([1])); await writing;
  assert.equal(finished, true); await playback.drain(); await playback.close();
});

test('Windows playback stop kills only its worker and unblocks an in-flight write', async () => {
  const io = transport(), playback = new WindowsPlayback(io), controller = new AbortController();
  const writing = playback.write(Buffer.alloc(640), { signal:controller.signal });
  const rejected = assert.rejects(writing, { name:'AbortError' });
  await tick(); controller.abort(); await rejected;
  assert.equal(io.children[0].kills, 1);
  io.children[0].stdout.write(Buffer.from([1])); // Late acks cannot resume the old stream.
  assert.equal(io.packets.length, 1); await playback.close();
});

test('Windows stop before startup finishes rejects readiness without sending audio', async () => {
  const io = transport({ autoReady:false }), playback = new WindowsPlayback(io), controller = new AbortController();
  const writing = playback.write(Buffer.alloc(640), { signal:controller.signal });
  const rejected = assert.rejects(writing, { name:'AbortError' });
  controller.abort(); await rejected;
  assert.equal(io.children[0].kills, 1); assert.equal(io.packets.length, 0);
});

test('Windows playback rejects a second write while device startup is pending', async () => {
  const io = transport({ autoReady:false }), playback = new WindowsPlayback(io);
  const first = playback.write(Buffer.alloc(640));
  const cancelled = assert.rejects(first, { name:'AbortError' });
  await assert.rejects(playback.write(Buffer.alloc(640)), /上一块/);
  assert.equal(io.children.length, 1);
  await playback.close(); await cancelled;
  assert.equal(io.packets.length, 0);
});

test('Windows process spawn/exit failures and startup timeout reach callers', async () => {
  for (const failure of ['spawn', 'exit', 'timeout']) {
    const io = transport({ autoReady:false }); io.startupTimeoutMs = 5;
    const capture = new WindowsCapture(io), errors = [];
    capture.on('error', error => errors.push(error));
    const starting = capture.start();
    const rejected = assert.rejects(starting, /denied|音频进程退出|音频设备启动超时/);
    if (failure === 'spawn') io.children[0].emit('error', new Error('denied'));
    if (failure === 'exit') io.children[0].emit('close', 1);
    await rejected; assert.equal(errors.length, 1); await capture.close();
  }
});

test('Windows playback driver stall is bounded and worker exit cannot silently truncate audio', async () => {
  const io = transport(), playback = new WindowsPlayback({ ...io, writeTimeoutMs:5 });
  await assert.rejects(playback.write(Buffer.alloc(640)), /播放超时/);
  assert.equal(io.children[0].kills, 1);
  const writing = playback.write(Buffer.alloc(640));
  const rejected = assert.rejects(writing, /音频进程退出/);
  await tick(); io.children[1].emit('close', 1); await rejected;
  await assert.rejects(playback.drain(), /音频进程退出/);
  await playback.close();
});

test('Windows adapters reject unsupported platforms and PCM formats before spawning', async () => {
  await assert.rejects(new WindowsCapture({ platform:'linux' }).start(), /仅支持 Windows/);
  await assert.rejects(new WindowsPlayback({ platform:'linux' }).write(Buffer.alloc(640)), /仅支持 Windows/);
  const io = transport();
  await assert.rejects(new WindowsCapture(io).start({ sampleRate:8000 }), /16kHz/);
  await assert.rejects(new WindowsPlayback(io).write(Buffer.alloc(3)), /PCM16/);
  assert.equal(io.children.length, 0);
});

test('Windows capture startup abort kills its worker immediately and permits retry', async () => {
  const io = transport({ autoReady:false }), capture = new WindowsCapture(io), controller = new AbortController();
  const errors = []; capture.on('error', error => errors.push(error));
  const started = capture.start({ signal:controller.signal });
  const rejected = assert.rejects(started, { name:'AbortError' });
  controller.abort();
  assert.equal(io.children[0].kills, 1);
  await rejected;
  io.children[0].stdout.write(Buffer.from([1]));
  const retry = capture.start(); io.children[1].stdout.write(Buffer.from([1])); await retry;
  assert.equal(errors.length, 0); await capture.close();
});

test('Windows playback rejects a second write before device readiness without losing the first', async () => {
  const io = transport({ autoReady:false, autoAck:true }), playback = new WindowsPlayback(io);
  const first = playback.write(Buffer.alloc(640, 3));
  await assert.rejects(playback.write(Buffer.alloc(640, 9)), /上一块/);
  assert.equal(io.children.length, 1); assert.equal(io.packets.length, 0);
  io.children[0].stdout.write(Buffer.from([1])); await first;
  assert.equal(io.packets.length, 1); assert.equal(io.packets[0][4], 3);
  await playback.close();
});

test('Windows playback can replace a cancelled write in the same tick, ignoring late ready and ack', async () => {
  for (const autoReady of [false, true]) {
    const io = transport({ autoReady, autoAck:true }), playback = new WindowsPlayback(io);
    const first = playback.write(Buffer.alloc(640));
    const rejected = assert.rejects(first, { name:'AbortError' });
    playback.stop();
    const second = playback.write(Buffer.alloc(640, 7));
    io.children[0].stdout.write(Buffer.from([1, 1]));
    if (!autoReady) io.children[1].stdout.write(Buffer.from([1]));
    await Promise.all([rejected, second]);
    assert.equal(io.children[0].kills, 1); assert.equal(io.packets.length, 1);
    assert.equal(io.packets[0][4], 7); await playback.close();
  }
});

test('capture prewarming waits without opening the microphone until an explicit start byte',async()=>{
  const io=transport({autoReady:false}),capture=new WindowsCapture(io),frames=[];
  capture.on('frame',frame=>frames.push(frame));capture.on('error',()=>{});
  const preparing=capture.prepare();
  assert.ok(io.calls[0][1].includes('-WaitForStart'));
  io.children[0].stdout.write(Buffer.from([0]));await preparing;
  assert.equal(frames.length,0);assert.equal(io.packets.length,0);
  // The prewarmed idle worker has no device-start timeout.
  await new Promise(resolve=>setTimeout(resolve,65));assert.equal(io.children[0].kills,0);
  const starting=capture.start();await tick();
  assert.deepEqual([...io.packets[0]],[1]);
  io.children[0].stdout.write(Buffer.concat([Buffer.from([1]),Buffer.alloc(640)]));
  await starting;assert.equal(frames.length,1);await capture.close();
  assert.equal(io.children[0].kills,1);
});
