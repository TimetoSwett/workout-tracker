import { useEffect, useState } from 'preact/hooks'
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

function migrateFromOldKey(): { activeSlice: ActiveSlice; historySlice: HistorySlice } | null {
  const raw = localStorage.getItem(OLD_KEY)
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as Partial<Stored>
    const activeSlice: ActiveSlice = {
      active: p.active ?? null,
      templates: p.templates ?? [],
      settings: { ...DEFAULT_SETTINGS, ...p.settings },
    }
    const historySlice: HistorySlice = {
      workouts: p.workouts ?? [],
      mesocycles: p.mesocycles ?? [],
    }
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(activeSlice))
    localStorage.setItem(HISTORY_KEY, JSON.stringify(historySlice))
    localStorage.removeItem(OLD_KEY)
    return { activeSlice, historySlice }
  } catch {
    return null
  }
}

function load(): Stored {
  const migrated = migrateFromOldKey()
  if (migrated) {
    return { ...migrated.activeSlice, ...migrated.historySlice }
  }
  let activeSlice: ActiveSlice = { active: null, templates: [], settings: DEFAULT_SETTINGS }
  let historySlice: HistorySlice = { workouts: [], mesocycles: [] }
  try {
    const raw = localStorage.getItem(ACTIVE_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<ActiveSlice>
      activeSlice = {
        active: p.active ?? null,
        templates: p.templates ?? [],
        settings: { ...DEFAULT_SETTINGS, ...p.settings },
      }
    }
  } catch {
  }
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<HistorySlice>
      historySlice = { workouts: p.workouts ?? [], mesocycles: p.mesocycles ?? [] }
    }
  } catch {
  }
  return { ...activeSlice, ...historySlice }
}

let state: Stored = load()
const listeners = new Set<() => void>()

function saveActive() {
  const { active, templates, settings } = state
  localStorage.setItem(ACTIVE_KEY, JSON.stringify({ active, templates, settings } satisfies ActiveSlice))
}

function saveHistory() {
  const { workouts, mesocycles } = state
  localStorage.setItem(HISTORY_KEY, JSON.stringify({ workouts, mesocycles } satisfies HistorySlice))
}

function emit(changed: { active?: boolean; history?: boolean }) {
  if (changed.active) saveActive()
  if (changed.history) saveHistory()
  for (const l of listeners) l()
}

export function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function useStore(): Stored {
  const [, force] = useState(0)
  useEffect(() => subscribe(() => force((n) => n + 1)), [])
  return state
}

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

/** Bulk-set both workouts and mesocycles with a single history write (used by import). */
export function setHistory(workouts: Workout[], mesocycles: Mesocycle[]) {
  state = { ...state, workouts, mesocycles }
  emit({ history: true })
}

/** Removes all storage keys this module owns, including the legacy pre-split key. */
export function clearHistory() {
  localStorage.removeItem(OLD_KEY)
  localStorage.removeItem(ACTIVE_KEY)
  localStorage.removeItem(HISTORY_KEY)
}

export function uid(): string {
  return crypto.randomUUID()
}
