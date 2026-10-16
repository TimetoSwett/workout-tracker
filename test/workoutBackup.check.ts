import { strict as assert } from 'node:assert'
import type { Workout } from '../src/types'
import { exportWorkoutBackup, importWorkoutBackup, mergeWorkoutBackup } from '../src/workoutBackup'

const w: Workout = {
  id: 'synthetic', date: '2026-10-08', startedAt: 1, updatedAt: 2, bodyweight: 178.46,
  exercises: [{ id: 'bench', name: 'Bench', sets: [
    { weight: 102.25, weightTarget: 110.75, reps: 8 }, { weight: null, reps: null },
  ] }],
}
const json = (v: unknown) => JSON.parse(JSON.stringify(v))
const before = json(w)
for (const unit of ['lbs', 'kg'] as const) {
  assert.deepEqual(importWorkoutBackup(json(exportWorkoutBackup([w], unit)), unit), [w])
}
const kg = importWorkoutBackup(json(exportWorkoutBackup([w], 'lbs')), 'kg')[0]
assert.ok(Math.abs(kg.bodyweight! - 80.94810) < 0.00001)
assert.ok(Math.abs(kg.exercises[0].sets[0].weight! - 46.37982) < 0.00001)
assert.ok(Math.abs(kg.exercises[0].sets[0].weightTarget! - 50.23536) < 0.00001)
const back = importWorkoutBackup(json(exportWorkoutBackup([kg], 'kg')), 'lbs')[0]
assert.ok(Math.abs(back.bodyweight! - w.bodyweight!) < 1e-10)
assert.ok(Math.abs(back.exercises[0].sets[0].weight! - 102.25) < 1e-10)
assert.deepEqual(kg.exercises[0].sets[1], w.exercises[0].sets[1])
assert.deepEqual(w, before)
assert.throws(() => importWorkoutBackup([w], 'kg'), /Choose the original/)
assert.deepEqual(importWorkoutBackup([w], 'kg', 'lbs'), [kg])
assert.deepEqual(importWorkoutBackup([w], 'kg', 'kg'), [w])
for (const patch of [{ version: 2 }, { weightUnit: 'stone' }, { weightUnit: undefined }, { workouts: [w, null] },
  { workouts: [{ ...w, exercises: [{ sets: [null] }] }] },
  { workouts: [{ ...w, bodyweight: '178' }] },
  { workouts: [{ ...w, weightUnit: 'kg' }] }]) {
  assert.throws(() => importWorkoutBackup({ ...exportWorkoutBackup([w], 'lbs'), ...patch }, 'kg'))
}
const deleted = { ...w, id: 'deleted', deleted: true }
const existing = [deleted, w]
const newWorkout = { ...w, id: 'new' }
assert.deepEqual(mergeWorkoutBackup(existing, [{ ...deleted, deleted: false }, { ...w, bodyweight: 1 }, newWorkout, newWorkout]),
  [...existing, newWorkout])
assert.deepEqual(mergeWorkoutBackup([], [deleted]), [deleted])
assert.deepEqual(exportWorkoutBackup(existing, 'lbs').workouts, [w])
assert.deepEqual(mergeWorkoutBackup(existing, []), existing)
console.log('PASS: same-unit precision, cross-unit round trip, legacy provenance, malformed rejection, duplicates and tombstones')
