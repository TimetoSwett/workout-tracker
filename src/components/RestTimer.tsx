import { useEffect, useState } from 'preact/hooks'

interface Props {
  /** Always > 0. The timer unmounts the moment rest expires, so there is no 0:00 state to
   *  render: LogView clears `restEndsAt` on expiry and gates this component on it. The
   *  component used to carry a "Rest complete 💪" branch — a done class, a filled bar and a
   *  Dismiss button — that could never mount, because nothing ever rendered it at zero. The
   *  shipped behaviour is a 400ms buzz and the strip disappearing, which is also what keeps
   *  the scarce vertical space from being held by a strip with nothing left to count. */
  secondsLeft: number
  total: number
  onAdd: (s: number) => void
  onStop: () => void
}

export function RestTimer({ secondsLeft, total, onAdd, onStop }: Props) {
  const [collapsed, setCollapsed] = useState(true)
  const pct = total > 0 ? (secondsLeft / total) * 100 : 0
  const mm = Math.floor(secondsLeft / 60)
  const ss = secondsLeft % 60
  const time = `${mm}:${String(ss).padStart(2, '0')}`

  useEffect(() => {
    if (secondsLeft > 0 && 'vibrate' in navigator) navigator.vibrate?.(1)
  }, [secondsLeft])

  return (
    <div class="rest-timer">
      <div class="rest-summary">
        <div class="rest-label">Rest</div>
        <div class="rest-time">{time}</div>
        <button class="btn small" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>{collapsed ? 'Show controls' : 'Hide controls'}</button>
      </div>
      {!collapsed && <>
        <div class="rest-bar">
          <div class="rest-fill" style={{ width: `${pct}%` }} />
        </div>
        <div class="rest-actions">
          <button class="btn small" onClick={() => onAdd(30)}>
            +30s
          </button>
          <button class="btn small danger" onClick={onStop}>
            Skip
          </button>
        </div>
      </>}
    </div>
  )
}
