import type { CheckinOption } from '../checkin'

export interface CheckinQuestion {
  key: string
  prompt: string
  options: CheckinOption[]
  value: number | undefined
}

/** One page of the per-exercise check-in: each question is a row of tap targets that carry
 *  their wording, like the RP app. Tapping an answer reports it; the caller decides when the
 *  page is finished. */
export function Checkin({
  title,
  questions,
  onAnswer,
  onDone,
}: {
  title: string
  questions: CheckinQuestion[]
  onAnswer: (key: string, value: number) => void
  onDone: () => void
}) {
  return (
    <div class="exercise-feel checkin" role="group" aria-label={title}>
      <p class="checkin-title">{title}</p>
      {questions.map((q) => (
        <div key={q.key} class="checkin-question" role="radiogroup" aria-label={q.prompt}>
          <p class="muted small">{q.prompt}</p>
          <div class={`choice-grid ${q.options.length === 3 ? 'three' : ''}`}>
            {q.options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={q.value === o.value}
                class={`choice-btn ${q.value === o.value ? 'active' : ''}`}
                onClick={() => onAnswer(q.key, o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      ))}
      <button class="btn small ghost" type="button" onClick={onDone}>
        Done
      </button>
    </div>
  )
}
