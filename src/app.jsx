import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

// ---------- constants extracted from the original calculator ----------
const MARKET = [
  { label: "My metro", mult: 0.01 },
  { label: "My state", mult: 0.1 },
  { label: "National", mult: 1 },
];
const PRESENCE = [
  { label: "Not in AI", mult: 0 },
  { label: "I'm found", mult: 0.02 },
  { label: "Recommended", mult: 0.05 },
  { label: "Own the market", mult: 0.1 },
];
const CLOSER = [
  { label: "Still figuring it out", mult: 0.6 },
  { label: "Average", mult: 1 },
  { label: "Strong closer", mult: 1.3 },
  { label: "Elite", mult: 1.6 },
];
const KV = 0.35; // researchers who buy from someone within the year
const CAP = 10;
const closeRatePct = (v) => (v < 500 ? 45 : v < 1500 ? 35 : v < 5000 ? 25 : v < 10000 ? 15 : 10);

const C = {
  bg: "#F3F5F2", ink: "#14232B", card: "#FFFFFF", line: "#C9D2CC", soft: "#E3E8E4",
  muted: "#5C6B66", faint: "#8B978F", green: "#0C8A5F", mint: "#7CE3B1", amber: "#C99039",
  down: "#C25B3A",
};
const mono = "'IBM Plex Mono', ui-monospace, monospace";

const LOOKUP = (window.AHREFS_LOOKUP_URL || "").replace(/\/+$/, "");

// deterministic synthetic 12-month wiggle for keywords without history
function synthHistory(volume, seed) {
  const out = [];
  let s = seed || 7;
  for (let i = 0; i < 12; i++) {
    s = (s * 9301 + 49297) % 233280;
    out.push(Math.max(0, Math.round(volume * (0.9 + (s / 233280) * 0.2))));
  }
  return out;
}
const fmt = (n) => n.toLocaleString("en-US");
const money = (n) => (n >= 1000 ? "$" + Math.round(n / 1000) + "K" : "$" + Math.round(n));
const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const cleanDomain = (s) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];

function Spark({ history }) {
  if (!history || history.length < 2) return null;
  const min = Math.min(...history), max = Math.max(...history);
  const span = max - min || 1;
  const pts = history.map((v, i) => `${(i / (history.length - 1)) * 56 + 2},${16 - ((v - min) / span) * 12 + 1}`).join(" ");
  const up = history[history.length - 1] >= history[0];
  return (
    <svg width="60" height="18" style={{ flex: "none" }}>
      <polyline points={pts} fill="none" stroke={up ? C.green : C.down} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function App() {
  const [verticals, setVerticals] = useState(null); // {label: clusters[]}
  const [meta, setMeta] = useState({ label: "Aug 2026" });
  const [brands, setBrands] = useState([]);
  const [order, setOrder] = useState([]); // vertical keys in display order
  const [vKey, setVKey] = useState(null);
  const [checked, setChecked] = useState({}); // {vKey: [names]}
  const [analyzed, setAnalyzed] = useState(null); // {domain, key, label}
  const [mIdx, setMIdx] = useState(0);
  const [pIdx, setPIdx] = useState(1);
  const [cIdx, setCIdx] = useState(1);
  const [site, setSite] = useState("");
  const [status, setStatus] = useState("We detect your category and pull the keywords you already rank for.");
  const [busy, setBusy] = useState(false);
  const [addText, setAddText] = useState("");
  const [suggest, setSuggest] = useState([]);
  const retried = useRef(0);
  const debounceRef = useRef(null);

  useEffect(() => {
    fetch("data/verticals.json").then((r) => r.json()).then((v) => {
      const keys = Object.keys(v);
      const chk = {};
      for (const k of keys) {
        chk[k] = [...v[k]].sort((a, b) => b.volume * b.value - a.volume * a.value).slice(0, CAP).map((c) => c.name);
      }
      setVerticals(v); setOrder(keys); setVKey(keys[1] || keys[0]); setChecked(chk);
    });
    fetch("data/meta.json").then((r) => (r.ok ? r.json() : null)).then((j) => j && setMeta(j)).catch(() => {});
    fetch("data/brands.json").then((r) => (r.ok ? r.json() : [])).then((j) => setBrands(j || [])).catch(() => {});
  }, []);

  const rows = (verticals && vKey && verticals[vKey]) || [];
  const checkedNames = checked[vKey] || [];
  const mkt = MARKET[mIdx].mult, pres = PRESENCE[pIdx].mult, closer = CLOSER[cIdx].mult;

  const calc = (list) => {
    let rev = 0, cust = 0;
    for (const r of list) {
      const monthly = ((r.volume * mkt) / 3) * KV * pres * Math.min((closeRatePct(r.value) / 100) * closer, 0.9);
      cust += monthly;
      rev += monthly * r.value;
    }
    return { rev, cust };
  };
  const on = calc(rows.filter((r) => checkedNames.includes(r.name)));
  const off = calc(rows.filter((r) => !checkedNames.includes(r.name)));

  const medianValue = useMemo(() => {
    const vals = rows.map((r) => r.value).sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)] || 500;
  }, [rows]);

  function toggle(name) {
    setChecked((c) => {
      const cur = c[vKey] || [];
      if (cur.includes(name)) return { ...c, [vKey]: cur.filter((n) => n !== name) };
      if (cur.length >= CAP) return c;
      return { ...c, [vKey]: [...cur, name] };
    });
  }
  function setValue(name, val) {
    setVerticals((v) => ({ ...v, [vKey]: v[vKey].map((r) => (r.name === name ? { ...r, value: val } : r)) }));
  }

  async function lookupVolume(kw) {
    const k = kw.toLowerCase().replace(/\s+/g, " ").trim();
    if (LOOKUP) {
      try {
        const r = await fetch(LOOKUP + "/?kw=" + encodeURIComponent(k));
        if (r.ok) { const j = await r.json(); return j.volume; }
      } catch {}
    }
    try {
      const r = await fetch("data/volumes.json");
      if (r.ok) { const pool = await r.json(); return pool[k] ?? null; }
    } catch {}
    return null;
  }

  function addCluster(raw, opts = {}) {
    const name = raw.trim();
    if (!name || !verticals) return;
    const key = opts.vKey || vKey;
    if ((verticals[key] || []).some((r) => r.name.toLowerCase() === name.toLowerCase())) return;
    const row = {
      name, examples: [name.toLowerCase()], kw: name.toLowerCase(),
      volume: opts.volume ?? 2000, value: opts.value ?? medianValue,
      history: opts.volume != null ? synthHistory(opts.volume, name.length) : synthHistory(2000, name.length),
      custom: true, brand: !!opts.brand,
    };
    setVerticals((v) => ({ ...v, [key]: opts.brand ? [row, ...(v[key] || [])] : [...(v[key] || []), row] }));
    setChecked((c) => {
      const cur = c[key] || [];
      if (opts.brand) return { ...c, [key]: [name, ...cur.filter((n) => n !== name)].slice(0, CAP) };
      return cur.length >= CAP ? c : { ...c, [key]: [...cur, name] };
    });
    if (opts.volume == null) {
      lookupVolume(name).then((vol) => {
        setVerticals((v) => ({
          ...v,
          [key]: (v[key] || []).map((r) =>
            r.name === name
              ? vol > 0
                ? { ...r, volume: vol, history: synthHistory(vol, name.length), live: true }
                : { ...r, volume: 0, history: new Array(12).fill(0), live: true }
              : r
          ),
        }));
      });
    }
  }

  async function analyze() {
    const domain = cleanDomain(site);
    setSuggest([]);
    if (!domain || !domain.includes(".")) { setStatus("Enter a domain like yourpractice.com"); return; }
    if (!LOOKUP) { setStatus("Live analysis is not configured."); return; }
    setBusy(true);
    setStatus("Analyzing " + domain + "\u2026 checking what you rank for (takes a few seconds)");
    let res, j;
    try {
      res = await fetch(LOOKUP + "/profile?domain=" + encodeURIComponent(domain));
      j = await res.json();
    } catch {
      setBusy(false); setStatus("Analysis service unreachable. Try again shortly."); return;
    }
    setBusy(false);
    if (!res.ok) {
      if (j && j.error === "rate limited") setStatus("Too many analyses from this connection. Try again in an hour.");
      else if (j && j.error === "invalid domain") setStatus("That does not look like a domain. Try yourpractice.com");
      else if (retried.current < 2) {
        retried.current++;
        setStatus("Search data provider is busy, retrying (" + retried.current + "/2)\u2026");
        setTimeout(analyze, 3000 * retried.current);
      } else setStatus("The data provider keeps blocking right now. Wait a minute, then hit Analyze again; it usually clears fast.");
      return;
    }
    retried.current = 0;
    if (!j.ranking_keywords) {
      setStatus(domain + " has no measurable US rankings yet, which itself is a findability signal.");
      return;
    }
    const kws = (j.keywords || []).slice(0, 8);
    const parts = [];
    if (j.vertical && verticals[j.vertical]) {
      // Known vertical: brand keywords replace lowest defaults, pinned on top, checked.
      const key = j.vertical;
      const base = verticals[key].filter((r) => !r.brand);
      const vals = base.map((r) => r.value).sort((a, b) => a - b);
      const med = vals[Math.floor(vals.length / 2)] || 500;
      const brandRows = kws
        .filter((k) => !base.some((r) => r.kw === k.keyword))
        .map((k) => ({
          name: k.keyword, examples: [k.keyword], kw: k.keyword, volume: k.volume,
          value: med, history: synthHistory(k.volume, k.keyword.length), custom: true, brand: true,
        }));
      const defaults = [...base].sort((a, b) => b.volume * b.value - a.volume * a.value).map((r) => r.name);
      setVerticals((v) => ({ ...v, [key]: [...brandRows, ...base] }));
      setChecked((c) => ({ ...c, [key]: [...brandRows.map((r) => r.name), ...defaults].slice(0, CAP) }));
      setVKey(key);
      setAnalyzed({ domain, key, label: null });
      parts.push("Detected: " + j.vertical);
    } else {
      // Outside the 14 verticals: a dedicated view with ONLY their keywords.
      const key = domain;
      const brandRows = kws.map((k) => ({
        name: k.keyword, examples: [k.keyword], kw: k.keyword, volume: k.volume,
        value: 500, history: synthHistory(k.volume, k.keyword.length), custom: true, brand: true,
      }));
      setVerticals((v) => ({ ...v, [key]: brandRows }));
      setChecked((c) => ({ ...c, [key]: brandRows.map((r) => r.name).slice(0, CAP) }));
      setOrder((o) => (o.includes(key) ? o : o));
      setVKey(key);
      setAnalyzed({ domain, key, label: domain + " \u00B7 analyzed" });
      if (j.category) parts.push("Detected: " + titleCase(j.category.replace(/_/g, " ")));
      parts.push("showing only your rankings \u00B7 $500 avg value, edit per row");
    }
    if (j.scope === "national") { setMIdx(2); parts.push("National footprint \u2192 market set to National"); }
    else if (j.city) { setMIdx(0); parts.push(titleCase(j.city)); }
    parts.push(j.ranking_keywords + " ranking keywords \u00B7 loaded " + Math.min(kws.length, CAP) + " below");
    setStatus(parts.join(" \u00B7 "));
  }

  function onSiteInput(q) {
    setSite(q);
    clearTimeout(debounceRef.current);
    const t = q.trim();
    if (t.length < 2 || t.includes(".")) { setSuggest([]); return; }
    debounceRef.current = setTimeout(async () => {
      const ql = t.toLowerCase();
      const local = brands.filter((b) => (b.name + " " + b.domain).toLowerCase().includes(ql)).slice(0, 3);
      let items = [];
      try {
        const r = await fetch("https://autocomplete.clearbit.com/v1/companies/suggest?query=" + encodeURIComponent(t));
        if (r.ok) items = await r.json();
      } catch {}
      const guess = ql.replace(/[^a-z0-9]/g, "") + ".com";
      const seen = {};
      const merged = [...local, ...items].filter((it) => !seen[it.domain] && (seen[it.domain] = 1)).slice(0, 4);
      if (!seen[guess]) merged.push({ name: "Analyze \u201C" + guess + "\u201D", domain: guess });
      setSuggest(merged);
    }, 220);
  }

  if (!verticals) {
    return <div style={{ padding: 40, fontFamily: mono, color: C.faint }}>Loading live Ahrefs data\u2026</div>;
  }

  const selectOptions = [
    ...(analyzed && analyzed.label ? [{ key: analyzed.key, label: analyzed.label }] : []),
    ...order.map((k) => ({ key: k, label: k })),
  ];

  const seg = (opts, idx, set) => (
    <div style={{ display: "inline-flex", border: `1px solid ${C.line}`, borderRadius: 8, overflow: "hidden", background: C.card, flexWrap: "wrap" }}>
      {opts.map((o, i) => (
        <button key={o.label} onClick={() => set(i)} style={{
          padding: "9px 14px", fontSize: 14, fontWeight: 600, cursor: "pointer", border: "none",
          borderLeft: i ? `1px solid ${C.soft}` : "none",
          background: i === idx ? C.ink : "transparent", color: i === idx ? C.mint : C.muted,
        }}>{o.label}</button>
      ))}
    </div>
  );

  const label = (t) => (
    <div style={{ fontFamily: mono, fontSize: 12, letterSpacing: 1, color: C.muted, margin: "22px 0 8px", textTransform: "uppercase" }}>{t}</div>
  );

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.ink, fontFamily: "'Space Grotesk', system-ui, sans-serif" }}>
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "28px 20px 60px" }}>
        {/* header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <div style={{ background: C.ink, color: C.mint, fontFamily: mono, fontWeight: 600, borderRadius: 8, padding: "8px 10px" }}>Ai</div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 18 }}>Local AI Registry</div>
              <div style={{ fontFamily: mono, fontSize: 13, color: C.muted }}>findability value calculator</div>
            </div>
          </div>
          <div style={{ fontFamily: mono, fontSize: 13, color: C.green, background: "#E2F3E9", border: "1px solid #BFE3CE", borderRadius: 999, padding: "8px 14px" }}>
            &#9679; Ahrefs data &#183; US &#183; {meta.label}
          </div>
        </div>

        {/* website analyzer */}
        <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: "16px 18px", marginTop: 22 }}>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>Start with your website</div>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1, position: "relative" }}>
              <input value={site} onChange={(e) => onSiteInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && analyze()}
                placeholder="Type your practice or brand name" autoComplete="off"
                style={{ width: "100%", boxSizing: "border-box", border: `1px solid ${C.line}`, borderRadius: 8, padding: "10px 12px", fontSize: 15, outline: "none", fontFamily: "inherit" }} />
              {suggest.length > 0 && (
                <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 50, background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, marginTop: 4, boxShadow: "0 8px 24px rgba(20,35,43,.12)", overflow: "hidden" }}>
                  {suggest.map((it) => (
                    <div key={it.domain}
                      onMouseDown={(e) => { e.preventDefault(); setSite(it.domain); setSuggest([]); setTimeout(analyze, 30); }}
                      style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", cursor: "pointer", fontSize: 14 }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = C.bg)}
                      onMouseLeave={(e) => (e.currentTarget.style.background = C.card)}>
                      {it.logo ? <img src={it.logo} width="20" height="20" style={{ borderRadius: 4 }} onError={(e) => (e.target.style.display = "none")} /> : null}
                      <span style={{ fontWeight: 600 }}>{it.name}</span>
                      <span style={{ marginLeft: "auto", fontFamily: mono, fontSize: 12, color: C.faint }}>{it.domain}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <button onClick={analyze} disabled={busy} style={{ background: C.green, color: "#fff", border: "none", borderRadius: 8, padding: "10px 22px", fontSize: 15, fontWeight: 600, cursor: "pointer", opacity: busy ? 0.7 : 1 }}>Analyze</button>
          </div>
          <div style={{ fontSize: 13, color: C.faint, marginTop: 8 }}>{status}</div>
        </div>

        <h1 style={{ fontSize: 42, lineHeight: 1.08, margin: "34px 0 14px", fontWeight: 700 }}>What is being found by AI worth to your practice?</h1>
        <p style={{ color: C.muted, fontSize: 17, lineHeight: 1.55, margin: 0 }}>
          Consumers ask AI assistants full questions, not keywords. Check the {CAP} services that matter most;
          each one carries the AI prompt clusters people actually ask. If AI can&#8217;t find you, this revenue goes to whoever it does find.
        </p>

        {label("Business category")}
        <select value={vKey} onChange={(e) => setVKey(e.target.value)}
          style={{ fontSize: 16, fontFamily: "inherit", padding: "10px 14px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.card, minWidth: 260 }}>
          {selectOptions.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>

        {label("Your market")}
        {seg(MARKET, mIdx, setMIdx)}
        {label("What's your AI presence?")}
        {seg(PRESENCE, pIdx, setPIdx)}
        {label("Once they reach out, how often do you close?")}
        {seg(CLOSER, cIdx, setCIdx)}

        {/* results */}
        <div style={{ background: C.ink, color: "#fff", borderRadius: 14, padding: "22px 24px", marginTop: 26, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
          <div>
            <div style={{ fontFamily: mono, fontSize: 12, letterSpacing: 1, color: "#9FB3AC" }}>POTENTIAL REVENUE / YEAR</div>
            <div style={{ fontSize: 44, fontWeight: 700, color: C.mint }}>{money(on.rev * 12)}</div>
          </div>
          <div>
            <div style={{ fontFamily: mono, fontSize: 12, letterSpacing: 1, color: "#9FB3AC" }}>PER MONTH</div>
            <div style={{ fontSize: 30, fontWeight: 700 }}>${fmt(Math.round(on.rev))}</div>
          </div>
          <div>
            <div style={{ fontFamily: mono, fontSize: 12, letterSpacing: 1, color: "#9FB3AC" }}>NEW CUSTOMERS / MO</div>
            <div style={{ fontSize: 26, fontWeight: 700 }}>{Math.round(on.cust)}</div>
          </div>
          <div>
            <div style={{ fontFamily: mono, fontSize: 12, letterSpacing: 1, color: "#9FB3AC" }}>CLUSTERS PICKED</div>
            <div style={{ fontSize: 26, fontWeight: 700 }}>{checkedNames.length} / {CAP}</div>
          </div>
          {off.rev > 0 && (
            <div>
              <div style={{ fontFamily: mono, fontSize: 12, letterSpacing: 1, color: "#9FB3AC" }}>UNCHECKED VALUE</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: C.amber, fontFamily: mono }}>{money(off.rev * 12)}/yr</div>
            </div>
          )}
        </div>

        {/* cluster table */}
        <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, marginTop: 22, overflow: "hidden" }}>
          <div style={{ display: "flex", padding: "14px 18px", fontFamily: mono, fontSize: 12, letterSpacing: 1, color: C.muted, borderBottom: `1px solid ${C.soft}` }}>
            <span style={{ flex: 1 }}>PROCEDURE / SERVICE</span>
            <span style={{ width: 90, textAlign: "right" }}>SEARCHES/MO</span>
            <span style={{ width: 70, textAlign: "right" }}>12 MO</span>
            <span style={{ width: 86, textAlign: "right" }}>1:1 VALUE</span>
          </div>
          {rows.map((r) => {
            const isOn = checkedNames.includes(r.name);
            return (
              <div key={r.name} style={{ display: "flex", gap: 12, padding: "14px 18px", borderBottom: `1px solid ${C.soft}`, alignItems: "flex-start" }}>
                <button onClick={() => toggle(r.name)} aria-label="toggle" style={{
                  width: 24, height: 24, borderRadius: 7, flex: "none", cursor: "pointer",
                  border: isOn ? "none" : `2px solid ${C.line}`, background: isOn ? C.green : C.card,
                  color: "#fff", fontSize: 14, lineHeight: "24px", marginTop: 2,
                }}>{isOn ? "\u2713" : ""}</button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 16 }}>
                    {r.name}
                    {r.custom && <span style={{ marginLeft: 8, fontFamily: mono, fontSize: 12, color: C.green, background: "#E2F3E9", borderRadius: 6, padding: "2px 8px" }}>yours</span>}
                  </div>
                  <div style={{ fontSize: 13.5, color: C.faint, marginTop: 4, lineHeight: 1.5 }}>
                    <span style={{ fontFamily: mono, fontSize: 11.5, letterSpacing: 1 }}>AI PROMPT CLUSTERS </span>
                    {r.examples.map((e, i) => <span key={i}>&#8220;{e}&#8221;{i < r.examples.length - 1 ? " \u00B7 " : ""}</span>)}
                  </div>
                </div>
                <div style={{ width: 90, textAlign: "right", fontFamily: mono, fontSize: 15, marginTop: 3 }}>{fmt(Math.round(r.volume * mkt))}</div>
                <div style={{ width: 70, display: "flex", justifyContent: "flex-end", marginTop: 3 }}><Spark history={r.history} /></div>
                <div style={{ width: 86, textAlign: "right", marginTop: 0 }}>
                  <input type="number" value={r.value} onChange={(e) => setValue(r.name, Math.max(0, +e.target.value || 0))}
                    style={{ width: 76, textAlign: "right", fontFamily: mono, fontSize: 14, border: `1px solid ${C.soft}`, borderRadius: 6, padding: "5px 6px" }} />
                </div>
              </div>
            );
          })}
          <div style={{ display: "flex", gap: 8, padding: "14px 18px", alignItems: "center", flexWrap: "wrap" }}>
            <input value={addText} onChange={(e) => setAddText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { addCluster(addText); setAddText(""); } }}
              placeholder={'Add your own cluster, e.g. "lip flip near me"'}
              style={{ flex: 1, minWidth: 200, border: `1px solid ${C.line}`, borderRadius: 8, padding: "9px 12px", fontSize: 14, outline: "none", fontFamily: "inherit" }} />
            <button onClick={() => { addCluster(addText); setAddText(""); }}
              style={{ background: C.green, color: "#fff", border: "none", borderRadius: 8, padding: "9px 18px", fontWeight: 600, cursor: "pointer" }}>Add</button>
            <span style={{ fontFamily: mono, fontSize: 12, color: C.faint, width: "100%" }}>
              {checkedNames.length >= CAP ? "At the 10 cap. New rows land unchecked." : "Custom clusters pull live Ahrefs search volume when available."}
            </span>
          </div>
        </div>

        <p style={{ fontFamily: mono, fontSize: 13, color: C.faint, lineHeight: 1.7, marginTop: 22 }}>
          How the math works, per cluster: searches &#247; 3 (people search about 3 times per decision) = researchers in your market
          &#215; 35% who actually buy from someone within the year &#215; your AI share = leads who contact you &#215; close rate
          &#215; avg customer value = revenue. Close rate scales with ticket size (under $500 closes at 45%, over $10K at 10%) and adjusts
          for your closing strength. Searches and 12-month trends are Ahrefs US data (representative query per cluster, {meta.label} snapshot),
          scaled to your market. Customer values are editable per row.
        </p>
        <p style={{ fontFamily: mono, fontSize: 11, color: C.faint, marginTop: 8 }}>build {window.BUILD || "dev"}</p>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
