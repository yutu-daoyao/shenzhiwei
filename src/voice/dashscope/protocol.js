// Wire-format assumptions live here. Verify with a real Beijing-region key:
// https://help.aliyun.com/zh/model-studio/paraformer-client-events
// https://help.aliyun.com/zh/model-studio/cosyvoice-client-events
// https://help.aliyun.com/zh/model-studio/paraformer-server-events
// In particular: model/voice availability, PCM sample rate, language_hints,
// and sentence begin_time/sentence_end semantics across multiple sentences.
export const ENDPOINT = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
export const ASR_MODEL = 'paraformer-realtime-v2';
export const TTS_MODEL = 'cosyvoice-v2';
export const TTS_VOICE = 'longwan_v2'; // CosyVoice v2 system voice.
export const MISSING_KEY = '未设置 DASHSCOPE_API_KEY，无法使用 DashScope 语音';

export function command(action, taskId, payload = { input:{} }) {
  return { header:{ action, task_id:taskId, streaming:'duplex' }, payload };
}

export function runASR(taskId, { model = ASR_MODEL, sampleRate = 16000, language = 'zh', vocabularyId = process.env.ZHIWEI_ASR_VOCABULARY_ID } = {}) {
  return command('run-task', taskId, {
    task_group:'audio', task:'asr', function:'recognition', model,
    parameters:{ format:'pcm', sample_rate:sampleRate, ...(language ? { language_hints:[language] } : {}), ...(vocabularyId ? { vocabulary_id:vocabularyId } : {}) },
    input:{},
  });
}

export function runTTS(taskId, { model = TTS_MODEL, voice = TTS_VOICE, sampleRate = 16000, rate } = {}) {
  if(rate!==undefined&&(!Number.isFinite(rate)||rate<0.5||rate>2))throw new RangeError('百炼语速须为0.5至2倍');
  return command('run-task', taskId, {
    task_group:'audio', task:'tts', function:'SpeechSynthesizer', model,
    parameters:{ text_type:'PlainText', voice, format:'pcm', sample_rate:sampleRate, ...(rate===undefined?{}:{rate}) }, input:{},
  });
}

export const continueTTS = (taskId, text) => command('continue-task', taskId, { input:{ text } });
export const finishTask = taskId => command('finish-task', taskId);

export function parseEvent(text, taskId) {
  let event;
  try { event = JSON.parse(text); } catch { throw new Error('DashScope 返回了无效的 JSON 事件'); }
  if (!event?.header || typeof event.header.event !== 'string') throw new Error('DashScope 事件缺少 header.event');
  if (event.header.task_id !== taskId) return null;
  return event;
}

export function sentenceOf(event) {
  const sentence = event.payload?.output?.sentence;
  if (!sentence || typeof sentence.text !== 'string') return null;
  return { id:sentence.begin_time ?? sentence.sentence_id ?? 0, text:sentence.text, final:sentence.sentence_end === true };
}


// Map provider diagnostics to fixed user-facing messages; never echo raw headers or credentials.
export function dashscopeFailure(header={}) {
  const code=String(header.error_code||'').toLowerCase(),message=String(header.error_message||'').toLowerCase();
  if(/arrearage|insufficient.?balance/.test(code)||/insufficient balance|in good standing|欠费|余额不足/.test(message))return '百炼账户欠费或余额不足，请在阿里云控制台核对账单并充值后再试。';
  if(/insufficient.?quota|allocationquota|freetieronly/.test(code)||/free tier|insufficient quota|免费额度/.test(message))return '百炼可用额度不足或免费额度已用完，请在控制台核对额度与计费设置。';
  if(/invalid.?api.?key|authentication|unauthorized/.test(code))return '百炼密钥无效或鉴权失败，请检查已有密钥及地域配置。';
  if(/throttl|ratelimit/.test(code))return '百炼请求过于频繁，已停止本次语音，请稍后再试。';
  if(/accessdenied|permission/.test(code))return '百炼访问被拒绝，请核对模型权限、服务开通及账户计费状态。';
  return 'DashScope 语音任务失败，请检查模型、音色和密钥权限';
}
