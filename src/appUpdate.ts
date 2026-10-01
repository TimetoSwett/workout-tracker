import { Capacitor, registerPlugin } from '@capacitor/core'
import type { ReleaseApk } from './updates'

/** The Android side of one-tap updates (TOM-2): the bridge to `AppUpdatePlugin.kt`, plus the
 *  capability check the UI uses to decide between "install the APK" and "reload the page".
 *
 *  Kept separate from `updates.ts` on purpose: the GitHub release query there is plain
 *  fetch/JSON with no native dependency, which keeps it runnable (and verifiable) outside a
 *  WebView. */

export interface AppUpdateInfo {
  /** versionName baked into the running APK, for cross-checking __APP_VERSION__. */
  versionName: string
  versionCode: number
  /** False when the user has not granted "install unknown apps" for this app.
   *  Android has no way to grant it programmatically; the OS requires a visit
   *  to its own settings screen, once, ever. */
  canRequestInstalls: boolean
}

export interface DownloadProgress {
  bytes: number
  totalBytes: number
}

interface AppUpdatePluginApi {
  getInfo(): Promise<AppUpdateInfo>
  openInstallPermissionSettings(): Promise<void>
  downloadAndInstall(options: { url: string; versionName: string }): Promise<void>
  addListener(event: 'downloadProgress', cb: (p: DownloadProgress) => void): Promise<{ remove: () => Promise<void> }>
}

const AppUpdate = registerPlugin<AppUpdatePluginApi>('AppUpdate')

/** One-tap install only exists on the Android build. Everywhere else the web
 *  app offers a reload only after its service worker caches a new deployment. */
export function canInstallUpdates(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
}

export function getNativeAppInfo(): Promise<AppUpdateInfo> {
  return AppUpdate.getInfo()
}

export function openInstallPermissionSettings(): Promise<void> {
  return AppUpdate.openInstallPermissionSettings()
}

/** Downloads the APK and hands it to the Android package installer. Resolves
 *  once the installer has been launched; from there the OS owns the flow, and
 *  the app is killed and replaced if the board confirms. */
export function downloadAndInstall(apk: ReleaseApk, versionName: string): Promise<void> {
  return AppUpdate.downloadAndInstall({ url: apk.url, versionName })
}

export function onDownloadProgress(cb: (p: DownloadProgress) => void) {
  return AppUpdate.addListener('downloadProgress', cb)
}

export { activateWebUpdate as reloadForUpdate } from './webUpdate'
