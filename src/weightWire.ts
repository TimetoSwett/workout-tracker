import type { DailyMetric, Workout } from './types'
import type { Units } from './units'
import { convertWeightExact } from './units'

/** Everything this app stores locally is a bare number in whatever `settings.units` was
 *  set to on *that device* when it was written (see `convertStoredWeights`). Units are
 *  per-device and deliberately not synced, so a bare number is meaningless once it leaves
 *  the device: a 140 lbs bench uploaded as `140` reads back as 140 kg on a kg phone, and
 *  switching one device to kg rewrote its own numbers to 63.5 and pushed those to a phone
 *  still in lbs, which showed "63.5 lbs".
 *
 *  So the synced JSONL has its own representation, separate from local storage:
 *
 *   - every weight is in `WIRE_UNIT`, at full precision
 *   - every record carries `weightUnit` naming the unit its weights are in
 *
 *  `encode*` converts out of the device's units on upload, `decode*` converts back into
 *  them on download. Local storage is untouched by this — it stays in device units, so
 *  the offline unit switch keeps working exactly as before.
 *
 *  A weight that never crosses units survives any number of syncs unchanged. One that is
 *  re-uploaded by a phone set to the other unit can move by a single display tenth once —
 *  that phone stores it rounded to 0.1 of its own unit — and then settles. */
export const WIRE_UNIT: Units = 'kg'

/** Weights the app keeps in whatever unit `settings.units` names, to be converted together. */
const SET_WEIGHT_KEYS = ['weight', 'weightTarget'] as const
const METRIC_WEIGHT_KEYS = ['weight', 'muscle', 'leanMass'] as const

/** A record as it appears in the Dropbox JSONL. `weightUnit` exists only here; it is
 *  stripped on the way into local storage, where the device's `settings.units` is the
 *  only source of truth and a stale tag could only mislead. */
export type Wire<T> = T & { weightUnit?: Units }
export type WireWorkout = Wire<Workout>
export type WireMetric = Wire<DailyMetric>

/** Records written before `weightUnit` existed. Nothing on the wire says what they mean,
 *  so they are read as being in the *receiving* device's units — which is what the app did
 *  before tagging, so a board that has only ever used one unit sees no change at all. It
 *  is also the likeliest reading: untagged data was written by this same user on a device
 *  that was almost certainly set the same way.
 *
 *  The guess is wrong only for untagged data written on a device set to the *other* unit,
 *  and nothing in the payload can distinguish that case. Reading one of these promotes the
 *  guess to a tag, so it is made once and then fixed; `hasUntaggedRecords` lets sync force
 *  an upload so the remote file stops being ambiguous on the very first sync after this
 *  ships, rather than whenever a weight next changes. */
function senderUnits(rec: { weightUnit?: Units }, receiverUnits: Units): Units {
  return rec.weightUnit ?? receiverUnits
}

export function hasUntaggedRecords(remote: { weightUnit?: Units }[]): boolean {
  return remote.some((r) => r.weightUnit == null)
}

/** `local -> wire`: exact, so a round trip returns the stored number unchanged. */
function out(v: number | null | undefined, from: Units): number | null | undefined {
  return v == null ? v : convertWeightExact(v, from, WIRE_UNIT)
}

/** `wire -> local`: rounded to 0.1, the precision every weight in the app is stored and
 *  shown at. The rounding happens even when the units already match, because the wire
 *  value is deliberately unrounded — `convertWeight` short-circuits a same-unit call, so
 *  going through it would drop 63.502932429341875 straight into a kg device's storage. */
function into(v: number | null | undefined, from: Units, to: Units): number | null | undefined {
  return v == null ? v : Math.round(convertWeightExact(v, from, to) * 10) / 10
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
  return { ...convertWorkoutWeights(w, (v) => out(v, local)), weightUnit: WIRE_UNIT }
}

export function decodeWorkout(w: WireWorkout, local: Units): Workout {
  const from = senderUnits(w, local)
  const { weightUnit: _tag, ...decoded } = convertWorkoutWeights(w, (v) => into(v, from, local))
  return decoded
}

export function encodeMetric(m: DailyMetric, local: Units): WireMetric {
  return { ...convertKeys(m, METRIC_WEIGHT_KEYS, (v) => out(v, local)), weightUnit: WIRE_UNIT }
}

export function decodeMetric(m: WireMetric, local: Units): DailyMetric {
  const from = senderUnits(m, local)
  const { weightUnit: _tag, ...decoded } = convertKeys(m, METRIC_WEIGHT_KEYS, (v) => into(v, from, local))
  return decoded
}
