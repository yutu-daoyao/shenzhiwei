import { performance } from 'node:perf_hooks';

// Mono PCM16, normalized full-scale RMS. No copies and no device/network work.
export function pcmRms(frame) {
  if (!Buffer.isBuffer(frame) || frame.length % 2) throw new TypeError('Expected PCM16 Buffer');
  if (!frame.length) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i += 2) sum += frame.readInt16LE(i) ** 2;
  return Math.min(1, Math.sqrt(sum / (frame.length / 2)) / 32768);
}

export class LevelMeter {
  constructor(report, { now = () => performance.now(), intervalMs = 40 } = {}) {
    Object.assign(this, { report, now, intervalMs });
    this.lastAt = -Infinity;
  }
  write(frame) {
    const now = this.now();
    if (now - this.lastAt < this.intervalMs) return;
    this.lastAt = now;
    this.report(pcmRms(frame));
  }
  reset() { this.lastAt = -Infinity; }
}

// Track the bounded Windows packet from dispatch to its playback acknowledgement.
// This timer only publishes UI telemetry; audio writes never wait for it.
export class PlaybackLevels {
  constructor(report, { now = () => performance.now(), schedule = fn => setTimeout(fn, 40), cancel = clearTimeout } = {}) {
    Object.assign(this, { report, now, schedule, cancel });
    this.frames = [];
  }
  enqueue(frame) {
    const duration = frame.length / 32; // 16kHz mono PCM16, milliseconds
    const start = Math.max(this.end ?? 0, this.started ? this.now() : 0);
    this.frames.push({ start, end:start + duration, level:pcmRms(frame) });
    this.end = start + duration;
  }
  start() {
    if (this.started) return;
    this.started = true;
    const generation = this.generation = (this.generation ?? 0) + 1;
    const offset = this.now();
    for (const frame of this.frames) { frame.start += offset; frame.end += offset; }
    this.end = (this.end ?? 0) + offset;
    const tick = () => {
      if (!this.started || this.generation !== generation) return;
      const now = this.now();
      while (this.frames.length && this.frames[0].end <= now) this.frames.shift();
      this.report(this.frames[0]?.level ?? 0);
      // Reporting can synchronously interrupt playback. Never revive that timer,
      // or let a callback from an old utterance report into its replacement.
      if (!this.started || this.generation !== generation) return;
      this.timer = this.schedule(tick);
      this.timer?.unref?.();
    };
    tick();
  }
  stop() {
    this.generation = (this.generation ?? 0) + 1;
    this.cancel(this.timer); this.timer = null;
    this.frames = []; this.end = 0; this.started = false;
  }
}
