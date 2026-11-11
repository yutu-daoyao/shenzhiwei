function aborted() { return new DOMException('语音回合已取消', 'AbortError'); }

export function withAbort(promise, signal) {
  if (!signal) return promise;
  // Always consume the work promise, including an already aborted call.
  return new Promise((resolve, reject) => {
    const abort = () => reject(aborted());
    signal.addEventListener('abort', abort, { once:true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

export function waitUntilStopped(client, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (!client.busy && !client.locked && !client.orchestrator.active && !client.stopRequest?.escalating) finish();
    };
    const finish = error => {
      clearTimeout(timer); client.off('change', check);
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(aborted());
    const timer = setTimeout(() => finish(new Error('上一轮停止尚未确认，请在界面恢复会话核对。')), timeoutMs);
    signal.addEventListener('abort', abort, { once:true });
    client.on('change', check);
    if (signal.aborted) abort(); else check();
  });
}

/** Reuses native send/wait/interrupt, including starting-ID races and stop escalation. */
export class CodexVoiceBrain {
  constructor(client, { stopTimeoutMs = 45000 } = {}) {
    this.client = client;
    this.stopTimeoutMs = stopTimeoutMs;
    this.lifetime = new AbortController();
  }
  async stop({ signal } = {}) {
    if (signal?.aborted) throw aborted();
    // Explicit voice control may stop a typed task or a plan as well.
    const stopping = this.stopping = Promise.resolve().then(() => this.client.interrupt()).then(() => waitUntilStopped(this.client, this.stopTimeoutMs, this.lifetime.signal));
    // A failed stop must not poison all future rounds after manual recovery.
    stopping.finally(() => { if (this.stopping === stopping) this.stopping = null; }).catch(() => {});
    await withAbort(stopping, signal);
  }
  async run(text, { signal, onProgress = () => {}, onSpeech = () => {}, screenContext } = {}) {
    if (this.stopping) await withAbort(this.stopping, signal);
    if (signal?.aborted) throw aborted();
    const client = this.client;
    if (client.busy || client.locked || client.orchestrator.active || client.stopRequest?.escalating) throw new Error('当前任务尚未结束，请先停止或等待完成。');
    const reported = new Set(),spoken=new Map();let ownTurn;
    const progress = () => {
      if (signal?.aborted) return;
      const turnId=ownTurn??(client.busy?client.task.turnId:null);
      if(turnId)for(const item of client.items?.values()??[]){
        if(item.turnId!==turnId||item.type!=='agentMessage')continue;
        const offset=spoken.get(item.id)??0,tail=item.text.slice(offset);
        // Wait for a complete link/URL line so a query-string semicolon cannot
        // split a URL into an unrecognisable, subsequently spoken fragment.
        const matches=[...tail.matchAll(/[。！？!?；;\n]/g)].filter(m=>{
          const prefix=tail.slice(0,m.index+1);
          return !/https?:\/\/[^\s]*$/i.test(prefix)&&!(prefix.match(/```/g)?.length%2)&&!(/\[[^\]]*$|\]\([^)]*$/.test(prefix));
        });
        const end=matches.length?matches.at(-1).index+1:0;
        if(end){spoken.set(item.id,offset+end);onSpeech(tail.slice(0,end),{itemId:item.id});}
      }
      if(!client.busy)return;
      let message;
      if (client.approvals.size || client.computer?.pending?.size) message = '需要你在界面确认操作，我会等待审批。';
      else {
        const item = [...client.items.values()].findLast(item => item.turnId === client.task.turnId && item.type === 'tool' && !client.completed.has(item.id));
        message = ({ commandExecution:'正在执行命令。', fileChange:'正在处理文件。', mcpToolCall:'正在调用工具。', dynamicToolCall:'正在调用工具。', webSearch:'正在搜索网页。' })[item?.tool];
      }
      if (message && !reported.has(message)) { reported.add(message); onProgress(message); }
    };
    const abort = () => {
      let stopping;
      try { stopping = client.busy ? client.interrupt() : undefined; }
      catch (error) { stopping = Promise.reject(error); }
      // Keep later voice rounds behind the existing reliable stop mechanism.
      this.stopping = Promise.resolve(stopping).then(() => waitUntilStopped(client, this.stopTimeoutMs, this.lifetime.signal)).catch(() => {});
    };
    signal?.addEventListener('abort', abort, { once:true });
    client.on('change', progress);
    try {
      const work = (async () => {
        const { turnId } = await client.send(text, undefined, { signal,effort:'low',...(screenContext?{screenContext}:{}) });
        ownTurn=turnId;progress();
        const result = await client.waitForTurn(turnId, signal);
        if (signal?.aborted) throw aborted();
        if (result.status !== 'completed') throw new Error(result.error || `大脑回合${result.status}`);
        return result.text;
      })();
      return await withAbort(work, signal);
    } finally { signal?.removeEventListener('abort', abort); client.off('change', progress); }
  }
  close() { this.lifetime.abort(); }
}
