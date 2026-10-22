import type { Workout } from './types'
import { dateOf, localDate } from './dates'

/** Sessions on one local calendar day, earliest first. A deleted row is not a session. */
export function workoutsOnLocalDate(workouts: Workout[], date: string): Workout[] {
  return workouts
    .filter((w) => !w.deleted && w.date === date)
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
}

export interface DayMarker {
  done: number
  skipped: number
  /** Placeholder until planned days are derived; always 0. */
  planned: number
}

/** Per-day session counts keyed by local date. Deleted rows are ignored, and a skipped
 *  session counts as skipped, not done. `from`/`to` (inclusive) limit the days kept. */
export function dayMarkers(workouts: Workout[], opts: { from?: string; to?: string } = {}): Map<string, DayMarker> {
  const markers = new Map<string, DayMarker>()
  for (const w of workouts) {
    if (w.deleted) continue
    const date = dateOf(w)
    if (!date) continue
    if (opts.from !== undefined && date < opts.from) continue
    if (opts.to !== undefined && date > opts.to) continue
    let m = markers.get(date)
    if (!m) markers.set(date, (m = { done: 0, skipped: 0, planned: 0 }))
    if (w.status === 'skipped') m.skipped++
    else m.done++
  }
  return markers
}

/** Days with at least one session actually done. */
export function localDatesWithWorkouts(workouts: Workout[]): Set<string> {
  const dates = new Set<string>()
  for (const [date, m] of dayMarkers(workouts)) if (m.done > 0) dates.add(date)
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
