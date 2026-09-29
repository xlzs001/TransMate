const DEFAULTS = {
  provider: "",
  providerConfigs: {},
  providerModelCache: {},
  apiKey: "",
  model: "gemini-3.5-flash-lite",
  enabled: true,
  triggerCount: 3,
  triggerTimeout: 1500,
  direction: "auto",
  translationProfile: "immersive",
  customerLanguage: "auto",
  disabledSites: [],
  watEnabled: true,
  watPosition: "status-line",
  watScale: 100,
  watTextColor: "#111b21",
  watAccentColor: "#008069",
  watOffsetX: 0,
  watOffsetY: 0,
  watChatTranslationEnabled: true,
  watChatTranslationTarget: "zh-CN",
  watChatTranslationMode: "bilingual",
  watChatTranslationScope: "all",
  watChatTranslationStyle: "plain",
  watChatTranslationTextColor: "#0b57d0",
  watChatTranslationBackground: "#eaf2ff",
  watChatTranslationFontSize: 13,
  watHideImmersiveTranslations: true,
  watChatShortcut: "Alt+Q",
  watPresenceIndicator: true
};

const APPEARANCE_DEFAULTS = {
  watPosition: "status-line",
  watScale: 100,
  watTextColor: "#111b21",
  watAccentColor: "#008069",
  watOffsetX: 0,
  watOffsetY: 0
};

const CHAT_DEFAULTS = {
  watChatTranslationTarget: "zh-CN",
  watChatTranslationMode: "bilingual",
  watChatTranslationScope: "all",
  watChatTranslationStyle: "plain",
  watChatTranslationTextColor: "#0b57d0",
  watChatTranslationBackground: "#eaf2ff",
  watChatTranslationFontSize: 13,
  watHideImmersiveTranslations: true,
  watChatShortcut: "Alt+Q"
};

const $ = (id) => document.getElementById(id);
const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};
const presets = globalThis.TLP_PROVIDER_PRESETS || {};
let providerConfigs = {};
let providerModelCache = {};
let activeProvider = "gemini";
let availableModels = [];
let providerGeneration = 0;
const providerActionSequence = { models: 0, test: 0 };
const LEGACY_TRANSLATION_PROFILES = {
  adaptive: "immersive",
  chat: "friend-casual",
  business: "business-english",
  technical: "warehouse-equipment"
};
const TRANSLATION_PROFILE_HELP = {
  immersive: "沉浸通用专家：结合上下文生成自然、准确且无机器翻译感的译文。",
  literal: "忠实直译专家：保留原句结构、语气、歧义、数字和术语，不主动改写。",
  paraphrase: "自然意译专家：在不改变事实的前提下重组表达，使译文更符合母语习惯。",
  "friend-casual": "朋友聊天专家：日常、简短、自然，保留称呼、语气词、表情和口语节奏。",
  "friend-warm": "亲切聊天专家：表达友好、温暖且自然，不擅自增加承诺或原文没有的情绪。",
  "friend-humor": "轻松幽默专家：保留玩笑、俚语和轻松语气，避免生硬直译与冒犯。",
  "business-english": "商务英语专家：使用清晰、礼貌、专业的邮件与即时沟通表达。",
  "foreign-trade": "专业外贸专家：准确处理询盘、报价、MOQ、付款、交期、单证、物流及 Incoterms。",
  sales: "外贸销售专家：表达积极、有服务感，适合跟进与促单，但不虚构折扣、承诺或紧迫性。",
  "warehouse-equipment": "仓储设备专家：针对货架、托盘、叉车、输送线、AS/RS、承载、尺寸、材料和安装术语优化。"
};

function setInlineStatus(message, kind = "") {
  const status = $("providerStatus");
  status.textContent = message;
  status.dataset.kind = kind;
}

function effectiveProviderConfig(id) {
  return { ...(presets[id] || presets.gemini || {}), ...(providerConfigs[id] || {}) };
}

function captureProviderDraft() {
  if (!activeProvider || !presets[activeProvider]) return;
  providerConfigs[activeProvider] = {
    apiKey: $("key").value.trim(),
    baseUrl: $("baseUrl").value.trim(),
    model: $("model").value.trim()
  };
}

function modelSuitability(model, providerId = activeProvider) {
  const id = String(model || "").toLocaleLowerCase();
  if (/embed|embedding|rerank|moderation|image-generation|text-to-image|speech|tts|whisper|transcri|text-to-audio|text-to-video/.test(id)) {
    return { score: -100, description: "非文本对话模型，不用于翻译" };
  }
  let score = 45;
  let description = "通用文本生成，可用于翻译";
  if (/translate|translation|mt\b/.test(id)) {
    score = 100;
    description = "翻译专用，优先推荐";
  } else if (/code|coder/.test(id)) {
    score = 20;
    description = "代码与技术内容优化";
  } else if (/flash|mini|lite|haiku|small|instant|turbo/.test(id)) {
    score = 88;
    description = "快速经济，适合聊天和日常翻译";
  } else if (/sonnet|plus|medium/.test(id)) {
    score = 84;
    description = "质量与速度均衡，适合商务翻译";
  } else if (/pro|opus|max|ultra|large/.test(id)) {
    score = 72;
    description = "质量优先，适合复杂专业内容";
  } else if (/reason|thinking|\br1\b|\bo1\b|\bo3\b/.test(id)) {
    score = 55;
    description = "推理型模型，翻译速度和成本通常较高";
  }
  const preferred = String(presets[providerId]?.model || "").toLocaleLowerCase();
  if (preferred && id === preferred) score = Math.max(score, 96);
  return { score, description };
}

function describeModel(model) {
  return modelSuitability(model).description;
}

function sortModelsForTranslation(models) {
  return [...new Set((models || []).map((model) => typeof model === "string" ? model : model?.id || model?.name).filter(Boolean))]
    .sort((a, b) => modelSuitability(b).score - modelSuitability(a).score || a.localeCompare(b));
}

function closeModelOptions() {
  $("providerModels").hidden = true;
  $("model").setAttribute("aria-expanded", "false");
  $("modelToggle").setAttribute("aria-expanded", "false");
}

function openModelOptions() {
  if (!availableModels.length || $("model").disabled) return;
  $("providerModels").hidden = false;
  $("model").setAttribute("aria-expanded", "true");
  $("modelToggle").setAttribute("aria-expanded", "true");
}

function chooseModel(model) {
  $("model").value = model;
  $("modelHelp").textContent = `${describeModel(model)}；已选择此模型，保存设置后生效。`;
  captureProviderDraft();
  renderModelOptions(availableModels);
  closeModelOptions();
}

function renderModelOptions(models) {
  availableModels = sortModelsForTranslation(models);
  const selectedModel = $("model").value.trim();
  const recommendedModels = new Set(availableModels.filter((model) => modelSuitability(model).score >= 84).slice(0, 3));
  $("providerModels").replaceChildren(...availableModels.map((model) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "model-option";
    option.dataset.model = model;
    option.dataset.recommended = String(recommendedModels.has(model));
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(model === selectedModel));
    const name = document.createElement("b");
    const recommended = recommendedModels.has(model);
    name.textContent = recommended ? `推荐 · ${model}` : model;
    const description = document.createElement("small");
    description.textContent = modelSuitability(model).description;
    option.append(name, description);
    option.addEventListener("click", () => chooseModel(model));
    return option;
  }));
  $("modelToggle").disabled = !availableModels.length || $("model").disabled;
  $("modelHelp").textContent = availableModels.length
    ? `已获取 ${availableModels.length} 个模型，点击输入框右侧箭头即可选择；也可手动填写模型 ID。`
    : "获取后可在当前输入框中展开并选择模型；每个模型会显示大致功能。";
  closeModelOptions();
}

function renderProvider() {
  const config = effectiveProviderConfig(activeProvider);
  $("provider").value = activeProvider;
  $("key").value = config.apiKey || "";
  $("baseUrl").value = config.baseUrl || "";
  $("model").value = config.model || "";
  const withoutModel = TLP_ADAPTERS_WITHOUT_MODEL.includes(config.adapter);
  $("model").disabled = withoutModel;
  $("model").placeholder = withoutModel ? "该服务不需要模型名称" : "填写模型名称，或填写 API Key 后点击获取模型";
  renderModelOptions(providerModelCache[activeProvider] || []);
  $("key").placeholder = config.apiKeyOptional ? "本机服务或免费接口可留空" : "粘贴所选服务的 API Key";
  const apiKeyApplyLink = $("apiKeyApplyLink");
  apiKeyApplyLink.hidden = !config.apiKeyUrl;
  apiKeyApplyLink.href = config.apiKeyUrl || "#";
  apiKeyApplyLink.textContent = config.apiKeyActionLabel || `申请 ${config.label || "API"} Key ↗`;
  apiKeyApplyLink.setAttribute("aria-label", `${apiKeyApplyLink.textContent.replace(/\s*↗$/, "")}（新窗口打开）`);
  $("listModels").disabled = TLP_ADAPTERS_WITHOUT_MODEL_LIST.includes(config.adapter);
  $("providerHelp").textContent = `${config.styleNote ? config.styleNote + " " : ""}${config.help || ""} API Key 只保存在本机浏览器。`;
  setInlineStatus("");
}

function updatePreview() {
  const scale = Number($("watScale").value);
  const preview = $("watPreview");
  preview.style.color = $("watTextColor").value;
  preview.style.transform = `scale(${scale / 100})`;
  preview.querySelector("b").style.color = $("watAccentColor").value;
  $("watScaleValue").value = `${scale}%`;
  const position = $("watPosition").value;
  $("positionHint").textContent = position === "custom"
    ? "保存后可在 WhatsApp 页面直接拖动标签。"
    : position === "status-line"
      ? "显示在“在线/最后上线时间”后方，采用24小时制。"
      : "可使用水平、垂直微调进行精确定位。";
}

function updateChatPreview() {
  const panel = $("chatPreviewTranslation");
  const message = panel.closest(".mock-message");
  const original = message.querySelector(".mock-original");
  const mode = $("watChatTranslationMode").value;
  const style = $("watChatTranslationStyle").value;
  original.hidden = mode === "translation";
  panel.hidden = mode === "original";
  panel.style.color = $("watChatTranslationTextColor").value;
  panel.style.fontSize = `${$("watChatTranslationFontSize").value}px`;
  panel.style.background = style === "background" ? $("watChatTranslationBackground").value : "transparent";
  panel.style.borderTop = style === "underline"
    ? `1px solid ${$("watChatTranslationTextColor").value}`
    : style === "dashed"
      ? `1px dashed ${$("watChatTranslationTextColor").value}`
      : "0";
  $("watChatTranslationFontSizeValue").value = `${$("watChatTranslationFontSize").value}px`;
}

function updateTranslationProfileHelp() {
  const profile = $("translationProfile").value;
  $("translationProfileHelp").textContent = TRANSLATION_PROFILE_HELP[profile] || TRANSLATION_PROFILE_HELP.immersive;
}

function shortcutFromKeyboardEvent(event) {
  const code = String(event.code || "");
  const codeAliases = {
    Space: "Space", Slash: "/", Backslash: "\\", Semicolon: ";", Quote: "'",
    Comma: ",", Period: ".", Minus: "-", Equal: "=", Backquote: "`",
    BracketLeft: "[", BracketRight: "]"
  };
  const key = /^Key[A-Z]$/.test(code)
    ? code.slice(3)
    : /^Digit[0-9]$/.test(code)
      ? code.slice(5)
      : codeAliases[code] || (event.key === " " ? "Space" : event.key);
  if (["Control", "Alt", "AltGraph", "Shift", "Meta"].includes(key)) return null;
  if (!event.ctrlKey && !event.altKey && !event.metaKey) return null;
  const parts = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Meta");
  const normalizedKey = key.length === 1 ? key.toUpperCase() : key;
  parts.push(normalizedKey);
  return parts.join("+");
}

const BROWSER_RESERVED_SHORTCUTS = new Set([
  "ctrl+l", "ctrl+t", "ctrl+w", "ctrl+r", "ctrl+n", "ctrl+p",
  "ctrl+shift+t", "ctrl+shift+n", "ctrl+shift+i", "ctrl+tab",
  "ctrl+0", "ctrl+1", "ctrl+2", "ctrl+3", "ctrl+4", "ctrl+5", "ctrl+6", "ctrl+7", "ctrl+8", "ctrl+9",
  "alt+left", "alt+right", "alt+home", "alt+d", "alt+e", "alt+f",
  "meta+l", "meta+t", "meta+w", "meta+r"
]);

function setShortcutHint(message, kind = "") {
  $("shortcutHint").textContent = message;
  $("shortcutHint").dataset.kind = kind;
}

async function ensureEndpointPermission(baseUrl) {
  let parsed;
  try { parsed = new URL(baseUrl); } catch (_) { throw new Error("API 地址格式不正确"); }
  const permissions = { origins: [`${parsed.origin}/*`] };
  if (await chrome.permissions.contains(permissions)) return true;
  const granted = await chrome.permissions.request(permissions);
  if (!granted) throw new Error(`需要授权访问 ${parsed.origin}`);
  return true;
}

function currentProviderPayload() {
  captureProviderDraft();
  return { providerId: activeProvider, config: providerConfigs[activeProvider] };
}

async function runProviderAction(kind) {
  const button = kind === "models" ? $("listModels") : $("testProvider");
  const original = button.textContent;
  const requestProvider = activeProvider;
  const requestGeneration = providerGeneration;
  const actionId = ++providerActionSequence[kind];
  button.disabled = true;
  button.textContent = kind === "models" ? "获取中…" : "测试中…";
  setInlineStatus("");
  try {
    const payload = currentProviderPayload();
    await ensureEndpointPermission(payload.config.baseUrl);
    const response = await chrome.runtime.sendMessage({
      type: kind === "models" ? "TL_LIST_MODELS" : "TL_TEST_PROVIDER",
      ...payload
    });
    if (!response?.ok) throw new Error(response?.error || "服务没有返回结果");
    if (kind === "models") {
      const models = sortModelsForTranslation(response.models || []);
      if (!models.length) throw new Error("该服务不支持读取模型列表，请手动填写模型名称");
      providerModelCache[requestProvider] = models;
      await chrome.storage.local.set({ providerModelCache });
      if (activeProvider === requestProvider && requestGeneration === providerGeneration && actionId === providerActionSequence[kind]) {
        renderModelOptions(models);
        openModelOptions();
        setInlineStatus(`已获取 ${models.length} 个模型，请直接点击候选项完成选择。`, "success");
      }
    } else if (activeProvider === requestProvider && requestGeneration === providerGeneration && actionId === providerActionSequence[kind]) {
      setInlineStatus(`连接成功，测试结果：${response.text}`, "success");
    }
  } catch (error) {
    if (activeProvider === requestProvider && requestGeneration === providerGeneration && actionId === providerActionSequence[kind]) {
      setInlineStatus(error.message || String(error), "error");
    }
  } finally {
    // 这里只能用 actionId 判断，不能把 providerGeneration 也算进去：
    // providerGeneration 会在用户切换服务商时自增，而"测试连接"请求还在飞。
    // 那样 finally 的条件不成立，按钮就永远停在禁用状态、文字停在"测试中…"，
    // 用户必须先刷新设置页才能再点一次。
    if (actionId === providerActionSequence[kind]) {
      button.textContent = original;
      button.disabled = kind === "models"
        && TLP_ADAPTERS_WITHOUT_MODEL_LIST.includes(effectiveProviderConfig(activeProvider).adapter);
    }
  }
}

async function loadSettings() {
  const settings = await chrome.storage.local.get(DEFAULTS);
  providerConfigs = { ...(settings.providerConfigs || {}) };
  providerModelCache = { ...(settings.providerModelCache || {}) };
  if (!providerConfigs.gemini && (settings.apiKey || settings.model)) {
    providerConfigs.gemini = {
      apiKey: settings.apiKey || "",
      baseUrl: presets.gemini.baseUrl,
      model: settings.model || presets.gemini.model
    };
  }
  // 与后台保持一致：老用户沿用 Gemini，新装用户默认免费档。
  activeProvider = presets[settings.provider]
    ? settings.provider
    : (settings.apiKey ? "gemini" : "googlefree");
  $("provider").replaceChildren(...Object.entries(presets).map(([id, preset]) => {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = preset.label;
    return option;
  }));
  renderProvider();

  $("enabled").checked = settings.enabled !== false;
  $("direction").value = settings.direction || "auto";
  const savedProfile = LEGACY_TRANSLATION_PROFILES[settings.translationProfile] || settings.translationProfile;
  const translationProfile = TRANSLATION_PROFILE_HELP[savedProfile]
    ? savedProfile
    : DEFAULTS.translationProfile;
  $("translationProfile").value = translationProfile;
  if (translationProfile !== settings.translationProfile) {
    await chrome.storage.local.set({ translationProfile });
  }
  $("customerLanguage").value = settings.customerLanguage || "auto";
  $("triggerCount").value = settings.triggerCount || 3;
  $("triggerTimeout").value = settings.triggerTimeout || 1500;
  $("disabledSites").value = (settings.disabledSites || []).join("\n");
  $("watEnabled").checked = settings.watEnabled !== false;
  for (const key of Object.keys(APPEARANCE_DEFAULTS)) $(key).value = settings[key] ?? APPEARANCE_DEFAULTS[key];

  $("watChatTranslationEnabled").checked = settings.watChatTranslationEnabled === true;
  for (const key of Object.keys(CHAT_DEFAULTS)) {
    if ($(key).type === "checkbox") $(key).checked = settings[key] !== false;
    else $(key).value = settings[key] ?? CHAT_DEFAULTS[key];
  }
  $("watPresenceIndicator").checked = settings.watPresenceIndicator !== false;
  if (BROWSER_RESERVED_SHORTCUTS.has($("watChatShortcut").value.toLocaleLowerCase())) {
    const oldShortcut = $("watChatShortcut").value;
    $("watChatShortcut").value = CHAT_DEFAULTS.watChatShortcut;
    await chrome.storage.local.set({ watChatShortcut: CHAT_DEFAULTS.watChatShortcut });
    setShortcutHint(`${oldShortcut} 被浏览器占用，已自动更换为 ${CHAT_DEFAULTS.watChatShortcut}。`, "error");
  }
  updatePreview();
  updateChatPreview();
  updateTranslationProfileHelp();
}

$("provider").addEventListener("change", () => {
  captureProviderDraft();
  providerGeneration += 1;
  activeProvider = $("provider").value;
  renderProvider();
});
$("listModels").addEventListener("click", () => runProviderAction("models"));
$("testProvider").addEventListener("click", () => runProviderAction("test"));
$("modelToggle").addEventListener("click", () => {
  if ($("providerModels").hidden) openModelOptions();
  else closeModelOptions();
});
$("model").addEventListener("focus", openModelOptions);
$("model").addEventListener("input", () => {
  const model = $("model").value.trim();
  const matched = availableModels.includes(model);
  $("modelHelp").textContent = matched
    ? `${describeModel(model)}；已选择此模型，保存设置后生效。`
    : "当前为手动填写的模型 ID；也可以点击右侧箭头选择已获取的模型。";
  if (availableModels.length) openModelOptions();
});
$("model").addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModelOptions();
  if (event.key === "ArrowDown" && availableModels.length) {
    event.preventDefault();
    openModelOptions();
    $("providerModels").querySelector(".model-option")?.focus();
  }
});
$("providerModels").addEventListener("keydown", (event) => {
  const options = [...$("providerModels").querySelectorAll(".model-option")];
  const index = options.indexOf(document.activeElement);
  if (event.key === "ArrowDown" && options.length) {
    event.preventDefault();
    options[(index + 1 + options.length) % options.length].focus();
  } else if (event.key === "ArrowUp" && options.length) {
    event.preventDefault();
    options[(index - 1 + options.length) % options.length].focus();
  } else if (event.key === "Escape") {
    closeModelOptions();
    $("model").focus();
  }
});
document.addEventListener("click", (event) => {
  if (!$("modelCombobox").contains(event.target)) closeModelOptions();
});

for (const id of ["watPosition", "watScale", "watTextColor", "watAccentColor", "watOffsetX", "watOffsetY"]) {
  $(id).addEventListener("input", updatePreview);
}
for (const id of [
  "watChatTranslationMode", "watChatTranslationStyle", "watChatTranslationTextColor",
  "watChatTranslationBackground", "watChatTranslationFontSize"
]) {
  $(id).addEventListener("input", updateChatPreview);
}
$("translationProfile").addEventListener("change", updateTranslationProfileHelp);

$("resetAppearance").addEventListener("click", () => {
  for (const [key, value] of Object.entries(APPEARANCE_DEFAULTS)) $(key).value = value;
  updatePreview();
});

let shortcutRecordingActive = false;
let shortcutBeforeRecording = "";

function beginShortcutRecording() {
  if (!shortcutRecordingActive) shortcutBeforeRecording = $("watChatShortcut").value;
  shortcutRecordingActive = true;
  $("watChatShortcut").dataset.recording = "true";
  $("watChatShortcut").select();
  setShortcutHint("录制中：先按住 Alt、Ctrl 或 Meta，再按另一个键。按 Esc 取消。", "");
}

function endShortcutRecording() {
  shortcutRecordingActive = false;
  delete $("watChatShortcut").dataset.recording;
}

function handleShortcutRecording(event) {
  if (!shortcutRecordingActive) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.key === "Escape") {
    $("watChatShortcut").value = shortcutBeforeRecording;
    endShortcutRecording();
    $("watChatShortcut").blur();
    setShortcutHint("已取消快捷键录制。", "");
    return;
  }
  if (["Backspace", "Delete"].includes(event.key)) {
    $("watChatShortcut").value = "";
    endShortcutRecording();
    $("watChatShortcut").blur();
    setShortcutHint("快捷键已清除；保存后将停用快捷键。", "success");
    return;
  }
  const shortcut = shortcutFromKeyboardEvent(event);
  if (!shortcut) {
    const held = [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Meta"]
      .filter(Boolean).join("+");
    setShortcutHint(held ? `已按下 ${held}，请继续按另一个键。` : "请先按住 Alt、Ctrl 或 Meta。", "");
    return;
  }
  if (BROWSER_RESERVED_SHORTCUTS.has(shortcut.toLocaleLowerCase())) {
    setShortcutHint(`${shortcut} 已被浏览器占用，请换一个组合键。`, "error");
    return;
  }
  $("watChatShortcut").value = shortcut;
  endShortcutRecording();
  $("watChatShortcut").blur();
  setShortcutHint(`已录制 ${shortcut}，保存后生效。`, "success");
}

window.addEventListener("keydown", handleShortcutRecording, true);
$("watChatShortcut").addEventListener("focus", beginShortcutRecording);
$("watChatShortcut").addEventListener("click", beginShortcutRecording);
document.addEventListener("pointerdown", (event) => {
  if (shortcutRecordingActive && event.target !== $("watChatShortcut")) endShortcutRecording();
});
$("resetChatShortcut").addEventListener("click", () => {
  endShortcutRecording();
  $("watChatShortcut").value = "Alt+Q";
  setShortcutHint("已恢复 Alt+Q，保存后生效。", "success");
});

$("save").addEventListener("click", async () => {
  const status = $("status");
  try {
    captureProviderDraft();
    const endpoint = providerConfigs[activeProvider]?.baseUrl;
    if (endpoint) await ensureEndpointPermission(endpoint);
    const sites = $("disabledSites").value
      .split("\n")
      .map((line) => line.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""))
      .filter(Boolean);
    const gemini = { ...presets.gemini, ...(providerConfigs.gemini || {}) };
    const values = {
      provider: activeProvider,
      providerConfigs,
      apiKey: gemini.apiKey || "",
      model: gemini.model || presets.gemini.model,
      enabled: $("enabled").checked,
      direction: $("direction").value,
      translationProfile: $("translationProfile").value,
      customerLanguage: $("customerLanguage").value,
      triggerCount: clamp($("triggerCount").value, 2, 5, 3),
      triggerTimeout: clamp($("triggerTimeout").value, 500, 5000, 1500),
      disabledSites: [...new Set(sites)],
      watEnabled: $("watEnabled").checked,
      watPosition: $("watPosition").value,
      watScale: clamp($("watScale").value, 75, 170, 100),
      watTextColor: $("watTextColor").value,
      watAccentColor: $("watAccentColor").value,
      watOffsetX: clamp($("watOffsetX").value, -400, 400, 0),
      watOffsetY: clamp($("watOffsetY").value, -300, 300, 0),
      watChatTranslationEnabled: $("watChatTranslationEnabled").checked,
      watChatTranslationTarget: $("watChatTranslationTarget").value,
      watChatTranslationMode: $("watChatTranslationMode").value,
      watChatTranslationScope: $("watChatTranslationScope").value,
      watChatTranslationStyle: $("watChatTranslationStyle").value,
      watChatTranslationTextColor: $("watChatTranslationTextColor").value,
      watChatTranslationBackground: $("watChatTranslationBackground").value,
      watChatTranslationFontSize: clamp($("watChatTranslationFontSize").value, 10, 22, 13),
      watHideImmersiveTranslations: $("watHideImmersiveTranslations").checked,
      watChatShortcut: $("watChatShortcut").value.trim(),
      watPresenceIndicator: $("watPresenceIndicator").checked
    };
    await chrome.storage.local.set(values);
    $("triggerCount").value = values.triggerCount;
    $("triggerTimeout").value = values.triggerTimeout;
    $("disabledSites").value = values.disabledSites.join("\n");
    status.dataset.kind = "success";
    status.textContent = "设置已保存并立即生效";
    setTimeout(() => { status.textContent = ""; delete status.dataset.kind; }, 2200);
  } catch (error) {
    status.dataset.kind = "error";
    status.textContent = `保存失败：${error.message || error}`;
  }
});

loadSettings().catch((error) => {
  $("status").dataset.kind = "error";
  $("status").textContent = `读取设置失败：${error.message || error}`;
});
