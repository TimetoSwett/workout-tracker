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

Concretely, for the TOM-39 logging-comfort candidate:

| Build | Commit | versionName | versionCode |
| --- | --- | --- | --- |
| Shipped stable (release `v0.3.0` asset) | `ef8be3e` | `0.3.0` | 213457601 |
| TOM-39 candidate | `9767550` | `2026.10.06.9767550` | 213469181 |
| Recovery build (this plan) | `9e16fb3b` | `2026.10.06.9e16fb3` | 213472506 |

Once the candidate (213469181) is installed, the `v0.3.0` release asset
(213457601) will not install over it. The installer reports a downgrade and
stops. The two ways past that are:

- **Uninstall first, then reinstall `v0.3.0`.** This works, and it **deletes all
  on-device app data**. Do not do this without an export in hand.
- **Install a build of v0.3.0's code that carries a higher `versionCode`.** This
  keeps app data. It is what the recovery build below is for.

## The recovery build

Branch `release/tom60-recovery-v030`, commit `9e16fb3b`.

Its tree is byte-identical to the `v0.3.0` tag — `git diff v0.3.0 9e16fb3b` is
empty — so it behaves exactly like the shipped stable build. The only difference
is the committer date, which is all `app-version.mjs` needs to mint a higher
`versionCode` (213472506 > 213469181). The normal `android-apk.yml` workflow
builds it, so it is signed with the same release key and installs straight over
the candidate without touching app data.

It reports `2026.10.06.9e16fb3` in Settings → About, not `0.3.0`, because the
version string names the commit that was built and this is not the tag. Same
code, different label. See "Two labels for one commit" below.

To rebuild it: `gh workflow run android-apk.yml --ref release/tom60-recovery-v030`.

## Installing either build

Both the candidate and the recovery build are **workflow artifacts, not GitHub
releases**. That matters for two reasons:

- The in-app updater only reads the *latest GitHub release*
  (`src/version.ts`). It cannot offer the candidate, and it cannot offer the
  recovery build. Both have to be sideloaded.
- After the candidate is installed, the latest release is still `v0.3.0` with the
  lower `versionCode`, so `isUpgrade()` returns false and the app correctly
  reports it is already current rather than walking into an installer that would
  refuse. The updater does not need a fix for this; it is the intended behavior.

Artifacts are zipped by `actions/upload-artifact`, so the download is a `.zip`
containing the `.apk`.

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
- A candidate is reachable only through its own Cloudflare branch preview, on a
  hostname separate from production.
- If a candidate has been opened in a browser, that origin holds a service worker
  and a cache. To return that browser to stable, clear site data for the preview
  origin (or use the app's own reload path) rather than assuming a refresh is
  enough. Production is a different origin and is unaffected either way.

Local data lives in that origin's storage, so a preview origin and production do
not share workout data. Export before relying on either.

## Before using real data

`docs/sync-weight-units.md` owns this and should be read in full. The short
version: export the affected local and Dropbox data, prove the exported copy
restores, and only then let a candidate touch the board's real folder. Keep
exports out of evidence posted to issues or PRs — they are private data.
