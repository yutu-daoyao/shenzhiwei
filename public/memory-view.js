export function mountMemory({ document, fetch, token, confirm }) {
  const $ = id => document.getElementById(id);
  const labels = { fact: '事实', note: '笔记', preference: '偏好', task: '任务历史' };
  let busy = false, offset = 0, query = '', hasMore = false;
  function node(tag, text) {
    const result = document.createElement(tag);
    result.textContent = text;
    return result;
  }
  function update() {
    $('memory-refresh').disabled = busy || !token();
    $('memory-prev').disabled = busy || !token() || offset === 0;
    $('memory-next').disabled = busy || !token() || !hasMore;
    if($('memory-add-submit'))$('memory-add-submit').disabled=busy||!token();
  }
  async function request(url, body) {
    const response = await fetch(url, { headers: { 'X-Zhiwei-CSRF': token(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '记忆请求失败');
    return result;
  }
  async function load() {
    $('memory-list').replaceChildren(); hasMore = false; update();
    const result = await request(`/api/memory?q=${encodeURIComponent(query)}&offset=${offset}`);
    hasMore = result.hasMore;
    for (const entry of result.entries) {
      const row = node('article', '');
      row.append(node('p', `${labels[entry.kind] || entry.kind} · ${new Date(entry.time).toLocaleString()}`), node('pre', entry.text));
      if (entry.tags) row.append(node('p', `标签：${entry.tags}`));
      const button = node('button', '删除'); button.type = 'button';
      button.onclick = () => run(async () => {
        if (!confirm(`确定删除这条${labels[entry.kind] || '记忆'}？删除后无法恢复。\n\n${entry.text}`)) return;
        await request('/api/memory/delete', { type: entry.type, id: entry.id });
        // Restart pagination after deletion so shifted rows cannot be skipped.
        offset = 0;
        await load();
      });
      row.append(button); $('memory-list').append(row);
    }
    $('memory-status').textContent = result.entries.length ? `第 ${offset / 20 + 1} 页 · ${result.entries.length} 条${hasMore ? '（还有更多）' : ''}` : '没有匹配的记忆。';
  }
  async function run(work) {
    if (busy || !token()) return;
    busy = true; update();
    try { await work(); }
    catch (error) { $('memory-status').textContent = error.message; }
    finally { busy = false; update(); }
  }
  $('memory-search').onsubmit = event => {
    event.preventDefault();
    return run(async () => { query = $('memory-query').value; offset = 0; await load(); });
  };
  if($('memory-add'))$('memory-add').onsubmit=event=>{event.preventDefault();return run(async()=>{const text=$('memory-text').value.trim();if(!text)throw Error('请先填写需要记住的内容');await request('/api/memory/remember',{text});$('memory-text').value='';query='';$('memory-query').value='';offset=0;await load();});};
  $('memory-prev').onclick = () => run(async () => { offset = Math.max(0, offset - 20); await load(); });
  $('memory-next').onclick = () => run(async () => { offset += 20; await load(); });
  $('memory-panel').ontoggle = () => {
    if ($('memory-panel').open) return run(async () => { offset = 0; await load(); });
  };
  return { update };
}
