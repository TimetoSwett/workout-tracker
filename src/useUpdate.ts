import { webUpdateReady } from './webUpdate'
import { APP_VERSION } from './version'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

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
      return `Version ${check.version} is available.`
    case 'web-update-ready':
      return 'A downloaded web update is ready.'
    case 'current':
      return canInstallUpdates() ? `Up to date (${check.version}).` : `No downloaded web update is ready (${check.version}).`
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

// Release discovery and web deployment availability are independent. Never cache
// web readiness in the six-hour GitHub result: verify the worker each time.
async function availableHere(onLaunch = false): Promise<UpdateCheck | null> {
  if (canInstallUpdates()) return onLaunch ? checkForUpdateOnLaunch() : checkForUpdate()
  if (await webUpdateReady()) return { kind: 'web-update-ready' }
  return { kind: 'current', version: APP_VERSION }
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
    void availableHere(true).then((result) => {
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
    void availableHere().then((result) => {
      setCheck(result)
      setMessage(result ? describe(result) : '')
      setBusy(false)
      inFlight.current = false
    })
  }, [])

  const install = useCallback(() => {
    if (inFlight.current || installInFlight) return

    if (check?.kind === 'web-update-ready') {
      inFlight.current = true
      installInFlight = true
      setBusy(true)
      setMessage('Activating the downloaded web update…')
      void reloadForUpdate().catch(() => {
        setMessage('The web update is not ready. Check again shortly.')
      }).finally(() => {
        inFlight.current = false
        installInFlight = false
        setBusy(false)
      })
      return
    }

    if (check?.kind !== 'update-available') return

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
    // Web dismissal lasts for this page; never persist a generic key that hides future deployments.
    if (check?.kind === 'update-available') dismissUpdate(check.versionCode)
    setCheck(null)
    setMessage('')
  }, [check])

  return { check, busy, progress, message, runCheck, install, dismiss }
}
