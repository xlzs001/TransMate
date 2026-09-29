# TransMate 翻译中转（Cloudflare Worker）

## 这是干什么的

TransMate 的「Google 翻译（免费）」档直接用 Google 网页端接口。这个接口在国内直连不到，
用受限节点也经常拿不到数据 —— 这是节点问题，扩展前端无法解决。

中转的思路很简单：**让一台能访问 Google 的服务器替你请求，再把结果原样传回来。**

```
你的浏览器 ──▶ 你的中转域名（Cloudflare 边缘）──▶ Google 翻译接口
               国内可直连                    走 Cloudflare 自己的出口 IP
```

因为 Worker 是从 Cloudflare 的边缘节点发起请求、出口 IP 不在你的节点上，
所以**无论你本地是什么网络环境，只要这个域名能打开，翻译就能用**。

关键前提只有一个：**域名在国内能访问**。`*.workers.dev` 默认被墙，所以必须绑自己的域名。

---

## 扩展端要不要改？

**不用改，一行都不用。** 这个 Worker 的路径和返回结构与 Google 完全一致，
扩展只会把「API 地址」当作服务器根地址，在后面拼 `/translate_a/single`。

所以部署完你只需要在扩展里填一个地址。

---

## 一、准备

| 需要什么 | 说明 |
| --- | --- |
| Cloudflare 账号 | 免费注册，免费套餐每天 10 万次请求（额度以官网为准） |
| 一个域名 | **必须**，且已托管在 Cloudflare（NS 指向 CF）。没有的话在 CF 买最省事 |
| Node.js | 只有用命令行部署才需要；用网页控制台不需要 |

> 为什么要域名：`*.workers.dev` 在国内基本打不开。绑了自定义域名走 CF 的常规 CDN 线路，
> 国内通常可以直连。这是整个方案能不能落地的分水岭。

---

## 二、部署 Worker

### 方式 A：网页控制台（不用装任何东西，推荐先试这个）

1. 登录 Cloudflare → 左侧 **Workers 和 Pages** → **创建** → **创建 Worker**
2. 名字填 `transmate-relay`，点部署
3. 点 **编辑代码**，把 `relay/worker.js` 的内容**整个替换**进去（先清空编辑器里的示例代码）
4. 右上角 **部署**
5. 点 **设置 → 域和路由 → 添加 → 自定义域**，填一个子域名，例如 `translate.你的域名.com`
   （这个子域名不能已经存在解析记录，CF 会自己加一条）
6. 等状态变成 **活动**，然后浏览器打开 `https://translate.你的域名.com/health`
   - 看到 `{"ok":true,"service":"transmate-relay"}` 就是成功了

### 方式 B：命令行（wrangler）

```bash
cd relay
npx wrangler login          # 浏览器里点一下授权
npx wrangler deploy
```

部署成功后终端会给出一个 `*.workers.dev` 地址。**先别急着用**，接着绑域名：

编辑 `relay/wrangler.toml`，取消这两行的注释并改成你的域名：

```toml
routes = [
  { pattern = "translate.你的域名.com", custom_domain = true }
]
```

再执行一次 `npx wrangler deploy` 即可。

> 如果域名不在 Cloudflare 上，`custom_domain` 会报错。
> 这种情况先把域名的 NS 迁到 Cloudflare，或者干脆用方式 A 在控制台里绑。

---

## 三、设置令牌（可选，但建议）

Worker 是公开的，任何人拿到你的域名都能白用。加个令牌能把门槛抬高。

**注意这是「防滥用」不是「强鉴权」**：扩展里的令牌是能被提取出来的，
真要死守额度还是得靠 Cloudflare 的 Rate limiting 规则。但挡掉扫描器已经够用了。

设置方法：

```bash
cd relay
npx wrangler secret put RELAY_TOKEN
# 粘贴一个随机字符串，回车
```

或者网页控制台 → 你的 Worker → **设置 → 变量和机密 → 添加**，类型选 **机密**，
名称 `RELAY_TOKEN`，值填随机串。

令牌有三种传法，**用第一种最省事**：

| 传法 | 例子 | 说明 |
| --- | --- | --- |
| **放在路径里**（推荐） | `https://translate.你的域名.com/t/你的令牌` | 直接填进扩展的「API 地址」，不用改扩展 |
| 查询串 | `.../translate_a/single?token=你的令牌&q=...` | 适合手动测试 |
| 请求头 | `x-relay-token: 你的令牌` | 适合别的程序调用 |

> 为什么路径传法能work：扩展只是把「API 地址」当根地址往后拼 `/translate_a/single`，
> 所以 `https://域名/t/令牌` 会被拼成 `https://域名/t/令牌/translate_a/single`，
> Worker 从路径里把令牌取出来，转发给 Google 时不会带上它。

没配 `RELAY_TOKEN` 时，Worker 不校验，任何人都能用。

---

## 四、在扩展里启用

1. 点扩展图标 → **设置**（或在扩展管理页点「扩展程序选项」）
2. **翻译服务** 选 **Google 翻译（免费）**
3. **API 地址** 填你的中转域名：

   - 没设令牌：`https://translate.你的域名.com`
   - 设了令牌：`https://translate.你的域名.com/t/你的令牌`

4. 保存时会弹出授权提示（需要访问该域名），点**允许**
5. 找一段英文试翻一下，能出中文就通了

### 中转挂了会不会直接不能用？

不会。扩展的域名列表是「你填的地址优先，后面跟着 Google 官方域名」，
中转请求失败时会自动回退去试 Google 官方域名 —— 所以你挂着 VPN 的时候
即使中转坏了也还能翻，只是慢一点。反过来，国内直连时中转就是唯一能走通的路。

---

## 五、验证中转是否正常

浏览器直接打开（把域名换成你的）：

```
https://translate.你的域名.com/health
```

或者在终端里：

```bash
curl "https://translate.你的域名.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=hello"
```

正常会返回类似：

```json
[[["你好","hello",null,null,10]],null,"en",...]
```

如果返回 `{"error":"all upstreams failed: ..."}`，说明 Cloudflare 到 Google 这条路也不通 ——
这种情况很少见，通常是 CF 账号所在区域被限制，换一个 CF 账号或换供应商（见下）。

---

## 六、它能带来什么

| 好处 | 说明 |
| --- | --- |
| **不受本地网络影响** | 出口在 Cloudflare，国内直连也能翻 |
| **边缘缓存** | 同一段文字只回源一次，之后所有用户都命中缓存（30 天）。常用短语几乎秒回 |
| **降低被限流概率** | Google 按出口 IP 限流，CF 出口分散，比单个家宽 IP 抗压得多 |
| **延迟更低** | 请求就近落到 CF 边缘节点，不必绕远路去 Google |

### 成本

免费套餐每天 10 万次请求。按扩展的用法（输入框翻译 + 聊天批量），
个人自用完全在免费额度内。真要做成商用产品、给一批用户共用，
建议配 Cloudflare 的 Rate limiting 规则，并按用量升级套餐。

---

## 七、必须知道的风险

1. **接口是非公开的。** `translate_a/single` 是 Google 网页端自用接口，官方随时可能改动或封禁。
   这也是为什么它在扩展里只作为「免费档」，不承担付费承诺 —— 收费功能别建在它上面。
2. **不要拿它当商业翻译 API 卖。** 转售 Google 机器翻译结果涉及服务条款和合规问题。
   商用请换成官方付费 API（Google Cloud Translation / DeepL）或大模型接口。
3. **合规提醒。** 如果你的产品面向境内公众提供生成式 AI 相关服务，
   按《生成式人工智能服务管理暂行办法》可能需要备案或安全评估 —— 这与用不用中转无关。
4. **中转域名别公开传播。** 一旦被大量滥用，你的额度会被跑光，也可能被 Cloudflare 限速。

---

## 八、如果不想用 Cloudflare

Worker 代码的逻辑（多上游重试 + 缓存 + 令牌）是通用的，只是用了 CF 的 `caches.default`
和 `ctx.waitUntil` 这两个 API。换成别的平台要改这两处：

| 平台 | 改动 |
| --- | --- |
| **Vercel / Netlify Functions** | 把 `export default { fetch }` 改成各自的 handler 签名，删掉缓存那几行（或改用平台 KV） |
| **自己的 VPS** | 用 Node 起个 Express/Fastify 服务转发即可，顺手可以加 Redis 缓存和额度计量 |
| **腾讯云 / 阿里云函数** | 改成对应的事件函数签名，同样去掉 CF 专有 API |

> 自建 VPS 的好处是出口 IP 固定、可以自己控制；坏处是单 IP 更容易被 Google 限流，
> 而且国内访问你的 VPS 本身可能又需要备案 + 域名解析。综合下来 Cloudflare Worker 最省事。

---

## 九、常见问题

**Q：部署完了但扩展里翻译还是失败？**
先确认 `/health` 能在浏览器打开。打不开就是域名没绑好或解析没生效（等几分钟）。
能打开但扩展报错，检查「API 地址」是不是填成了带 `/translate_a/single` 的完整路径 —— 只填到域名就行。

**Q：报 `unauthorized`？**
设了 `RELAY_TOKEN` 但扩展地址里没带令牌。改成 `https://域名/t/令牌`。

**Q：报 `text too long (max 2000)`？**
扩展单条最大只发 1200 字符，正常不会触发。手动 curl 测试长文本时会看到。

**Q：`workers.dev` 的地址能用吗？**
国内大概率不能。别在这上面浪费时间，直接绑域名。

**Q：需要给 Worker 加 CORS 吗？**
已经加了。扩展以 service worker 身份发请求，配上域名授权后不受同源限制，
但加上 CORS 头方便你用网页或别的工具调试。

---

## 附：文件说明

| 文件 | 作用 |
| --- | --- |
| `worker.js` | Worker 本体，部署时复制这一份就够 |
| `wrangler.toml` | 命令行部署的配置模板，含自定义域名示例 |
| `../temp/relay-smoke.mjs` | 冒烟测试：模拟 Cloudflare 环境跑一遍路由/令牌/缓存/回退（29 项） |
