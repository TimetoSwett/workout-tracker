import type { Workout } from './types'
import { localDate } from './dates'

/** Sessions on one local calendar day, earliest first. A deleted row is not a session. */
export function workoutsOnLocalDate(workouts: Workout[], date: string): Workout[] {
  return workouts
    .filter((w) => !w.deleted && w.date === date)
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
}

export function localDatesWithWorkouts(workouts: Workout[]): Set<string> {
  const dates = new Set<string>()
  for (const w of workouts) if (!w.deleted && w.date) dates.add(w.date)
  return dates
}

/** Sunday-start grid for a local month. Cells outside the month are the adjacent days. */
export function monthGrid(year: number, monthIndex: number): { date: string; inMonth: boolean }[] {
  const firstWeekday = new Date(year, monthIndex, 1).getDay()
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate()
  const cells: { date: string; inMonth: boolean }[] = []
  for (let i = 0; i < firstWeekday; i++) {
    cells.push({ date: localDate(new Date(year, monthIndex, 1 - (firstWeekday - i))), inMonth: false })
  }
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push({ date: localDate(new Date(year, monthIndex, day)), inMonth: true })
  }
  let next = 1
  while (cells.length % 7 !== 0) {
    cells.push({ date: localDate(new Date(year, monthIndex + 1, next)), inMonth: false })
    next++
  }
  return cells
}

/** Save a past session in place. The id, local date, and start time stay what they were,
 *  so the edit cannot become the workout in progress or land on a different day. */
export function commitPastEdit(original: Workout, draft: Workout, now: number): Workout {
  return { ...draft, id: original.id, date: original.date, startedAt: original.startedAt, updatedAt: now }
}
