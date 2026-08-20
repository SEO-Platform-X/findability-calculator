#!/usr/bin/env node
// Builds full calculator verticals from data/new-verticals.json:
// fetches real volume + 12-month history from Ahrefs for every cluster keyword,
// splices the vertical objects into the app bundle's Xf map, and registers the
// keywords in data/keywords.json so the monthly refresh maintains them.
// Idempotent: skips verticals already present in the bundle.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = join(ROOT, "index.html");

function lastTwelveCompleteMonths(now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 11, 1));
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { from: fmt(start), to: fmt(end) };
}

const key = process.env.AHREFS_API_KEY;
if (!key) { console.error("AHREFS_API_KEY required"); process.exit(1); }

const { verticals } = JSON.parse(readFileSync(join(ROOT, "data", "new-verticals.json"), "utf8"));
let html = readFileSync(INDEX, "utf8");

const pending = Object.entries(verticals).filter(([label]) => {
  const marker = label.includes(" ") || label.includes("&") ? `"${label}":[{name:` : `${label}:[{name:`;
  return !html.includes(marker);
});
if (!pending.length) { console.log("All verticals already present. Nothing to do."); process.exit(0); }

const allKws = [...new Set(pending.flatMap(([, v]) => v.clusters.map((c) => c.kw)))];
console.log(`Fetching ${allKws.length} keywords for ${pending.length} verticals...`);

const { from, to } = lastTwelveCompleteMonths();
const rows = {};
for (let i = 0; i < allKws.length; i += 50) {
  const chunk = allKws.slice(i, i + 50);
  const params = new URLSearchParams({
    country: "us",
    keywords: chunk.join(","),
    select: "keyword,volume,volume_monthly_history",
    volume_monthly_date_from: from,
    volume_monthly_date_to: to,
    output: "json",
  });
  const res = await fetch(`https://api.ahrefs.com/v3/keywords-explorer/overview?${params}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  if (!res.ok) { console.error(`Ahrefs ${res.status}: ${await res.text()}`); process.exit(1); }
  const data = await res.json();
  for (const r of data.keywords ?? []) {
    const hist = (r.volume_monthly_history ?? []).sort((a, b) => a.date.localeCompare(b.date)).map((h) => h.volume ?? 0).slice(-12);
    if (r.volume != null && hist.length === 12) rows[r.keyword] = { volume: r.volume, history: hist };
  }
}
console.log(`Got data for ${Object.keys(rows).length}/${allKws.length} keywords.`);

const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
let snippet = "";
const added = [];
for (const [label, v] of pending) {
  const clusters = v.clusters
    .filter((c) => rows[c.kw])
    .map((c) => {
      const d = rows[c.kw];
      return `{name:"${esc(c.name)}",examples:[${c.examples.map((e) => `"${esc(e)}"`).join(",")}],kw:"${esc(c.kw)}",volume:${d.volume},value:${v.value},history:[${d.history.join(",")}]}`;
    });
  if (clusters.length < 6) { console.warn(`Skipping ${label}: only ${clusters.length} clusters with data`); continue; }
  const keyStr = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(label) ? label : `"${label}"`;
  snippet += `,${keyStr}:[${clusters.join(",")}]`;
  added.push(`${label} (${clusters.length} clusters)`);
}
if (!snippet) { console.error("No verticals could be built."); process.exit(1); }

const marker = "}]},jm=Object.keys(Xf)";
if (!html.includes(marker)) { console.error("Splice marker not found in bundle."); process.exit(1); }
html = html.replace(marker, `}]${snippet}},jm=Object.keys(Xf)`);
writeFileSync(INDEX, html);

// register keywords for the monthly refresh
const kwPath = join(ROOT, "data", "keywords.json");
const kwCfg = JSON.parse(readFileSync(kwPath, "utf8"));
kwCfg.keywords = [...new Set([...kwCfg.keywords, ...allKws.filter((k) => rows[k])])].sort();
writeFileSync(kwPath, JSON.stringify(kwCfg, null, 2) + "\n");

console.log(`Added verticals: ${added.join(", ")}`);
console.log(`keywords.json now tracks ${kwCfg.keywords.length} keywords.`);
