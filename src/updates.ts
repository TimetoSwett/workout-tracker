import { APP_VERSION, APP_VERSION_CODE, isUpgrade, parseApkName } from './version'

/** Unauthenticated releases endpoint. 60 requests/hour per IP is plenty for a
 *  launch check that is throttled to once every few hours. */
const LATEST_RELEASE_URL = 'https://api.github.com/repos/TimetoSwett/workout-tracker/releases/latest'

const CHECK_TIMEOUT_MS = 8000

export interface ReleaseApk {
  url: string
  name: string
  sizeBytes: number
  /** The APK's own versionCode, read out of its asset name. This is what the
   *  "is it newer?" decision is made on -- see src/version.ts. */
  versionCode: number
  /** The APK's own versionName, which is what Settings will show after it is
   *  installed. Not necessarily the release tag: see below. */
  versionName: string
}

/** Every outcome of a check, including the failures. The UI renders each of
 *  these as a quiet line of text — nothing here ever becomes a dialog. */
export type UpdateCheck =
  | {
      kind: 'update-available'
      /** The versionName the app will report once this is installed. */
      version: string
      versionCode: number
      releaseUrl: string
      notes: string
      apk: ReleaseApk
    }
  /** The web build only. A newer set of assets has been downloaded by the
   *  service worker and is waiting for a reload. Deliberately distinct from
   *  `update-available`: it is not a GitHub release, there is nothing to
   *  install, and the only action is to reload. */
  | { kind: 'web-update-ready' }
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

/** The release-signed APK attached to a release, or null if it has none. A
 *  debug-signed asset is deliberately not a candidate: it carries a throwaway
 *  key, so Android refuses to install it over the release-signed app (see
 *  android/KEYSTORE.md) and offering it would be a dead end. */
function pickApk(assets: unknown): ReleaseApk | null {
  if (!Array.isArray(assets)) return null
  let best: ReleaseApk | null = null
  for (const raw of assets as GitHubAsset[]) {
    const name = typeof raw?.name === 'string' ? raw.name : null
    const url = typeof raw?.browser_download_url === 'string' ? raw.browser_download_url : null
    if (!name || !url) continue
    const id = parseApkName(name)
    if (!id) continue
    if (!best || id.versionCode > best.versionCode) {
      best = { url, name, sizeBytes: typeof raw.size === 'number' ? raw.size : 0, ...id }
    }
  }
  return best
}

/** Queries the latest GitHub release and compares it to the running version.
 *  Never throws and never rejects: every failure mode is a returned `kind`. */
export async function checkForUpdate(): Promise<UpdateCheck> {
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

  if (!release || typeof release !== 'object') return { kind: 'unknown', detail: 'invalid release body' }

  const tag = typeof release.tag_name === 'string' ? release.tag_name : null
  if (!tag) return { kind: 'unknown', detail: 'release had no tag_name' }

  // /releases/latest already excludes drafts and prereleases, but the field is
  // cheap to honour in case this ever reads /releases instead.
  if (release.draft === true || release.prerelease === true) return { kind: 'no-releases' }

  const apk = pickApk(release.assets)
  if (!apk) {
    // A release with no release-signed APK is one we could never install, and
    // its tag alone cannot be ordered against an untagged running build. Say
    // so to the console and stay silent in the UI rather than offer a dead end.
    const detail = 'Latest release has no compatible APK. Expected workout-tracker-<versionName>-<versionCode>-release.apk; check the release workflow.'
    console.warn('[updates]', detail)
    return { kind: 'unknown', detail }
  }

  // The APK's own versionCode, not the tag, decides this. It is the number
  // Android enforces, and it is the only one that orders a tagged release
  // against the untagged build the board may be running. "Not an upgrade"
  // includes the case where the running build is NEWER than the release --
  // exactly what a board on a main-branch artifact sees, and a downgrade
  // Android would refuse anyway.
  if (!isUpgrade(apk.versionCode)) return { kind: 'current', version: APP_VERSION }

  return {
    kind: 'update-available',
    version: apk.versionName,
    versionCode: apk.versionCode,
    releaseUrl:
      typeof release.html_url === 'string'
        ? release.html_url
        : `https://github.com/TimetoSwett/workout-tracker/releases/tag/${tag}`,
    notes: typeof release.body === 'string' ? release.body : '',
    apk,
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

function read(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function write(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* Storage is optional. */ }
}
const RESULT_KEY = 'wt.update.lastResult'
let launchCheck: Promise<UpdateCheck | null> | null = null

/** Re-decides whether a result is still worth showing. A cached offer outlives
 *  the check that produced it, and the board may have installed the update in
 *  between -- in which case the running versionCode has caught up and the offer
 *  is stale. Re-comparing here is what stops a just-installed build from
 *  greeting the board with an offer to install itself. */
function visible(result: UpdateCheck): UpdateCheck | null {
  if (result.kind === 'update-available') {
    if (typeof result.versionCode !== 'number' || !isUpgrade(result.versionCode)) return null
    if (read(DISMISSED_KEY) === String(result.versionCode)) return null
  }
  return result
}

async function launch(): Promise<UpdateCheck | null> {
  try {
    const cached = JSON.parse(read(RESULT_KEY) || 'null')
    const age = Date.now() - Number(read(LAST_CHECK_KEY))
    if (age >= 0 && age < LAUNCH_CHECK_INTERVAL_MS && cached?.running === APP_VERSION_CODE &&
        ['current', 'no-releases', 'update-available'].includes(cached.result?.kind)) {
      return visible(cached.result)
    }
  } catch { /* Ignore corrupt or unavailable storage. */ }
  const result = await checkForUpdate()
  if (['current', 'no-releases', 'update-available'].includes(result.kind)) {
    write(RESULT_KEY, JSON.stringify({ running: APP_VERSION_CODE, result }))
    write(LAST_CHECK_KEY, String(Date.now()))
  }
  return visible(result)
}

/** Throttle requests, retaining the last conclusive answer until dismissed. */
export function checkForUpdateOnLaunch(): Promise<UpdateCheck | null> {
  if (!launchCheck) launchCheck = launch().finally(() => { launchCheck = null })
  return launchCheck
}

/** Dismissal is keyed on the versionCode, not the name: it must suppress
 *  exactly the one build the board said no to, and let the next release
 *  through. */
export function dismissUpdate(versionCode: number): void {
  write(DISMISSED_KEY, String(versionCode))
}
