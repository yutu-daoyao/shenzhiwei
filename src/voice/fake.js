import { EventEmitter } from 'node:events';
import { setImmediate as nextTick } from 'node:timers/promises';

export class FakeASR {
  // A session script contains cumulative partial strings (legacy), or sentence
  // events {id, text, final:true}. One item is emitted per write; end drains the rest.
  constructor({ scripts = [] } = {}) { this.scripts = [...scripts]; }
  createSession({ sampleRate = 16000, language = 'zh' } = {}) {
    const session = new EventEmitter();
    const script = [...(this.scripts.shift() ?? ['测试语音'])];
    let closed = false, text = '';
    const sentences = new Map();
    const emit = item => {
      if (typeof item === 'string') { text = item; session.emit('partial', { text }); return; }
      if (sentences.get(item.id)?.final) return;
      sentences.set(item.id, item);
      text = [...sentences.values()].map(sentence => sentence.text).join('');
      session.emit('partial', { text });
      if (item.final) session.emit('sentence', { id:item.id, text:item.text });
    };
    Object.assign(session, {
      sampleRate, language,
      write(chunk) {
        if (closed) return;
        if (!Buffer.isBuffer(chunk)) throw new TypeError('PCM chunk must be a Buffer');
        if (script.length) emit(script.shift());
      },
      end() {
        if (closed) return;
        closed = true;
        for (const partial of script) emit(partial);
        session.emit('final', { text });
      },
      close() { closed = true; },
    });
    return session;
  }
}

export class FakeTTS {
  synthesize(text, { format = 'pcm16', sampleRate = 16000 } = {}) {
    if (format !== 'pcm16') throw new Error('FakeTTS only supports pcm16');
    if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new RangeError('Invalid sampleRate');
    let cancelled = false;
    const count = Math.max(1, Array.from(text).length);
    return {
      cancel() { cancelled = true; },
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < count; i++) {
          await nextTick();
          if (cancelled) return;
          yield Buffer.alloc(Math.max(1, Math.round(sampleRate * 0.02)) * 2);
        }
      },
    };
  }
}

// RMS values use PCM16 sample units, not a normalized 0..1 scale.
export class EnergyVAD extends EventEmitter {
  constructor({ sampleRate = 16000, threshold = process.env.ZHIWEI_VAD_THRESHOLD?.trim() ? Number(process.env.ZHIWEI_VAD_THRESHOLD) : null,
    hangoverMs = process.env.ZHIWEI_VAD_HANGOVER_MS?.trim() ? Number(process.env.ZHIWEI_VAD_HANGOVER_MS) : 600,
    startMs = 60, minSpeechMs = 300 } = {}) {
    super();
    if (![sampleRate, hangoverMs, startMs, minSpeechMs].every(Number.isFinite) || sampleRate <= 0 ||
      [hangoverMs, startMs, minSpeechMs].some(value => value < 0) ||
      (threshold !== null && (!Number.isFinite(threshold) || threshold < 0))) throw new RangeError('Invalid VAD options');
    Object.assign(this, { sampleRate, fixedThreshold:threshold, hangoverMs, startMs, minSpeechMs });
    this.reset();
  }
  get threshold() { return this.fixedThreshold ?? Math.max(60, this.noiseFloor * 1.5); }
  reset() {
    this.speech = false; this.silenceMs = 0; this.candidateMs = 0; this.voicedMs = 0;
    this.noiseFloor = 30;
  }
  process(frame) {
    if (!Buffer.isBuffer(frame) || frame.length % 2) throw new TypeError('Expected PCM16 Buffer');
    const samples = frame.length / 2;
    if (!samples) return { speech:this.speech };
    let sum = 0;
    for (let i = 0; i < frame.length; i += 2) sum += frame.readInt16LE(i) ** 2;
    const rms = Math.sqrt(sum / samples), ms = samples / this.sampleRate * 1000;
    // A lower release threshold preserves quiet syllables after a confirmed opening.
    const threshold = this.speech && this.fixedThreshold === null ? Math.max(45, this.noiseFloor * 1.2) : this.threshold;
    const voiced = this.fixedThreshold === 0 ? rms > 0 : rms >= threshold;
    if (voiced) {
      this.silenceMs = 0;
      if (this.speech) this.voicedMs += ms;
      else {
        this.candidateMs += ms;
        if (this.candidateMs >= this.startMs) {
          this.speech = true; this.voicedMs = this.candidateMs; this.candidateMs = 0;
          this.emit('speechStart');
        }
      }
    } else if (this.speech) {
      this.silenceMs += ms;
      if (this.silenceMs >= this.hangoverMs) {
        this.speech = false;
        this.emit('speechEnd', { voicedMs:this.voicedMs, valid:this.voicedMs >= this.minSpeechMs });
        this.candidateMs = 0; this.voicedMs = 0; this.silenceMs = 0;
      }
    } else {
      this.candidateMs = 0;
      // Learn only idle frames below the opening threshold. Rise slowly so quiet
      // speech cannot quickly raise its own threshold; follow a falling floor faster.
      const tau = rms < this.noiseFloor ? 200 : 5000;
      this.noiseFloor += (rms - this.noiseFloor) * (1 - Math.exp(-ms / tau));
    }
    return { speech:this.speech, rms, threshold:this.threshold, noiseFloor:this.noiseFloor, voiced };
  }
}

// Deterministic activity detector for tests: any nonzero PCM sample is speech.
export class FakeVAD extends EnergyVAD {
  constructor(options = {}) { super({ threshold:0, hangoverMs:0, startMs:0, minSpeechMs:0, ...options }); }
}
