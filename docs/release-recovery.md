# Getting back to a working app

How to install a candidate build, and how to get off it again. This is the
release-side counterpart to `docs/sync-weight-units.md`, which covers recovering
the *data*; this file covers recovering the *install*.

## Why rollback needs planning at all

`scripts/app-version.mjs` derives `versionCode` from the commit's committer date
(seconds since 2020-01-01). That gives two properties worth keeping: the same
commit always builds the same number, and the number rises with commit order, so
Android always sees a newer commit as an upgrade.

It also has one consequence that is easy to miss. Android refuses an install
whose `versionCode` does not increase. Because the number rises with commit
*date*, every older build has a lower number than every newer one — so an older
build can never be reinstalled over a newer one. Rolling back is not a matter of
re-downloading the previous release.

The two ways past that are:

- **Uninstall first, then reinstall `v0.3.0`.** This works, and it **deletes all
  on-device app data**. Do not do this without an export in hand.
- **Install a build of v0.3.0's code that carries a higher `versionCode`.** This
  keeps app data. It is what the recovery builds below are for.

### A recovery build only outranks candidates older than itself

This is the part that bites. A recovery build is a *new commit* of v0.3.0's
tree, so its `versionCode` is fixed the moment it is created. Any candidate
committed **after** it outranks it, and it stops being a recovery path. That has
already happened twice:

| Build | Commit | versionName | versionCode | Status |
| --- | --- | --- | --- | --- |
| Shipped stable (release `v0.3.0` asset) | `ef8be3e` | `0.3.0` | 213457601 | current stable |
| TOM-39 candidate #1 | `9767550` | `2026.10.06.9767550` | 213469181 | **failed QA — do not promote** |
| Recovery build for candidate #1 | `9e16fb3` | `2026.10.06.9e16fb3` | 213472506 | **superseded** — lower than candidate #2 |
| TOM-39 candidate #2 (corrected) | `f836d1e` | `2026.10.06.f836d1e` | 213493055 | **superseded** — conditional pass with a landscape regression |
| Recovery build for candidate #2 | `8ea4b75` | `2026.10.06.8ea4b75` | 213493432 | **superseded** — lower than candidate #3 |
| TOM-39 candidate #3 (+ TOM-62) | `c602979` | `2026.10.07.c602979` | 213494693 | **current candidate — QA passed (TOM-66)** |
| Recovery build for candidate #3 | `53ef15c` | `2026.10.07.53ef15c` | 213529619 | **current recovery path** |

Re-running the workflow on the old recovery commit cannot fix this: the same
commit always mints the same number. It takes a new commit. So:

> **Every new candidate needs its own recovery build, minted after it.** Compare
> the two `versionCode`s before handing a pair to the board.

## The current recovery build

Branch `release/tom67-recovery-v030`, commit `53ef15c`, `versionCode` 213529619.
Built by run
[37602996629](https://github.com/TimetoSwett/workout-tracker/actions/runs/37602996629);
artifact `workout-tracker-2026.10.07.53ef15c-213529619-release`.

Its tree is byte-identical to the `v0.3.0` tag — `git diff v0.3.0 53ef15c` is
empty — so it behaves exactly like the shipped stable build. The only difference
is the committer date, which is all `app-version.mjs` needs to mint a higher
`versionCode`. The normal `android-apk.yml` workflow builds it, so it is signed
with the same release key and installs straight over the candidate without
touching app data.

That it really is the same app is checkable on the artifacts themselves and not
only in the commit. Of the 426 entries in the APK outside `assets/public/` and
`META-INF/` — `classes.dex`, the native libraries, `resources.arsc`, every
resource — 425 are byte-identical to the shipped `v0.3.0` release asset. The
only one that differs is `AndroidManifest.xml`, which is where `versionCode` and
`versionName` live. The web payload differs only in the version string that is
compiled into the bundle, the content-hash filenames that follow from it, and one
minifier identifier rename inside the Workbox loader shim in `sw.js`.

It reports `2026.10.07.53ef15c` in Settings → About, not `0.3.0`, because the
version string names the commit that was built and this is not the tag. Same
code, different label. See "Two labels for one commit" below.

To mint a *new* recovery build for a later candidate — which is what a later
candidate needs, not a rebuild of this one:

```sh
git switch --detach v0.3.0
git switch -c release/<ticket>-recovery-v030
git commit --allow-empty -m 'Re-mint v0.3.0 above <candidate sha>'
git push -u origin HEAD
gh workflow run android-apk.yml --ref release/<ticket>-recovery-v030
```

## Checking an APK before it reaches the phone

Two things have to be true of any artifact handed to the board, and both are
checkable from the downloaded file with no Android SDK and no JDK:

```sh
node scripts/apk-identity.mjs path/to/*.apk
```

- **`versionCode` must increase** over whatever is installed, or Android refuses
  the install outright.
- **The signer certificate must match.** Every release-signed build of this app
  carries signer certificate SHA-256
  `f7f50190a75994c01e862037251a5fa5b6ec5ac63727ce5f6661304c7e64f94a`. A
  different digest means a different key, and a different key cannot update the
  installed app at all — it forces an uninstall, which deletes the data. If an
  artifact reports anything else, stop: it is a debug-signed build, or the
  signing secrets were missing from the run that produced it.

The script reports the same numbers as `apksigner verify --print-certs` and
`aapt2 dump badging`, which is what `android-apk.yml` already asserts in CI. The
point of having it in the repo is that the check can also be run where the file
is downloaded, so a claim about an artifact never has to rest only on a CI log.

## Installing either build

Both candidates and recovery builds are **workflow artifacts, not GitHub
releases**. That matters for two reasons:

- The in-app updater only reads the *latest GitHub release*
  (`src/version.ts`). It cannot offer a candidate, and it cannot offer a
  recovery build. Both have to be sideloaded.
- After a candidate is installed, the latest release is still `v0.3.0` with the
  lower `versionCode`, so `isUpgrade()` returns false and the app correctly
  reports it is already current rather than walking into an installer that would
  refuse. The updater does not need a fix for this; it is the intended behavior.

Artifacts are zipped by `actions/upload-artifact`, so the download is a `.zip`
containing the `.apk`.

### Going back, step by step

1. Export your data from the app first. Always — even though this path is
   designed to keep it.
2. Download the recovery artifact from its workflow run and unzip it.
3. Open the `.apk`. Android installs it as an update, with no uninstall prompt.
   If you see "app not installed", or anything offering to uninstall first,
   **stop**: the `versionCode` or the signing key is wrong, and continuing loses
   the data.
4. Open the app and check Settings → About reports the recovery build's
   `versionName` from the table above.
5. Confirm the workouts are still there.

Step 3's failure mode is the one that cannot be undone afterwards, which is why
`scripts/apk-identity.mjs` exists: run it on the file before step 3 and that
failure is ruled out on the host, not discovered on the phone.

## Two labels for one commit

The same commit can show two different version strings, which is worth knowing
before comparing what the phone says against what the web says:

- Built from a `v*` tag, `versionName` is the tag without its `v` — `0.3.0`.
- Built from a branch, it is `<commit date>.<short sha>` — `2026.10.06.ef8be3e`.

So commit `ef8be3e` is `0.3.0` in Android's app info (that APK came from the tag
build) and `2026.10.06.ef8be3e` on the web (that bundle came from the `main`
build). Both carry `versionCode` 213457601. They are the same code.

`package.json`'s `"version": "1.0.0"` is npm package metadata and is read by
nothing in the version pipeline — not `app-version.mjs`, not `vite.config.ts`,
not Gradle. It is not and has never been the shipped app label. The roadmap's
"v0.3.1" is likewise a planning name; no `v0.3.1` tag exists, and until the board
creates one, builds off this branch label themselves by commit.

## Web recovery

The web targets do not have the `versionCode` problem — there is no installer to
refuse a downgrade — but they do cache.

- **Production** is two surfaces, both published automatically from `main`, and
  neither is moved by a branch. `workout.tucker-swett.com` is a custom domain
  bound to the `workout-tracker` Worker, published by that Worker's Workers
  Builds **production trigger**, which runs `npm run build` then
  `npx wrangler deploy` on every push to `main`. `wrangler deploy` both uploads
  a version and shifts 100% of traffic to it, which is what makes the push
  reach the live domain. **GitHub Pages**
  (`timetoswett.github.io/workout-tracker/`) is published by
  `.github/workflows/deploy.yml`, also on pushes to `main`. So a merge to `main`
  moves both surfaces with no human step, and "recovery" for both is the same:
  do not merge a candidate tree, and do not deploy a version built from one.

  Two traps here, both of which this project has actually fallen into:

  - The Worker's deploy command is a *dashboard* setting, not a file in the
    repo, so nothing in a diff tells you it changed. Between 2026-10-08 20:21
    and 2026-10-09 11:42 it was `npx wrangler versions upload`, which uploads a
    version **without** shifting traffic. For those 15 hours a push to `main`
    would have built, succeeded, reported a green check run, and silently not
    reached `workout.tucker-swett.com`. It was restored to `npx wrangler deploy`
    on 2026-10-09 (TOM-87). If production ever looks stale while builds look
    green, read the trigger before anything else:
    `GET /accounts/:id/builds/workers/<script_tag>/triggers` — see the
    `script_tag` warning below, because the same call with the Worker's *name*
    will tell you there are no triggers at all.
  - A version uploaded but not deployed still exists and is still promotable.
    `npx wrangler versions deploy` shifts traffic to one; that is the manual
    recovery if a `versions upload` build is the newest thing on the Worker.

  As of 2026-10-09 both surfaces serve `2026.10.08.ebd44da` — `main`'s head, the
  merge of PR #29. They report different bundle filenames
  (`assets/index-C-FBFX_J.js` on the custom domain,
  `assets/index-DGjX66H1.js` on Pages) because Pages builds under a different
  base path. **Compare the self-reported version, not the bundle filename, when
  checking whether the two surfaces agree** — the filenames differ by design and
  will look like divergence if you read them as identity.
- **Branch previews are published automatically, by Workers Builds.** Verified
  end to end on 2026-10-08 (TOM-87) by pushing a new branch and watching it:
  the Worker has a GitHub App repository connection to
  `TimetoSwett/workout-tracker` (connected 2026-09-28), `previews_enabled` is
  true, and Cloudflare creates a per-branch preview with `auto_build: true` for
  every branch it sees — a brand-new branch's build started **6 seconds** after
  the push and finished in ~40s. Each preview build runs `npm run build` then
  `npx wrangler preview`, and the resulting hostname serves that exact commit.
  No human step, no stored secret, no workflow.

  The proof branch is `ci/tom87-preview-proof` (commit `896c487`). Its preview,
  `https://ci-tom87-preview-proof-workout-tracker.tuckerswett.workers.dev`,
  self-reports `2026.10.08.896c487` and serves `/tom87-preview-proof.txt`, a
  marker file that exists only on that commit. Re-run that check any time the
  channel is in doubt: push a branch carrying a unique marker, then assert both
  the marker and the self-reported version.

  So the `preview/<short-sha>` branch recipe this file originally recommended
  **does** work, and for the reason it claimed: the preview alias is the branch
  name slugified, so pushing `<sha>:refs/heads/preview/<short-sha>` yields
  `preview-<short-sha>-workout-tracker.tuckerswett.workers.dev`, and because
  nothing ever pushes to that branch again the alias never moves. That is where
  the existing `preview-c602979` and `preview-f836d1e` aliases came from, and
  `preview-326b92e` was published the same way on 2026-10-09 for TOM-93 — the
  push auto-created the trigger and the build finished in about 30s, with no
  credential held by the agent that pushed it. All three are visible as
  Previews named `preview/<short-sha>` in
  `GET /accounts/:id/workers/workers/<script_tag>/previews`, which is the
  cheapest way to confirm an alias exists without guessing at its hostname.

  A revision of this section dated 2026-10-08 (TOM-87's first pass) claimed the
  opposite — that nothing published previews and every URL here was hand-made.
  That was wrong, and the way it went wrong is worth recording, because the
  check looks authoritative and is not. It queried
  `GET /accounts/:id/builds/workers/workout-tracker/builds` and got `[]`.
  **That endpoint keys on the Worker's `script_tag`, not its name**, so passing
  a script name returns an empty list whether or not builds exist. The same
  false negative is available from `/builds/workers/<name>/triggers`. Use the
  tag (`05c689ac575544b0bdb927be01e80498` for this Worker); with the tag the
  same endpoints returned 15 production builds and 41 branch previews on
  2026-10-08, and 46 previews on 2026-10-09. Those counts only ever grow, so
  read them as "not empty", not as a fixture to assert against.

  To find a branch's preview without the dashboard:

  ```sh
  # The branch-alias hostname is the branch name slugified: / and . -> -
  #   ci/tom87-preview-proof -> ci-tom87-preview-proof
  curl -sI https://<branch-slug>-workout-tracker.tuckerswett.workers.dev
  ```

  The Workers Builds GitHub **check run** on the commit confirms the build
  passed and links the dashboard build page, but it does **not** carry either
  URL — so the alias is derivable from the branch name, while the pinned URL has
  to be read out of the build log.
- A candidate is reachable only through its own Cloudflare preview, on a hostname
  separate from production. A preview comes in two forms, and a branch build
  prints both:

  - `https://<version-prefix>-workout-tracker.tuckerswett.workers.dev` is the
    **Unique Deployment URL**: pinned to one version, never moves. This is the
    form to quote in a QA handoff. It appears only in the build log's
    `Unique Deployment URL:` line (or `npx wrangler versions upload`'s output
    for a hand upload) — the prefix is not derivable from the branch or the sha.
  - `https://<branch-slug>-workout-tracker.tuckerswett.workers.dev` is the
    **Preview URL**: a named alias. A branch build re-points it on every push,
    so it names a commit only until the next push to that branch. Convenient to
    guess, unsafe to pin a handoff to.

  Neither form can reach production: the custom domain has previews disabled,
  and neither `wrangler preview` nor `versions upload` changes the live
  deployment.

  **A preview does not do SPA fallback, and production does.** Measured
  2026-10-09 (TOM-94): `workout.tucker-swett.com/settings` returns 200 and
  `index.html`, while the same path on both preview forms of `326b92e` —
  the alias `preview-326b92e-…` and its Unique Deployment URL
  `74f85397-…` — returns 404. Same for `/a/b/c` and `/nope.html`; only `/`
  works. `preview-c602979`, which QA already passed, behaves the same way, so
  this is not new and not specific to one build.

  It is **not** an inheritance failure, which is the obvious guess and is
  wrong. The preview deployment really does carry the setting: `GET
  /accounts/:id/workers/workers/<script_tag>/previews/<id>/deployments/<id>`
  reports `assets.config.not_found_handling: "single-page-application"`. The
  setting is inherited and inert. What differs is who answers a miss:

  - Production has **no Worker script** (`has_modules: false`, and the version's
    `script_runtime.assets` shows `serve_directly: true`). With no entrypoint,
    the asset router itself handles a miss, so `not_found_handling` applies and
    `index.html` comes back.
  - A preview has one. The Previews API requires a script, and this repo's
    Worker is assets-only, so `wrangler preview` supplies Wrangler's stub —
    the preview deployment reports `main_module: "no-op-worker.js"` with
    `run_worker_first: false`. Assets that exist are still served, but a miss
    falls through to that stub instead of to the asset router, and
    `node_modules/wrangler/templates/no-op-worker.js` answers every request
    with a 404. That is the response on the wire exactly: status 404,
    `content-type: text/html`, 9 bytes, body `Not found`.

  So it cannot be fixed from `previews`. That block takes bindings and runtime
  settings only — no asset config. Wrangler 4.145.0 rejects both spellings at
  config-validation time, which `wrangler deploy --dry-run` will show you
  without deploying anything:

  ```
  - Unexpected fields found in previews field: "not_found_handling"
  - Unexpected fields found in previews field: "assets"
  ```

  Treat it as a Cloudflare-side limitation of `wrangler preview` on an
  assets-only Worker. Closing it would mean giving the Worker a real `main` that
  serves the fallback itself — a production architecture change, and Lord Soth's
  call, not a preview tweak. It is worth doing only if it stops costing nothing:
  today the app is a tab-state SPA with no URL routes, nothing ever links to a
  non-root path, and QA enters every preview at `/`, which is why this never
  surfaced. If a real route is ever added, this stops being cosmetic and a
  preview will diverge from production on exactly the paths under test.
  Re-measure after any Wrangler bump (4.149.0 was current on 2026-10-09) before
  assuming it still holds.

  To mint a commit-named alias that is immovable by construction, push the
  commit to a branch named after it and never push to that branch again:

  ```sh
  git push origin <sha>:refs/heads/preview/<short-sha>
  ```

  For a tree that is not going to a branch at all, a hand upload from an
  authenticated machine gives the same shape:

  ```sh
  npm run build
  npx wrangler versions upload --preview-alias preview-<short-sha>
  ```

  Prefer the branch push. It needs no credential at all, which matters because
  the credential question here is easy to get wrong in the direction of
  "no agent can do this" (TOM-94):

  - There is no Cloudflare credential in the environment.
    `GET /api/agents/me/secrets` is empty and `cf auth whoami` reports not
    logged in, so `wrangler` subcommands that need auth — `versions upload`,
    `versions deploy`, `preview` — will not run from an agent host.
  - But the Cloudflare **API** is reachable from an agent run, through the
    assigned Cloudflare MCP server, which carries its own authorized session
    for account `670bd9fa…`. Everything in this section that reads build
    triggers, builds, previews, versions, or preview deployments was measured
    that way. So "`cf` is not logged in" is not the same claim as "no agent can
    see Cloudflare", and it is never grounds to escalate a read to the board.

  The current candidate's alias is
  `https://preview-c602979-workout-tracker.tuckerswett.workers.dev`, serving
  bundle `assets/index-yeZO2pgu.js` and reporting `2026.10.07.c602979` /
  213494693 — the same bundle filename the `c602979` APK carries, so the web and
  Android artifacts under QA are the same code. The previous candidate's alias,
  `https://preview-f836d1e-workout-tracker.tuckerswett.workers.dev`
  (`assets/index-GLnAdP6P.js`, `2026.10.06.f836d1e`), still stands and still
  serves `f836d1e`, so the two candidates stay distinguishable by URL.

  A QA harness should still read the running build's own version out of
  Settings → About and refuse to continue unless it is the expected commit (see
  `tests/tom61-preview-verify.qa.mjs`). A URL is a convenience; the self-reported
  version is the attribution.
- The v0.3.0 code is on the web too, at the alias its recovery branch's own
  preview build published —
  `https://release-tom67-recovery-v030-workout-tracker.tuckerswett.workers.dev`
  (bundle `assets/index-CZRxuw5w.js`, reporting `2026.10.07.53ef15c`). That is
  the web counterpart of the recovery APK — same bundle filename the recovery
  APK carries: known-good behaviour on a preview origin, without touching
  production.
- If a candidate has been opened in a browser, that origin holds a service worker
  and a cache. To return that browser to stable, clear site data for the preview
  origin (or use the app's own reload path) rather than assuming a refresh is
  enough. Production is a different origin and is unaffected either way.

  TOM-63 proved the old-worker-to-candidate transition — install an older
  bundle, update through the app's own UI, land on the candidate's assets with no
  stale worker left waiting and synthetic state retained — against commit
  `9767550`. That proof carries forward to `c602979` without a retest, and the
  reason is checkable rather than assumed: every file in the update and
  service-worker pipeline is byte-identical between the two commits.
  `git diff --name-only 9767550 c602979 -- src/webUpdate.ts src/main.tsx
  src/version.ts vite.config.ts public/ capacitor.config.ts android/ scripts/`
  is empty, so the three candidates differ only in view code and CSS. If a later
  candidate touches any of those paths, the proof lapses and TOM-63 has to be
  re-run.

Local data lives in that origin's storage, so a preview origin and production do
not share workout data. Export before relying on either.

## Candidate dispositions

Keep this current. It is the list that stops a failed build being promoted by
mistake.

- `9767550` — TOM-39 candidate #1. **Failed QA (TOM-59). Do not promote, tag or
  merge.** Superseded by `f836d1e`. Its artifact
  (`workout-tracker-2026.10.06.9767550-213469181-release`) and its recovery build
  `9e16fb3` are retained for the record only.
- `f836d1e` — TOM-39 candidate #2, the correction. **Superseded by `c602979`. Do
  not promote, tag or merge.** TOM-64 returned a *conditional* pass with a
  landscape regression, which is not a promotion. Its artifact
  (`workout-tracker-2026.10.06.f836d1e-213493055-release`), its pinned preview and
  its recovery build `8ea4b75` are retained for the record only. The board may
  already have this build installed; `53ef15c` is the way back off it.
- `c602979` — TOM-39 candidate #3, carrying the TOM-62 focus-reveal and `.compact`
  work plus three fixes from the TOM-64 verdict. **Independent QA passed (TOM-66,
  merge recommendation go)** — a clean pass, not a conditional one. Still not
  promoted: promotion needs real-data backup/recovery evidence and the board's
  hands-on acceptance (TOM-42). See "Handing `c602979` to the board" below.

Nothing here has been merged to `main` or tagged. Tagging is the board's call.

## Handing `c602979` to the board

Everything that could be checked without the phone has been. What is left is the
part that needs a physical soft keyboard, and it is two taps' worth of work.

**The pair of artifacts.** Install the candidate, keep the recovery build to
hand. Both are release-signed with the same key, so either installs over the
other with no uninstall and no data loss — but only in this direction, because
213529619 > 213494693.

| | Candidate | Way back off it |
| --- | --- | --- |
| Commit | `c602979` | `53ef15c` (v0.3.0's tree) |
| Settings → About reads | `2026.10.07.c602979` | `2026.10.07.53ef15c` |
| APK artifact | `workout-tracker-2026.10.07.c602979-213494693-release` | `workout-tracker-2026.10.07.53ef15c-213529619-release` |
| From run | [37550056265](https://github.com/TimetoSwett/workout-tracker/actions/runs/37550056265) | [37602996629](https://github.com/TimetoSwett/workout-tracker/actions/runs/37602996629) |
| `versionCode` | 213494693 | 213529619 |
| APK SHA-256 | `e3511ba660773c9fee5b0ed4d6e5e33b307d9b10147e76f715fac50103df379e` | `79e68c14913b2346572c1611d379b27f9f70c4d7128bbcdddb0670aff918b75f` |
| Bundled web asset | `assets/index-yeZO2pgu.js` | `assets/index-CZRxuw5w.js` |
| Web preview | `https://preview-c602979-workout-tracker.tuckerswett.workers.dev` | `https://release-tom67-recovery-v030-workout-tracker.tuckerswett.workers.dev` |

Each APK's bundle filename is the same one its preview URL serves, so the web
build QA ran against and the Android build the board installs are the same code.

Run `node scripts/apk-identity.mjs` on the downloaded file before installing
either one; that is what rules out the one failure mode that costs data.

### The acceptance checks that need the phone

This is the entire device-side residue of TOM-66. The risk behind both steps is
the same one a desktop browser cannot reproduce: a physical soft keyboard may
*pan* the WebView instead of resizing the visual viewport, and in that case
`revealFocusedField()` never fires at all.

1. Start any workout, rotate to **landscape**, tap a weight field low in the
   list. *Expect:* the field you tapped stays visible above the keyboard; the
   rest timer stays a thin strip at the top; nothing jumps when rest starts or
   ends.
2. Still in landscape with the keyboard up, tap **Skip**. *Expect:* the strip
   stays put and goes grey; the set rows do not move.

### Known limitation shipping with this candidate

- **TOM-69 — no selected-tab indicator in the compact log layout.** When the
  logging view is in `.compact` (short viewport, keyboard up in landscape), the
  tab buttons drop to `font-size: 0` and the only remaining active marker is
  `color`, which emoji glyphs ignore. The result is a tab bar with nothing
  showing which tab is selected. Low severity, not a blocker, and known before
  the board sees it. If Lord Soth lands the fix before promotion, it rides along
  on a new candidate SHA — and that candidate then needs its own recovery build
  minted after it, per the rule above.

## Before using real data

`docs/sync-weight-units.md` owns this and should be read in full. The short
version: export the affected local and Dropbox data, prove the exported copy
restores, and only then let a candidate touch the board's real folder. Keep
exports out of evidence posted to issues or PRs — they are private data.
