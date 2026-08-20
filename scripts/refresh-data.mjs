#!/usr/bin/env node
// Refreshes the Findability Calculator with live Ahrefs keyword data.
//
// Modes:
//   node scripts/refresh-data.mjs                        -> fetch from Ahrefs API (needs AHREFS_API_KEY), patch index.html, write data/latest.json
//   node scripts/refresh-data.mjs --from-file data/latest.json  -> skip fetch, patch index.html from an existing snapshot
//
// What it patches in index.html:
//   1. volume + 12-month history for each cluster (matched by kw:"...")
//   2. the "Ahrefs data · US · <Mon YYYY>" badge and "<Mon YYYY> snapshot" footnote

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = join(ROOT, "index.html");
const KEYWORDS_FILE = join(ROOT, "data", "keywords.json");
const LATEST_FILE = join(ROOT, "data", "latest.json");

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function lastTwelveCompleteMonths(now = new Date()) {
  // Range ends with the last complete month.
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)); // last day of previous month
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 11, 1));
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { from: fmt(start), to: fmt(end) };
}

async function fetchFromAhrefs() {
  const key = process.env.AHREFS_API_KEY;
  if (!key) {
    console.error("AHREFS_API_KEY env var is required in fetch mode.");
    process.exit(1);
  }
  const { keywords, country } = JSON.parse(readFileSync(KEYWORDS_FILE, "utf8"));
  const { from, to } = lastTwelveCompleteMonths();

  const params = new URLSearchParams({
    country,
    keywords: keywords.join(","),
    select: "keyword,volume,volume_monthly_history",
    volume_monthly_date_from: from,
    volume_monthly_date_to: to,
    output: "json",
  });

  const res = await fetch(`https://api.ahrefs.com/v3/keywords-explorer/overview?${params}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  if (!res.ok) {
    console.error(`Ahrefs API error ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const body = await res.json();
  const rows = {};
  for (const row of body.keywords ?? []) {
    const history = (row.volume_monthly_history ?? [])
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((h) => h.volume)
      .slice(-12);
    if (row.volume == null || history.length !== 12 || history.some((v) => v == null)) {
      console.warn(`Skipping "${row.keyword}": incomplete data (volume=${row.volume}, history=${history.length} pts). Keeping previous values.`);
      continue;
    }
    rows[row.keyword] = { volume: row.volume, history };
  }
  return { fetched_at: new Date().toISOString(), country, range: { from, to }, rows };
}

function loadFromFile(path) {
  return JSON.parse(readFileSync(join(ROOT, path), "utf8"));
}

function patchIndex(snapshot) {
  let html = readFileSync(INDEX, "utf8");
  let updated = 0;
  const missing = [];

  for (const [kw, { volume, history }] of Object.entries(snapshot.rows)) {
    const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `(kw:"${esc}",volume:)[0-9.e]+(,value:[0-9.e]+,history:\\[)[0-9.e,]*(\\])`
    );
    if (!re.test(html)) {
      missing.push(kw);
      continue;
    }
    html = html.replace(re, `$1${volume}$2${history.join(",")}$3`);
    updated++;
  }

  // Refresh the visible date stamps ("Ahrefs data \xB7 US \xB7 Aug 2026" and "Aug 2026 snapshot").
  const now = new Date();
  const label = `${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
  html = html.replace(
    /(Ahrefs data \\xB7 US \\xB7 )[A-Z][a-z]{2} 20\d{2}/g,
    `$1${label}`
  );
  html = html.replace(/[A-Z][a-z]{2} 20\d{2}( snapshot)/g, `${label}$1`);

  writeFileSync(INDEX, html);
  console.log(`Patched ${updated} clusters. Date stamp set to ${label}.`);
  if (missing.length) {
    console.warn(`No match in index.html for: ${missing.join(", ")}`);
  }
  if (updated === 0) {
    console.error("Nothing was patched. Aborting so the workflow fails loudly.");
    process.exit(1);
  }
}

// ---- Prefill keyword pool for user-added clusters --------------------------
// Pulls top keywords by US volume per category (data/pool-seeds.json) via the
// matching-terms endpoint and writes a flat {keyword: volume} lookup that the
// site checks when a visitor adds a custom cluster. Cost: 10 units per keyword.

async function refreshPool() {
  const key = process.env.AHREFS_API_KEY;
  if (!key) {
    console.error("AHREFS_API_KEY env var is required for pool refresh.");
    process.exit(1);
  }
  const { categories, per_category_limit } = JSON.parse(
    readFileSync(join(ROOT, "data", "pool-seeds.json"), "utf8")
  );
  const pool = {};
  let fetched = 0;
  for (const [category, seeds] of Object.entries(categories)) {
    const params = new URLSearchParams({
      country: "us",
      keywords: seeds.join(","),
      select: "keyword,volume",
      order_by: "volume:desc",
      limit: String(per_category_limit),
      match_mode: "terms",
      output: "json",
    });
    const res = await fetch(
      `https://api.ahrefs.com/v3/keywords-explorer/matching-terms?${params}`,
      { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } }
    );
    if (!res.ok) {
      console.error(`Pool fetch failed for "${category}" (${res.status}): ${await res.text()}`);
      process.exit(1);
    }
    const data = await res.json();
    let added = 0;
    for (const row of data.keywords ?? []) {
      if (!row.keyword || row.volume == null || row.volume <= 0) continue;
      const kw = row.keyword.toLowerCase().replace(/\s+/g, " ").trim();
      pool[kw] = Math.max(pool[kw] ?? 0, row.volume);
      added++;
    }
    fetched += added;
    console.log(`  ${category}: ${added} keywords`);
  }
  const sorted = Object.fromEntries(Object.entries(pool).sort((a, b) => b[1] - a[1]));
  writeFileSync(join(ROOT, "data", "volumes.json"), JSON.stringify(sorted) + "\n");
  console.log(`Pool written: ${Object.keys(sorted).length} unique keywords (${fetched} fetched, ~${fetched * 10} units).`);
}

const poolOnly = process.argv.includes("--pool-only");
const withPool = process.argv.includes("--pool");
const fromFileIdx = process.argv.indexOf("--from-file");

if (poolOnly) {
  await refreshPool();
} else {
  let snapshot;
  if (fromFileIdx !== -1) {
    snapshot = loadFromFile(process.argv[fromFileIdx + 1]);
    console.log(`Using snapshot from file (fetched ${snapshot.fetched_at}).`);
  } else {
    snapshot = await fetchFromAhrefs();
    mkdirSync(join(ROOT, "data"), { recursive: true });
    writeFileSync(LATEST_FILE, JSON.stringify(snapshot, null, 2) + "\n");
    console.log(`Fetched ${Object.keys(snapshot.rows).length} keywords from Ahrefs (${snapshot.range.from} to ${snapshot.range.to}).`);
  }
  patchIndex(snapshot);
  if (withPool) await refreshPool();
}
