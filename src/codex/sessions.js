import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class Sessions {
  constructor(directory) { this.directory = directory; this.file = path.join(directory, 'sessions.json'); this.entries = []; this.queue = Promise.resolve(); }
  async load() {
    await mkdir(this.directory, { recursive: true });
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      if (!Array.isArray(data) || data.some(s => typeof s.id !== 'string' || typeof s.title !== 'string' || !s.createdAt || !s.updatedAt)) throw new Error('invalid');
      this.entries = data.map(({ id, title, createdAt, updatedAt, draft }) => ({
        id, title, createdAt, updatedAt, ...(draft === true ? {draft:true} : {}),
      }));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('会话索引损坏或无法读取。请备份 data/sessions.json 后修复；程序不会覆盖原文件。');
    }
  }
  async put(entry) {
    const job = this.queue.then(async () => {
      const entries = this.entries.filter(s => s.id !== entry.id).concat(entry);
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(entries, null, 2), { mode: 0o600 });
      await rename(temporary, this.file);
      this.entries = entries;
    });
    this.queue = job.catch(() => {});
    return job;
  }
}
