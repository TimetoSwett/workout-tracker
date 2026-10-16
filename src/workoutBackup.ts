import type { Workout } from './types'
import { convertWeightExact, type Units } from './units'

export function exportWorkoutBackup(workouts: Workout[], weightUnit: Units) {
  return { format: 'workout-tracker-workouts', version: 1, weightUnit, workouts: workouts.filter((w) => !w.deleted) }
}

function object(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function weight(v: unknown) {
  return v == null || (typeof v === 'number' && Number.isFinite(v))
}
function isWorkout(v: unknown): v is Workout {
  return object(v) && typeof v.id === 'string' && v.id.length > 0 &&
    typeof v.startedAt === 'number' && Number.isFinite(v.startedAt) &&
    weight(v.bodyweight) && Array.isArray(v.exercises) && v.exercises.every((ex) =>
      object(ex) && Array.isArray(ex.sets) && ex.sets.every((s) =>
        object(s) && weight(s.weight) && weight(s.weightTarget)))
}

/** Legacy arrays need a deliberate source-unit choice. No write occurs during parsing. */
export function importWorkoutBackup(parsed: unknown, local: Units, legacyUnits?: Units): Workout[] {
  let records: unknown
  let from: unknown
  if (Array.isArray(parsed)) {
    records = parsed
    from = legacyUnits
    if (!from) throw new Error('Choose the original weight units for this legacy workout file. No data was changed.')
  } else {
    if (!object(parsed) || parsed.format !== 'workout-tracker-workouts' || parsed.version !== 1) {
      throw new Error('Unsupported workout backup format or version')
    }
    records = parsed.workouts
    from = parsed.weightUnit
  }
  if (from !== 'lbs' && from !== 'kg') throw new Error('Missing or invalid original weight units')
  if (!Array.isArray(records)) throw new Error('Expected workouts array')
  const source: Units = from
  const convert = (v: number | null | undefined) => v == null ? v : convertWeightExact(v, source, local)
  return records.map((w, i) => {
    if (!isWorkout(w)) throw new Error(`Item ${i + 1} is not a valid workout`)
    // A conflicting per-record tag is ambiguous even when an envelope/legacy choice exists.
    const { weightUnit: tag, ...record } = w as Workout & { weightUnit?: unknown }
    if (tag !== undefined && tag !== source) throw new Error(`Item ${i + 1} has conflicting weight units`)
    return {
      ...record,
      ...('bodyweight' in record ? { bodyweight: convert(record.bodyweight) as number | undefined } : {}),
      exercises: record.exercises.map((ex) => ({
        ...ex,
        sets: ex.sets.map((s) => ({
          ...s,
          ...('weight' in s ? { weight: convert(s.weight) as number | null } : {}),
          ...('weightTarget' in s ? { weightTarget: convert(s.weightTarget) } : {}),
        })),
      })),
    }
  })
}

/** Existing IDs (including tombstones) win. First occurrence of a new ID wins. */
export function mergeWorkoutBackup(existing: Workout[], incoming: Workout[]): Workout[] {
  const ids = new Set(existing.map((w) => w.id))
  const added = incoming.filter((w) => {
    if (ids.has(w.id)) return false
    ids.add(w.id)
    return true
  })
  return [...existing, ...added]
}
