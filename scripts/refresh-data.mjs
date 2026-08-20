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
  // Data-as-data: update volumes + history in data/verticals.json and the date stamp in data/meta.json.
  const vPath = join(ROOT, "data", "verticals.json");
  const verticals = JSON.parse(readFileSync(vPath, "utf8"));
  let updated = 0;
  const missing = [];
  const found = new Set();
  for (const key of Object.keys(verticals)) {
    verticals[key] = verticals[key].map((c) => {
      const fresh = snapshot.rows[c.kw];
      if (!fresh) return c;
      found.add(c.kw);
      updated++;
      return { ...c, volume: fresh.volume, history: fresh.history };
    });
  }
  for (const kw of Object.keys(snapshot.rows)) if (!found.has(kw)) missing.push(kw);
  writeFileSync(vPath, JSON.stringify(verticals, null, 1) + "\n");

  const now = new Date();
  const label = `${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
  writeFileSync(join(ROOT, "data", "meta.json"), JSON.stringify({ label }) + "\n");

  console.log(`Patched ${updated} clusters in verticals.json. Date stamp set to ${label}.`);
  if (missing.length) console.warn(`Fetched but not in any vertical: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? "\u2026" : ""}`);
  if (updated === 0) {
    console.error("Nothing was patched. Aborting so the workflow fails loudly.");
    process.exit(1);
  }
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
