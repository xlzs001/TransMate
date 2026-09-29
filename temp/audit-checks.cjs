// Local audit only: evaluate current source in isolated VM contexts with fake APIs.
// Does not modify extension files, read browser storage, or make network requests.
// v3.7.2 历史复现脚本 —— 记录当时仍然存在的缺陷，不是回归测试。
//
// 该脚本的每条断言都对应 v3.7.2 的“错误行为”，这些缺陷已在 v3.8.2 修复
// （B1/B2/B3/B4/B5/B7），因此它在当前代码上必然失败，属预期结果：
// 第一个断言即 B3（富文本多行写入误报），当前正常返回 true。
// 当前代码的回归用例请运行 temp/regression-checks.cjs（9/9）与
// temp/review-checks.cjs（H1/H2 修复验证）。保留本文件仅用于对照历史结论。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const results = [];
async function check(name, fn) {
  const evidence = await fn();
  results.push({ name, result: 'CONFIRMED', evidence });
}
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function contentContext(sendMessage) {
  const handlers = {};
  const document = {
    activeElement: null,
    body: { appendChild() {} },
    documentElement: { appendChild() {} },
    head: { appendChild() {} },
    getElementById() { return null; },
    hasFocus() { return true; },
    createElement() { return { style: {}, setAttribute() {}, remove() {} }; },
    createRange() { return { selectNodeContents() {} }; },
    addEventListener(type, fn) { handlers[type] = fn; },
    execCommand(command, _unused, text) {
      if (command !== 'insertText') return true;
      const field = document.activeElement;
      if (field.tagName === 'TEXTAREA') field.value = text;
      else field.innerText = text;
      return true;
    }
  };
  class Textarea {
    constructor(value) { this.value = value; this.nodeType = 1; this.tagName = 'TEXTAREA'; this.isConnected = true; }
    focus() { document.activeElement = this; }
    select() {}
    dispatchEvent() {}
    getBoundingClientRect() { return { right: 400, top: 10, height: 30 }; }
  }
  const sandbox = {
    chrome: {
      storage: { local: { get: (defaults, callback) => callback(defaults) }, onChanged: { addListener() {} } },
      runtime: { sendMessage }
    },
    document,
    window: { focus() {}, innerWidth: 1200, innerHeight: 800, getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
    location: { hostname: 'local-audit.invalid' },
    navigator: {}, Node: { ELEMENT_NODE: 1 },
    HTMLTextAreaElement: Textarea, HTMLInputElement: class {},
    Event: class {}, InputEvent: class {},
    setTimeout: fn => { queueMicrotask(fn); return 1; }, clearTimeout() {},
    setInterval() { return 1; }, clearInterval() {}, console
  };
  vm.createContext(sandbox);
  const code = source('content.js').replace(/\}\)\(\);\s*$/, 'globalThis.audit = { translate, insertViaExecCommand, readField, normalize };\n})();');
  vm.runInContext(code, sandbox, { filename: 'content.js' });
  return { sandbox, Textarea, document, handlers };
}
function backgroundContext(fetchImpl) {
  const sandbox = {
    URLSearchParams, AbortController, setTimeout, clearTimeout, console,
    fetch: fetchImpl,
    chrome: {
      storage: {
        local: { get: async defaults => ({ ...defaults, provider: 'custom', providerConfigs: { custom: { baseUrl: 'http://localhost:11434/v1', apiKey: 'audit-only', model: 'audit-only' } } }), set: async () => {} },
        session: { get: async () => ({}) }
      },
      runtime: { onMessage: { addListener(fn) { sandbox.messageHandler = fn; } } }
    }
  };
  vm.createContext(sandbox);
  sandbox.importScripts = file => vm.runInContext(source(file), sandbox, { filename: file });
  vm.runInContext(source('background.js'), sandbox, { filename: 'background.js' });
  return sandbox;
}
const jsonResponse = data => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
(async () => {
  await check('Multiline rich text: successful insertion reported as failure', async () => {
    const { sandbox, document } = contentContext(async () => ({ ok: true, text: 'unused' }));
    const field = { nodeType: 1, tagName: 'DIV', innerText: '', focus() { document.activeElement = this; } };
    const text = 'First line\nSecond line';
    const accepted = await sandbox.audit.insertViaExecCommand(field, text);
    assert.equal(field.innerText, text);
    assert.equal(accepted, false);
    return { actualTextMatches: true, writeReportedSuccess: accepted };
  });
  await check('In-flight translation overwrites newer user input', async () => {
    const pending = deferred();
    const { sandbox, Textarea } = contentContext(() => pending.promise);
    const field = new Textarea('Original source');
    const task = sandbox.audit.translate(field);
    field.value = 'User edited this while waiting';
    pending.resolve({ ok: true, text: 'Translation of original source' });
    await task;
    assert.equal(field.value, 'Translation of original source');
    return { userEditLost: true, finalText: field.value };
  });
  await check('Truncated model response accepted by translation message handler', async () => {
    let requestBody;
    const sandbox = backgroundContext(async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return jsonResponse({ choices: [{ message: { content: 'Incomplete translation' }, finish_reason: 'length' }] });
    });
    const response = await new Promise(resolve => { sandbox.messageHandler({ type: 'TL_TRANSLATE', text: 'Long source '.repeat(500), direction: 'en2zh' }, { tab: { id: 1 } }, resolve); });
    assert.equal(requestBody.max_tokens, 800);
    assert.equal(response.ok, true);
    assert.equal(response.text, 'Incomplete translation');
    return { requestedOutputLimit: requestBody.max_tokens, truncatedResponseReportedOk: response.ok };
  });
  await check('Valid but incomplete batch JSON skips missing items without fallback', async () => {
    let calls = 0;
    const sandbox = backgroundContext(async () => {
      calls += 1;
      return jsonResponse({ choices: [{ message: { content: JSON.stringify([{ id: '0', text: 'Result A' }]) } }] });
    });
    const response = await sandbox.translateChatBatch([{ id: 'a', text: 'Message A' }, { id: 'b', text: 'Message B' }], 'en');
    assert.equal(response.length, 1);
    assert.equal(calls, 1);
    return { inputItems: 2, outputItems: response.length, apiCalls: calls, missingItemRetried: false };
  });
  await check('Batch parser accepts object text as literal object string', async () => {
    const sandbox = backgroundContext(async () => { throw new Error('Network disabled'); });
    const parsed = sandbox.parseBatchTranslationOutput('[{"id":"0","text":{"unexpected":"value"}}]');
    assert.equal(parsed[0].text, '[object Object]');
    return { acceptedInvalidText: parsed[0].text };
  });
  await check('Empty API address blocks unrelated settings save', async () => {
    const code = source('options.js');
    const permissionFn = code.slice(code.indexOf('async function ensureEndpointPermission('), code.indexOf('function currentProviderPayload('));
    const saveHandler = code.slice(code.indexOf('$("save").addEventListener("click", async () => {'), code.indexOf('\nloadSettings().catch('));
    let saved = false;
    let click;
    const status = { dataset: {}, textContent: '' };
    const sandbox = {
      URL,
      $: id => id === 'save' ? { addEventListener(_event, callback) { click = callback; } } : status,
      activeProvider: 'custom', providerConfigs: { custom: { baseUrl: '' } },
      captureProviderDraft() {},
      chrome: { permissions: { contains: async () => true }, storage: { local: { set: async () => { saved = true; } } } }
    };
    vm.createContext(sandbox);
    vm.runInContext(permissionFn + '\n' + saveHandler, sandbox);
    await click();
    assert.equal(saved, false);
    assert.ok(status.textContent.includes('API'));
    return { settingsSaved: saved, displayedMessage: status.textContent };
  });
  await check('Provider model fetch writes results into provider selected later', async () => {
    const code = source('options.js');
    const fn = code.slice(code.indexOf('async function runProviderAction('), code.indexOf('async function loadSettings('));
    const pending = deferred();
    const started = deferred();
    let rendered;
    const button = { textContent: 'Fetch', disabled: false };
    const sandbox = {
      activeProvider: 'qwen', providerModelCache: {}, $: () => button,
      currentProviderPayload: () => ({ providerId: 'qwen', config: { baseUrl: '' } }),
      ensureEndpointPermission: async () => true,
      sortModelsForTranslation: models => models,
      renderModelOptions: models => { rendered = models; }, openModelOptions() {}, setInlineStatus() {},
      effectiveProviderConfig: () => ({ adapter: 'openai' }),
      chrome: { runtime: { sendMessage: () => { started.resolve(); return pending.promise; } }, storage: { local: { set: async () => {} } } }
    };
    vm.createContext(sandbox);
    vm.runInContext(fn, sandbox);
    const task = sandbox.runProviderAction('models');
    await started.promise;
    sandbox.activeProvider = 'glm';
    pending.resolve({ ok: true, models: ['audit-model-from-first-provider'] });
    await task;
    assert.equal(sandbox.providerModelCache.qwen, undefined);
    assert.equal(sandbox.providerModelCache.glm[0], 'audit-model-from-first-provider');
    assert.equal(rendered[0], 'audit-model-from-first-provider');
    return { fetchedFor: 'first provider', cachedUnder: 'second provider', wrongDropdownUpdated: true };
  });
  await check('Space trigger counter carries across input fields', async () => {
    const pending = deferred();
    const requests = [];
    const { handlers, Textarea } = contentContext(message => { requests.push(message); return pending.promise; });
    const a = new Textarea('Field A');
    const b = new Textarea('Field B');
    const space = field => ({ key: ' ', code: 'Space', target: field, composedPath: () => [field], preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
    handlers.keydown(space(a));
    handlers.keydown(space(a));
    handlers.keydown(space(b));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].text, 'Field B');
    return { spacesInFirstField: 2, spacesInSecondField: 1, translationTriggeredOnSecondField: true };
  });
  console.log(JSON.stringify({ method: 'Local VM mocks; no real network or browser access; extension files unchanged', confirmedCases: results.length, results }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
