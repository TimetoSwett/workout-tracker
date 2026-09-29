import type { DailyMetric } from './types'
import { activeTargets, syncFile } from './syncTargets'
import { getMetrics, setMetrics } from './metricsStore'
import { getState } from './store'

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

function mergeAll(contents: string[]): string {
  const byDate = new Map<string, DailyMetric>()
  for (const content of contents) {
    for (const m of parseJsonl(content)) {
      const cur = byDate.get(m.date)
      byDate.set(m.date, cur ? mergeRecord(cur, m) : m)
    }
  }
  return toJsonl([...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)))
}

let syncing = false

export async function syncMetrics(): Promise<string | null> {
  if (syncing) return null
  const targets = activeTargets(getState().settings)
  if (!targets.length) return 'No sync target is set up — connect Dropbox or Cloudflare in Settings.'
  syncing = true
  try {
    const { merged, errors } = await syncFile(targets, 'metrics', toJsonl(getMetrics()), mergeAll)
    setMetrics(parseJsonl(merged))
    return errors.length ? errors.map((e) => `${e.label}: ${e.message}`).join('; ') : null
  } finally {
    syncing = false
  }
}
