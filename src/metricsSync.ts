import type { DailyMetric } from './types'
import { dropboxConfigured, dropboxDownload, dropboxUpload } from './dropbox'
import { getMetrics, setMetrics } from './metricsStore'
import { getState } from './store'

const METRICS_PATH = '/metrics.jsonl'

function parseJsonl(content: string): DailyMetric[] {
  const out: DailyMetric[] = []
  for (const line of content.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const m = JSON.parse(t) as DailyMetric
      if (m.date) out.push(m)
    } catch {
    }
  }
  return out
}

function toJsonl(ms: DailyMetric[]): string {
  return ms.map((m) => JSON.stringify(m)).join('\n') + '\n'
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
    source: newer.source ?? older.source,
    updatedAt: Math.max(a.updatedAt ?? 0, b.updatedAt ?? 0),
  }
}

let syncing = false

export async function syncMetrics(): Promise<string | null> {
  if (syncing) return null
  if (!dropboxConfigured(getState().settings)) return 'Dropbox is not connected'
  syncing = true
  try {
    const local = getMetrics()
    const remote = await dropboxDownload(METRICS_PATH)
    if (remote.error) return remote.error
    const remoteMetrics = remote.content ? parseJsonl(remote.content) : []
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
    if (changedRemote) {
      const err = await dropboxUpload(toJsonl(merged), METRICS_PATH)
      if (err) return err
    }
    setMetrics(merged)
    return null
  } finally {
    syncing = false
  }
}
