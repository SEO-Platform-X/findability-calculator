// Findability Calculator: live keyword volume lookup proxy.
//
// Sits between the static GitHub Pages site and the Ahrefs API so the API key
// never ships to the browser. One lookup = one keywords-explorer/overview call
// selecting volume only (10 Ahrefs units). Results are cached for 30 days, so
// repeat lookups of the same keyword are free.
//
// Guardrails:
//   - CORS locked to the GitHub Pages origin
//   - keyword validated (2-60 chars, letters/numbers/spaces/hyphens/apostrophes)
//   - coarse per-IP throttle of 20 uncached lookups per hour
//
// Note: caches.default is per Cloudflare datacenter, not global. That means the
// occasional duplicate Ahrefs call across regions and a per-datacenter rate
// limit. Fine at this scale; swap in KV later if traffic grows.
//
// Deploy:
//   cd worker
//   npx wrangler deploy
//   npx wrangler secret put AHREFS_API_KEY   (paste your Ahrefs API key)

const ALLOWED_ORIGIN = "https://seo-platform-x.github.io";
const KEYWORD_RE = /^[a-z0-9][a-z0-9 '\-]{1,59}$/;
const RESULT_TTL_SECONDS = 60 * 60 * 24 * 30;
const IP_LIMIT_PER_HOUR = 20;

function json(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

export default {
  async fetch(request, env, ctx) {
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405, cors);

    const url = new URL(request.url);
    const kw = (url.searchParams.get("kw") || "").trim().toLowerCase();
    if (!KEYWORD_RE.test(kw)) return json({ error: "invalid keyword" }, 400, cors);

    const cache = caches.default;

    // 1. Cached result?
    const resultKey = new Request("https://cache.internal/kw/" + encodeURIComponent(kw));
    const cached = await cache.match(resultKey);
    if (cached) {
      const body = await cached.json();
      return json({ ...body, cached: true }, 200, cors);
    }

    // 2. Per-IP throttle for uncached lookups.
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const rlKey = new Request("https://cache.internal/rl/" + encodeURIComponent(ip));
    const rlHit = await cache.match(rlKey);
    const count = rlHit ? parseInt(await rlHit.text(), 10) || 0 : 0;
    if (count >= IP_LIMIT_PER_HOUR) return json({ error: "rate limited" }, 429, cors);
    ctx.waitUntil(
      cache.put(rlKey, new Response(String(count + 1), {
        headers: { "Cache-Control": "max-age=3600" },
      }))
    );

    // 3. Ask Ahrefs for US monthly volume.
    const params = new URLSearchParams({
      country: "us",
      keywords: kw,
      select: "keyword,volume",
      output: "json",
    });
    const upstream = await fetch(
      "https://api.ahrefs.com/v3/keywords-explorer/overview?" + params,
      { headers: { Authorization: `Bearer ${env.AHREFS_API_KEY}`, Accept: "application/json" } }
    );
    if (!upstream.ok) return json({ error: "upstream error", status: upstream.status }, 502, cors);

    const data = await upstream.json();
    const row = (data.keywords || [])[0];
    const body = { keyword: kw, volume: row && row.volume != null ? row.volume : null };

    ctx.waitUntil(
      cache.put(resultKey, new Response(JSON.stringify(body), {
        headers: { "Cache-Control": `max-age=${RESULT_TTL_SECONDS}` },
      }))
    );
    return json(body, 200, cors);
  },
};
