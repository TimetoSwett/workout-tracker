import type { Workout } from './types'
import { isScoringWorkout } from './records'

export type CoachWindow = 'last' | 'all' | number

export function coachEmptyMessage(workouts: Workout[], window: CoachWindow): string {
  return !workouts.some(isScoringWorkout) || typeof window !== 'number'
    ? 'No workouts logged yet — log a session, or import your RP history from the Plan tab.'
    : `No workouts in the last ${window} weeks. Log a session or ask a question directly instead.`
}

export function coachWindow(workouts: Workout[], window: CoachWindow, now = Date.now()): Workout[] {
  const sorted = workouts.filter(isScoringWorkout).sort((a, b) => a.startedAt - b.startedAt)
  if (window === 'all') return sorted
  if (window === 'last') return sorted.slice(-1)
  return sorted.filter((w) => w.startedAt >= now - window * 7 * 864e5)
}
