import { pathToFileURL } from 'node:url';
import { WindowsCapture } from '../src/voice/windows/audio.js';
import { EnergyVAD } from '../src/voice/fake.js';

// Local PCM only: no ASR, credentials, audio files or network calls.
export async function micLevel({ capture = new WindowsCapture(), vad = new EnergyVAD(), log = console.log, signal } = {}) {
  let resolve, reject, timer, frames = 0, sum = 0, transitions = [];
  const completed = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Device failures can arrive before start() has resolved.
  completed.catch(() => {});
  const onError = error => reject(error);
  const onAbort = () => reject(new DOMException('麦克风诊断已停止', 'AbortError'));
  const onStart = () => transitions.push('start');
  const onEnd = ({ valid }) => transitions.push(valid ? 'end' : 'discard-short');
  const onFrame = frame => {
    if (frames >= 500) return;
    const result = vad.process(frame);
    sum += result.rms ** 2;
    frames++;
    if (frames % 5 === 0) {
      log(`${(frames * 0.02).toFixed(1)}s RMS=${Math.sqrt(sum / 5).toFixed(1)} VAD=${result.speech ? 'speech' : 'idle'} threshold=${result.threshold.toFixed(1)} noise=${result.noiseFloor.toFixed(1)}${transitions.length ? ` [${transitions.join(',')}]` : ''}`);
      sum = 0; transitions = [];
    }
    if (frames === 500) resolve();
  };
  capture.on('frame', onFrame); capture.on('error', onError);
  vad.on('speechStart', onStart); vad.on('speechEnd', onEnd);
  signal?.addEventListener('abort', onAbort, { once:true });
  try {
    if (signal?.aborted) signal.throwIfAborted();
    log('采集 10 秒：前 2 秒保持安静，随后说“你好知微”，中间稍作停顿。每行 100ms；RMS 为 PCM16 原始电平。');
    await capture.start({ sampleRate:16000, frameMs:20, signal });
    timer = setTimeout(() => reject(new Error('麦克风采集不足 10 秒，请检查默认输入设备。')), 15000);
    await completed;
  } finally {
    clearTimeout(timer);
    capture.off('frame', onFrame);
    vad.off('speechStart', onStart); vad.off('speechEnd', onEnd);
    signal?.removeEventListener('abort', onAbort);
    await capture.close();
    capture.off('error', onError);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  try { await micLevel({ signal:controller.signal }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { process.off('SIGINT', stop); }
}
