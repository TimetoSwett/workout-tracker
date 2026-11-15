import { useMemo, useState } from 'preact/hooks'
import type { Workout } from '../types'
import { applyLogEdit, findLogEdits, type LogEdit } from '../logReview'
import { upsertWorkout } from '../store'
import { sync } from '../sync'
import { dropboxConfigured } from '../dropbox'
import type { Settings } from '../types'

/** Shows inconsistent old entries. A change is written only when the user allows it. */
export function LogCheck({ workouts, planNames, settings }: { workouts: Workout[]; planNames: string[]; settings: Settings }) {
  const [hidden, setHidden] = useState<string[]>([])
  const edits = useMemo(
    () => findLogEdits(workouts, planNames, settings.units).filter((e) => !hidden.includes(e.id)),
    [workouts, planNames, settings.units, hidden],
  )
  if (edits.length === 0) return null

  function allow(edit: LogEdit) {
    const workout = workouts.find((w) => w.id === edit.workoutId)
    if (!workout) {
      setHidden((ids) => [...ids, edit.id])
      return
    }
    const next = applyLogEdit(workout, edit)
    if (!next) {
      setHidden((ids) => [...ids, edit.id])
      return
    }
    upsertWorkout({ ...next, updatedAt: Date.now() })
    if (dropboxConfigured(settings)) void sync()
  }

  return (
    <div class="card">
      <h3>Log check</h3>
      <p class="muted small">Inconsistent old entries. Nothing is changed until you allow that one.</p>
      {edits.map((edit) => (
        <div key={edit.id} class="template-row">
          <span class="template-name">{edit.date}</span>
          <span class="template-meta">{edit.reason}</span>
          <div class="btn-row">
            <button class="btn small primary" type="button" onClick={() => allow(edit)}>
              Allow {edit.from} → {edit.to}
            </button>
            <button class="btn small ghost" type="button" onClick={() => setHidden((ids) => [...ids, edit.id])}>
              Skip
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
