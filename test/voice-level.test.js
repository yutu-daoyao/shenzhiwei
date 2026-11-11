import test from 'node:test';
import assert from 'node:assert/strict';
import { pcmRms, LevelMeter, PlaybackLevels } from '../src/voice/level.js';
import { VoiceConversation } from '../src/voice/conversation.js';
import { FakeCapture, FakePlayback } from '../src/voice/audio.js';
import { FakeASR, FakeTTS, FakeVAD } from '../src/voice/fake.js';

const pcm = (sample, samples = 320) => {
  const frame = Buffer.alloc(samples * 2);
  for (let i = 0; i < frame.length; i += 2) frame.writeInt16LE(sample, i);
  return frame;
};

test('PCM16 RMS normalizes silence, signed full scale and mixed samples', () => {
  assert.equal(pcmRms(Buffer.alloc(0)), 0);
  assert.equal(pcmRms(pcm(0)), 0);
  assert.equal(pcmRms(pcm(-32768)), 1);
  assert.equal(pcmRms(pcm(16384)), 0.5);
  assert.ok(Math.abs(pcmRms(Buffer.concat([pcm(16384), pcm(-16384), pcm(0), pcm(0)])) - Math.sqrt(0.125)) < 1e-10);
  assert.throws(() => pcmRms(Buffer.alloc(3)), /PCM16/);
});

test('level telemetry is capped at 25Hz before computing RMS; reset permits a new stream', () => {
  let time = 0; const levels = [];
  const meter = new LevelMeter(level => levels.push(level), { now:() => time });
  for (time = 0; time < 1000; time += 20) meter.write(pcm(16384));
  assert.equal(levels.length, 25);
  assert.ok(levels.every(level => level === 0.5));
  time = 981; meter.write(Buffer.alloc(3)); // A throttled frame does no scan or validation.
  assert.equal(levels.length, 25);
  meter.reset(); meter.write(pcm(0));
  assert.equal(levels.at(-1), 0);
});

test('playback levels wait for actual device start and follow frame duration, silence and reset', () => {
  let time = 1000, callback, cancelled;
  const levels = [];
  const meter = new PlaybackLevels(level => levels.push(level), {
    now:() => time, schedule:fn => { callback = fn; return 42; }, cancel:id => { cancelled = id; },
  });
  meter.enqueue(pcm(16384, 640)); // 40ms of half scale, then 40ms silence
  meter.enqueue(pcm(0, 640));
  assert.deepEqual(levels, []);
  meter.start(); assert.deepEqual(levels, [0.5]);
  time += 40; callback(); assert.equal(levels.at(-1), 0);
  time += 40; callback(); assert.equal(meter.frames.length, 0);
  meter.enqueue(pcm(-32768, 640)); callback(); assert.equal(levels.at(-1), 1);
  meter.stop(); assert.equal(cancelled, 42); assert.equal(meter.frames.length, 0);
  meter.enqueue(pcm(8192, 640)); time += 200; meter.start();
  assert.equal(levels.at(-1), 0.25, 'drained worker can start another utterance');
  meter.stop();
});

test('voice snapshot and telemetry select microphone while listening and playback while speaking', async t => {
  const capture = new FakeCapture(), playback = new FakePlayback();
  const voice = new VoiceConversation({ capture, playback, brain:{ run:async () => '' }, config:{ mode:'ptt' },
    providers:{ asr:new FakeASR(), tts:new FakeTTS(), vad:new FakeVAD() } });
  t.after(() => voice.close());
  const levels = []; voice.on('level', level => levels.push(level));
  await voice.setEnabled(true);
  capture.emit('frame', pcm(16384)); assert.equal(levels.length, 0, 'idle capture is not exposed');
  voice.ptt('start');
  for (let i = 0; i < 10; i++) capture.emit('frame', pcm(16384));
  assert.equal(levels.length, 1); assert.equal(levels[0].state, 'listening');
  assert.equal(voice.snapshot().level, 0.5); assert.ok(voice.snapshot().levelAt > 0);
  playback.onLevel(1); assert.equal(levels.length, 1, 'wrong source is ignored');
  voice.interrupt(); assert.ok(voice.snapshot().interruptedAt > 0);
  assert.equal(voice.snapshot().level, 0);
  voice.pipeline.setState('speaking'); playback.onLevel(0.25);
  capture.emit('frame', pcm(16384));
  assert.equal(voice.snapshot().level, 0.25);
  assert.equal(levels.at(-1).state, 'speaking');
  await voice.setEnabled(false);
  playback.onLevel(1); assert.equal(voice.snapshot().level, 0);
});

test('an interruption inside a level callback cannot revive a stopped timer or leak into the next utterance', () => {
  let time = 0, next, schedules = 0, stopInside = true;
  const values = [];
  const meter = new PlaybackLevels(level => { values.push(level); if (stopInside) meter.stop(); }, {
    now:() => time, schedule:fn => { next = fn; schedules++; return schedules; }, cancel() {},
  });
  meter.enqueue(pcm(16384)); meter.start();
  assert.equal(schedules, 0, 'stop inside report must cancel the upcoming tick');
  stopInside = false;
  meter.enqueue(pcm(8192)); meter.start(); const stale = next;
  meter.stop(); time = 100;
  meter.enqueue(pcm(4096)); meter.start();
  const before = [...values], count = schedules;
  stale();
  assert.deepEqual(values, before); assert.equal(schedules, count);
  assert.equal(values.at(-1), 0.125);
  meter.stop();
});
