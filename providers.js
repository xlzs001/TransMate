// 适配器能力声明：background / options / popup 三处都要判断，集中在此避免漏改。
// 无模型名概念的适配器
// Azure 的模型由 API 地址里的 /deployments/<名字>/ 决定，请求体里不发 model 字段，
// 所以不能要求用户填模型名（漏掉它会让 Azure 直接报"请填写模型名称"而无法使用）。
globalThis.TLP_ADAPTERS_WITHOUT_MODEL = Object.freeze(["deepl", "googlefree", "azure"]);
// 不支持读取模型列表的适配器
globalThis.TLP_ADAPTERS_WITHOUT_MODEL_LIST = Object.freeze(["deepl", "azure", "googlefree"]);

globalThis.TLP_PROVIDER_PRESETS = Object.freeze({
  googlefree: {
    label: "Google 翻译（免费）",
    adapter: "googlefree",
    baseUrl: "https://translate.googleapis.com",
    model: "",
    apiKeyOptional: true,
    styleNote: "Google 网页翻译是纯机器翻译，不接收「AI 翻译专家」指令。",
    help: "使用 Google 网页翻译接口，无需 API Key。按出口 IP 限流；国内需代理才能访问。"
  },
  glmfree: {
    label: "智谱 GLM-4.7-Flash（免费）",
    adapter: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4.7-flash",
    apiKeyUrl: "https://open.bigmodel.cn/",
    help: "国内可直连、不需要代理的免费模型。注册智谱开放平台后，在「API Keys」页创建一个 Key 填到这里即可。翻译质量优于机器翻译，且支持「AI 翻译专家」指令。"
  },
  gemini: {
    label: "Google Gemini",
    adapter: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-3.5-flash-lite",
    apiKeyUrl: "https://aistudio.google.com/apikey",
    help: "使用 Google AI Studio API Key。"
  },
  openai: {
    label: "OpenAI",
    adapter: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5-mini",
    apiKeyUrl: "https://platform.openai.com/settings/organization/api-keys",
    help: "使用 OpenAI API Key，兼容 Chat Completions。"
  },
  anthropic: {
    label: "Anthropic Claude",
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-5",
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    help: "使用 Anthropic API Key 和 Messages API。"
  },
  deepseek: {
    label: "DeepSeek",
    adapter: "openai",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-flash",
    // DeepSeek V4 默认开启思考模式（effort 默认 high）：翻译一句话会先输出整段思维链，
    // 既慢又贵，还会挤占 max_tokens 导致译文被截断。翻译用不到思考，这里显式关闭。
    // 只有 DeepSeek 认这个字段，所以只在本预设声明，避免发给其他服务时 400。
    extraBody: { thinking: { type: "disabled" } },
    apiKeyUrl: "https://platform.deepseek.com/",
    help: "OpenAI 兼容接口。已默认关闭思考模式，让翻译更快更省。"
  },
  groq: {
    label: "Groq",
    adapter: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    apiKeyUrl: "https://console.groq.com/keys",
    help: "OpenAI 兼容接口，响应速度较快。"
  },
  openrouter: {
    label: "OpenRouter",
    adapter: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "google/gemini-2.5-flash-lite",
    apiKeyUrl: "https://openrouter.ai/",
    help: "一个 Key 可选择多个厂商模型。"
  },
  qwen: {
    label: "阿里云百炼 / Qwen",
    adapter: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    apiKeyUrl: "https://bailian.console.aliyun.com/",
    help: "使用 DashScope OpenAI 兼容接口。"
  },
  glm: {
    label: "智谱 GLM（自选模型）",
    adapter: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4.7-flash",
    apiKeyUrl: "https://open.bigmodel.cn/",
    help: "使用智谱开放平台 API Key，模型名可自行修改（如换成 glm-4-plus 等更强的付费模型）。只想用免费模型请选「智谱 GLM-4.7-Flash（免费）」。"
  },
  siliconflow: {
    label: "硅基流动",
    adapter: "openai",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "Qwen/Qwen3-8B",
    apiKeyUrl: "https://cloud.siliconflow.cn/",
    help: "OpenAI 兼容接口，模型名称可自行修改。"
  },
  azure: {
    label: "Azure OpenAI",
    adapter: "azure",
    baseUrl: "",
    model: "",
    apiKeyUrl: "https://learn.microsoft.com/en-us/azure/api-management/api-management-authenticate-authorize-ai-apis",
    help: "接口地址请填写到 chat/completions，并包含 api-version。"
  },
  deepl: {
    label: "DeepL",
    adapter: "deepl",
    baseUrl: "https://api-free.deepl.com/v2",
    model: "",
    apiKeyUrl: "https://support.deepl.com/hc/en-us/articles/360020695820-API-key-for-DeepL-API",
    styleNote: "DeepL 不接收「AI 翻译专家」指令，只会体现正式/口语（formality）差异。",
    help: "免费版使用 api-free；付费版可改为 https://api.deepl.com/v2。"
  },
  ollama: {
    label: "Ollama（本机）",
    adapter: "openai",
    baseUrl: "http://localhost:11434/v1",
    model: "qwen3:8b",
    apiKeyOptional: true,
    apiKeyUrl: "https://docs.ollama.com/api/openai-compatibility",
    apiKeyActionLabel: "查看配置说明",
    help: "需要本机启动 Ollama，并允许浏览器扩展访问 localhost。"
  },
  custom: {
    label: "自定义 OpenAI 兼容接口",
    adapter: "openai",
    baseUrl: "",
    model: "",
    help: "填写兼容 /chat/completions 的 Base URL、API Key 和模型名称。"
  }
});
