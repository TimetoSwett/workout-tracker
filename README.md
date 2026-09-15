# Workout Tracker

A free, offline-first PWA for logging workouts. Data syncs to **your own Dropbox**, and an AI coach (Claude or any OpenAI-compatible API like NanoGPT) reviews your training history.

**Live app:** https://timetoswett.github.io/workout-tracker/

## Features

- **Log** — set-by-set weight/reps entry, exercise autocomplete, workout templates, rest timer with vibration, duration tracking
- **History** — weekly volume chart, best lifts (PRs), full workout details, CSV/JSON export
- **Insights** — AI analysis of your last 2–12 weeks: volume trends, muscle balance, progression, deload suggestions, plus follow-up chat
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

## Development

```sh
npm install
npm run dev      # dev server
npm run build    # production build to dist/
```

Stack: Vite + Preact + TypeScript, vite-plugin-pwa (Workbox service worker). Deploys to GitHub Pages via `.github/workflows/deploy.yml` on push to `main`.

## Data format

Each workout is one JSON line in `workouts.jsonl`:

```json
{"id":"…","date":"2026-09-15","name":"Push Day A","startedAt":…,"endedAt":…,"exercises":[{"name":"Bench Press","sets":[{"weight":185,"reps":8}]}],"updatedAt":…}
```

## Privacy

- The app is static HTML/JS; there is no backend
- Dropbox and AI API keys are stored only on your device
- AI reviews send your workout log to the AI provider you configured — nothing else
