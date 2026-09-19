import { getState, setHistory, setSettings } from './store'
import type { Mesocycle, Workout } from './types'
import { dropboxConfigured, dropboxDownload, dropboxUpload } from './dropbox'

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
): { merged: T[]; changedRemote: boolean } {
  const byId = new Map<string, T>()
  for (const item of [...local, ...remote]) {
    const cur = byId.get(item.id)
    if (!cur || (item.updatedAt ?? 0) > (cur.updatedAt ?? 0)) byId.set(item.id, item)
  }
  const merged = [...byId.values()].sort((a, b) => sortKey(a) - sortKey(b))
  const changedRemote =
    remote.length !== merged.length ||
    remote.some((r) => {
      const m = byId.get(r.id)
      return !m || m.updatedAt !== r.updatedAt
    })
  return { merged, changedRemote }
}

let syncing = false

export async function sync(): Promise<string | null> {
  if (syncing) return null
  const { settings, workouts, mesocycles } = getState()
  if (!dropboxConfigured(settings)) return 'Dropbox is not connected'
  syncing = true
  try {
    const [remoteWorkoutsRes, remoteMesosRes] = await Promise.all([
      dropboxDownload(),
      dropboxDownload(MESO_PATH),
    ])
    if (remoteWorkoutsRes.error) return remoteWorkoutsRes.error
    if (remoteMesosRes.error) return remoteMesosRes.error

    const remoteWorkouts = remoteWorkoutsRes.content ? parseJsonl<Workout>(remoteWorkoutsRes.content) : []
    const remoteMesos = remoteMesosRes.content ? parseJsonl<Mesocycle>(remoteMesosRes.content) : []

    const { merged: mergedWorkouts, changedRemote: workoutsChanged } = merge(workouts, remoteWorkouts, (w) => w.startedAt)
    const { merged: mergedMesos, changedRemote: mesosChanged } = merge(mesocycles, remoteMesos, (m) => m.createdAt)

    const uploads: Promise<string | null>[] = []
    if (workoutsChanged) uploads.push(dropboxUpload(toJsonl(mergedWorkouts)))
    if (mesosChanged) uploads.push(dropboxUpload(toJsonl(mergedMesos), MESO_PATH))
    const errs = (await Promise.all(uploads)).filter((e): e is string => !!e)
    if (errs.length) return errs[0]

    setHistory(mergedWorkouts, mergedMesos)
    setSettings({ ...settings, lastSyncAt: Date.now() })
    return null
  } finally {
    syncing = false
  }
}

