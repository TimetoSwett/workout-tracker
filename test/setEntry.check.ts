// Weight fills forward only on a committed change, and only into later unfinished
// sets of that exercise. Exercise history is the completed sets of that lift,
// newest first, never the workout in progress and never a lookalike name.
import assert from 'node:assert/strict'
import type { LoggedSet, Workout } from '../src/types'
const { allSetsDone, exerciseHistory, isUnfinishedSet, weightsFilledForward } =
  require('../src/setEntry') as typeof import('../src/setEntry')

const set = (weight: number | null, extra: Partial<LoggedSet> = {}): LoggedSet => ({
  weight,
  reps: 5,
  done: false,
  ...extra,
})

function main() {
  let n = 0
  const check = (fn: () => void) => { fn(); n++ }

  const row = [set(100, { done: true }), set(100, { done: true }), set(100), set(100), set(100, { done: true })]

  check(() => {
    const edited = row.map((s, i) => (i === 2 ? { ...s, weight: 110 } : s))
    const next = weightsFilledForward(edited, 2, 100)
    assert.deepEqual(next.map((s) => s.weight), [100, 100, 110, 110, 100])
    assert.equal(next[0], edited[0])
    assert.equal(next[1], edited[1])
    assert.equal(next[2], edited[2])
    assert.equal(next[4], edited[4])
    assert.equal(next[3].reps, 5)
    assert.notEqual(next[3], edited[3])
  })

  check(() => {
    const cleared = row.map((s, i) => (i === 2 ? { ...s, weight: null } : s))
    const next = weightsFilledForward(cleared, 2, 100)
    assert.equal(next, cleared)
    assert.equal(next[3].weight, 100)
  })

  check(() => {
    assert.equal(weightsFilledForward(row, 2, 100), row)
  })

  check(() => {
    const skipped = [set(100), set(90, { status: 'skipped', done: false })]
    const edited = skipped.map((s, i) => (i === 0 ? { ...s, weight: 110 } : s))
    const next = weightsFilledForward(edited, 0, 100)
    assert.equal(next[1].weight, 90)
    assert.equal(isUnfinishedSet(skipped[1]), false)
  })

  const workouts: Workout[] = [
    {
      id: 'today',
      date: '2026-10-16',
      startedAt: 3,
      updatedAt: 0,
      exercises: [{ id: 'a', name: 'Bench Press', templateExerciseId: 'tex-bench', sets: [set(200, { done: true })] }],
    },
    {
      id: 'old-name',
      date: '2026-10-01',
      startedAt: 1,
      updatedAt: 0,
      exercises: [{ id: 'b', name: 'Bench Press Pause', templateExerciseId: 'tex-pause', sets: [set(150, { done: true })] }],
    },
    {
      id: 'mid',
      date: '2026-10-09',
      startedAt: 2,
      updatedAt: 0,
      exercises: [{
        id: 'c',
        name: 'Bench Press',
        templateExerciseId: 'tex-bench',
        sets: [set(185, { done: true }), set(185, { done: false }), set(null, { done: true, reps: 8 })],
      }],
    },
    {
      id: 'newest',
      date: '2026-10-14',
      startedAt: 2,
      updatedAt: 0,
      exercises: [{ id: 'd', name: 'Bench Press', templateExerciseId: 'tex-bench', sets: [set(195, { done: true, reps: 3 })] }],
    },
    {
      id: 'skipped-day',
      date: '2026-10-15',
      startedAt: 2,
      updatedAt: 0,
      status: 'skipped',
      exercises: [{ id: 'e', name: 'Bench Press', templateExerciseId: 'tex-bench', sets: [set(205, { done: true })] }],
    },
  ]

  check(() => {
    const sessions = exerciseHistory(workouts, { name: 'Bench Press', templateExerciseId: 'tex-bench' }, 'today')
    assert.deepEqual(sessions.map((s) => s.workoutId), ['newest', 'mid'])
    assert.deepEqual(sessions[1].sets, [
      { weight: 185, reps: 5 },
      { weight: null, reps: 8 },
    ])
  })

  check(() => {
    const sessions = exerciseHistory(workouts, { name: 'Bench Press Pause' }, 'today')
    assert.deepEqual(sessions.map((s) => s.workoutId), ['old-name'])
  })

  check(() => {
    const sessions = exerciseHistory(workouts, { name: 'bench press' }, 'today')
    assert.ok(sessions.every((s) => s.workoutId !== 'old-name'))
    assert.ok(sessions.some((s) => s.workoutId === 'newest'))
  })

  check(() => {
    assert.equal(allSetsDone({ sets: [{ done: true }, { done: true }] }), true)
    assert.equal(allSetsDone({ sets: [{ done: true }, { done: false }] }), false)
    assert.equal(allSetsDone({ sets: [] }), false)
    assert.equal(allSetsDone({ skipReason: 'No time', sets: [{ done: true }] }), false)
  })

  console.log(`setEntry: ${n} checks passed`)
}

main()
