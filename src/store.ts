import { useEffect, useState } from 'preact/hooks'
import * as historyDb from './historyDb'
import type { ActiveWorkout, Mesocycle, Settings, Template, Workout } from './types'

export interface Stored {
  workouts: Workout[]
  mesocycles: Mesocycle[]
  templates: Template[]
  settings: Settings
  active: ActiveWorkout | null
}

const OLD_KEY = 'wt.v1'
const ACTIVE_KEY = 'wt.active.v1'
const HISTORY_KEY = 'wt.history.v1'
const HISTORY_SCHEMA = 1
const DEFAULT_SETTINGS: Settings = { units: 'lbs', restSeconds: 90, philosophy: 'balanced' }

interface ActiveSlice {
  active: ActiveWorkout | null
  templates: Template[]
  settings: Settings
}

interface HistorySlice {
  workouts: Workout[]
  mesocycles: Mesocycle[]
}

const storageErrors = new Map<string, string>()

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function isHistorySlice(v: unknown): v is HistorySlice {
  return isObj(v) && Array.isArray(v.workouts) && Array.isArray(v.mesocycles) && v.workouts.every(isObj) && v.mesocycles.every(isObj)
}

function lsRemove(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    // Harmless: the data is safe in IndexedDB, so the next launch retries the removal.
  }
}

function lsParse(key: string): unknown {
  try {
    const v = localStorage.getItem(key)
    return v ? JSON.parse(v) : null
  } catch {
    return null
  }
}

interface ActiveBoot {
  activeSlice: ActiveSlice
  /** History held by the legacy `wt.v1` key, if that key parsed. */
  legacyHistory: HistorySlice | null
  /** `wt.v1` parsed and its active data is saved under the split key, so the key may go once history is safe. */
  legacyRemovable: boolean
}

/** Synchronous part of boot: the active slice, plus the active half of the `wt.v1` split. History is loaded by `initStore`. */
function bootActive(): ActiveBoot {
  const legacy = lsParse(OLD_KEY)
  const rawActive = lsParse(ACTIVE_KEY)
  // Only a well-formed slice may win over wt.v1; anything else is re-migrated.
  const savedActive =
    isObj(rawActive) && isObj(rawActive.settings) && Array.isArray(rawActive.templates) && rawActive.templates.every(isObj)
      ? (rawActive as unknown as ActiveSlice)
      : null
  const fromSaved = (s: ActiveSlice): ActiveSlice => ({
    active: s.active ?? null,
    templates: s.templates ?? [],
    settings: { ...DEFAULT_SETTINGS, ...s.settings },
  })
  if (!isObj(legacy)) {
    const p = (isObj(rawActive) ? rawActive : {}) as Partial<ActiveSlice>
    return {
      activeSlice: { active: p.active ?? null, templates: p.templates ?? [], settings: { ...DEFAULT_SETTINGS, ...p.settings } },
      legacyHistory: null,
      legacyRemovable: false,
    }
  }
  const p = legacy as Partial<Stored>
  const fromLegacy: ActiveSlice = {
    active: p.active ?? null,
    templates: p.templates ?? [],
    settings: { ...DEFAULT_SETTINGS, ...p.settings },
  }
  // An already-saved split slice holds newer data than wt.v1 (a failed or retried migration): keep it.
  const a: ActiveSlice = savedActive
    ? { ...fromSaved(savedActive), active: 'active' in savedActive ? (savedActive.active ?? null) : fromLegacy.active }
    : fromLegacy
  // Rewrite the active slice if it was missing or lacked `active`, so a recovered legacy workout persists.
  if (!savedActive || !('active' in savedActive)) trySave(ACTIVE_KEY, a)
  return {
    activeSlice: a,
    legacyHistory: {
      workouts: Array.isArray(p.workouts) ? (p.workouts.filter(isObj) as unknown as Workout[]) : [],
      mesocycles: Array.isArray(p.mesocycles) ? (p.mesocycles.filter(isObj) as unknown as Mesocycle[]) : [],
    },
    legacyRemovable: !storageErrors.has(ACTIVE_KEY),
  }
}

const boot = bootActive()
let state: Stored = { ...boot.activeSlice, workouts: [], mesocycles: [] }
const listeners = new Set<() => void>()

/** Set while any key's latest save has failed (usually the quota). In-memory state is still current. */
export function getStorageError(): string | null {
  return storageErrors.get(HISTORY_KEY) ?? storageErrors.values().next().value ?? null
}

function isQuotaError(e: unknown): boolean {
  return e instanceof DOMException && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014)
}

function describeSaveError(e: unknown): string {
  return isQuotaError(e)
    ? 'Browser storage is full, so recent changes are only kept until this tab closes. Sync to Dropbox to keep them.'
    : `Could not save to browser storage: ${e instanceof Error ? e.message : String(e)}`
}

function trySave(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    storageErrors.delete(key)
  } catch (e) {
    storageErrors.set(key, describeSaveError(e))
  }
}

function saveActive() {
  const { active, templates, settings } = state
  trySave(ACTIVE_KEY, { active, templates, settings } satisfies ActiveSlice)
}

function notify() {
  for (const l of listeners) l()
}

// History writes: the latest snapshot is queued and written by one loop, so rapid edits coalesce
// into a single IndexedDB write instead of racing each other.
let historyReady = false
let queued: HistorySlice | null = null
let pumping: Promise<void> | null = null
/** The IndexedDB read failed at startup: the stored history is unknown, so nothing may overwrite it. */
let historyBlocked = false

async function drainQueue(): Promise<void> {
  while (queued) {
    const slice = queued
    queued = null
    const before = storageErrors.get(HISTORY_KEY)
    try {
      await historyDb.set(historyDb.HISTORY_RECORD, { schemaVersion: HISTORY_SCHEMA, ...slice })
      storageErrors.delete(HISTORY_KEY)
    } catch (e) {
      storageErrors.set(HISTORY_KEY, describeSaveError(e))
    }
    if (storageErrors.get(HISTORY_KEY) !== before) notify()
  }
}

function pump(): Promise<void> {
  if (pumping) return pumping
  // `finally` callbacks run in a later microtask, so they cannot clear `pumping` before it is assigned
  // (an idle drain finishes synchronously and used to leave a resolved promise stuck here for good).
  const p: Promise<void> = drainQueue().finally(() => {
    if (pumping === p) pumping = null
    // A change queued after the loop's last check but before this callback still needs a writer.
    if (queued) void pump()
  })
  pumping = p
  return p
}

function saveHistory() {
  // Before initStore() finishes, the loaded history is not in memory yet; writing now would clobber it.
  // After a failed load the stored record is unknown, so it must not be replaced either.
  if (!historyReady || historyBlocked) return
  const { workouts, mesocycles } = state
  queued = { workouts, mesocycles }
  void pump()
}

/** Resolves once every history change made so far has been written (or has failed and been reported). */
export async function flushHistory(): Promise<void> {
  while (pumping || queued) await pump()
}

/** Flushes history and returns the storage error if the history is not safely stored, else null. */
export async function commitHistory(): Promise<string | null> {
  await flushHistory()
  if (historyBlocked) return storageErrors.get(HISTORY_KEY) ?? 'History could not be loaded, so it was not saved.'
  return storageErrors.get(HISTORY_KEY) ?? null
}

function fingerprint(h: HistorySlice): string {
  const sum = (xs: { updatedAt?: number }[]) => xs.reduce((n, x) => n + (Number(x.updatedAt) || 0), 0)
  return JSON.stringify([h.workouts.map((w) => w.id), h.mesocycles.map((m) => m.id), sum(h.workouts), sum(h.mesocycles)])
}

/** Writes `h` to IndexedDB, reads it back and compares counts, ids and updatedAt. Returns an error message on failure. */
async function migrateToIdb(h: HistorySlice): Promise<string | null> {
  try {
    await historyDb.set(historyDb.HISTORY_RECORD, { schemaVersion: HISTORY_SCHEMA, ...h })
    const back = await historyDb.get(historyDb.HISTORY_RECORD)
    if (!isHistorySlice(back) || fingerprint(back) !== fingerprint(h)) {
      // A record that reads back wrong must not win on the next launch over the intact localStorage copy.
      await historyDb.del(historyDb.HISTORY_RECORD).catch(() => undefined)
      return 'Could not verify history after moving it to browser storage; it stays in the old location.'
    }
    return null
  } catch (e) {
    return describeSaveError(e)
  }
}

const READ_ATTEMPTS = 3
const READ_RETRY_MS = 50

let initPromise: Promise<void> | null = null

/** Loads history from IndexedDB, migrating it from localStorage first if needed. Await before reading history or syncing. Never rejects. */
export function initStore(): Promise<void> {
  initPromise ??= loadHistory().catch((e) => {
    storageErrors.set(HISTORY_KEY, describeSaveError(e))
  }).finally(() => {
    historyReady = true
  })
  return initPromise
}

async function loadHistory(): Promise<void> {
  let fromIdb: HistorySlice | null = null
  let readFailed = false
  for (let attempt = 0; ; attempt++) {
    try {
      const rec = await historyDb.get(historyDb.HISTORY_RECORD)
      if (isHistorySlice(rec)) fromIdb = rec
      break
    } catch (e) {
      if (attempt >= READ_ATTEMPTS - 1) {
        readFailed = true
        storageErrors.set(HISTORY_KEY, `Could not read your saved history, so changes to it will not be saved. Restart the app to try again. (${describeSaveError(e)})`)
        break
      }
      await new Promise((r) => setTimeout(r, READ_RETRY_MS * (attempt + 1)))
    }
  }
  if (readFailed) {
    // Show whatever localStorage copy exists, but touch nothing: the IndexedDB record may be intact.
    historyBlocked = true
    const lsCopy = lsParse(HISTORY_KEY)
    const history = isHistorySlice(lsCopy) ? lsCopy : boot.legacyHistory
    if (history) state = { ...state, workouts: history.workouts, mesocycles: history.mesocycles }
    notify()
    return
  }
  const lsRaw = lsParse(HISTORY_KEY)
  const fromLs = isHistorySlice(lsRaw) ? lsRaw : null

  let safe = false
  let history: HistorySlice | null = fromIdb
  if (fromIdb) {
    safe = true
    storageErrors.delete(HISTORY_KEY)
  } else {
    // Precedence: valid IndexedDB record, then wt.history.v1, then wt.v1.
    history = fromLs ?? boot.legacyHistory
    if (history) {
      const err = await migrateToIdb(history)
      if (err) storageErrors.set(HISTORY_KEY, err)
      else {
        safe = true
        storageErrors.delete(HISTORY_KEY)
      }
    }
  }
  if (history) state = { ...state, workouts: history.workouts, mesocycles: history.mesocycles }
  // Remove the old copies only once history is verified in IndexedDB; otherwise keep them and run from memory.
  if (safe) {
    lsRemove(HISTORY_KEY)
    if (boot.legacyRemovable) lsRemove(OLD_KEY)
  }
  notify()
}

function emit(changed: { active?: boolean; history?: boolean }) {
  if (changed.active) saveActive()
  if (changed.history) saveHistory()
  notify()
}

export function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

let liveCacheSrc: Stored | null = null
let liveCache: Stored = state

/** `state` with tombstoned (`deleted: true`) workouts and mesocycles removed. Cached per state identity. */
function liveState(): Stored {
  if (liveCacheSrc !== state) {
    liveCacheSrc = state
    liveCache = {
      ...state,
      workouts: state.workouts.filter((w) => !w.deleted),
      mesocycles: state.mesocycles.filter((m) => !m.deleted),
    }
  }
  return liveCache
}

/** Reactive read for views. Tombstones are filtered out; use `getState()` for the raw lists when writing. */
export function useStore(): Stored {
  const [, force] = useState(0)
  useEffect(() => subscribe(() => force((n) => n + 1)), [])
  return liveState()
}

/** Raw state including tombstones. Writers and sync must start from this, never from `useStore()`. */
export function getState(): Stored {
  return state
}

export function setSettings(settings: Settings) {
  state = { ...state, settings }
  emit({ active: true })
}

export function setTemplates(templates: Template[]) {
  state = { ...state, templates }
  emit({ active: true })
}

export function setActive(active: ActiveWorkout | null) {
  state = { ...state, active }
  emit({ active: true })
}

export function setWorkouts(workouts: Workout[]) {
  state = { ...state, workouts }
  emit({ history: true })
}

export function upsertWorkout(workout: Workout) {
  const i = state.workouts.findIndex((w) => w.id === workout.id)
  const workouts = [...state.workouts]
  if (i >= 0) workouts[i] = workout
  else workouts.push(workout)
  setWorkouts(workouts)
}

export function setMesocycles(mesocycles: Mesocycle[]) {
  state = { ...state, mesocycles }
  emit({ history: true })
}

export function upsertMesocycle(meso: Mesocycle) {
  const i = state.mesocycles.findIndex((m) => m.id === meso.id)
  const mesocycles = [...state.mesocycles]
  if (i >= 0) mesocycles[i] = meso
  else mesocycles.push(meso)
  setMesocycles(mesocycles)
}

/** Saves `meso` as a mesocycle template. A brand-new one retires any other
 *  still-active, non-imported mesocycle, matching the app's one-active-plan rule;
 *  editing an existing id leaves other mesocycles untouched. Shared by the manual
 *  mesocycle editor and the coach's draft-accept flow so both follow the same rule. */
export function saveMesocycle(meso: Mesocycle) {
  const now = Date.now()
  const existing = state.mesocycles
  const isNew = !existing.some((m) => m.id === meso.id)
  const next = isNew
    ? existing.map((m) =>
        m.status === 'active' && !m.imported ? { ...m, status: 'complete' as const, finishedAt: now, updatedAt: now } : m,
      )
    : existing
  const i = next.findIndex((m) => m.id === meso.id)
  const mesocycles = i >= 0 ? next.map((m) => (m.id === meso.id ? meso : m)) : [...next, meso]
  setMesocycles(mesocycles)
}

/** Bulk-set both workouts and mesocycles with a single history write (used by import). */
export function setHistory(workouts: Workout[], mesocycles: Mesocycle[]) {
  state = { ...state, workouts, mesocycles }
  emit({ history: true })
}

/** Removes everything this module stores, including the IndexedDB history and the legacy pre-split keys. */
export async function clearHistory() {
  queued = null
  await pumping
  for (const key of [OLD_KEY, ACTIVE_KEY, HISTORY_KEY]) lsRemove(key)
  await historyDb.clear()
}

export function uid(): string {
  return crypto.randomUUID()
}

/** Saves a finished workout and clears the active one only once the history write is committed.
 *  On failure the active workout is kept and the error message is returned. */
export async function finishWorkout(finished: Workout): Promise<string | null> {
  upsertWorkout(finished)
  const err = await commitHistory()
  if (err) return err
  setActive(null)
  return null
}
