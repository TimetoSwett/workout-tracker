import type { Units } from './units'
import { convertWeight } from './units'
import { getState, setActive, setHistory, setSettings } from './store'
import { getMetrics, setMetrics } from './metricsStore'

/** Everything this app persists as a weight is a bare number in whatever `settings.units`
 *  was when it was written — set weights and their targets, the bodyweight on a workout,
 *  the profile bodyweight, the goal rate, and the weight/muscle/lean-mass columns of the
 *  daily metrics. Nothing carries its own unit. So flipping the setting on its own only
 *  relabels: a 5,050 lbs session became a 5,050 kg session.
 *
 *  Switching units therefore has to rewrite the stored numbers. This converts all of them
 *  in one pass and bumps `updatedAt` on every record it changes, so the new values are
 *  what Dropbox sync propagates rather than leaving two devices silently disagreeing
 *  about what the same number means.
 *
 *  Note `settings` is not synced — units are per-device — so a second device keeps its own
 *  setting and has to be switched too. That is inherent to per-device units, not to this
 *  migration.
 *
 *  Returns the number of records touched, for the confirmation copy. */
export function convertStoredWeights(from: Units, to: Units): { workouts: number; metrics: number } {
  if (from === to) return { workouts: 0, metrics: 0 }
  const cv = <T extends number | null | undefined>(v: T): T => (v == null ? v : (convertWeight(v, from, to) as T))
  const now = Date.now()

  const state = getState()
  let workouts = 0
  const nextWorkouts = state.workouts.map((w) => {
    const exercises = w.exercises.map((ex) => ({
      ...ex,
      sets: ex.sets.map((s) => ({ ...s, weight: cv(s.weight), weightTarget: cv(s.weightTarget) })),
    }))
    const bodyweight = cv(w.bodyweight)
    const touched = w.exercises.some((ex) => ex.sets.some((s) => s.weight != null || s.weightTarget != null)) || w.bodyweight != null
    if (!touched) return w
    workouts++
    return { ...w, exercises, bodyweight, updatedAt: now }
  })
  // Mesocycles hold rep targets and set counts only — no weights — so they are untouched.
  setHistory(nextWorkouts, state.mesocycles)

  if (state.active) {
    setActive({
      ...state.active,
      exercises: state.active.exercises.map((ex) => ({
        ...ex,
        sets: ex.sets.map((s) => ({ ...s, weight: cv(s.weight), weightTarget: cv(s.weightTarget) })),
      })),
    })
  }

  let metrics = 0
  setMetrics(
    getMetrics().map((m) => {
      if (m.weight == null && m.muscle == null && m.leanMass == null) return m
      metrics++
      return {
        ...m,
        weight: cv(m.weight),
        muscle: cv(m.muscle),
        leanMass: cv(m.leanMass),
        updatedAt: now,
      }
    }),
  )

  // Settings last: `units` is the flag every reader keys off, so it flips only once the
  // numbers behind it have been rewritten.
  const s = getState().settings
  setSettings({
    ...s,
    units: to,
    profile: s.profile ? { ...s.profile, bodyweight: cv(s.profile.bodyweight) } : s.profile,
    goal: s.goal
      ? {
          ...s.goal,
          ratePerWeek:
            s.goal.ratePerWeek == null ? s.goal.ratePerWeek : convertWeight(s.goal.ratePerWeek, from, to, 2),
        }
      : s.goal,
  })

  return { workouts, metrics }
}
