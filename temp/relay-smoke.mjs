/**
 * relay/worker.js 冒烟测试
 *
 * 只做一件事：把 Worker 真的跑起来，验证路由、令牌、上游回退、缓存这几条路径。
 * Worker 的 ESM 写法在 Node 里需要一个 .mjs 副本才能 import，所以脚本会先复制一份。
 *
 * 运行：node temp/relay-smoke.mjs
 * 也可被门禁运行器 import：const { run } = await import("./relay-smoke.mjs")
 *
 * 注意：为了模拟 Workers 运行时，这里会临时接管 globalThis.fetch / globalThis.caches，
 * 跑完会还原，避免污染同进程里的其它检查。
 */

import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

export async function run(log = console.log) {
  const source = path.join(here, "..", "relay", "worker.js");
  const copy = path.join(here, "relay-worker.mjs");
  copyFileSync(source, copy);

  // ---- 环境模拟 -----------------------------------------------------------

  const calls = [];
  let upstreamPlan = []; // 依次决定每次上游 fetch 的返回

  const cacheStore = new Map();
  const previousFetch = globalThis.fetch;
  const previousCaches = globalThis.caches;

  globalThis.caches = {
    default: {
      async match(request) {
        const hit = cacheStore.get(request.url);
        return hit ? new Response(hit, { headers: { "content-type": "application/json" } }) : undefined;
      },
      async put(request, response) {
        cacheStore.set(request.url, await response.text());
      }
    }
  };

  globalThis.fetch = async (url) => {
    const href = String(url);
    calls.push(href);
    const plan = upstreamPlan.shift();
    if (!plan) throw new Error(`unexpected upstream call: ${href}`);
    if (plan === "boom") throw new Error("network down");
    return new Response(plan, { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const worker = (await import(`file://${copy.replace(/\\/g, "/")}`)).default;

    // ---- 断言 -------------------------------------------------------------

    let passed = 0;
    const failures = [];

    function check(name, condition, detail) {
      if (condition) {
        passed += 1;
        log(`  ok   ${name}`);
      } else {
        failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
        log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
      }
    }

    let pending = [];
    const ctx = { waitUntil: (promise) => { pending.push(promise); } };

    async function call(pathAndQuery, options = {}) {
      calls.length = 0;
      pending = [];
      // 默认清空缓存：否则前面用例缓存过的 q 会让后面用例直接命中、不回源，
      // 断言「上游被调用了 N 次」就会失真。缓存用例自己传 keepCache。
      if (!options.keepCache) cacheStore.clear();
      const request = new Request(`https://relay.example.com${pathAndQuery}`, options);
      const response = await worker.fetch(request, options.env || {}, ctx);
      await Promise.all(pending);
      return response;
    }

    const GOOGLE_BODY = JSON.stringify([[[ "你好", "hello", null, null, 1 ]], null, "en"]);
    const env = { RELAY_TOKEN: "s3cret" };

    // ---- 1. 健康检查 ------------------------------------------------------

    log("\n[1] 路由");
    {
      const res = await call("/health");
      check("/health 返回 200", res.status === 200, `got ${res.status}`);
      check("/health 不回源", calls.length === 0, `upstream calls: ${calls.length}`);
    }
    {
      const res = await call("/nope");
      check("未知路径返回 404", res.status === 404, `got ${res.status}`);
    }

    // ---- 2. 令牌 ----------------------------------------------------------

    log("\n[2] 令牌");
    {
      upstreamPlan = [GOOGLE_BODY];
      const res = await call("/translate_a/single?q=hello&tl=zh-CN", { env });
      check("无令牌返回 401", res.status === 401, `got ${res.status}`);
      check("无令牌不回源", calls.length === 0, `upstream calls: ${calls.length}`);
    }
    {
      upstreamPlan = [GOOGLE_BODY];
      const res = await call("/t/wrong/translate_a/single?q=hello&tl=zh-CN", { env });
      check("错误路径令牌返回 401", res.status === 401, `got ${res.status}`);
    }
    {
      upstreamPlan = [GOOGLE_BODY];
      const res = await call("/t/s3cret/translate_a/single?q=hello&tl=zh-CN", { env });
      check("路径令牌通过", res.status === 200, `got ${res.status}`);
      check("路径令牌透传原文", (await res.text()) === GOOGLE_BODY);
    }
    {
      upstreamPlan = [GOOGLE_BODY];
      const res = await call("/translate_a/single?q=hello&tl=zh-CN&token=s3cret", { env });
      check("查询串令牌通过", res.status === 200, `got ${res.status}`);
    }
    {
      upstreamPlan = [GOOGLE_BODY];
      const res = await call("/translate_a/single?q=hello&tl=zh-CN", {
        env,
        headers: { "x-relay-token": "s3cret" }
      });
      check("请求头令牌通过", res.status === 200, `got ${res.status}`);
    }
    {
      upstreamPlan = [GOOGLE_BODY];
      const res = await call("/translate_a/single?q=hello&tl=zh-CN", { env: {} });
      check("未配置 RELAY_TOKEN 时不校验", res.status === 200, `got ${res.status}`);
    }

    // ---- 3. 输入校验 ------------------------------------------------------

    log("\n[3] 输入校验");
    {
      const res = await call("/translate_a/single?q=&tl=zh-CN");
      check("空文本返回 400", res.status === 400, `got ${res.status}`);
    }
    {
      const res = await call(`/translate_a/single?q=${"a".repeat(2001)}&tl=zh-CN`);
      check("超长文本返回 413", res.status === 413, `got ${res.status}`);
    }

    // ---- 4. 上游回退 ------------------------------------------------------

    log("\n[4] 上游回退");
    {
      upstreamPlan = ["boom", GOOGLE_BODY];
      const res = await call("/translate_a/single?q=hello&tl=zh-CN");
      check("首个上游网络失败后换下一个", res.status === 200, `got ${res.status}`);
      check("确实换了域名", calls[1].includes("translate.google.com"), calls[1]);
    }
    {
      upstreamPlan = ["<html>sorry</html>", GOOGLE_BODY];
      const res = await call("/translate_a/single?q=hello&tl=zh-CN");
      check("上游返回验证页时换下一个", res.status === 200, `got ${res.status}`);
    }
    {
      upstreamPlan = ["boom", "boom", "boom"];
      const res = await call("/translate_a/single?q=hello&tl=zh-CN");
      check("全部失败返回 502", res.status === 502, `got ${res.status}`);
      const body = await res.json();
      check("502 带上游错误信息", /all upstreams failed/.test(body.error || ""), body.error);
    }

    // ---- 5. 缓存 ----------------------------------------------------------

    log("\n[5] 缓存");
    {
      // 两次回源：zh-CN 一次，en 一次（不同目标语言不共用缓存）。
      upstreamPlan = [GOOGLE_BODY, GOOGLE_BODY];
      const res = await call("/translate_a/single?q=%E7%BC%93%E5%AD%98%E6%B5%8B%E8%AF%95&tl=zh-CN");
      check("首次请求回源", calls.length === 1, `upstream calls: ${calls.length}`);
      check("首次标记 miss", res.headers.get("x-relay-cache") === "miss", res.headers.get("x-relay-cache"));

      const res2 = await call("/translate_a/single?q=%E7%BC%93%E5%AD%98%E6%B5%8B%E8%AF%95&tl=zh-CN", { keepCache: true });
      check("第二次不回源", calls.length === 0, `upstream calls: ${calls.length}`);
      check("第二次标记 hit", res2.headers.get("x-relay-cache") === "hit", res2.headers.get("x-relay-cache"));

      const res3 = await call("/translate_a/single?q=%E7%BC%93%E5%AD%98%E6%B5%8B%E8%AF%95&tl=en", { keepCache: true });
      check("不同目标语言不共用缓存", calls.length === 1, `upstream calls: ${calls.length}`);
      check("未命中时标记 miss", res3.headers.get("x-relay-cache") === "miss", res3.headers.get("x-relay-cache"));
    }

    // ---- 6. 转发参数 ------------------------------------------------------

    log("\n[6] 转发参数");
    {
      upstreamPlan = [GOOGLE_BODY];
      await call("/translate_a/single?q=hello%20world&tl=zh-CN");
      const url = calls[0];
      check("空格编成 %20 而不是 +", url.includes("q=hello%20world"), url);
      check("带上 client=gtx", url.includes("client=gtx"), url);
      check("带上 dt=t", url.includes("dt=t"), url);
      check("带上 sl=auto", url.includes("sl=auto"), url);
    }
    {
      upstreamPlan = [GOOGLE_BODY];
      await call("/t/s3cret/translate_a/single?q=hello&tl=zh-CN");
      check("上游 URL 里不含令牌", !calls[0].includes("s3cret"), calls[0]);
    }

    // ---- 汇总 -------------------------------------------------------------

    log(`\n通过 ${passed} 项，失败 ${failures.length} 项`);
    for (const item of failures) log(`  - ${item}`);

    return { passed, failures };
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.caches = previousCaches;
  }
}

// 直接 `node temp/relay-smoke.mjs` 时自动运行；被 import 时不自动跑。
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  run().then(result => {
    if (result.failures.length) process.exitCode = 1;
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
