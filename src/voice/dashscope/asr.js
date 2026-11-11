import { EventEmitter } from 'node:events';
import { createTask } from './socket.js';
import { ASR_MODEL, runASR, finishTask, sentenceOf } from './protocol.js';
import { correctAssistantName } from '../name-corrections.js';

export class DashScopeASR {
  constructor(options = {}) { this.options = { model:process.env.ZHIWEI_VOICE_ASR_MODEL ?? ASR_MODEL, ...options }; }
  createSession({ sampleRate = 16000, language = 'zh' } = {}) {
    if (sampleRate !== 16000) throw new RangeError('DashScope ASR 需要 16000 Hz 单声道 PCM16');
    const session = new EventEmitter(), sentences = new Map();
    // A direct caller without an error listener must not crash the process.
    session.on('error', () => {});
    let ready = false, ended = false, queued = [], queuedBytes = 0;
    const text = (finalOnly = false) => correctAssistantName([...sentences.values()]
      .filter(sentence => !finalOnly || sentence.final).map(sentence => sentence.text).join(''));
    const clear = () => { queued = []; queuedBytes = 0; };
    const task = createTask(this.options, {
      run:id => runASR(id, { ...this.options, sampleRate, language }),
      started:() => {
        ready = true;
        for (const chunk of queued) task.send(chunk);
        clear();
        if (ended) task.send(finishTask(task.id));
      },
      result:event => {
        const sentence = sentenceOf(event);
        if (!sentence) return;
        // begin_time identifies a sentence; repeated finals replace, never append.
        const previous = sentences.get(sentence.id);
        if (previous?.final) return;
        sentences.set(sentence.id, sentence);
        session.emit('partial', { text:text() });
        if (sentence.final) session.emit('sentence', { id:sentence.id, text:correctAssistantName(sentence.text) });
      },
      // task-finished closes transport; only sentence_end confirms recognized text.
      finished:() => { clear(); session.emit('final', { text:text(true) }); },
      error:error => { clear(); session.emit('error', error); },
    });
    Object.assign(session, {
      sampleRate, language,
      write(chunk) {
        if (task.stopped || ended) return;
        if (!Buffer.isBuffer(chunk) || chunk.length % 2) throw new TypeError('需要单声道 PCM16 Buffer');
        if (ready) task.send(chunk);
        else {
          if (queuedBytes + chunk.length > 2 * 1024 * 1024) { task.fail('DashScope ASR 等待启动的音频缓冲区已满'); return; }
          queued.push(Buffer.from(chunk)); queuedBytes += chunk.length;
        }
      },
      end() {
        if (task.stopped || ended) return;
        ended = true;
        if (ready) task.send(finishTask(task.id));
      },
      close() { clear(); sentences.clear(); task.close(); },
    });
    return session;
  }
}
