import { mkdirSync } from 'node:fs';
import path from 'node:path';

const cap = (value, max = 2000) => String(value ?? '').slice(0, max);
const limitOf = (value, fallback = 20) => Number.isFinite(value) ? Math.max(0, Math.min(100, Math.trunc(value))) : fallback;
const keywordPattern = query => `%${cap(query).replace(/[\\%_]/g, '\\$&')}%`;

export async function openMemory(dataDir, { file = path.join(dataDir, 'memory.sqlite'), log = console.error } = {}) {
  file = path.resolve(file);
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { log('长期记忆不可用：当前 Node 不支持 node:sqlite。'); return null; }
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    return new MemoryStore(new DatabaseSync(file), file);
  } catch (error) { log(`长期记忆不可用：${error.message}`); return null; }
}

export class MemoryStore {
  constructor(db, file) {
    this.db = db; this.file = file;
    try {
      db.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT, updatedAt TEXT);
        CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY, kind TEXT CHECK(kind IN ('fact','note')), text TEXT, tags TEXT, createdAt TEXT, updatedAt TEXT);
        CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, threadId TEXT, turnId TEXT, request TEXT, outcome TEXT, status TEXT, createdAt TEXT);`);
    } catch (error) { db.close(); throw error; }
  }
  setPreference(key, value) {
    key = cap(key, 200).trim();
    if (!key) throw new Error('偏好名称不能为空');
    this.db.prepare('INSERT INTO preferences VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt').run(key, cap(value), new Date().toISOString());
  }
  getPreferences() { return this.db.prepare('SELECT * FROM preferences ORDER BY updatedAt DESC, key').all(); }
  deletePreference(key) { return this.db.prepare('DELETE FROM preferences WHERE key=?').run(cap(key, 200)).changes; }
  remember(text, tags = '', kind = 'fact') {
    text = cap(text).trim();
    if (!text || !['fact', 'note'].includes(kind)) throw new Error('记忆内容或类型无效');
    const now = new Date().toISOString();
    tags = cap(Array.isArray(tags) ? tags.join(',') : tags);
    // UI and MCP use separate connections. Serialize read + update across both.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT * FROM memories WHERE kind=? AND text=? ORDER BY id LIMIT 1').get(kind, text);
      let id = existing?.id;
      if (existing) {
        const merged = [...new Set(`${existing.tags},${tags}`.split(',').map(tag => tag.trim()).filter(Boolean))].join(',');
        this.db.prepare('UPDATE memories SET tags=?, updatedAt=? WHERE id=?').run(cap(merged), now, id);
      } else {
        id = this.db.prepare('INSERT INTO memories(kind,text,tags,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(kind, text, tags, now, now).lastInsertRowid;
      }
      const result = this.db.prepare('SELECT * FROM memories WHERE id=?').get(id);
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  search(query = '', limit = 20) {
    const pattern = keywordPattern(query);
    return this.db.prepare("SELECT * FROM memories WHERE text LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' ORDER BY updatedAt DESC, id DESC LIMIT ?").all(pattern, pattern, limitOf(limit));
  }
  forget(id) { return this.db.prepare('DELETE FROM memories WHERE id=?').run(id).changes; }
  listEntries(query = '', offset = 0, limit = 20) {
    const pattern = keywordPattern(query);
    const rows = this.db.prepare(`SELECT * FROM (
      SELECT 'memory' AS type, id, kind, text, tags, updatedAt AS time FROM memories
      UNION ALL SELECT 'preference', key, 'preference', key || '：' || value, '', updatedAt FROM preferences
      UNION ALL SELECT 'task', id, 'task', request || char(10) || outcome || '（' || status || '）', '', createdAt FROM tasks
    ) WHERE text LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\'
    ORDER BY time DESC, type, id DESC LIMIT ? OFFSET ?`).all(pattern, pattern, limitOf(limit) + 1, offset);
    return { entries: rows.slice(0, limitOf(limit)), hasMore: rows.length > limitOf(limit) };
  }
  deleteEntry(type, id) {
    if (type === 'memory') return this.forget(id);
    if (type === 'preference') return this.deletePreference(id);
    if (type === 'task') return this.db.prepare('DELETE FROM tasks WHERE id=?').run(id).changes;
    throw new Error('记忆类别无效');
  }
  recordTask({ threadId, turnId, request, outcome, status }) {
    return this.db.prepare('INSERT INTO tasks(threadId,turnId,request,outcome,status,createdAt) VALUES (?,?,?,?,?,?)').run(cap(threadId, 200), cap(turnId, 200), cap(request), cap(outcome, 500), cap(status, 100), new Date().toISOString());
  }
  recentTasks(limit = 5) { return this.db.prepare('SELECT * FROM tasks ORDER BY createdAt DESC, id DESC LIMIT ?').all(limitOf(limit, 5)); }
  contextSummary(maxChars = 1500, {includeTasks=true} = {}) {
    const preferences = this.getPreferences().map(p => `${p.key}：${p.value.slice(0, 150)}`);
    const facts = this.db.prepare("SELECT text FROM memories WHERE kind='fact' ORDER BY updatedAt DESC, id DESC LIMIT 5").all().map(m => m.text.slice(0, 150));
    const tasks = includeTasks?this.recentTasks(5).map(t => `${t.request.slice(0, 80)} → ${t.outcome.slice(0, 100)}（${t.status}）`):[];
    return [preferences.length && `偏好：\n${preferences.join('\n')}`, facts.length && `事实：\n${facts.join('\n')}`, tasks.length && `最近任务：\n${tasks.join('\n')}`].filter(Boolean).join('\n').slice(0, Math.max(0, Math.trunc(maxChars) || 0));
  }
  close() { this.db.close(); }
}
