
(() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  const DEFAULTS = {
    enabled: true,
    triggerCount: 3,
    triggerTimeout: 1500,
    direction: "auto",     // auto | zh2en | en2zh
    disabledSites: []      // array of hostnames
  };

  let cfg = { ...DEFAULTS };
  let active = false;

  const HOST = location.hostname.replace(/^www\./, "");

  function siteDisabled(list) {
    return (list || []).some(entry => {
      const clean = String(entry || "").trim().toLowerCase().replace(/^www\./, "");
      if (!clean) return false;
      return HOST === clean || HOST.endsWith("." + clean);
    });
  }

  function applyCfg(next) {
    cfg = { ...DEFAULTS, ...next };
    cfg.triggerCount = Math.min(5, Math.max(2, Number(cfg.triggerCount) || 3));
    active = cfg.enabled && !siteDisabled(cfg.disabledSites);
  }

  chrome.storage.local.get(DEFAULTS, applyCfg);

  // content script 只关心 DEFAULTS 里这几个键，但 chrome.storage.onChanged 会在
  // 任何键变化时触发。设置页保存、后台写 providerModelCache 等都会触发它，
  // 而这个脚本在每个标签页的每个 iframe 里都有一份，无差别重读会把无关的写入放大成
  // 全浏览器范围的 storage.get 风暴。这里只对真正相关的键做出反应。
  const WATCHED_KEYS = new Set(Object.keys(DEFAULTS));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!Object.keys(changes).some((key) => WATCHED_KEYS.has(key))) return;
    chrome.storage.local.get(DEFAULTS, applyCfg);
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  let busy = false;
  let spaceCount = 0;
  let lastSpaceAt = 0;
  let lastSpaceField = null;
  let requestSequence = 0;

  const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

  const preserveText = value => String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\r\n?/g, "\n")
    .trim();

  const normalize = value => preserveText(value)
    .replace(/\s+/g, " ");

  /**
   * Decide zh->en or en->zh.
   *
   * Rule: any Chinese ideograph means the user is composing Chinese and wants
   * English out. Foreign-trade Chinese almost always mixes in Incoterms and
   * model numbers ("CIF Rotterdam 报价"), so an English-character ratio would
   * misfire. Punctuation is excluded so that pasted English text containing a
   * full-width comma is not mistaken for Chinese.
   */
  function detectDirection(text) {
    if (cfg.direction === "zh2en" || cfg.direction === "en2zh") return cfg.direction;

    const ideographs = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(text);
    return ideographs ? "zh2en" : "en2zh";
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  function ensureStyle() {
    if (document.getElementById("__tl_style")) return;
    const style = document.createElement("style");
    style.id = "__tl_style";
    style.textContent = `
      @keyframes __tl_spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function showSpinner(target) {
    removeSpinner();
    ensureStyle();

    let rect;
    try {
      rect = target.getBoundingClientRect();
    } catch (_) {
      rect = { right: window.innerWidth - 20, top: 20, height: 20 };
    }

    const spinner = document.createElement("div");
    spinner.id = "__tl_spinner";
    spinner.setAttribute("aria-label", "TransMate translating");

    Object.assign(spinner.style, {
      position: "fixed",
      left: `${Math.min(window.innerWidth - 26, Math.max(8, rect.right - 30))}px`,
      top: `${Math.min(window.innerHeight - 26, Math.max(8, rect.top + (rect.height - 18) / 2))}px`,
      width: "18px",
      height: "18px",
      border: "2px solid rgba(128,128,128,.35)",
      borderTopColor: "#25D366",
      borderRadius: "50%",
      boxSizing: "border-box",
      pointerEvents: "none",
      zIndex: "2147483647",
      animation: "__tl_spin .7s linear infinite"
    });

    document.documentElement.appendChild(spinner);
  }

  function removeSpinner() {
    document.getElementById("__tl_spinner")?.remove();
  }

  function toast(message, kind = "error") {
    document.getElementById("__tl_toast")?.remove();

    const el = document.createElement("div");
    el.id = "__tl_toast";
    el.textContent = "TransMate：" + message;

    Object.assign(el.style, {
      position: "fixed",
      right: "20px",
      bottom: "24px",
      zIndex: "2147483647",
      maxWidth: "540px",
      padding: "11px 15px",
      borderRadius: "10px",
      background: kind === "error" ? "#991b1b" : kind === "info" ? "#334155" : kind === "warn" ? "#92400e" : "#065f46",
      color: "#fff",
      font: "13px/1.45 system-ui, -apple-system, Segoe UI, sans-serif",
      boxShadow: "0 8px 30px rgba(0,0,0,.28)",
      whiteSpace: "pre-wrap"
    });

    (document.body || document.documentElement).appendChild(el);
    setTimeout(
      () => el.remove(),
      kind === "error" ? 7000 : kind === "warn" ? 11000 : kind === "info" ? 3200 : 2500
    );
  }

  /**
   * 硬信息校验命中时提示用户核对。译文已经写进输入框了，这里只做提醒，
   * 不阻止写入——模型绝大多数时候是对的，误报也不该打断用户的流程。
   */
  function showWarnings(warnings) {
    const list = (warnings || []).map((item) => item?.message).filter(Boolean);
    if (!list.length) return;
    toast(`请核对译文里的关键信息：\n${list.map((line) => `· ${line}`).join("\n")}`, "warn");
  }

  // ---------------------------------------------------------------------------
  // Universal field detection
  // ---------------------------------------------------------------------------

  const TEXT_INPUT_TYPES = new Set([
    "text", "search", "email", "url", "tel", "", null, undefined
  ]);

  function isTextInput(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = node.tagName;

    if (tag === "TEXTAREA") return !node.disabled && !node.readOnly;
    if (tag === "INPUT") {
      const type = (node.getAttribute("type") || "text").toLowerCase();
      return TEXT_INPUT_TYPES.has(type) && !node.disabled && !node.readOnly;
    }
    return false;
  }

  function isEditable(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    const attr = node.getAttribute?.("contenteditable");
    return attr === "" || attr === "true" || attr === "plaintext-only";
  }

  /**
   * Resolve the real editing target. Uses composedPath() so fields inside
   * Shadow DOM (web components, many SaaS backends) resolve correctly.
   */
  function findField(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];

    for (const node of path) {
      if (isTextInput(node) || isEditable(node)) return node;
      if (node === document) break;
    }

    let node = event.target;
    while (node && node !== document.body && node.nodeType === Node.ELEMENT_NODE) {
      if (isTextInput(node) || isEditable(node)) return node;
      node = node.parentElement || node.getRootNode?.()?.host;
    }

    const activeEl = document.activeElement;
    if (isTextInput(activeEl) || isEditable(activeEl)) return activeEl;

    return null;
  }

  function readField(field) {
    if (isTextInput(field)) return preserveText(field.value);
    return preserveText(field.innerText || field.textContent || "");
  }

  // ---------------------------------------------------------------------------
  // Writing — input/textarea path
  // ---------------------------------------------------------------------------

  /**
   * Write target for this control.
   *
   * A single-line <input> sanitises CR/LF out of its value, so a multi-line
   * translation would be written but could never compare equal to what we sent
   * — the field would hold the right text while we reported a blocked write.
   * Collapse newlines to spaces up front and compare against the same string.
   */
  function textForField(field, text) {
    if (field?.tagName !== "INPUT") return text;
    return String(text).replace(/[\r\n]+/g, " ").trim();
  }

  /**
   * React/Vue keep their own copy of the value, so a plain `el.value = x`
   * gets reverted on the next render. Calling the native prototype setter
   * and then firing input+change makes the framework pick the change up.
   */
  function setNativeValue(field, value) {
    const proto = field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;

    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

    if (setter) setter.call(field, value);
    else field.value = value;
  }

  async function writeToInput(field, text, expectedCurrent = null) {
    field.focus({ preventScroll: true });

    try {
      field.select?.();
      if (document.execCommand("insertText", false, text)) {
        await sleep(80);
        if (normalize(field.value) === normalize(text)) return true;
        if (expectedCurrent !== null && preserveText(field.value) !== preserveText(expectedCurrent)) return false;
      }
    } catch (_) {}

    try {
      if (expectedCurrent !== null && preserveText(field.value) !== preserveText(expectedCurrent)) return false;
      setNativeValue(field, text);
      field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      field.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

      try {
        const end = text.length;
        field.setSelectionRange?.(end, end);
      } catch (_) {}

      await sleep(80);
      return normalize(field.value) === normalize(text);
    } catch (_) {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Writing — contenteditable path (3-level fallback, kept from v1.0.2)
  // ---------------------------------------------------------------------------

  function selectAll(field) {
    field.focus({ preventScroll: true });

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(field);

    selection.removeAllRanges();
    selection.addRange(range);
  }

  async function insertViaExecCommand(field, text) {
    selectAll(field);
    try {
      document.execCommand("insertText", false, text);
    } catch (_) {
      return false;
    }
    await sleep(150);
    return normalize(readField(field)) === normalize(text);
  }

  async function insertViaPasteEvent(field, text) {
    selectAll(field);

    let transfer;
    try {
      transfer = new DataTransfer();
      transfer.setData("text/plain", text);
    } catch (_) {
      return false;
    }

    try {
      field.dispatchEvent(new InputEvent("beforeinput", {
        inputType: "insertFromPaste",
        dataTransfer: transfer,
        bubbles: true, cancelable: true, composed: true
      }));
      field.dispatchEvent(new ClipboardEvent("paste", {
        clipboardData: transfer,
        bubbles: true, cancelable: true, composed: true
      }));
    } catch (_) {
      return false;
    }

    await sleep(220);
    return normalize(readField(field)) === normalize(text);
  }

  async function insertViaDom(field, text) {
    try {
      selectAll(field);

      const selection = window.getSelection();
      const range = selection.getRangeAt(0);
      range.deleteContents();

      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.setEndAfter(node);

      selection.removeAllRanges();
      selection.addRange(range);

      field.dispatchEvent(new InputEvent("input", {
        inputType: "insertText", data: text,
        bubbles: true, composed: true
      }));
    } catch (_) {
      return false;
    }

    await sleep(150);
    return normalize(readField(field)) === normalize(text);
  }

  // ---------------------------------------------------------------------------
  // Focus + clipboard (fix carried over from v1.0.2)
  // ---------------------------------------------------------------------------

  async function ensureFocused(field, timeout = 1200) {
    try { window.focus(); } catch (_) {}
    try { field?.focus({ preventScroll: true }); } catch (_) {}

    if (document.hasFocus()) return true;

    return new Promise(resolve => {
      const done = value => {
        clearTimeout(timer);
        clearInterval(poll);
        window.removeEventListener("focus", onFocus, true);
        resolve(value);
      };
      const onFocus = () => done(true);
      const timer = setTimeout(() => done(document.hasFocus()), timeout);
      const poll = setInterval(() => { if (document.hasFocus()) done(true); }, 100);
      window.addEventListener("focus", onFocus, true);
    });
  }

  async function copyToClipboard(text, field) {
    try {
      await ensureFocused(field);
      if (navigator.clipboard?.writeText && document.hasFocus()) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {}

    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      Object.assign(textarea.style, {
        position: "fixed", top: "0", left: "0",
        width: "1px", height: "1px", opacity: "0", pointerEvents: "none"
      });

      document.body.appendChild(textarea);
      const previous = document.activeElement;
      textarea.focus({ preventScroll: true });
      textarea.select();
      textarea.setSelectionRange(0, text.length);

      const ok = document.execCommand("copy");
      textarea.remove();
      try { previous?.focus?.({ preventScroll: true }); } catch (_) {}

      return ok;
    } catch (_) {
      return false;
    }
  }

  async function writeField(field, text, expectedCurrent = null) {
    if (!field?.isConnected && field?.isConnected !== undefined) return false;
    if (expectedCurrent !== null && readField(field) !== preserveText(expectedCurrent)) return false;
    await ensureFocused(field);
    field.focus({ preventScroll: true });
    await sleep(60);
    if (expectedCurrent !== null && readField(field) !== preserveText(expectedCurrent)) return false;

    const target = textForField(field, text);

    if (isTextInput(field)) return writeToInput(field, target, expectedCurrent);

    if (await insertViaExecCommand(field, target)) return true;
    if (readField(field) !== preserveText(expectedCurrent)) return false;
    if (await insertViaPasteEvent(field, target)) return true;
    if (readField(field) !== preserveText(expectedCurrent)) return false;
    if (await insertViaDom(field, target)) return true;

    return false;
  }

  // ---------------------------------------------------------------------------
  // Main flow
  // ---------------------------------------------------------------------------

  async function translate(field) {
    // 触发时如果上一条还在翻译，以前是直接 return：用户连按三次空格却什么都没发生，
    // 也看不到任何反馈，会以为扩展坏了。这里明确告诉他原因。
    if (busy) {
      toast("上一条还在翻译中，请稍候再试", "info");
      return;
    }

    const source = readField(field);

    if (!source) {
      toast("输入框没有可翻译内容");
      return;
    }

    const requestId = ++requestSequence;
    const context = HOST === "web.whatsapp.com" ? "chat" : "field";
    busy = true;
    showSpinner(field);

    try {
      const direction = detectDirection(source);

      const result = await chrome.runtime.sendMessage({
        type: "TL_TRANSLATE",
        text: source,
        direction,
        context
      });

      if (!result?.ok) throw new Error(result?.error || "翻译失败");

      const output = preserveText(result.text);
      if (!output) throw new Error("翻译结果为空");
      if (requestId !== requestSequence || readField(field) !== source) {
        const copied = await copyToClipboard(output, field);
        throw new Error(copied
          ? "输入框内容已变化，未覆盖新内容；译文已复制到剪贴板。"
          : "输入框内容已变化，未覆盖新内容。译文：\n" + output);
      }

      if (await writeField(field, output, source)) {
        showWarnings(result.warnings);
        return;
      }

      const copied = await copyToClipboard(output, field);
      throw new Error(
        copied
          ? "页面阻止了自动写入或内容已变化。译文已复制到剪贴板，请按 Ctrl+V 粘贴。"
          : "页面阻止了自动写入或内容已变化，且剪贴板不可用。译文：\n" + output
      );
    } catch (error) {
      toast(error?.message || String(error));
    } finally {
      removeSpinner();
      busy = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Trigger — consecutive spaces
  // ---------------------------------------------------------------------------

  document.addEventListener("keydown", event => {
    if (!active || event.isComposing || event.keyCode === 229) return;

    const field = findField(event);

    if (!field) {
      spaceCount = 0;
      lastSpaceField = null;
      return;
    }

    if (event.key === " " || event.code === "Space") {
      if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
      const now = Date.now();

      if (field !== lastSpaceField || now - lastSpaceAt > cfg.triggerTimeout) spaceCount = 0;

      lastSpaceField = field;
      lastSpaceAt = now;
      spaceCount += 1;

      if (spaceCount >= cfg.triggerCount) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        spaceCount = 0;
        lastSpaceAt = 0;
        lastSpaceField = null;

        translate(field);
      }
      return;
    }

    spaceCount = 0;
    lastSpaceAt = 0;
    lastSpaceField = null;
  }, true);

})();
