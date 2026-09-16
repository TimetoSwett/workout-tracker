import JSZip from 'jszip'
import type { DailyMetric } from './types'
import { getMetrics, upsertMetric } from './metricsStore'

export interface ImportResult {
  files: string[]
  days: { added: number; updated: number }
  errors: string[]
}

const KG_TO_LB = 2.2046226

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

function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'))
  if (!lines.length) return { header: [], rows: [] }
  // Samsung CSVs sometimes start with a metadata line before the header
  let start = 0
  if (!lines[0].toLowerCase().includes('date') && lines[1]?.toLowerCase().includes('date')) start = 1
  const header = parseCsvLine(lines[start]).map((h) => h.trim().toLowerCase())
  const rows = lines.slice(start + 1).map(parseCsvLine)
  return { header, rows }
}

function col(header: string[], ...names: string[]): number {
  for (const n of names) {
    const i = header.findIndex((h) => h === n)
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
  // Accept YYYY-MM-DD, YYYY-MM-DD HH:MM:SS, YYYYMMDD, unix seconds/ms
  let m = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  m = v.match(/^(\d{4})(\d{2})(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  if (/^\d{10,13}$/.test(v)) {
    const ms = v.length === 10 ? parseInt(v) * 1000 : parseInt(v)
    const d = new Date(ms)
    return isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10)
  }
  return undefined
}

function unitsToLb(v: number | undefined, unit: string | undefined, appUnits: 'lbs' | 'kg'): number | undefined {
  if (v == null) return undefined
  if (unit === 'kg' || unit === 'kilograms') v = v * KG_TO_LB
  if (appUnits === 'kg' && (unit === 'lbs' || unit === 'pounds' || !unit)) v = v / KG_TO_LB
  return Math.round(v * 10) / 10
}

interface ParsedDay {
  date: string
  weight?: number
  bodyFat?: number
  muscle?: number
  steps?: number
  sleepMin?: number
}

function importWeightCsv(text: string, appUnits: 'lbs' | 'kg'): ParsedDay[] {
  const { header, rows } = parseCsv(text)
  const dI = col(header, 'start_time', 'create_date', 'create_time', 'date', 'day_date')
  const wI = col(header, 'weight', 'weight_kg', 'weight_lb', 'weight_lbs')
  const bfI = col(header, 'body_fat', 'bodyfat', 'fat', 'body_fat_%')
  const muI = col(header, 'skeletal_muscle', 'muscle_mass', 'muscle', 'skeletal_muscle_mass')
  const uI = col(header, 'unit', 'weight_unit')
  if (dI < 0 || wI < 0) return []
  const out: ParsedDay[] = []
  for (const r of rows) {
    const date = toDate(r[dI])
    const weight = unitsToLb(num(r[wI]), r[uI]?.trim().toLowerCase(), appUnits)
    if (!date || weight == null) continue
    const bf = num(r[bfI])
    const mu = num(r[muI])
    out.push({ date, weight, bodyFat: bf != null && bf < 70 ? Math.round(bf * 10) / 10 : undefined, muscle: mu })
  }
  return out
}

function importStepsCsv(text: string): ParsedDay[] {
  const { header, rows } = parseCsv(text)
  const dI = col(header, 'start_time', 'create_date', 'create_time', 'date', 'day_date')
  const sI = col(header, 'step_count', 'steps', 'count')
  if (dI < 0 || sI < 0) return []
  const byDay = new Map<string, number>()
  for (const r of rows) {
    const date = toDate(r[dI])
    const steps = num(r[sI])
    if (!date || steps == null) continue
    byDay.set(date, (byDay.get(date) ?? 0) + steps) // hourly bins may repeat a day
  }
  return [...byDay.entries()].map(([date, steps]) => ({ date, steps: Math.round(steps) }))
}

function importSleepCsv(text: string): ParsedDay[] {
  const { header, rows } = parseCsv(text)
  // sleep_stage or sleep data: either duration in minutes or start/end timestamps
  const dI = col(header, 'start_time', 'create_date', 'create_time', 'date', 'day_date')
  const durI = col(header, 'sleep_duration', 'duration', 'total_sleep_time', 'sleep_time', 'time_in_bed')
  const eI = col(header, 'end_time', 'update_time')
  if (dI < 0) return []
  const byDay = new Map<string, number>()
  for (const r of rows) {
    const start = r[dI]
    const date = toDate(start)
    if (!date) continue
    let min: number | undefined
    if (durI >= 0) {
      const v = num(r[durI])
      if (v != null) min = v > 100000 ? v / 60000 : v <= 24 ? v * 60 : v
    } else if (eI >= 0 && /^\d{10,13}$/.test(r[eI] ?? '')) {
      const s = start.match(/^\d{10,13}$/) ? (start.length === 10 ? parseInt(start) * 1000 : parseInt(start)) : Date.parse(start)
      const e = r[eI].length === 10 ? parseInt(r[eI]) * 1000 : parseInt(r[eI])
      if (Number.isFinite(s) && Number.isFinite(e)) min = Math.round((e - s) / 60000)
    }
    if (min == null || min < 60 || min > 16 * 60) continue
    byDay.set(date, byDay.has(date) ? Math.max(byDay.get(date)!, min) : min)
  }
  return [...byDay.entries()].map(([date, sleepMin]) => ({ date, sleepMin }))
}

function apply(days: ParsedDay[], source: DailyMetric['source'], counts: { added: number; updated: number }) {
  const now = Date.now()
  for (const d of days) {
    const existing = getMetrics().find((m) => m.date === d.date)
    const res = upsertMetric({
      date: d.date,
      weight: d.weight ?? existing?.weight,
      bodyFat: d.bodyFat ?? existing?.bodyFat,
      muscle: d.muscle ?? existing?.muscle,
      steps: d.steps ?? existing?.steps,
      sleepMin: d.sleepMin ?? existing?.sleepMin,
      updatedAt: now,
      source,
    })
    if (res.added) counts.added++
    else counts.updated++
  }
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
          if (!/\.csv$/i.test(base)) continue
          entries.push({ name: base, text: await z.async('string') })
        }
      } else if (/\.csv$/i.test(file.name)) {
        entries.push({ name: file.name, text: await file.text() })
      } else if (/\.json$/i.test(file.name)) {
        result.errors.push(`${file.name}: JSON not supported — export as CSV from Samsung Health`)
      }
    } catch (e) {
      result.errors.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  for (const e of entries) {
    const n = e.name.toLowerCase()
    try {
      if (n.includes('weight')) {
        apply(importWeightCsv(e.text, appUnits), 'samsung', result.days)
        result.files.push(e.name)
      } else if (n.includes('step')) {
        apply(importStepsCsv(e.text), 'samsung', result.days)
        result.files.push(e.name)
      } else if (n.includes('sleep')) {
        apply(importSleepCsv(e.text), 'samsung', result.days)
        result.files.push(e.name)
      }
    } catch (err) {
      result.errors.push(`${e.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return result
}
