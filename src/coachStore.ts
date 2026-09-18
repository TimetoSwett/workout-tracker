import type { CoachMemory, CoachThread } from './types'
import { dropboxDownload, dropboxUpload } from './dropbox'
import { getState } from './store'

const KEY = 'wt.coach.v1'
const COACH_PATH = '/coach.jsonl'
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

export function getThreads(): CoachThread[] {
  return data.threads
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

export function deleteThread(id: string) {
  data.threads = data.threads.filter((t) => t.id !== id)
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

let syncing = false

export async function syncCoach(): Promise<string | null> {
  if (syncing) return null
  const token = getState().settings.dropboxToken
  if (!token) return 'No Dropbox token configured'
  syncing = true
  try {
    const remote = await dropboxDownload(token, COACH_PATH)
    if (remote.error) return remote.error
    const remoteThreads = remote.content ? parseJsonl(remote.content) : []
    const remoteMemory = remote.content ? parseMemory(remote.content) : null

    const byId = new Map<string, CoachThread>()
    for (const t of [...data.threads, ...remoteThreads]) {
      const cur = byId.get(t.id)
      if (!cur || (t.updatedAt ?? 0) > (cur.updatedAt ?? 0)) byId.set(t.id, t)
    }
    const mergedThreads = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)

    let memory = data.memory
    if (remoteMemory && (!memory || remoteMemory.updatedAt > memory.updatedAt)) memory = remoteMemory

    const remoteChanged =
      remoteThreads.length !== mergedThreads.length ||
      remoteThreads.some((r) => byId.get(r.id)?.updatedAt !== r.updatedAt) ||
      (!!remoteMemory && (!memory || remoteMemory.updatedAt !== memory.updatedAt))

    if (remoteChanged) {
      data = { threads: mergedThreads, memory }
      const err = await dropboxUpload(token, toJsonl(), COACH_PATH)
      if (err) return err
    } else if (mergedThreads !== data.threads || memory !== data.memory) {
      data = { threads: mergedThreads, memory }
    }
    save()
    return null
  } finally {
    syncing = false
  }
}
