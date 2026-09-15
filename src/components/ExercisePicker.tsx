import { useState } from 'preact/hooks'
import type { LoggedExercise, Template } from '../types'
import { EXERCISE_PRESETS } from '../types'
import { getState } from '../store'

interface Props {
  onPick: (name: string) => void
  onClose: () => void
}

export function ExercisePicker({ onPick, onClose }: Props) {
  const [q, setQ] = useState('')
  const query = q.trim().toLowerCase()

  const names = new Set<string>(EXERCISE_PRESETS)
  for (const w of getState().workouts) for (const ex of w.exercises) names.add(ex.name)
  for (const t of getState().templates as Template[]) for (const ex of t.exercises) names.add(ex.name)
  if (getState().active) for (const ex of getState().active!.exercises) names.delete(ex.name)

  const matches = [...names]
    .filter((n) => n.toLowerCase().includes(query))
    .sort((a, b) => {
      const ai = a.toLowerCase().startsWith(query) ? 0 : 1
      const bi = b.toLowerCase().startsWith(query) ? 0 : 1
      return ai - bi || a.localeCompare(b)
    })
    .slice(0, 25)

  return (
    <div class="modal-backdrop" onClick={onClose}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Add exercise</h3>
        <input
          class="text-input"
          type="text"
          placeholder="Search or type new exercise…"
          value={q}
          autoFocus
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
        />
        <div class="picker-list">
          {q.trim() && !names.has(q.trim()) && (
            <button class="picker-item new" onClick={() => onPick(q.trim())}>
              ＋ Use “{q.trim()}”
            </button>
          )}
          {matches.map((n) => (
            <button key={n} class="picker-item" onClick={() => onPick(n)}>
              {n}
            </button>
          ))}
        </div>
        <button class="btn ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  )
}

export function emptyExercise(name: string): LoggedExercise {
  return { id: crypto.randomUUID(), name, sets: [{ weight: null, reps: null, done: false }] }
}
