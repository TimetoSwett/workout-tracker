import { getState, setSettings, setWorkouts } from './store'
import type { Workout } from './types'
import { dropboxDownload, dropboxUpload } from './dropbox'

function parseJsonl(content: string): Workout[] {
  const out: Workout[] = []
  for (const line of content.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t) as Workout)
    } catch {
    }
  }
  return out
}

function toJsonl(workouts: Workout[]): string {
  return workouts.map((w) => JSON.stringify(w)).join('\n') + '\n'
}

function merge(local: Workout[], remote: Workout[]): { merged: Workout[]; changedRemote: boolean } {
  const byId = new Map<string, Workout>()
  for (const w of [...local, ...remote]) {
    const cur = byId.get(w.id)
    if (!cur || (w.updatedAt ?? 0) > (cur.updatedAt ?? 0)) byId.set(w.id, w)
  }
  const merged = [...byId.values()].filter((w) => !w.deleted).sort((a, b) => a.startedAt - b.startedAt)
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
  const { settings, workouts } = getState()
  if (!settings.dropboxToken) return 'No Dropbox token configured'
  syncing = true
  try {
    const remote = await dropboxDownload(settings.dropboxToken)
    if (remote.error) return remote.error
    const remoteWorkouts = remote.content ? parseJsonl(remote.content) : []
    const { merged, changedRemote } = merge(workouts, remoteWorkouts)
    if (changedRemote) {
      const err = await dropboxUpload(settings.dropboxToken, toJsonl(merged))
      if (err) return err
    }
    setWorkouts(merged)
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
