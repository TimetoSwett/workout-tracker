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

/** Drops keys that are present but `undefined`. A spread merge treats those as real
 *  values and erases what is stored, so a caller that fills a fixed shape — a form that
 *  leaves one field blank, say — would wipe readings it never meant to touch. Clearing a
 *  field is not something any caller asks for, so absent and undefined mean the same
 *  thing here: leave whatever is already on the day alone. */
function defined(m: DailyMetric): DailyMetric {
  return Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined)) as unknown as DailyMetric
}

export function upsertMetric(input: DailyMetric): { added: boolean } {
  const m = defined(input)
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
