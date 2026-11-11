import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export class ConnectionStages {
  constructor(client, agent) { this.client = client; this.agent = agent; }
  reset() { this.steps = []; }
  snapshot() { return (this.steps ?? []).map(step => ({ ...step })); }
  async run(stage, operation, detail) {
    const step = { stage, status: 'running', ...(detail ? { detail } : {}) };
    this.steps.push(step);
    this.client.changed();
    const start = performance.now();
    try {
      const result = await operation();
      step.status = 'done';
      return result;
    } catch (error) {
      step.status = 'failed';
      throw error;
    } finally {
      step.elapsedMs = Math.round((performance.now() - start) * 1000) / 1000;
      this.record(step);
    }
  }
  skip(stage, detail) {
    const step = { stage, status: 'skipped', detail };
    this.steps.push(step);
    this.record(step);
  }
  record(step) {
    const row = JSON.stringify({ time: new Date().toISOString(), agent: this.agent, ...step }) + '\n';
    this.client.changed();
    const dir = this.client.dataDir;
    if (!dir) return;
    this.pending = (this.pending ?? Promise.resolve()).then(async () => {
      await mkdir(dir, { recursive: true });
      await appendFile(path.join(dir, 'agent-connection.jsonl'), row, { mode: 0o600 });
    }).catch(() => this.client.log('无法写入 Agent 连接计时日志。'));
  }
}
