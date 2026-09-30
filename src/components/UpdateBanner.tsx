import { canInstallUpdates } from '../appUpdate'
import { useUpdateController } from '../useUpdate'

/** The launch affordance (TOM-2): one quiet line above the content, and only when a newer
 *  release actually exists and has not been dismissed. Every other outcome of the check —
 *  offline, rate-limited, no releases yet, already current — renders nothing at all here. Those
 *  are visible on demand in Settings, where the board went looking for them. */
export function UpdateBanner() {
  const { check, busy, progress, message, install, dismiss } = useUpdateController({ checkOnMount: true })

  if (check?.kind !== 'update-available') return null

  const pct = progress == null ? null : Math.round(progress * 100)
  const label = canInstallUpdates() ? 'Update' : 'Reload'

  return (
    <div class="update-banner" role="status">
      <div class="update-banner-text">
        <strong>Version {check.version} is available.</strong>
        {busy && <span class="muted small"> {pct == null ? message : `Downloading… ${pct}%`}</span>}
      </div>
      <button class="btn primary small" disabled={busy} onClick={install}>
        {label}
      </button>
      <button class="btn ghost small" disabled={busy} onClick={dismiss} aria-label="Dismiss this update">
        ✕
      </button>
    </div>
  )
}
