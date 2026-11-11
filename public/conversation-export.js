// Export only the visible conversation, never reasoning, tool arguments or account data.
export function conversationExport(state, now = new Date()) {
  const messages = (state.items || []).filter(item => ['userMessage', 'agentMessage'].includes(item.type) && typeof item.text === 'string');
  if (!messages.length) throw new Error('当前还没有可导出的对话。');
  const title = state.sessions?.find(session => session.id === state.currentId)?.title || '新对话';
  const text = [`沈知微 · ${title}`, `导出时间：${now.toISOString()}`, '以下为当前已收到的对话内容，导出不会停止正在执行的任务。', '',
    ...messages.flatMap(item => [item.type === 'userMessage' ? '你：' : '知微：', item.text, ''])].join('\r\n');
  return { text, filename: `zhiwei-conversation-${now.toISOString().replace(/[:.]/g, '-')}.txt` };
}
