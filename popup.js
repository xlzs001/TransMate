const DEFAULTS = {
  provider: "",
  providerConfigs: {},
  apiKey: "",
  enabled: true,
  triggerCount: 3,
  direction: "auto",
  customerLanguage: "auto",
  disabledSites: [],
  watEnabled: true,
  watChatTranslationEnabled: true,
  watChatShortcut: "Alt+Q"
};

const DIRECTION_LABELS = {
  auto: "自动判断翻译方向",
  zh2en: "中文 → 客户语言",
  en2zh: "客户语言 → 中文"
};

const $ = (id) => document.getElementById(id);
let host = "";
let config = { ...DEFAULTS };
const RESERVED_CHAT_SHORTCUTS = new Set([
  "ctrl+l", "ctrl+t", "ctrl+w", "ctrl+r", "ctrl+n", "ctrl+p", "ctrl+tab",
  "ctrl+shift+t", "ctrl+shift+n", "ctrl+shift+i",
  "ctrl+0", "ctrl+1", "ctrl+2", "ctrl+3", "ctrl+4", "ctrl+5", "ctrl+6", "ctrl+7", "ctrl+8", "ctrl+9",
  "alt+left", "alt+right", "alt+home", "alt+d", "alt+e", "alt+f",
  "meta+l", "meta+t", "meta+w", "meta+r"
]);

function siteDisabled() {
  return (config.disabledSites || []).some((entry) => {
    const clean = String(entry || "").trim().toLowerCase().replace(/^www\./, "");
    return clean && (host === clean || host.endsWith(`.${clean}`));
  });
}

function formatTime(timezone) {
  if (!timezone) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(new Date());
}

async function load() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
      const url = new URL(tab?.url || "");
      if (["http:", "https:"].includes(url.protocol)) host = url.hostname.replace(/^www\./, "");
    } catch (_) {
      // 当前标签页可能是 chrome:// 或扩展页，URL 构造不出来；此时保持 host 为空。
    }

    config = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
    // 与后台保持一致：老用户沿用 Gemini，新装用户默认免费档。
    if (!config.provider) config.provider = config.apiKey ? "gemini" : "googlefree";
    if (RESERVED_CHAT_SHORTCUTS.has(String(config.watChatShortcut).toLocaleLowerCase())) {
      config.watChatShortcut = DEFAULTS.watChatShortcut;
      await chrome.storage.local.set({ watChatShortcut: DEFAULTS.watChatShortcut });
    }
    const tabKey = Number.isInteger(tab?.id) ? `watCurrentTab_${tab.id}` : "watCurrent";
    const session = await chrome.storage.session.get([tabKey, "watCurrent"]);
    render(Number.isInteger(tab?.id) ? session[tabKey] : session.watCurrent);
  } catch (error) {
    if (!String(error?.message || error).includes("Extension context invalidated")) {
      console.error("TransMate popup:", error);
    }
  }
}

function render(current) {
  $("count").textContent = config.triggerCount || 3;
  $("direction").textContent = DIRECTION_LABELS[config.direction] || DIRECTION_LABELS.auto;
  $("host").textContent = host || "当前页面不可用";
  const preset = globalThis.TLP_PROVIDER_PRESETS?.[config.provider] || globalThis.TLP_PROVIDER_PRESETS?.gemini || {};
  const providerConfig = { ...preset, ...(config.providerConfigs?.[config.provider] || {}) };
  if (config.provider === "gemini" && !providerConfig.apiKey) providerConfig.apiKey = config.apiKey;
  $("providerName").textContent = preset.label || "翻译服务";
  const hasRequiredKey = Boolean(providerConfig.apiKey || preset.apiKeyOptional);
  const hasRequiredModel = TLP_ADAPTERS_WITHOUT_MODEL.includes(preset.adapter) || Boolean(providerConfig.model);
  $("apiWarning").hidden = Boolean(providerConfig.baseUrl && hasRequiredKey && hasRequiredModel);

  const off = !config.enabled || siteDisabled();
  const badge = $("translationBadge");
  badge.textContent = !config.enabled ? "全局关闭" : off ? "本站关闭" : "已启用";
  badge.className = `badge ${off ? "off" : "on"}`;
  $("siteToggle").textContent = !config.enabled ? "前往设置开启翻译" : off ? "为当前网站启用" : "为当前网站停用";
  $("siteToggle").disabled = !host;

  $("watEnabled").checked = config.watEnabled !== false;
  $("watChatTranslationEnabled").checked = config.watChatTranslationEnabled === true;
  $("chatShortcutLabel").textContent = config.watChatShortcut || "未设置";
  $("customerLanguage").value = config.customerLanguage || "auto";
  if (current?.region && current?.timezone) {
    $("contactName").textContent = current.title || "当前联系人";
    $("timeSummary").textContent = `${current.region}  当地时间：${formatTime(current.timezone)}`;
    const confidence = current.detectedLanguage?.manual
      ? "（手动）"
      : current.detectedLanguage?.confidence
        ? ` ${current.detectedLanguage.confidence}%`
        : "";
    const language = current.detectedLanguage?.name
      ? ` · 客户语言：${current.detectedLanguage.name}${confidence}`
      : "";
    $("timezoneMeta").textContent = `${current.phone} · ${current.timezone}${language}`;
  } else {
    $("contactName").textContent = current?.title || "请打开一个 WhatsApp 对话";
    $("timeSummary").textContent = current ? "地区未识别" : "等待识别";
    $("timezoneMeta").textContent = current ? "点击页面顶部标签可手动填写号码" : "号码归属地区与当地时间";
  }
}

$("siteToggle").addEventListener("click", () => {
  if (!config.enabled) return chrome.runtime.openOptionsPage();
  const list = [...(config.disabledSites || [])];
  if (siteDisabled()) {
    config.disabledSites = list.filter((entry) => {
      const clean = String(entry || "").trim().toLowerCase().replace(/^www\./, "");
      return !(host === clean || host.endsWith(`.${clean}`));
    });
  } else {
    config.disabledSites = [...new Set([...list, host])];
  }
  chrome.storage.local.set({ disabledSites: config.disabledSites }, load);
});

$("watEnabled").addEventListener("change", () => {
  config.watEnabled = $("watEnabled").checked;
  chrome.storage.local.set({ watEnabled: config.watEnabled });
});

$("watChatTranslationEnabled").addEventListener("change", () => {
  config.watChatTranslationEnabled = $("watChatTranslationEnabled").checked;
  chrome.storage.local.set({ watChatTranslationEnabled: config.watChatTranslationEnabled });
});

$("customerLanguage").addEventListener("change", () => {
  config.customerLanguage = $("customerLanguage").value;
  chrome.storage.local.set({ customerLanguage: config.customerLanguage });
});

for (const id of ["settings", "openSettings"]) {
  $(id).addEventListener("click", () => chrome.runtime.openOptionsPage());
}

chrome.storage.onChanged.addListener(() => { load(); });
load();
