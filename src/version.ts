// Build version, injected by Vite from scripts/app-version.mjs (see vite.config.ts).
// The APK's versionName is stamped from the same value in the same CI step, so
// what Settings shows is the build that is actually running.

declare const __APP_VERSION__: string
declare const __APP_VERSION_CODE__: number

/** e.g. '1.2.0' for a v1.2.0 release, '2026.09.29.a1b2c3d' for an untagged build. */
export const APP_VERSION: string = __APP_VERSION__

/** The Android versionCode of this build. Monotonic; comparable against a release's. */
export const APP_VERSION_CODE: number = __APP_VERSION_CODE__
