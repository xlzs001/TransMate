
importScripts("providers.js");
importScripts("verify.js");

const DEFAULT_MODEL = "gemini-3.5-flash-lite";

async function getCfg() {
  const settings = await chrome.storage.local.get({
    provider: "",
    providerConfigs: {},
    apiKey: "",
    model: DEFAULT_MODEL,
    translationProfile: "immersive",
    customerLanguage: "auto"
  });
  // 没存过 provider 的老用户（v2.x 只存过 apiKey）继续沿用 Gemini，
  // 避免升级后已配置好的服务被静默换成免费档。新装用户则用免费档。
  if (!settings.provider) settings.provider = settings.apiKey ? "gemini" : "googlefree";
  const legacyProfiles = {
    adaptive: "immersive",
    chat: "friend-casual",
    business: "business-english",
    technical: "warehouse-equipment"
  };
  const migratedProfile = legacyProfiles[settings.translationProfile];
  if (migratedProfile) {
    settings.translationProfile = migratedProfile;
    chrome.storage.local.set({ translationProfile: migratedProfile }).catch(() => {});
  }
  return settings;
}

function getProviderConfig(settings, override) {
  if (override?.providerId) {
    const preset = TLP_PROVIDER_PRESETS[override.providerId];
    if (!preset) throw new Error("未知翻译服务");
    return { id: override.providerId, ...preset, ...(override.config || {}) };
  }
  const id = settings.provider || "gemini";
  const preset = TLP_PROVIDER_PRESETS[id] || TLP_PROVIDER_PRESETS.gemini;
  const saved = settings.providerConfigs?.[id] || {};
  const legacy = id === "gemini" ? { apiKey: settings.apiKey, model: settings.model } : {};
  return { id, ...preset, ...legacy, ...saved };
}

function requireProviderConfig(provider) {
  // Google 免费接口内置了多个官方域名，地址留空时按默认域名轮询，不视为配置缺失。
  if (!provider.baseUrl && provider.adapter !== "googlefree") throw new Error(`请填写 ${provider.label} 的 API 地址`);
  if (!provider.apiKeyOptional && !provider.apiKey) throw new Error(`请填写 ${provider.label} 的 API Key`);
  if (!TLP_ADAPTERS_WITHOUT_MODEL.includes(provider.adapter) && !provider.model) {
    throw new Error(`请填写 ${provider.label} 的模型名称`);
  }
}

async function fetchText(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("翻译请求超时，请稍后重试");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// 服务商报错时经常直接甩回一整页 HTML（Cloudflare 502、网关拦截页、登录页等），
// 原样塞进错误消息会变成几千字的 toast，把真正的信息淹没，还会撑破弹窗。
const MAX_ERROR_CHARS = 300;
function trimProviderError(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= MAX_ERROR_CHARS) return text;
  return `${text.slice(0, MAX_ERROR_CHARS)}…（已截断，原始响应共 ${text.length} 字符）`;
}

async function fetchJson(url, options = {}, timeoutMs = 30000) {
  const { ok, status, text } = await fetchText(url, options, timeoutMs);
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) {}
  if (!ok) {
    const message = trimProviderError(data?.error?.message || data?.message || text || `HTTP ${status}`);
    throw new Error(`${message} (${status})`);
  }
  return data;
}

function openAIEndpoint(baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return /\/chat\/completions(?:\?|$)/.test(base) ? base : `${base}/chat/completions`;
}

function authHeaders(provider) {
  const headers = { "Content-Type": "application/json" };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  return headers;
}

// Azure 把模型名写在地址的 /deployments/<名字>/ 段里，请求体的 model 字段是空的，
// 所以要判断它是不是 GPT-5 / o 系列，只能从地址里把这个名字取出来。
function azureDeploymentName(baseUrl) {
  const match = String(baseUrl || "").match(/\/deployments\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : "";
}

// 这个模型在请求里的真实名字：Azure 藏在地址里，其他服务用 model 字段。
function effectiveModelName(provider) {
  const name = provider.adapter === "azure"
    ? azureDeploymentName(provider.baseUrl)
    : String(provider.model || "");
  // OpenRouter、硅基流动等会在模型名前加厂商前缀（openai/gpt-5、Qwen/Qwen3-8B）。
  // 不剥掉前缀，推理模型就会被当成普通模型，发 max_tokens + temperature 直接 400。
  return name.split("/").pop().trim();
}

// GPT-5 与 o 系列只认 max_completion_tokens，且不接受 temperature。
function isReasoningOnlyModel(provider) {
  return /^(?:gpt-5|o[134](?:-|$))/i.test(effectiveModelName(provider));
}

function usesCompletionTokenBudget(provider) {
  if (provider.id === "openai") return true;
  return isReasoningOnlyModel(provider);
}

// 推理模型必须省掉 temperature，其余模型必须带上：漏掉会让服务端用默认温度（通常 1.0），
// 同一句话每次翻译出来的结果都不一样，用户会以为"翻译不稳定"。
function applyTokenBudget(body, provider, maxOutputTokens, temperature) {
  if (usesCompletionTokenBudget(provider)) body.max_completion_tokens = maxOutputTokens;
  else body.max_tokens = maxOutputTokens;
  if (!isReasoningOnlyModel(provider)) body.temperature = temperature;
  return body;
}

function openAIRequestBody(provider, prompt, maxOutputTokens, temperature) {
  const body = applyTokenBudget({
    model: provider.model,
    messages: [{ role: "user", content: prompt }]
  }, provider, maxOutputTokens, temperature);
  // 个别服务需要额外的请求字段（例如 DeepSeek 关闭思考模式）。
  // 只在对应预设里声明，避免把别人不认识的字段发给其他服务导致 400。
  if (provider.extraBody && typeof provider.extraBody === "object") {
    Object.assign(body, provider.extraBody);
  }
  return body;
}

function extractOpenAIText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => part?.text || part?.content || "").join("").trim();
  }
  return "";
}

const DEEPL_TARGETS = {
  "zh": "ZH-HANS", "zh-CN": "ZH-HANS", "zh-TW": "ZH-HANT",
  en: "EN", es: "ES", fr: "FR", de: "DE", pt: "PT-PT", ru: "RU",
  uk: "UK", it: "IT", nl: "NL", pl: "PL", cs: "CS", ro: "RO",
  bg: "BG", hu: "HU", el: "EL", sv: "SV", da: "DA", fi: "FI",
  no: "NB", tr: "TR", id: "ID", ja: "JA", ko: "KO"
};

function deepLFormality(profileId, context = "field") {
  if (["business", "technical", "business-english", "foreign-trade", "warehouse-equipment"].includes(profileId)) return "prefer_more";
  if (["chat", "sales", "friend-casual", "friend-warm", "friend-humor"].includes(profileId) || (["adaptive", "immersive"].includes(profileId) && context === "chat")) {
    return "prefer_less";
  }
  return null;
}

function estimateOutputTokens(text, minimum = 800, maximum = 6000) {
  const inputLength = String(text || "").length;
  return Math.min(maximum, Math.max(minimum, Math.ceil(inputLength * 1.8)));
}

// 服务商因安全策略拒答时不会返回任何内容，如果只判断"返回为空"，
// 用户会看到"XX 没有返回翻译结果"这种误导性提示，不知道是内容被拦了。
const SAFETY_FINISH_REASONS = new Set([
  "SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "IMAGE_SAFETY",
  "content_filter", "refusal"
]);

function throwIfIncomplete(provider, data) {
  let reason = "";
  if (provider.adapter === "gemini") {
    reason = data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason || "";
  } else if (provider.adapter === "anthropic") reason = data?.stop_reason || "";
  else reason = data?.choices?.[0]?.finish_reason || "";
  if (["MAX_TOKENS", "max_tokens", "length"].includes(reason)) {
    throw new Error("AI 返回内容达到长度上限，为避免覆盖成不完整内容，请缩短文本后重试");
  }
  if (SAFETY_FINISH_REASONS.has(reason)) {
    throw new Error("服务商判定这段内容触发了安全策略，拒绝翻译。请换个说法，或改用其他翻译服务。");
  }
}

async function callProvider(provider, {
  prompt,
  sourceText,
  targetCode,
  maxOutputTokens = 800,
  temperature = 0.1,
  translationProfile = "immersive",
  context = "field"
}) {
  requireProviderConfig(provider);

  if (provider.adapter === "gemini") {
    const base = String(provider.baseUrl).replace(/\/+$/, "");
    const url = `${base}/models/${encodeURIComponent(provider.model)}:generateContent?key=${encodeURIComponent(provider.apiKey)}`;
    const data = await fetchJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature, maxOutputTokens }
      })
    });
    throwIfIncomplete(provider, data);
    return data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim() || "";
  }

  if (provider.adapter === "anthropic") {
    const url = `${String(provider.baseUrl).replace(/\/+$/, "")}/messages`;
    const data = await fetchJson(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": provider.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: maxOutputTokens,
        temperature,
        messages: [{ role: "user", content: prompt }]
      })
    });
    throwIfIncomplete(provider, data);
    return data?.content?.map((part) => part?.text || "").join("").trim() || "";
  }

  if (provider.adapter === "deepl") {
    const target = DEEPL_TARGETS[targetCode] || DEEPL_TARGETS[String(targetCode || "").split("-")[0]];
    if (!target) throw new Error(`DeepL 暂不支持目标语言：${targetCode}`);
    const url = `${String(provider.baseUrl).replace(/\/+$/, "")}/translate`;
    const body = new URLSearchParams({ text: sourceText, target_lang: target });
    const formality = deepLFormality(translationProfile, context);
    if (formality) body.set("formality", formality);
    const profileContext = translationProfileInstruction(translationProfile, context);
    if (profileContext) body.set("context", profileContext);
    const data = await fetchJson(url, {
      method: "POST",
      headers: {
        Authorization: `DeepL-Auth-Key ${provider.apiKey}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });
    return data?.translations?.[0]?.text?.trim() || "";
  }

  if (provider.adapter === "googlefree") {
    return translateWithGoogleFree(provider, sourceText, targetCode);
  }

  if (provider.adapter === "azure") {
    // Azure 上部署的也可能是 GPT-5 / o 系列，那些模型不认 max_tokens 和 temperature，
    // 用错了会直接 400，所以这里和 OpenAI 走同一套判断。
    const body = applyTokenBudget(
      { messages: [{ role: "user", content: prompt }] },
      provider,
      maxOutputTokens,
      temperature
    );
    const data = await fetchJson(provider.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": provider.apiKey },
      body: JSON.stringify(body)
    });
    throwIfIncomplete(provider, data);
    return extractOpenAIText(data);
  }

  const data = await fetchJson(openAIEndpoint(provider.baseUrl), {
    method: "POST",
    headers: authHeaders(provider),
    body: JSON.stringify(openAIRequestBody(provider, prompt, maxOutputTokens, temperature))
  });
  throwIfIncomplete(provider, data);
  return extractOpenAIText(data);
}

// ---------------------------------------------------------------------------
// Google 网页翻译（免费接口，无需 API Key）
//
// translate_a/single 是 Google 网页端自用的非公开接口，实测要点：
//   - 重复传 q 只会翻译第一条，所以批量必须按条请求，不能拼 q。
//   - 返回结构 [[[译文, 原文, ...], ...], null, "检测到的源语言", ...]，长文本会自动切成多段。
//   - 约 2900 字符仍可返回；这里取保守的分块上限。
//   - 按出口 IP 限流（429），且国内需代理才能访问；多域名依次重试可提高成功率。
// 该接口不受 Google 官方支持，可能随时变动，因此只作为免费档，不承担付费承诺。
// ---------------------------------------------------------------------------

const GOOGLE_FREE_HOSTS = [
  "https://translate.googleapis.com",
  "https://translate.google.com",
  "https://clients5.google.com"
];

// 目标语言代码基本沿用 BCP-47，仅少数需要归一化。
const GOOGLE_FREE_TARGETS = {
  zh: "zh-CN",
  "zh-Hans": "zh-CN",
  "zh-Hant": "zh-TW",
  he: "iw",
  no: "no",
  nb: "no"
};

const GOOGLE_FREE_CHUNK_LIMIT = 1200;
// 单次请求超时。20 秒对一次翻译来说过长：域名被代理黑洞时会一直挂着，
// 串行重试三个域名最坏要等一分钟。这里收紧，并用并行探测兜底。
const GOOGLE_FREE_FIRST_TIMEOUT = 6000;
const GOOGLE_FREE_RACE_TIMEOUT = 10000;

// 记住上次成功的域名：正常情况下只发一个请求，不必每次重新探测。
let googleFreePreferredHost = "";
let googleFreePreferredLoaded = false;

async function googleFreePreferredHostName() {
  if (!googleFreePreferredLoaded) {
    googleFreePreferredLoaded = true;
    try {
      const stored = await chrome.storage.session.get("googleFreeHost");
      googleFreePreferredHost = String(stored?.googleFreeHost || "");
    } catch (_) {}
  }
  return googleFreePreferredHost;
}

function rememberGoogleFreeHost(host) {
  // 正常情况下每次翻译都会命中同一个域名，无脑写 session storage 等于给每次翻译
  // 多加一次存储写入；只在域名真的变了的时候写。
  if (googleFreePreferredHost === host) return;
  googleFreePreferredHost = host;
  try { chrome.storage.session.set({ googleFreeHost: host })?.catch(() => {}); } catch (_) {}
}

function googleFreeHosts(provider) {
  const configured = String(provider?.baseUrl || "").replace(/\/+$/, "");
  if (!configured) return [...GOOGLE_FREE_HOSTS];
  return [configured, ...GOOGLE_FREE_HOSTS.filter((host) => host !== configured)];
}

function googleFreeTarget(targetCode) {
  const code = String(targetCode || "").trim();
  return GOOGLE_FREE_TARGETS[code] || code || "en";
}

/** 按换行优先、句末标点次之的顺序切块，尽量不切在句子中间。 */
function splitGoogleFreeChunks(text, limit = GOOGLE_FREE_CHUNK_LIMIT) {
  const source = String(text || "");
  if (source.length <= limit) return source ? [source] : [];

  const chunks = [];
  let current = "";
  const flush = () => { if (current) chunks.push(current); current = ""; };

  for (const piece of source.split(/(\n+)/)) {
    if (!piece) continue;
    if (current.length + piece.length <= limit) {
      current += piece;
      continue;
    }
    flush();
    if (piece.length <= limit) {
      current = piece;
      continue;
    }
    let rest = piece;
    while (rest.length > limit) {
      const window = rest.slice(0, limit);
      const cut = Math.max(
        window.lastIndexOf("。"), window.lastIndexOf("！"), window.lastIndexOf("？"),
        window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "),
        window.lastIndexOf("；"), window.lastIndexOf("; ")
      );
      const size = cut > limit / 2 ? cut + 1 : limit;
      chunks.push(rest.slice(0, size));
      rest = rest.slice(size);
    }
    current = rest;
  }
  flush();
  return chunks;
}

function googleFreeNetworkHint(error) {
  const message = String(error?.message || error || "");
  if (/Failed to fetch|NetworkError|Load failed|net::|ERR_/i.test(message)) {
    return "连接不上 Google 翻译：当前网络或代理节点访问不到 translate.googleapis.com。请检查代理规则，或改用需要 API Key 的服务。";
  }
  return message || "Google 翻译接口不可用";
}

async function tryGoogleFreeHost(host, query, timeoutMs) {
  try {
    const { ok, status, text: body } = await fetchText(`${host}/translate_a/single?${query}`, {}, timeoutMs);
    if (!ok) {
      return {
        ok: false,
        error: status === 429
          ? "Google 翻译限流（HTTP 429）：当前出口 IP 请求过于频繁，请稍后重试或更换节点。"
          : `Google 翻译返回 HTTP ${status}。`
      };
    }
    const trimmed = body.trim();
    if (!trimmed.startsWith("[")) {
      return { ok: false, error: "Google 翻译返回了验证页面：当前节点暂时不可用，请更换节点或稍后重试。" };
    }
    const data = JSON.parse(trimmed);
    const segments = Array.isArray(data?.[0]) ? data[0] : [];
    const output = segments
      .map((segment) => (Array.isArray(segment) ? segment[0] || "" : ""))
      .join("")
      .trim();
    if (!output) return { ok: false, error: "Google 翻译没有返回译文。" };
    return { ok: true, text: output };
  } catch (error) {
    return { ok: false, error: googleFreeNetworkHint(error) };
  }
}

async function requestGoogleFree(provider, text, targetCode) {
  const params = new URLSearchParams({
    client: "gtx",
    sl: "auto",
    tl: googleFreeTarget(targetCode),
    dt: "t",
    q: text
  });
  // URLSearchParams 会把空格编成 "+"，该接口对 "+" 的处理并不明确，统一用 %20。
  const query = params.toString().replace(/\+/g, "%20");

  const hosts = googleFreeHosts(provider);
  const preferred = await googleFreePreferredHostName();
  const ordered = preferred && hosts.includes(preferred)
    ? [preferred, ...hosts.filter((host) => host !== preferred)]
    : hosts;

  // 先用上次成功的域名单发：正常情况只产生一个请求。
  const first = await tryGoogleFreeHost(ordered[0], query, GOOGLE_FREE_FIRST_TIMEOUT);
  if (first.ok) {
    rememberGoogleFreeHost(ordered[0]);
    return first.text;
  }

  // 失败后并行探测其余域名，避免逐个等超时（最坏情况从 3 次超时降到 1 次）。
  const others = ordered.slice(1);
  if (!others.length) throw new Error(first.error);

  try {
    const winner = await Promise.any(others.map(async (host) => {
      const result = await tryGoogleFreeHost(host, query, GOOGLE_FREE_RACE_TIMEOUT);
      if (!result.ok) throw new Error(result.error);
      return { host, text: result.text };
    }));
    rememberGoogleFreeHost(winner.host);
    return winner.text;
  } catch (_) {
    throw new Error(first.error);
  }
}

/** 长文本按块翻译后拼回；原本以换行结尾的块用换行衔接，其余用空格。 */
async function translateWithGoogleFree(provider, text, targetCode) {
  const chunks = splitGoogleFreeChunks(text);
  if (!chunks.length) throw new Error("没有可翻译的内容");

  const pieces = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const translated = await requestGoogleFree(provider, chunks[index], targetCode);
    if (index > 0) pieces.push(/\n\s*$/.test(chunks[index - 1]) ? "\n" : " ");
    pieces.push(translated);
  }
  return pieces.join("").trim();
}

/** 免费接口不支持拼 q 批量，按条并发（并发 4，兼顾速度与 IP 限流）。 */
async function translateGoogleFreeBatch(provider, items, targetCode) {
  const results = [];
  const concurrency = 4;

  for (let index = 0; index < items.length; index += concurrency) {
    const group = items.slice(index, index + concurrency);
    results.push(...await Promise.all(group.map(async (item) => {
      try {
        const text = await translateWithGoogleFree(provider, item.text, targetCode);
        return { id: item.clientId, text: String(text || "").trim(), warnings: TLP_VERIFY.verifyTranslation(item.text, text) };
      } catch (error) {
        return { id: item.clientId, text: "", error };
      }
    })));
  }

  const translated = results.filter((item) => item.text);
  if (!translated.length) throw new Error(googleFreeNetworkHint(results[0]?.error));
  return translated.map(({ id, text, warnings }) => ({ id, text, warnings }));
}

const LANGUAGE_NAMES = {
  ar: "Arabic", bn: "Bengali", bg: "Bulgarian", cs: "Czech", da: "Danish",
  de: "German", el: "Greek", en: "English", es: "Spanish", et: "Estonian",
  fa: "Persian", fi: "Finnish", fr: "French", he: "Hebrew", hi: "Hindi",
  hr: "Croatian", hu: "Hungarian", id: "Indonesian", it: "Italian", ja: "Japanese",
  ko: "Korean", lv: "Latvian", lt: "Lithuanian", ms: "Malay", nl: "Dutch",
  no: "Norwegian", pl: "Polish", pt: "Portuguese", ro: "Romanian", ru: "Russian",
  sk: "Slovak", sl: "Slovenian", sr: "Serbian", sv: "Swedish", ta: "Tamil",
  th: "Thai", tl: "Filipino", tr: "Turkish", uk: "Ukrainian", ur: "Urdu",
  vi: "Vietnamese", zh: "Chinese"
};

const TARGET_LANGUAGE_NAMES = {
  ...LANGUAGE_NAMES,
  "zh-CN": "Simplified Chinese",
  "zh-TW": "Traditional Chinese",
  ca: "Catalan", af: "Afrikaans", am: "Amharic", as: "Assamese",
  gu: "Gujarati", hy: "Armenian", ka: "Georgian", km: "Khmer", lo: "Lao",
  kn: "Kannada", ml: "Malayalam", mr: "Marathi", my: "Burmese", ne: "Nepali", pa: "Punjabi",
  ps: "Pashto", si: "Sinhala", sw: "Swahili", te: "Telugu", ug: "Uyghur"
};

const TRANSLATION_PROFILES = {
  immersive: {
    field: "Act as a context-aware native translator in the style of an immersive translation expert. Produce accurate, fluent, idiomatic text with no machine-translated feel. Preserve terminology, structure and formatting when they carry meaning.",
    chat: "Act as a context-aware native translator for instant messages. Preserve the sender's intent, relationship, emotion, politeness and conversational rhythm; use natural spoken language and never sound like a formal letter unless the source does."
  },
  adaptive: {
    field: "Act as a context-aware native translator. Produce accurate, fluent and concise wording appropriate to the text's actual context.",
    chat: "Use natural, concise conversational wording suitable for a real-time chat. Match the sender's level of formality."
  },
  literal: {
    field: "Translate faithfully and closely. Preserve sentence structure, emphasis, ambiguity, terminology and formatting where possible; do not embellish, soften or infer missing facts.",
    chat: "Translate faithfully and closely. Preserve tone, ambiguity, names and message structure; do not rewrite for style."
  },
  paraphrase: {
    field: "First understand the literal meaning, then express it as fluent native-language prose. Improve clarity and idiomatic flow without adding, deleting or changing facts.",
    chat: "Understand the literal meaning, then rewrite it as a natural native chat message while preserving intent, tone and every factual detail."
  },
  "friend-casual": {
    field: "Use relaxed everyday language appropriate between friends. Keep sentences short and natural; preserve greetings, nicknames, emojis, slang and conversational markers.",
    chat: "Sound like a real friend chatting: casual, concise and natural. Preserve emojis, slang and the sender's degree of familiarity; avoid business or ceremonial wording."
  },
  "friend-warm": {
    field: "Use warm, caring and friendly everyday language without exaggerating emotion or adding promises not present in the source.",
    chat: "Use a warm and approachable friend-to-friend tone. Preserve emotion and politeness without becoming overly enthusiastic or inventing intimacy."
  },
  "friend-humor": {
    field: "Preserve jokes, wordplay, playful exaggeration and informal rhythm using a culturally natural equivalent. Never invent a joke when none exists.",
    chat: "Keep the message light and playful. Adapt jokes, slang and teasing naturally while preserving intent and avoiding offensive wording not present in the source."
  },
  "business-english": {
    field: "Use polished, concise professional business wording in the requested target language, following native business conventions. When the target is English, prefer clear active sentences suitable for emails, meetings, reports and professional correspondence.",
    chat: "Use concise professional business-chat wording in the requested target language. When the target is English, use natural business English; remain polite and clear without turning short messages into formal letters."
  },
  "foreign-trade": {
    field: "Act as a senior international-trade translator. Use precise terminology for inquiries, quotations, MOQ, samples, lead time, payment terms, contracts, customs, documentation, freight and Incoterms. Preserve all commercial facts exactly.",
    chat: "Use concise professional foreign-trade chat language. Accurately handle inquiry, quotation, MOQ, price, sample, production, payment, shipping, customs and Incoterms terminology without adding commitments."
  },
  business: {
    field: "Use professional, courteous international-business wording suitable for quotations, delivery, payment and customer follow-up.",
    chat: "Use professional and courteous business-chat wording while keeping short messages brief."
  },
  technical: {
    field: "Prioritize technical precision and terminology consistency for specifications, materials, drawings, models, dimensions and units.",
    chat: "Prioritize technical precision and terminology consistency while keeping the message readable as a chat response."
  },
  sales: {
    field: "Use warm, confident and service-oriented foreign-trade sales wording, but never add promises, discounts, urgency or facts absent from the source.",
    chat: "Use friendly, positive and helpful sales-chat wording, but never add promises, discounts, urgency or facts absent from the source."
  },
  "warehouse-equipment": {
    field: "Act as a warehouse and material-handling equipment translator. Use precise, consistent terminology for pallet racking, shelving, mezzanines, cantilever racks, drive-in racks, AS/RS, conveyors, forklifts, pallets, beams, uprights, bracing, load capacity, dimensions, tolerances, steel grades, surface treatment, layout, installation and safety standards. Preserve model numbers, units and technical parameters exactly.",
    chat: "Use concise professional warehouse-equipment terminology for customer discussions. Accurately preserve rack type, bay and level configuration, load capacity, dimensions, pallet and forklift data, materials, coatings, drawings, installation and safety requirements."
  }
};

function translationProfileInstruction(profileId, context = "field") {
  const profile = TRANSLATION_PROFILES[profileId] || TRANSLATION_PROFILES.immersive;
  return profile[context === "chat" ? "chat" : "field"];
}

const PROMPTS = {
  zh2en: (text, targetLanguage, profileInstruction) => `You are an expert multilingual translator.

Translate the following Chinese message into ${targetLanguage}.

Selected translation style:
${profileInstruction}

Requirements:
- Preserve the exact meaning.
- Do not add information not present in the Chinese.
- Preserve numbers, prices, currencies, models, dimensions and Incoterms accurately.
- Use natural ${targetLanguage} appropriate to the selected style.
- Correctly handle international trade, quotation, payment, shipping, warehousing racks, sheet metal and machinery terminology.
- If the Chinese sentence is short, keep the translation short.
- Output ONLY the final ${targetLanguage} translation.
- No explanation, heading, quotation marks or markdown.

Chinese:
${text}`,

  en2zh: (text, expectedLanguage, profileInstruction) => `You are an expert multilingual translator.

Identify the source language and translate the following customer message into accurate Chinese. The expected customer language is ${expectedLanguage}, but trust the actual text if it differs.

Selected translation style:
${profileInstruction}

Requirements:
- Preserve the exact meaning.
- Do not add information not present in the source.
- Preserve numbers, prices, currencies, models, dimensions and Incoterms accurately.
- Keep Incoterms (FOB, CIF, EXW...), product model numbers and units in their original form.
- Correctly handle international trade, quotation, payment, shipping, warehousing racks, sheet metal and machinery terminology.
- Use natural Chinese appropriate to the selected style.
- If the source sentence is short, keep the Chinese short.
- Output ONLY the final Chinese translation.
- No explanation, heading, quotation marks or markdown.

Customer message:
${text}`
};

const contactSessionKey = (tabId) => Number.isInteger(tabId) ? `watCurrentTab_${tabId}` : "watCurrent";

// ---------------------------------------------------------------------------
// 输入框翻译结果缓存
//
// 只缓存确定性引擎（同一输入必得同一输出）。AI 服务故意不缓存：用户可能希望
// 重新生成一次。缓存键包含服务、接口地址、模型、翻译专家、场景、目标语言和原文，
// 任一项变化都会重新请求。
// ---------------------------------------------------------------------------
const CACHEABLE_ADAPTERS = new Set(["googlefree", "deepl"]);
const TRANSLATION_CACHE_LIMIT = 200;
const translationCache = new Map();

function translationCacheKey(provider, settings, targetCode, context, text) {
  return [
    provider.id,
    provider.baseUrl || "",
    provider.model || "",
    settings.translationProfile || "",
    context,
    targetCode,
    text
  ].join("\u0000");
}

function readTranslationCache(key) {
  if (!translationCache.has(key)) return "";
  const value = translationCache.get(key);
  translationCache.delete(key);
  translationCache.set(key, value);
  return value;
}

function writeTranslationCache(key, value) {
  if (translationCache.has(key)) translationCache.delete(key);
  translationCache.set(key, value);
  while (translationCache.size > TRANSLATION_CACHE_LIMIT) {
    translationCache.delete(translationCache.keys().next().value);
  }
}

async function resolveCustomerLanguage(config, tabId) {
  const key = contactSessionKey(tabId);
  const stored = await chrome.storage.session.get([key, "watCurrent"]);
  const current = Number.isInteger(tabId) ? stored[key] : stored.watCurrent;
  const detected = current?.detectedLanguage;
  if (detected?.manual && detected?.promptName) {
    return { code: detected.code || "en", name: detected.promptName };
  }

  let code = config.customerLanguage || "auto";
  if (code === "auto") {
    if (detected?.promptName) {
      return { code: detected.code || "en", name: detected.promptName };
    }
    code = detected?.code || "en";
  }
  return { code, name: TARGET_LANGUAGE_NAMES[code] || LANGUAGE_NAMES.en };
}

async function translate(text, direction, tabId, context = "field") {
  const s = await getCfg();
  const provider = getProviderConfig(s);
  const build = PROMPTS[direction] || PROMPTS.zh2en;
  const customerLanguage = await resolveCustomerLanguage(s, tabId);
  const target = direction === "en2zh"
    ? { code: "zh-CN", name: "Chinese" }
    : customerLanguage;
  const normalizedContext = context === "chat" ? "chat" : "field";

  // 重复翻译同一句话时直接命中缓存，省掉整次网络往返。
  const cacheKey = CACHEABLE_ADAPTERS.has(provider.adapter)
    ? translationCacheKey(provider, s, target.code, normalizedContext, text)
    : "";
  if (cacheKey) {
    const cached = readTranslationCache(cacheKey);
    if (cached) {
      return { text: cached, targetLanguage: target.code, cached: true, warnings: TLP_VERIFY.verifyTranslation(text, cached) };
    }
  }

  const profileInstruction = translationProfileInstruction(s.translationProfile, normalizedContext);
  const prompt = build(text, customerLanguage.name, profileInstruction);
  const output = await callProvider(provider, {
    prompt,
    sourceText: text,
    targetCode: target.code,
    maxOutputTokens: estimateOutputTokens(text, 2048, 8000),
    translationProfile: s.translationProfile,
    context: normalizedContext
  });
  if (!output) throw new Error(`${provider.label} 没有返回翻译结果`);
  if (cacheKey) writeTranslationCache(cacheKey, output);
  return { text: output, targetLanguage: target.code, warnings: TLP_VERIFY.verifyTranslation(text, output) };
}

function buildChatTranslationPrompt(text, targetName, profileId = "immersive") {
  const profileInstruction = translationProfileInstruction(profileId, "chat");
  return `You are an expert multilingual translator.

Identify the source language and translate the following WhatsApp message into natural, accurate ${targetName}.

Selected translation style:
${profileInstruction}

Requirements:
- Preserve the exact meaning and tone.
- Preserve names, numbers, prices, currencies, model numbers, dimensions, units and Incoterms accurately.
- Correctly handle quotation, payment, shipping, warehouse rack, sheet metal and machinery terminology.
- Do not translate URLs, email addresses, file names or standalone model numbers.
- If the message is short, keep the translation short.
- Output ONLY the translated message.
- No explanation, heading, quotation marks or markdown.

WhatsApp message:
${text}`;
}

async function translateChat(text, targetCode) {
  const s = await getCfg();
  const provider = getProviderConfig(s);
  const targetName = TARGET_LANGUAGE_NAMES[targetCode] || TARGET_LANGUAGE_NAMES["zh-CN"];
  const prompt = buildChatTranslationPrompt(text, targetName, s.translationProfile);
  const output = await callProvider(provider, {
    prompt,
    sourceText: text,
    targetCode,
    translationProfile: s.translationProfile,
    context: "chat"
  });
  if (!output) throw new Error(`${provider.label} 没有返回翻译结果`);
  return { text: output, warnings: TLP_VERIFY.verifyTranslation(text, output) };
}

function parseBatchTranslationOutput(output) {
  let text = String(output || "").trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");
  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");
  let parsed;
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    parsed = JSON.parse(text.slice(arrayStart, arrayEnd + 1));
  } else if (objectStart >= 0 && objectEnd > objectStart) {
    parsed = JSON.parse(text.slice(objectStart, objectEnd + 1));
  } else {
    throw new Error("批量翻译返回格式不是 JSON");
  }
  const rows = Array.isArray(parsed) ? parsed : parsed?.translations;
  if (!Array.isArray(rows)) throw new Error("批量翻译缺少 translations 数组");
  return rows.map((row) => {
    if (!row || typeof row !== "object" || typeof row.id !== "string" || typeof row.text !== "string") {
      throw new Error("批量翻译包含无效项目");
    }
    return { id: row.id, text: row.text.trim() };
  });
}

async function translateChatBatch(items, targetCode) {
  const normalized = (Array.isArray(items) ? items : [])
    .slice(0, 16)
    .map((item, index) => ({
      id: String(index),
      clientId: String(item?.id || index),
      text: String(item?.text || "").trim()
    }))
    .filter((item) => item.text);
  if (!normalized.length) return [];

  const settings = await getCfg();
  const provider = getProviderConfig(settings);
  const targetName = TARGET_LANGUAGE_NAMES[targetCode] || TARGET_LANGUAGE_NAMES["zh-CN"];
  const profileInstruction = translationProfileInstruction(settings.translationProfile, "chat");

  if (provider.adapter === "googlefree") {
    requireProviderConfig(provider);
    return translateGoogleFreeBatch(provider, normalized, targetCode);
  }

  if (provider.adapter === "deepl") {
    requireProviderConfig(provider);
    const target = DEEPL_TARGETS[targetCode] || DEEPL_TARGETS[String(targetCode || "").split("-")[0]];
    if (!target) throw new Error(`DeepL 暂不支持目标语言：${targetCode}`);
    const body = new URLSearchParams({ target_lang: target });
    const formality = deepLFormality(settings.translationProfile, "chat");
    if (formality) body.set("formality", formality);
    if (profileInstruction) body.set("context", profileInstruction);
    normalized.forEach((item) => body.append("text", item.text));
    const data = await fetchJson(`${String(provider.baseUrl).replace(/\/+$/, "")}/translate`, {
      method: "POST",
      headers: {
        Authorization: `DeepL-Auth-Key ${provider.apiKey}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });
    return normalized.map((item, index) => {
      const text = String(data?.translations?.[index]?.text || "").trim();
      return { id: item.clientId, text, warnings: TLP_VERIFY.verifyTranslation(item.text, text) };
    }).filter((item) => item.text);
  }

  const payload = normalized.map(({ id, text }) => ({ id, text }));
  const prompt = `You are an expert multilingual translator.

Translate every item's text into natural, accurate ${targetName}.

Selected translation style:
${profileInstruction}

Requirements:
- Preserve meaning, tone, names, numbers, prices, currencies, models, dimensions, units and Incoterms.
- Correctly handle quotation, payment, shipping, warehouse rack, sheet metal and machinery terminology.
- Do not translate URLs, email addresses, file names or standalone model numbers.
- Return every input id exactly once and in the same order.
- Output ONLY valid JSON in this exact shape: [{"id":"0","text":"translation"}]
- No markdown fences and no explanation.

Input JSON:
${JSON.stringify(payload)}`;
  // Budget by source volume instead of item count: three long messages need far
  // more output tokens than twelve short ones, and a count-based budget silently
  // caps the long batch at a few hundred tokens.
  const sourceCharacters = normalized.reduce((sum, item) => sum + item.text.length, 0);
  const batchBudget = Math.min(8000, Math.max(1200, Math.ceil(sourceCharacters * 1.8)));

  let parsed;
  try {
    // The request stays inside the try so a truncated or malformed batch response
    // degrades to per-item retries instead of failing every message in the batch.
    const output = await callProvider(provider, {
      prompt,
      sourceText: JSON.stringify(payload),
      targetCode,
      maxOutputTokens: batchBudget,
      translationProfile: settings.translationProfile,
      context: "chat"
    });
    parsed = parseBatchTranslationOutput(output);
    const expectedIds = new Set(normalized.map((item) => item.id));
    const returnedIds = new Set();
    for (const item of parsed) {
      if (!expectedIds.has(item.id) || returnedIds.has(item.id) || !item.text) {
        throw new Error("批量翻译返回了重复、未知或空白项目");
      }
      returnedIds.add(item.id);
    }
    if (returnedIds.size !== expectedIds.size) throw new Error("批量翻译缺少部分项目");
  } catch (batchError) {
    const fallback = [];
    for (let index = 0; index < normalized.length; index += 4) {
      const group = normalized.slice(index, index + 4);
      const results = await Promise.all(group.map(async (item) => {
        try {
          const text = await callProvider(provider, {
            prompt: buildChatTranslationPrompt(item.text, targetName, settings.translationProfile),
            sourceText: item.text,
            targetCode,
            maxOutputTokens: estimateOutputTokens(item.text, 1000, 4000),
            translationProfile: settings.translationProfile,
            context: "chat"
          });
          return { id: item.clientId, text: String(text || "").trim(), warnings: TLP_VERIFY.verifyTranslation(item.text, text) };
        } catch (_) {
          return { id: item.clientId, text: "" };
        }
      }));
      fallback.push(...results.filter((item) => item.text));
    }
    if (!fallback.length) throw batchError;
    return fallback;
  }
  const byId = new Map(parsed.map((item) => [item.id, item.text]));
  return normalized.map((item) => {
    const text = byId.get(item.id) || "";
    return { id: item.clientId, text, warnings: TLP_VERIFY.verifyTranslation(item.text, text) };
  }).filter((item) => item.text);
}

function modelListEndpoint(provider) {
  const base = String(provider.baseUrl || "").replace(/\/+$/, "");
  return /\/chat\/completions(?:\?|$)/.test(base)
    ? base.replace(/\/chat\/completions(?:\?.*)?$/, "/models")
    : `${base}/models`;
}

function isTextGenerationModel(model) {
  const id = String(typeof model === "string" ? model : model?.id || model?.name || "").toLocaleLowerCase();
  if (!id) return false;
  return !/embed|embedding|rerank|moderation|image-generation|text-to-image|speech|tts|whisper|transcri|text-to-audio|text-to-video/.test(id);
}

async function listProviderModels(provider) {
  requireProviderConfig({ ...provider, model: provider.model || "model-list-placeholder" });
  if (TLP_ADAPTERS_WITHOUT_MODEL_LIST.includes(provider.adapter)) return [];

  if (provider.adapter === "gemini") {
    const base = String(provider.baseUrl).replace(/\/+$/, "");
    const data = await fetchJson(`${base}/models?key=${encodeURIComponent(provider.apiKey)}`);
    return (data?.models || [])
      .filter((item) => (!item.supportedGenerationMethods || item.supportedGenerationMethods.includes("generateContent")) && isTextGenerationModel(item))
      .map((item) => String(item.name || "").replace(/^models\//, ""))
      .filter(Boolean);
  }

  if (provider.adapter === "anthropic") {
    const data = await fetchJson(`${String(provider.baseUrl).replace(/\/+$/, "")}/models`, {
      headers: {
        "x-api-key": provider.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      }
    });
    return (data?.data || []).filter(isTextGenerationModel).map((item) => item?.id).filter(Boolean);
  }

  const data = await fetchJson(modelListEndpoint(provider), { headers: authHeaders(provider) });
  return (data?.data || data?.models || [])
    .filter(isTextGenerationModel)
    .map((item) => typeof item === "string" ? item : item?.id || item?.name)
    .filter(Boolean);
}

async function testProvider(provider) {
  const output = await callProvider(provider, {
    prompt: "Translate the following text into Simplified Chinese. Output only the translation: Connection successful",
    sourceText: "Connection successful",
    targetCode: "zh-CN"
  });
  if (!output) throw new Error(`${provider.label} 没有返回测试结果`);
  return output;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "WAT_CURRENT_CONTACT") {
    try {
      const payload = message.payload || null;
      const tabId = sender.tab?.id;
      const values = { watCurrent: payload };
      if (Number.isInteger(tabId)) values[contactSessionKey(tabId)] = payload;
      chrome.storage.session.set(values)?.catch(() => {});
    } catch (_) {}
    return;
  }

  if (message?.type === "TL_TRANSLATE") {
    translate(message.text, message.direction, sender.tab?.id, message.context)
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TL_CHAT_TRANSLATE") {
    translateChat(message.text, message.targetLanguage || "zh-CN")
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TL_CHAT_TRANSLATE_BATCH") {
    translateChatBatch(message.items, message.targetLanguage || "zh-CN")
      .then(items => sendResponse({ ok: true, items }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TL_TEST_PROVIDER") {
    Promise.resolve()
      .then(() => getProviderConfig({}, message))
      .then(testProvider)
      .then(text => sendResponse({ ok: true, text }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TL_LIST_MODELS") {
    Promise.resolve()
      .then(() => getProviderConfig({}, message))
      .then(listProviderModels)
      .then(models => sendResponse({ ok: true, models }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});
