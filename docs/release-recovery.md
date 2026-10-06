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
already happened once:

| Build | Commit | versionName | versionCode | Status |
| --- | --- | --- | --- | --- |
| Shipped stable (release `v0.3.0` asset) | `ef8be3e` | `0.3.0` | 213457601 | current stable |
| TOM-39 candidate #1 | `9767550` | `2026.10.06.9767550` | 213469181 | **failed QA — do not promote** |
| Recovery build for candidate #1 | `9e16fb3` | `2026.10.06.9e16fb3` | 213472506 | **superseded** — lower than candidate #2 |
| TOM-39 candidate #2 (corrected) | `f836d1e` | `2026.10.06.f836d1e` | 213493055 | candidate under QA |
| Recovery build for candidate #2 | `8ea4b75` | `2026.10.06.8ea4b75` | 213493432 | **current recovery path** |

Re-running the workflow on the old recovery commit cannot fix this: the same
commit always mints the same number. It takes a new commit. So:

> **Every new candidate needs its own recovery build, minted after it.** Compare
> the two `versionCode`s before handing a pair to the board.

## The current recovery build

Branch `release/tom65-recovery-v030`, commit `8ea4b75`, `versionCode` 213493432.

Its tree is byte-identical to the `v0.3.0` tag — `git diff v0.3.0 8ea4b75` is
empty — so it behaves exactly like the shipped stable build. The only difference
is the committer date, which is all `app-version.mjs` needs to mint a higher
`versionCode`. The normal `android-apk.yml` workflow builds it, so it is signed
with the same release key and installs straight over the candidate without
touching app data.

That it really is the same app is checkable on the artifacts themselves and not
only in the commit. Of the 426 entries in the APK outside `assets/public/` and
`META-INF/` — `classes.dex`, the native libraries, `resources.arsc`, every
resource — all 426 are byte-identical to the shipped `v0.3.0` release asset. The
only one that differs is `AndroidManifest.xml`, which is where `versionCode` and
`versionName` live. The web payload differs only in the version string that is
compiled into the bundle, the content-hash filenames that follow from it, and one
minifier identifier rename inside the Workbox loader shim in `sw.js`.

It reports `2026.10.06.8ea4b75` in Settings → About, not `0.3.0`, because the
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

- **Production** (`workout.tucker-swett.com`, Cloudflare) and **GitHub Pages**
  both deploy from `main` only. Neither can be moved by a branch build, so
  neither is at risk from a candidate, and "recovery" for them is just: do not
  merge. As of this writing production serves `2026.10.06.ef8be3e` /
  213457601 — the shipped stable commit.
- A candidate is reachable only through its own Cloudflare preview, on a hostname
  separate from production. Workers Builds publishes a preview per branch at
  `https://<branch-with-slashes-as-dashes>-workout-tracker.tuckerswett.workers.dev`,
  and that alias **follows the branch head**. Convenient, but a push during QA
  silently moves it, so a pass recorded against a feature branch's alias does not
  name a commit.

  Cloudflare also publishes a per-version URL
  (`https://<version-prefix>-workout-tracker…`) that never moves, but the prefix
  is only visible in the Cloudflare dashboard — the GitHub check run does not
  carry it, so it cannot be looked up from CI. The way to get an immovable
  preview without dashboard access is to push the candidate commit to a branch
  named after it, and then never update that branch:

  ```sh
  git push origin <full-sha>:refs/heads/preview/<short-sha>
  ```

  That alias is pinned by construction, because the branch has nowhere to move.
  For the corrected TOM-39 candidate it is
  `https://preview-f836d1e-workout-tracker.tuckerswett.workers.dev`, serving
  bundle `assets/index-GLnAdP6P.js` and reporting `2026.10.06.f836d1e` /
  213493055 — the same bundle filename the `f836d1e` APK carries, so the web and
  Android artifacts under QA are the same code.

  A QA harness should still read the running build's own version out of
  Settings → About and refuse to continue unless it is the expected commit (see
  `tests/tom61-preview-verify.qa.mjs`). A URL is a convenience; the self-reported
  version is the attribution.
- The v0.3.0 code is on the web too, at the recovery branch's own preview —
  `https://release-tom65-recovery-v030-workout-tracker.tuckerswett.workers.dev`
  (bundle `assets/index-BPdn-VCa.js`). That is the web counterpart of the
  recovery APK: known-good behaviour on a preview origin, without touching
  production.
- If a candidate has been opened in a browser, that origin holds a service worker
  and a cache. To return that browser to stable, clear site data for the preview
  origin (or use the app's own reload path) rather than assuming a refresh is
  enough. Production is a different origin and is unaffected either way.

Local data lives in that origin's storage, so a preview origin and production do
not share workout data. Export before relying on either.

## Candidate dispositions

Keep this current. It is the list that stops a failed build being promoted by
mistake.

- `9767550` — TOM-39 candidate #1. **Failed QA (TOM-59). Do not promote, tag or
  merge.** Superseded by `f836d1e`. Its artifact
  (`workout-tracker-2026.10.06.9767550-213469181-release`) and its recovery build
  `9e16fb3` are retained for the record only.
- `f836d1e` — TOM-39 candidate #2, the correction. Under independent QA (TOM-64).
  Not promoted: promotion needs the QA verdict and the board's hands-on
  acceptance.

Nothing here has been merged to `main` or tagged. Tagging is the board's call.

## Before using real data

`docs/sync-weight-units.md` owns this and should be read in full. The short
version: export the affected local and Dropbox data, prove the exported copy
restores, and only then let a candidate touch the board's real folder. Keep
exports out of evidence posted to issues or PRs — they are private data.
