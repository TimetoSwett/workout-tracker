// Build version, injected by Vite from scripts/app-version.mjs (see vite.config.ts).
// The APK's versionName is stamped from the same value in the same CI step, so
// what Settings shows is the build that is actually running.

declare const __APP_VERSION__: string
declare const __APP_VERSION_CODE__: number

/** e.g. '1.2.0' for a v1.2.0 release, '2026.09.29.a1b2c3d' for an untagged build. */
export const APP_VERSION: string = __APP_VERSION__

/** The Android versionCode of this build. Monotonic; comparable against a release's. */
export const APP_VERSION_CODE: number = __APP_VERSION_CODE__

/* ------------------------------------------------------------------ *
 * Comparing the running build against a release
 *
 * versionName is not orderable on its own. A tagged build names itself
 * '1.2.0'; an untagged one names itself '2026.09.29.a1b2c3d'. The board runs
 * both, because PR artifacts are release-signed and install straight over a
 * release. versionCode is the only value that orders every build against
 * every other one, and it is the only one Android itself honours: it refuses
 * an install whose versionCode does not increase.
 *
 * So the updater compares versionCode, and a release publishes its own
 * versionCode in the APK's asset name. That keeps the comparison exact with
 * no second API request, and the number compared is read off the very
 * artifact we would install rather than inferred from the tag.
 * ------------------------------------------------------------------ */

/** `workout-tracker-<versionName>-<versionCode>-release.apk`, written by
 *  .github/workflows/android-apk.yml. Only a release-signed APK can update the
 *  installed app: a debug-signed one carries a throwaway key and Android
 *  rejects it (android/KEYSTORE.md), so the `-release` suffix is load-bearing. */
const RELEASE_APK_NAME = /^workout-tracker-(.+)-(\d+)-release\.apk$/i

export interface ApkIdentity {
  versionName: string
  versionCode: number
}

/** The version a release APK asset declares, or null when the name does not
 *  follow the scheme -- treated as "cannot compare" rather than guessed at. */
export function parseApkName(name: string): ApkIdentity | null {
  const m = RELEASE_APK_NAME.exec(name.trim())
  if (!m) return null
  const versionCode = Number(m[2])
  if (!Number.isSafeInteger(versionCode) || versionCode < 1) return null
  return { versionName: m[1], versionCode }
}

/** True when `candidateVersionCode` is a build Android would accept as an
 *  upgrade over the running one. Equal codes are not an upgrade -- that is the
 *  "already current" case, and offering it walks the board into an installer
 *  that refuses. */
export function isUpgrade(candidateVersionCode: number): boolean {
  return candidateVersionCode > APP_VERSION_CODE
}
