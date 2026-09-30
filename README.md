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

**Option A — PWA (easiest, no APK):**

1. Open the live app URL in Chrome
2. Menu → **Add to Home screen** → Install
3. It launches fullscreen like a native app and works offline

**Option B — APK (native app wrapper, sideloaded):**

The app is also wrapped with [Capacitor](https://capacitorjs.com) into a real
Android app (`android/`). It's not on the Play Store, so you install it by
sideloading the built APK:

1. Download the APK from GitHub:
   - **Tagged versions:** the repo's **Releases** page. Each `v*` tag has
     `workout-tracker-<tag>-release.apk` attached.
   - **Latest `main` build:** **Actions → Build Android APK** → open the
     newest green run → **Artifacts** → download `workout-tracker-<sha>-…`.
     It arrives as a `.zip`, so unzip it to get the `.apk`.

   Get it onto your phone however is easiest: open the page in the phone's
   browser, or use Drive or a USB cable. Only use `-release` APKs for
   day-to-day installs. A `-debug-signed` APK won't update over a release
   install (see `android/KEYSTORE.md`).
2. On your phone: **Settings → Apps → Special access → Install unknown apps**
   (on some phones: **Settings → Security**) → pick the app you'll open the
   file with (e.g. Files, Chrome, or your email/Drive app) → enable **Allow
   from this source**.
3. Open the APK file on your phone (e.g. from the Files app or your
   downloads) and tap **Install**. Android will show a warning because it's
   not from the Play Store — that's expected for a sideloaded app; tap
   **Install anyway**.
4. Open **Workout Tracker** from your app drawer. It works fully offline,
   same as the PWA — your data still lives in your Dropbox, not on any app
   store account.

You only do the above **once**. After that the app updates itself — see below.

## Updating

The app checks for a newer release on its own, so you don't go looking.

- **On launch** (at most once every 6 hours) a quiet one-line banner appears at
  the top *only* if a newer release actually exists. Offline, rate-limited, and
  no-new-version all render nothing at all — no dialogs, ever.
- **On demand** in **Settings → About**, which also shows the version you are
  running right now, so "am I on the fix?" is answerable without guessing.

Tap **Update** and the app downloads the release APK and hands it to Android's
package installer. Android then shows its own confirmation screen — that one is
the OS's, not ours, and it is not skippable. The very first time, Android also
asks you to grant **install unknown apps** to Workout Tracker; the app sends you
straight to that settings screen, and it is a one-time grant.

On the web/PWA build there is no APK to install, so the same affordance says
**Reload for the new version** instead — the service worker has already fetched
the new build in the background.

### If the update mechanism itself breaks

It cannot leave you without a working app. The updater never modifies the
installed app — Android's package installer does, and it refuses anything that
isn't signature-compatible. A failed, truncated, or rejected download leaves the
currently installed app untouched and running.

So the manual path above is always still there: download
`workout-tracker-<tag>-release.apk` from the **Releases** page and install it by
hand, exactly as in steps 1–3. Because it is signed with the same release key it
installs over the broken version **and keeps your data** (see
`android/KEYSTORE.md`). Nothing about the in-app updater needs to be working for
that to succeed.

### Versioning

`version` in `package.json` is the single source of truth. It flows to:

- the web build, as `__APP_VERSION__` (see `vite.config.ts`)
- the APK's `versionName`, and a `versionCode` of
  `major*10000 + minor*100 + patch` (see `android/app/build.gradle`)
- the string shown in **Settings → About**

CI reads the version back out of the built APK with `aapt2 dump badging` and
fails the build on any drift, so the version the app displays is provably the
version of the artifact. `versionCode` must only ever increase — Android
silently refuses to install a build that doesn't — so the Gradle build fails if
`minor` or `patch` would reach 100 and break that arithmetic.

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

The app also builds for Cloudflare Pages. `vite.config.ts` picks `base: '/'` when Cloudflare's own build env var is set (`CF_PAGES` for Pages, `WORKERS_CI` for Workers Builds), and `base: '/workout-tracker/'` otherwise, so the same repo serves both GitHub Pages (subpath) and Cloudflare Pages (custom domain root) without a separate build script.

One-time setup (do this in the Cloudflare dashboard — no repo changes needed):

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**, authorize GitHub, pick the `workout-tracker` repo.
2. Build settings: **Framework preset** `None`, **Build command** `npm run build`, **Build output directory** `dist`. Leave everything else default — no environment variables needed, Cloudflare sets `CF_PAGES` (Pages) or `WORKERS_CI` (Workers) itself. If the site loads blank with `/workout-tracker/` asset paths, the build did not see either variable: add `CF_PAGES=1` as a build environment variable and redeploy.
3. After the first deploy, open the Pages project → **Custom domains** → **Set up a custom domain** → enter `workout.tucker-swett.com`. Since `tucker-swett.com` is already on this Cloudflare account, DNS is created automatically.
4. Every push to `main` now deploys to both GitHub Pages and Cloudflare Pages independently — no conflict, they're separate pipelines.
5. Browser storage is per-origin: open the new hostname once and re-enter the Dropbox token in Settings → Dropbox sync (or just sync) to pull your existing data down from Dropbox.

This uses Cloudflare's Git-connect build, not a GitHub Actions job, so no Cloudflare API token or GitHub secret is required.

### Building the Android APK

**On GitHub (no local toolchain needed):** `.github/workflows/android-apk.yml`
builds the APK on an x86 runner. It runs on every push to `main` that touches
app or `android/` code, on every `v*` tag, and on demand (**Actions → Build
Android APK → Run workflow**). The APK is uploaded as a run artifact, and on
`v*` tags it is also attached to a GitHub Release. The APK is signed with the
release key if the four `ANDROID_*` repo secrets are set (setup in
`android/KEYSTORE.md`). If they aren't, you get a `-debug-signed` APK, and the
run summary warns you.

To cut a release: `git tag v1.2.3 && git push origin v1.2.3`.

**Locally:**

Requires a JDK (17+) and the Android SDK (`platforms;android-34` or newer,
`build-tools`) installed locally, with `JAVA_HOME` and `ANDROID_HOME` (or
`ANDROID_SDK_ROOT`) set in your shell — Gradle needs both to build. The SDK
path is also cached in `android/local.properties` (gitignored, machine-local,
same pattern as every native Android project).

```sh
export JAVA_HOME=/path/to/jdk-17-or-newer
export ANDROID_HOME=/path/to/android-sdk

npm run build:android   # vite build in --mode capacitor (base '/', see vite.config.ts)
npm run cap:sync        # build:android, then `cap sync android` to copy web assets in
npm run android:apk     # cap:sync, then a signed release APK via Gradle
```

`npm run android:apk` is the one command from the issue: it produces
`android/app/build/outputs/apk/release/app-release.apk`, signed with the
release key described in `android/KEYSTORE.md` (gitignored — the keystore
and its passwords never enter this repo). If `android/keystore.properties`
is missing, the release build falls back to an **unsigned** APK instead of
failing, so a machine without the release key can still build and verify —
just not produce something installable. Add `-PdebugSignRelease` to the Gradle
command (`./gradlew assembleRelease -PdebugSignRelease`) to debug-sign it
instead, as CI does.

There's also `npm run android:install`, which does the above and then
`adb install -r` onto a device connected over USB/ADB — useful for testing
without moving the APK by hand.

The Vite `base` differs by target: `/workout-tracker/` for GitHub Pages
(default), `/` for Cloudflare Pages (`CF_PAGES=1`, set by Cloudflare) and for
the Android WebView (`--mode capacitor`, which `build:android` passes). The
Capacitor WebView serves assets from its own root, not a URL subpath, so it
needs `base: '/'` the same way Cloudflare does — see `vite.config.ts`.

## Data format

Each workout is one JSON line in `workouts.jsonl`:

```json
{"id":"…","date":"2026-09-15","name":"Push Day A","startedAt":…,"endedAt":…,"exercises":[{"name":"Bench Press","sets":[{"weight":185,"reps":8}]}],"updatedAt":…}
```

## Privacy

- The app is static HTML/JS; there is no backend
- Dropbox and AI API keys are stored only on your device
- AI reviews send your workout log to the AI provider you configured — nothing else
