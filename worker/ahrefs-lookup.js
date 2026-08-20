// Findability Calculator: Ahrefs proxy worker.
//
// Routes:
//   GET /?kw=<keyword>          -> US monthly volume for one keyword (10 units, 30d cache)
//   GET /profile?domain=<site>  -> profile a domain: category, city, top local keywords
//                                  (~600-1200 units, 7d cache)
//
// The Ahrefs API key lives only here (wrangler secret). CORS locked to the
// GitHub Pages origin. Deploy: npx wrangler deploy && npx wrangler secret put AHREFS_API_KEY

const ALLOWED_ORIGIN = "https://seo-platform-x.github.io";
const KEYWORD_RE = /^[a-z0-9][a-z0-9 '\-]{1,59}$/;
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const KW_TTL = 60 * 60 * 24 * 30;
const PROFILE_TTL = 60 * 60 * 24 * 7;
const KW_LIMIT_PER_HOUR = 20;
const PROFILE_LIMIT_PER_HOUR = 5;

const CATEGORIES = {
  plastic_surgery: ["plastic surgeon", "plastic surgery", "rhinoplasty", "breast augmentation", "tummy tuck", "liposuction", "facelift", "bbl", "mommy makeover", "blepharoplasty", "eyelid", "nose job", "gynecomastia", "body contouring", "fat transfer", "arm lift", "breast reduction"],
  med_spa: ["botox", "filler", "med spa", "medspa", "laser hair", "microneedling", "coolsculpting", "semaglutide", "tirzepatide", "morpheus8", "hydrafacial", "iv therapy", "chemical peel", "prp", "thread lift", "emsculpt", "hormone replacement", "aesthetics", "juvederm", "dysport"],
  eye_care: ["lasik", "cataract", "eye doctor", "optometrist", "ophthalmolog", "eye exam", "glaucoma", "dry eye", "icl", "prk", "keratoconus", "eye surgery", "vision", "contact lens", "retina", "eye care"],
  dental: ["dentist", "dental", "invisalign", "veneers", "teeth", "root canal", "orthodont", "braces", "dentures", "periodont", "tooth", "smile"],
  dermatology: ["dermatolog", "acne", "eczema", "psoriasis", "rosacea", "mole removal", "skin cancer", "skin tag", "skin clinic"],
  law: ["lawyer", "attorney", "law firm", "legal", "injury", "dui", "divorce", "immigration", "estate planning", "workers comp", "criminal defense"],
  cannabis: ["dispensary", "cannabis", "weed", "marijuana", "thc", "edibles", "delta 8", "delta 9", "cbd"],
  veterinary: ["vet ", "veterinar", "animal hospital", "pet ", "spay", "neuter"],
  wellness: ["chiropract", "physical therapy", "massage", "acupuncture", "cryotherapy"],
  home_services: ["hvac", "plumb", "electrician", "roof", "landscap", "pest control", "locksmith", "garage door"],
};

const VERTICAL_LABELS = {
  plastic_surgery: "Plastic Surgeon",
  med_spa: "Med Spa",
  eye_care: "LASIK & Eye Care",
};

const CITIES = ["new york","los angeles","chicago","houston","phoenix","philadelphia","san antonio","san diego","dallas","austin","jacksonville","fort worth","columbus","charlotte","san francisco","indianapolis","seattle","denver","washington","boston","el paso","nashville","detroit","oklahoma city","portland","las vegas","memphis","louisville","baltimore","milwaukee","albuquerque","tucson","fresno","sacramento","mesa","kansas city","atlanta","omaha","colorado springs","raleigh","miami","long beach","virginia beach","oakland","minneapolis","tulsa","tampa","arlington","new orleans","wichita","bakersfield","cleveland","aurora","anaheim","honolulu","santa ana","riverside","corpus christi","lexington","san jose","stockton","st louis","saint louis","pittsburgh","cincinnati","anchorage","henderson","greensboro","plano","newark","toledo","lincoln","orlando","chula vista","jersey city","chandler","fort wayne","buffalo","durham","st petersburg","irvine","laredo","lubbock","madison","gilbert","norfolk","reno","winston salem","glendale","hialeah","garland","scottsdale","irving","chesapeake","north las vegas","fremont","baton rouge","richmond","boise","san bernardino","spokane","birmingham","modesto","des moines","rochester","tacoma","fontana","oxnard","moreno valley","fayetteville","huntington beach","yonkers","glendale az","aurora il","montgomery","amarillo","little rock","akron","columbus ga","augusta","grand rapids","shreveport","salt lake city","huntsville","mobile","tallahassee","grand prairie","overland park","knoxville","worcester","brownsville","newport news","santa clarita","port st lucie","providence","fort lauderdale","chattanooga","tempe","oceanside","garden grove","rancho cucamonga","cape coral","santa rosa","vancouver wa","sioux falls","peoria","ontario ca","jackson","elk grove","springfield","pembroke pines","salem","corona","eugene","mckinney","fort collins","lancaster","cary","palmdale","hayward","salinas","frisco","pasadena","macon","alexandria","pomona","lakewood","sunnyvale","escondido","kansas city ks","hollywood fl","clarksville","torrance","rockford","joliet","paterson","bridgeport","naperville","savannah","mesquite","syracuse","dayton","pasadena tx","orange","fullerton","killeen","hampton","mcallen","warren","west valley city","columbia","olathe","sterling heights","new haven","miramar","waco","thousand oaks","cedar rapids","charleston","visalia","topeka","elizabeth","gainesville","thornton","roseville","carrollton","coral springs","stamford","simi valley","concord","hartford","kent","lafayette","midland","surprise","denton","victorville","evansville","santa clara","abilene","athens","vallejo","allentown","norman","beaumont","independence","murfreesboro","ann arbor","costa mesa","tuscaloosa","el monte","newport beach","laguna beach","mission viejo","huntington","boca raton","sarasota","naples","clearwater","the woodlands","frisco tx","bellevue","redmond","kirkland","walnut creek","palo alto","berkeley","santa monica","beverly hills","calabasas","encino","sherman oaks","tustin","fullerton ca","brea","yorba linda","dana point","san clemente","carlsbad","encinitas","la jolla","del mar","temecula","murrieta"];

function json(body, status, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

async function throttle(cache, kind, ip, limit) {
  const key = new Request(`https://cache.internal/rl/${kind}/${encodeURIComponent(ip)}`);
  const hit = await cache.match(key);
  const count = hit ? parseInt(await hit.text(), 10) || 0 : 0;
  if (count >= limit) return null;
  return () => cache.put(key, new Response(String(count + 1), { headers: { "Cache-Control": "max-age=3600" } }));
}

async function ahrefs(path, params, key) {
  const res = await fetch(`https://api.ahrefs.com/v3/${path}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`ahrefs ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function inferCategory(rows) {
  const scores = {};
  for (const r of rows) {
    const kw = " " + r.keyword + " ";
    const weight = Math.log10(2 + (r.volume || 0));
    for (const [cat, sigs] of Object.entries(CATEGORIES)) {
      if (sigs.some((s) => kw.includes(s))) scores[cat] = (scores[cat] || 0) + weight;
    }
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best ? { category: best[0], confidence: best[1] } : { category: null, confidence: 0 };
}

function inferCity(rows) {
  const scores = {};
  for (const r of rows) {
    const kw = " " + r.keyword + " ";
    for (const c of CITIES) {
      if (kw.includes(" " + c + " ") || kw.endsWith(" " + c + " ".trimEnd())) {
        scores[c] = (scores[c] || 0) + 1;
      }
    }
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

async function handleProfile(url, cache, ip, env, cors) {
  const domain = (url.searchParams.get("domain") || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  if (!DOMAIN_RE.test(domain)) return json({ error: "invalid domain" }, 400, cors);

  const cacheKey = new Request("https://cache.internal/profile/" + encodeURIComponent(domain));
  const hit = await cache.match(cacheKey);
  if (hit) return json({ ...(await hit.json()), cached: true }, 200, cors);

  const bump = await throttle(cache, "profile", ip, PROFILE_LIMIT_PER_HOUR);
  if (!bump) return json({ error: "rate limited" }, 429, cors);

  const today = new Date().toISOString().slice(0, 10);
  let data;
  try {
    data = await ahrefs("site-explorer/organic-keywords", {
      target: domain, mode: "subdomains", country: "us", date: today,
      select: "keyword,volume,best_position", order_by: "volume:desc",
      limit: "60", output: "json",
    }, env.AHREFS_API_KEY);
  } catch (e) {
    return json({ error: "upstream", detail: String(e.message).slice(0, 120) }, 502, cors);
  }

  const rows = (data.keywords || [])
    .filter((r) => r.keyword && (r.best_position == null || r.best_position <= 30))
    .map((r) => ({ keyword: r.keyword.toLowerCase(), volume: r.volume || 0, position: r.best_position }));

  const { category, confidence } = inferCategory(rows);
  const city = inferCity(rows);
  const seen = new Set();
  const top = rows
    .filter((r) => r.volume >= 50 && !seen.has(r.keyword) && seen.add(r.keyword))
    .slice(0, 8);

  const body = {
    domain, category,
    vertical: VERTICAL_LABELS[category] || null,
    confidence: Math.round(confidence * 10) / 10,
    city,
    ranking_keywords: rows.length,
    keywords: top,
  };
  bump();
  await cache.put(cacheKey, new Response(JSON.stringify(body), { headers: { "Cache-Control": `max-age=${PROFILE_TTL}` } }));
  return json(body, 200, cors);
}

async function handleKeyword(url, cache, ip, env, cors) {
  const kw = (url.searchParams.get("kw") || "").trim().toLowerCase();
  if (!KEYWORD_RE.test(kw)) return json({ error: "invalid keyword" }, 400, cors);

  const cacheKey = new Request("https://cache.internal/kw/" + encodeURIComponent(kw));
  const hit = await cache.match(cacheKey);
  if (hit) return json({ ...(await hit.json()), cached: true }, 200, cors);

  const bump = await throttle(cache, "kw", ip, KW_LIMIT_PER_HOUR);
  if (!bump) return json({ error: "rate limited" }, 429, cors);

  let data;
  try {
    data = await ahrefs("keywords-explorer/overview", {
      country: "us", keywords: kw, select: "keyword,volume", output: "json",
    }, env.AHREFS_API_KEY);
  } catch (e) {
    return json({ error: "upstream", detail: String(e.message).slice(0, 120) }, 502, cors);
  }
  const row = (data.keywords || [])[0];
  const body = { keyword: kw, volume: row && row.volume != null ? row.volume : null };
  bump();
  await cache.put(cacheKey, new Response(JSON.stringify(body), { headers: { "Cache-Control": `max-age=${KW_TTL}` } }));
  return json(body, 200, cors);
}

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405, cors);

    const url = new URL(request.url);
    const cache = caches.default;
    const ip = request.headers.get("cf-connecting-ip") || "unknown";

    if (url.pathname.endsWith("/profile")) return handleProfile(url, cache, ip, env, cors);
    return handleKeyword(url, cache, ip, env, cors);
  },
};
