import { weightLines } from './legacyWeights'
import { getState, setHistory, setSettings } from './store'
import type { Mesocycle } from './types'
import { dropboxConfigured, dropboxDownload, dropboxUpload, REVISION_CONFLICT } from './dropbox'
import type { WireWorkout } from './weightWire'
import { decodeWorkout, encodeWorkout, hasUntaggedRecords, LEGACY_UNITS_ERROR } from './weightWire'

const MESO_PATH = '/mesocycles.jsonl'

function parseJsonl<T>(content: string): T[] {
  const out: T[] = []
  for (const line of content.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t) as T)
    } catch {
    }
  }
  return out
}

function toJsonl<T>(items: T[]): string {
  return items.map((w) => JSON.stringify(w)).join('\n') + '\n'
}

/**
 * Last-writer-wins by id. Tombstones (`deleted: true`) are kept in the merged
 * result and uploaded, so a delete made on one device propagates to the others
 * instead of being resurrected by a device that still holds the live copy.
 * Callers filter `deleted` at read time (see `liveWorkouts` in store.ts).
 */
function merge<T extends { id: string; updatedAt?: number; deleted?: boolean }>(
  local: T[],
  remote: T[],
  sortKey: (t: T) => number,
  combine: (newer: T, older: T) => T = (newer) => newer,
  differs: (merged: T, remote: T) => boolean = () => false,
): { merged: T[]; changedRemote: boolean } {
  const byId = new Map<string, T>()
  for (const item of [...local, ...remote]) {
    const cur = byId.get(item.id)
    if (!cur) byId.set(item.id, item)
    else if ((item.updatedAt ?? 0) >= (cur.updatedAt ?? 0)) byId.set(item.id, combine(item, cur))
    else byId.set(item.id, combine(cur, item))
  }
  const merged = [...byId.values()].sort((a, b) => sortKey(a) - sortKey(b))
  const changedRemote =
    remote.length !== merged.length ||
    remote.some((r) => {
      const m = byId.get(r.id)
      return !m || m.updatedAt !== r.updatedAt || differs(m, r)
    })
  return { merged, changedRemote }
}

const SCHEDULE_KEYS = ['startDate', 'trainingWeekdays'] as const

/** Newer mesocycle wins, except a schedule field the newer record has no key for at all
 *  (saved by a build that predates it) is kept from the older record. An explicit `null`
 *  is a deliberate clear and is not filled in. */
function mergeMeso(newer: Mesocycle, older: Mesocycle): Mesocycle {
  let out = newer
  for (const k of SCHEDULE_KEYS) {
    if (!(k in newer) && k in older) out = { ...out, [k]: older[k] }
  }
  return out
}

/** True when the merged plan's schedule fields differ from the remote record's. A missing
 *  key and an explicit `null` are different; weekdays compare by value. */
function scheduleDiffers(merged: Mesocycle, remote: Mesocycle): boolean {
  return SCHEDULE_KEYS.some((k) => {
    const m = merged[k]
    const r = remote[k]
    if ((m === undefined) !== (r === undefined)) return true
    return JSON.stringify(m) !== JSON.stringify(r)
  })
}

let syncing = false

export async function sync(): Promise<string | null> {
  if (syncing) return null
  const { settings, workouts, mesocycles } = getState()
  if (!dropboxConfigured(settings)) return 'Dropbox is not connected'
  const localChanged = () => getState().settings.units !== settings.units || getState().workouts !== workouts || getState().mesocycles !== mesocycles
  syncing = true
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const [remoteWorkoutsRes, remoteMesosRes] = await Promise.all([
        dropboxDownload(),
        dropboxDownload(MESO_PATH),
      ])
      if (remoteWorkoutsRes.error) return remoteWorkoutsRes.error
      if (remoteMesosRes.error) return remoteMesosRes.error

      // Merge tagged wire records first, retaining original precision on remote ties.
      const wireWorkouts = remoteWorkoutsRes.content ? weightLines(remoteWorkoutsRes.content).map(({ record }) => record as unknown as WireWorkout) : []
      if (hasUntaggedRecords(wireWorkouts)) return LEGACY_UNITS_ERROR
      const remoteWorkouts = wireWorkouts
      const remoteMesos = remoteMesosRes.content ? parseJsonl<Mesocycle>(remoteMesosRes.content) : []

      const { merged: mergedWorkouts, changedRemote: workoutsChanged } = merge(workouts.map((w) => encodeWorkout(w, settings.units)), remoteWorkouts, (w) => w.startedAt)
      const { merged: mergedMesos, changedRemote: mesosChanged } = merge(mesocycles, remoteMesos, (m) => m.createdAt, mergeMeso, scheduleDiffers)

      // Validate before uploading and never overwrite edits made while a request awaited.
      const decoded = mergedWorkouts.map((w) => decodeWorkout(w, settings.units))
      if (localChanged()) return 'Local data changed during sync; sync again.'
      const uploads: Promise<string | null>[] = []
      if (workoutsChanged) {
        uploads.push(dropboxUpload(toJsonl(mergedWorkouts), undefined, remoteWorkoutsRes.rev ?? null))
      }
      if (mesosChanged) uploads.push(dropboxUpload(toJsonl(mergedMesos), MESO_PATH, remoteMesosRes.rev ?? null))
      const errs = (await Promise.all(uploads)).filter((e): e is string => !!e)
      if (errs.includes(REVISION_CONFLICT)) continue
      if (errs.length) return errs[0]

      if (localChanged()) return 'Local data changed during sync; sync again.'
      setHistory(decoded, mergedMesos)
      setSettings({ ...getState().settings, lastSyncAt: Date.now() })
      return null
    }
    return REVISION_CONFLICT
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  } finally {
    syncing = false
  }
}

