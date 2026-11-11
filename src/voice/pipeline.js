import { EventEmitter } from 'node:events';
import { createVoiceProviders } from './interfaces.js';
import {isVoiceFiller,voiceTaskControl} from './task-control.js';
import {speechText} from './speech-text.js';

export function createVoicePipeline({ config = {}, ...options } = {}) {
  return new VoicePipeline({ ...createVoiceProviders(config), ...options });
}

// Wake sessions drain sentences in input order; PTT submits one aggregate on release.
export class VoicePipeline extends EventEmitter {
  constructor({ asr, tts, vad, mode = 'wake', confirmBargeIn = false, admitSpeech, acceptLocalTranscript, onUserText = () => {}, speak = () => {}, stopPlayback = () => {}, finishPlayback = () => {}, sampleRate = 16000, language = 'zh', asrTimeoutMs = 45000, asrFinalTimeoutMs = 5000, asrMaxSessionMs = Number(process.env.ZHIWEI_ASR_MAX_SESSION_MS || 15000), preRollMs = 200 }) {
    super();
    if (!Number.isFinite(asrMaxSessionMs) || asrMaxSessionMs <= 0) throw new RangeError('ASR 会话时长必须为正数');
    Object.assign(this, { asr, tts, vad, mode, admitSpeech, acceptLocalTranscript, onUserText, speak, stopPlayback, finishPlayback, sampleRate, language, asrTimeoutMs, asrFinalTimeoutMs, asrMaxSessionMs });
    this.held = false;
    this.confirmBargeIn=confirmBargeIn;
    this.preRollBytes = Math.round(sampleRate * preRollMs / 1000) * 2;
    this.preRoll = Buffer.alloc(0);
    this.state = 'idle';
    this.sessions = new Set();
    this.closed = false;
    this.start = () => this.startSpeech();
    this.end = result => this.endSpeech(result);
    if (mode === 'wake') {
      vad.on('speechStart', this.start);
      vad.on('speechEnd', this.end);
    }
  }
  setState(state) {
    if (state !== this.state) { this.state = state; this.emit('state', state); }
  }
  updateState() {
    const listening=this.session&&!this.session.voiceNeedsConfirmation;
    this.setState(this.closed ? 'idle' : listening ? 'listening' : this.output ? 'speaking' : (this.turn || this.sessions.size) ? 'thinking' : 'idle');
  }
  cancelOutput() {
    const output = this.output;
    this.output = null;
    if (output) { output.controller.abort(); output.stream.cancel(); }
    this.stopPlayback();
  }
  interrupt({ preserveRecognition = false } = {}) {
    const active = this.output || this.turn || this.sessions.size;
    // The device queue is stopped synchronously, before waiting for any network work.
    this.cancelOutput();
    const turn = this.turn;
    this.turn = null;
    turn?.controller.abort();
    if (!preserveRecognition) this.discardInput();
    if (active && !this.closed) { this.setState('interrupted'); this.emit('bargeIn'); }
    this.updateState();
  }
  discardInput(){
    this.held=false;
    for(const session of this.sessions)this.removeSession(session);
    this.preRoll=Buffer.alloc(0);
    this.vad.reset?.();
    this.updateState();
  }
  setMode(mode){
    this.discardInput();
    if(mode===this.mode)return;
    this.mode=mode;
    if(mode==='wake'){
      this.vad.on('speechStart',this.start);
      this.vad.on('speechEnd',this.end);
    }else{
      this.vad.off('speechStart',this.start);
      this.vad.off('speechEnd',this.end);
    }
  }
  startHold() {
    if (this.closed || this.mode !== 'ptt' || this.held) return;
    if(this.admitSpeech)this.discardInput();else this.interrupt();
    this.held = true;
    this.startSpeech({ continuation:true });
  }
  stopHold() {
    if (!this.held) return;
    this.held = false;
    this.endSpeech({valid:!this.admitSpeech||!!this.session?.voiceDurationMs});
  }
  startSpeech({ continuation = false } = {}) {
    if (this.closed || this.session) return;
    const needsConfirmation=!continuation&&(this.confirmBargeIn||this.asr.requiresVerification)&&!!(this.output||this.turn);
    if (!this.admitSpeech&&!continuation&&!needsConfirmation) this.interrupt({ preserveRecognition:true });
    let session;
    try { session = this.asr.createSession({ sampleRate:this.sampleRate, language:this.language }); }
    catch (error) {
      if (this.mode === 'ptt') this.interrupt();
      this.emit('error', error); return;
    }
    this.session = session;
    session.voiceNeedsConfirmation=needsConfirmation;
    session.voiceContinuation=continuation&&this.mode==='wake';
    this.sessions.add(session);
    session.voiceSentences = [];
    session.voiceSeen = new Set();
    session.voiceDurationMs = 0;
    const fail = error => {
      if (!this.removeSession(session)) return;
      // Never execute a partial PTT utterance after a missing/failed segment.
      if (this.mode === 'ptt') {
        if(this.admitSpeech)this.discardInput();else this.interrupt();
      }
      this.updateState();
      if (!this.closed) this.emit('error', error);
      this.flushFinals();
    };
    session.voiceFail = fail;
    session.on('error', fail);
    session.on('partial', result => {
      if (!this.sessions.has(session)) return;
      if(this.admitSpeech)return;
      session.voicePartial = result.text;
      if(this.mode==='wake'&&(session.voiceNeedsConfirmation||isVoiceFiller(result.text)))return;
      if (!this.session || this.session === session) this.emit('partial', this.mode === 'ptt'
        ? { ...result, text:[...this.sessions].map(item => item.voiceFinal?.text ?? item.voicePartial ?? '').join('') }
        : result);
    });
    session.on('sentence', ({ id, text }) => {
      if (this.admitSpeech || !this.sessions.has(session) || this.closed || session.voiceSeen.has(id)) return;
      session.voiceSeen.add(id);
      if(this.acceptSpeech(session,text)){
        this.preemptControl(session,text);
        session.voiceSentences.push(text);
      }
      this.flushFinals();
    });
    session.once('final', ({ text }) => {
      if (!this.sessions.has(session) || this.closed) return;
      const accepted=this.admitSpeech||(this.mode==='ptt'||!session.voiceSeen.size)&&this.acceptSpeech(session,text);
      if(accepted&&!this.admitSpeech)this.preemptControl(session,text);
      clearTimeout(session.voiceTimer);
      session.voiceFinal = { text:accepted?text:'' };
      // Keep the lifetime timer until VAD has validated the segment.
      if (this.session !== session) session.close();
      else session.voiceTimer = setTimeout(() => fail(new Error('语音识别超时，请重新说话。')), this.asrTimeoutMs);
      this.flushFinals();
    });
    session.voiceTimer = setTimeout(() => fail(new Error('语音识别超时，请重新说话。')), this.asrTimeoutMs);
    session.voiceSegmentTimer = setTimeout(() => this.rotateSession(session), this.asrMaxSessionMs);
    try { if (!continuation && this.preRoll.length) session.write(this.preRoll); }
    catch (error) { fail(error); }
    this.updateState();
  }
  removeSession(session) {
    if (!this.sessions.delete(session)) return false;
    clearTimeout(session.voiceTimer);
    clearTimeout(session.voiceSegmentTimer);
    if (this.session === session) this.session = null;
    session.close();
    return true;
  }
  acceptSpeech(session,text){
    if(typeof text!=='string'||!text.trim())return false;
    if(this.mode!=='wake')return true;
    if(isVoiceFiller(text))return false;
    if(session.voiceNeedsConfirmation){
      if(voiceTaskControl(text)==='append'&&text.replace(/[^\p{L}\p{N}]/gu,'').length<2)return false;
      session.voiceNeedsConfirmation=false;
      if(this.output||this.turn)this.interrupt({preserveRecognition:true});
    }
    return true;
  }
  preemptControl(session,text){
    if(this.mode!=='wake'||voiceTaskControl(text)==='append')return;
    this.interrupt({preserveRecognition:true});
    // Old recognition segments must not run after an explicit change of priority.
    for(const older of this.sessions){if(older===session)break;this.removeSession(older);}
    session.voiceSentences.length=0;
  }
  flushFinals() {
    // Confirmed sentences can run while VAD is still open. Drain sessions and
    // sentences in input order; legacy aggregate finals still wait for VAD.
    if (this.closed) return;
    if(this.admitSpeech&&this.mode==='wake'){
      for(const session of this.sessions){
        if(session===this.session||!session.voiceFinal)break;
        if(!session.voiceFinal.checked){
          const {text}=session.voiceFinal;
          if(!this.admitSpeech(text,session.voiceContinuation)){this.removeSession(session);continue;}
          session.voiceFinal.checked=true;
          if(this.output||this.turn)this.interrupt({preserveRecognition:true});
        }
        break;
      }
    }
    if(this.mode==='wake')for(const session of this.sessions){
      if(session!==this.session&&session.voiceFinal?.text===''&&!session.voiceSentences.length)this.removeSession(session);
    }
    if (this.turn && !(this.admitSpeech&&this.mode==='ptt')) return;
    const session = this.sessions.values().next().value;
    if (!session) { this.updateState(); return; }
    let text;
    if (this.mode === 'ptt') {
      if (this.held || this.session || [...this.sessions].some(item => !item.voiceFinal)) { this.updateState(); return; }
      text = [...this.sessions].map(item => item.voiceFinal.text ?? '').join('').trim();
      for (const item of this.sessions) this.removeSession(item);
      if(this.admitSpeech&&!this.admitSpeech(text)){this.updateState();return;}
      if ([...text.replace(/[^\p{L}\p{N}]/gu, '')].length < 2) {
        this.emit('empty'); this.updateState(); return;
      }
    }
    else if (session.voiceSentences.length) text = session.voiceSentences.shift();
    else if (session.voiceFinal && this.session !== session && (session.voiceFinal.checked || !this.session || session.voiceSeen.size || !session.voiceFinal.text?.trim())) {
      // Once sentence events have been received, the aggregate is cleanup only.
      text = session.voiceSeen.size ? '' : session.voiceFinal.text;
      this.removeSession(session);
    } else { this.updateState(); return; }
    if (typeof text !== 'string' || !text.trim()) { this.flushFinals(); return; }
    if(this.admitSpeech&&this.mode==='ptt'&&(this.output||this.turn))this.interrupt({preserveRecognition:true});
    const turn = { controller:new AbortController() };
    this.turn = turn;
    this.updateState();
    Promise.resolve().then(() => {
      if (!turn.controller.signal.aborted) return this.onUserText(text.trim(), { signal:turn.controller.signal });
    }).catch(error => {
      if (!this.closed && this.turn === turn && !turn.controller.signal.aborted) this.emit('error', error);
    }).finally(() => {
      if (this.turn === turn) this.turn = null;
      this.updateState();
      this.flushFinals();
    });
  }
  endSpeech({ valid = true, rotating = false } = {}) {
    const session = this.session;
    this.session = null;
    if (session && !valid) {
      this.removeSession(session);
      this.flushFinals();
      this.updateState();
      return;
    }
    if (session) {
      clearTimeout(session.voiceTimer);
      clearTimeout(session.voiceSegmentTimer);
      if (session.voiceFinal) session.close();
      else {
        session.voiceTimer = setTimeout(() => session.voiceFail(new Error('语音识别最终结果超时，请重新说话。')), this.asrFinalTimeoutMs);
        const acceptLocalTranscript=this.mode==='wake'&&!rotating&&!session.voiceContinuation?this.acceptLocalTranscript:undefined;
        try { session.end({acceptLocalTranscript}); }
        catch (error) { session.emit('error', error); }
      }
    }
    this.flushFinals();
    this.updateState();
  }
  rotateSession(session) {
    if (this.closed || this.session !== session) return;
    this.endSpeech({rotating:true});
    // A transport boundary is not a new user interruption. Do not cancel a
    // command or replay pre-roll audio when room speech keeps VAD open.
    if (this.mode === 'ptt' ? this.held : this.vad.speech) this.startSpeech({ continuation:true });
  }
  write(frame) {
    if (this.closed) return;
    if (!Buffer.isBuffer(frame) || frame.length % 2) throw new TypeError('Expected PCM16 Buffer');
    if (this.mode === 'ptt') {
      if (!this.held) return;
    } else this.vad.process(frame);
    const session = this.session;
    try {
      session?.write(frame);
      if (session) {
        session.voiceDurationMs += frame.length / (this.sampleRate * 2) * 1000;
        if (session.voiceDurationMs >= this.asrMaxSessionMs) this.rotateSession(session);
      }
    }
    catch (error) { session?.emit('error', error); }
    if (this.mode === 'wake' && this.preRollBytes > 0) this.preRoll = Buffer.concat([this.preRoll, frame]).subarray(-this.preRollBytes);
  }
  setReading(enabled){
    this.muted=!enabled;
    if(this.muted){this.cancelOutput();this.updateState();}
  }
  async say(text, { signal } = {}) {
    text = speechText(text);
    if (this.closed || this.muted || signal?.aborted || !text?.trim()) return;
    this.cancelOutput();
    const output = { stream:this.tts.synthesize(text, { format:'pcm16', sampleRate:this.sampleRate }), controller:new AbortController() };
    this.output = output;
    const abort = () => { if (this.output === output) this.cancelOutput(); };
    signal?.addEventListener('abort', abort, { once:true });
    this.updateState();
    const options = { signal:output.controller.signal, sampleRate:this.sampleRate };
    try {
      for await (const chunk of output.stream) {
        if (this.closed || this.output !== output) break;
        await this.speak(chunk, options);
      }
      if (this.output === output) await this.finishPlayback(options);
    } catch (error) {
      if (!output.controller.signal.aborted) {
        if (this.output === output) this.cancelOutput();
        throw error;
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      output.stream.cancel();
      if (this.output === output) this.output = null;
      this.updateState();
    }
  }
  close() {
    this.closed = true;
    this.vad.off('speechStart', this.start);
    this.vad.off('speechEnd', this.end);
    this.interrupt();
    this.preRoll = Buffer.alloc(0);
    this.vad.reset?.();
  }
}
