import type { Workout } from './types'
import { isScoringWorkout } from './records'

export type CoachWindow = 'last' | 'all' | number

export function coachWindow(workouts: Workout[], window: CoachWindow, now = Date.now()): Workout[] {
  const sorted = workouts.filter(isScoringWorkout).sort((a, b) => a.startedAt - b.startedAt)
  if (window === 'all') return sorted
  if (window === 'last') return sorted.slice(-1)
  return sorted.filter((w) => w.startedAt >= now - window * 7 * 864e5)
}
