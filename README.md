# TransMate

外贸场景的浏览器翻译扩展（Chrome / Edge，Manifest V3）。

它把三件平时要来回切换的事放进一个扩展里：**商务翻译**、**WhatsApp 聊天窗口翻译**、
**客户时区与语言识别**。装完就能在 WhatsApp 网页版里看到客户所在地的当地时间，
按一次快捷键把整段聊天翻译成中文，同时把客户发来的小语种自动认出来。

扩展本体是纯前端，没有自建服务器，API Key 只存在浏览器本地存储里。

---

## 核心能力

### 翻译

| 能力 | 说明 |
| --- | --- |
| 输入框翻译 | 在任意网页的输入框里**连续按 3 次空格**触发（次数与超时可在设置里调，范围 2–5 次 / 500–5000 ms） |
| WhatsApp 聊天翻译 | 按 `Alt+Q` 开启或关闭，读取当前聊天区已加载的全部消息并继续处理新消息；支持双语对照 / 仅译文 / 仅原文三种显示 |
| AI 翻译专家 | 10 个预设：自然通用、忠实直译、自然意译、自然聊天、亲切聊天、幽默聊天、商务英语、专业外贸、销售沟通、仓储设备 |
| 请求缓存与并发 | 按「原文 + 目标语言」缓存，相同内容不重复请求；同时最多两个请求在跑 |
| 第三方插件译文屏蔽 | 默认隐藏聊天区里其他翻译插件注入的译文，避免干扰客户语言识别 |

### WhatsApp 客户信息

| 能力 | 说明 |
| --- | --- |
| 归属地区 | 由客户号码推断注册国家（注意：是号码注册国，不等于客户当前所在地） |
| 当地时间 | 24 小时制，默认跟随「在线 / 最后上线时间」显示；多时区国家可手动切换 |
| 客户语言 | 综合最近五条不同的客户消息自动识别，并显示置信度；过短或模糊的信息不会覆盖已有结果 |
| 号码修正 | 识别不准时可手动填写，手动值优先级最高，不会被自动识别覆盖 |

---

## 支持的翻译服务

| 服务 | 需要 API Key | 备注 |
| --- | --- | --- |
| Google 翻译（免费） | 否 | 默认档。调用 Google 网页端非公开接口，按出口 IP 限流；国内需要代理，或自建 `relay/` 中转 |
| 智谱 GLM-4.7-Flash（免费） | 是 | 推荐。国内可直连，模型本身免费，支持 AI 翻译专家 |
| Gemini / OpenAI / Claude / DeepSeek / Groq / OpenRouter / Qwen / 硅基流动 / 智谱 GLM / Azure OpenAI | 是 | 填好 Key 后可「获取可用模型」，候选项按翻译适用度排序并标注推荐模型 |
| DeepL | 是 | 专业翻译引擎，响应快、术语稳；国内需代理，免费版每月 50 万字符 |
| Ollama | 否 | 走本机 `http://localhost:11434` |
| 自定义 OpenAI 兼容接口 | 视情况 | 首次保存或测试时，浏览器会询问该域名的访问权限 |

免费档走不到 Google 的时候，可以用 [`relay/`](relay/README.md) 里的 Cloudflare Worker
自建中转：让一台能访问 Google 的服务器替你请求，再把结果原样传回来。

---

## 安装

### 方式一：从源码加载（开发用）

1. 下载或克隆本仓库。
2. Chrome 打开 `chrome://extensions/`，Edge 打开 `edge://extensions/`。
3. 打开右上角「开发者模式」。
4. 点「加载已解压的扩展程序」，选择本仓库根目录（含 `manifest.json` 的那一层）。
5. 打开扩展设置页，选择翻译服务，填好 API Key 与模型，点「测试连接」。
6. 建议先停用旧的翻译类扩展，避免功能重复触发。

扩展本体没有构建步骤，不需要 `npm install` 就能加载。

### 方式二：从发布包安装

```bash
python temp/build-zip.py
```

产物是 `TransMate-v<版本>-源码.zip`，解压后按上面第 2–6 步加载即可。
普通用户请直接看 [`安装说明.txt`](安装说明.txt)。

---

## 开发

```bash
npm install      # 首次：装 eslint / acorn / globals
npm run check    # 提交前必跑：8 道质量门禁，约 2.4 秒
npm run metrics  # 看代码质量数据（函数长度 / 复杂度 / 重复代码）
npm run preview  # 生成面板预览页，用浏览器肉眼核对样式改动
```

改代码之前建议先读 [`docs/工程规范手册.md`](docs/工程规范手册.md)，
里面的规则都带本项目的真实行号。

### 8 道质量门禁

`npm run check` 一次跑完，全绿才提交：

| 门禁 | 防什么 |
| --- | --- |
| 静态检查（ESLint） | 拼错变量、恒真恒假、Promise 返回值写错 |
| 默认值一致性 | 5 份 DEFAULTS 副本互相漂移 |
| 回归测试（55 项） | 已修过的 bug 重新出现 |
| 审查项（8 项） | 版本号、HTML id、开关默认值不一致 |
| 中转服务冒烟（29 项） | 中转服务的请求 / 响应契约被改坏 |
| 空 catch 有说明 | 吞掉异常却不写为什么 |
| 质量预算 | 函数越写越长、越写越绕；已经改好的地方再退回去 |
| 变异测试（10 点） | 测试变成摆设 —— 代码改坏了，回归测试却还是绿的 |

CI（[`.github/workflows/quality-gate.yml`](.github/workflows/quality-gate.yml)）
在每次推送和每个 PR 上跑同一套。

单独跑某一道：

```bash
npm run test:regression   # 回归测试
npm run test:budget       # 质量预算名单
npm run test:mutation     # 变异测试
```

---

## 目录结构

```
manifest.json          MV3 清单
background.js          Service Worker：请求转发、翻译调度、批量聊天翻译
content.js             内容脚本：输入框翻译、剪贴板、快捷键
providers.js           服务商预设表（纯数据）
timezone.js            WhatsApp 页面：时区、客户语言与地区、聊天翻译
                       ⚠ 第 2 ~ 3232 行是第三方打包产物，不要手改
timezone.css           上面那个的样式
options.html/js/css    设置页
popup.html/js/css      工具栏弹窗

relay/                 独立部署的中转服务（Cloudflare Worker），单独维护

temp/                  开发工具与测试，不打进发布包
  run-checks.cjs         门禁运行器（npm run check 的入口）
  regression-checks.cjs  回归测试 55 项
  review-checks.cjs      审查项 8 项
  defaults-consistency.cjs  默认值一致性检查
  quality-budget.cjs     质量预算（超标函数名单，兼重构待办）
  mutation-test.cjs      变异测试 20 点：故意改坏，确认测试真的会红
  relay-smoke.mjs        中转服务冒烟 29 项
  quality-metrics.cjs    AST 级质量度量
  preview-ui.cjs         生成面板预览页
  build-zip.py           打包发布包

docs/                  工程文档
```

---

## 文档

| 文档 | 什么时候看 |
| --- | --- |
| [`开发说明.md`](开发说明.md) | 准备改代码，先看这份 |
| [`docs/工程规范手册.md`](docs/工程规范手册.md) | 写代码之前过一遍，所有规则都带真实行号 |
| [`docs/代码质量基线报告.md`](docs/代码质量基线报告.md) | 想知道「现在的代码到底怎么样」，以及该先动哪里 |
| [`docs/功能与问题盘点.md`](docs/功能与问题盘点.md) | 想知道「现在有哪些功能」和「接下来修什么」 |
| [`docs/学习路线图.md`](docs/学习路线图.md) | 想借这个项目练手，12 周计划，练习题就用本项目的函数 |
| [`安装说明.txt`](安装说明.txt) | 给最终用户的说明书 |
| `更新说明-v3.9.*.txt` | 逐版本变更记录 |

---

## 隐私

- **没有自建服务器**。扩展直接调用你自己选择的翻译服务，请求不经过任何第三方中转
  （除非你主动部署并使用 `relay/`）。
- **API Key 只存在本地**。保存在 `chrome.storage.local`，不会上传到任何地方。
- **不收集数据**。没有埋点、没有统计、没有远程配置。
- 权限说明：`storage` 存设置，`clipboardWrite` 支持复制译文，`activeTab` 用于弹窗操作当前页；
  其余主机权限只用于访问你选定的翻译服务接口与 `web.whatsapp.com`。
  自定义接口域名走 `optional_host_permissions`，由你在首次保存时单独授权。

---

## 许可

本项目以 [MIT 许可](LICENSE) 发布。

`timezone.js` 中内联打包了 [libphonenumber-js](https://github.com/catamphetamine/libphonenumber-js)
与 [franc](https://github.com/wooorm/franc) 两个第三方库（均为 MIT），
各自的版权声明与许可全文见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
