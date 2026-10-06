import type { DailyMetric, Workout } from './types'
import type { Units } from './units'
import { convertWeightExact } from './units'

/** Wire tags name the native unit of the numbers. Upload adds metadata only;
 * same-unit decoding preserves all precision. Cross-unit decoding rounds for local
 * display. Sync preserves remote wire records when unrelated local records change. */
/** Weights the app keeps in whatever unit `settings.units` names, to be converted together. */
const SET_WEIGHT_KEYS = ['weight', 'weightTarget'] as const
const METRIC_WEIGHT_KEYS = ['weight', 'muscle', 'leanMass'] as const

/** A record as it appears in the Dropbox JSONL. `weightUnit` exists only here; it is
 *  stripped on the way into local storage, where the device's `settings.units` is the
 *  only source of truth and a stale tag could only mislead. */
export type Wire<T> = T & { weightUnit?: Units }
export type WireWorkout = Wire<Workout>
export type WireMetric = Wire<DailyMetric>

/** Legacy records have no reliable unit provenance. Never guess or rewrite them.
 *  Sync must stop before merging until an explicit, backed-up migration resolves units. */
export const LEGACY_UNITS_ERROR =
  'Sync paused: Dropbox contains records with missing or invalid weight units. No data was changed. Back up the Dropbox files and resolve each record’s original units before syncing.'

function senderUnits(rec: { weightUnit?: Units }): Units {
  if (rec.weightUnit !== 'lbs' && rec.weightUnit !== 'kg') throw new Error(LEGACY_UNITS_ERROR)
  return rec.weightUnit
}

export function hasUntaggedRecords(remote: { weightUnit?: Units }[]): boolean {
  return remote.some((r) => r.weightUnit !== 'lbs' && r.weightUnit !== 'kg')
}

function into(v: number | null | undefined, from: Units, to: Units): number | null | undefined {
  return v == null || from === to ? v : Math.round(convertWeightExact(v, from, to) * 10) / 10
}

type Convert = (v: number | null | undefined) => number | null | undefined

/** Converts the listed keys in place on a shallow copy, leaving keys that are absent
 *  absent. Writing `weight: undefined` onto a record that never had one would make
 *  `metricsStore.upsertMetric`'s "present but undefined" guard do extra work and would
 *  change `'weight' in m` for every later reader, so absence is preserved. */
function convertKeys<T, K extends keyof T>(rec: T, keys: readonly K[], f: Convert): T {
  const next = { ...rec }
  for (const k of keys) {
    if (k in (rec as object)) next[k] = f(rec[k] as number | null | undefined) as T[K]
  }
  return next
}

function convertWorkoutWeights(w: WireWorkout, f: Convert): WireWorkout {
  return {
    ...convertKeys(w, ['bodyweight'] as const, f),
    exercises: w.exercises.map((ex) => ({
      ...ex,
      sets: ex.sets.map((s) => convertKeys(s, SET_WEIGHT_KEYS, f)),
    })),
  }
}

export function encodeWorkout(w: Workout, local: Units): WireWorkout {
  return { ...w, weightUnit: local }
}

export function decodeWorkout(w: WireWorkout, local: Units): Workout {
  const from = senderUnits(w)
  const { weightUnit: _tag, ...decoded } = convertWorkoutWeights(w, (v) => into(v, from, local))
  return decoded
}

export function encodeMetric(m: DailyMetric, local: Units): WireMetric {
  return { ...m, weightUnit: local }
}

export function decodeMetric(m: WireMetric, local: Units): DailyMetric {
  const from = senderUnits(m)
  const { weightUnit: _tag, ...decoded } = convertKeys(m, METRIC_WEIGHT_KEYS, (v) => into(v, from, local))
  return decoded
}
