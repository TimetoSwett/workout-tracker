import { Capacitor } from '@capacitor/core'
import { Browser } from '@capacitor/browser'
import { StatusBar, Style } from '@capacitor/status-bar'

export const isNative = Capacitor.isNativePlatform()

/** The app is always dark-themed (see `:root { color-scheme: dark }`), so the
 *  status bar needs light icons/text and, pre-Android-15, must not paint a
 *  light background under them. `overlaysWebView`/`backgroundColor` are
 *  no-ops on Android 15+ (edge-to-edge is forced there) — safe areas are
 *  handled in CSS via `env(safe-area-inset-*)` instead, which works the same
 *  on every version. */
export async function initStatusBar(): Promise<void> {
  if (!isNative) return
  try {
    await StatusBar.setOverlaysWebView({ overlay: true })
    await StatusBar.setStyle({ style: Style.Dark })
  } catch {
    // Unsupported on this platform/version — CSS safe-area insets still apply.
  }
}

/** Opens an external URL in the system browser.
 *
 *  Plain `window.open`/`<a target="_blank">` silently no-ops in Capacitor's
 *  Android WebView: it has no `WebChromeClient.onCreateWindow` wired up, so
 *  there is nothing to catch the new-window request. Route through
 *  `@capacitor/browser` on native so the Dropbox authorize link (and any
 *  other outbound link) actually opens. */
export async function openExternal(url: string): Promise<void> {
  if (isNative) {
    await Browser.open({ url })
  } else {
    window.open(url, '_blank', 'noopener')
  }
}
