const KEY = 'wt.metrics.v1'
const listeners = new Set<() => void>()
import type { DailyMetric } from './types'

function load(): DailyMetric[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return JSON.parse(raw) as DailyMetric[]
  } catch {
  }
  return []
}

let metrics: DailyMetric[] = load()

function save() {
  localStorage.setItem(KEY, JSON.stringify(metrics))
  for (const l of listeners) l()
}

export function subscribeMetrics(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function getMetrics(): DailyMetric[] {
  return metrics
}

export function setMetrics(next: DailyMetric[]) {
  metrics = next.sort((a, b) => (a.date < b.date ? -1 : 1))
  save()
}

export function upsertMetric(m: DailyMetric): { added: boolean } {
  const i = metrics.findIndex((x) => x.date === m.date)
  let added = false
  if (i >= 0) {
    const cur = metrics[i]
    if ((m.updatedAt ?? 0) >= (cur.updatedAt ?? 0)) {
      metrics[i] = { ...cur, ...m, updatedAt: m.updatedAt ?? Date.now() }
    } else {
      return { added: false }
    }
  } else {
    metrics.push(m)
    added = true
  }
  metrics.sort((a, b) => (a.date < b.date ? -1 : 1))
  save()
  return { added }
}

export function clearMetrics() {
  metrics = []
  save()
}
