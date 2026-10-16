import { useUpdateController } from '../useUpdate'

/** The launch affordance (TOM-2): one quiet line above the content, and only when a newer
 *  release actually exists and has not been dismissed. Every other outcome of the check —
 *  offline, rate-limited, no releases yet, already current — renders nothing at all here. Those
 *  are visible on demand in Settings, where the board went looking for them. */
export function UpdateBanner() {
  const { check, busy, progress, message, install, dismiss } = useUpdateController({ checkOnMount: true })

  const offer = check?.kind === 'update-available' ? check : check?.kind === 'web-update-ready' ? check : null
  if (!offer) return null

  const pct = progress == null ? null : Math.round(progress * 100)
  const web = offer.kind === 'web-update-ready'

  return (
    <div class="update-banner">
      <div class="update-banner-text" role="status">
        <strong>{web ? 'A downloaded web update is ready.' : `Version ${offer.version} is available.`}</strong>
        {message && <span class="muted small"> {pct == null ? message : `Downloading… ${pct}%`}</span>}
      </div>
      <button class="btn primary small" disabled={busy} onClick={install}>
        {web ? 'Reload' : 'Update'}
      </button>
      <button class="btn ghost small" disabled={busy} onClick={dismiss} aria-label="Dismiss this update">
        ✕
      </button>
    </div>
  )
}
