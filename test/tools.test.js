import test from 'node:test';
import assert from 'node:assert/strict';
import { tools, readOnly, validate } from '../src/windows/tools.js';

const sample = (key, schema) => schema.enum?.[0] ?? (schema.type === 'integer' ? 1 : key === 'windowId' ? '123' : key === 'filename' ? 'result.txt' : 'fixture');
for (const tool of tools) test(`${tool.name} validates its complete parameter contract`, () => {
  const { properties, required } = tool.inputSchema;
  const valid = Object.fromEntries(required.map(key => [key, sample(key, properties[key])]));
  assert.doesNotThrow(() => validate(tool.name, valid));
  assert.throws(() => validate(tool.name, { ...valid, injected: true }), /不允许/);
  for (const key of required) {
    const missing = { ...valid }; delete missing[key];
    assert.throws(() => validate(tool.name, missing), /缺少/);
  }
  for (const [key, schema] of Object.entries(properties)) {
    const rejects = value => assert.throws(() => validate(tool.name, { ...valid, [key]: value }), /参数|滚动/);
    rejects(null);
    if (schema.type === 'boolean') {
      rejects('true');
      for (const value of [true,false]) assert.doesNotThrow(() => validate(tool.name, { ...valid, [key]:value }));
    } else if (schema.type === 'string') {
      rejects('x'.repeat((schema.maxLength ?? 10000) + 1));
      if (schema.minLength) rejects('');
      if (schema.pattern) rejects('../invalid');
      if (schema.enum) rejects('outside-enum');
    } else {
      for (const value of [schema.minimum - 1, schema.maximum + 1, 0.5, '1']) rejects(value);
      for (const value of [schema.minimum, schema.maximum]) assert.doesNotThrow(() => validate(tool.name, { ...valid, [key]: value }));
    }
  }
  assert.equal(tool.inputSchema.additionalProperties, false);
});
test('read-only tools are exactly the observation and metadata operations', () => {
  assert.deepEqual([...readOnly].sort(), ['search_files','get_desktop_status','list_saved_windows','list_windows','get_window','get_ui_tree','find_element','read_text','get_action_status'].map(op => `windows_${op}`).sort());
  for (const tool of tools) {
    assert.equal(tool.annotations.destructiveHint, tool.name === 'windows_close_window');
    assert.equal(tool.annotations.openWorldHint, false);
    assert.equal(tool.annotations.idempotentHint, false);
  }
  for (const params of [null, [], 'text']) assert.throws(() => validate(tools[0].name, params));
  assert.throws(() => validate('windows_unknown', {}));
  const mouse = { windowId:'1', captureId:'c', x:0, y:0, kind:'scroll' };
  for (const delta of [undefined, 0]) assert.throws(() => validate('windows_mouse', { ...mouse, delta }));
  assert.doesNotThrow(() => validate('windows_mouse', { ...mouse, delta:-120 }));
});
test('browser URL and search query validation', () => {
  assert.doesNotThrow(() => validate('windows_launch_app', { app:'browser' }));
  assert.doesNotThrow(() => validate('windows_launch_app', { app:'browser', url:'https://www.bing.com/search?q=AI' }));
  for (const url of ['file:///tmp/file', 'javascript:alert(1)', 'https://', 'https://a/'+ 'x'.repeat(2000)]) {
    assert.throws(() => validate('windows_launch_app', { app:'browser', url }));
  }
  for (const query of ['', 'x'.repeat(201)]) assert.throws(() => validate('windows_browser_search', { query }));
  assert.doesNotThrow(() => validate('windows_browser_search', { query:'今天的 AI 新闻' }));
});
