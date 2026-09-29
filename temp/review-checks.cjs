// Fix verification + open-item measurements for the TransMate translation module.
// Covers the H1/H2 patches applied on 2026-09-28; no real network, no browser.
//   node temp/review-checks.cjs
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const jsonResponse = data => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
const openItem = [];

function backgroundContext(fetchImpl, storageOverrides = {}) {
  const sandbox = {
    URLSearchParams, AbortController, setTimeout, clearTimeout, console, fetch: fetchImpl,
    chrome: {
      storage: {
        local: { get: async defaults => ({ ...defaults, provider: 'custom', providerConfigs: { custom: { baseUrl: 'http://localhost:11434/v1', apiKey: 'test-only', model: 'test-only' } }, ...storageOverrides }), set: async () => {} },
        session: { get: async () => ({}) }
      }, runtime: { onMessage: { addListener(fn) { sandbox.messageHandler = fn; } } }
    }
  };
  vm.createContext(sandbox);
  sandbox.importScripts = file => vm.runInContext(source(file), sandbox, { filename: file });
  vm.runInContext(source('background.js'), sandbox, { filename: 'background.js' });
  return sandbox;
}

function fakeElement(tag = 'div') {
  return {
    nodeType: 1, tagName: tag.toUpperCase(), isConnected: true, style: {}, dataset: {}, hidden: false,
    children: [], textContent: '', innerText: '', value: '',
    setAttribute() {}, removeAttribute() {}, addEventListener() {}, remove() {},
    append(...items) { this.children.push(...items); }, appendChild(item) { this.children.push(item); return item; },
    focus() {}, select() {}, dispatchEvent() {}, setSelectionRange() {},
    getBoundingClientRect() { return { right: 400, top: 10, height: 30 }; }
  };
}

function contentContext(sendMessage) {
  const handlers = {};
  const nodes = new Map();
  const body = fakeElement('body');
  const html = fakeElement('html');
  const head = fakeElement('head');
  for (const parent of [body, html, head]) parent.appendChild = item => { parent.children.push(item); if (item.id) nodes.set(item.id, item); return item; };
  const document = {
    activeElement: null, body, documentElement: html, head,
    getElementById(id) { return nodes.get(id) || null; }, hasFocus() { return true; },
    createElement(tag) {
      const element = fakeElement(tag);
      Object.defineProperty(element, 'id', { get() { return this._id || ''; }, set(value) { this._id = value; if (value) nodes.set(value, this); } });
      return element;
    },
    createTextNode(text) { return { textContent: text }; },
    createRange() { return { selectNodeContents() {}, deleteContents() {}, insertNode() {}, setStartAfter() {}, setEndAfter() {} }; },
    addEventListener(type, fn) { handlers[type] = fn; },
    execCommand(command, _unused, text) {
      if (command !== 'insertText') return true;
      const field = document.activeElement;
      if (field.tagName === 'TEXTAREA' || field.tagName === 'INPUT') field.value = text;
      else field.innerText = text;
      return true;
    }
  };
  // <input type="text"> per HTML spec: value sanitisation strips CR/LF.
  class Input {
    constructor(value) { this._value = String(value); this.nodeType = 1; this.tagName = 'INPUT'; this.isConnected = true; this.disabled = false; this.readOnly = false; }
    get value() { return this._value; }
    set value(next) { this._value = String(next).replace(/[\r\n]+/g, ''); }
    getAttribute(name) { return name === 'type' ? 'text' : null; }
    focus() { document.activeElement = this; } select() {} dispatchEvent() {} setSelectionRange() {}
    getBoundingClientRect() { return { right: 400, top: 10, height: 30 }; }
  }
  class Textarea {
    constructor(value) { this.value = value; this.nodeType = 1; this.tagName = 'TEXTAREA'; this.isConnected = true; this.disabled = false; this.readOnly = false; }
    focus() { document.activeElement = this; } select() {} dispatchEvent() {} setSelectionRange() {}
    getBoundingClientRect() { return { right: 400, top: 10, height: 30 }; }
  }
  const sandbox = {
    chrome: { storage: { local: { get: (defaults, callback) => callback(defaults) }, onChanged: { addListener() {} } }, runtime: { sendMessage } },
    document, window: { focus() {}, innerWidth: 1200, innerHeight: 800, getSelection: () => ({ removeAllRanges() {}, addRange() {}, getRangeAt: () => document.createRange() }), addEventListener() {}, removeEventListener() {} },
    location: { hostname: 'local-audit.invalid' }, navigator: {}, Node: { ELEMENT_NODE: 1 },
    HTMLTextAreaElement: Textarea, HTMLInputElement: Input, Event: class {}, InputEvent: class {}, ClipboardEvent: class {}, DataTransfer: class { setData() {} },
    setTimeout: fn => { queueMicrotask(fn); return 1; }, clearTimeout() {}, setInterval() { return 1; }, clearInterval() {}, console
  };
  vm.createContext(sandbox);
  const code = source('content.js').replace(/\}\)\(\);\s*$/, 'globalThis.audit = { translate, writeField, readField, normalize, textForField };\n})();');
  vm.runInContext(code, sandbox, { filename: 'content.js' });
  return { sandbox, Input, Textarea, document, handlers, nodes };
}

async function run() {
  const verified = [];
  const test = async (name, fn) => { await fn(); verified.push(name); };

  // H1-a: a truncated batch now degrades to per-item retries instead of failing all
  await test('H1-a truncated batch response falls back to per-item retries', async () => {
    let calls = 0;
    const sandbox = backgroundContext(async (_url, options) => {
      calls += 1;
      const body = JSON.parse(options.body);
      if (body.messages[0].content.includes('Input JSON')) {
        return jsonResponse({ choices: [{ message: { content: '{"id":"0","text":"partial"}' }, finish_reason: 'length' }] });
      }
      const text = body.messages[0].content;
      const ids = [...text.matchAll(/"id":"([^"]+)"\s*,\s*"text"/g)].map(match => match[1]);
      const guess = ids[0] || (/Message ([A-Z])/.exec(text)?.[1] || 'x');
      return jsonResponse({ choices: [{ message: { content: `translated-${guess}` }, finish_reason: 'stop' }] });
    });
    const result = await sandbox.translateChatBatch([{ id: 'a', text: '消息一' }, { id: 'b', text: '消息二' }], 'en');
    // ids come back from the vm realm, so compare primitives instead of arrays
    assert.equal(result.map(item => item.id).join(','), 'a,b');
    assert.ok(result.every(item => item.text), 'every item should carry a translation');
    assert.equal(calls, 3, 'expected 1 batch call + 2 per-item fallback calls');
  });

  // H1-b: the batch output budget follows source volume, not item count
  await test('H1-b batch budget scales with characters, not item count', async () => {
    const bodies = [];
    const sandbox = backgroundContext(async (_url, options) => {
      const body = JSON.parse(options.body);
      if (!body.messages[0].content.includes('Input JSON')) {
        return jsonResponse({ choices: [{ message: { content: 'single' }, finish_reason: 'stop' }] });
      }
      bodies.push(body);
      const ids = [...body.messages[0].content.matchAll(/"id":"([^"]+)"/g)].map(match => match[1]);
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(ids.map(id => ({ id, text: 'x' }))) }, finish_reason: 'stop' }] });
    });
    const longText = '这是一段很长的中文客户消息。'.repeat(200); // ~2800 chars
    await sandbox.translateChatBatch([{ id: 'a', text: longText }, { id: 'b', text: longText }, { id: 'c', text: longText }], 'en');
    await sandbox.translateChatBatch(Array.from({ length: 12 }, (_, i) => ({ id: String(i), text: '短消息' })), 'en');
    const longBudget = bodies[0].max_tokens;
    const shortBudget = bodies[1].max_tokens;
    assert.ok(longBudget > longText.length, `long batch budget ${longBudget} should exceed ${longText.length} chars`);
    assert.equal(longBudget, 8000);
    assert.equal(shortBudget, 1200);
  });

  // H2-a: multi-line result into a single-line <input> is written AND verified
  await test('H2-a single-line input accepts a multi-line translation without a false failure', async () => {
    const { sandbox, Input, nodes } = contentContext(async () => ({ ok: true, text: 'First line\nSecond line', targetLanguage: 'en' }));
    const field = new Input('第一行\n第二行');
    await sandbox.audit.translate(field);
    assert.equal(field.value, 'First line Second line');
    assert.equal(nodes.get('__tl_toast'), undefined, 'no error toast expected');
  });

  // H2-b: the contenteditable / textarea path still receives raw newlines
  await test('H2-b non-input fields keep their original newlines', async () => {
    const { sandbox } = contentContext(async () => ({ ok: true, text: 'x' }));
    assert.equal(sandbox.audit.textForField({ tagName: 'INPUT' }, 'a\nb'), 'a b');
    assert.equal(sandbox.audit.textForField({ tagName: 'DIV' }, 'a\nb'), 'a\nb');
    assert.equal(sandbox.audit.textForField({ tagName: 'TEXTAREA' }, 'a\nb'), 'a\nb');
  });

  // M1: a gateway error page used to be thrown verbatim (6332 chars) into the toast
  await test('M1 provider error pages are trimmed before they reach the toast', async () => {
    const hugeBody = `<html><body>${'gateway error detail '.repeat(300)}</body></html>`;
    const sandbox = backgroundContext(async () => ({ ok: false, status: 502, text: async () => hugeBody }));
    const response = await new Promise(resolve => { sandbox.messageHandler({ type: 'TL_TRANSLATE', text: '你好', direction: 'zh2en' }, { tab: { id: 1 } }, resolve); });
    assert.equal(response.ok, false);
    assert.ok(response.error.length < 500, `错误信息应被截断，实际 ${response.error.length} 字符`);
    assert.match(response.error, /已截断/);
  });

  // M3: gpt-4o used to lose temperature (server fell back to its default, usually 1.0)
  await test('M3 a non-reasoning OpenAI model keeps its temperature', async () => {
    let body;
    const config = { provider: 'openai', providerConfigs: { openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'test-only', model: 'gpt-4o' } } };
    const sandbox = backgroundContext(async (_url, options) => {
      body = JSON.parse(options.body);
      return jsonResponse({ choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }] });
    }, config);
    await new Promise(resolve => { sandbox.messageHandler({ type: 'TL_TRANSLATE', text: '你好', direction: 'zh2en' }, { tab: { id: 1 } }, resolve); });
    assert.equal(body.temperature, 0.1);
  });

  // M2: a SAFETY block used to surface as "Google Gemini 没有返回翻译结果"
  await test('M2 a safety block is reported as a safety block, not as an empty result', async () => {
    const geminiConfig = { provider: 'gemini', providerConfigs: { gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'test-only', model: 'gemini-3.5-flash-lite' } } };
    const sandbox = backgroundContext(async () => jsonResponse({ candidates: [{ finishReason: 'SAFETY', content: {} }] }), geminiConfig);
    const response = await new Promise(resolve => { sandbox.messageHandler({ type: 'TL_TRANSLATE', text: '测试', direction: 'zh2en' }, { tab: { id: 1 } }, resolve); });
    assert.equal(response.ok, false);
    assert.match(response.error, /安全策略/);
    assert.doesNotMatch(response.error, /没有返回翻译结果/);
  });

  // M5: a second trigger while busy used to be dropped without any feedback
  await test('M5 a trigger during an in-flight translation tells the user why nothing happened', async () => {
    const requests = [];
    const { sandbox, Input, nodes } = contentContext(message => { requests.push(message); return new Promise(() => {}); });
    sandbox.audit.translate(new Input('第一条消息'));
    sandbox.audit.translate(new Input('第二条消息'));
    assert.equal(requests.length, 1, '忙碌时不应再发一次请求');
    assert.ok(nodes.get('__tl_toast'), '忙碌时应给出提示');
  });

  return { verified: verified.length, checks: verified, openItems: openItem };
}

module.exports = { run };

if (require.main === module) {
  run()
    .then(result => { console.log(JSON.stringify(result, null, 2)); })
    .catch(error => { console.error('VERIFICATION FAILED:', error); process.exitCode = 1; });
}
