import { useEffect } from 'preact/hooks'

interface Props {
  /** Seconds of rest remaining; 0 means no rest is running. The strip renders in both
   *  cases so its height never changes. */
  secondsLeft: number
  total: number
  onAdd: (s: number) => void
  onStop: () => void
}

/** Always mounted for the whole active workout, at one fixed height.
 *
 *  It used to mount only while rest was running, and to grow a second row when its
 *  controls were expanded. Both pushed the header, the first set and the input the user
 *  was typing into down the screen — 59px on start and 45px more on expand at 360px and
 *  390px — and pulled them back up again on Skip or expiry. Since a stable layout has to
 *  reserve the tallest state anyway, the collapse toggle was saving nothing: +30s and Skip
 *  are now always on the row, disabled while no rest is running. */
export function RestTimer({ secondsLeft, total, onAdd, onStop }: Props) {
  const running = secondsLeft > 0
  const pct = running && total > 0 ? (secondsLeft / total) * 100 : 0
  const mm = Math.floor(secondsLeft / 60)
  const ss = secondsLeft % 60

  useEffect(() => {
    if (secondsLeft > 0 && 'vibrate' in navigator) navigator.vibrate?.(1)
  }, [secondsLeft])

  return (
    <div class="rest-timer">
      <div class="rest-summary">
        <div class="rest-label">Rest</div>
        <div class="rest-time">{running ? `${mm}:${String(ss).padStart(2, '0')}` : '—'}</div>
        <div class="rest-actions">
          <button class="btn small" disabled={!running} onClick={() => onAdd(30)}>
            +30s
          </button>
          <button class="btn small danger" disabled={!running} onClick={onStop}>
            Skip
          </button>
        </div>
      </div>
      <div class="rest-bar">
        <div class="rest-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
