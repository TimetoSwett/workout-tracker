/** Two-device sync checks: the same board, two phones, one Dropbox folder, and in the
 *  interesting cases a different `settings.units` on each.
 *
 *  `weightWire.check.ts` covers the codec. This covers the wiring — that `sync()` and
 *  `syncMetrics()` actually put every download through `decode*` and every upload through
 *  `encode*`, which is where the original defect lived.
 *
 *  Each "device" is a fresh import of the store modules over its own localStorage, with
 *  `dropbox.ts` replaced by an in-memory folder both devices share. Run with `npm run check`. */
import type { DailyMetric, Workout } from '../src/types'
import type { Units } from '../src/units'

let failures = 0
let checks = 0

function check(name: string, fn: () => Promise<void> | void) {
  checks++
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok   ${name}`))
    .catch((e: Error) => {
      failures++
      console.log(`  FAIL ${name}\n       ${e.message}`)
    })
}

function eq(actual: unknown, expected: unknown, what: string) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`)
}

/** The shared Dropbox folder, keyed by the paths `sync.ts`/`metricsSync.ts` use. */
let cloud: Record<string, string> = {}
let uploads = 0

const dropboxStub = {
  dropboxConfigured: () => true,
  dropboxDownload: async (path = '/workouts.jsonl') => ({ content: cloud[path] ?? null }),
  dropboxUpload: async (content: string, path = '/workouts.jsonl') => {
    uploads++
    cloud[path] = content
    return null
  },
}

const APP_MODULES = ['store', 'metricsStore', 'sync', 'metricsSync', 'weightWire', 'units', 'dropbox']

/** A phone: its own localStorage, its own module instances, the shared folder. */
async function device(units: Units, storage: Record<string, string> = {}) {
  for (const m of APP_MODULES) delete require.cache[require.resolve(`../src/${m}`)]
  // `sync.ts` only knows the real Dropbox module; swapping it in the module cache is what
  // lets these checks run with no network and no credentials.
  require.cache[require.resolve('../src/dropbox')] = {
    id: require.resolve('../src/dropbox'),
    filename: require.resolve('../src/dropbox'),
    loaded: true,
    exports: dropboxStub,
  } as NodeJS.Module

  const g = globalThis as unknown as { localStorage: unknown }
  g.localStorage = {
    getItem: (k: string) => storage[k] ?? null,
    setItem: (k: string, v: string) => {
      storage[k] = v
    },
    removeItem: (k: string) => {
      delete storage[k]
    },
  }

  const store = await import('../src/store')
  const metricsStore = await import('../src/metricsStore')
  const { sync } = await import('../src/sync')
  const { syncMetrics } = await import('../src/metricsSync')

  const s = store.getState()
  store.setSettings({ ...s.settings, units, dropboxToken: 't', dropboxTokenExpiresAt: Date.now() + 3.6e6 })
  return { storage, store, metricsStore, sync, syncMetrics, units }
}

function workout(weight: number, bodyweight: number): Workout {
  return {
    id: 'w1',
    date: '2026-09-28',
    startedAt: 1_759_000_000_000,
    updatedAt: 1_759_000_100_000,
    exercises: [{ id: 'e1', name: 'Bench Press', sets: [{ weight, reps: 8, weightTarget: weight }] }],
    bodyweight,
  }
}

function metric(weight: number, updatedAt = 1_759_000_100_000): DailyMetric {
  return { date: '2026-09-28', weight, bodyFat: 18.2, updatedAt, source: 'manual' }
}

const benchOn = (d: { store: { getState: () => { workouts: Workout[] } } }) =>
  d.store.getState().workouts[0].exercises[0].sets[0].weight

/** The same two weights written out in both units, so the expected reading on the
 *  receiving phone is stated rather than recomputed by the code under test. */
const BENCH = { lbs: 140, kg: 63.5 }
const BODY = { lbs: 178.4, kg: 80.9 }
const PAIRINGS: [Units, Units][] = [
  ['lbs', 'lbs'],
  ['lbs', 'kg'],
  ['kg', 'kg'],
  ['kg', 'lbs'],
]

async function main() {
  console.log('\nworkouts across two phones')
  for (const [sender, receiver] of PAIRINGS) {
    await check(`${sender} phone logs ${BENCH[sender]} -> ${receiver} phone reads ${BENCH[receiver]}`, async () => {
      cloud = {}
      const a = await device(sender)
      a.store.setHistory([workout(BENCH[sender], BODY[sender])], [])
      eq(await a.sync(), null, 'sender sync succeeded')

      const b = await device(receiver)
      eq(await b.sync(), null, 'receiver sync succeeded')
      eq(benchOn(b), BENCH[receiver], 'bench weight as the receiver sees it')
      eq(b.store.getState().workouts[0].bodyweight, BODY[receiver], 'bodyweight')
    })
  }

  console.log('\nthe defect QA reported, through sync()')
  await check('switching one phone to kg does not turn 140 lbs into "63.5 lbs" on the other', async () => {
    cloud = {}
    const a = await device('lbs')
    a.store.setHistory([workout(140, 178.4)], [])
    await a.sync()

    const b = await device('lbs')
    await b.sync()
    eq(benchOn(b), 140, 'both phones agree before the switch')

    // Phone A switches to kg. `convertStoredWeights` rewrites A's storage and bumps
    // `updatedAt`, so A's record wins the merge on B.
    const a2 = await device('lbs', a.storage)
    const { convertStoredWeights } = await import('../src/unitsMigration')
    convertStoredWeights('lbs', 'kg')
    eq(benchOn(a2), 63.5, 'phone A now stores kg locally')
    eq(await a2.sync(), null, 'phone A re-syncs')

    const b2 = await device('lbs', b.storage)
    await b2.sync()
    eq(benchOn(b2), 140, 'phone B, still in lbs, still reads 140 lbs')
    eq(b2.store.getState().workouts[0].bodyweight, 178.4, 'and 178.4 lbs bodyweight')
  })

  console.log('\nbody metrics across two phones')
  for (const [sender, receiver] of PAIRINGS) {
    await check(`${sender} phone logs ${BODY[sender]} -> ${receiver} phone reads ${BODY[receiver]}`, async () => {
      cloud = {}
      const a = await device(sender)
      a.metricsStore.setMetrics([metric(BODY[sender])])
      eq(await a.syncMetrics(), null, 'sender sync succeeded')

      const b = await device(receiver)
      eq(await b.syncMetrics(), null, 'receiver sync succeeded')
      eq(b.metricsStore.getMetrics()[0].weight, BODY[receiver], 'weight as the receiver sees it')
      eq(b.metricsStore.getMetrics()[0].bodyFat, 18.2, 'body fat is a percentage and must not convert')
    })
  }

  console.log('\nlegacy data already in Dropbox, written before weights were tagged')
  await check('untagged records are read as the receiving phone\'s units and then tagged', async () => {
    // Exactly what the board's folder holds today: bare numbers, no `weightUnit`.
    cloud = { '/workouts.jsonl': JSON.stringify(workout(140, 178.4)) + '\n' }
    const b = await device('lbs')
    eq(await b.sync(), null, 'sync succeeded')
    eq(benchOn(b), 140, 'read verbatim on the lbs phone that wrote it')
    eq(JSON.parse(cloud['/workouts.jsonl'].trim()).weightUnit, 'kg', 'and re-uploaded tagged')

    // The documented limitation: nothing in an untagged payload says what it means, so a
    // kg phone reading the same legacy file reads 140 as 140 kg. Tagging stops this
    // happening to anything written from here on; it cannot retro-fix what is already there.
    cloud = { '/workouts.jsonl': JSON.stringify(workout(140, 178.4)) + '\n' }
    const c = await device('kg')
    await c.sync()
    eq(benchOn(c), 140, 'a kg phone reads the same untagged 140 as 140 kg')
  })

  await check('an untagged remote file is re-uploaded even when no record changed', async () => {
    // `changedRemote` only looks at `updatedAt`, so without the untagged check the folder
    // would stay ambiguous until the board next edited something.
    cloud = { '/workouts.jsonl': JSON.stringify(workout(140, 178.4)) + '\n' }
    const b = await device('lbs')
    b.store.setHistory([workout(140, 178.4)], [])
    uploads = 0
    await b.sync()
    eq(uploads > 0, true, 'the ambiguous file was rewritten')

    // Second pass: everything is tagged now, nothing changed, so nothing is uploaded.
    const c = await device('lbs', b.storage)
    uploads = 0
    await c.sync()
    eq(uploads, 0, 'an already-tagged, unchanged folder is left alone')
  })

  console.log(`\n${checks - failures}/${checks} checks passed`)
  if (failures) process.exit(1)
}

void main()
