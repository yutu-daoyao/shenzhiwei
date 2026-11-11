import { createTask } from './socket.js';
import { TTS_MODEL, TTS_VOICE, runTTS, continueTTS, finishTask } from './protocol.js';

export class DashScopeTTS {
  constructor(options = {}) {
    this.options = { model:process.env.ZHIWEI_VOICE_TTS_MODEL ?? TTS_MODEL, voice:process.env.ZHIWEI_VOICE_TTS_VOICE ?? TTS_VOICE, ...options };
  }
  synthesize(text, { format = 'pcm16', sampleRate = 16000, voice = this.options.voice } = {}) {
    if (format !== 'pcm16') throw new Error('DashScope TTS 仅支持 pcm16');
    if (![8000, 16000, 22050, 24000, 44100, 48000].includes(sampleRate)) throw new RangeError('DashScope TTS 采样率无效');
    if (typeof text !== 'string' || !text.trim() || Array.from(text).length > 20000) throw new TypeError('DashScope TTS 文本须为 1–20000 字符');
    const options = this.options;
    let task, done = false, error, wake, consumed = false, queue = [], bytes = 0;
    const notify = () => { wake?.(); wake = null; };
    const cancel = () => { done = true; error = null; queue = []; bytes = 0; task?.close(); notify(); };
    return {
      cancel,
      async *[Symbol.asyncIterator]() {
        if (consumed) throw new Error('DashScope 音频流只能消费一次');
        consumed = true;
        if (done) return;
        task = createTask(options, {
          run:id => runTTS(id, { ...options, voice, sampleRate }),
          started:() => { task.send(continueTTS(task.id, text)); task.send(finishTask(task.id)); },
          audio:chunk => {
            if (bytes + chunk.length > 8 * 1024 * 1024) { task.fail('DashScope TTS 音频缓冲区已满'); return; }
            queue.push(chunk); bytes += chunk.length; notify();
          },
          finished:() => { done = true; notify(); },
          error:reason => { error = reason; done = true; queue = []; bytes = 0; notify(); },
        });
        try {
          while (true) {
            if (error) throw error;
            if (queue.length) { const chunk = queue.shift(); bytes -= chunk.length; yield chunk; }
            else if (done) return;
            else await new Promise(resolve => { wake = resolve; });
          }
        } finally { cancel(); }
      },
    };
  }
}
