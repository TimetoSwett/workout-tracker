import { weightLines } from './legacyWeights'
import type { DailyMetric } from './types'
import { dropboxConfigured, dropboxDownload, dropboxUpload, REVISION_CONFLICT } from './dropbox'
import { getMetrics, setMetrics } from './metricsStore'
import { getState } from './store'
import { convertWeightExact } from './units'
import type { WireMetric } from './weightWire'
import { decodeMetric, encodeMetric, hasUntaggedRecords, LEGACY_UNITS_ERROR } from './weightWire'

const METRICS_PATH = '/metrics.jsonl'

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
    const localChanged = () => getMetrics() !== local || getState().settings.units !== units
    for (let attempt = 0; attempt < 3; attempt++) {
      const remote = await dropboxDownload(METRICS_PATH)
      if (remote.error) return remote.error
      // Merge in the existing remote unit; unchanged records retain their raw precision.
      const wireMetrics = remote.content ? weightLines(remote.content).map(({ record }) => record as unknown as WireMetric) : []
      if (hasUntaggedRecords(wireMetrics)) return LEGACY_UNITS_ERROR
      const remoteMetrics = wireMetrics
      const byDate = new Map<string, WireMetric>(local.map(m => [m.date, encodeMetric(m, units)]))
      for (const m of remoteMetrics) {
        const cur = byDate.get(m.date)
        if (!cur) { byDate.set(m.date, m); continue }
        // Keep the remote magnitude/precision when local data is merely a decoded copy.
        const localInRemoteUnit = { ...cur }
        const displayedRemote = decodeMetric(m, units)
        for (const key of ['weight', 'muscle', 'leanMass'] as const) {
          if (localInRemoteUnit[key] != null) localInRemoteUnit[key] = cur[key] === displayedRemote[key] ? m[key] : convertWeightExact(localInRemoteUnit[key]!, units, m.weightUnit!)
        }
        byDate.set(m.date, { ...mergeRecord(localInRemoteUnit, m), weightUnit: m.weightUnit })
      }
      const merged = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
      const changedRemote =
        remoteMetrics.length !== merged.length ||
        remoteMetrics.some((r) => {
          const m = byDate.get(r.date)
          return !m || Object.keys(m).some(key => JSON.stringify(m[key as keyof WireMetric]) !== JSON.stringify(r[key as keyof WireMetric]))
        })
      const decoded = merged.map(m => decodeMetric(m, units))
      if (localChanged()) return 'Local data changed during sync; sync again.'
      if (changedRemote) {
        const err = await dropboxUpload(merged.map(m => JSON.stringify(m)).join('\n') + '\n', METRICS_PATH, remote.rev ?? null)
        if (err === REVISION_CONFLICT) continue
        if (err) return err
      }
      if (localChanged()) return 'Local data changed during sync; sync again.'
      setMetrics(decoded)
      return null
    }
    return REVISION_CONFLICT
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  } finally {
    syncing = false
  }
}
