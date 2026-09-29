# TransMate 项目长期约定

## 项目

Chrome MV3 扩展「TransMate - 外贸翻译与客户时区」，作者 Mark。
功能：外贸商务翻译、WhatsApp 聊天窗口翻译、客户号码归属地区与当地时间。

## 工作路径（固定）

```
C:\Users\hengchu\Desktop\Mark\Mark\TransMate
```

- **不要再使用带版本号的目录名**（旧目录 `TransMatev3.7.3` 仅作备份）。
- 源码在根目录；`relay/` 是可选的服务端中转组件；`temp/` 是测试与打包脚本（不进包）。

## 版本号规则（重要）

**每修改一次就升一次版本号。** 需要同步三处：

| 文件 | 改什么 |
| --- | --- |
| `manifest.json` | `"version"` ← 唯一来源 |
| `options.html` | `<span class="version">vX.Y.Z</span>` |
| `安装说明.txt` | 首行 `TransMate vX.Y.Z` |

升版本**不需要**再改测试或打包脚本：两者都已改成从 manifest 读版本号。

## 常用命令

```bash
# 回归测试（36 项）
node temp/regression-checks.cjs

# 弹层 UI 视觉校验（生成静态预览页，再用 Chrome 截图看效果）
node temp/preview-ui.cjs
chrome --headless --force-device-scale-factor=2 --window-size=640,700 \
  --screenshot=temp/crops/popover.png file:///<绝对路径>/temp/preview-ui.html

# H1/H2 修复验证 + M1/M2/M3/M5 修复验证（8 项，遗留项应为空）
node temp/review-checks.cjs

# 中转 Worker 冒烟测试（29 项）
node temp/relay-smoke.mjs

# 打包源码（版本号自动从 manifest 读）
python temp/build-zip.py
```

Node / Python 用 managed 版本：
`C:\Users\hengchu\.workbuddy-ai\binaries\node\versions\22.22.2-3\node.exe`
`C:\Users\hengchu\.workbuddy-ai\binaries\python\versions\3.13.12\python.exe`

## 关键约定

- **服务商模型名会过期，这是高频坑。** 预设里的 `model` 是快照，服务商改名或下线后，用户选了就报"模型不存在"。
  动服务相关代码时顺手核对官方文档的当前模型名。已踩过的坑：
  - `deepseek-chat` / `deepseek-reasoner` 于 2026-07-24 退役 → 用 `deepseek-flash`（V4 起还默认开思考模式，必须显式关闭）。
  - 智谱免费模型是 `glm-4.7-flash`，不是 `glm-4-flash`。
- **新增翻译服务只需改 `providers.js` 一处。** 设置页下拉由 `options.js` 的 `Object.entries(presets)` 动态生成，
  popup 也直接读 `TLP_PROVIDER_PRESETS`。**前提是新服务的域名要已在 `manifest.json` 的 host_permissions 里**
  （否则要加，且会让已装用户重新授权）。
- **Azure 的模型名在地址里，不在请求体里。** 形如 `.../deployments/<名字>/chat/completions?api-version=...`，
  请求体不发 `model`。所以：① 它必须留在 `TLP_ADAPTERS_WITHOUT_MODEL` 里（漏掉会直接报"请填写模型名称"而完全不可用）；
  ② 判断它是不是 GPT-5 / o 系列只能从地址的 deployment 段取名字（`azureDeploymentName()`）。
- **`provider.extraBody`**：给个别服务加专属请求字段（如 DeepSeek 关思考模式）。在 providers.js 的预设里声明，
  `openAIRequestBody` 末尾合并。**只对声明的预设生效**，避免把别人不认识的字段发出去导致 400。
- **WhatsApp 聊天翻译是"快捷键触发"语义（v3.9.5 定稿，别再改成常开）**：开关叫「允许快捷键」，
  默认 true 只表示"快捷键可用"，**打开开关不翻译**；只有按 Alt+Q 才进翻译会话，再按一次关闭并移除译文。
  v3.9.4 曾改成常开（自动进入会话），v3.9.5 已按用户要求撤回——**不要再自动激活翻译会话**。
  `update()` 里只有 `else if (chatTranslationSessionActive) scheduleChatTranslation(...)`，
  任何 `chatTranslationAutoActivated` 之类的自动激活标志都不要加回来。
- **判断"是不是推理模型"必须先剥掉厂商前缀**（v3.9.6 修）。OpenRouter / 硅基流动的模型名形如
  `openai/gpt-5`、`Qwen/Qwen3-8B`，直接拿 `provider.model` 去匹配 `^gpt-5` 匹配不上，会被当成普通模型
  发出它不接受的 `max_tokens` + `temperature`，服务端直接 400。统一走 `effectiveModelName()`（取最后一段）。
- **`temperature` 只对真正的推理模型省略**（v3.9.6 修）。GPT-5 / o 系列不接受它；gpt-4o、gpt-4.1 等是接受的。
  以前按"provider 是不是 openai"判断，范围太宽，导致 gpt-4o 用默认温度（通常 1.0），同一句话每次翻译结果都不同。
- **错误信息必须截断**（v3.9.6 修）。网关 / Cloudflare 出错会返回整页 HTML，实测 6332 字符进 toast，
  真正的信息全被淹没。统一走 `trimProviderError()`（压平空白 + 截到 300 字符 + 标注原始长度）。
- **安全策略拦截要和"返回为空"分开报**（v3.9.6 修）。Gemini `SAFETY`、Anthropic `refusal`、
  OpenAI `content_filter` 都返回空内容，只判断空会报"没有返回翻译结果"，用户会去反复检查 Key 配置。
- **content script 的 `storage.onChanged` 必须过滤键**（v3.9.6 优化）。它注入在每个标签页的每个 iframe 里，
  只用到 5 个设置项；无差别重读会把无关写入（设置页保存、后台写模型缓存）放大成全浏览器范围的读取。
- **源码包只放扩展本体**（14 个源文件 + icons，共 18 项），不含 `temp/`、`.workbuddy-ai/`、审查报告 md、更新说明。
  `verify.js` 是 `background.js` 用 `importScripts` 加载的，**不在 manifest 里**，
  但 `temp/build-zip.py` 的 `include` 列表**必须带上它**，否则打出来的包少文件、后台直接报错。
- **`verify.js` 通过 `globalThis.TLP_VERIFY` 暴露**（v3.9.7 新增）。它是 background service worker 的全局对象，
  在 `background.js` 里**必须写 `TLP_VERIFY.verifyTranslation(...)`，裸名会 ReferenceError**（已踩过）。
  对外只冻结暴露 `extractHardFacts / compareHardFacts / verifyTranslation / normalizeNumber`。
  设计取向：**宁可多提醒一次，也不要漏掉一次改写**；`verifyTranslation` 用 try/catch 兜底返回 `[]`，
  校验失败绝不能拖垮翻译本身。
- **数字抽取不能用 `\d[\d,\s]*`**（v3.9.7 修）。那样 `HR-2400, 20GP` 会被读成一个数 `240020`，之后全是误报。
  必须写成 `\d{1,3}(?:[,\u00a0 ]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`，只认规范千分位分组。
- **硬信息校验只报"请核对"，不做任何自动修改**：数字（千分位/小数补零/前导零归一）、
  Incoterms、柜型（HC≡HQ、中文"40 尺高柜"→40HQ）、货币（RMB→CNY、符号映射到候选组）、
  型号（`USD12`/`FOB1000` 靠 `NON_MODEL_PREFIXES` 排除）。单条消息最多报 6 条。
  原文含中文数字时**只报"数字丢失"，不报"多出数字"**，否则全是误报。
- **聊天翻译的缓存/插入结构已变为 `{ text, warnings }`**（v3.9.7）。`translateChat` 返回
  `{ text, warnings }`，`pumpChatTranslationQueue` 的 `translated` Map 值同结构，
  判空用 `!payload?.text`。警告 DOM **必须挂在译文元素内部**，才能复用现有的
  `[data-tlp-chat-translation="1"]` 过滤，否则 MutationObserver 会死循环。
- **客户沟通时间建议**（v3.9.7）：`watContactWorkHint/Start/End/Weekends` 四个设置项，
  timezone.js 与 options.js 的默认值必须一致（`true / 9 / 18 / false`）。
  `workHourRange()` 自愈（`end = max(start+1, end)`），设置页 `normalizeWorkHours()` 同步纠正。
  计算全部是本地 `Intl` 运算，不联网。**新增函数必须真的接到 `renderKnown` / `renderUnknown` /
  15 秒 `clockTimer` 三处**，否则是死代码（这次差点漏掉，已加回归断言守住）。
- **设置页里默认值为 `false` 的开关不能走 `settings[key] !== false` 那个循环**，
  那样 `undefined` 会被判成 `true`。默认 false 的项要单独写 `=== true`。
- **硬信息校验最容易死在误报上**（v3.9.8 修，用户直接拿截图反馈了两条）。
  两条都是"翻译得对却被标出来"：
  ① 模型把 `6-layer` 译成"六层"，阿拉伯数字 6 在译文里消失 → 误报"数字丢失"。
  修法是**只在"丢失"方向**把译文里的中文数字还原成阿拉伯数字
  （`chineseNumeralsAsDigits`，六=6、三万=30000）。反方向（译文多出数字）
  仍然只看阿拉伯数字——否则"一共""一些""一直"里的"一"会凭空造出一堆数字。
  ② 模型把 `EXW` 意译成"出厂价" → 误报"术语丢失"。修法是给每个 Incoterms
  配一组可接受的中文别名（`INCOTERM_CN_ALIASES`，出厂价=EXW、离岸价=FOB、到岸价=CIF…），
  双向都判（原文写中文、译文写缩写也不报）。
  **但"把 CIF 写成 CFR"这类真正的改写仍要报**——所以别名表必须精确，
  别把 CFR 的"成本加运费"塞进 CIF。
- **在线状态灯判定：离线文案必须先判**（v3.9.8）。中文"最后上线时间"里含"上线"，
  先判在线会把离线误判成在线。顺序是：正在输入 → 离线文案 → 在线文案。
  状态直接读 WhatsApp 标题下方那一行（`title` 属性优先，页面上可能是截断的），
  **不额外发任何请求**；读不到时指示灯自动收起，不假装"离线"。
- **弹层里的快捷开关与设置页共用同一存储键**（v3.9.8）：`.wat-presence-toggle` /
  `.wat-work-toggle` 的 change 直接 `safeStorageSet`，靠 `storage.onChanged` 触发重渲染。
  写 `.wat-toggle` 的 CSS 时注意**要盖掉那条给文本框用的
  `#wat-region-time-root input { height: 34px; border: ...; background: ... }` 通用规则**。
- **弹层静态预览的坑**：预览页里想让弹层默认展开，`[hidden] { display: block !important }`
  **必须放在 timezone.css 之后**，否则会被 css 里同名规则盖掉，截出来是空白的。
- `relay/` 是独立部署的服务端组件，**不打进扩展源码包**。用户没有域名，此方案暂搁置。
- 扩展端「API 地址」会被原样拼上 `/translate_a/single`，所以中转地址可以带路径（令牌就靠这个传）。
- 免费档（googlefree）是 Google 非公开接口，**只作为免费档，不要把收费功能建在它上面**。
- `temp/audit-checks.cjs` 是 v3.7.2 的历史复现脚本，断言旧缺陷行为，在当前代码上必然失败，不是回归测试。

## 商业化方向（2026-09 结论，未实施）

L1 通用输入框翻译免费引流 → L2 外贸垂直能力（术语库、数字/型号/Incoterms 校验）个人版 ¥29–39/月 → L3 团队一致性（共享术语库）。
建议 BYO-Key（成本≈0、合规面轻），不做额度转售。

**前提改动**：`timezone.js` 聊天缓存键为 `provider:model:profile:target:hash`，
术语库上线后**必须把术语表版本加进缓存键与 fingerprint**，否则改了术语表旧译文不重译。

## 已知未处理项

v3.9.6 已修完 M1（错误响应体未截断）、M2（Gemini SAFETY 提示）、M3（temperature 按 provider 判断）、
M5（busy 静默丢弃），`review-checks.cjs` 的遗留项已清零。v3.9.7 未动这些遗留项，**仍然未处理**：

- **M4 长输入无预检**：`translate()` 不限制输入长度，超长文本会先花掉一次请求才在返回时被判截断。
- **M6 推理模型预算含推理 token**：`estimateOutputTokens` 按字符数估算，没给思维链留余量。
- **L1–L10**：见 `翻译模块代码审查报告.md`。
- **目标语言为中文时，自己发出的中文消息也会被送去翻译**（`shouldSkipChatTranslation` 在目标为中文时直接放行，
  因为中文识别分不出简繁）。副作用是白花一次 API 调用、并显示一条几乎相同的"译文"。
  想避免只能把范围改成"仅客户发来的消息"。**改动会变更行为，需先问用户。**
- **聊天会话开启期间每次聊天区变化都重扫全部已加载消息**，长会话有可感知开销；改成只重扫变化的那几条属结构改动。
