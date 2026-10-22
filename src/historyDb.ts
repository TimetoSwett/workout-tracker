// Minimal IndexedDB key-value wrapper. Workout history is one record under one key:
// localStorage's ~5 MB quota cannot hold a large import, IndexedDB's quota is far higher.
const DB_NAME = 'wt'
const STORE = 'kv'

/** Key of the single record holding `{ schemaVersion, workouts, mesocycles }`. */
export const HISTORY_RECORD = 'history'

let cached: { factory: IDBFactory; db: Promise<IDBDatabase> } | null = null

function open(): Promise<IDBDatabase> {
  // Read the global each call so a swapped factory (tests, a reset) gets a fresh connection.
  const factory = globalThis.indexedDB
  if (!factory) return Promise.reject(new Error('IndexedDB is not available'))
  if (cached && cached.factory === factory) return cached.db
  const db = new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => {
      const d = req.result
      const drop = () => {
        if (cached?.db === db) cached = null
      }
      d.onclose = drop
      d.onversionchange = () => {
        d.close()
        drop()
      }
      resolve(d)
    }
    req.onerror = () => reject(req.error ?? new Error('Could not open IndexedDB'))
    req.onblocked = () => reject(new Error('IndexedDB open was blocked'))
  })
  cached = { factory, db }
  // Do not cache a failed open: the next call should try again.
  db.catch(() => {
    if (cached?.db === db) cached = null
  })
  return db
}

async function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction
    try {
      tx = db.transaction(STORE, mode)
    } catch (e) {
      // A closed connection throws here; drop it so the next call reopens.
      cached = null
      reject(e)
      return
    }
    let result: T
    const req = op(tx.objectStore(STORE))
    req.onsuccess = () => {
      result = req.result
    }
    // Resolve on commit, not on request success, so a resolved write is durable.
    tx.oncomplete = () => resolve(result)
    tx.onerror = () => reject(tx.error ?? req.error)
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'))
  })
}

export function get(key: string): Promise<unknown> {
  return run('readonly', (s) => s.get(key))
}

export function set(key: string, value: unknown): Promise<void> {
  return run('readwrite', (s) => s.put(value, key)).then(() => undefined)
}

export function del(key: string): Promise<void> {
  return run('readwrite', (s) => s.delete(key)).then(() => undefined)
}

export function clear(): Promise<void> {
  return run('readwrite', (s) => s.clear()).then(() => undefined)
}

/** Asks the browser not to evict this origin's storage under pressure. Best effort: failure is ignored. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false
    if (await navigator.storage.persisted?.()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}
