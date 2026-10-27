import type { LoggedExercise, Workout } from './types'
import { muscleGroupName } from './mesoEngine'
import { phaseSummary } from './checkin'

/**
 * Display text for a workout's post-workout ratings (History).
 *
 * Skipped workouts are never rated and never shown as unrated: they produce
 * no lines at all, even if a record somehow carries ratings or feedback.
 * Unrated performed workouts likewise produce nothing — absence is the display.
 */

/** "Joint soreness: 4 / 5", or null when there is nothing to show. */
export function jointSorenessText(w: Workout): string | null {
  if (w.status === 'skipped' || w.ratings?.jointSoreness == null) return null
  return `Joint soreness: ${w.ratings.jointSoreness} / 5`
}

/** One line per muscle that carries any of pump / soreness / workload / recovery. */
export function muscleFeedbackLines(w: Workout, overrides: Record<number, string> | undefined): string[] {
  if (w.status === 'skipped' || !w.muscleFeedback?.length) return []
  const lines: string[] = []
  for (const f of w.muscleFeedback) {
    const parts: string[] = []
    if (f.pump != null) parts.push(`pump ${f.pump}`)
    if (f.soreness != null) parts.push(`soreness ${f.soreness}`)
    if (f.workload != null) parts.push(`workload ${f.workload}`)
    if (f.recovery != null) parts.push(`recovery ${f.recovery}/3`)
    if (parts.length) lines.push(`${muscleGroupName(f.muscleGroupId, overrides)}: ${parts.join(' · ')}`)
  }
  return lines
}

/** The check-in answers for one exercise, or null when it was skipped or not rated. Older logs
 *  carry pump as a bare number and a recovery rating; both still read back. */
export function exerciseFeelText(ex: LoggedExercise): string | null {
  if (ex.skipReason) return null
  const parts = [phaseSummary(ex, 'start'), phaseSummary(ex, 'end')].filter((p): p is string => p != null)
  if (ex.recovery != null) parts.push(`Recovery: ${ex.recovery}/3`)
  return parts.length ? parts.join(' · ') : null
}
