import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { openExternal } from './native'

import { checkForUpdate, checkForUpdateOnLaunch, dismissUpdate, type UpdateCheck } from './updates'
import {
  canInstallUpdates,
  downloadAndInstall,
  getNativeAppInfo,
  onDownloadProgress,
  openInstallPermissionSettings,
  reloadForUpdate,
} from './appUpdate'

/** Thrown across the Capacitor bridge by AppUpdatePlugin when the board has not yet granted
 *  "install unknown apps". Not an error to show — it is a signposted detour. */
let installInFlight = false

const NEEDS_INSTALL_PERMISSION = 'NEEDS_INSTALL_PERMISSION'

export interface UpdateController {
  /** Null until a check has produced an answer. */
  check: UpdateCheck | null
  /** True while a check or a download is in flight. */
  busy: boolean
  /** 0..1 while downloading, null otherwise. */
  progress: number | null
  /** Quiet one-line status for the UI. Never a dialog. */
  message: string
  runCheck: () => void
  install: () => void
  dismiss: () => void
}

/** Renders every failure as a sentence rather than an error. The board can act on "you're
 *  offline"; they cannot act on a stack trace, and a modal about GitHub being unreachable while
 *  they are mid-set is worse than silence. */
function describe(check: UpdateCheck): string {
  switch (check.kind) {
    case 'update-available':
      return check.apk
        ? `Version ${check.version} is available.`
        : `Version ${check.version} is available, but it has no release-signed APK attached.`
    case 'current':
      return `Up to date (${check.version}).`
    case 'no-releases':
      return 'No releases published yet.'
    case 'rate-limited':
      return "GitHub's rate limit is reached. Try again later."
    case 'offline':
      return "Couldn't reach GitHub. You may be offline."
    case 'unknown':
      return "Couldn't read the latest release."
  }
}

/** One instance per consumer: the launch banner mounts it with `checkOnMount`, the Settings
 *  panel mounts it for on-demand checks. They hold independent state, but the throttle and the
 *  dismissal both live in localStorage, so neither double-checks or re-nags because of the other. */
export function useUpdateController(options?: { checkOnMount?: boolean }): UpdateController {
  const [check, setCheck] = useState<UpdateCheck | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [message, setMessage] = useState('')
  const inFlight = useRef(false)

  useEffect(() => {
    if (!options?.checkOnMount) return
    // The request is throttled; an undismissed cached offer remains visible.
    void checkForUpdateOnLaunch().then((result) => {
      if (result) {
        setCheck(result)
        setMessage(describe(result))
      }
    })
  }, [])

  const runCheck = useCallback(() => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setMessage('Checking…')
    void checkForUpdate().then((result) => {
      setCheck(result)
      setMessage(describe(result))
      setBusy(false)
      inFlight.current = false
    })
  }, [])

  const install = useCallback(() => {
    if (inFlight.current || installInFlight) return
    if (check?.kind !== 'update-available') return

    // Web/PWA: the service worker is registerType 'autoUpdate', so the new build is already
    // cached and a reload is genuinely the whole update. No install button to break.
    if (!canInstallUpdates()) {
      reloadForUpdate()
      return
    }
    // Android with no release-signed asset: a debug-signed APK cannot install over the
    // release-signed app, so send them to the release page instead of failing at the installer.
    if (!check.apk) {
      void openExternal(check.releaseUrl)
      return
    }

    const apk = check.apk
    installInFlight = true
    inFlight.current = true
    setBusy(true)
    setMessage('Checking install permission…')
    void (async () => {
      let listener: Awaited<ReturnType<typeof onDownloadProgress>> | undefined
      try {
        const info = await getNativeAppInfo()
        if (!info.canRequestInstalls) {
          setMessage('Allow installs from this app in Android settings, then return and tap Update again.')
          await openInstallPermissionSettings()
          return
        }
        listener = await onDownloadProgress(({ bytes, totalBytes }) => {
          setProgress(totalBytes > 0 ? Math.min(1, bytes / totalBytes) : null)
        })
        setProgress(0)
        setMessage('Downloading…')
        await downloadAndInstall(apk, check.version)
        setMessage('Opening the installer…')
      } catch (err: unknown) {
        const text = err instanceof Error ? err.message : String(err)
        setMessage(text.includes(NEEDS_INSTALL_PERMISSION)
          ? 'Android install permission changed. Tap Update to open settings and allow installs.'
          : 'Could not install the update. Try again, or download the APK from the release page.')
      } finally {
        try { await listener?.remove() } catch { /* Cleanup must always release the guard. */ }
        setBusy(false)
        setProgress(null)
        inFlight.current = false
        installInFlight = false
      }
    })()

  }, [check])

  const dismiss = useCallback(() => {
    if (check?.kind === 'update-available') dismissUpdate(check.version)
    setCheck(null)
    setMessage('')
  }, [check])

  return { check, busy, progress, message, runCheck, install, dismiss }
}
