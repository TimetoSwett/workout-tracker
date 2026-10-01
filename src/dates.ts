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
