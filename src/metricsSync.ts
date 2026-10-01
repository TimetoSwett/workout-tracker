import type { DailyMetric } from './types'
import { dropboxConfigured, dropboxDownload, dropboxUpload } from './dropbox'
import { getMetrics, setMetrics } from './metricsStore'
import { getState } from './store'
import type { Units } from './units'
import type { WireMetric } from './weightWire'
import { decodeMetric, encodeMetric, hasUntaggedRecords } from './weightWire'

const METRICS_PATH = '/metrics.jsonl'

function parseJsonl(content: string): WireMetric[] {
  const out: WireMetric[] = []
  for (const line of content.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const m = JSON.parse(t) as WireMetric
      if (m.date) out.push(m)
    } catch {
    }
  }
  return out
}

function toJsonl(ms: DailyMetric[], local: Units): string {
  return ms.map((m) => JSON.stringify(encodeMetric(m, local))).join('\n') + '\n'
}

function mergeRecord(a: DailyMetric, b: DailyMetric): DailyMetric {
  const [newer, older] = (b.updatedAt ?? 0) >= (a.updatedAt ?? 0) ? [b, a] : [a, b]
  return {
    date: a.date,
    weight: newer.weight ?? older.weight,
    bodyFat: newer.bodyFat ?? older.bodyFat,
    muscle: newer.muscle ?? older.muscle,
    leanMass: newer.leanMass ?? older.leanMass,
    steps: newer.steps ?? older.steps,
    sleepMin: newer.sleepMin ?? older.sleepMin,
    restingHr: newer.restingHr ?? older.restingHr,
    calories: newer.calories ?? older.calories,
    proteinG: newer.proteinG ?? older.proteinG,
    carbsG: newer.carbsG ?? older.carbsG,
    fatG: newer.fatG ?? older.fatG,
    source: newer.source ?? older.source,
    updatedAt: Math.max(a.updatedAt ?? 0, b.updatedAt ?? 0),
  }
}

let syncing = false

export async function syncMetrics(): Promise<string | null> {
  if (syncing) return null
  const units = getState().settings.units
  if (!dropboxConfigured(getState().settings)) return 'Dropbox is not connected'
  syncing = true
  try {
    const local = getMetrics()
    const remote = await dropboxDownload(METRICS_PATH)
    if (remote.error) return remote.error
    // As in `sync()`: weights come in tagged with the sending device's unit, and
    // `mergeRecord` picks per-field winners, so they have to be in this device's unit
    // before they are merged with anything local.
    const wireMetrics = remote.content ? parseJsonl(remote.content) : []
    const remoteMetrics = wireMetrics.map((m) => decodeMetric(m, units))
    const byDate = new Map<string, DailyMetric>()
    for (const m of [...local, ...remoteMetrics]) {
      const cur = byDate.get(m.date)
      byDate.set(m.date, cur ? mergeRecord(cur, m) : m)
    }
    const merged = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
    const changedRemote =
      remoteMetrics.length !== merged.length ||
      remoteMetrics.some((r) => {
        const m = byDate.get(r.date)
        return !m || m.updatedAt !== r.updatedAt
      })
    if (changedRemote || hasUntaggedRecords(wireMetrics)) {
      const err = await dropboxUpload(toJsonl(merged, units), METRICS_PATH)
      if (err) return err
    }
    setMetrics(merged)
    return null
  } finally {
    syncing = false
  }
}
