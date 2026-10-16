// TOM-99: after a metrics sync the chart readout named the wrong day, because the
// selected bar was an index. A backfill shifts every later index; a newer day leaves
// the old tip's index pointing at yesterday. Selection has to be a date, and a date
// the board actually picked has to survive a window that still contains it.
import assert from 'node:assert/strict'
const { resolveChartSelection, selectionAfterPick } =
  require('../src/chartSelection') as typeof import('../src/chartSelection')

const days = (...dates: string[]) => dates.map((date) => ({ date }))

function main() {
  let n = 0
  const check = (fn: () => void) => { fn(); n++ }

  const open = days('2026-10-08', '2026-10-09', '2026-10-10')

  check(() => {
    const r = resolveChartSelection(open, null)
    assert.equal(r.date, '2026-10-10')
    assert.equal(r.index, 2)
  })

  // The defect: Body is open on the tip, a sync appends a newer day. The old code
  // kept index 2, which is now the 10th, and the readout named that day.
  check(() => {
    const following = selectionAfterPick(open, 2)
    assert.equal(following.followNewest, true)
    const r = resolveChartSelection(days('2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'), following)
    assert.equal(r.date, '2026-10-11')
    assert.equal(r.index, 3)
  })

  // A backfill must not move a pinned reading, and must not move the tip either.
  // Under index selection both slide onto a different date.
  check(() => {
    const pinned = selectionAfterPick(open, 0)
    assert.deepEqual(pinned, { date: '2026-10-08', followNewest: false })
    const backfilled = days('2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10')
    assert.equal(resolveChartSelection(backfilled, pinned).date, '2026-10-08')
    assert.equal(resolveChartSelection(backfilled, selectionAfterPick(open, 2)).date, '2026-10-10')
  })

  // Same-length rolling window: the oldest day drops, a newer one arrives. A
  // historical pick that is still in the window stays. The tip follows the new day
  // instead of keeping yesterday's index.
  check(() => {
    const pinned = selectionAfterPick(open, 1)
    const rolled = days('2026-10-09', '2026-10-10', '2026-10-11')
    const kept = resolveChartSelection(rolled, pinned)
    assert.equal(kept.date, '2026-10-09')
    assert.equal(kept.index, 0)
    const followed = resolveChartSelection(rolled, selectionAfterPick(open, 2))
    assert.equal(followed.date, '2026-10-11')
    assert.equal(followed.index, 2)
  })

  // A pinned date that fell off the window falls back to the newest reading.
  check(() => {
    const pinned = selectionAfterPick(open, 0)
    const r = resolveChartSelection(days('2026-10-09', '2026-10-10', '2026-10-11'), pinned)
    assert.equal(r.date, '2026-10-11')
    assert.equal(r.index, 2)
  })

  console.log(`chartSelection: ${n} checks passed`)
}

main()
