import { EventEmitter } from 'node:events';
import { VoicePipeline } from './pipeline.js';
import { createVoiceProviders, voiceAvailability } from './interfaces.js';
import { createAudioAdapters, FakeCapture, FakePlayback } from './audio.js';
import { withAbort } from './brain.js';
import { KeywordWakeDetector, WakeGate } from './wake.js';
import { LevelMeter } from './level.js';
import { safeError } from '../codex/process.js';
import {requestedSpokenMode,spokenModeLabels,spokenModeText,voiceTaskControl} from './task-control.js';
import {installedSessionReady} from './bageshuo/auth.js';
import {BAGESHUO_AUTH_REJECTED} from './bageshuo/asr.js';

export class VoiceConversation extends EventEmitter {
  constructor({ brain, capture, playback, providers, config = {}, wakeDetector, brainTimeoutMs = Number(process.env.ZHIWEI_VOICE_BRAIN_TIMEOUT_MS || 120000) } = {}) {
    super();
    if (!Number.isFinite(brainTimeoutMs) || brainTimeoutMs <= 0) throw new Error('语音大脑超时必须为正数');
    Object.assign(this, { brain, capture, playback, providers, config, brainTimeoutMs });
    this.mode = config.spokenModes ? 'default' : config.mode ?? process.env.ZHIWEI_VOICE_MODE ?? 'ptt';
    if (!config.spokenModes&&!['ptt', 'wake'].includes(this.mode)) throw new Error('语音模式必须为 ptt 或 wake');
    this.enabled = false; this.state = 'idle'; this.error = null; this.partial = '';
    this.level = 0; this.levelAt = 0; this.interruptedAt = 0;
    this.inputMeter = new LevelMeter(level => this.reportLevel('listening', level));
    this.outputMeter = new LevelMeter(level => this.reportLevel('speaking', level));
    this.queue = Promise.resolve();
    this.wake = this.mode === 'wake' && (config.wakeEnabled ?? process.env.ZHIWEI_WAKE_ENABLED !== '0') ? new WakeGate({ detector:wakeDetector ?? new KeywordWakeDetector(config.wakeOptions), ...config.wakeGateOptions }) : null;
  }
  get realAudio() {
    // Injected fake devices are offline audio too; explicit real-audio config still wins.
    const fallback = this.capture instanceof FakeCapture && this.playback instanceof FakePlayback ? 'fake' : 'windows';
    return !this.providers && (this.config.audio ?? process.env.ZHIWEI_VOICE_AUDIO ?? fallback) !== 'fake';
  }
  get providerConfig() { return { ...this.config, provider:this.config.provider ?? process.env.ZHIWEI_VOICE_PROVIDER ?? (this.realAudio ? 'dashscope' : 'fake') }; }
  snapshot() { return { ...(this.config.voiceprint?{voiceprint:this.config.voiceprint.snapshot()}:{}), enabled:this.enabled, mode:this.mode, ...(this.config.spokenModes?{spokenModes:true,inputEnabled:!!this.inputEnabled,readingEnabled:!!this.pipeline&&!this.pipeline.muted}:{}), held:!!this.pipeline?.held, state:this.state, level:this.level, levelAt:this.levelAt, interruptedAt:this.interruptedAt, error:this.error, partial:this.partial, changing:!!this.changing, ...(this.realAudio ? { recognition:{asr:this.providerConfig.asr??this.providerConfig.provider,useInstalledSession:this.config.asrOptions?.useInstalledSession===true,sessionReady:installedSessionReady()}, availability:voiceAvailability(this.providerConfig), provider:this.providerConfig.provider } : {}), ...(this.wake ? { wakeWord:this.wake.detector.keyword ?? '自定义' } : {}) }; }
  reportLevel(state, level) {
    if (!this.enabled || this.state !== state) return;
    this.level = level; this.levelAt = Math.max(Date.now(), this.levelAt + 1);
    this.emit('level', { state, level, levelAt:this.levelAt });
  }
  changed() { this.emit('change'); }
  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') return Promise.reject(new Error('语音开关必须为布尔值'));
    if (enabled && this.closed) return Promise.reject(new Error('语音已退出'));
    if (!enabled) {
      this.enableEpoch = (this.enableEpoch ?? 0) + 1;
      this.startController?.abort();
      this.pipeline?.interrupt();
    }
    const epoch = this.enableEpoch;
    const operation = this.queue.then(async () => {
      this.changing = true; this.changed();
      try { if (enabled && !this.closed && epoch === this.enableEpoch) await this.start(); else await this.stop(); }
      finally { this.changing = false; this.changed(); }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  async start() {
    if (this.enabled) return;
    const startup = this.startController = new AbortController();
    this.error = null; this.partial = '';
    this.wake?.sleep();
    if(this.config.spokenModes&&!this.preselectedMode)this.mode='default';
    this.preselectedMode=false;
    try {
      const providers = this.providers ?? createVoiceProviders({
        ...this.providerConfig, requireReal:this.realAudio, vad:this.config.vad ?? process.env.ZHIWEI_VOICE_VAD ?? 'energy',
        onWarning:message => { this.error = safeError(message); this.changed(); },
      });
      if (!this.capture || !this.playback) {
        const devices = createAudioAdapters(this.config);
        this.capture ??= devices.capture; this.playback ??= devices.playback;
      }
      this.playback.onLevel = level => this.reportLevel('speaking', level);
      this.inputMeter.reset(); this.outputMeter.reset();
      const pipeline = this.pipeline = new VoicePipeline({
        ...providers, ...(this.config.voiceprint?.enabled?{asrFinalTimeoutMs:20000}:{}), ...(this.providerConfig.asr==='bageshuo'?{asrTimeoutMs:90000,asrFinalTimeoutMs:20000,asrMaxSessionMs:45000}:{}), ...this.config.pipelineOptions, mode:this.mode==='ptt'?'ptt':'wake',
        ...(this.config.spokenModes?{
          admitSpeech:(text,continuation)=>spokenModeText(text,this.mode,continuation),
          acceptLocalTranscript:text=>!!requestedSpokenMode(text,{requireWake:this.mode==='default'}),
        }:{}),
        speak:(chunk, options) => {
          if (!this.playback.reportsLevel) this.outputMeter.write(chunk);
          return this.playback.write(chunk, options);
        },
        stopPlayback:() => this.playback.stop(),
        finishPlayback:options => this.playback.drain(options),
        onUserText:(text, options) => this.handleText(text, options),
      });
      pipeline.on('state', state => {
        this.state = state; this.level = 0; this.levelAt = 0;
        if (state === 'interrupted') this.interruptedAt = Date.now();
        this.inputMeter.reset(); this.outputMeter.reset(); this.changed();
      });
      pipeline.on('partial', ({ text }) => { this.partial = text; this.changed(); });
      pipeline.on('error', error => {
        this.error = safeError(error);
        if(error.code===BAGESHUO_AUTH_REJECTED&&this.config.spokenModes){
          this.setInput(false);
          this.capture.pauseInput?.();
        }else this.changed();
      });
      pipeline.on('empty', () => { this.error = this.config.voiceprint?.enabled&&this.config.voiceprint.lastResult?.matched===false?this.config.voiceprint.lastResult.reason:(this.mode==='ptt'?'没听清，请再按住说一次':'没听清，请再说一次'); this.partial = ''; this.changed(); });
      this.onFrame = frame => {
        if(!this.inputEnabled)return;
        try { pipeline.write(frame); if (this.state === 'listening') this.inputMeter.write(frame); }
        catch (error) { this.deviceFailed(error); }
      };
      this.onDeviceError = error => this.deviceFailed(error);
      this.capture.on('frame', this.onFrame);
      this.capture.on('error', this.onDeviceError);
      this.enabled = this.inputEnabled = true;
      this.readingScope=new AbortController();
      await withAbort(this.capture.start({ sampleRate:16000, frameMs:20, signal:startup.signal }), startup.signal);
      this.changed();
    } catch (error) {
      if (!startup.signal.aborted) this.error = safeError(error);
      await this.stop();
      if (!startup.signal.aborted) throw error;
    } finally { if (this.startController === startup) this.startController = null; }
  }
  deviceFailed(error) {
    this.error = safeError(error);
    // Cancel output and the brain immediately; serialized teardown follows.
    this.pipeline?.close();
    this.setEnabled(false).catch(() => {});
    this.changed();
  }
  setInput(enabled){
    if(!this.enabled||!this.pipeline)return false;
    if(enabled&&this.config.spokenModes&&!voiceAvailability(this.providerConfig).ready)return false;
    this.inputEnabled=enabled;
    if(!enabled){this.pipeline.discardInput();this.partial='';}
    this.changed();
    return true;
  }
  cancelReading(){
    this.readingScope?.abort();
    this.readingScope=new AbortController();
  }
  setReading(enabled){
    if(!this.pipeline)return;
    if(!enabled)this.cancelReading();
    this.pipeline.setReading(enabled);
    this.changed();
  }
  readReply(resolveText){
    const pipeline=this.pipeline,signal=this.readingScope?.signal;
    if(!this.config.spokenModes||!pipeline||pipeline.muted||!signal)return;
    void Promise.resolve().then(()=>resolveText(signal)).then(text=>{
      if(this.pipeline===pipeline&&!signal.aborted)return pipeline.say(text,{signal});
    }).catch(error=>{if(this.pipeline===pipeline&&!signal.aborted){this.error=safeError(error);this.changed();}});
  }
  ptt(action) {
    if (!['start', 'stop'].includes(action)) throw new Error('按住说话操作必须为 start 或 stop');
    if (this.mode !== 'ptt') throw new Error(this.config.spokenModes?'当前不是按键模式':'当前为唤醒词模式');
    if (action === 'stop') { this.pipeline?.stopHold(); this.changed(); return; }
    if (!this.enabled || !this.inputEnabled || this.changing || !this.pipeline) throw new Error('请先开启语音并等待麦克风就绪');
    if (this.pipeline.held) return;
    this.error = null; this.partial = '';
    this.pipeline.startHold(); this.changed();
  }
  setSpokenMode(mode){
    if(!this.config.spokenModes||!Object.hasOwn(spokenModeLabels,mode))throw Error('请选择默认、对话或按键模式。');
    if(this.changing)throw Error('语音正在切换连接，请稍候。');
    if(!this.enabled)this.preselectedMode=true;
    if(this.mode!==mode){
      this.mode=mode;
      this.pipeline?.setMode(mode==='ptt'?'ptt':'wake');
      this.partial='';
      this.changed();
    }
    return `已切到${spokenModeLabels[mode]}模式`;
  }
  async handleText(text, options) {
    const pipeline = this.pipeline;
    if(this.config.spokenModes){
      const next=requestedSpokenMode(text,{requireWake:this.mode==='default'});
      if(next){
        this.error=null;
        await pipeline.say(this.setSpokenMode(next),options);
        return;
      }
      text=spokenModeText(text,this.mode);
    }
    this.partial = text; this.changed();
    if (this.wake) {
      const { action, command } = this.wake.route(text);
      if (action === 'sleep') { this.partial = ''; this.changed(); return; }
      if (action === 'wake') {
        await pipeline.say('我在，请说。', options);
        if (options.signal.aborted || this.pipeline !== pipeline) return;
        if (!command) { this.wake.touch(); return; }
      }
      text = command;
    }
    if (this.wake && !this.wake.singleCommand) this.wake.until = Infinity;
    try {
      const command=voiceTaskControl(text);
      if (command==='stop' && (this.config.spokenModes||this.brain.stop)) {
        this.cancelReading();
        await this.brain.stop?.(options);
        if (!this.config.spokenModes&&!options.signal.aborted) await pipeline.say('已停止。', options);
      } else {
        if(command==='replace'&&this.brain.stop)await this.brain.stop(options);
        if(!options.signal.aborted){
          const local=await this.localCommand?.(text,options);
          if(local){
            if(!options.signal.aborted&&this.pipeline===pipeline)await pipeline.say(local,options);
          }else if(!options.signal.aborted)await this.respond(text,options);
        }
      }
    }
    finally { if (this.pipeline === pipeline && this.wake && !this.wake.singleCommand) this.wake.touch(); }
  }
  async respond(text, { signal }) {
    const pipeline = this.pipeline;
    const controller = new AbortController();
    const narration = new AbortController();
    const abort = () => { controller.abort(); narration.abort(); };
    signal.addEventListener('abort', abort, { once:true });
    if (signal.aborted) abort();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.brainTimeoutMs);
    let lastProgress = '', lastAt = -Infinity, progressWork = Promise.resolve(),speechWork=Promise.resolve(),speechError,lastSpeechItem,spokenText='';
    const onSpeech=(chunk,{itemId}={})=>{
      if(controller.signal.aborted||this.pipeline!==pipeline)return;
      if(itemId!==lastSpeechItem){lastSpeechItem=itemId;spokenText='';}spokenText+=chunk;
      narration.abort();
      speechWork=speechWork.then(async()=>{if(!controller.signal.aborted&&this.pipeline===pipeline)await pipeline.say(chunk,{signal:controller.signal});}).catch(error=>{speechError=error;});
    };
    const onProgress = message => {
      const now = Date.now();
      if (controller.signal.aborted || this.pipeline !== pipeline || pipeline.output || pipeline.session || message === lastProgress || now - lastAt < (this.config.progressIntervalMs ?? 8000)) return;
      lastProgress = message; lastAt = now;
      // The brain never waits for progress audio. No backlog can outlive the task.
      progressWork = pipeline.say(message, { signal:narration.signal }).catch(error => {
        if (!narration.signal.aborted) { this.error = safeError(error); this.changed(); }
      });
    };
    try {
      const reply = await withAbort(Promise.resolve().then(() => {
        if (!controller.signal.aborted) return this.brain.run(text, { signal:controller.signal, onProgress, onSpeech });
      }), controller.signal);
      clearTimeout(timer);
      narration.abort();
      await withAbort(progressWork, signal);
      await withAbort(speechWork,signal);if(speechError)throw speechError;
      const remaining=spokenText&&reply.startsWith(spokenText)?reply.slice(spokenText.length):reply;
      if (!signal.aborted && this.pipeline === pipeline) await pipeline.say(remaining, { signal });
    } catch (error) {
      abort();
      if (timedOut) throw new Error('大脑响应超时，已请求停止；请重试或核对任务状态。');
      if (!signal.aborted) throw error;
    } finally {
      narration.abort(); clearTimeout(timer); signal.removeEventListener('abort', abort);
    }
  }
  interrupt() {
    this.cancelReading();
    this.pipeline?.interrupt();
    this.pipeline?.vad.reset?.();
    this.partial = ''; this.changed();
  }
  async stop() {
    this.enabled = this.inputEnabled = false;
    this.readingScope?.abort();
    this.readingScope=null;
    this.pipeline?.close(); this.pipeline = null;
    // Keep the error listener until capture shutdown finishes.
    if (this.onFrame) this.capture?.off('frame', this.onFrame);
    await Promise.allSettled([this.capture?.close(), this.playback?.close()]);
    if (this.onDeviceError) this.capture?.off('error', this.onDeviceError);
    this.wake?.sleep();
    this.state = 'idle'; this.level = 0; this.levelAt = 0; this.partial = ''; this.changed();
  }
  async close() { this.closed = true; await this.setEnabled(false); this.brain.close?.(); }
}
