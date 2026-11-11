import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const fixtureId = '01234567-89ab-4cde-8fab-0123456789ab';

// Handcrafted protocol transcripts, not recordings from a paid service.
// Outbound rows act as barriers: no server event can overtake a command.
export class ReplaySocket extends EventTarget {
  constructor(name) {
    super();
    this.rows = readFileSync(new URL(`${name}.jsonl`, import.meta.url), 'utf8').trim().split('\n').map(JSON.parse);
    this.index = 0;
    this.sent = [];
    this.failures = [];
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.epoch = performance.now();
    queueMicrotask(() => this.advance());
  }
  advance() {
    if (this.timer || this.closed) return;
    const row = this.rows[this.index];
    if (!row || row.direction === 'send') return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.index++;
      if (row.event) {
        this.readyState = row.event === 'open' ? 1 : 3;
        this.dispatchEvent(new Event(row.event));
      } else {
        const data = row.text ? row.text.replaceAll(fixtureId, this.taskId) : Uint8Array.from(Buffer.from(row.binaryBase64, 'base64')).buffer;
        this.dispatchEvent(new MessageEvent('message', { data }));
      }
      this.advance();
    }, Math.max(0, row.offsetMs - (performance.now() - this.epoch)));
  }
  match(actual) {
    const expected = this.rows[this.index++];
    try { assert.deepEqual(actual, expected && { ...expected, offsetMs:0 }); }
    catch (error) { this.failures.push(error); }
    this.advance();
  }
  send(data) {
    this.sent.push(data);
    if (typeof data === 'string') {
      const message = JSON.parse(data);
      this.taskId ??= message.header.task_id;
      assert.match(this.taskId, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
      message.header.task_id = fixtureId;
      this.match({ direction:'send', offsetMs:0, text:JSON.stringify(message) });
    } else this.match({ direction:'send', offsetMs:0, binaryBase64:Buffer.from(data).toString('base64') });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.readyState = 3;
    this.match({ direction:'send', offsetMs:0, event:'close' });
  }
  verify() {
    assert.deepEqual(this.failures, []);
    assert.equal(this.index, this.rows.length, 'replay did not consume every frame');
    assert.equal(this.closed, true);
  }
}
