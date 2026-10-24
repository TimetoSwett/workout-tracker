// Pump and recovery belong to the exercise that was performed, not the whole workout.
import assert from 'node:assert/strict'
import type { LoggedExercise, Workout } from '../src/types'
const { exerciseFeelText, withExerciseFeel } = require('../src/ratings') as typeof import('../src/ratings')
const { compileWorkouts } = require('../src/prompts') as typeof import('../src/prompts')
const { encodeWorkout, decodeWorkout } = require('../src/weightWire') as typeof import('../src/weightWire')

const bench: LoggedExercise = { id: 'bench', name: 'Bench Press', sets: [{ weight: 185, reps: 8, done: true }] }
const row: LoggedExercise = { id: 'row', name: 'Row', skipReason: 'Still sore', sets: [{ weight: 100, reps: 8, done: false, status: 'skipped' }] }

function main() {
  const rated = withExerciseFeel([bench, row], {
    bench: { pump: 2, recovery: 1 },
    row: { pump: 0, recovery: 3 },
  })
  assert.equal(rated[0].pump, 2)
  assert.equal(rated[0].recovery, 1)
  assert.equal(rated[1].pump, undefined)
  assert.equal(rated[1].recovery, undefined)
  assert.equal(bench.pump, undefined)
  assert.equal(exerciseFeelText(rated[0]), 'pump 2/2 · recovery 1/3')
  assert.equal(exerciseFeelText(rated[1]), null)

  const workout: Workout = {
    id: 'w',
    date: '2026-10-24',
    startedAt: 1,
    updatedAt: 1,
    exercises: rated,
  }
  const settings = { units: 'lbs', restSeconds: 90, philosophy: 'balanced' } as const
  const text = compileWorkouts([workout], settings)
  assert.match(text, /Bench Press:.*\n {2}feel: pump 2\/2, recovery 1\/3/)
  assert.doesNotMatch(text, /Row:[\s\S]*feel:/)
  assert.match(text, /Recovery scale: 0 = not recovered/)

  const back = decodeWorkout(encodeWorkout(workout, 'lbs'), 'lbs')
  assert.equal(back.exercises[0].pump, 2)
  assert.equal(back.exercises[0].recovery, 1)
  assert.equal(back.exercises[1].recovery, undefined)
  console.log('exerciseFeel: ok')
}

main()
