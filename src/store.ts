import { useEffect, useState } from 'preact/hooks'
import type { ActiveWorkout, Settings, Template, Workout } from './types'

export interface Stored {
  workouts: Workout[]
  templates: Template[]
  settings: Settings
  active: ActiveWorkout | null
}

const KEY = 'wt.v1'
const DEFAULT_SETTINGS: Settings = { units: 'lbs', restSeconds: 90, philosophy: 'balanced' }

function load(): Stored {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<Stored>
      return {
        workouts: p.workouts ?? [],
        templates: p.templates ?? [],
        settings: { ...DEFAULT_SETTINGS, ...p.settings },
        active: p.active ?? null,
      }
    }
  } catch {
  }
  return { workouts: [], templates: [], settings: DEFAULT_SETTINGS, active: null }
}

let state: Stored = load()
const listeners = new Set<() => void>()

function save() {
  localStorage.setItem(KEY, JSON.stringify(state))
}

function emit() {
  save()
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

function set(patch: Partial<Stored>) {
  state = { ...state, ...patch }
  emit()
}

export function setSettings(settings: Settings) {
  set({ settings })
}

export function setTemplates(templates: Template[]) {
  set({ templates })
}

export function setActive(active: ActiveWorkout | null) {
  set({ active })
}

export function setWorkouts(workouts: Workout[]) {
  set({ workouts })
}

export function upsertWorkout(workout: Workout) {
  const i = state.workouts.findIndex((w) => w.id === workout.id)
  const workouts = [...state.workouts]
  if (i >= 0) workouts[i] = workout
  else workouts.push(workout)
  setWorkouts(workouts)
}

export function uid(): string {
  return crypto.randomUUID()
}
