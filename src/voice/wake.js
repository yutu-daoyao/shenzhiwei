import { NAME_CORRECTIONS, parseAssistantAddress } from './name-corrections.js';

// Replaceable detector: accept(sentenceText) -> boolean, reset().
export class KeywordWakeDetector {
  constructor({ keyword = process.env.ZHIWEI_WAKE_WORD ?? '知微', aliases = process.env.ZHIWEI_WAKE_ALIASES ?? '', cooldownMs = 3000, now = Date.now } = {}) {
    if (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 40) throw new Error('唤醒词需要 1–40 个字符');
    if (!Number.isFinite(cooldownMs) || cooldownMs < 0) throw new Error('唤醒冷却时间无效');
    Object.assign(this, { keyword:keyword.normalize('NFKC').trim().toLowerCase(), cooldownMs, now });
    this.names = [this.keyword, ...(this.keyword === '知微' ? ['沈知微', ...Object.keys(NAME_CORRECTIONS)] : []),
      ...String(aliases).split(/[,，]/u).map(name => name.normalize('NFKC').trim().toLowerCase()).filter(Boolean)];
    this.reset();
  }
  reset() { this.lastWake = -Infinity; }
  parse(text) { return parseAssistantAddress(text, this.names); }
  matches(text) { return !!this.parse(text); }
  accept(text) {
    if (!this.matches(text)) return false;
    const time = this.now();
    if (time - this.lastWake < this.cooldownMs) return false;
    this.lastWake = time;
    return true;
  }
}

export class WakeGate {
  constructor({ detector = new KeywordWakeDetector(), idleMs = Number(process.env.ZHIWEI_WAKE_IDLE_MS || 30000), singleCommand = process.env.ZHIWEI_WAKE_SINGLE_COMMAND === '1', now = Date.now } = {}) {
    if (!Number.isFinite(idleMs) || idleMs <= 0) throw new Error('唤醒闲置时间必须为正数');
    Object.assign(this, { detector, idleMs, singleCommand, now });
    this.sleep();
  }
  sleep() { this.until = -Infinity; }
  touch() { this.until = this.now() + this.idleMs; }
  route(text) {
    const address = this.detector.parse?.(text);
    // Wake-only utterances are always consumed, including duplicates within cooldown.
    if (this.detector.accept(text)) {
      this.touch();
      if (address?.command && this.singleCommand) this.sleep();
      return { action:'wake', command:address?.command ?? '' };
    }
    // Cooldown suppresses repeated acknowledgements, not a freshly addressed
    // command in an already open conversation.
    if (address?.command && this.now() < this.until) {
      if (this.singleCommand) this.sleep(); else this.touch();
      return { action:'command', command:address.command };
    }
    if (address || this.detector.matches?.(text)) return { action:'sleep' };
    if (this.now() >= this.until) { this.sleep(); return { action:'sleep' }; }
    if (this.singleCommand) this.sleep(); else this.touch();
    return { action:'command', command:text };
  }
  accept(text) { return this.route(text).action; }
}
