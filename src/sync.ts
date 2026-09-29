import { getState, setHistory, setSettings } from './store'
import type { Mesocycle, Workout } from './types'
import { activeTargets, syncFile, type SyncTarget, type TargetError } from './syncTargets'

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
 * Last-writer-wins by id across the local copy and every target's remote
 * copy. Tombstones (`deleted: true`) are kept in the merged result and
 * uploaded, so a delete made on one device propagates to the others instead
 * of being resurrected by a device that still holds the live copy. Callers
 * filter `deleted` at read time (see `liveWorkouts` in store.ts).
 */
function mergeAll<T extends { id: string; updatedAt?: number; deleted?: boolean }>(
  contents: string[],
  sortKey: (t: T) => number,
): string {
  const byId = new Map<string, T>()
  for (const content of contents) {
    for (const item of parseJsonl<T>(content)) {
      const cur = byId.get(item.id)
      if (!cur || (item.updatedAt ?? 0) > (cur.updatedAt ?? 0)) byId.set(item.id, item)
    }
  }
  return toJsonl([...byId.values()].sort((a, b) => sortKey(a) - sortKey(b)))
}

/** Records each target's own last-sync time and error independently, so a
 *  broken Cloudflare setup doesn't clobber a healthy Dropbox status or vice
 *  versa. Only touches fields for targets that were actually attempted. */
function applyOutcome(targets: SyncTarget[], errors: TargetError[]) {
  const settings = getState().settings
  const next = { ...settings }
  for (const target of targets) {
    const err = errors.find((e) => e.targetId === target.id)
    if (target.id === 'dropbox') {
      if (!err) next.lastSyncAt = Date.now()
    } else if (target.id === 'cloudflare') {
      next.cloudflareLastError = err?.message
      if (!err) next.cloudflareLastSyncAt = Date.now()
    }
  }
  setSettings(next)
}

let syncing = false

export async function sync(): Promise<string | null> {
  if (syncing) return null
  const { settings, workouts, mesocycles } = getState()
  const targets = activeTargets(settings)
  if (!targets.length) return 'No sync target is set up — connect Dropbox or Cloudflare in Settings.'
  syncing = true
  try {
    const [w, m] = await Promise.all([
      syncFile(targets, 'workouts', toJsonl(workouts), (contents) => mergeAll<Workout>(contents, (x) => x.startedAt)),
      syncFile(targets, 'mesocycles', toJsonl(mesocycles), (contents) => mergeAll<Mesocycle>(contents, (x) => x.createdAt)),
    ])

    setHistory(parseJsonl<Workout>(w.merged), parseJsonl<Mesocycle>(m.merged))
    const errors = [...w.errors, ...m.errors]
    applyOutcome(targets, errors)
    return errors.length ? errors.map((e) => `${e.label}: ${e.message}`).join('; ') : null
  } finally {
    syncing = false
  }
}
