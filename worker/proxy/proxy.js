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
    const upstream = await fetch(UPSTREAM + path + url.search, {
      headers: { "User-Agent": "localai-life-proxy" },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    const headers = new Headers(upstream.headers);
    headers.delete("content-security-policy");
    headers.set("x-served-by", "localai-life-calculator-proxy");
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
