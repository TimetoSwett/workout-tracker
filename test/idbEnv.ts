// Shared fixture for the storage*.check.ts suites: a fake localStorage (optionally size-capped,
// with failure switches) plus a fresh fake-indexeddb factory. Made-up data only.
import { IDBFactory } from 'fake-indexeddb'

export interface Env {
  mem: Map<string, string>
  idb: IDBFactory
  /** Total characters localStorage accepts before setItem throws QuotaExceededError (~5 MB of UTF-16). */
  quotaChars: number
  removeThrows: boolean
}

export function makeEnv(initial: Record<string, string> = {}): Env {
  return { mem: new Map(Object.entries(initial)), idb: new IDBFactory(), quotaChars: 2_500_000, removeThrows: false }
}

/** Installs the env's storage as the globals the app reads. Call again with the same env to simulate a relaunch. */
export function install(env: Env) {
  const g = globalThis as any
  g.localStorage = {
    getItem: (k: string) => env.mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      let total = v.length
      for (const [key, val] of env.mem) if (key !== k) total += val.length
      if (total > env.quotaChars) throw new DOMException('full', 'QuotaExceededError')
      env.mem.set(k, v)
    },
    removeItem: (k: string) => {
      if (env.removeThrows) throw new Error('removeItem failed')
      env.mem.delete(k)
    },
  }
  g.indexedDB = env.idb
}

const storePath = require.resolve('../src/store')
const dbPath = require.resolve('../src/historyDb')

/** A freshly evaluated store module, as after an app relaunch. Does not call initStore(). */
export function loadStore() {
  delete require.cache[storePath]
  delete require.cache[dbPath]
  return {
    store: require(storePath) as typeof import('../src/store'),
    db: require(dbPath) as typeof import('../src/historyDb'),
  }
}

export function fakeWorkout(n: number, exercises = 8): any {
  const id = `fake-${String(n).padStart(4, '0')}`
  return {
    id,
    date: '2025-01-01',
    startedAt: 1_735_689_600_000 + n * 86_400_000,
    updatedAt: 1_735_689_600_000 + n,
    name: `Fake session ${n}`,
    notes: 'made-up note '.repeat(10),
    exercises: Array.from({ length: exercises }, (_, e) => ({
      id: `${id}-ex${e}`,
      name: `Fake lift ${e}`,
      sets: Array.from({ length: 5 }, (_, s) => ({ weight: 100 + s, reps: 8, done: true, weightTarget: 100, repsTarget: 8, status: 'complete' })),
    })),
  }
}

export const histJson = (workouts: unknown[], mesocycles: unknown[] = []) => JSON.stringify({ workouts, mesocycles })

export async function readIdb(db: typeof import('../src/historyDb')): Promise<any> {
  return db.get(db.HISTORY_RECORD)
}
