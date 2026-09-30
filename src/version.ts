/** The running app's version.
 *
 *  There is exactly one source of truth for this: `version` in `package.json`.
 *  It reaches here through a Vite `define` (see `vite.config.ts`) and reaches
 *  the Android artifact through `android/app/build.gradle`, which parses the
 *  same file for `versionName`/`versionCode`. CI asserts the built APK's
 *  `versionName` equals `package.json`'s `version`, so the string the board
 *  reads in Settings provably matches the artifact they are running. */
export const APP_VERSION: string = __APP_VERSION__

export interface Semver {
  major: number
  minor: number
  patch: number
}

/** Parses `1.2.3`, tolerating a `v` prefix and ignoring any `-pre`/`+build` suffix.
 *  Returns null for anything that isn't three numeric components, so a release
 *  tag that doesn't follow the scheme is treated as "can't compare" rather than
 *  silently sorting as older or newer. */
export function parseSemver(raw: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(raw.trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

/** Negative when `a` is older than `b`, zero when equal, positive when newer. */
export function compareSemver(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}
