import JSZip from 'jszip'
import type { DailyMetric } from './types'
import { getMetrics, setMetrics } from './metricsStore'

export interface ImportResult {
  files: string[]
  days: { added: number; updated: number }
  errors: string[]
}

const KG_TO_LB = 2.2046226

function kgToUnits(kg: number, appUnits: 'lbs' | 'kg'): number {
  const v = appUnits === 'kg' ? kg : kg * KG_TO_LB
  return Math.round(v * 10) / 10
}

function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"'
        i++
      } else inQuotes = !inQuotes
    } else if (c === ',' && !inQuotes) {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}

// Samsung CSVs: line 1 is metadata ("com.samsung.health.weight,7006011,12"),
// line 2 is the header, data from line 3. Rows may carry a trailing empty
// column beyond the header (extra comma) — index-based access stays safe.
function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const lines = text.replace(/^\ufeff/, '').split(/\r?\n/).filter((l) => l.trim())
  if (!lines.length) return { header: [], rows: [] }
  let hi = 0
  while (hi < lines.length) {
    const cells = parseCsvLine(lines[hi]).map((c) => c.trim().toLowerCase())
    if (cells.some((c) => /(^|\.)(start_time|create_time|update_time|day_time|end_time)$/.test(c))) break
    hi++
  }
  if (hi >= lines.length) return { header: [], rows: [] }
  const header = parseCsvLine(lines[hi]).map((h) => h.trim().toLowerCase())
  const rows = lines.slice(hi + 1).map(parseCsvLine)
  return { header, rows }
}

function col(header: string[], ...names: string[]): number {
  for (const n of names) {
    const i = header.indexOf(n)
    if (i >= 0) return i
  }
  return -1
}

function num(v: string | undefined): number | undefined {
  if (v == null) return undefined
  const n = parseFloat(v)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

function toDate(v: string | undefined): string | undefined {
  if (!v) return undefined
  const m = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  if (/^\d{10,13}$/.test(v)) {
    const ms = v.length === 10 ? parseInt(v) * 1000 : parseInt(v)
    const d = new Date(ms)
    return isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10)
  }
  return undefined
}

function toEpoch(v: string | undefined): number {
  if (!v) return Date.now()
  const t = Date.parse(v.trim().replace(' ', 'T'))
  return Number.isFinite(t) ? t : Date.now()
}

function avg(nums: number[]): number | undefined {
  if (!nums.length) return undefined
  return Math.round((nums.reduce((s, n) => s + n, 0) / nums.length) * 10) / 10
}

interface ParsedDay {
  date: string
  weight?: number
  bodyFat?: number
  muscle?: number
  leanMass?: number
  steps?: number
  sleepMin?: number
  updatedAt: number
  source: DailyMetric['source']
}

// weight is in kg; *_mass columns in kg; bare-name columns (body_fat,
// skeletal_muscle, fat_free) are percentages. Multiple weigh-ins per day
// are averaged into one daily record.
function importWeightCsv(text: string, appUnits: 'lbs' | 'kg'): ParsedDay[] {
  const { header, rows } = parseCsv(text)
  const dI = col(header, 'start_time')
  const uI = col(header, 'update_time')
  const wI = col(header, 'weight')
  const bfI = col(header, 'body_fat')
  const smI = col(header, 'skeletal_muscle_mass')
  const ffI = col(header, 'fat_free_mass')
  if (dI < 0 || wI < 0) return []
  const byDay = new Map<
    string,
    { w: number[]; bf: number[]; sm: number[]; ff: number[]; updatedAt: number }
  >()
  for (const r of rows) {
    const date = toDate(r[dI])
    const kg = num(r[wI])
    if (!date || kg == null || kg < 20 || kg > 400) continue
    const g = byDay.get(date) ?? { w: [], bf: [], sm: [], ff: [], updatedAt: 0 }
    g.w.push(kgToUnits(kg, appUnits))
    const bf = num(r[bfI])
    if (bf != null && bf > 0 && bf < 70) g.bf.push(bf)
    const sm = num(r[smI])
    if (sm != null && sm > 0) g.sm.push(kgToUnits(sm, appUnits))
    const ff = num(r[ffI])
    if (ff != null && ff > 0) g.ff.push(kgToUnits(ff, appUnits))
    g.updatedAt = Math.max(g.updatedAt, toEpoch(r[uI]))
    byDay.set(date, g)
  }
  return [...byDay.entries()].map(([date, g]) => ({
    date,
    weight: avg(g.w),
    bodyFat: avg(g.bf),
    muscle: avg(g.sm),
    leanMass: avg(g.ff),
    updatedAt: g.updatedAt || Date.now(),
    source: 'samsung' as const,
  }))
}

function importStepsCsv(text: string): ParsedDay[] {
  const { header, rows } = parseCsv(text)
  const dI = col(header, 'day_time')
  const cI = col(header, 'count')
  const uI = col(header, 'update_time')
  if (dI < 0 || cI < 0) return []
  const out: ParsedDay[] = []
  const seen = new Map<string, ParsedDay>()
  for (const r of rows) {
    const date = toDate(r[dI])
    const steps = num(r[cI])
    if (!date || steps == null) continue
    // multiple rows per day (phone + watch sources, partial syncs) — keep the max
    const cur = seen.get(date)
    if (!cur || (cur.steps ?? 0) < steps) {
      seen.set(date, { date, steps: Math.round(steps), updatedAt: toEpoch(r[uI]), source: 'samsung' })
    }
  }
  out.push(...seen.values())
  return out
}

// Sleep sessions: sleep_duration is minutes (verified against end-start);
// rows missing it get the duration computed from the timestamps. Sessions
// are attributed to the wake-up date; the longest session wins the day.
function importSleepCsv(text: string): ParsedDay[] {
  const { header, rows } = parseCsv(text)
  const sI = col(header, 'com.samsung.health.sleep.start_time', 'start_time')
  const eI = col(header, 'com.samsung.health.sleep.end_time', 'end_time')
  const durI = col(header, 'sleep_duration')
  const uI = col(header, 'com.samsung.health.sleep.update_time', 'update_time')
  if (eI < 0 || sI < 0) return []
  const byDay = new Map<string, ParsedDay>()
  for (const r of rows) {
    const date = toDate(r[eI])
    if (!date) continue
    let min = num(r[durI])
    if (min == null) {
      const s = Date.parse(r[sI].replace(' ', 'T'))
      const e = Date.parse(r[eI].replace(' ', 'T'))
      if (Number.isFinite(s) && Number.isFinite(e)) min = (e - s) / 60000
    }
    if (min == null || min < 30 || min > 16 * 60) continue
    const cur = byDay.get(date)
    if (!cur || (cur.sleepMin ?? 0) < min) {
      byDay.set(date, { date, sleepMin: Math.round(min), updatedAt: toEpoch(r[uI]), source: 'samsung' })
    }
  }
  return [...byDay.values()]
}

// Classify by filename prefix — never exact names (timestamps change per
// export). Raw/high-frequency duplicates are excluded: pedometer bins,
// sleep_stage, sleep_raw_data, sleep_combined, stress histograms.
function classify(base: string): 'weight' | 'steps' | 'sleep' | null {
  const b = base.toLowerCase()
  if (/pedometer|sleep_stage|sleep_raw|sleep_combined|histogram|alerted/.test(b)) return null
  if (b.startsWith('com.samsung.health.weight.')) return 'weight'
  if (b.includes('step_daily_trend')) return 'steps'
  if (b.startsWith('com.samsung.shealth.sleep.')) return 'sleep'
  return null
}


/**
 * A re-import is authoritative for the fields it carries. Timestamp-based merging is
 * wrong here: the parsed updatedAt comes from the CSV's update_time (when Samsung
 * recorded the day), while a previous import stamped its rows with the moment the
 * import ran — which is always later. That made a corrected re-import lose to the
 * values it was meant to replace. Freshly parsed fields now win outright, and the
 * row is stamped now so it also beats a stale copy in Dropbox on the next sync.
 */
function apply(days: ParsedDay[], counts: { added: number; updated: number }) {
  if (!days.length) return
  const now = Date.now()
  const byDate = new Map(getMetrics().map((m) => [m.date, m]))
  for (const d of days) {
    const existing = byDate.get(d.date)
    if (existing) {
      byDate.set(d.date, {
        date: d.date,
        weight: d.weight ?? existing.weight,
        bodyFat: d.bodyFat ?? existing.bodyFat,
        muscle: d.muscle ?? existing.muscle,
        leanMass: d.leanMass ?? existing.leanMass,
        steps: d.steps ?? existing.steps,
        sleepMin: d.sleepMin ?? existing.sleepMin,
        source: d.source ?? existing.source,
        updatedAt: now,
      })
      counts.updated++
    } else {
      byDate.set(d.date, { ...d, updatedAt: now })
      counts.added++
    }
  }
  setMetrics([...byDate.values()]) // single batched write for the whole import
}

export async function importSamsungHealth(files: File[], appUnits: 'lbs' | 'kg'): Promise<ImportResult> {
  const result: ImportResult = { files: [], days: { added: 0, updated: 0 }, errors: [] }
  const entries: { name: string; text: string }[] = []

  for (const file of files) {
    try {
      if (file.name.toLowerCase().endsWith('.zip')) {
        const zip = await JSZip.loadAsync(file)
        for (const [name, z] of Object.entries(zip.files)) {
          if (z.dir) continue
          const base = name.split('/').pop() ?? name
          if (!/\.csv$/i.test(base)) continue // skips jsons/ sidecar bulk (SpO2, HRV binning, etc.)
          entries.push({ name: base, text: await z.async('string') })
        }
      } else if (/\.csv$/i.test(file.name)) {
        entries.push({ name: file.name, text: await file.text() })
      }
    } catch (e) {
      result.errors.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const allDays: ParsedDay[] = []
  for (const e of entries) {
    try {
      const kind = classify(e.name)
      if (!kind) continue
      const days =
        kind === 'weight'
          ? importWeightCsv(e.text, appUnits)
          : kind === 'steps'
            ? importStepsCsv(e.text)
            : importSleepCsv(e.text)
      allDays.push(...days)
      result.files.push(e.name)
    } catch (err) {
      result.errors.push(`${e.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  apply(allDays, result.days)
  return result
}
