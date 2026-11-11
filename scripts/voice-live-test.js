import {guardLiveScript} from './live-guard.js';
guardLiveScript(import.meta.url);
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DashScopeASR } from '../src/voice/dashscope/asr.js';
import { DashScopeTTS } from '../src/voice/dashscope/tts.js';

if (!process.env.DASHSCOPE_API_KEY?.trim()) {
  console.log('未设置 DASHSCOPE_API_KEY，跳过');
} else {
  let session, stream;
  const uploadAbort = new AbortController();
  try {
    const chunks = [];
    stream = new DashScopeTTS().synthesize('你好，我是沈知微，这是语音接口测试。');
    for await (const chunk of stream) chunks.push(chunk);
    const pcm = Buffer.concat(chunks);
    if (!pcm.length || pcm.length % 2) throw new Error('DashScope 未返回有效 PCM16 音频');
    const dir = new URL('../data/', import.meta.url);
    await mkdir(dir, { recursive:true });
    const file = new URL(`voice-live-${Date.now()}.pcm`, dir);
    await writeFile(file, pcm, { flag:'wx' });
    console.log(`已保存音频：${fileURLToPath(file)}（16kHz 单声道 PCM16）`);
    session = new DashScopeASR().createSession();
    // Register the rejection handler before streaming, including failures mid-upload.
    const result = new Promise((resolve, reject) => {
      session.once('final', ({ text }) => resolve(text));
      session.once('error', reject);
    });
    const upload = (async () => {
      for (let i = 0; i < pcm.length; i += 3200) {
        uploadAbort.signal.throwIfAborted();
        session.write(pcm.subarray(i, i + 3200));
        await delay(100, undefined, { signal:uploadAbort.signal }); // Microphone pace.
      }
      session.end();
    })();
    const [text] = await Promise.all([result, upload]);
    if (!text.trim()) throw new Error('DashScope ASR 返回了空识别结果');
    console.log(`识别结果：${text}`);
  } catch {
    // Do not print raw transport errors, headers, or response bodies.
    console.error('DashScope 语音实测失败，请检查网络、密钥权限、模型和音色配置');
    process.exitCode = 1;
  } finally { uploadAbort.abort(); stream?.cancel(); session?.close(); }
}
