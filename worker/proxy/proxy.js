// Serves the Findability Calculator at localai.life/calculator by proxying
// GitHub Pages. Root and unknown paths redirect to /calculator/ for now.

const UPSTREAM = "https://seo-platform-x.github.io/findability-calculator";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/calculator") {
      return Response.redirect(url.origin + "/calculator/", 301);
    }
    if (!url.pathname.startsWith("/calculator/")) {
      return Response.redirect(url.origin + "/calculator/", 302);
    }
    const path = url.pathname.slice("/calculator".length) || "/";
    const isAsset = /\.(js|css|json|png|svg|woff2?)$/.test(path);
    const upstream = await fetch(UPSTREAM + path + url.search, {
      headers: { "User-Agent": "localai-life-proxy" },
      cf: isAsset ? { cacheTtl: 120, cacheEverything: true } : { cacheTtl: 0 },
    });
    const headers = new Headers(upstream.headers);
    headers.delete("content-security-policy");
    headers.set("x-served-by", "localai-life-calculator-proxy");
    if (!isAsset) headers.set("Cache-Control", "no-cache, must-revalidate");
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
