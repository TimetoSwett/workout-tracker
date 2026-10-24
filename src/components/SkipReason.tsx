import { useState } from 'preact/hooks'
import { skipReasonText } from '../skipExercise'

export const SKIP_REASONS = ['Low energy', 'Still sore', 'No time', 'Other'] as const

export function SkipReasonDialog({
  title,
  onChoose,
  onCancel,
}: {
  title: string
  onChoose: (reason: string) => void
  onCancel: () => void
}) {
  const [other, setOther] = useState(false)
  const [text, setText] = useState('')

  return (
    <div class="modal-backdrop" onClick={onCancel}>
      <div class="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p class="muted small">Why are you skipping?</p>
        <div class="reason-list">
          {SKIP_REASONS.map((reason) => (
            <button
              key={reason}
              class={`btn wide ${other && reason === 'Other' ? 'primary' : ''}`}
              type="button"
              onClick={() => (reason === 'Other' ? setOther(true) : onChoose(reason))}
            >
              {reason}
            </button>
          ))}
        </div>
        {other && (
          <>
            <input
              class="text-input"
              type="text"
              placeholder="Why? (optional)"
              aria-label="Other reason"
              value={text}
              autoFocus
              onInput={(e) => setText((e.target as HTMLInputElement).value)}
            />
            <button class="btn primary wide" type="button" onClick={() => onChoose(skipReasonText('Other', text))}>
              Skip
            </button>
          </>
        )}
        <button class="btn ghost wide" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
