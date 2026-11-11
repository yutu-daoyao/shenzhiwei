import { lstat, realpath, open, opendir } from 'node:fs/promises';
import path from 'node:path';

const MAX_BYTES = 1024 * 1024, PREVIEW_BYTES = 64 * 1024;
const allowed = name => typeof name === 'string' && name.length > 0 && name.length <= 160 && name.trim() === name && !name.startsWith('.') && !/[\\/:<>|"*?\x00-\x1f]/.test(name) && /\.(txt|md|csv)$/i.test(name) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])\./i.test(name);

// Read-only, shallow access to the dedicated workspace. No arbitrary paths or shell.
export class WorkspaceFiles {
  constructor(directory) { this.directory = path.resolve(directory); }
  async checkRoot() {
    const stat = await lstat(this.directory, { bigint: true });
    const resolved = await realpath(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (this.identity && (resolved !== this.identity.path || stat.ino !== this.identity.ino || stat.dev !== this.identity.dev))) throw new Error('工作目录已被替换或重定向，请检查专用工作区后重新启动客户端。');
    this.identity ??= { path: resolved, ino: stat.ino, dev: stat.dev };
    return resolved;
  }
  async info(name) {
    if (!allowed(name)) throw new Error('只支持专用目录中的 txt、md、csv 文件，不允许路径、隐藏文件或设备名。');
    const target = path.join(this.directory, name), stat = await lstat(target, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error('只允许普通文件，不读取符号链接、目录或硬链接。');
    if (stat.size > BigInt(MAX_BYTES)) throw new Error('文件超过 1 MB，请通过知微在工作区内分段处理。');
    const resolved = await realpath(target);
    if (path.dirname(resolved) !== this.identity.path) throw new Error('文件不在原专用工作区内，已拒绝读取。');
    return { target, stat, resolved };
  }
  async list() {
    await this.checkRoot();
    const files = []; let scanned = 0, truncated = false;
    for await (const entry of await opendir(this.directory)) {
      if (++scanned > 256 || files.length >= 128) { truncated = true; break; }
      if (!entry.isFile() || !allowed(entry.name)) continue;
      try { const { stat } = await this.info(entry.name); files.push({ name: entry.name, size: Number(stat.size), modifiedAt: new Date(Number(stat.mtimeMs)).toISOString() }); }
      catch { /* Changing, linked or oversized files are not deliverables. */ }
    }
    await this.checkRoot();
    files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name));
    return { files, truncated };
  }
  async read(name, download = false) {
    await this.checkRoot();
    const before = await this.info(name), handle = await open(before.target, 'r');
    try {
      const actual = await handle.stat({ bigint: true });
      if (!actual.isFile() || actual.ino !== before.stat.ino || actual.dev !== before.stat.dev || actual.nlink !== 1n || actual.size > BigInt(MAX_BYTES)) throw new Error('文件身份已变化，请刷新后重试。');
      await this.checkRoot();
      if (await realpath(before.target) !== before.resolved) throw new Error('文件位置已变化，已拒绝读取。');
      const limit = download ? MAX_BYTES : PREVIEW_BYTES;
      const buffer = Buffer.alloc(Math.min(limit + 1, Number(actual.size) + 1));
      let count = 0;
      while (count < buffer.length) {
        const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
        if (!bytesRead) break;
        count += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      await this.checkRoot();
      if (after.size !== actual.size || after.mtimeNs !== actual.mtimeNs || after.nlink !== 1n || count < Math.min(Number(actual.size), limit)) throw new Error('文件正在变化或未完整读取，请保存完成后刷新预览。');
      const truncated = actual.size > BigInt(PREVIEW_BYTES) && !download, bytes = buffer.subarray(0, Math.min(count, limit));
      const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
      let text;
      try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: truncated }); }
      catch { throw new Error('文件不是支持的 UTF-8/UTF-16 文本，未显示内容。'); }
      if (text.includes('\u0000')) throw new Error('文件包含二进制数据，未作为文本交付。');
      return { name, text, truncated, size: Number(actual.size), modifiedAt: new Date(Number(actual.mtimeMs)).toISOString(), bytes };
    } finally { await handle.close(); }
  }
}
