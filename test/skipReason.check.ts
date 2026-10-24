// Skipping an exercise records why, keeps it out of the performed sets, and does
// not replace the last session that actually happened. A skipped day keeps its reason.
import assert from 'node:assert/strict'
import type { LoggedExercise, Mesocycle, Workout } from '../src/types'
const { skipExercise, unskipExercise, skipReasonText } = require('../src/skipExercise') as typeof import('../src/skipExercise')
const { buildSkippedWorkout, generateWorkoutExercises, mesoPosition } =
  require('../src/mesoEngine') as typeof import('../src/mesoEngine')
const { compileWorkouts } = require('../src/prompts') as typeof import('../src/prompts')
const { isHardSet } = require('../src/records') as typeof import('../src/records')

const exercise: LoggedExercise = {
  id: 'ex',
  name: 'Bench Press',
  templateExerciseId: 'tex',
  sets: [{ weight: 185, reps: 8, done: true }, { weight: 185, reps: null, done: false }],
}

const meso: Mesocycle = {
  id: 'meso',
  name: 'Plan',
  unit: 'lbs',
  weeksPlanned: 4,
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
  priorities: [],
  days: [{ id: 'day', label: 'Upper', exercises: [{ id: 'tex', name: 'Bench Press', sets: 2, repTarget: [8, 10] }] }],
}

function main() {
  const snapshot = JSON.stringify(exercise)
  const skipped = skipExercise(exercise, 'Still sore')
  assert.equal(JSON.stringify(exercise), snapshot)
  assert.equal(skipped.skipReason, 'Still sore')
  assert.equal(skipped.sets.every((s) => s.status === 'skipped' && s.done === false), true)
  assert.equal(skipped.sets[0].weight, 185)
  assert.equal(isHardSet(skipped.sets[0]), false)
  const back = unskipExercise(skipped)
  assert.equal(back.skipReason, undefined)
  assert.equal(back.sets[0].status, undefined)
  assert.equal(back.sets[0].weight, 185)

  const done: Workout = {
    id: 'done',
    date: '2026-10-20',
    startedAt: 1,
    updatedAt: 1,
    mesoId: meso.id,
    exercises: [{ ...exercise, sets: [{ weight: 185, reps: 10, done: true }, { weight: 185, reps: 10, done: true }] }],
  }
  const partial: Workout = {
    id: 'partial',
    date: '2026-10-22',
    startedAt: 2,
    updatedAt: 2,
    mesoId: meso.id,
    exercises: [skipped],
  }
  const next = generateWorkoutExercises(meso, { weekIndex: 1, dayIndex: 0, isDeload: false, isFirstWeek: false }, [done, partial])
  assert.equal(next[0].sets[0].weightTarget, 190)

  const day = buildSkippedWorkout(meso, mesoPosition(meso, []), 50, 'skip', 'No time')
  assert.equal(day.status, 'skipped')
  assert.equal(day.skipReason, 'No time')
  const settings = { units: 'lbs', restSeconds: 90, philosophy: 'balanced' } as const
  const text = compileWorkouts([day, partial], settings)
  assert.match(text, /Skipped \(No time\)/)
  assert.match(text, /Bench Press: skipped \(Still sore\)/)

  assert.equal(skipReasonText('Low energy', ''), 'Low energy')
  assert.equal(skipReasonText('Other', '  knee  '), 'Other: knee')
  assert.equal(skipReasonText('Other', '   '), 'Other')
  console.log('skipReason: ok')
}

main()
