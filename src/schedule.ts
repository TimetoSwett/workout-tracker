import type { Mesocycle, Workout } from './types'
import { addDays, compareLocalDates, dateOf, isLocalDate, weekdayOf } from './dates'
import { dayMarkers } from './calendar'

/** One session the plan expects, placed on a local calendar day. */
export interface PlannedSession {
  /** Local `YYYY-MM-DD`. */
  date: string
  /** 0-based week of the meso, same numbering as `mesoPosition`. */
  week: number
  /** Index into `meso.days`. */
  dayIndex: number
  /** 0-based position in the meso's session sequence: week = floor(slot / days), day = slot % days. */
  slot: number
  label?: string
}

/** True for a non-empty list of distinct weekdays (0 = Sunday .. 6), ascending. */
export function isValidTrainingWeekdays(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((n, i) => Number.isInteger(n) && n >= 0 && n <= 6 && (i === 0 || n > v[i - 1]))
  )
}

/** The sessions a plan still expects, computed on the fly from the plan and the log.
 *
 *  Slots already logged against the meso (done or skipped, not deleted) are used up, exactly
 *  as `mesoPosition` counts them. The remaining slots go on the next `trainingWeekdays` on or
 *  after the later of `today` and `startDate`, one per training day, in order. A training day
 *  that already has a logged workout (done or skipped) for this meso is skipped. A planned day
 *  that passes unlogged is not overdue: its slot simply moves to the next training day.
 *  Nothing is planned past the meso's last slot, for a finished or deleted meso, or when
 *  `startDate`/`trainingWeekdays` are missing or invalid. `from`/`to` (inclusive) and `limit`
 *  narrow the result. */
export function plannedSessions(
  meso: Mesocycle,
  workouts: Workout[],
  opts: { today: string; from?: string; to?: string; limit?: number },
): PlannedSession[] {
  const { today, from, to, limit } = opts
  const { startDate, trainingWeekdays } = meso
  if (meso.deleted || meso.status === 'complete') return []
  if (!isLocalDate(today) || typeof startDate !== 'string' || !isLocalDate(startDate)) return []
  if (!isValidTrainingWeekdays(trainingWeekdays)) return []
  const daysPerWeek = meso.days.length
  if (daysPerWeek < 1 || !Number.isFinite(meso.weeksPlanned)) return []
  if (limit !== undefined && limit <= 0) return []

  const total = Math.max(1, Math.floor(meso.weeksPlanned)) * daysPerWeek
  let slot = workouts.filter((w) => w.mesoId === meso.id && !w.deleted).length
  if (slot >= total) return []

  const weekdays = new Set(trainingWeekdays)
  const taken = new Set<string>()
  for (const w of workouts) {
    if (w.mesoId !== meso.id || w.deleted) continue
    const d = dateOf(w)
    if (d) taken.add(d)
  }
  const out: PlannedSession[] = []
  let date = compareLocalDates(startDate, today) > 0 ? startDate : today
  // Every 7 days holds at least one training weekday, so this bounds the walk.
  for (let guard = (total - slot) * 7 + 7; guard > 0 && slot < total; guard--, date = addDays(date, 1)) {
    if (to !== undefined && compareLocalDates(date, to) > 0) break
    if (!weekdays.has(weekdayOf(date)) || taken.has(date)) continue
    const dayIndex = slot % daysPerWeek
    if (from === undefined || compareLocalDates(date, from) >= 0) {
      out.push({ date, week: Math.floor(slot / daysPerWeek), dayIndex, slot, label: meso.days[dayIndex]?.label })
      if (limit !== undefined && out.length >= limit) break
    }
    slot++
  }
  return out
}

/** Planned sessions of `meso` between `from` and `to` (inclusive). No plan, or one without a
 *  usable schedule, plans nothing. Days before `today` never hold a plan: unlogged days slide. */
export function plannedForRange(
  meso: Mesocycle | null | undefined,
  workouts: Workout[],
  today: string,
  from: string,
  to: string,
): PlannedSession[] {
  if (!meso || compareLocalDates(from, to) > 0) return []
  return plannedSessions(meso, workouts, { today, from, to })
}

/** A planned session can be started once its day has come; later days are read-only. */
export function canStartPlanned(date: string, today: string): boolean {
  return isLocalDate(date) && isLocalDate(today) && compareLocalDates(date, today) <= 0
}

export interface UpcomingDay {
  date: string
  planned: PlannedSession[]
  done: number
  skipped: number
}

/** `count` days from `today` on (default 7: today..today+6), each with its planned sessions
 *  and what is already logged that day. */
export function nextDays(
  meso: Mesocycle | null | undefined,
  workouts: Workout[],
  today: string,
  count = 7,
): UpcomingDay[] {
  if (!isLocalDate(today) || count < 1) return []
  const last = addDays(today, count - 1)
  const planned = plannedForRange(meso, workouts, today, today, last)
  const markers = dayMarkers(workouts, { from: today, to: last })
  const out: UpcomingDay[] = []
  for (let i = 0; i < count; i++) {
    const date = addDays(today, i)
    const m = markers.get(date)
    out.push({ date, planned: planned.filter((p) => p.date === date), done: m?.done ?? 0, skipped: m?.skipped ?? 0 })
  }
  return out
}
