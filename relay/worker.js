/**
 * TransMate 翻译中转（Cloudflare Worker）
 *
 * 作用：让访问不到 Google 的网络（含国内直连、受限节点）也能用免费翻译。
 * 设计要点：
 *   - 路径与返回结构完全对齐 Google 的 translate_a/single，
 *     所以扩展端不需要任何改动，只要把「API 地址」指向本 Worker。
 *   - 边缘缓存：同一段文字只回源一次，之后所有用户都命中缓存。
 *     这既提速，也大幅降低被 Google 按 IP 限流的概率。
 *   - 多上游依次重试：某个 Google 域名不可用时自动换下一个。
 *
 * 部署：见同目录 README.md
 * 可选变量：RELAY_TOKEN
 *   设置后必须带令牌，三种传法任选其一（都不需要改扩展代码）：
 *     1) 路径：https://你的域名/t/令牌/translate_a/single?...   ← 推荐，直接填进「API 地址」
 *     2) 请求头：x-relay-token: 令牌
 *     3) 查询串：.../translate_a/single?token=令牌&q=...
 */

const UPSTREAMS = [
  "https://translate.googleapis.com",
  "https://translate.google.com",
  "https://clients5.google.com"
];

const MAX_TEXT_LENGTH = 2000;
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;

// 令牌可以藏在路径前缀里：/t/<token>/translate_a/single
// 这样扩展只要把「API 地址」填成 https://域名/t/令牌 即可，无需传自定义请求头。
const TOKEN_PATH_PREFIX = "/t/";

function splitTokenPath(pathname) {
  const index = pathname.indexOf(TOKEN_PATH_PREFIX);
  if (index < 0) return { pathname, pathToken: "" };
  const rest = pathname.slice(index + TOKEN_PATH_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return { pathname, pathToken: "" };
  return { pathname: rest.slice(slash), pathToken: rest.slice(0, slash) };
}

const CACHE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": `public, max-age=${CACHE_TTL_SECONDS}`
};

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "content-type": "application/json; charset=utf-8" }
  });
}

function corsHeaders(request) {
  return {
    "access-control-allow-origin": request.headers.get("origin") || "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type, x-relay-token",
    "access-control-max-age": "86400"
  };
}

function cacheKeyFor(source, target, text) {
  const url = `https://relay.invalid/cache?sl=${encodeURIComponent(source)}&tl=${encodeURIComponent(target)}&q=${encodeURIComponent(text)}`;
  return new Request(url, { method: "GET" });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);
    const { pathname, pathToken } = splitTokenPath(url.pathname);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (pathname === "/health" || pathname.endsWith("/health")) {
      return json({ ok: true, service: "transmate-relay" }, 200, cors);
    }

    // 用 endsWith 而不是全等：这样把 Worker 挂在子路径（如 /relay/*）下也能工作。
    if (!pathname.endsWith("/translate_a/single")) {
      return json({ error: "not found" }, 404, cors);
    }

    // 令牌校验：在 Worker 变量里配置 RELAY_TOKEN 后才会启用。
    // 注意这是"抬高滥用门槛"，不是强鉴权——扩展里的令牌是可以被提取的。
    if (env.RELAY_TOKEN) {
      const provided = pathToken
        || request.headers.get("x-relay-token")
        || url.searchParams.get("token")
        || "";
      if (provided !== env.RELAY_TOKEN) {
        return json({ error: "unauthorized" }, 401, cors);
      }
    }

    const text = url.searchParams.get("q") || "";
    const target = url.searchParams.get("tl") || "zh-CN";
    const source = url.searchParams.get("sl") || "auto";

    if (!text.trim()) return json({ error: "empty text" }, 400, cors);
    if (text.length > MAX_TEXT_LENGTH) {
      return json({ error: `text too long (max ${MAX_TEXT_LENGTH})` }, 413, cors);
    }

    const cache = caches.default;
    const cacheKey = cacheKeyFor(source, target, text);

    const cached = await cache.match(cacheKey);
    if (cached) {
      return new Response(cached.body, {
        status: 200,
        headers: { ...cors, ...CACHE_HEADERS, "x-relay-cache": "hit" }
      });
    }

    const query = new URLSearchParams({
      client: "gtx",
      sl: source,
      tl: target,
      dt: "t",
      q: text
    }).toString().replace(/\+/g, "%20");

    let lastError = "unknown";
    for (const upstream of UPSTREAMS) {
      try {
        const response = await fetch(`${upstream}/translate_a/single?${query}`, {
          headers: {
            "accept": "application/json",
            "accept-language": "en-US,en;q=0.9",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
          }
        });

        if (!response.ok) {
          lastError = `${new URL(upstream).host} -> HTTP ${response.status}`;
          continue;
        }

        const body = await response.text();
        if (!body.trim().startsWith("[")) {
          lastError = `${new URL(upstream).host} -> challenge page`;
          continue;
        }

        // 只缓存成功结果；写入不阻塞响应。
        ctx.waitUntil(cache.put(cacheKey, new Response(body, { headers: CACHE_HEADERS })));

        return new Response(body, {
          status: 200,
          headers: { ...cors, ...CACHE_HEADERS, "x-relay-cache": "miss" }
        });
      } catch (error) {
        lastError = `${new URL(upstream).host} -> ${error.message || error}`;
      }
    }

    return json({ error: `all upstreams failed: ${lastError}` }, 502, cors);
  }
};
