import { EventEmitter } from 'node:events';
import { setImmediate as nextTick } from 'node:timers/promises';
import { WindowsCapture, WindowsPlayback } from './windows/audio.js';

/** Capture: start({sampleRate}), close(); emits frame(Buffer PCM16) and error.
 * Playback: write(chunk,{signal,sampleRate}), drain({signal}), stop(), close().
 * stop() must synchronously discard queued audio and unblock an in-flight write.
 * write/drain provide backpressure through actual playback, not just pipe delivery.
 */
export function createAudioAdapters({ audio = process.env.ZHIWEI_VOICE_AUDIO ?? 'windows', ...options } = {}) {
  if (audio === 'fake') return { capture:new FakeCapture(), playback:new FakePlayback() };
  if (audio !== 'windows') throw new Error(`音频适配器「${audio}」未配置`);
  return { capture:new WindowsCapture(options), playback:new WindowsPlayback(options) };
}

export class FakeCapture extends EventEmitter {
  async start() { this.active = true; }
  async replay(frames) {
    for (const frame of frames) { if (!this.active) return; this.emit('frame', frame); await nextTick(); }
  }
  async close() { this.active = false; }
}

export class FakePlayback {
  constructor() { this.chunks = []; this.stops = 0; }
  async write(chunk, { signal } = {}) { if (!signal?.aborted) this.chunks.push(Buffer.from(chunk)); }
  async drain() {}
  stop() { this.stops++; }
  async close() { this.stop(); }
}
