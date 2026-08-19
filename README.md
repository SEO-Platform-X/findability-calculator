# findability-calculator

Local AI Registry, Findability Value Calculator. What being found by AI is worth to your practice.

Live at https://seo-platform-x.github.io/findability-calculator/

## Live data

The calculator runs on real Ahrefs US search data. Two systems keep it live:

### 1. Monthly refresh of the 63 curated clusters (GitHub Actions)

`.github/workflows/refresh-ahrefs-data.yml` runs on the 5th of every month (or manually from the Actions tab). It calls the Ahrefs API, rewrites volume and 12-month history for every cluster in `index.html`, updates the visible date stamps, and commits. GitHub Pages redeploys automatically.

One-time setup: add a repo secret named `AHREFS_API_KEY` (Settings > Secrets and variables > Actions) with your Ahrefs API key.

Cost per run: about 3,850 Ahrefs API units (61 units per keyword: volume plus 12 months of history).

To change the tracked keyword set, edit `data/keywords.json`. Note that new keywords also need a matching cluster object in the app bundle.

Manual run locally:

```
AHREFS_API_KEY=xxx node scripts/refresh-data.mjs
```

Each snapshot is saved to `data/latest.json`. To re-apply a snapshot without hitting the API:

```
node scripts/refresh-data.mjs --from-file data/latest.json
```

### 2. Live volume for user-added clusters (Cloudflare Worker)

Visitors can type their own cluster into the calculator. By default those get an estimated volume. To make them pull real Ahrefs volume, deploy the proxy worker straight from GitHub:

1. Create a Cloudflare API token at dash.cloudflare.com > My Profile > API Tokens, using the "Edit Cloudflare Workers" template.
2. Add repo secrets (Settings > Secrets and variables > Actions): `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (shown on your Cloudflare dashboard sidebar), and `AHREFS_API_KEY` if not added already.
3. Actions tab > "Deploy lookup worker" > Run workflow.

The workflow deploys the worker, sets its Ahrefs key, writes the worker URL into `index.html`, pushes, and smoke tests a live lookup. If you ever deploy the worker manually instead (`cd worker && npx wrangler deploy && npx wrangler secret put AHREFS_API_KEY`), run the same workflow with the worker URL pasted into its input field and it will just wire up the site.

The worker keeps the API key server side, locks CORS to this site, validates keywords, caches results for 30 days, and throttles uncached lookups to 20 per hour per IP. Each uncached lookup costs 10 Ahrefs units; cached lookups cost nothing. If the worker is unreachable or rate limited, the calculator quietly falls back to the estimate.
