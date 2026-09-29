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
// timezone.js 的号码查找：三处候选来源 + 一个"只在换联系人时重扫"的缓存。
// 这段以前一条测试都没有 —— 正是"没人测"才让同一个循环被抄了三遍。
function phoneFinderModule(deps = {}) {
  const code = source('timezone.js');
  const lines = code.split('\n');
  const start = lines.findIndex(line => line.trim().startsWith('function valuesFromElement('));
  const end = lines.findIndex((line, index) => index > start && line.trim().startsWith('function isThirdPartyTranslationNode('));
  assert.ok(start > -1 && end > start, 'timezone.js 里应存在号码查找模块');
  const snippet = lines.slice(start, end).join('\n');
  const sandbox = {
    console, ROOT_ID: 'wat-region-time-root', stopped: false,
    chrome: { runtime: { sendMessage: () => ({ catch() {} }) } },
    handleExtensionError() {},
    cleanText: value => String(value || '').replace(/\s+/g, ' ').trim(),
    getContactTitle: deps.getContactTitle || (() => ''),
    normalizePhone: deps.normalizePhone || (value => String(value || '').trim() || null),
    document: deps.document || { querySelector: () => null, querySelectorAll: () => [] },
    window: deps.window || { innerWidth: 1200, location: { href: '' } },
    Number, String, Array, Object, RegExp, Math, Set
  };
  vm.createContext(sandbox);
  vm.runInContext(
    snippet + '\nglobalThis.phoneApi = { valuesFromElement, firstPhoneFrom, findPhoneInHeader, findPhoneInChatMetadata, findPhoneInVisibleContactPanel, getPhone };',
    sandbox,
    { filename: 'timezone-phone.js' }
  );
  return sandbox.phoneApi;
}
// resolveContactFacts 决定"面板上到底显示哪个号码"。它依赖三处外部输入，
// 这里全部换成桩，只验证优先级和写回规则 —— 那才是真会出错的地方。
function contactFactsModule(deps = {}) {
  const src = source('timezone.js');
  const start = src.indexOf('  function resolveContactFacts(');
  const end = src.indexOf('  /** 拿到号码之后的分支', start);
  assert.ok(start > -1 && end > start, 'timezone.js 里应存在 resolveContactFacts');
  const writes = [];
  const sandbox = {
    console,
    STORAGE: {
      contactMap: 'watContactMap', manualPhones: 'watManualPhones',
      languageCache: 'watLanguageCacheV3', languageOverrides: 'watLanguageOverrides'
    },
    getContactTitle: () => deps.title || '客户 A',
    getRecentIncomingMessages: () => [],
    getPhone: () => deps.detected || null,
    detectCustomerLanguage: () => ({ code: 'en', confidence: 90 }),
    // shouldCache 固定为 false：这里只关心号码，不想被语言缓存的写入干扰断言。
    resolveLanguageState: fresh => ({
      detectedLanguage: fresh, automaticLanguage: fresh, manualLanguageCode: null, shouldCache: false
    }),
    safeStorageSet: value => { writes.push(value); }
  };
  vm.createContext(sandbox);
  vm.runInContext(
    src.slice(start, end) + '\nglobalThis.contactApi = { resolveContactFacts };',
    sandbox,
    { filename: 'timezone-contact.js' }
  );
  sandbox.writes = writes;
  return sandbox;
}
// shouldSkipChatTranslation 决定"这条消息到底要不要花钱翻译"。它只依赖语言识别，
// 把识别换成桩就能单独验证跳过规则 —— 这里出错的代价是白花额度。
function chatSkipModule(detect) {
  const src = source('timezone.js');
  const start = src.indexOf('  function shouldSkipChatTranslation(');
  const end = src.indexOf('  function clearChatTranslationDom(', start);
  assert.ok(start > -1 && end > start, 'timezone.js 里应存在 shouldSkipChatTranslation');
  const sandbox = { console, detectSingleLanguage: detect };
  vm.createContext(sandbox);
  vm.runInContext(
    src.slice(start, end) + '\nglobalThis.chatSkipApi = { shouldSkipChatTranslation };',
    sandbox,
    { filename: 'timezone-chat-skip.js' }
  );
  return sandbox.chatSkipApi;
}
// options.js 的 clamp 是纯函数，单独切出来测。它的坑在于 Number("") === 0。
function optionsClampModule() {
  const src = source('options.js');
  const start = src.indexOf('const clamp = (value, min, max, fallback) => {');
  const stop = src.indexOf('\n};', start);
  assert.ok(start > -1 && stop > start, 'options.js 里应存在 clamp');
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(
    src.slice(start, stop + 3) + '\nglobalThis.clampApi = { clamp };',
    sandbox,
    { filename: 'options-clamp.js' }
  );
  return sandbox.clampApi;
}
// vm 里造出来的数组/对象原型与宿主机不同，deepStrictEqual 会因为原型不一致而失败。
// 统一走一次 JSON 往返，拿到宿主机的普通对象再断言。
const plain = value => JSON.parse(JSON.stringify(value));
async function run() {
  const passed = [];
  async function test(name, fn) { await fn(); passed.push(name); }

  // 短输入（几个字符）时的输出预算下限。普通模型取 2048；推理模型要抬高，
  // 因为 max_completion_tokens 是"思考 + 正文"合起来算的（见 M6）。
  // 断言"推理 > 普通"这个关系而不是某个死数字，以后调系数不用回头改测试。
  const PLAIN_BUDGET_MIN = 2048;

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

  // 超长输入必须在**发请求之前**就被拦下来（M4）。
  // 原来的行为是"先把请求发出去，等服务端回一段 context_length_exceeded 的英文原始报文，
  // 再整段甩给用户"——钱花掉了，用户还不知道发生了什么。
  await test('超长输入在发请求之前就被拦下', async () => {
    let calls = 0;
    const sandbox = backgroundContext(async () => {
      calls += 1;
      return jsonResponse({ choices: [{ message: { content: '译文' }, finish_reason: 'stop' }] });
    });
    const send = text => new Promise(resolve => {
      sandbox.messageHandler({ type: 'TL_TRANSLATE', text, direction: 'zh2en' }, { tab: { id: 1 } }, resolve);
    });

    const tooLong = await send('字'.repeat(9000));
    // 先断言"请求根本没发出去"——这才是这条用例真正要守的东西。
    // 放在前面还让变异测试能报出有意义的信息（见 temp/mutation-test.cjs 的提示关键字）。
    assert.equal(calls, 0, '不该把注定失败的请求发出去');
    assert.equal(tooLong.ok, false);
    assert.match(tooLong.error, /超过单次上限/, '要给一句能看懂的中文提示');

    // 限额之内的照常翻译，不能误伤。
    const ok = await send('字'.repeat(100));
    assert.equal(ok.ok, true);
    assert.equal(calls, 1);
  });

  await test('invalid batch item text type is rejected', async () => {
    const sandbox = backgroundContext(async () => { throw new Error('Network disabled'); });
    assert.throws(() => sandbox.parseBatchTranslationOutput('[{"id":"0","text":{"unexpected":"value"}}]'), /无效项目/);
  });

  // 模型常把 id 回成数字（"id": 0）。原来按 typeof !== "string" 判无效会连坐整批：
  // 12 条消息从 1 次请求退化成 3 次，钱多花、还更慢。归一成字符串只丢真正对不上的那条。
  await test('批量翻译把数字 id 归一成字符串，不再连坐整批', async () => {
    const sandbox = backgroundContext(async () => { throw new Error('Network disabled'); });
    const rows = sandbox.parseBatchTranslationOutput('[{"id":0,"text":"Result A"},{"id":1,"text":"Result B"}]');
    assert.deepEqual(plain(rows), [{ id: '0', text: 'Result A' }, { id: '1', text: 'Result B' }]);
  });

  // 中文原文在简体目标下必须跳过。原来写的是"目标带 - 就不跳过"，可默认目标 zh-CN
  // 也带 -，等于这条规则恒成立：中文消息全被送去翻译，白花额度，聊天区还会多出一行
  // 几乎相同的译文。只有繁体目标才需要把简体原文转过去。
  await test('中文原文在简体目标下被跳过，只有繁体目标才放行', async () => {
    const zh = chatSkipModule(() => ({ code: 'zh', name: '中文', confidence: 100 }));
    assert.equal(zh.shouldSkipChatTranslation('你好，请问什么时候能发货', 'zh-CN'), true, 'zh-CN 下中文不该再送去翻译');
    assert.equal(zh.shouldSkipChatTranslation('你好，请问什么时候能发货', 'zh-TW'), false, 'zh-TW 下简体要转成繁体');
    assert.equal(zh.shouldSkipChatTranslation('https://example.com/quote.pdf', 'zh-CN'), true, '纯链接照旧跳过');
    const ru = chatSkipModule(() => ({ code: 'ru', name: '俄语', confidence: 100 }));
    assert.equal(ru.shouldSkipChatTranslation('Здравствуйте, есть ли товар?', 'zh-CN'), false, '外语照常翻译');
  });

  // Number("") 等于 0，而 0 是有限数。原来空输入会被当成 0 再夹到下限，
  // 于是清空输入框再保存，值会存成 -400px / 10px 这类下限，而不是默认值。
  await test('数字输入框清空后回落到默认值，而不是下限', async () => {
    const { clamp } = optionsClampModule();
    assert.equal(clamp('', -400, 400, 99), 99, '空串要返回 fallback');
    assert.equal(clamp('   ', -400, 400, 99), 99, '纯空白同理');
    assert.equal(clamp(null, 2, 5, 3), 3);
    assert.equal(clamp(undefined, 10, 22, 13), 13);
    assert.equal(clamp('0', -400, 400, 99), 0, '真的填了 0 就保留 0');
    assert.equal(clamp('999', -400, 400, 0), 400, '超出上限仍要夹住');
    assert.equal(clamp('-999', -400, 400, 0), -400, '超出下限仍要夹住');
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
    const send = async (model) => {
      let body;
      const config = { provider: 'openai', providerConfigs: { openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'test-only', model } } };
      const sandbox = backgroundContext(async (_url, options) => {
        body = JSON.parse(options.body);
        return jsonResponse({ choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }] });
      }, config);
      const response = await new Promise(resolve => { sandbox.messageHandler({ type: 'TL_TRANSLATE', text: '你好', direction: 'zh2en' }, { tab: { id: 1 } }, resolve); });
      assert.equal(response.ok, true);
      return body;
    };

    const reasoning = await send('gpt-5-mini');
    assert.equal('max_tokens' in reasoning, false);
    assert.equal('temperature' in reasoning, false, '推理模型不接受 temperature');

    // 推理模型的预算要高于普通模型（M6）：
    // max_completion_tokens 是"思考 + 正文"合起来算的，不抬高的情况下
    // 思维链会把额度吃光，正文翻到一半就被截断 —— 钱已经花了，用户只看到一条失败提示。
    // 这里断言的是"推理 > 普通"这个关系，不是某个具体数字，
    // 这样以后调系数不用回头改测试。
    const plain = await send('gpt-4o');
    assert.ok(reasoning.max_completion_tokens > plain.max_completion_tokens,
      '推理模型的输出预算必须高于普通模型');
    assert.ok('temperature' in plain, '普通模型必须带 temperature，否则服务端用默认温度、每次结果都不一样');
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
    // 预算高于普通模型的下限，说明"藏在地址里的 gpt-5"确实被认成了推理模型。
    assert.ok(body.max_completion_tokens > PLAIN_BUDGET_MIN, '推理模型的预算要高于普通模型');
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
    // 同上：预算高于普通模型下限，说明带厂商前缀的 gpt-5 也被认出来了。
    assert.ok(body.max_completion_tokens > PLAIN_BUDGET_MIN, '推理模型的预算要高于普通模型');
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
    assert.match(optionsCode, /if \(actionId === providerActionSequence\[kind\]\) \{\s*button\.textContent = labels\.idle;/, '按钮恢复只应依赖 actionId');
    assert.doesNotMatch(optionsCode, /if \(requestGeneration === providerGeneration && actionId === providerActionSequence\[kind\]\) \{\s*button\.disabled/, '恢复按钮时不应再看 providerGeneration');
    // 文案不能"把按钮上当时的文字抓下来、结束再写回去"：
    // 请求飞行途中按钮文字已经是"获取中…"，抓回来写回就等于把它永久钉在那儿。
    // 文案只能由 kind 推出来 —— 这样无论中途发生什么，恢复时写的都是确定的那个词。
    assert.doesNotMatch(optionsCode, /const original = button\.textContent/, '按钮文案不能读 DOM');
    assert.match(optionsCode, /PROVIDER_ACTION_LABELS = \{/, '按钮文案应由 kind 推出');
    assert.match(optionsCode, /button\.textContent = labels\.busy;/, '忙碌文案也应来自同一张表');
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

  // 顶层 model 是 v2.x 的遗留镜像，options.js 每次保存设置页都会往里写一份"当时的快照"。
  // 它必须**压不过** providers.js 的预设：模型名会过期（deepseek-chat 就退役过），
  // 一旦镜像固化，预设里的模型升级就永远传不到用户那里 —— 表现为"新装用户好的、
  // 老用户报模型不存在"，是最难定位的那一类问题。
  await test('预设的 Gemini 模型不会被顶层遗留的 model 镜像压掉', async () => {
    const presetSandbox = { console };
    vm.createContext(presetSandbox);
    vm.runInContext(source('providers.js'), presetSandbox, { filename: 'providers.js' });
    const presetModel = presetSandbox.TLP_PROVIDER_PRESETS.gemini.model;
    assert.ok(presetModel, 'providers.js 里 gemini 预设应当有默认模型');

    let called = '';
    const sandbox = backgroundContext(async url => {
      called = url;
      return jsonResponse({ candidates: [{ content: { parts: [{ text: '你好' }] }, finishReason: 'STOP' }] });
    }, { provider: 'gemini', apiKey: 'legacy-key', model: 'gemini-1.0-pro-retired' });
    const response = await new Promise(resolve => { sandbox.messageHandler({ type: 'TL_TRANSLATE', text: 'Hello', direction: 'en2zh' }, { tab: { id: 1 } }, resolve); });
    assert.equal(response.ok, true);
    assert.ok(called.includes(encodeURIComponent(presetModel)),
      `请求应当用预设模型 ${presetModel}，实际 URL：${called}`);
    assert.doesNotMatch(called, /1\.0-pro-retired/, '顶层遗留的 model 镜像不该再影响实际请求');
  });

  // Gemini 的 API Key 必须走请求头，不能拼在 URL 的 ?key= 上：
  // URL 会进浏览器历史、代理与网络日志，也会随跨域请求的 Referer 泄漏出去。
  await test('Gemini 的 API Key 走请求头而不是 URL query', async () => {
    let calledUrl = '';
    let calledHeaders = null;
    const sandbox = backgroundContext(async (url, options) => {
      calledUrl = url;
      calledHeaders = options?.headers || {};
      return jsonResponse({ candidates: [{ content: { parts: [{ text: '你好' }] }, finishReason: 'STOP' }] });
    }, { provider: 'gemini', providerConfigs: { gemini: { apiKey: 'secret-key' } } });
    const response = await new Promise(resolve => { sandbox.messageHandler({ type: 'TL_TRANSLATE', text: 'Hello', direction: 'en2zh' }, { tab: { id: 1 } }, resolve); });
    assert.equal(response.ok, true);
    assert.doesNotMatch(calledUrl, /[?&]key=/, 'Key 不该出现在 URL 上');
    assert.equal(calledHeaders['x-goog-api-key'], 'secret-key', 'Key 应当放在 x-goog-api-key 请求头里');
  });

  // DeepL 的 `context` 语义是"帮助消歧的上下文文本"，不是给引擎的系统提示词；
  // `formality` 只对部分目标语言生效，不支持的语种传了会直接 400、整次翻译失败。
  await test('DeepL 不把风格指令当 context，formality 只发给支持的语种', async () => {
    const bodies = [];
    const makeSandbox = storage => backgroundContext(async (url, options) => {
      bodies.push(String(options?.body || ''));
      return jsonResponse({ translations: [{ text: 'Hello' }] });
    }, {
      provider: 'deepl',
      providerConfigs: { deepl: { baseUrl: 'https://api-free.deepl.com/v2', apiKey: 'k' } },
      ...storage
    });
    const send = (sandbox, direction) => new Promise(resolve => {
      sandbox.messageHandler({ type: 'TL_TRANSLATE', text: '你好', direction }, { tab: { id: 1 } }, resolve);
    });

    // 目标 ZH-HANS：既不在 formality 支持名单里，也不该带 context。
    await send(makeSandbox({ customerLanguage: 'auto' }), 'en2zh');
    const zhBody = new URLSearchParams(bodies[0]);
    assert.equal(zhBody.get('target_lang'), 'ZH-HANS');
    assert.equal(zhBody.has('formality'), false, 'ZH-HANS 不支持 formality，传了会 400');
    assert.equal(zhBody.has('context'), false, '英文风格指令不是 DeepL 的 context，不该发出去');

    // 目标 DE + 商务风格：支持 formality，应当带 prefer_more。
    bodies.length = 0;
    await send(makeSandbox({ customerLanguage: 'de', translationProfile: 'business-english' }), 'zh2en');
    const deBody = new URLSearchParams(bodies[0]);
    assert.equal(deBody.get('target_lang'), 'DE');
    assert.equal(deBody.get('formality'), 'prefer_more');

    // 目标 TR：不在支持名单里，不能带 formality。
    bodies.length = 0;
    await send(makeSandbox({ customerLanguage: 'tr', translationProfile: 'business-english' }), 'zh2en');
    const trBody = new URLSearchParams(bodies[0]);
    assert.equal(trBody.get('target_lang'), 'TR');
    assert.equal(trBody.has('formality'), false, 'TR 不在 DeepL 的 formality 支持名单里');
  });

  // 聊天批量翻译有四条出口（免费接口 / DeepL 批量 / AI 批量 / 逐条降级），
  // 它们必须给出同一个结果形状 { id, text }。
  // v3.9.10 出过一次同类事故：AI 批量那条漏传了参数，用户换个服务商就静默失效。
  // 所以这里既做结构守卫（都经过同一个收口函数），也做行为验证（形状真的对）。
  await test('聊天批量翻译的四条出口给出同一个结果形状', async () => {
    const background = source('background.js');
    assert.match(background, /function toChatResult\(item, text\)/, '批量出口要有统一的收口函数');
    // 只数"调用点"，不数函数声明，也不在乎参数换不换行。
    assert.equal((background.match(/(?<!function )toChatResult\(/g) || []).length, 4,
      '免费接口 / DeepL 批量 / AI 批量 / 逐条降级 四个出口都要经过 toChatResult');

    // 行为验证：AI 批量出口真的只返回 { id, text } 两个字段。
    const batch = await backgroundContext(
      async () => jsonResponse({
        choices: [{
          message: { content: JSON.stringify([{ id: '0', text: '你好' }]) },
          finish_reason: 'stop'
        }]
      }),
      {
        provider: 'openai',
        providerConfigs: { openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'test-only', model: 'gpt-4o-mini' } }
      }
    ).translateChatBatch([{ id: 'a', text: 'Hello' }], 'zh-CN');

    assert.equal(batch.length, 1);
    assert.deepEqual(Object.keys(batch[0]).sort(), ['id', 'text'], '出口形状必须是 { id, text }');
    assert.equal(batch[0].id, 'a');
    assert.equal(batch[0].text, '你好');
  });

  // 移除一个功能最怕"删了渲染、留下设置项"或反过来 —— 半截状态最难维护。
  // 这条用例把"整条链路都不存在"钉死，防止以后有人只补回一半。
  await test('已移除的功能不在界面与数据里留残骸', async () => {
    const removedSymbols = [
      // 沟通时间提示
      'watContactWorkHint', 'watContactWorkStart', 'watContactWorkEnd', 'watContactWorkWeekends',
      'wat-work', 'renderWorkHint', 'describeContactWorkHours', 'workHourRange',
      'minutesUntilWorkWindow', 'formatWorkGap', 'normalizeWorkHours', 'WORK_DEFAULTS',
      '提示客户沟通时间', '沟通时间',
      // 客户在线状态指示灯：状态判断、渲染、样式、设置项、存储键一个都不许留
      'watPresenceIndicator', 'wat-presence', 'presenceKey', 'lastPresenceOnline', 'presenceFlashUntil',
      'isOnlinePresence', 'looksLikePresenceText', 'isIconLike', 'getPresenceElement',
      'detectPresence', 'renderPresence', 'wat-toggle', 'panel-settings', '客户在线状态指示灯',
      // 硬信息一致性校验 + 自动统一柜型写法：实现、出口、界面、样式一个都不许留
      'translationAutoNormalize', 'tlp-chat-translation-warning', '自动统一柜型写法',
      'verifyTranslation', 'normalizeHardFacts', 'TLP_VERIFY'
    ];
    for (const file of ['timezone.js', 'timezone.css', 'options.js', 'options.html', 'options.css']) {
      const text = source(file);
      for (const symbol of removedSymbols) {
        assert.equal(text.includes(symbol), false, `${file} 里还残留 ${symbol}`);
      }
    }

    // 默认值里也不能留：留着就是"读得到但没人用"的孤儿设置。
    const { run: checkDefaults } = require('./defaults-consistency.cjs');
    const { problems, authoritySize } = checkDefaults();
    assert.deepEqual(problems, [], '默认值一致性门禁应通过');
    assert.equal(authoritySize, 29, `权威默认值应为 29 键，实际 ${authoritySize}`);

    // verify.js 是被整文件删掉的，上面那个字符串扫描循环覆盖不到它。
    assert.equal(fs.existsSync(path.join(root, 'verify.js')), false, 'verify.js 应当已经删除');
    assert.equal(source('background.js').includes('TLP_VERIFY'), false, '后台不该再引用 TLP_VERIFY');
    assert.equal(source('background.js').includes('importScripts("verify.js")'), false, '后台不该再加载 verify.js');
    // 聊天译文里那条"请核对：…"在源码里是 Unicode 转义，字符串扫描搜不到中文。
    assert.equal(source('timezone.js').includes('\\u8BF7\\u6838\\u5BF9'), false, '聊天译文里不该再内嵌校验提示');
    assert.equal(source('content.js').includes('showWarnings'), false, '输入框翻译不该再弹校验提示');

    // 状态行本身要留着 —— 那是客户地区与当地时间，不属于被移除的功能。
    assert.match(source('timezone.js'), /class="wat-time-label"/, '地区时间标签不该被误删');
    assert.match(source('timezone.css'), /\.wat-time-label/, '地区时间标签的样式不该被误删');
    assert.match(source('options.html'), /id="watEnabled"/, 'WhatsApp 面板总开关不该被误删');
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

  // 号码查找三处来源共用同一个循环，且只在"换了联系人"时才重扫页面。
  await test('号码查找：三处候选共用一个循环，只在换联系人时重扫', async () => {
    // normalizePhone 换成可控替身：只认 "+7~15 位数字"，方便断言"取到的是哪一个候选"。
    const fakeNormalize = value => {
      const match = String(value || '').match(/\+\d{7,15}/);
      return match ? match[0] : null;
    };
    let rectCalls = 0;
    const element = (text, attrs = {}) => ({
      textContent: text,
      getAttribute: name => (name in attrs ? attrs[name] : null),
      closest: () => null,
      querySelectorAll: () => [],
      getBoundingClientRect() { rectCalls += 1; return { width: 100, height: 20, left: 900 }; }
    });

    // 标题栏：自身属性里就有号码。
    const header = element('', { title: 'Ihor Petrenko +380676503011' });
    const P = phoneFinderModule({ normalizePhone: fakeNormalize });
    assert.equal(P.findPhoneInHeader(header), '+380676503011');
    // header 还没渲染出来时不能抛（原来这里会 TypeError）。
    assert.equal(P.findPhoneInHeader(null), null);
    assert.equal(P.findPhoneInHeader(undefined), null);

    // 会话元数据：从 #main 的候选里取。
    const metadata = phoneFinderModule({
      normalizePhone: fakeNormalize,
      document: {
        querySelector: selector => (selector === '#main' ? { querySelectorAll: () => [element('', { 'data-jid': '1@c.us' }), element('', { 'data-phone': '+8613800138000' })] } : null),
        querySelectorAll: () => []
      }
    });
    assert.equal(metadata.findPhoneInChatMetadata(), '+8613800138000');
    // 没有 #main 时安全返回 null。
    assert.equal(phoneFinderModule({ document: { querySelector: () => null, querySelectorAll: () => [] } }).findPhoneInChatMetadata(), null);

    // 可见联系人面板：没有 7 位数字的候选要在问布局之前就被筛掉，
    // 否则上千个 span 每个都要 getBoundingClientRect（强制同步布局）。
    rectCalls = 0;
    const panel = phoneFinderModule({
      normalizePhone: fakeNormalize,
      document: {
        querySelector: () => null,
        querySelectorAll: () => [
          element('Ihor Petrenko'),
          element('在线'),
          element('最后上线时间 昨天 21:10'),
          element('+380676503011')
        ]
      }
    });
    assert.equal(panel.findPhoneInVisibleContactPanel(), '+380676503011');
    assert.equal(rectCalls, 1, `只有真正像号码的那一个才该去问布局，实际问了 ${rectCalls} 次`);

    // 换联系人之前复用上次结果；换人之后必须重扫。
    let scans = 0;
    let currentTitle = 'Ihor Petrenko';
    const cached = phoneFinderModule({
      normalizePhone: fakeNormalize,
      getContactTitle: () => currentTitle,
      document: {
        querySelector: () => null,
        querySelectorAll: () => { scans += 1; return [element('+380676503011')]; }
      }
    });
    assert.equal(cached.getPhone(null), '+380676503011');
    assert.equal(scans, 1);
    cached.getPhone(null);
    cached.getPhone(null);
    assert.equal(scans, 1, '同一个联系人期间的定时刷新不该重扫整个页面');
    currentTitle = 'Anna Petrova';
    cached.getPhone(null);
    assert.equal(scans, 2, '换了联系人必须重扫');

    // 没找到时不缓存：否则用户后来点开联系人面板把号码露出来，我们会一直记着"上次没有"。
    let attempts = 0;
    let found = null;
    const late = phoneFinderModule({
      normalizePhone: fakeNormalize,
      getContactTitle: () => 'Ihor Petrenko',
      document: {
        querySelector: () => null,
        querySelectorAll: () => { attempts += 1; return found ? [element(found)] : []; }
      }
    });
    assert.equal(late.getPhone(null), null);
    found = '+380676503011';
    assert.equal(late.getPhone(null), '+380676503011', '号码后来才出现时必须能拿到');
    assert.equal(attempts, 2);
  });

  // 手动填写的号码是用户对着真实客户核对过的，页面扫描只是猜测。
  // 让猜测压过人工确认，那个输入框就等于摆设：用户改完还是看到错的号码。
  // 更糟的是原来"自动识别值回写"会把手动值冲掉，表现是"改完过一会儿又变回去"。
  await test('号码：手动填写的值压过自动识别，且不会被自动识别冲掉', async () => {
    // 只有自动识别值：照常显示，并写进 contactMap 当缓存。
    const auto = contactFactsModule({ detected: '5215500000000' });
    assert.equal(auto.contactApi.resolveContactFacts(null, { watContactMap: {} }).phone, '5215500000000');
    assert.deepEqual(plain(auto.writes), [{ watContactMap: { '客户 A': '5215500000000' } }]);

    // 自动识别值没变时不再重复写存储。
    const stable = contactFactsModule({ detected: '5215500000000' });
    stable.contactApi.resolveContactFacts(null, { watContactMap: { '客户 A': '5215500000000' } });
    assert.deepEqual(plain(stable.writes), [], '缓存里已经是同一个号码，不该再写一次');

    // 有手动值时：手动值赢，而且一个字节都不许回写 contactMap。
    const manual = contactFactsModule({ detected: '5215500000000' });
    const facts = manual.contactApi.resolveContactFacts(null, {
      watManualPhones: { '客户 A': '8613800000000' },
      watContactMap: {}
    });
    assert.equal(facts.phone, '8613800000000', '手动值必须压过页面扫描值');
    assert.deepEqual(plain(manual.writes), [], '有手动值时不许再写 contactMap，否则手动值会被冲掉');

    // 页面没扫到号码时，手动值照样生效。
    const manualOnly = contactFactsModule({ detected: null });
    assert.equal(manualOnly.contactApi.resolveContactFacts(null, {
      watManualPhones: { '客户 A': '8613800000000' }
    }).phone, '8613800000000');

    // 换到别的联系人，手动值不该串台。
    const other = contactFactsModule({ title: '客户 B', detected: '5215599999999' });
    assert.equal(other.contactApi.resolveContactFacts(null, {
      watManualPhones: { '客户 A': '8613800000000' }
    }).phone, '5215599999999');
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
