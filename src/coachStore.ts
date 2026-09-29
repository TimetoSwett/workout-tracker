import type { CoachMemory, CoachThread } from './types'
import { activeTargets, syncFile } from './syncTargets'
import { getState } from './store'

const KEY = 'wt.coach.v1'
const MEMORY_ID = 'memory'

const listeners = new Set<() => void>()

interface CoachData {
  threads: CoachThread[]
  memory: CoachMemory | null
}

function load(): CoachData {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return JSON.parse(raw) as CoachData
  } catch {
  }
  return { threads: [], memory: null }
}

let data: CoachData = load()

function save() {
  localStorage.setItem(KEY, JSON.stringify(data))
  for (const l of listeners) l()
}

export function subscribeCoach(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Live threads only. Tombstones stay in `data.threads` so deletes can propagate through sync. */
export function getThreads(): CoachThread[] {
  return data.threads.filter((t) => !t.deleted)
}

export function getMemory(): CoachMemory | null {
  return data.memory
}

export function upsertThread(t: CoachThread) {
  const i = data.threads.findIndex((x) => x.id === t.id)
  if (i >= 0) data.threads[i] = t
  else data.threads.push(t)
  data.threads.sort((a, b) => b.updatedAt - a.updatedAt)
  save()
}

/**
 * Soft delete. A hard delete is undone by the next sync: the thread still exists in
 * the remote coach.jsonl, and merge-by-id has nothing local to compare it against, so
 * it comes straight back. The tombstone carries a newer updatedAt and wins instead.
 */
export function deleteThread(id: string) {
  const t = data.threads.find((x) => x.id === id)
  if (!t) return
  t.deleted = true
  t.messages = []
  t.updatedAt = Date.now()
  save()
}

export function setMemory(facts: string[]) {
  data.memory = { id: MEMORY_ID, facts, updatedAt: Date.now() }
  save()
}

function parseJsonl(content: string): CoachThread[] {
  const out: CoachThread[] = []
  for (const line of content.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const p = JSON.parse(t)
      if (p.id === MEMORY_ID) continue
      if (p.id && Array.isArray(p.messages)) out.push(p as CoachThread)
    } catch {
    }
  }
  return out
}

function parseMemory(content: string): CoachMemory | null {
  for (const line of content.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const p = JSON.parse(t)
      if (p.id === MEMORY_ID && Array.isArray(p.facts)) return p as CoachMemory
    } catch {
    }
  }
  return null
}

function toJsonl(): string {
  const records: (CoachThread | CoachMemory)[] = [...data.threads]
  if (data.memory) records.push(data.memory)
  return records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '')
}

/** Last-writer-wins by id across the local copy and every target's remote
 *  copy, same rule as workouts/mesocycles/metrics. The single memory record
 *  merges the same way, keyed by its own `updatedAt`. */
function mergeAll(contents: string[]): string {
  const byId = new Map<string, CoachThread>()
  let memory: CoachMemory | null = null
  for (const content of contents) {
    for (const t of parseJsonl(content)) {
      const cur = byId.get(t.id)
      if (!cur || (t.updatedAt ?? 0) > (cur.updatedAt ?? 0)) byId.set(t.id, t)
    }
    const m = parseMemory(content)
    if (m && (!memory || m.updatedAt > memory.updatedAt)) memory = m
  }
  const threads = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  const records: (CoachThread | CoachMemory)[] = [...threads]
  if (memory) records.push(memory)
  return records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '')
}

let syncing = false

export async function syncCoach(): Promise<string | null> {
  if (syncing) return null
  const targets = activeTargets(getState().settings)
  if (!targets.length) return 'No sync target is set up — connect Dropbox or Cloudflare in Settings.'
  syncing = true
  try {
    const { merged, errors } = await syncFile(targets, 'coach', toJsonl(), mergeAll)
    data = { threads: parseJsonl(merged), memory: parseMemory(merged) }
    save()
    return errors.length ? errors.map((e) => `${e.label}: ${e.message}`).join('; ') : null
  } finally {
    syncing = false
  }
}
