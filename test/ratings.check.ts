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
import { jointSorenessText, muscleFeedbackLines } from '../src/ratings'
import { parseRpExport } from '../src/rpImport'
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
check('skipped workout prints no Muscle feedback line, even if the record carries feedback', () => {
  const out = compileWorkouts(
    [
      baseWorkout({
        status: 'skipped',
        exercises: [],
        muscleFeedback: [{ muscleGroupId: 1, pump: 2, soreness: 1, workload: 3, recovery: 3 }],
      }),
    ],
    settings,
  )
  ok(!/Muscle feedback/i.test(out), 'skipped workout must not print a Muscle feedback line')
  ok(!/Recovery scale/i.test(out), 'skipped workout must not print the recovery legend')
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

console.log('\nratings: History display')
check('History shows joint soreness when set, including a real 0', () => {
  ok(jointSorenessText(baseWorkout({ ratings: { jointSoreness: 4 } })) === 'Joint soreness: 4 / 5', 'rated 4 not shown')
  ok(jointSorenessText(baseWorkout({ ratings: { jointSoreness: 0 } })) === 'Joint soreness: 0 / 5', 'rated 0 must show')
})
check('History shows nothing for unrated workouts', () => {
  ok(jointSorenessText(baseWorkout({})) === null, 'unrated workout produced a joint line')
  ok(muscleFeedbackLines(baseWorkout({}), undefined).length === 0, 'unrated workout produced muscle lines')
})
check('History shows nothing at all for skipped workouts', () => {
  const skipped = baseWorkout({
    status: 'skipped',
    exercises: [],
    ratings: { jointSoreness: 3 },
    muscleFeedback: [{ muscleGroupId: 1, pump: 2, soreness: 1, recovery: 3 }],
  })
  ok(jointSorenessText(skipped) === null, 'skipped workout produced a joint line')
  ok(muscleFeedbackLines(skipped, undefined).length === 0, 'skipped workout produced muscle lines')
})
check('History shows per-muscle pump, soreness, workload and recovery', () => {
  const lines = muscleFeedbackLines(
    baseWorkout({
      muscleFeedback: [
        { muscleGroupId: 1, pump: 2, soreness: 1, workload: 3, recovery: 0 },
        { muscleGroupId: 6, soreness: 2 },
        { muscleGroupId: 2 },
      ],
    }),
    undefined,
  )
  ok(lines.length === 2, `expected 2 muscle lines, got ${lines.length}`)
  ok(lines[0] === 'Chest: pump 2 · soreness 1 · workload 3 · recovery 0/3', `unexpected first line: ${lines[0]}`)
  ok(lines[1] === 'Quads: soreness 2', `unexpected second line: ${lines[1]}`)
})

console.log('\nratings: RP import jointPain mapping (hand-made fixture, invented values)')
check('jointPain 0-3 maps to joint soreness 0, 2, 3, 5 by the day max; all-null stays unrated', () => {
  const day = (id: number, jointPains: (number | null | undefined)[]) => ({
    id,
    week: 0,
    position: id,
    status: 'complete',
    createdAt: '2026-01-05T15:00:00.000Z',
    updatedAt: '2026-01-05T16:00:00.000Z',
    exercises: jointPains.map((jointPain, i) => ({
      id: id * 100 + i,
      name: `Fixture Lift ${id}-${i}`,
      ...(jointPain !== undefined ? { jointPain } : {}),
      sets: [],
    })),
    muscleGroups: [{ muscleGroupId: 1, pump: 2, soreness: 1, workload: 2 }],
  })
  const fixture = JSON.stringify([
    {
      id: 9001,
      name: 'Fixture Meso',
      unit: 'lbs',
      createdAt: '2026-01-05T00:00:00.000Z',
      updatedAt: '2026-01-05T16:00:00.000Z',
      weeks: [{ days: [day(101, [1, 3, null]), day(102, [1, null]), day(103, [2, 0]), day(104, [0]), day(105, [null, undefined])] }],
    },
  ])
  const { workouts } = parseRpExport(fixture)
  const byId = new Map(workouts.map((w) => [w.id, w]))
  ok(byId.get('rp-day-101')?.ratings?.jointSoreness === 5, `max 3 must map to 5, got ${byId.get('rp-day-101')?.ratings?.jointSoreness}`)
  ok(byId.get('rp-day-102')?.ratings?.jointSoreness === 2, `max 1 must map to 2, got ${byId.get('rp-day-102')?.ratings?.jointSoreness}`)
  ok(byId.get('rp-day-103')?.ratings?.jointSoreness === 3, `max 2 must map to 3, got ${byId.get('rp-day-103')?.ratings?.jointSoreness}`)
  ok(byId.get('rp-day-104')?.ratings?.jointSoreness === 0, 'max 0 must map to a real 0 rating')
  ok(byId.get('rp-day-105')?.ratings === undefined, 'all-null jointPain must leave ratings unset')
  ok(
    byId.get('rp-day-101')?.muscleFeedback?.[0]?.recovery === undefined,
    'recovery must stay unset on import',
  )
})

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
