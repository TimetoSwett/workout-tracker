import type { Workout } from './types'
import { isCompletedSet, isScoringWorkout } from './records'

export interface LogEdit {
  id: string
  workoutId: string
  exerciseId: string
  setIndex?: number
  date: string
  kind: 'rename' | 'weight'
  from: string
  to: string
  reason: string
}

/** Same letters and numbers, so "Bench-Press" and "bench press" are one spelling group.
 *  "Bench Press" and "Incline Bench Press" stay different. */
export function looseName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/** Inconsistencies the coach may fix only after the user allows that one change.
 *  A different lift is never treated as a spelling of this one, and a normal
 *  lighter or heavier day is not treated as a bad number. */
export function findLogEdits(workouts: Workout[], planNames: string[], unit: string): LogEdit[] {
  const edits: LogEdit[] = []
  const scoring = workouts.filter(isScoringWorkout)

  const groups = new Map<string, { name: string; count: number; latest: string }[]>()
  for (const w of scoring) {
    for (const ex of w.exercises) {
      const key = looseName(ex.name)
      if (!key) continue
      const exact = ex.name.trim()
      const list = groups.get(key) ?? []
      const found = list.find((g) => g.name === exact)
      if (found) {
        found.count += 1
        if (w.date > found.latest) found.latest = w.date
      } else list.push({ name: exact, count: 1, latest: w.date })
      groups.set(key, list)
    }
  }

  const canonical = new Map<string, string>()
  for (const [key, list] of groups) {
    if (list.length < 2) continue
    const planned = planNames.map((n) => n.trim()).find((n) => looseName(n) === key)
    const usual = [...list].sort((a, b) => b.count - a.count || b.latest.localeCompare(a.latest))[0]
    canonical.set(key, planned || usual.name)
  }

  const weightsByName = new Map<string, number[]>()
  for (const w of scoring) {
    for (const ex of w.exercises) {
      if (ex.skipReason) continue
      const key = ex.name.trim().toLowerCase()
      const nums = weightsByName.get(key) ?? []
      for (const s of ex.sets) {
        if (isCompletedSet(s) && s.weight != null && s.weight > 0) nums.push(s.weight)
      }
      weightsByName.set(key, nums)
    }
  }

  for (const w of scoring) {
    for (const ex of w.exercises) {
      const key = looseName(ex.name)
      const usual = canonical.get(key)
      if (usual && ex.name.trim() !== usual) {
        edits.push({
          id: `${w.id}:${ex.id}:rename`,
          workoutId: w.id,
          exerciseId: ex.id,
          date: w.date,
          kind: 'rename',
          from: ex.name.trim(),
          to: usual,
          reason: `“${ex.name.trim()}” is the same name as “${usual}”, spelled differently.`,
        })
      }
      if (ex.skipReason) continue
      const samples = weightsByName.get(ex.name.trim().toLowerCase()) ?? []
      if (samples.length < 5) continue
      const mid = median(samples)
      if (!(mid > 0)) continue
      ex.sets.forEach((s, setIndex) => {
        if (!isCompletedSet(s) || s.weight == null || s.weight <= 0) return
        if (s.weight > mid * 2.5 || s.weight < mid * 0.4) {
          const to = String(round1(mid))
          edits.push({
            id: `${w.id}:${ex.id}:${setIndex}:weight`,
            workoutId: w.id,
            exerciseId: ex.id,
            setIndex,
            date: w.date,
            kind: 'weight',
            from: String(s.weight),
            to,
            reason: `${ex.name.trim()} at ${s.weight} ${unit} is far from your usual ${round1(mid)} ${unit}.`,
          })
        }
      })
    }
  }

  return edits.slice(0, 40)
}

/** Applies one allowed edit. Returns null when the session no longer matches the
 *  proposal, so an old suggestion cannot overwrite a newer value. */
export function applyLogEdit(workout: Workout, edit: LogEdit): Workout | null {
  let changed = false
  const exercises = workout.exercises.map((ex) => {
    if (ex.id !== edit.exerciseId) return ex
    if (edit.kind === 'rename') {
      if (ex.name.trim() !== edit.from) return ex
      changed = true
      return { ...ex, name: edit.to }
    }
    const sets = ex.sets.map((s, i) => {
      if (i !== edit.setIndex || s.weight == null || Math.abs(s.weight - Number(edit.from)) > 0.05) return s
      changed = true
      return { ...s, weight: Number(edit.to) }
    })
    return changed ? { ...ex, sets } : ex
  })
  return changed ? { ...workout, exercises } : null
}
