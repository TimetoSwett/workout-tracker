// Reusing a plan keeps its weekday pattern but not its start date.
import assert from 'node:assert/strict'
import type { Mesocycle } from '../src/types'
const { cloneMesoAsTemplate } = require('../src/mesoClone') as typeof import('../src/mesoClone')

function ids() {
  let n = 0
  return () => `new-${++n}`
}

const base: Mesocycle = {
  id: 'rp-1',
  name: 'Upper Lower',
  unit: 'lbs',
  weeksPlanned: 5,
  days: [{ id: 'd', label: 'Upper', exercises: [{ id: 'e', name: 'Bench Press', sets: 3 }] }],
  priorities: [],
  status: 'complete',
  createdAt: 1,
  updatedAt: 1,
  imported: true,
}

{
  const src = { ...base, startDate: '2026-01-05', trainingWeekdays: [1, 3, 5] }
  const copy = cloneMesoAsTemplate(src, 50, ids())
  assert.deepEqual(copy.trainingWeekdays, [1, 3, 5])
  assert.notEqual(copy.trainingWeekdays, src.trainingWeekdays)
  assert.equal('startDate' in copy, false)
  assert.deepEqual(src.trainingWeekdays, [1, 3, 5])
  assert.equal(src.startDate, '2026-01-05')
}

{
  const copy = cloneMesoAsTemplate(base, 50, ids())
  assert.equal('trainingWeekdays' in copy, false)
  assert.equal('startDate' in copy, false)
}

console.log('clone schedule checks passed')
