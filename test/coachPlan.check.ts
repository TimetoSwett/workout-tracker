// A coach reply that is a mesocycle becomes a plan the user can start, and the JSON
// does not stay in the chat. Ordinary prose is left alone.
import assert from 'node:assert/strict'
const {
  planSavedText,
  replyWithoutMesoJson,
  trainingWeekdaysFromLabels,
  tryParseMesoDraft,
  withUsableSchedule,
} = require('../src/mesoDraft') as typeof import('../src/mesoDraft')
const { buildMesoDraft } = require('../src/mesoDraft') as typeof import('../src/mesoDraft')

const json = `{
  "name": "Upper Hypertrophy",
  "goal": "Chest emphasis.",
  "unit": "lbs",
  "weeksPlanned": 5,
  "deloadWeek": 4,
  "days": [
    { "label": "Sunday — Press", "exercises": [{ "name": "Smith Machine Bench Press", "muscleGroupId": 1, "sets": 4, "repTarget": [4, 8] }] },
    { "label": "Monday — Legs", "exercises": [{ "name": "Leg Press", "muscleGroupId": 6, "sets": 3, "repTarget": [6, 10] }] }
  ],
  "priorities": [{ "muscleGroupId": 1, "type": "emphasize" }]
}`

function main() {
  assert.equal(tryParseMesoDraft('How many days can you train?'), null)
  const parsed = tryParseMesoDraft('Here is the plan:\n```json\n' + json + '\n```')
  assert.ok(parsed)
  assert.equal(parsed!.name, 'Upper Hypertrophy')
  assert.deepEqual(trainingWeekdaysFromLabels(['Sunday — Press', 'Monday — Legs']), [0, 1])
  assert.equal(trainingWeekdaysFromLabels(['Push', 'Pull']), null)
  assert.equal(trainingWeekdaysFromLabels(['Friday', 'Monday']), null)

  const { meso } = buildMesoDraft(parsed!, new Set())
  const ready = withUsableSchedule(meso, '2026-11-15')
  assert.equal(ready.startDate, '2026-11-15')
  assert.deepEqual(ready.trainingWeekdays, [0, 1])
  assert.equal(ready.status, 'active')

  const shown = replyWithoutMesoJson('Here is the plan:\n```json\n' + json + '\n```', planSavedText(ready))
  assert.equal(shown.startsWith('Here is the plan:'), true)
  assert.equal(shown.includes('```'), false)
  assert.equal(shown.includes('"weeksPlanned"'), false)
  assert.equal(shown.includes('Saved “Upper Hypertrophy” as your active plan.'), true)
  assert.equal(replyWithoutMesoJson(json, 'saved'), 'saved')
  console.log('coachPlan: ok')
}

main()
