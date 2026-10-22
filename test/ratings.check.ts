/** Post-workout ratings checks (`Workout.ratings`, joint soreness first).
 *
 *  The guarantees that matter:
 *   - ratings are optional: records written before ratings existed load and sync unchanged;
 *   - the wire round trip (Dropbox JSONL via weightWire) preserves ratings untouched;
 *   - the coach context prints a joint-soreness line only for a rated, performed workout;
 *   - a skipped workout never shows a rating and never reads as "not rated" — even if a
 *     record somehow carries both `status: 'skipped'` and a ratings value.
 *
 *  Run with `npm run check`. */
import type { Settings, Workout } from '../src/types'
import { compileWorkouts } from '../src/prompts'
import { decodeWorkout, encodeWorkout } from '../src/weightWire'

let failures = 0
let checks = 0

function check(name: string, fn: () => void) {
  checks++
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg)
}

const settings: Settings = { units: 'lbs', restSeconds: 90, philosophy: 'balanced' }

function baseWorkout(partial: Partial<Workout>): Workout {
  return {
    id: 'w1',
    date: '2026-10-20',
    startedAt: 1760000000000,
    endedAt: 1760003600000,
    exercises: [
      {
        id: 'e1',
        name: 'Bench Press',
        muscleGroupId: 1,
        sets: [{ weight: 100, reps: 8, status: 'complete' }],
      },
    ],
    updatedAt: 1760003600000,
    ...partial,
  }
}

console.log('\nratings: coach context')
check('rated workout prints its joint soreness', () => {
  const out = compileWorkouts([baseWorkout({ ratings: { jointSoreness: 4 } })], settings)
  ok(out.includes('Joint soreness: 4 / 5'), `expected a joint soreness line, got:\n${out}`)
})
check('unrated performed workout prints nothing about joint soreness', () => {
  const out = compileWorkouts([baseWorkout({})], settings)
  ok(!/joint soreness/i.test(out), 'unrated workout must not mention joint soreness')
  ok(!/not rated/i.test(out), 'unrated workout must not read as "not rated"')
})
check('skipped workout never prints a rating, even if the record carries one', () => {
  const out = compileWorkouts(
    [baseWorkout({ status: 'skipped', exercises: [], ratings: { jointSoreness: 3 } })],
    settings,
  )
  ok(!/joint soreness/i.test(out), 'skipped workout must not print a joint soreness line')
  ok(!/not rated/i.test(out), 'skipped workout must not read as "not rated"')
})

console.log('\nratings: backward compatibility and sync')
check('pre-ratings record (no ratings key) decodes unchanged', () => {
  const legacy = JSON.parse(
    '{"id":"old1","date":"2025-01-05","startedAt":1736000000000,"exercises":[],"updatedAt":1736000000000,"weightUnit":"lbs"}',
  )
  const decoded = decodeWorkout(legacy, 'lbs')
  ok(decoded.ratings === undefined, 'legacy record must not gain a ratings field')
  ok(!('ratings' in decoded), 'legacy record must not gain a ratings key')
})
check('ratings survive the wire round trip in both unit pairings', () => {
  const w = baseWorkout({ ratings: { jointSoreness: 0 } })
  for (const from of ['lbs', 'kg'] as const) {
    const back = decodeWorkout(encodeWorkout(w, from), from)
    ok(back.ratings?.jointSoreness === 0, `ratings lost on ${from} round trip`)
  }
  const cross = decodeWorkout(encodeWorkout(w, 'lbs'), 'kg')
  ok(cross.ratings?.jointSoreness === 0, 'ratings lost on cross-unit round trip')
})
check('unrated workout stays unrated through the wire round trip', () => {
  const back = decodeWorkout(encodeWorkout(baseWorkout({}), 'lbs'), 'lbs')
  ok(back.ratings === undefined, 'unrated workout gained ratings in transit')
})

console.log('\nmuscle ratings: pump, soreness, recovery')
check('muscle feedback prints pump, soreness and recovery with the recovery legend', () => {
  const out = compileWorkouts(
    [baseWorkout({ muscleFeedback: [{ muscleGroupId: 1, pump: 2, soreness: 1, workload: 3, recovery: 0 }] })],
    settings,
  )
  ok(out.includes('pump 2'), 'pump missing from coach context')
  ok(out.includes('soreness 1'), 'soreness missing from coach context')
  ok(out.includes('recovery 0/3'), 'recovery missing from coach context')
  ok(out.includes('Recovery scale: 0 = not recovered'), 'recovery legend missing')
})
check('muscle feedback without recovery prints no recovery legend', () => {
  const out = compileWorkouts(
    [baseWorkout({ muscleFeedback: [{ muscleGroupId: 1, pump: 1, soreness: 0 }] })],
    settings,
  )
  ok(!/recovery/i.test(out), 'recovery must not appear when never rated')
})
check('recovery survives the wire round trip inside muscleFeedback', () => {
  const w = baseWorkout({ muscleFeedback: [{ muscleGroupId: 6, pump: 1, recovery: 3 }] })
  const back = decodeWorkout(encodeWorkout(w, 'kg'), 'kg')
  ok(back.muscleFeedback?.[0]?.recovery === 3, 'recovery lost in wire round trip')
  ok(back.muscleFeedback?.[0]?.pump === 1, 'pump lost in wire round trip')
})
check('old muscleFeedback (no recovery) decodes unchanged', () => {
  const w = baseWorkout({ muscleFeedback: [{ muscleGroupId: 6, pump: 1, soreness: 2, workload: 2 }] })
  const back = decodeWorkout(encodeWorkout(w, 'lbs'), 'lbs')
  ok(back.muscleFeedback?.[0]?.recovery === undefined, 'old feedback gained a recovery value')
})

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
