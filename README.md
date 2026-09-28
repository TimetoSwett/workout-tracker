# Workout Tracker

A free, offline-first PWA for logging workouts. Data syncs to **your own Dropbox**, and an AI coach (Claude or any OpenAI-compatible API like NanoGPT) reviews your training history.

**Live app:** https://timetoswett.github.io/workout-tracker/

## Features

- **Log** — set-by-set weight/reps entry, exercise autocomplete, workout templates, rest timer with vibration, duration tracking
- **History** — weekly volume chart, best lifts (PRs), full workout details, CSV/JSON export
- **Body** — weight/body-fat trends, steps and sleep charts (from Samsung Health CSV imports or manual entry), synced to Dropbox as `metrics.jsonl`
- **Insights** — AI analysis of your last 2–12 weeks with a selectable coaching philosophy (**Balanced**, **Powerlifting**, **Hypertrophy**, or **Hybrid** strength + size), always-on recovery monitoring that recommends rest days/deloads when your logs show fatigue, calorie/macro prescriptions when you set a goal (cut/maintain/bulk), an optional athlete profile (age, height, bodyweight, injuries) for tailored advice, and follow-up chat
- **Sync** — all workouts stored as plain JSONL in your Dropbox at `/Apps/Workout Tracker/workouts.jsonl` — your data, readable by anything
- **Offline-first** — works with zero signal in the gym; syncs when back online

No accounts, no server, no subscription. Everything (including your API keys) stays in your browser's localStorage.

## Install on your phone (Android)

1. Open the live app URL in Chrome
2. Menu → **Add to Home screen** → Install
3. It launches fullscreen like a native app and works offline

## One-time setup

### Dropbox (storage)

1. Go to [dropbox.com/developers/apps](https://www.dropbox.com/developers/apps) → **Create app**
2. Choose **App folder** access, name it `Workout Tracker`
3. Permissions tab: enable **files.content.read** and **files.content.write**
4. Settings tab: **Generate access token**
5. Paste the token into the app's Settings → Dropbox sync → Save & test

### AI coach

In Settings → AI provider, either:

- **Anthropic (Claude)** — API key from [console.anthropic.com](https://console.anthropic.com), or
- **OpenAI-compatible** — any provider with a `/chat/completions` endpoint (NanoGPT, OpenRouter, etc.): enter base URL, model, and key

In Settings → Coaching, optionally enter your age, bodyweight, and injuries/limitations — the coach factors these into every analysis.

## Development

```sh
npm install
npm run dev      # dev server
npm run build    # production build to dist/
```

Stack: Vite + Preact + TypeScript, vite-plugin-pwa (Workbox service worker). Deploys to GitHub Pages via `.github/workflows/deploy.yml` on push to `main`.

### Cloudflare Pages (mirror + backup)

The app also builds for Cloudflare Pages. `vite.config.ts` picks `base: '/'` when Cloudflare's own `CF_PAGES` build env var is set, and `base: '/workout-tracker/'` otherwise, so the same repo serves both GitHub Pages (subpath) and Cloudflare Pages (custom domain root) without a separate build script.

One-time setup (do this in the Cloudflare dashboard — no repo changes needed):

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**, authorize GitHub, pick the `workout-tracker` repo.
2. Build settings: **Framework preset** `None`, **Build command** `npm run build`, **Build output directory** `dist`. Leave everything else default — no environment variables needed, Cloudflare sets `CF_PAGES` itself.
3. After the first deploy, open the Pages project → **Custom domains** → **Set up a custom domain** → enter `workout.tucker-swett.com`. Since `tucker-swett.com` is already on this Cloudflare account, DNS is created automatically.
4. Every push to `main` now deploys to both GitHub Pages and Cloudflare Pages independently — no conflict, they're separate pipelines.
5. Browser storage is per-origin: open the new hostname once and re-enter the Dropbox token in Settings → Dropbox sync (or just sync) to pull your existing data down from Dropbox.

This uses Cloudflare's Git-connect build, not a GitHub Actions job, so no Cloudflare API token or GitHub secret is required.

## Data format

Each workout is one JSON line in `workouts.jsonl`:

```json
{"id":"…","date":"2026-09-15","name":"Push Day A","startedAt":…,"endedAt":…,"exercises":[{"name":"Bench Press","sets":[{"weight":185,"reps":8}]}],"updatedAt":…}
```

## Privacy

- The app is static HTML/JS; there is no backend
- Dropbox and AI API keys are stored only on your device
- AI reviews send your workout log to the AI provider you configured — nothing else
