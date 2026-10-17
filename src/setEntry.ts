import type { LoggedExercise, LoggedSet, Workout } from './types'
import { isCompletedSet, isScoringWorkout } from './records'

/** A set the user has not finished. Skipped and completed rows are left alone;
 *  a pending or unticked row is still open. */
export function isUnfinishedSet(s: LoggedSet): boolean {
  if (s.status === 'skipped' || s.status === 'complete') return false
  return s.done !== true
}

/** Copy a committed weight onto later unfinished sets of this exercise.
 *
 *  `previous` is the weight when editing started. The same number, or a cleared
 *  field, does not spread: clearing changes only the set that was edited, and a
 *  blur without a change is not an edit. Earlier sets, finished sets, reps, and
 *  every other exercise are untouched. The caller only passes the current exercise.
 */
export function weightsFilledForward(sets: LoggedSet[], index: number, previous: number | null): LoggedSet[] {
  const next = sets[index]?.weight ?? null
  if (next == null || Object.is(next, previous)) return sets
  let changed = false
  const filled = sets.map((s, i) => {
    if (i <= index || !isUnfinishedSet(s) || Object.is(s.weight, next)) return s
    changed = true
    return { ...s, weight: next }
  })
  return changed ? filled : sets
}

export interface HistorySet {
  weight: number | null
  reps: number | null
}

export interface ExerciseHistorySession {
  workoutId: string
  date: string
  startedAt: number
  sets: HistorySet[]
}

function sameExercise(ex: LoggedExercise, current: { templateExerciseId?: string; name: string }): boolean {
  // A template id is the exercise. Matching the name as well would pull in a
  // different lift that only happens to be spelled the same.
  if (current.templateExerciseId) return ex.templateExerciseId === current.templateExerciseId
  const name = current.name.trim().toLowerCase()
  if (!name) return false
  return ex.name.trim().toLowerCase() === name
}

/** Past sessions for one exercise, newest first.
 *
 *  The workout in progress is excluded, and so is any set that was not actually
 *  performed. A session with nothing completed is omitted. Identity is the
 *  template id when the current exercise has one; otherwise the exact name,
 *  not a prefix or a similar spelling.
 */
export function exerciseHistory(
  workouts: Workout[],
  current: { templateExerciseId?: string; name: string },
  activeWorkoutId: string,
): ExerciseHistorySession[] {
  const sessions: ExerciseHistorySession[] = []
  for (const w of workouts) {
    if (w.id === activeWorkoutId || !isScoringWorkout(w)) continue
    for (const ex of w.exercises) {
      if (!sameExercise(ex, current)) continue
      const sets = ex.sets.filter(isCompletedSet).map((s) => ({ weight: s.weight, reps: s.reps }))
      if (sets.length === 0) continue
      sessions.push({ workoutId: w.id, date: w.date, startedAt: w.startedAt, sets })
    }
  }
  sessions.sort((a, b) => b.date.localeCompare(a.date) || b.startedAt - a.startedAt)
  return sessions
}
