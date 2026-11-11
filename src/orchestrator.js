import { randomUUID } from 'node:crypto';
import { safeError } from './codex/process.js';

export function parsePlan(output, text) {
  for (let start = output.indexOf('{'); start !== -1; start = output.indexOf('{', start + 1)) {
    for (let end = output.lastIndexOf('}'); end > start; end = output.lastIndexOf('}', end - 1)) {
      try {
        const plan = JSON.parse(output.slice(start, end + 1));
        if (Array.isArray(plan.steps) && plan.steps.length && plan.steps.every(s => typeof s?.title === 'string' && s.title.trim() && typeof s.instruction === 'string' && s.instruction.trim())) return plan.steps.slice(0, 8).map(({ title, instruction }) => ({ title, instruction }));
      } catch {}
    }
  }
  return [{ title: text, instruction: text }];
}

export class Orchestrator {
  constructor({ client }) { this.client = client; this.active = false; }
  stop() { this.controller?.abort(); }
  async turn(text) {
    const signal = this.controller.signal;
    if (signal.aborted) return { status: 'interrupted', text: '' };
    let abort;
    const stopped = new Promise(resolve => {
      abort = () => resolve({ status: 'interrupted', text: '' });
      signal.addEventListener('abort', abort, { once: true });
    });
    const execution = this.client.send(text, this).then(({ turnId }) => {
      this.turnId = turnId;
      return this.client.waitForTurn(turnId, signal);
    });
    try { return await Promise.race([execution, stopped]); }
    finally { signal.removeEventListener('abort', abort); }
  }
  async runPlan(text, { maxAttempts = 2 } = {}) {
    if (![1, 2].includes(maxAttempts)) throw new Error('maxAttempts 必须为 1 或 2');
    if (typeof text !== 'string' || !text.trim() || text.length > 30000) throw new Error('请输入 1–30000 个字符。');
    const c = this.client;
    if (this.active || c.locked || c.busy) throw new Error('当前任务尚未结束。');
    c.ready();
    this.turnId = null;
    this.active = true;
    this.controller = new AbortController();
    const plan = c.plan = { text: text.trim(), status: 'planning', steps: [], report: '' };
    c.changed();
    try {
      const planning = await this.turn(`只规划，不执行任何操作或调用工具。仅输出 JSON：{"steps":[{"title":"简短标题","instruction":"具体执行指令"}]}。拆为 1–8 步，简单任务可仅 1 步。总任务：${plan.text}`);
      if (this.controller.signal.aborted) throw new Error('已停止');
      if (planning.status !== 'completed') throw new Error(planning.error || '规划未完成');
      plan.steps = parsePlan(planning.text, plan.text).map(s => ({ ...s, status: 'pending', attempts: 0, error: '' }));
      plan.status = 'running'; c.changed();
      for (const [index, step] of plan.steps.entries()) {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          if (this.controller.signal.aborted) break;
          step.status = 'running'; step.attempts++; c.changed();
          let result;
          try {
            result = await this.turn(`第 ${index + 1}/${plan.steps.length} 步：${step.instruction}（总任务：${plan.text}）。仅执行本步。${attempt ? `上次失败原因：${step.error}，换一种方法重试一次。` : ''}完成后最后一行必须输出 STEP_RESULT: ok 或 STEP_RESULT: failed <原因>`);
          } catch (error) { result = { status: 'failed', error: safeError(error), text: '' }; }
          if (this.controller.signal.aborted) break;
          const unknown = c.computer?.snapshot().actions?.find(a => a.needsReview);
          const marker = result.text.match(/(?:^|\n)STEP_RESULT:\s*(ok|failed)([^\n]*)\s*$/);
          step.error = unknown ? `Windows 操作结果未知，需核实，未重试：${unknown.error || unknown.tool}` : result.status !== 'completed' ? result.error || `任务${result.status}` : marker?.[1] === 'failed' ? marker[2].trim() || '步骤失败' : '';
          step.status = step.error ? 'failed' : 'ok'; c.changed();
          if (unknown || step.status === 'ok') break;
        }
        if (this.controller.signal.aborted || step.status === 'failed') break;
      }
      plan.status = this.controller.signal.aborted ? 'stopped' : plan.steps.some(s => s.status === 'failed') ? 'failed' : 'done';
    } catch (error) {
      plan.status = this.controller.signal.aborted ? 'stopped' : 'failed';
      plan.report = safeError(error);
    } finally {
      for (const step of plan.steps) if (step.status === 'pending' || step.status === 'running') step.status = 'skipped';
      plan.report = `${plan.status === 'stopped' ? '已停止' : plan.status === 'failed' ? '执行失败' : '执行完成'}，共 ${plan.steps.length} 步${plan.report ? `：${plan.report}` : ''}\n` + plan.steps.map((s, i) => `${s.status === 'ok' ? '✓' : s.status === 'failed' ? '✗' : '未执行'} ${i + 1}. ${s.title}${s.error ? `：${s.error}` : ''}`).join('\n');
      c.upsert({ id: `plan-${randomUUID()}`, type: 'agentMessage', text: plan.report }, null, true);
      try { await c.memory?.recordTask({ threadId: c.currentId, turnId: this.turnId, request: plan.text, outcome: plan.report, status: plan.status }); }
      catch (error) { c.log(`长期记忆写入失败：${safeError(error)}`); }
      this.active = false; c.changed();
    }
    return { report: plan.report };
  }
}
