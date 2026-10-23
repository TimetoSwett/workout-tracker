import type { Units } from './units'
import { convertWeight } from './units'
import { commitActiveAndSettings, commitHistory, flushHistory, getState, isConverting, runConversion } from './store'
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
 *  History lives in IndexedDB and is written asynchronously, while the unit setting and
 *  metrics are written to localStorage at once. If the unit were saved first and the history
 *  write then failed, the next launch would read the old numbers under the new unit (100 lbs
 *  as 100 kg). So the converted history is committed first, then the metrics, then the active
 *  workout and settings (the unit) in one write. If any step fails, the history is committed
 *  back to the original, metrics and the active workout are restored, the unit is left alone,
 *  and `error` says why. If the history cannot be put back, the converted history is what is
 *  stored, so the new unit, metrics and active workout are kept to match it (`unitsChanged`).
 *  History and active-workout edits are refused (see `runConversion`) while this runs so a
 *  rollback cannot drop one.
 *
 *  Returns the number of records touched, for the confirmation copy. */
export async function convertStoredWeights(
  from: Units,
  to: Units,
): Promise<{ workouts: number; metrics: number; error: string | null; unitsChanged?: boolean }> {
  if (from === to) return { workouts: 0, metrics: 0, error: null }
  if (isConverting()) return { workouts: 0, metrics: 0, error: 'A unit conversion is already running.' }
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

  return runConversion(async (writeHistory) => {
    writeHistory(nextWorkouts, state.mesocycles)
    const historyErr = await commitHistory()
    if (historyErr) {
      writeHistory(state.workouts, state.mesocycles)
      await flushHistory()
      return { workouts: 0, metrics: 0, error: historyErr }
    }

    // The active workout, settings and metrics are not blocked during the history await, so they
    // are read only now, right before the synchronous section that converts and (if needed) restores them.
    const origMetrics = getMetrics()
    const { active: origActive, settings: origSettings } = getState()

    // Everything below is synchronous, so nothing can interleave with it or its rollback.
    // `units` is the flag every reader keys off and lives in the same localStorage slice as the
    // active workout, so both go in one write and only after history and metrics are stored.
    let metrics = 0
    const s = origSettings
    const nextMetrics = origMetrics.map((m) => {
      if (m.weight == null && m.muscle == null && m.leanMass == null) return m
      metrics++
      return {
        ...m,
        weight: cv(m.weight),
        muscle: cv(m.muscle),
        leanMass: cv(m.leanMass),
        updatedAt: now,
      }
    })
    const nextActive = origActive && {
      ...origActive,
      exercises: origActive.exercises.map((ex) => ({
        ...ex,
        sets: ex.sets.map((x) => ({ ...x, weight: cv(x.weight), weightTarget: cv(x.weightTarget) })),
      })),
    }
    const nextSettings = {
      ...s,
      units: to,
      profile: s.profile ? { ...s.profile, bodyweight: cv(s.profile.bodyweight) } : s.profile,
      goal: s.goal
        ? {
            ...s.goal,
            ratePerWeek: s.goal.ratePerWeek == null ? s.goal.ratePerWeek : convertWeight(s.goal.ratePerWeek, from, to, 2),
          }
        : s.goal,
    }
    try {
      setMetrics(nextMetrics)
      const saveErr = commitActiveAndSettings(nextActive, nextSettings)
      if (saveErr) throw new Error(saveErr)
    } catch (e) {
      const failures: string[] = []
      const why = e instanceof Error ? e.message : String(e)
      writeHistory(state.workouts, state.mesocycles)
      const back = await commitHistory().catch((x: unknown) => String(x))
      if (back) {
        // The converted history is what is stored and could not be put back. Reverting the unit now would
        // label those numbers with the old unit, so everything else moves to the new unit to match them.
        writeHistory(nextWorkouts, state.mesocycles)
        try {
          setMetrics(nextMetrics)
        } catch (x) {
          failures.push(`metrics: ${x instanceof Error ? x.message : String(x)}`)
        }
        if (commitActiveAndSettings(nextActive, nextSettings)) failures.push('settings')
        return {
          workouts,
          metrics,
          unitsChanged: true,
          error: `${why}; history could not be restored (${back}), so your data was kept converted to ${to}${
            failures.length ? ` (and could not be fully saved — ${failures.join('; ')})` : ''
          }`,
        }
      }
      try {
        setMetrics([...origMetrics])
      } catch (x) {
        failures.push(`metrics: ${x instanceof Error ? x.message : String(x)}`)
      }
      if (commitActiveAndSettings(origActive, origSettings)) failures.push('settings')
      return {
        workouts: 0,
        metrics: 0,
        error: failures.length ? `${why} (could not fully roll back — ${failures.join('; ')})` : why,
      }
    }

    return { workouts, metrics, error: null }
  })
}
