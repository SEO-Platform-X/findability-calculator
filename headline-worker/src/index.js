const ANGLES = [
  "accuracy errors: wrong hours, phones, addresses, services across local businesses",
  "invisibility and concentration: AI recommends the same few businesses per city, most are never named",
  "ghost businesses: AI confidently recommends closed, moved, or rebranded businesses",
  "estimated revenue loss: modeled dollars lost per month to AI referrals a business never sees",
  "credential confusion: AI merges doctors, misstates board certification and specialties",
  "pricing errors: AI quotes prices far off from real menus, usually too high",
  "reviews vs AI mismatch: top-rated businesses invisible while weaker-rated ones dominate answers",
  "new businesses: recently opened or relocated businesses described by their old identity or not at all",
  "compliance risk: AI gives wrong legal or regulated details for dispensaries, med spas, contractors",
  "trust gap: consumers trust AI answers more than the data behind them deserves",
];

const REAL_STATS = `Real published statistics you may anchor to (attribute loosely as industry research, do not invent sources):
- 45% of consumers used AI tools to find local businesses in the past year, up from 6% the year before (BrightLocal 2026), making AI the third most-used local discovery channel behind Google and Facebook.
- Among US households earning $150,000 or more, AI has already passed Google as the starting point for local business searches (Yext 2026).
- ChatGPT recommends only about 1.2% of local business locations; Google's three-pack surfaces 35.9% (SOCi 2026 Local Visibility Index, 350,000 locations).
- 93% of companies had at least one basic fact hallucinated or missing in AI answers; 50% of small businesses received at least one fabricated fact (Searchable, 13,000+ queries, 2026).
- 88% of local businesses have no active strategy for AI search visibility.`;

function buildPrompt(existingHeadlines, angle) {
  return `You are writing a mock press article announcing findings from a study by Local AI Registry, a company that creates verified business profiles for AI engines. The study has not been run yet; this article is a target the team will design the study to validate. Write it exactly as it would be published.

Angle for this article: ${angle}

${REAL_STATS}

Rules:
- Headline and article are about "AI" generically. Never name ChatGPT, Gemini, Perplexity, or Claude.
- Cover local businesses broadly (dentists, dermatologists, med spas, lasik centers, contractors, law firms, restaurants, dispensaries, plastic surgeons), with one or two vertical-specific findings inside the article.
- Attribute the new findings to an audit or analysis by Local AI Registry. Invent specific, believable study numbers: query counts in the thousands, 20 to 30 US markets, and ugly non-round percentages like 91%, 87%, 6%, 34%. Never use suspiciously clean numbers like 98% or 50% for the new findings.
- Include exactly one short quote from Steve Lee, CEO of Local AI Registry. Plain spoken, no hype words.
- Plain language for non-technical readers. Short paragraphs, 4 to 6 total, roughly 220 to 300 words.
- Absolutely no em dashes anywhere. No bullet lists. No marketing call to action. It should read like research coverage, not an ad.
- End with one paragraph explaining the structural cause: AI assembles its picture of businesses from third-party data, and thin or stale footprints get confident guesswork.

Do not reuse these existing headlines or their central claim:
${existingHeadlines.length ? existingHeadlines.map((h) => "- " + h).join("\n") : "- none yet"}

Respond in EXACTLY this plain text format, nothing before or after it:
HEADLINE: the full headline on one line
BODY:
the article paragraphs, separated by blank lines`;
}

async function loadPool(env, limit) {
  const list = await env.POOL.list({ prefix: "article:" });
  const articles = [];
  for (const k of list.keys) {
    const v = await env.POOL.get(k.name);
    if (v) {
      try { articles.push(JSON.parse(v)); } catch (e) {}
    }
  }
  articles.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return limit ? articles.slice(0, limit) : articles;
}

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,X-Passcode",
    };
    const json = (obj, status) =>
      new Response(JSON.stringify(obj), {
        status: status || 200,
        headers: Object.assign({ "Content-Type": "application/json" }, cors),
      });

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(request.url);

    if (url.pathname === "/articles" && request.method === "GET") {
      return json({ articles: await loadPool(env) });
    }

    if (request.method === "POST" || request.method === "DELETE") {
      const passcode = request.headers.get("X-Passcode") || "";
      if (passcode !== env.HEADLINE_PASSCODE) return json({ error: "wrong passcode" }, 401);
    }

    if (url.pathname === "/generate" && request.method === "POST") {
      const recent = await loadPool(env, 30);
      const usedAngles = recent.slice(0, 4).map((a) => a.angle);
      const fresh = ANGLES.filter((a) => !usedAngles.includes(a));
      const pool = fresh.length ? fresh : ANGLES;
      const angle = pool[Math.floor(Math.random() * pool.length)];

      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "user-agent": "headline-lab-worker/1.0",
        },
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: 1000,
          messages: [{ role: "user", content: buildPrompt(recent.map((a) => a.headline), angle) }],
        }),
      });
      const raw = await resp.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        return json({ error: "upstream " + resp.status + ": " + raw.slice(0, 300) }, 502);
      }
      if (data.error) return json({ error: (data.error.message || "model API error") + " [" + resp.status + "]" }, 502);
      const text = (data.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      const headlineMatch = text.match(/HEADLINE:\s*(.+)/);
      const bodyIndex = text.indexOf("BODY:");
      if (!headlineMatch || bodyIndex === -1) return json({ error: "unexpected model output" }, 502);
      const headline = headlineMatch[1].trim();
      let body = text.slice(bodyIndex + 5).trim();
      if (data.stop_reason === "max_tokens") {
        const parts = body.split(/\n\n+/);
        if (parts.length > 1) parts.pop();
        body = parts.join("\n\n");
      }
      if (!headline || !body) return json({ error: "incomplete article" }, 502);

      const article = {
        id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
        headline: headline,
        body: body,
        angle: angle,
        createdAt: new Date().toISOString(),
      };
      await env.POOL.put("article:" + article.id, JSON.stringify(article));
      return json({ article: article });
    }

    if (url.pathname.indexOf("/articles/") === 0 && request.method === "DELETE") {
      const id = url.pathname.split("/").pop();
      await env.POOL.delete("article:" + id);
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  },
};
