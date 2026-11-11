import { FakeASR, FakeTTS, FakeVAD, EnergyVAD } from './fake.js';
import { DashScopeASR } from './dashscope/asr.js';
import { DashScopeTTS } from './dashscope/tts.js';
import { MISSING_KEY } from './dashscope/protocol.js';
import {BageshuoASR} from './bageshuo/asr.js';
import {SESSION_CONSENT} from './bageshuo/auth.js';
import {SpeakerFilteredASR} from './voiceprint.js';

/**
 * All audio is mono signed little-endian PCM16. Providers do no device I/O.
 * @typedef {{ sampleRate?: number, language?: string }} ASROptions
 * @typedef {import('node:events').EventEmitter & {
 *   write(chunk: Buffer): void, end(): void, close(): void
 * }} ASRSession Emits partial/final {text: string} and error (Error).
 * Optional sentence {id: string|number, text: string} confirms each sentence once,
 * before end(). final remains the aggregate; consumers must not replay sentences.
 * end flushes one final result; close aborts and releases resources.
 * @typedef {{ createSession(options?: ASROptions): ASRSession }} ASR
 * @typedef {AsyncIterable<Buffer> & { cancel(): void }} AudioStream
 * cancel stops future chunks; a sink already processing a chunk must finish/abort itself.
 * @typedef {{ synthesize(text: string, options: {
 *   voice?: string, format: 'pcm16', sampleRate: number
 * }): AudioStream }} TTS
 * @typedef {import('node:events').EventEmitter & {
 *   process(frame: Buffer): { speech: boolean }
 * }} VAD Emits speechStart/speechEnd on transitions; silence hangover is provider-owned.
 * speechEnd may include {valid:false, voicedMs} to discard a short noise segment.
 */

/** Resolve only explicitly registered providers; no network or device initialization. */
export function voiceAvailability(config = {}) {
  const provider = config.provider ?? process.env.ZHIWEI_VOICE_PROVIDER ?? 'fake';
  const asr = config.asr ?? process.env.ZHIWEI_VOICE_ASR ?? provider;
  const tts = config.tts ?? process.env.ZHIWEI_VOICE_TTS ?? provider;
  const reason = config.voiceprint?.enabled&&!config.voiceprint.ready?'本人声纹尚未就绪，请先录入和测试，或明确关闭声纹筛选。' : [asr, tts].includes('fake')
    ? '真实语音尚未配置：当前为测试识别/合成器，不能识别人声。请配置 ZHIWEI_VOICE_PROVIDER=dashscope 及语音服务密钥后重启。'
    : !['dashscope','bageshuo'].includes(asr)||tts!=='dashscope' ? '语音提供方未配置，请检查 ASR/TTS 设置。'
    : asr==='bageshuo'&&config.asrOptions?.useInstalledSession!==true ? SESSION_CONSENT
    : [asr,tts].includes('dashscope') && !process.env.DASHSCOPE_API_KEY?.trim() ? `${MISSING_KEY}。真实语音未开启，不会回落到测试识别器。` : null;
  return { ready:!reason, reason };
}

export function createVoiceProviders(config = {}) {
  if (config.requireReal) {
    const available = voiceAvailability(config);
    if (!available.ready) throw new Error(available.reason);
  }
  const provider = config.provider ?? process.env.ZHIWEI_VOICE_PROVIDER ?? 'fake';
  if (!['fake', 'dashscope'].includes(provider)) throw new Error(`语音提供方「${provider}」未配置`);
  const names = {
    asr:config.asr ?? process.env.ZHIWEI_VOICE_ASR ?? provider,
    tts:config.tts ?? process.env.ZHIWEI_VOICE_TTS ?? provider,
    vad:config.vad ?? process.env.ZHIWEI_VOICE_VAD ?? 'fake',
  };
  const registry = { asr:{ fake:FakeASR, dashscope:DashScopeASR, bageshuo:BageshuoASR }, tts:{ fake:FakeTTS, dashscope:DashScopeTTS }, vad:{ fake:FakeVAD, energy:EnergyVAD } };
  const providers = {};
  let warned = false;
  for (const [kind, name] of Object.entries(names)) {
    let Provider = Object.hasOwn(registry[kind], name) && registry[kind][name];
    if (!Provider) throw new Error(`语音 ${kind} 提供方「${name}」未配置`);
    if (name === 'dashscope' && !process.env.DASHSCOPE_API_KEY?.trim()) {
      if (!warned) (config.onWarning ?? console.warn)(`${MISSING_KEY}，已回落到 fake`);
      warned = true;
      Provider = registry[kind].fake;
    }
    providers[kind] = new Provider(config[`${kind}Options`]);
  }
  if(config.voiceprint?.enabled)providers.asr=new SpeakerFilteredASR(providers.asr,config.voiceprint);
  return providers;
}
