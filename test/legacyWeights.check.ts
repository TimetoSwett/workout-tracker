import assert from 'node:assert/strict'
import type { Declaration } from '../src/legacyWeights'
let cloud: Record<string, string> = {}
let revs: Record<string, number> = {}
let beforeWrite: (() => void) | undefined
let failBackup = false
const path = '/workouts.jsonl'
const raw = '{ "id":"w1", "bodyweight":178.46,"exercises":[{"sets":[{"weight":102.25}]}] }\n'
require.cache[require.resolve('../src/dropbox')] = {
  id: require.resolve('../src/dropbox'), filename: require.resolve('../src/dropbox'), loaded: true,
  exports: {
    REVISION_CONFLICT: 'conflict',
    dropboxDownload: async (p: string) => ({ content: cloud[p] ?? null, rev: String(revs[p] ?? 0) }),
    dropboxUpload: async (content: string, p: string, rev: string | null) => {
      if (p !== path && failBackup) return 'backup denied'
      if (p === path && beforeWrite) { const f = beforeWrite; beforeWrite = undefined; f() }
      if (rev !== (cloud[p] == null ? null : String(revs[p] ?? 0))) return 'conflict'
      cloud[p] = content; revs[p] = (revs[p] ?? 0) + 1; return null
    },
  },
} as NodeJS.Module
const { tagLegacyContent, migrateLegacyFile } = require('../src/legacyWeights') as typeof import('../src/legacyWeights')
const declaration: Declaration[] = [{ raw: raw.trimEnd(), unit: 'lbs' }]
let checks = 0
async function check(name: string, fn: () => void | Promise<void>) { await fn(); checks++; console.log('  ok  ' + name) }
async function main() {
  await check('178.46 lbs / 102.25 tagged without changing numeric literals, with raw recovery', async () => {
    cloud = { [path]: raw }; revs = {}
    const backup = await migrateLegacyFile({ path, content: raw, rev: '0' }, declaration)
    assert.equal(cloud[backup], raw)
    const record = JSON.parse(cloud[path])
    assert.equal(record.bodyweight, 178.46); assert.equal(record.exercises[0].sets[0].weight, 102.25); assert.equal(record.weightUnit, 'lbs')
    assert.equal(cloud[path].replace(',"weightUnit":"lbs"', ''), raw)
    const { decodeWorkout, encodeWorkout } = require('../src/weightWire') as typeof import('../src/weightWire')
    assert.equal(encodeWorkout(decodeWorkout(record, 'lbs'), 'lbs').bodyweight, 178.46)
  })
  await check('body metrics preserve 178.46 and 102.25; mixed units need individual declarations', () => {
    const a = '{"date":"2026-10-01","weight":178.46,"leanMass":102.25}'
    const b = '{"date":"2026-10-02","weight":80.123}'
    const content = a + '\n' + b + '\n'
    assert.throws(() => tagLegacyContent(content, [{ raw: a, unit: 'lbs' }]))
    const result = tagLegacyContent(content, [{ raw: a, unit: 'lbs' }, { raw: b, unit: 'kg' }])
    const records = result.trim().split('\n').map(x => JSON.parse(x))
    assert.equal(records[0].weight, 178.46); assert.equal(records[0].leanMass, 102.25); assert.equal(records[1].weight, 80.123)
    assert.equal(records[0].weightUnit, 'lbs'); assert.equal(records[1].weightUnit, 'kg')
  })
  await check('backup failure leaves original unchanged', async () => {
    cloud = { [path]: raw }; revs = {}; failBackup = true
    await assert.rejects(migrateLegacyFile({ path, content: raw, rev: '0' }, declaration), /Backup failed/)
    assert.equal(cloud[path], raw); failBackup = false
  })
  await check('simultaneous differing-unit migrators cannot overwrite first declaration', async () => {
    cloud = { [path]: raw }; revs = {}
    const file = { path, content: raw, rev: '0' }
    const result = await Promise.allSettled([migrateLegacyFile(file, declaration), migrateLegacyFile(file, [{ raw: raw.trimEnd(), unit: 'kg' }])])
    assert.equal(result.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal(result.filter(r => r.status === 'rejected').length, 1)
    assert.equal(JSON.parse(cloud[path]).weightUnit, 'lbs')
  })
  await check('intervening tagged record survives re-read/merge with backup of latest revision', async () => {
    cloud = { [path]: raw }; revs = {}
    const other = '{"id":"other","bodyweight":80.123,"weightUnit":"kg"}\n'
    beforeWrite = () => { cloud[path] += other; revs[path] = 1 }
    await migrateLegacyFile({ path, content: raw, rev: '0' }, declaration)
    assert.ok(cloud[path].endsWith(other)); assert.equal(JSON.parse(cloud[path].split('\n')[0]).bodyweight, 178.46)
    assert.ok(Object.entries(cloud).some(([p, value]) => p !== path && value === raw + other))
  })
  await check('new unknown, changed record, malformed JSON and invalid tags never get guessed', async () => {
    for (const extra of ['{"id":"new","bodyweight":80}\n', '{bad}\n']) {
      cloud = { [path]: raw }; revs = {}
      beforeWrite = () => { cloud[path] += extra; revs[path] = 1 }
      await assert.rejects(migrateLegacyFile({ path, content: raw, rev: '0' }, declaration))
      assert.equal(cloud[path], raw + extra)
    }
    assert.throws(() => tagLegacyContent(raw.replace('178.46', '178.47'), declaration))
    assert.throws(() => tagLegacyContent('{"weight":178.46,"weightUnit":"stone"}', []))
  })
  console.log(`${checks}/${checks} migration checks passed`)
}
main().catch(e => { console.error(e); process.exit(1) })
