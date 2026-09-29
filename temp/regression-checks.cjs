// Regression checks for TransMate core logic. No real network or browser access.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

// 源码覆盖钩子：变异测试要在进程内把某个文件换成"故意改坏"的版本，
// 然后看回归测试会不会变红。默认关闭，正常运行时读的就是磁盘上的文件。
let sourceOverrides = null;
const source = file => {
  if (sourceOverrides && Object.hasOwn(sourceOverrides, file)) return sourceOverrides[file];
  return fs.readFileSync(path.join(root, file), 'utf8');
};
/** 传 null 恢复成读磁盘。只给 temp/mutation-test.cjs 用。 */
function setSourceOverrides(overrides) { sourceOverrides = overrides; }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fakeElement(tag = 'div') {
  return {
    nodeType: 1, tagName: tag.toUpperCase(), isConnected: true, style: {}, dataset: {}, hidden: false,
    children: [], textContent: '', innerText: '', value: '',
    setAttribute() {}, removeAttribute() {}, addEventListener() {}, remove() {},
    append(...items) { this.children.push(...items); }, appendChild(item) { this.children.push(item); return item; },
    focus() {}, select() {}, dispatchEvent() {}, getBoundingClientRect() { return { right: 400, top: 10, height: 30 }; }
  };
}
function contentContext(sendMessage) {
  const handlers = {};
  const nodes = new Map();
  const storageListeners = [];
  let storageGetCount = 0;
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
      if (field.tagName === 'TEXTAREA') field.value = text;
      else field.innerText = text;
      return true;
    }
  };
  class Textarea {
    constructor(value) { this.value = value; this.nodeType = 1; this.tagName = 'TEXTAREA'; this.isConnected = true; this.disabled = false; this.readOnly = false; }
    focus() { document.activeElement = this; } select() {} dispatchEvent() {} setSelectionRange() {}
    getBoundingClientRect() { return { right: 400, top: 10, height: 30 }; }
  }
  const sandbox = {
    chrome: {
      storage: {
        local: { get: (defaults, callback) => { storageGetCount += 1; callback(defaults); } },
        onChanged: { addListener(fn) { storageListeners.push(fn); } }
      },
      runtime: { sendMessage }
    },
    document, window: { focus() {}, innerWidth: 1200, innerHeight: 800, getSelection: () => ({ removeAllRanges() {}, addRange() {}, getRangeAt: () => document.createRange() }), addEventListener() {}, removeEventListener() {} },
    location: { hostname: 'local-audit.invalid' }, navigator: {}, Node: { ELEMENT_NODE: 1 },
    HTMLTextAreaElement: Textarea, HTMLInputElement: class {}, Event: class {}, InputEvent: class {}, ClipboardEvent: class {}, DataTransfer: class { setData() {} },
    setTimeout: fn => { queueMicrotask(fn); return 1; }, clearTimeout() {}, setInterval() { return 1; }, clearInterval() {}, console
  };
  vm.createContext(sandbox);
  const code = source('content.js').replace(/\}\)\(\);\s*$/, 'globalThis.audit = { translate, insertViaExecCommand, readField, normalize };\n})();');
  vm.runInContext(code, sandbox, { filename: 'content.js' });
  return { sandbox, Textarea, document, handlers, nodes, storageListeners, storageGetCount: () => storageGetCount };
}
function backgroundContext(fetchImpl, storageOverrides = {}, sessionOverrides = {}) {
  const sandbox = {
    URLSearchParams, AbortController, setTimeout, clearTimeout, console, fetch: fetchImpl,
    chrome: {
      storage: {
        local: { get: async defaults => ({ ...defaults, provider: 'custom', providerConfigs: { custom: { baseUrl: 'http://localhost:11434/v1', apiKey: 'test-only', model: 'test-only' } }, ...storageOverrides }), set: async () => {} },
        session: {
          get: async keys => {
            const wanted = typeof keys === 'string' ? [keys] : (Array.isArray(keys) ? keys : Object.keys(keys || {}));
            const result = {};
            for (const key of wanted) if (key in sessionOverrides) result[key] = sessionOverrides[key];
            return result;
          },
          set: async () => {}
        }
      }, runtime: { onMessage: { addListener(fn) { sandbox.messageHandler = fn; } } }
    }
  };
  vm.createContext(sandbox);
  sandbox.importScripts = file => vm.runInContext(source(file), sandbox, { filename: file });
  vm.runInContext(source('background.js'), sandbox, { filename: 'background.js' });
  return sandbox;
}
const jsonResponse = data => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
// popup.js 直接操作 DOM 和 chrome.*，这里用最小夹具把它整个跑起来。
// getElementById 按需造元素，所以不用手抄 popup.html 里的 id 列表 ——
// 抄一份的话，改了 html 而忘了改这里，测试就会假绿。
function popupContext(storage = {}, session = {}) {
  const nodes = new Map();
  const writes = [];
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) {
        const element = fakeElement();
        element.id = id;
        element.listeners = {};
        element.addEventListener = (type, fn) => { element.listeners[type] = fn; };
        nodes.set(id, element);
      }
      return nodes.get(id);
    }
  };
  const sandbox = {
    console, Intl, Date, Set, Map, Boolean, String, Number, Object, Array, URL,
    document,
    chrome: {
      tabs: { query: async () => [{ id: 1, url: 'https://web.whatsapp.com/' }] },
      storage: {
        local: {
          get: async defaults => ({ ...defaults, ...storage }),
          set: async values => { writes.push(values); }
        },
        session: {
          get: async keys => {
            const wanted = typeof keys === 'string' ? [keys] : (Array.isArray(keys) ? keys : Object.keys(keys || {}));
            const result = {};
            for (const key of wanted) if (key in session) result[key] = session[key];
            return result;
          }
        },
        onChanged: { addListener() {} }
      },
      runtime: { openOptionsPage() {} }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(source('providers.js'), sandbox, { filename: 'providers.js' });
  // 去掉末尾自动执行的 load()，改由测试自己驱动，
  // 避免"文件一加载就跑一次渲染"污染断言。
  const code = source('popup.js').replace(
    /\bload\(\);\s*$/,
    'globalThis.popupApi = { render, load };\n'
  );
  assert.ok(code.includes('globalThis.popupApi'), 'popup.js 末尾的 load() 没被替换掉，测试夹具需要更新');
  vm.runInContext(code, sandbox, { filename: 'popup.js' });
  // 只暴露 render / load 这两个对外行为。
  // 刻意不暴露内部函数名 —— 测行为不测结构，这样重构时测试不用跟着改。
  return { sandbox, api: sandbox.popupApi, element: id => document.getElementById(id), writes };
}
function verifyApi() {
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(source('verify.js'), sandbox, { filename: 'verify.js' });
  return sandbox.TLP_VERIFY;
}
// timezone.js 是个巨大的内容脚本，没法整体跑。这里只把"客户沟通时间建议"那一段
// 纯计算代码切出来单独执行，DOM 部分用最小夹具代替。
function workHintModule(config) {
  const code = source('timezone.js');
  const start = code.indexOf('\n  // 客户沟通时间建议\n');
  const end = code.indexOf('function createRoot()', start);
  assert.ok(start > -1 && end > start, 'timezone.js 里应存在客户沟通时间建议模块');
  const sandbox = {
    console, activeConfig: config, Intl, Date, Math, Number, String, Object, Array, Map, Set
  };
  vm.createContext(sandbox);
  vm.runInContext(
    code.slice(start, end)
      + '\nglobalThis.workApi = { WEEKDAY_INDEX, workHourRange, minutesUntilWorkWindow, formatWorkGap, describeContactWorkHours, renderWorkHint };',
    sandbox,
    { filename: 'timezone-work.js' }
  );
  return sandbox;
}
// timezone.js 里"客户在线状态指示灯"那一段同样是纯逻辑，单独切出来执行。
function presenceModule(config) {
  const code = source('timezone.js');
  const start = code.indexOf('\n  // 客户在线状态指示灯\n');
  const end = code.indexOf('\n  // 客户沟通时间建议\n', start);
  assert.ok(start > -1 && end > start, 'timezone.js 里应存在客户在线状态指示灯模块');
  const sandbox = {
    console, activeConfig: config, activeHeader: null, ROOT_ID: 'wat-region-time-root',
    cleanText: value => String(value || '').replace(/\s+/g, ' ').trim(),
    document: { createTreeWalker: () => ({ nextNode: () => false }) },
    NodeFilter: { SHOW_TEXT: 4 },
    Date, Math, Number, String, Object, Array, Set, RegExp
  };
  vm.createContext(sandbox);
  vm.runInContext(
    code.slice(start, end)
      + '\nglobalThis.presenceApi = { isOnlinePresence, getPresenceElement, detectPresence, renderPresence };',
    sandbox,
    { filename: 'timezone-presence.js' }
  );
  return sandbox;
}
// timezone.js 的"文字系统识别"整段都是纯函数（只依赖正则和入参，不碰 DOM），
// 可以整段切出来单独跑。重构前它是 42 个分支的 if 链却一条测试都没有 ——
// 正是"没人测"才让它一路长到 42。现在这段有了保护，改动它才敢放心。
function scriptDetectModule() {
  const code = source('timezone.js');
  const start = code.indexOf('\n  // 文字系统识别');
  const end = code.indexOf('  function detectSingleLanguage(', start);
  assert.ok(start > -1 && end > start, 'timezone.js 里应存在文字系统识别模块');
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(
    code.slice(start, end) + '\nglobalThis.scriptApi = { detectByScript, SCRIPT_LANGUAGES };',
    sandbox,
    { filename: 'timezone-script.js' }
  );
  return sandbox.scriptApi;
}
// resolveLanguageState 是纯函数（不碰存储、不碰 DOM），只依赖一张手动语言表，
// 整段切出来就能测。其中"要不要写缓存"的判据是最容易改错的地方：
// 放宽一点，页面上每次一点风吹草动都会写一次存储。
function languageStateModule(manualLanguages = [['ru', '俄语', 'Russian']]) {
  const src = source('timezone.js');
  const start = src.indexOf('  function makeManualLanguage(');
  const end = src.indexOf('  function detectLanguageHint(', start);
  assert.ok(start > -1 && end > start, 'timezone.js 里应存在 makeManualLanguage / resolveLanguageState');
  const sandbox = {
    console,
    MANUAL_LANGUAGE_BY_CODE: new Map(
      manualLanguages.map(([code, name, promptName]) => [code, { code, name, promptName }])
    )
  };
  vm.createContext(sandbox);
  vm.runInContext(
    src.slice(start, end) + '\nglobalThis.languageApi = { resolveLanguageState, makeManualLanguage };',
    sandbox,
    { filename: 'timezone-language.js' }
  );
  return sandbox.languageApi;
}
function fakePresenceHeader(presenceText) {
  if (!presenceText) return { querySelector: () => null };
  const subtitle = {
    textContent: presenceText,
    closest: () => null,
    getAttribute: name => (name === 'title' ? presenceText : null)
  };
  return { querySelector: selector => (selector.includes('subtitle') ? subtitle : null) };
}
function fakePresenceRoot() {
  const marker = {
    hidden: true, title: '', dataset: {}, offsetWidth: 0,
    removeAttribute(name) { if (name === 'title') this.title = ''; }
  };
  const detail = { textContent: '', dataset: {} };
  const toggle = { checked: false };
  return {
    marker,
    detail,
    toggle,
    root: {
      dataset: {},
      querySelector: selector => (selector === '.wat-presence' ? marker
        : selector === '.wat-presence-hint' ? detail
          : selector === '.wat-presence-toggle' ? toggle
            : null)
    }
  };
}

// vm 里造出来的数组/对象原型与宿主机不同，deepStrictEqual 会因为原型不一致而失败。
// 统一走一次 JSON 往返，拿到宿主机的普通对象再断言。
const plain = value => JSON.parse(JSON.stringify(value));
function fakeWorkRoot() {
  const marker = { hidden: false, title: '', removeAttribute(name) { if (name === 'title') this.title = ''; } };
  const detail = { textContent: '', dataset: {} };
  return {
    marker,
    detail,
    root: { dataset: {}, querySelector: sel => (sel === '.wat-work' ? marker : sel === '.wat-work-hint' ? detail : null) }
  };
}
async function run() {
  const passed = [];
  async function test(name, fn) { await fn(); passed.push(name); }

  await test('multiline rich-text insertion is recognized', async () => {
    const { sandbox, document } = contentContext(async () => ({ ok: true, text: 'unused' }));
    const field = fakeElement('div'); field.focus = () => { document.activeElement = field; };
    const text = 'First line\nSecond line';
    assert.equal(await sandbox.audit.insertViaExecCommand(field, text), true);
  });

  await test('new user edits are not overwritten by stale translation', async () => {
    const pending = deferred();
    const { sandbox, Textarea } = contentContext(() => pending.promise);
    const field = new Textarea('Original source');
    const task = sandbox.audit.translate(field);
    field.value = 'User edited this while waiting';
    pending.resolve({ ok: true, text: 'Translation of original source', targetLanguage: 'en' });
    await task;
    assert.equal(field.value, 'User edited this while waiting');
  });

  await test('truncated provider response is rejected', async () => {
    const sandbox = backgroundContext(async () => jsonResponse({ choices: [{ message: { content: 'Incomplete' }, finish_reason: 'length' }] }));
    const response = await new Promise(resolve => { sandbox.messageHandler({ type: 'TL_TRANSLATE', text: 'Long source '.repeat(500), direction: 'en2zh' }, { tab: { id: 1 } }, resolve); });
    assert.equal(response.ok, false);
    assert.match(response.error, /长度上限/);
  });

  await test('incomplete batch response falls back to all individual items', async () => {
    let calls = 0;
    const sandbox = backgroundContext(async () => {
      calls += 1;
      const content = calls === 1 ? JSON.stringify([{ id: '0', text: 'Result A' }]) : `Fallback ${calls}`;
      return jsonResponse({ choices: [{ message: { content }, finish_reason: 'stop' }] });
    });
    const response = await sandbox.translateChatBatch([{ id: 'a', text: 'Message A' }, { id: 'b', text: 'Message B' }], 'en');
    assert.equal(response.length, 2);
    assert.equal(calls, 3);
  });

  await test('invalid batch item text type is rejected', async () => {
    const sandbox = backgroundContext(async () => { throw new Error('Network disabled'); });
    assert.throws(() => sandbox.parseBatchTranslationOutput('[{"id":"0","text":{"unexpected":"value"}}]'), /无效项目/);
  });

  await test('DeepL translation remains available without polish metadata', async () => {
    const deeplConfig = { provider: 'deepl', providerConfigs: { deepl: { baseUrl: 'https://api-free.deepl.com/v2', apiKey: 'test-only' } } };
    const sandbox = backgroundContext(async () => jsonResponse({ translations: [{ text: 'Hello' }] }), deeplConfig);
    const translated = await new Promise(resolve => { sandbox.messageHandler({ type: 'TL_TRANSLATE', text: '你好', direction: 'zh2en' }, { tab: { id: 1 } }, resolve); });
    assert.equal(translated.ok, true);
    assert.equal(translated.text, 'Hello');
    assert.equal('canPolish' in translated, false);
  });

  await test('OpenAI reasoning model uses completion budget without temperature', async () => {
    let body;
    const config = { provider: 'openai', providerConfigs: { openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'test-only', model: 'gpt-5-mini' } } };
    const sandbox = backgroundContext(async (_url, options) => {
      body = JSON.parse(options.body);
      return jsonResponse({ choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }] });
    }, config);
    const response = await new Promise(resolve => { sandbox.messageHandler({ type: 'TL_TRANSLATE', text: '你好', direction: 'zh2en' }, { tab: { id: 1 } }, resolve); });
    assert.equal(response.ok, true);
    assert.equal(body.max_completion_tokens, 2048);
    assert.equal('max_tokens' in body, false);
    assert.equal('temperature' in body, false);
  });

  await test('DeepSeek uses the current model id and disables thinking mode', async () => {
    let body;
    const config = { provider: 'deepseek', providerConfigs: { deepseek: { baseUrl: 'https://api.deepseek.com', apiKey: 'test-only' } } };
    const sandbox = backgroundContext(async (_url, options) => {
      body = JSON.parse(options.body);
      return jsonResponse({ choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }] });
    }, config);
    const response = await new Promise(resolve => { sandbox.messageHandler({ type: 'TL_TRANSLATE', text: '你好', direction: 'zh2en' }, { tab: { id: 1 } }, resolve); });
    assert.equal(response.ok, true);
    // deepseek-chat / deepseek-reasoner 已于 2026-07-24 退役，必须用 deepseek-flash。
    assert.equal(body.model, 'deepseek-flash');
    // V4 默认开启思考模式，翻译会被思维链拖慢并挤占 max_tokens。
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.max_tokens, 2048);
    assert.equal('max_completion_tokens' in body, false);
  });

  await test('GLM preset tracks the free model and leaks no extra fields', async () => {
    let body;
    const config = { provider: 'glm', providerConfigs: { glm: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'test-only' } } };
    const sandbox = backgroundContext(async (_url, options) => {
      body = JSON.parse(options.body);
      return jsonResponse({ choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }] });
    }, config);
    const response = await new Promise(resolve => { sandbox.messageHandler({ type: 'TL_TRANSLATE', text: '你好', direction: 'zh2en' }, { tab: { id: 1 } }, resolve); });
    assert.equal(response.ok, true);
    assert.equal(body.model, 'glm-4.7-flash');
    // extraBody 只属于 DeepSeek，不能外溢到其他服务，否则会被判 400。
    assert.equal('thinking' in body, false);
    assert.notEqual(body.temperature, undefined);
  });

  await test('free GLM preset is offered and uses the free model', async () => {
    let body;
    const config = { provider: 'glmfree', providerConfigs: { glmfree: { apiKey: 'test-only' } } };
    const sandbox = backgroundContext(async (_url, options) => {
      body = JSON.parse(options.body);
      return jsonResponse({ choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }] });
    }, config);
    // 设置页的下拉列表直接显示 label，所以"免费"必须出现在 label 里，用户才看得见。
    assert.match(sandbox.TLP_PROVIDER_PRESETS.glmfree.label, /免费/);
    // 免费档要能在只填 API Key 的情况下工作，不依赖用户再填地址。
    assert.equal(sandbox.TLP_PROVIDER_PRESETS.glmfree.baseUrl, 'https://open.bigmodel.cn/api/paas/v4');
    const response = await new Promise(resolve => { sandbox.messageHandler({ type: 'TL_TRANSLATE', text: '你好', direction: 'zh2en' }, { tab: { id: 1 } }, resolve); });
    assert.equal(response.ok, true);
    assert.equal(body.model, 'glm-4.7-flash');
    assert.equal('thinking' in body, false);
  });

  await test('Azure works without a model name', async () => {
    let body;
    const azureUrl = 'https://demo.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21';
    const config = { provider: 'azure', providerConfigs: { azure: { baseUrl: azureUrl, apiKey: 'test-only' } } };
    const sandbox = backgroundContext(async (_url, options) => {
      body = JSON.parse(options.body);
      return jsonResponse({ choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }] });
    }, config);
    const response = await new Promise(resolve => { sandbox.messageHandler({ type: 'TL_TRANSLATE', text: '你好', direction: 'zh2en' }, { tab: { id: 1 } }, resolve); });
    // 模型由地址里的 /deployments/<名字>/ 决定，请求体不发 model，所以不能强制要求填模型名。
    assert.equal(response.ok, true, response.error);
    assert.equal('model' in body, false);
    assert.equal(body.max_tokens, 2048);
    assert.notEqual(body.temperature, undefined);
  });

  await test('Azure deployment of a GPT-5 model uses the completion budget', async () => {
    let body;
    const azureUrl = 'https://demo.openai.azure.com/openai/deployments/gpt-5-mini/chat/completions?api-version=2025-01-01';
    const config = { provider: 'azure', providerConfigs: { azure: { baseUrl: azureUrl, apiKey: 'test-only' } } };
    const sandbox = backgroundContext(async (_url, options) => {
      body = JSON.parse(options.body);
      return jsonResponse({ choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }] });
    }, config);
    const response = await new Promise(resolve => { sandbox.messageHandler({ type: 'TL_TRANSLATE', text: '你好', direction: 'zh2en' }, { tab: { id: 1 } }, resolve); });
    // 模型名藏在地址里，只认 model 字段会把 GPT-5 当成普通模型，发 max_tokens 会 400。
    assert.equal(response.ok, true, response.error);
    assert.equal(body.max_completion_tokens, 2048);
    assert.equal('max_tokens' in body, false);
    assert.equal('temperature' in body, false);
  });

  await test('a provider-prefixed reasoning model still gets the completion budget', async () => {
    let body;
    // OpenRouter、硅基流动等会在模型名前加厂商前缀。不剥掉前缀，
    // openai/gpt-5 就不匹配 ^gpt-5，会被当成普通模型发出 max_tokens + temperature，直接 400。
    const config = { provider: 'openrouter', providerConfigs: { openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'test-only', model: 'openai/gpt-5' } } };
    const sandbox = backgroundContext(async (_url, options) => {
      body = JSON.parse(options.body);
      return jsonResponse({ choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }] });
    }, config);
    const response = await new Promise(resolve => { sandbox.messageHandler({ type: 'TL_TRANSLATE', text: '你好', direction: 'zh2en' }, { tab: { id: 1 } }, resolve); });
    assert.equal(response.ok, true, response.error);
    assert.equal(body.model, 'openai/gpt-5');
    assert.equal(body.max_completion_tokens, 2048);
    assert.equal('max_tokens' in body, false);
    assert.equal('temperature' in body, false);
  });

  await test('a non-reasoning OpenAI model keeps its temperature', async () => {
    let body;
    // 只有推理模型不接受 temperature。给 gpt-4o 这类模型漏掉 temperature，
    // 服务端会退回默认温度（通常 1.0），同一句话每次翻译结果都不一样。
    const config = { provider: 'openai', providerConfigs: { openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'test-only', model: 'gpt-4o' } } };
    const sandbox = backgroundContext(async (_url, options) => {
      body = JSON.parse(options.body);
      return jsonResponse({ choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }] });
    }, config);
    const response = await new Promise(resolve => { sandbox.messageHandler({ type: 'TL_TRANSLATE', text: '你好', direction: 'zh2en' }, { tab: { id: 1 } }, resolve); });
    assert.equal(response.ok, true, response.error);
    assert.equal(body.temperature, 0.1);
    assert.equal(body.max_completion_tokens, 2048);
    assert.equal('max_tokens' in body, false);
  });

  await test('a provider error page is trimmed before it reaches the toast', async () => {
    // 网关或 Cloudflare 出错时回一整页 HTML，原样抛出会变成几千字的 toast，
    // 把真正的信息淹没，弹窗也会被撑破。
    const page = `<html><head><title>502 Bad Gateway</title></head><body>${'<div>upstream unreachable</div>'.repeat(400)}</body></html>`;
    const sandbox = backgroundContext(async () => ({ ok: false, status: 502, text: async () => page }));
    const response = await new Promise(resolve => { sandbox.messageHandler({ type: 'TL_TRANSLATE', text: '你好', direction: 'zh2en' }, { tab: { id: 1 } }, resolve); });
    assert.equal(response.ok, false);
    assert.ok(response.error.length < 500, `错误信息应被截断，实际 ${response.error.length} 字符`);
    assert.match(response.error, /已截断/);
    assert.match(response.error, /502/);
  });

  await test('content script only reacts to the settings it actually uses', async () => {
    const { storageListeners, storageGetCount } = contentContext(async () => ({ ok: true, text: 'x' }));
    assert.equal(storageListeners.length, 1, 'content script 应注册存储监听');
    const before = storageGetCount();
    storageListeners[0]({ provider: { newValue: 'openai' } }, 'local');
    storageListeners[0]({ apiKey: { newValue: 'sk-test' } }, 'local');
    assert.equal(storageGetCount(), before, '无关键变化不应重读设置');
    storageListeners[0]({ triggerCount: { newValue: 4 } }, 'local');
    assert.equal(storageGetCount(), before + 1, '相关键变化应重读设置');
    storageListeners[0]({ triggerCount: { newValue: 5 } }, 'session');
    assert.equal(storageGetCount(), before + 1, 'session 区变化应忽略');
  });

  await test('provider action button recovers when the provider changes mid-request', async () => {
    // 恢复按钮时若把 providerGeneration 也算进条件，用户在"测试连接"飞行途中
    // 切换服务商，按钮就永远停在禁用状态、文字停在"测试中…"。
    const optionsCode = source('options.js');
    assert.match(optionsCode, /if \(actionId === providerActionSequence\[kind\]\) \{\s*button\.textContent = original;/, '按钮恢复只应依赖 actionId');
    assert.doesNotMatch(optionsCode, /if \(requestGeneration === providerGeneration && actionId === providerActionSequence\[kind\]\) \{\s*button\.disabled/, '恢复按钮时不应再看 providerGeneration');
  });

  await test('chat translation waits for the shortcut and never starts on its own', async () => {
    const timezoneCode = source('timezone.js');
    // 开关只是"允许快捷键"：默认打开表示快捷键可用，但打开开关本身不翻译。
    assert.match(timezoneCode, /watChatTranslationEnabled:\s*true/, 'timezone 默认应允许快捷键');
    assert.match(source('options.js'), /watChatTranslationEnabled:\s*true/, '设置页默认值也应为允许');
    assert.match(source('popup.js'), /watChatTranslationEnabled:\s*true/, '弹窗默认值应与设置页一致');
    assert.match(source('options.html'), /允许快捷键/, '设置页开关文案应为"允许快捷键"');
    // 不能有任何自动激活的痕迹，否则开关一打开就自己翻译了。
    assert.doesNotMatch(timezoneCode, /chatTranslationAutoActivated/, '不应再自动激活翻译会话');
    // 只有已经处于翻译会话中，DOM 变化才会继续翻译；会话只能由快捷键开启。
    assert.match(timezoneCode, /} else if \(chatTranslationSessionActive\) \{\s*scheduleChatTranslation\(activeConfig, 0\);/, '会话外不应调度翻译');
    assert.match(timezoneCode, /if \(chatTranslationSessionActive\) \{\s*deactivateChatTranslation\(\);\s*return;\s*\}/, '再按一次快捷键应关闭翻译');
  });

  await test('space trigger does not carry between fields', async () => {
    const requests = [];
    const { handlers, Textarea } = contentContext(message => { requests.push(message); return new Promise(() => {}); });
    const a = new Textarea('Field A'); const b = new Textarea('Field B');
    const space = field => ({ key: ' ', code: 'Space', target: field, composedPath: () => [field], preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
    handlers.keydown(space(a)); handlers.keydown(space(a)); handlers.keydown(space(b));
    assert.equal(requests.length, 0);
  });

  const freeGoogle = { provider: 'googlefree', providerConfigs: {} };
  const googleOn = 'translate.googleapis.com';
  const knownHost = { googleFreeHost: googleOn };
  const googlePayload = text => JSON.stringify([[[text, 'source', null, null, 10]], null, 'en']);

  await test('free Google provider translates without an API key', async () => {
    const calls = [];
    const sandbox = backgroundContext(async url => {
      calls.push(url);
      return { ok: true, status: 200, text: async () => googlePayload('你好世界') };
    }, freeGoogle, knownHost);
    const response = await new Promise(resolve => { sandbox.messageHandler({ type: 'TL_TRANSLATE', text: 'Hello world', direction: 'en2zh' }, { tab: { id: 1 } }, resolve); });
    assert.equal(response.ok, true);
    assert.equal(response.text, '你好世界');
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^https:\/\/translate\.googleapis\.com\/translate_a\/single\?/);
    assert.match(calls[0], /tl=zh-CN/);
  });

  await test('free Google provider splits long text into chunks', async () => {
    const queries = [];
    const sandbox = backgroundContext(async url => {
      queries.push(decodeURIComponent(new URL(url).searchParams.get('q')));
      return { ok: true, status: 200, text: async () => googlePayload('译文') };
    }, freeGoogle, knownHost);
    const response = await new Promise(resolve => { sandbox.messageHandler({ type: 'TL_TRANSLATE', text: 'a'.repeat(3000), direction: 'zh2en' }, { tab: { id: 1 } }, resolve); });
    assert.equal(response.ok, true);
    assert.equal(queries.length, 3);
    assert.equal(queries.join('').length, 3000);
    assert.equal(queries.every(q => q.length <= 1200), true);
  });

  await test('free Google provider reports a clear error when no host is reachable', async () => {
    const sandbox = backgroundContext(async () => { throw new TypeError('Failed to fetch'); }, freeGoogle);
    const response = await new Promise(resolve => { sandbox.messageHandler({ type: 'TL_TRANSLATE', text: 'Hello', direction: 'en2zh' }, { tab: { id: 1 } }, resolve); });
    assert.equal(response.ok, false);
    assert.match(response.error, /代理节点|访问不到/);
  });

  await test('free Google provider probes the remaining hosts in parallel on 429', async () => {
    const hosts = [];
    const sandbox = backgroundContext(async url => {
      const host = new URL(url).host;
      hosts.push(host);
      if (host === 'translate.googleapis.com') return { ok: false, status: 429, text: async () => 'Too Many Requests' };
      if (host === 'clients5.google.com') return { ok: false, status: 503, text: async () => 'unavailable' };
      return { ok: true, status: 200, text: async () => googlePayload('备用成功') };
    }, freeGoogle, knownHost);
    const response = await new Promise(resolve => { sandbox.messageHandler({ type: 'TL_TRANSLATE', text: 'Hello', direction: 'en2zh' }, { tab: { id: 1 } }, resolve); });
    assert.equal(response.ok, true);
    assert.equal(response.text, '备用成功');
    assert.equal(hosts[0], 'translate.googleapis.com');
    assert.equal(hosts.slice(1).sort().join(','), 'clients5.google.com,translate.google.com');
  });

  await test('free Google provider remembers the working host after a fallback', async () => {
    const hosts = [];
    const sandbox = backgroundContext(async url => {
      const host = new URL(url).host;
      hosts.push(host);
      if (host === 'translate.google.com') return { ok: true, status: 200, text: async () => googlePayload('OK') };
      return { ok: false, status: 429, text: async () => 'busy' };
    }, freeGoogle);
    const send = text => new Promise(resolve => { sandbox.messageHandler({ type: 'TL_TRANSLATE', text, direction: 'en2zh' }, { tab: { id: 1 } }, resolve); });
    await send('first text');
    const seen = hosts.length;
    await send('second text');
    assert.equal(hosts[seen], 'translate.google.com');
    assert.equal(hosts.length - seen, 1, 'second call should go straight to the remembered host');
  });

  await test('repeating the same field translation is served from cache', async () => {
    let calls = 0;
    const sandbox = backgroundContext(async () => {
      calls += 1;
      return { ok: true, status: 200, text: async () => googlePayload('你好世界') };
    }, freeGoogle, knownHost);
    const send = () => new Promise(resolve => { sandbox.messageHandler({ type: 'TL_TRANSLATE', text: 'Hello world', direction: 'en2zh' }, { tab: { id: 1 } }, resolve); });
    const first = await send();
    const second = await send();
    assert.equal(calls, 1);
    assert.equal(second.text, '你好世界');
    assert.equal(second.cached, true);
    assert.equal('cached' in first, false);
  });

  await test('AI providers are never served from cache', async () => {
    let calls = 0;
    const config = { provider: 'openai', providerConfigs: { openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'test-only', model: 'gpt-5-mini' } } };
    const sandbox = backgroundContext(async () => {
      calls += 1;
      return jsonResponse({ choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }] });
    }, config);
    const send = () => new Promise(resolve => { sandbox.messageHandler({ type: 'TL_TRANSLATE', text: '你好', direction: 'zh2en' }, { tab: { id: 1 } }, resolve); });
    await send();
    await send();
    assert.equal(calls, 2);
  });

  await test('free Google provider rejects a consent page instead of returning it as a translation', async () => {
    const sandbox = backgroundContext(async () => ({ ok: true, status: 200, text: async () => '<html><body>Before you continue</body></html>' }), freeGoogle);
    const response = await new Promise(resolve => { sandbox.messageHandler({ type: 'TL_TRANSLATE', text: 'Hello', direction: 'en2zh' }, { tab: { id: 1 } }, resolve); });
    assert.equal(response.ok, false);
    assert.match(response.error, /验证页面/);
  });

  await test('free Google provider batch keeps the caller ids', async () => {
    let index = 0;
    const sandbox = backgroundContext(async () => {
      index += 1;
      return { ok: true, status: 200, text: async () => googlePayload(`译文${index}`) };
    }, freeGoogle, knownHost);
    const items = await sandbox.translateChatBatch([{ id: 'a', text: 'One' }, { id: 'b', text: 'Two' }], 'zh-CN');
    assert.equal(items.map(item => item.id).join(','), 'a,b');
    assert.equal(items.every(item => item.text), true);
  });

  await test('free Google provider still works when the address field is cleared', async () => {
    const hosts = [];
    const sandbox = backgroundContext(async url => {
      hosts.push(new URL(url).host);
      return { ok: true, status: 200, text: async () => googlePayload('OK') };
    }, { provider: 'googlefree', providerConfigs: { googlefree: { baseUrl: '' } } }, knownHost);
    const response = await new Promise(resolve => { sandbox.messageHandler({ type: 'TL_TRANSLATE', text: 'Hello', direction: 'en2zh' }, { tab: { id: 1 } }, resolve); });
    assert.equal(response.ok, true);
    assert.equal(hosts[0], 'translate.googleapis.com');
  });

  await test('free Google provider encodes spaces as %20 rather than +', async () => {
    let called = '';
    const sandbox = backgroundContext(async url => {
      called = url;
      return { ok: true, status: 200, text: async () => googlePayload('x') };
    }, freeGoogle, knownHost);
    await new Promise(resolve => { sandbox.messageHandler({ type: 'TL_TRANSLATE', text: 'hello world', direction: 'en2zh' }, { tab: { id: 1 } }, resolve); });
    assert.match(called, /q=hello%20world/);
    assert.equal(called.includes('+'), false);
  });

  await test('fresh installs default to the free Google provider', async () => {
    let called = '';
    const sandbox = backgroundContext(async url => {
      called = url;
      return { ok: true, status: 200, text: async () => googlePayload('你好') };
    }, { provider: '', apiKey: '' });
    const response = await new Promise(resolve => { sandbox.messageHandler({ type: 'TL_TRANSLATE', text: 'Hello', direction: 'en2zh' }, { tab: { id: 1 } }, resolve); });
    assert.equal(response.ok, true);
    assert.match(called, /translate\.googleapis\.com/);
  });

  await test('apiKey-only legacy installs keep Gemini instead of switching to the free tier', async () => {
    let called = '';
    const sandbox = backgroundContext(async url => {
      called = url;
      return jsonResponse({ candidates: [{ content: { parts: [{ text: '你好' }] }, finishReason: 'STOP' }] });
    }, { provider: '', apiKey: 'legacy-key', model: 'gemini-3.5-flash-lite' });
    const response = await new Promise(resolve => { sandbox.messageHandler({ type: 'TL_TRANSLATE', text: 'Hello', direction: 'en2zh' }, { tab: { id: 1 } }, resolve); });
    assert.equal(response.ok, true);
    assert.match(called, /generativelanguage\.googleapis\.com/);
  });

  await test('hard facts survive translation without false alarms', async () => {
    const V = verifyApi();

    // 数字必须按规范千分位分组抽取。写成 \d[\d,\s]* 会把 "HR-2400, 20GP"
    // 读成一个数 240020，之后所有比对全是误报。
    assert.deepEqual(plain([...V.extractHardFacts('HR-2400, 20GP').numbers]), ['2400', '20']);
    // 千分位、小数补零、前导零都算同一个数。
    assert.equal(V.normalizeNumber('1,200'), '1200');
    assert.equal(V.normalizeNumber('12.50'), '12.5');
    assert.equal(V.normalizeNumber('01200'), '1200');
    assert.deepEqual(plain(V.verifyTranslation('Total 1,200 pcs, USD 12.50', '共 1200 件，12.5 美元')), []);

    // HC 与 HQ 是同一规格，40 尺高柜也归一，不能因为换了写法就报警。
    assert.deepEqual(plain([...V.extractHardFacts('40HC').containers]), ['40HQ']);
    assert.deepEqual(plain([...V.extractHardFacts('40 尺高柜').containers]), ['40HQ']);
    assert.deepEqual(plain(V.verifyTranslation('40HC', '40HQ')), []);
    // 归一之后仍然要能发现真的被改写了：40HQ 写成 40GP 是事故。
    const swapped = V.verifyTranslation('40HQ', '40GP');
    assert.ok(plain(swapped).some(item => item.kind === 'container' && item.token === '40HQ'));

    // 货币：RMB 归到 CNY，中文"美元"与代码 USD 等价。
    assert.deepEqual(plain([...V.extractHardFacts('报价 RMB 5000').currencies]), ['CNY']);
    assert.deepEqual(plain([...V.extractHardFacts('12.50 美元').currencies]), ['USD']);

    // 符号有多义，只要两边有一个共同候选就算一致：$ 与 USD 不该报不一致。
    // 两个方向都要测：符号在原文侧时会展开成 7 个候选，必须"任一命中"而不是"全部命中"。
    assert.deepEqual(plain(V.verifyTranslation('USD 100', '$100')), []);
    assert.deepEqual(plain(V.verifyTranslation('$100', 'USD 100')), []);
    // 但两边彻底对不上时（USD -> EUR）必须报，这是最容易漏掉的一条。
    const currencySwap = V.verifyTranslation('USD 100', 'EUR 100');
    assert.deepEqual(plain(currencySwap).map(item => item.kind), ['currency']);
    // 译文里货币单位整个消失，也要报。
    const currencyLost = V.verifyTranslation('USD 100', '100');
    assert.deepEqual(plain(currencyLost).map(item => item.kind), ['currency']);
    // 原文没有货币单位时不该凭空报一条。
    assert.deepEqual(plain(V.verifyTranslation('100 pcs', '100 件')), []);

    // USD12 是"金额 + 数字"，不是型号；真实型号要认得出来。
    assert.deepEqual(plain([...V.extractHardFacts('USD12').models]), []);
    assert.deepEqual(plain([...V.extractHardFacts('Model HR-2400 qty 500').models]), ['HR2400']);

    // 该报的要报：术语被改写、型号丢失。
    const incoterm = V.verifyTranslation('CIF Rotterdam USD 12.5', 'CFR 鹿特丹 12.5 美元');
    assert.deepEqual(plain(incoterm).map(item => item.kind).sort(), ['incoterm', 'incoterm']);
    const dropped = V.verifyTranslation('Model HR-2400 qty 500', '型号 数量 500');
    assert.ok(dropped.some(item => item.kind === 'model' && item.token === 'HR2400'));

    // 原文是中文数字时无法与阿拉伯数字一一对应，只报"丢失"，不报"多出"。
    assert.deepEqual(plain(V.verifyTranslation('三千套', '3000 sets')), []);

    // 误报修复 ①：模型把阿拉伯数字正当地写成中文数字，不能报"数字丢失"。
    // 实测案例："6-layer" → "六层" 曾误报"原文的数字 6 没有出现在译文里"。
    assert.equal(V.parseChineseNumber('六'), 6);
    assert.equal(V.parseChineseNumber('十五'), 15);
    assert.equal(V.parseChineseNumber('二十三'), 23);
    assert.equal(V.parseChineseNumber('三万'), 30000);
    assert.equal(V.parseChineseNumber('一百零五'), 105);
    assert.deepEqual(plain([...V.chineseNumeralsAsDigits('六层')]), ['6']);
    assert.deepEqual(plain(V.verifyTranslation(
      'HC-B3015-63.3m x 1.5m 6-layer 3-ton pallet rack (1).PDF',
      'HC-B3015-63.3米×1.5米六层3吨板架(1).PDF'
    )), []);
    assert.deepEqual(plain(V.verifyTranslation('500 pcs', '五百件')), []);
    // 但数字真的丢了还是要报。
    assert.ok(plain(V.verifyTranslation('500 pcs', '件')).some(item => item.kind === 'number'));
    // "一共"里的"一"不能凭空造出一个数字来。
    assert.equal(plain(V.verifyTranslation('500 pcs', '一共 500 件')).length, 0);

    // 误报修复 ②：模型把 Incoterms 意译成中文（EXW → 出厂价），不能报"术语丢失"。
    // 实测案例：Цена EXW $6,120 → 出厂价 $6,120 曾误报"贸易术语 EXW 在译文里丢失或被改写"。
    assert.deepEqual(plain(V.verifyTranslation('Цена EXW $6,120', '出厂价 $6,120')), []);
    assert.deepEqual(plain(V.verifyTranslation('FOB Shanghai USD 100', '上海离岸价 100 美元')), []);
    assert.deepEqual(plain(V.verifyTranslation('出厂价 6120 美元', 'EXW USD 6120')), []);
    // 意译成"另一个术语"仍然要报。
    assert.ok(plain(V.verifyTranslation('Цена EXW $6,120', '价格 6,120 美元')).some(item => item.kind === 'incoterm'));
    assert.ok(plain(V.verifyTranslation('CIF Rotterdam USD 12.5', '到岸价 鹿特丹 12.5 美元')).length === 0);
    assert.ok(plain(V.verifyTranslation('FOB Shanghai USD 100', 'CIF 上海 100 美元')).some(item => item.kind === 'incoterm'));

    // 校验绝不能拖垮翻译本身。
    assert.deepEqual(plain(V.verifyTranslation('', 'x')), []);
    assert.deepEqual(V.verifyTranslation('FOB 1 2 3 4 5 6 7 8 9', 'nothing').length <= 6, true);

    // 超过 6 条要截断，而截断是"按顺序砍尾巴"，所以顺序本身是有意义的：
    // 数字与型号最容易出事故，必须排在货币前面，否则一屏 6 条里可能看不到它们。
    // 注意 HR-2400 里的 2400 会被同时算作"数字"和"型号"的一部分 —— 这是刻意的：
    // 数字与型号是两套独立检查，型号变了要报型号，数字变了要报数字，互不代替。
    const kinds = plain(V.verifyTranslation('Model HR-2400 qty 500 USD', 'x')).map(item => item.kind);
    assert.equal(kinds[0], 'number', '数字要排在最前面');
    assert.equal(kinds[kinds.length - 1], 'currency', '货币排在最后');
    assert.ok(kinds.includes('model'), '型号被整段丢掉时也要报出来');

    // 每个翻译出口都必须真的调用校验。
    const background = source('background.js');
    assert.match(background, /importScripts\("verify\.js"\)/, '后台应加载 verify.js');
    assert.doesNotMatch(background, /(^|[^.\w])verifyTranslation\(/m, '必须走 TLP_VERIFY 命名空间，裸名会 ReferenceError');

    // 这里刻意不数"某个函数被调用了几次" —— 那个数字只反映写法，不反映正确性，
    // 而且新增一个出口时它反而不会报警。直接检查出口本身的形状才是真正防漏的规则：
    // 凡是返回给客户端的译文对象，都必须带 warnings。
    // （失败路径的 `text: ""` 没有 warnings，它在到达客户端前就被过滤掉了，不算出口。）
    const exits = background.split('\n')
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(({ line }) => /^return \{ .*\b(?:targetLanguage:|warnings:)/.test(line));
    assert.ok(exits.length >= 5, `译文出口不该减少，现在只找到 ${exits.length} 处`);
    for (const { line, number } of exits) {
      assert.match(line, /\bwarnings:/, `background.js:${number} 的译文出口漏了 warnings`);
    }

    // 批量路径的三个出口（批量 / DeepL 批量 / 逐条降级）必须共用同一个收口函数，
    // 否则校验逻辑一散开，就一定会有人漏加其中一条。
    assert.match(background, /function withWarnings\(item, text\)/, '批量出口要有统一的收口函数');
    assert.equal((background.match(/(?:return |=> )withWarnings\(item,/g) || []).length, 3,
      '批量 / DeepL 批量 / 逐条降级 三个出口都要经过 withWarnings');
    assert.match(source('content.js'), /showWarnings\(/, '字段翻译命中后要提示用户');
    assert.match(source('timezone.js'), /tlp-chat-translation-warning/, '聊天译文里要内嵌提示');
  });

  await test('customer work hours drive the contact-time hint', async () => {
    const sandbox = workHintModule({ watContactWorkHint: true, watContactWorkStart: 9, watContactWorkEnd: 18, watContactWorkWeekends: false });
    const W = sandbox.workApi;

    assert.deepEqual(plain(W.workHourRange({})), { start: 9, end: 18, startMinutes: 540, endMinutes: 1080 });
    // 上班时间必须早于下班时间：填反了也要自愈，不能出现空时段或负时长。
    assert.deepEqual(plain(W.workHourRange({ watContactWorkStart: 20, watContactWorkEnd: 5 })), { start: 20, end: 21, startMinutes: 1200, endMinutes: 1260 });
    assert.deepEqual(plain(W.workHourRange({ watContactWorkStart: 99, watContactWorkEnd: 99 })), { start: 23, end: 24, startMinutes: 1380, endMinutes: 1440 });

    const gap = (weekday, hour, weekend = false) => W.minutesUntilWorkWindow(weekday, hour * 60, 540, 1080, weekend);
    assert.equal(gap(1, 8), 60, '周一 08:00 距上班 1 小时');
    assert.equal(gap(1, 12), 0, '周一 12:00 在工作时段内');
    assert.equal(gap(1, 20), 780, '周一 20:00 要等到周二 09:00');
    // 跨周末：周五 20:00 → 周一 09:00 = 4h + 24h + 24h + 9h。
    assert.equal(gap(5, 20), 3660, '周五下班后要跳到下周一');
    assert.equal(gap(6, 12), 2700, '周六默认不算工作日');
    assert.equal(gap(6, 12, true), 0, '勾选周末后周六 12:00 也算工作时段');

    assert.equal(W.formatWorkGap(0), '0 分');
    assert.equal(W.formatWorkGap(45), '45 分');
    assert.equal(W.formatWorkGap(60), '1 小时');
    assert.equal(W.formatWorkGap(90), '1 小时 30 分');

    const info = plain(W.describeContactWorkHours('Asia/Tokyo', {}));
    assert.match(info.text, /^客户当地时间 \d{2}:\d{2}/);
    assert.equal(info.range, '09:00–18:00');
    assert.equal(info.inWindow, info.text.includes('处于工作时段'));

    // 关掉开关 → 不显示圆点，弹层写"已关闭"；没有时区 → 两个位置都清空。
    let fixture = fakeWorkRoot();
    sandbox.activeConfig = { watContactWorkHint: false };
    W.renderWorkHint(fixture.root, { timezone: 'Asia/Tokyo' });
    assert.equal(fixture.marker.hidden, true);
    assert.equal(fixture.detail.textContent, '已关闭');
    assert.equal(fixture.root.dataset.work, undefined);

    fixture = fakeWorkRoot();
    sandbox.activeConfig = { watContactWorkHint: true };
    W.renderWorkHint(fixture.root, { timezone: null });
    assert.equal(fixture.marker.hidden, true);
    assert.equal(fixture.detail.textContent, '—');

    fixture = fakeWorkRoot();
    W.renderWorkHint(fixture.root, { timezone: 'Asia/Tokyo' });
    assert.equal(fixture.marker.hidden, fixture.root.dataset.work === 'in', '只有不在工作时段才亮圆点');
    assert.equal(fixture.detail.dataset.state, fixture.root.dataset.work);
    assert.match(fixture.detail.textContent, /^客户当地时间 \d{2}:\d{2}/);
    assert.equal(fixture.marker.title, fixture.detail.textContent, '悬停提示应与弹层文案一致');

    // 计算好还不够，必须真的接到渲染路径上，否则就是死代码。
    const timezoneCode = source('timezone.js');
    assert.match(timezoneCode, /\.wat-time"\)\.textContent = formatLocalTime\(state\.timezone\);\s*renderWorkHint\(root, state\);/, 'renderKnown 要调用 renderWorkHint');
    assert.match(timezoneCode, /\.wat-time"\)\.textContent = "\\u70B9\\u51FB\\u8BBE\\u7F6E";\s*renderWorkHint\(root, \{ timezone: null \}\);/, 'renderUnknown 要清空提示');
    assert.match(timezoneCode, /\.wat-time"\)\.textContent = formatLocalTime\(activeState\.timezone\);\s*renderWorkHint\(root, activeState\);/, '定时刷新要同步更新提示');
    assert.match(timezoneCode, /<span class="wat-work" hidden><\/span>/, '摘要条里要有圆点锚点');
    assert.match(timezoneCode, /class="wat-work-hint"/, '弹层里要有沟通时间行');
    assert.match(timezoneCode, /watContactWorkHint: true,\s*watContactWorkStart: 9,\s*watContactWorkEnd: 18,\s*watContactWorkWeekends: false/, 'timezone 要有沟通时间默认值');

    // 设置页要能改这几项，并且开关的默认语义与 timezone 一致。
    const optionsCode = source('options.js');
    const optionsHtml = source('options.html');
    for (const id of ['watContactWorkHint', 'watContactWorkStart', 'watContactWorkEnd', 'watContactWorkWeekends']) {
      assert.match(optionsHtml, new RegExp(`id="${id}"`), `设置页缺少 ${id}`);
    }
    assert.match(optionsCode, /watContactWorkHint: true,\s*watContactWorkStart: 9,\s*watContactWorkEnd: 18,\s*watContactWorkWeekends: false/, '设置页默认值要与 timezone 一致');
    assert.match(optionsCode, /\$\(id\)\.addEventListener\("blur", \(\) => normalizeWorkHours\(\)\)/, '时间填反要自动纠正');
    assert.match(source('options.css'), /\.work-window-settings/, '设置页要有对应样式');
    assert.match(source('timezone.css'), /\.wat-work-hint/, '页面提示要有对应样式');
  });

  await test('customer presence drives the online indicator', async () => {
    const sandbox = presenceModule({ watPresenceIndicator: true });
    const P = sandbox.presenceApi;

    assert.equal(P.isOnlinePresence('在线'), true);
    assert.equal(P.isOnlinePresence('online'), true);
    assert.equal(P.isOnlinePresence('正在输入…'), true, '"正在输入"是比"在线"更明确的信号');
    // "最后上线时间"里也含"上线"，必须先排掉离线文案，否则会把离线判成在线。
    assert.equal(P.isOnlinePresence('最后上线时间 昨天 21:10'), false);
    assert.equal(P.isOnlinePresence('last seen today at 11:43'), false);
    assert.equal(P.isOnlinePresence(''), false);

    assert.deepEqual(plain(P.detectPresence(fakePresenceHeader('在线'))), { online: true, text: '在线' });
    assert.deepEqual(plain(P.detectPresence(fakePresenceHeader('最后上线时间 昨天 21:10'))), { online: false, text: '最后上线时间 昨天 21:10' });
    // WhatsApp 没公开状态（或还没渲染出这一行）时不能假装"离线"。
    assert.equal(P.detectPresence(null), null);
    assert.equal(P.detectPresence(fakePresenceHeader(null)), null);

    let fixture = fakePresenceRoot();
    sandbox.activeHeader = fakePresenceHeader('在线');
    P.renderPresence(fixture.root, 'Ihor');
    assert.equal(fixture.marker.hidden, false);
    assert.equal(fixture.marker.dataset.state, 'online');
    assert.equal(fixture.detail.textContent, '在线');
    assert.equal(fixture.detail.dataset.state, 'online');
    assert.equal(fixture.toggle.checked, true);
    assert.match(fixture.marker.title, /^客户在线/);

    // 离线 → 在线要闪一下；一直在线不能反复闪。
    fixture = fakePresenceRoot();
    sandbox.activeHeader = fakePresenceHeader('最后上线时间 昨天 21:10');
    P.renderPresence(fixture.root, 'Ihor');
    assert.equal(fixture.marker.dataset.state, 'offline');
    assert.equal(fixture.marker.dataset.flash, undefined);
    sandbox.activeHeader = fakePresenceHeader('在线');
    P.renderPresence(fixture.root, 'Ihor');
    assert.equal(fixture.marker.dataset.flash, '1', '客户刚上线要闪一下');
    P.renderPresence(fixture.root, 'Ihor');
    assert.equal(fixture.marker.dataset.flash, '1');
    // 换联系人不能沿用上一个人的状态，否则会误闪一下"刚上线"。
    fixture = fakePresenceRoot();
    P.renderPresence(fixture.root, '另一个客户');
    assert.equal(fixture.marker.dataset.flash, undefined, '换联系人不应误闪');

    // 关掉开关：指示灯收起，弹层里写明"已关闭"。
    sandbox.activeConfig = { watPresenceIndicator: false };
    fixture = fakePresenceRoot();
    P.renderPresence(fixture.root, 'Ihor');
    assert.equal(fixture.marker.hidden, true);
    assert.equal(fixture.detail.textContent, '已关闭');
    assert.equal(fixture.toggle.checked, false);
    assert.equal(fixture.root.dataset.presence, undefined);

    // 开着但读不到状态：收起指示灯，弹层写"—"。
    sandbox.activeConfig = { watPresenceIndicator: true };
    fixture = fakePresenceRoot();
    sandbox.activeHeader = fakePresenceHeader(null);
    P.renderPresence(fixture.root, 'Ihor');
    assert.equal(fixture.marker.hidden, true);
    assert.equal(fixture.detail.textContent, '—');

    // 计算与渲染都要真的接到页面上。
    const timezoneCode = source('timezone.js');
    assert.match(timezoneCode, /<span class="wat-presence" hidden><\/span>/, '摘要条里要有状态灯锚点');
    assert.match(timezoneCode, /class="wat-presence-hint"/, '弹层里要有状态行');
    assert.match(timezoneCode, /renderWorkHint\(root, state\);\s*renderPresence\(root, state\.title\);/, 'renderKnown 要渲染状态灯');
    assert.match(timezoneCode, /renderWorkHint\(root, \{ timezone: null \}\);\s*renderPresence\(root, title\);/, 'renderUnknown 要渲染状态灯');
    assert.match(timezoneCode, /if \(root\) renderPresence\(root, activeState\?\.title\);/, '定时刷新要同步状态灯');
    assert.match(timezoneCode, /watContactWorkHint: true,\s*watContactWorkStart: 9,\s*watContactWorkEnd: 18,\s*watContactWorkWeekends: false,\s*(?:\/\/[^\n]*\n\s*)*watPresenceIndicator: true/, 'timezone 要有在线状态默认值');

    // 弹层里的两个快捷开关必须写回与设置页相同的存储键。
    assert.match(timezoneCode, /\.wat-presence-toggle"\)\.addEventListener\("change", \(event\) => \{\s*safeStorageSet\(\{ watPresenceIndicator: event\.target\.checked \}\)/, '状态开关要写回设置');
    assert.match(timezoneCode, /\.wat-work-toggle"\)\.addEventListener\("change", \(event\) => \{\s*safeStorageSet\(\{ watContactWorkHint: event\.target\.checked \}\)/, '沟通时间开关要写回设置');

    const optionsCode = source('options.js');
    const optionsHtml = source('options.html');
    assert.match(optionsHtml, /id="watPresenceIndicator"/, '设置页要能关掉状态灯');
    assert.match(optionsCode, /watContactWorkWeekends: false,\s*watPresenceIndicator: true/, '设置页默认值要与 timezone 一致');
    assert.match(optionsCode, /\$\("watPresenceIndicator"\)\.checked = settings\.watPresenceIndicator !== false;/, '设置页读取状态开关');
    assert.match(source('timezone.css'), /\.wat-presence\[data-state="online"\]/, '在线状态灯要有样式');
    assert.match(source('timezone.css'), /\.wat-toggle input:checked \+ i/, '快捷开关要有样式');
  });

  // 文字系统识别：重构前是 42 个分支的 if 链，且零测试覆盖。
  // 这几条用例把"表驱动"的行为钉死，防止以后往表里加行时改错顺序或置信度。
  await test('文字系统识别把常见文字映射到正确语言', async () => {
    const { detectByScript } = scriptDetectModule();
    assert.deepEqual(plain(detectByScript('你好，这是中文')), ['cmn', 1]);
    assert.deepEqual(plain(detectByScript('こんにちは')), ['jpn', 1]);
    assert.deepEqual(plain(detectByScript('안녕하세요')), ['kor', 1]);
    assert.deepEqual(plain(detectByScript('สวัสดี')), ['tha', 1]);
    assert.deepEqual(plain(detectByScript('Γειά σου')), ['ell', 1]);
    assert.deepEqual(plain(detectByScript('שלום')), ['heb', 0.98]);
  });

  await test('西里尔字母靠专属字母区分语言，细分不出来就交给统计识别', async () => {
    const { detectByScript } = scriptDetectModule();
    assert.deepEqual(plain(detectByScript('Привет, ты как')), ['rus', 0.99]);
    assert.deepEqual(plain(detectByScript('Привіт, як справи')), ['ukr', 0.99]);
    // 全是西里尔字母但没有任何区分特征时返回 null，让 franc 去做统计识别，
    // 而不是在这里硬猜一个语言 —— 猜错比不猜更糟。
    assert.equal(detectByScript('абвгд'), null);
  });

  await test('阿拉伯字母细分不出来时兜底到标准阿拉伯语', async () => {
    const { detectByScript } = scriptDetectModule();
    assert.deepEqual(plain(detectByScript('مرحبا بك')), ['arb', 0.96]);
    assert.deepEqual(plain(detectByScript('سلام، حال شما چطور است')), ['pes', 0.99]);
  });

  await test('拉丁字母不归文字系统管，留给统计识别', async () => {
    const { detectByScript } = scriptDetectModule();
    assert.equal(detectByScript('hello world'), null);
    assert.equal(detectByScript(''), null);
  });

  await test('语言状态：手动指定覆盖自动识别', async () => {
    const { resolveLanguageState } = languageStateModule();
    const fresh = { iso3: 'ukr', confidence: 96, name: '乌克兰语' };

    const auto = plain(resolveLanguageState(fresh, null, null));
    assert.equal(auto.detectedLanguage.name, '乌克兰语');
    assert.equal(auto.detectedLanguage.manual, undefined);
    assert.equal(auto.manualLanguageCode, null);

    const manual = plain(resolveLanguageState(fresh, null, 'ru'));
    assert.equal(manual.detectedLanguage.name, '俄语', '手动指定的语言优先');
    assert.equal(manual.detectedLanguage.manual, true);
    assert.equal(manual.manualLanguageCode, 'ru');
    // 手动指定不该影响缓存判据 —— 缓存里存的一直是"自动识别的结果"。
    assert.equal(manual.shouldCache, true);
  });

  await test('语言状态：只有识别结果确实变了才写缓存', async () => {
    const { resolveLanguageState } = languageStateModule();
    const fresh = { iso3: 'ukr', confidence: 96 };

    assert.equal(resolveLanguageState(null, null, null).shouldCache, false, '什么都没识别出来不该写');
    assert.equal(resolveLanguageState(fresh, null, null).shouldCache, true, '首次识别出高置信度结果要写');
    assert.equal(resolveLanguageState(fresh, { iso3: 'ukr', confidence: 96 }, null).shouldCache, false,
      '与缓存完全一致不该写 —— 否则每次页面变化都会写一次存储');
    assert.equal(resolveLanguageState(fresh, { iso3: 'rus', confidence: 96 }, null).shouldCache, true, 'iso3 变了要写');
    assert.equal(resolveLanguageState(fresh, { iso3: 'ukr', confidence: 80 }, null).shouldCache, true, '置信度变了要写');
    assert.equal(resolveLanguageState({ iso3: 'ukr', confidence: 42 }, null, null).shouldCache, false,
      '置信度低于 60 不该写 —— 避免把一次猜测固化下来');

    // 本轮没识别出来时退回用缓存里的结果。
    assert.equal(resolveLanguageState(null, { iso3: 'rus', confidence: 90 }, null).detectedLanguage.iso3, 'rus');
  });

  // popup.js 的 render 原本是一个 41 行、复杂度 31 的函数。
  // 重构前先把它的对外行为钉死 —— 这几条只断言 DOM 上的结果，
  // 不碰任何内部函数名，所以拆成几个函数之后它们不需要改。
  const fullProvider = {
    provider: 'custom',
    providerConfigs: { custom: { baseUrl: 'https://api.example.com/v1', apiKey: 'test-only', model: 'test-only' } }
  };

  await test('popup 的服务商警告条只在缺必填项时出现', async () => {
    const complete = popupContext(fullProvider);
    await complete.api.load();
    complete.api.render(null);
    assert.equal(complete.element('apiWarning').hidden, true, '配置齐全时不该警告');

    const noKey = popupContext({ provider: 'custom', providerConfigs: { custom: { baseUrl: 'https://api.example.com/v1', model: 'm' } } });
    await noKey.api.load();
    noKey.api.render(null);
    assert.equal(noKey.element('apiWarning').hidden, false, '缺 API Key 要警告');

    const noUrl = popupContext({ provider: 'custom', providerConfigs: { custom: { apiKey: 'k', model: 'm' } } });
    await noUrl.api.load();
    noUrl.api.render(null);
    assert.equal(noUrl.element('apiWarning').hidden, false, '缺接口地址要警告');

    // 免费档没有 API Key 也能用，不该弹警告。
    const free = popupContext({ provider: 'googlefree' });
    await free.api.load();
    free.api.render(null);
    assert.equal(free.element('apiWarning').hidden, true, '免费档不该警告');
    assert.equal(free.element('providerName').textContent, 'Google 翻译（免费）');
  });

  await test('popup 的 Gemini 回填历史遗留的顶层 apiKey', async () => {
    // v2.x 只存过顶层 apiKey，没有 providerConfigs。老用户升级后不能变成"未配置"。
    const legacy = popupContext({ provider: 'gemini', apiKey: 'legacy-key' });
    await legacy.api.load();
    legacy.api.render(null);
    assert.equal(legacy.element('apiWarning').hidden, true, '老用户只存过 apiKey 时不该被判定为未配置');
  });

  await test('popup 的启用徽标区分全局关闭 / 本站关闭 / 已启用', async () => {
    const enabled = popupContext({ ...fullProvider, enabled: true, disabledSites: [] });
    await enabled.api.load();
    enabled.api.render(null);
    assert.equal(enabled.element('translationBadge').textContent, '已启用');
    assert.equal(enabled.element('translationBadge').className, 'badge on');

    const siteOff = popupContext({ ...fullProvider, enabled: true, disabledSites: ['whatsapp.com'] });
    await siteOff.api.load();
    siteOff.api.render(null);
    assert.equal(siteOff.element('translationBadge').textContent, '本站关闭', '父域名应当覆盖子域名');
    assert.equal(siteOff.element('translationBadge').className, 'badge off');
    assert.equal(siteOff.element('siteToggle').textContent, '为当前网站启用');

    const globalOff = popupContext({ ...fullProvider, enabled: false, disabledSites: [] });
    await globalOff.api.load();
    globalOff.api.render(null);
    assert.equal(globalOff.element('translationBadge').textContent, '全局关闭');
    assert.equal(globalOff.element('siteToggle').textContent, '前往设置开启翻译');
  });

  await test('popup 停用本站时只移除覆盖当前站点的记录', async () => {
    const ctx = popupContext({ ...fullProvider, enabled: true, disabledSites: ['www.WhatsApp.com', 'example.com'] });
    await ctx.api.load();
    ctx.api.render(null);
    ctx.element('siteToggle').listeners.click();
    const written = ctx.writes.at(-1);
    assert.ok(written && 'disabledSites' in written, '点击后应写回 disabledSites');
    assert.deepEqual(plain(written.disabledSites), ['example.com'],
      '带 www 前缀 / 大小写不同的记录也要被识别为"覆盖当前站点"并移除');
  });

  await test('popup 的联系人卡片在识别不出时区时给提示文案', async () => {
    const ctx = popupContext(fullProvider);
    await ctx.api.load();

    ctx.api.render({ title: 'Ihor', region: '乌克兰', timezone: 'Europe/Kyiv', phone: '+380 44', detectedLanguage: { name: '乌克兰语', confidence: 96 } });
    assert.equal(ctx.element('contactName').textContent, 'Ihor');
    assert.match(ctx.element('timeSummary').textContent, /^乌克兰 {2}当地时间：\d{2}:\d{2}$/);
    assert.equal(ctx.element('timezoneMeta').textContent, '+380 44 · Europe/Kyiv · 客户语言：乌克兰语 96%');

    // 手动指定过语言时显示"（手动）"而不是置信度。
    ctx.api.render({ title: 'Ihor', region: '乌克兰', timezone: 'Europe/Kyiv', phone: '+380 44', detectedLanguage: { name: '俄语', manual: true, confidence: 99 } });
    assert.equal(ctx.element('timezoneMeta').textContent, '+380 44 · Europe/Kyiv · 客户语言：俄语（手动）');

    // 有联系人但识别不出时区。
    ctx.api.render({ title: 'Ihor' });
    assert.equal(ctx.element('timeSummary').textContent, '地区未识别');
    assert.equal(ctx.element('timezoneMeta').textContent, '点击页面顶部标签可手动填写号码');

    // 一个联系人也没有。
    ctx.api.render(null);
    assert.equal(ctx.element('contactName').textContent, '请打开一个 WhatsApp 对话');
    assert.equal(ctx.element('timeSummary').textContent, '等待识别');
    assert.equal(ctx.element('timezoneMeta').textContent, '号码归属地区与当地时间');
  });

  const manifest = JSON.parse(source('manifest.json'));
  const html = source('options.html');
  const guide = source('安装说明.txt');
  // 版本号以 manifest.json 为唯一来源，另两处必须跟上。
  // 这样升版本只要改 manifest.json，测试不用跟着改。
  const version = manifest.version;
  assert.match(version, /^\d+\.\d+\.\d+$/, 'manifest version 应为 x.y.z');
  const escaped = version.replace(/\./g, '\\.');
  assert.match(html, new RegExp(`v${escaped}`), 'options.html 版本号与 manifest 不一致');
  assert.match(guide, new RegExp(`TransMate v${escaped}`), '安装说明.txt 版本号与 manifest 不一致');
  assert.ok(manifest.host_permissions.includes('https://translate.googleapis.com/*'));
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'options.html contains duplicate ids');
  for (const requiredId of ['translationProfile', 'save']) assert.ok(ids.includes(requiredId));
  assert.equal(ids.includes('polishStyle'), false);
  for (const file of ['background.js', 'content.js', 'options.js', 'options.html', '安装说明.txt']) {
    const text = source(file);
    for (const removedSymbol of ['TL_POLISH', 'polishStyle', '__tl_polish_panel', 'AI 译后润色', 'AI 润色', '采用润色']) {
      assert.equal(text.includes(removedSymbol), false, `${removedSymbol} remains in ${file}`);
    }
  }
  return { passed: passed.length + 1, checks: [...passed, 'versions, HTML ids and polish removal are consistent'] };
}

module.exports = { run, setSourceOverrides };

if (require.main === module) {
  run()
    .then(result => { console.log(JSON.stringify(result, null, 2)); })
    .catch(error => { console.error(error); process.exitCode = 1; });
}
