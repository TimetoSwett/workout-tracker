// The after-exercise check-in belongs to the exercise that was performed, and uses RP's scales:
// soreness 0-3 and joint pain 0-3 after the first set, pump 0-2 and workload 0-3 after the last.
import assert from 'node:assert/strict'
import type { LoggedExercise, Workout } from '../src/types'
const { exerciseFeelText } = require('../src/ratings') as typeof import('../src/ratings')
const checkin = require('../src/checkin') as typeof import('../src/checkin')
const { compileWorkouts } = require('../src/prompts') as typeof import('../src/prompts')
const { encodeWorkout, decodeWorkout } = require('../src/weightWire') as typeof import('../src/weightWire')

const sets = (...done: boolean[]) => done.map((d) => ({ weight: 185, reps: 8, done: d }))

function main() {
  // Scales match RP's: four soreness and joint-pain answers, three pump, four workload.
  assert.deepEqual(checkin.SORENESS_OPTIONS.map((o) => o.value), [0, 1, 2, 3])
  assert.deepEqual(checkin.JOINT_PAIN_OPTIONS.map((o) => o.value), [0, 1, 2, 3])
  assert.deepEqual(checkin.PUMP_OPTIONS.map((o) => o.value), [0, 1, 2])
  assert.deepEqual(checkin.WORKLOAD_OPTIONS.map((o) => o.value), [0, 1, 2, 3])

  // Soreness and pain wait for the first set; pump and workload wait for the last.
  const untouched: LoggedExercise = { id: 'a', name: 'Bench Press', sets: sets(false, false) }
  assert.equal(checkin.phaseReached(untouched, 'start'), false)
  const oneDone = { ...untouched, sets: sets(true, false) }
  assert.equal(checkin.phaseReached(oneDone, 'start'), true)
  assert.equal(checkin.phaseReached(oneDone, 'end'), false)
  const allDone = { ...untouched, sets: sets(true, true) }
  assert.equal(checkin.phaseReached(allDone, 'end'), true)
  const skipped: LoggedExercise = { id: 'b', name: 'Row', skipReason: 'Still sore', sets: sets(true) }
  assert.equal(checkin.phaseReached(skipped, 'start'), false)
  assert.equal(checkin.phaseReached(skipped, 'end'), false)

  // A phase is answered only when both of its questions are, and a 0 is an answer.
  assert.equal(checkin.phaseUntouched(untouched, 'start'), true)
  assert.equal(checkin.phaseAnswered({ ...oneDone, soreness: 0 }, 'start'), false)
  assert.equal(checkin.phaseAnswered({ ...oneDone, soreness: 0, jointPain: 0 }, 'start'), true)
  assert.equal(checkin.phaseUntouched({ ...oneDone, soreness: 0 }, 'start'), false)

  const rated: LoggedExercise = { ...allDone, soreness: 2, jointPain: 0, pump: 2, workload: 2 }
  assert.equal(
    exerciseFeelText(rated),
    'Soreness: Healed just in time · Joint pain: None · Pump: Amazing · Workload: Pushed my limits',
  )
  assert.equal(exerciseFeelText({ ...rated, skipReason: 'No time' }), null)
  assert.equal(exerciseFeelText(untouched), null)
  // Logs from before the check-in carried a bare pump number and a recovery rating.
  assert.equal(exerciseFeelText({ ...untouched, pump: 1, recovery: 3 }), 'Pump: Moderate · Recovery: 3/3')

  const workout: Workout = { id: 'w', date: '2026-10-24', startedAt: 1, updatedAt: 1, exercises: [rated, skipped] }
  const settings = { units: 'lbs', restSeconds: 90, philosophy: 'balanced' } as const
  const text = compileWorkouts([workout], settings)
  assert.match(text, /Bench Press:.*\n {2}feel: Soreness: Healed just in time · Joint pain: None · Pump: Amazing · Workload: Pushed my limits/)
  assert.doesNotMatch(text, /Row:[\s\S]*feel:/)

  const back = decodeWorkout(encodeWorkout(workout, 'lbs'), 'lbs')
  assert.equal(back.exercises[0].soreness, 2)
  assert.equal(back.exercises[0].jointPain, 0)
  assert.equal(back.exercises[0].pump, 2)
  assert.equal(back.exercises[0].workload, 2)
  console.log('exerciseFeel: ok')
}

main()
