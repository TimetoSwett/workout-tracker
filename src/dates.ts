/** Every `date` this app stores — on a workout, on a daily metric, on an imported row —
 *  is a *local* calendar day, and the Health Connect plugin buckets its readings by
 *  `ZoneId.systemDefault()`. `Date#toISOString().slice(0, 10)` is the **UTC** day, which
 *  is tomorrow for an evening session anywhere west of Greenwich, so it must not be used
 *  to derive one of these keys. Use the helpers here instead. */

/** The local calendar day of `d` as `YYYY-MM-DD`. */
export function localDate(d: Date = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** The local calendar day `days` before `from`. Steps by calendar date rather than by
 *  `days * 864e5` so a DST boundary in the window can't shift the result by a day. */
export function localDateDaysAgo(days: number, from: Date = new Date()): string {
  const d = new Date(from)
  d.setDate(d.getDate() - days)
  return localDate(d)
}

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** `s` as local midnight, or null unless it is a real `YYYY-MM-DD` day (so `2026-02-30` is null). */
export function parseLocalDate(s: string): Date | null {
  const m = typeof s === 'string' ? LOCAL_DATE.exec(s) : null
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const date = new Date(y, mo - 1, d)
  date.setFullYear(y) // years 0–99 would otherwise map to 1900–1999
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? date : null
}

export function isLocalDate(s: string): boolean {
  return parseLocalDate(s) !== null
}

/** The local day `n` calendar days after `date` (negative `n` goes back). Steps by calendar
 *  date, so a DST boundary can't shift the result. Throws on an invalid `date`. */
export function addDays(date: string, n: number): string {
  const d = parseLocalDate(date)
  if (!d) throw new RangeError(`Invalid local date: ${date}`)
  return localDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n))
}

/** Day of the week for a local date, 0 = Sunday. Throws on an invalid `date`. */
export function weekdayOf(date: string): number {
  const d = parseLocalDate(date)
  if (!d) throw new RangeError(`Invalid local date: ${date}`)
  return d.getDay()
}

/** Orders two `YYYY-MM-DD` strings: negative if `a` is earlier, 0 if equal, positive if later. */
export function compareLocalDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Every local day from `from` to `to`, inclusive. Empty if either is invalid or `to` is before `from`. */
export function dateRange(from: string, to: string): string[] {
  if (!isLocalDate(from) || !isLocalDate(to) || compareLocalDates(from, to) > 0) return []
  const days: string[] = []
  for (let d = from; ; d = addDays(d, 1)) {
    days.push(d)
    if (d === to) return days
  }
}

/** The local day a workout belongs to: its stored `date` if valid, else the local day of
 *  `startedAt`, else undefined. Never mutates `w`. */
export function dateOf(w: { date?: string; startedAt?: number }): string | undefined {
  if (typeof w.date === 'string' && isLocalDate(w.date)) return w.date
  if (typeof w.startedAt === 'number' && Number.isFinite(w.startedAt)) {
    const d = new Date(w.startedAt)
    if (!Number.isNaN(d.getTime())) return localDate(d)
  }
  return undefined
}
