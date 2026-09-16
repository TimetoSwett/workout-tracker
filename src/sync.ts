import { getState, setHistory, setSettings } from './store'
import type { Mesocycle, Workout } from './types'
import { dropboxDownload, dropboxUpload } from './dropbox'

const CONTENT_API = 'https://content.dropboxapi.com/2'
const MESO_PATH = '/mesocycles.jsonl'

/**
 * Mirrors dropbox.ts's download/upload but parameterized by path, kept local
 * to this file rather than generalizing dropbox.ts (owned by the parallel
 * health/nutrition work's own metrics.jsonl sync) to avoid a merge conflict.
 */
async function downloadPath(token: string, path: string): Promise<{ content: string | null; error?: string }> {
  try {
    const res = await fetch(`${CONTENT_API}/files/download`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': JSON.stringify({ path }) },
    })
    if (res.status === 409) return { content: null }
    if (!res.ok) {
      if (res.status === 401) return { content: null, error: 'Dropbox rejected the token (401). Generate a new one in the Dropbox App Console.' }
      return { content: null, error: `Download failed (${res.status})` }
    }
    return { content: await res.text() }
  } catch (e) {
    return { content: null, error: `Network error: ${e instanceof Error ? e.message : String(e)}` }
  }
}

async function uploadPath(token: string, path: string, content: string): Promise<string | null> {
  try {
    const res = await fetch(`${CONTENT_API}/files/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Dropbox-API-Arg': JSON.stringify({ path, mode: 'overwrite', mute: true }),
        'Content-Type': 'application/octet-stream',
      },
      body: content,
    })
    if (!res.ok) {
      if (res.status === 401) return 'Dropbox rejected the token (401). Generate a new one in the Dropbox App Console.'
      return `Upload failed (${res.status})`
    }
    return null
  } catch (e) {
    return `Network error: ${e instanceof Error ? e.message : String(e)}`
  }
}

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
  const merged = [...byId.values()].filter((item) => !item.deleted).sort((a, b) => sortKey(a) - sortKey(b))
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
  if (!settings.dropboxToken) return 'No Dropbox token configured'
  syncing = true
  try {
    const [remoteWorkoutsRes, remoteMesosRes] = await Promise.all([
      dropboxDownload(settings.dropboxToken),
      downloadPath(settings.dropboxToken, MESO_PATH),
    ])
    if (remoteWorkoutsRes.error) return remoteWorkoutsRes.error
    if (remoteMesosRes.error) return remoteMesosRes.error

    const remoteWorkouts = remoteWorkoutsRes.content ? parseJsonl<Workout>(remoteWorkoutsRes.content) : []
    const remoteMesos = remoteMesosRes.content ? parseJsonl<Mesocycle>(remoteMesosRes.content) : []

    const { merged: mergedWorkouts, changedRemote: workoutsChanged } = merge(workouts, remoteWorkouts, (w) => w.startedAt)
    const { merged: mergedMesos, changedRemote: mesosChanged } = merge(mesocycles, remoteMesos, (m) => m.createdAt)

    const uploads: Promise<string | null>[] = []
    if (workoutsChanged) uploads.push(dropboxUpload(settings.dropboxToken, toJsonl(mergedWorkouts)))
    if (mesosChanged) uploads.push(uploadPath(settings.dropboxToken, MESO_PATH, toJsonl(mergedMesos)))
    const errs = (await Promise.all(uploads)).filter((e): e is string => !!e)
    if (errs.length) return errs[0]

    setHistory(mergedWorkouts, mergedMesos)
    setSettings({ ...settings, lastSyncAt: Date.now() })
    return null
  } finally {
    syncing = false
  }
}

export async function testToken(token: string): Promise<string | null> {
  const res = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return `Token rejected (${res.status})`
  return null
}
