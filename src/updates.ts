import { APP_VERSION, compareSemver, parseSemver } from './version'

/** Unauthenticated releases endpoint. 60 requests/hour per IP is plenty for a
 *  launch check that is throttled to once every few hours. */
const LATEST_RELEASE_URL = 'https://api.github.com/repos/TimetoSwett/workout-tracker/releases/latest'

const CHECK_TIMEOUT_MS = 8000

/** A release-signed APK is the only asset we can offer one-tap install for: a
 *  debug-signed APK is signed with a throwaway key and Android refuses to
 *  install it over the release-signed app (see android/KEYSTORE.md). The
 *  workflow suffixes the artifact name with the signing mode. */
const RELEASE_SIGNED_APK = /-release\.apk$/i

export interface ReleaseApk {
  url: string
  name: string
  sizeBytes: number
}

/** Every outcome of a check, including the failures. The UI renders each of
 *  these as a quiet line of text — nothing here ever becomes a dialog. */
export type UpdateCheck =
  | {
      kind: 'update-available'
      version: string
      releaseUrl: string
      notes: string
      /** Null when the release has no release-signed APK attached, which means
       *  we must not offer one-tap install — see RELEASE_SIGNED_APK. */
      apk: ReleaseApk | null
    }
  | { kind: 'current'; version: string }
  /** The repo has no published releases yet. This is the state on the day this
   *  ships, so it has to be completely silent. */
  | { kind: 'no-releases' }
  | { kind: 'rate-limited' }
  | { kind: 'offline' }
  /** Anything else: a 5xx, a malformed body, a release tag that isn't semver.
   *  Deliberately lumped together because the board cannot act on the
   *  difference. `detail` is for the console, not the UI. */
  | { kind: 'unknown'; detail: string }

interface GitHubAsset {
  name?: unknown
  size?: unknown
  browser_download_url?: unknown
}

interface GitHubRelease {
  tag_name?: unknown
  html_url?: unknown
  body?: unknown
  draft?: unknown
  prerelease?: unknown
  assets?: unknown
}

function pickApk(assets: unknown): ReleaseApk | null {
  if (!Array.isArray(assets)) return null
  for (const raw of assets as GitHubAsset[]) {
    const name = typeof raw?.name === 'string' ? raw.name : null
    const url = typeof raw?.browser_download_url === 'string' ? raw.browser_download_url : null
    if (!name || !url || !RELEASE_SIGNED_APK.test(name)) continue
    return { url, name, sizeBytes: typeof raw.size === 'number' ? raw.size : 0 }
  }
  return null
}

/** Queries the latest GitHub release and compares it to the running version.
 *  Never throws and never rejects: every failure mode is a returned `kind`. */
export async function checkForUpdate(): Promise<UpdateCheck> {
  const running = parseSemver(APP_VERSION)
  if (!running) {
    return { kind: 'unknown', detail: `running version '${APP_VERSION}' is not semver` }
  }

  let res: Response
  try {
    res = await fetch(LATEST_RELEASE_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
  } catch {
    // fetch only rejects on network failure or the abort above — both mean
    // "couldn't reach GitHub", which is the offline story either way.
    return { kind: 'offline' }
  }

  // 404 is what the endpoint returns when the repo has never had a release.
  if (res.status === 404) return { kind: 'no-releases' }

  // GitHub signals throttling as 403 (primary limit) or 429 (secondary), both
  // with x-ratelimit-remaining: 0. A 403 with budget left is something else.
  if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
    return { kind: 'rate-limited' }
  }

  if (!res.ok) return { kind: 'unknown', detail: `HTTP ${res.status}` }

  let release: GitHubRelease
  try {
    release = (await res.json()) as GitHubRelease
  } catch {
    return { kind: 'unknown', detail: 'response body was not JSON' }
  }

  const tag = typeof release.tag_name === 'string' ? release.tag_name : null
  if (!tag) return { kind: 'unknown', detail: 'release had no tag_name' }

  // /releases/latest already excludes drafts and prereleases, but the field is
  // cheap to honour in case this ever reads /releases instead.
  if (release.draft === true || release.prerelease === true) return { kind: 'no-releases' }

  const latest = parseSemver(tag)
  if (!latest) return { kind: 'unknown', detail: `release tag '${tag}' is not semver` }

  const version = `${latest.major}.${latest.minor}.${latest.patch}`
  // Treat "installed is newer than the latest release" as current, not as a
  // downgrade offer: that is what a board running a main-branch build sees.
  if (compareSemver(latest, running) <= 0) return { kind: 'current', version: APP_VERSION }

  return {
    kind: 'update-available',
    version,
    releaseUrl:
      typeof release.html_url === 'string'
        ? release.html_url
        : `https://github.com/TimetoSwett/workout-tracker/releases/tag/${tag}`,
    notes: typeof release.body === 'string' ? release.body : '',
    apk: pickApk(release.assets),
  }
}

/* ------------------------------------------------------------------ *
 * Throttling and dismissal
 *
 * Kept in localStorage rather than the settings store so an update-check
 * bookkeeping value never rides along in a Dropbox sync payload.
 * ------------------------------------------------------------------ */

const LAST_CHECK_KEY = 'wt.update.lastCheckAt'
const DISMISSED_KEY = 'wt.update.dismissedVersion'
const LAUNCH_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

function readNumber(key: string): number {
  const n = Number(localStorage.getItem(key))
  return Number.isFinite(n) ? n : 0
}

/** The launch check: skipped entirely if one ran recently, so opening the app
 *  ten times in an afternoon makes one request, not ten. */
export async function checkForUpdateOnLaunch(): Promise<UpdateCheck | null> {
  if (Date.now() - readNumber(LAST_CHECK_KEY) < LAUNCH_CHECK_INTERVAL_MS) return null
  const result = await checkForUpdate()
  // Only a conclusive answer counts as "checked" — being offline at launch
  // must not suppress the next six hours of checks.
  if (result.kind !== 'offline' && result.kind !== 'rate-limited') {
    localStorage.setItem(LAST_CHECK_KEY, String(Date.now()))
  }
  if (result.kind === 'update-available' && localStorage.getItem(DISMISSED_KEY) === result.version) {
    return null
  }
  return result
}

/** Hides the banner for one specific version. A later version shows again. */
export function dismissUpdate(version: string): void {
  localStorage.setItem(DISMISSED_KEY, version)
}
