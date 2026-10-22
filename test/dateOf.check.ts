// Local-date helpers: parsing, day arithmetic across DST, and dateOf's fallback to startedAt.
import assert from 'node:assert/strict'
const { addDays, compareLocalDates, dateOf, dateRange, isLocalDate, localDate, parseLocalDate, weekdayOf } =
  require('../src/dates') as typeof import('../src/dates')

/** Runs `fn` under a fixed TZ; Node re-reads process.env.TZ on assignment. */
function inTZ(tz: string, fn: () => void) {
  const prev = process.env.TZ
  process.env.TZ = tz
  try {
    fn()
  } finally {
    if (prev === undefined) delete process.env.TZ
    else process.env.TZ = prev
  }
}

const ZONES = ['UTC', 'America/Los_Angeles', 'Europe/London', 'Pacific/Auckland']

for (const tz of ZONES) {
  inTZ(tz, () => {
    // parse / validate
    assert.equal(isLocalDate('2026-03-08'), true, tz)
    assert.equal(isLocalDate('2028-02-29'), true, tz)
    for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-1-1', '', 'nope', '2026-03-08T00:00', ' 2026-03-08'])
      assert.equal(isLocalDate(bad), false, `${tz} ${bad}`)
    assert.equal(isLocalDate('2027-02-29'), false, tz)
    assert.equal(parseLocalDate('2026-02-30'), null, tz)
    const p = parseLocalDate('2026-03-08')!
    assert.deepEqual([p.getFullYear(), p.getMonth(), p.getDate(), p.getHours(), p.getMinutes()], [2026, 2, 8, 0, 0], tz)

    // arithmetic across both US DST transitions
    assert.equal(addDays('2026-03-07', 1), '2026-03-08', tz)
    assert.equal(addDays('2026-03-08', 1), '2026-03-09', tz)
    assert.equal(addDays('2026-03-09', -2), '2026-03-07', tz)
    assert.equal(addDays('2026-10-31', 1), '2026-11-01', tz)
    assert.equal(addDays('2026-11-01', 1), '2026-11-02', tz)
    assert.equal(addDays('2026-12-31', 1), '2027-01-01', tz)
    assert.equal(addDays('2026-03-01', 0), '2026-03-01', tz)
    assert.equal(addDays('2026-01-01', 365), '2027-01-01', tz)
    assert.throws(() => addDays('2026-02-30', 1), RangeError)

    assert.deepEqual(
      dateRange('2026-03-06', '2026-03-10'),
      ['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10'],
      tz,
    )
    assert.deepEqual(
      dateRange('2026-10-30', '2026-11-03'),
      ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03'],
      tz,
    )
    assert.deepEqual(dateRange('2026-03-08', '2026-03-08'), ['2026-03-08'], tz)
    assert.deepEqual(dateRange('2026-03-09', '2026-03-08'), [], tz)
    assert.deepEqual(dateRange('bad', '2026-03-08'), [], tz)
    assert.equal(dateRange('2026-01-01', '2026-12-31').length, 365, tz)

    assert.equal(weekdayOf('2026-03-08'), 0, tz) // Sunday
    assert.equal(weekdayOf('2026-11-01'), 0, tz)
    assert.equal(weekdayOf('2026-03-09'), 1, tz)
    assert.equal(weekdayOf('2026-03-14'), 6, tz)
    assert.throws(() => weekdayOf(''), RangeError)

    assert.equal(compareLocalDates('2026-03-08', '2026-03-08'), 0, tz)
    assert.ok(compareLocalDates('2026-03-07', '2026-03-08') < 0, tz)
    assert.ok(compareLocalDates('2027-01-01', '2026-12-31') > 0, tz)

    // dateOf
    assert.equal(dateOf({ date: '2026-03-08', startedAt: new Date(2026, 5, 1).getTime() }), '2026-03-08', tz)
    for (const bad of ['', '2026-02-30', 'garbage'])
      assert.equal(dateOf({ date: bad, startedAt: new Date(2026, 2, 8, 12).getTime() }), '2026-03-08', `${tz} ${JSON.stringify(bad)}`)
    assert.equal(dateOf({ startedAt: new Date(2026, 2, 8, 23, 59).getTime() }), '2026-03-08', tz) // stays that local day
    assert.equal(dateOf({ date: '', startedAt: new Date(2026, 2, 8, 0, 0).getTime() }), '2026-03-08', tz)
    assert.equal(dateOf({ date: '', startedAt: NaN }), undefined, tz)
    assert.equal(dateOf({ date: '', startedAt: Infinity }), undefined, tz)
    assert.equal(dateOf({ date: '', startedAt: 8.64e15 + 1 }), undefined, tz)
    assert.equal(dateOf({}), undefined, tz)

    // never mutates
    const w = { date: '2026-02-30', startedAt: new Date(2026, 2, 8, 9).getTime() }
    const snapshot = { ...w }
    dateOf(w)
    assert.deepEqual(w, snapshot, tz)
  })
}

// The same instant is a different local day in different zones; dateOf follows the machine zone.
const instant = Date.UTC(2026, 2, 9, 3, 30) // 03:30Z Mar 9
inTZ('America/Los_Angeles', () => assert.equal(dateOf({ startedAt: instant }), '2026-03-08'))
inTZ('Pacific/Auckland', () => assert.equal(dateOf({ startedAt: instant }), '2026-03-09'))
inTZ('America/Los_Angeles', () => assert.equal(localDate(new Date(instant)), '2026-03-08'))

console.log('dateOf.check: ok')
