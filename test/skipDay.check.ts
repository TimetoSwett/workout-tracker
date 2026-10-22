import assert from 'node:assert/strict'
import type { Mesocycle, Workout } from '../src/types'
const { buildSkippedWorkout, mesoPosition, generateWorkoutExercises } =
  require('../src/mesoEngine') as typeof import('../src/mesoEngine')
const { encodeWorkout, decodeWorkout } = require('../src/weightWire') as typeof import('../src/weightWire')
const { localDate } = require('../src/dates') as typeof import('../src/dates')
const { isScoringWorkout } = require('../src/records') as typeof import('../src/records')
const { volumeOf, setCount, compileWorkouts, compileHistorySummary } = require('../src/prompts') as typeof import('../src/prompts')

const meso: Mesocycle = {
  id: 'meso', name: 'Plan', unit: 'lbs', weeksPlanned: 4,
  status: 'active', createdAt: 1, updatedAt: 1, priorities: [],
  days: ['Upper', 'Lower'].map((label) => ({
    id: label, label,
    exercises: [{ id: label, name: 'Squat', sets: 1, repTarget: [8, 10] }],
  })),
}
const snapshot = JSON.stringify(meso)
// Late local evening crosses the UTC day in time zones west of Greenwich.
const now = new Date(2026, 9, 22, 23, 30).getTime()
const skipped = buildSkippedWorkout(meso, mesoPosition(meso, []), now, 'skip')
assert.equal(skipped.date, localDate(new Date(now)))
assert.deepEqual(skipped, {
  id: 'skip', date: '2026-10-22', name: 'Upper', status: 'skipped', exercises: [],
  mesoId: 'meso', mesoWeek: 0, mesoDayPosition: 0,
  startedAt: now, endedAt: now, updatedAt: now,
})
assert.equal(JSON.stringify(meso), snapshot)
assert.equal(mesoPosition(meso, [skipped]).dayIndex, 1)
const legacy: Workout = {
  id: 'legacy', date: '2026-10-21', startedAt: 1, updatedAt: 1, mesoId: meso.id,
  exercises: [{ id: 'ex', name: 'Squat', templateExerciseId: 'Upper', sets: [{ weight: 100, reps: 10, done: true }] }],
}
assert.equal('status' in legacy, false)
assert.equal(mesoPosition(meso, [legacy]).dayIndex, 1)
assert.equal(mesoPosition(meso, [legacy, skipped]).weekIndex, 1)
assert.equal(mesoPosition(meso, [legacy, skipped]).dayIndex, 0)
assert.equal(mesoPosition(meso, [{ ...skipped, deleted: true }]).dayIndex, 0)
for (const units of ['lbs', 'kg'] as const) {
  const wire = JSON.parse(JSON.stringify(encodeWorkout(skipped, 'lbs')))
  assert.deepEqual(decodeWorkout(wire, units), skipped)
}
assert.equal(volumeOf(skipped), 0)
assert.equal(setCount(skipped), 0)
assert.equal(volumeOf(legacy), 1000)
assert.match(compileWorkouts([skipped], { units: 'lbs', restSeconds: 60, philosophy: 'balanced' }), /Upper — Skipped/)
// Imported skipped sessions may retain prescribed rows; they must not change targets.
const importedSkip = { ...skipped, exercises: [{ ...legacy.exercises[0], sets: [{ weight: 900, reps: 10, done: true }] }] }
const next = generateWorkoutExercises(meso, mesoPosition(meso, [legacy, importedSkip]), [legacy, importedSkip])
assert.equal(next[0].sets[0].weightTarget, 105)
console.log('PASS skipDay: advancement, legacy workouts, wire round-trip, summaries and targets')

assert.equal(isScoringWorkout(skipped), false)
assert.equal(isScoringWorkout(importedSkip), false)
assert.equal(isScoringWorkout(legacy), true)
assert.equal(isScoringWorkout({ ...legacy, deleted: true }), false)
assert.deepEqual([legacy, skipped, importedSkip].filter(isScoringWorkout), [legacy])
assert.equal(volumeOf(importedSkip), 0)
assert.equal(setCount(importedSkip), 0)
const settings = { units: 'lbs', restSeconds: 60, philosophy: 'balanced' } as const
assert.match(compileWorkouts([legacy, importedSkip], settings), /Workouts \(1\)/)
assert.equal(compileHistorySummary([legacy, importedSkip], settings), compileHistorySummary([legacy], settings))

const { coachEmptyMessage, coachWindow } = require('../src/coachWindow') as typeof import('../src/coachWindow')
assert.deepEqual(coachWindow([skipped, legacy], 'last'), [legacy])
assert.deepEqual(coachWindow([skipped, legacy], 'all'), [legacy])
assert.deepEqual(coachWindow([skipped], 'last'), [])
assert.deepEqual(coachWindow([skipped], 4, now), [])
assert.deepEqual(coachWindow([legacy, skipped], 4, now), [])
assert.deepEqual(coachWindow([legacy, skipped], 4, legacy.startedAt), [legacy])

const noLoggedWorkouts = 'No workouts logged yet — log a session, or import your RP history from the Plan tab.'
for (const window of ['last', 'all', 2, 4, 8, 12] as const) {
  assert.equal(coachEmptyMessage([], window), noLoggedWorkouts)
  assert.equal(coachEmptyMessage([skipped, importedSkip], window), noLoggedWorkouts)
}
assert.equal(
  coachEmptyMessage([legacy, skipped], 4),
  'No workouts in the last 4 weeks. Log a session or ask a question directly instead.',
)
// History's empty-state guard accepts legacy workouts and keeps skips in mixed lists.
assert.equal([].some(isScoringWorkout), false)
assert.equal([skipped, importedSkip].some(isScoringWorkout), false)
assert.equal([legacy].some(isScoringWorkout), true)
const mixedHistory = [skipped, legacy, importedSkip]
assert.equal(mixedHistory.some(isScoringWorkout), true)
assert.equal(mixedHistory.length, 3)

// Legacy records can lack a stored date: use startedAt, or omit the monthly row.
const missingDate = { ...legacy, date: undefined } as unknown as Workout
assert.doesNotThrow(() => compileHistorySummary([missingDate], settings))
assert.match(compileHistorySummary([missingDate], settings), new RegExp(localDate(new Date(legacy.startedAt)).slice(0, 7)))
const undated = { ...missingDate, startedAt: undefined } as unknown as Workout
assert.doesNotThrow(() => compileHistorySummary([undated], settings))
assert.match(compileHistorySummary([undated], settings), /0 sessions/)
console.log('PASS skipDay: coach windows exclude skips and history tolerates missing dates')
