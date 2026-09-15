import { useEffect } from 'preact/hooks'

interface Props {
  secondsLeft: number
  total: number
  onAdd: (s: number) => void
  onStop: () => void
}

export function RestTimer({ secondsLeft, total, onAdd, onStop }: Props) {
  const pct = total > 0 ? (secondsLeft / total) * 100 : 0
  const mm = Math.floor(secondsLeft / 60)
  const ss = secondsLeft % 60
  const time = `${mm}:${String(ss).padStart(2, '0')}`

  useEffect(() => {
    if (secondsLeft > 0 && 'vibrate' in navigator) navigator.vibrate?.(1)
  }, [secondsLeft])

  return (
    <div class={`rest-timer ${secondsLeft === 0 ? 'done' : ''}`}>
      <div class="rest-label">{secondsLeft === 0 ? 'Rest complete 💪' : 'Rest'}</div>
      <div class="rest-time">{time}</div>
      <div class="rest-bar">
        <div class="rest-fill" style={{ width: `${secondsLeft === 0 ? 100 : pct}%` }} />
      </div>
      <div class="rest-actions">
        {secondsLeft > 0 ? (
          <>
            <button class="btn small" onClick={() => onAdd(30)}>
              +30s
            </button>
            <button class="btn small danger" onClick={onStop}>
              Skip
            </button>
          </>
        ) : (
          <button class="btn small" onClick={onStop}>
            Dismiss
          </button>
        )}
      </div>
    </div>
  )
}
