// Called only after the shared HTTP origin/CSRF/body guards.
export function memoryList(store, params) {
  const query = params.get('q') ?? '';
  const rawOffset = params.get('offset') ?? '0';
  const offset = Number(rawOffset);
  if (query.length > 2000 || !/^\d+$/.test(rawOffset) || !Number.isSafeInteger(offset)) {
    return { status: 400, body: { error: '搜索词或分页参数无效' } };
  }
  if (!store) return unavailable();
  return { status: 200, body: store.listEntries(query, offset) };
}

export function memoryDelete(store, { type, id }) {
  if (!['memory', 'preference', 'task'].includes(type) ||
      (type === 'preference' ? typeof id !== 'string' || !id.trim() || id.length > 200 : !Number.isSafeInteger(id) || id <= 0)) {
    return { status: 400, body: { error: '记忆类别或编号无效' } };
  }
  if (!store) return unavailable();
  return store.deleteEntry(type, id)
    ? { status: 200, body: { ok: true } }
    : { status: 404, body: { error: '记忆已删除或不存在，请刷新列表。' } };
}

const unavailable = () => ({ status: 503, body: { error: '长期记忆不可用，请检查 Node 版本及数据库权限。' } });
