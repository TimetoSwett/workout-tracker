/** Checks for the "Show AI features" switch (TOM-28).
 *
 *  The views decide what to show from `aiFeaturesEnabled`, which is easy to read. What
 *  these checks cover is the part a screenshot cannot show: that with the switch off no
 *  request reaches a provider, that a call already on the wire is dropped, that the
 *  preference survives a reload, and that turning it back on restores the feature with the
 *  provider configuration untouched.
 *
 *  Each "install" is a fresh import of the app modules over its own localStorage and its
 *  own `fetch` recorder, so nothing a check does leaks into the next. Run with
 *  `npm run check`. */
import type { AISettings } from '../src/types'

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

const AI: AISettings = { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-test', baseUrl: '' }

const APP_MODULES = ['store', 'ai', 'aiGate', 'coachStore', 'dropbox']

/** The shared Dropbox folder `coachStore` talks to, and a tally of the calls it made. */
let cloud: Record<string, string> = {}
let dropboxCalls = 0

const dropboxStub = {
  REVISION_CONFLICT: 'revision conflict',
  dropboxConfigured: () => true,
  dropboxDownload: async (path: string) => {
    dropboxCalls++
    return { content: cloud[path] ?? null, rev: '0' }
  },
  dropboxUpload: async (content: string, path: string) => {
    dropboxCalls++
    cloud[path] = content
    return null
  },
}

interface Call {
  url: string
  signal?: AbortSignal
}

/** One install: its own storage, its own module instances, no real network. */
async function install(storage: Record<string, string> = {}) {
  for (const m of APP_MODULES) delete require.cache[require.resolve(`../src/${m}`)]
  require.cache[require.resolve('../src/dropbox')] = {
    id: require.resolve('../src/dropbox'),
    filename: require.resolve('../src/dropbox'),
    loaded: true,
    exports: dropboxStub,
  } as NodeJS.Module

  const g = globalThis as unknown as { localStorage: unknown; fetch: unknown }
  g.localStorage = {
    getItem: (k: string) => storage[k] ?? null,
    setItem: (k: string, v: string) => {
      storage[k] = v
    },
    removeItem: (k: string) => {
      delete storage[k]
    },
  }

  const calls: Call[] = []
  /** Set by a check that wants the request to hang, so an abort is the only way out. */
  let hang = false
  g.fetch = (url: string, init?: { signal?: AbortSignal }) => {
    calls.push({ url: String(url), signal: init?.signal })
    if (hang) return new Promise(() => {})
    return Promise.resolve({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'OK' }] }),
    })
  }

  const store = await import('../src/store')
  const { aiFeaturesEnabled } = await import('../src/aiGate')
  const { aiChat, isCancelled } = await import('../src/ai')
  const { syncCoach, upsertThread } = await import('../src/coachStore')

  function setAIEnabled(enabled: boolean) {
    store.setSettings({ ...store.getState().settings, aiEnabled: enabled })
  }
  const enabled = () => aiFeaturesEnabled(store.getState().settings)
  const ask = (ai: AISettings = store.getState().settings.ai ?? AI) =>
    aiChat(ai, 'system', [{ role: 'user' as const, content: 'hi' }])

  return {
    storage,
    calls,
    store,
    enabled,
    setAIEnabled,
    ask,
    isCancelled,
    syncCoach,
    upsertThread,
    hangNextCall: () => {
      hang = true
    },
  }
}

/** An install whose provider is already configured, as the board's phone is. */
async function configured(storage?: Record<string, string>) {
  const d = await install(storage)
  d.store.setSettings({ ...d.store.getState().settings, ai: AI })
  return d
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p
  } catch (e) {
    return e as Error
  }
  throw new Error('expected a rejection, but the call resolved')
}

async function main() {
  console.log('\ndefault preserves the behavior the board already had')
  await check('an install that has never seen the switch keeps AI on and calls the provider', async () => {
    const d = await configured()
    eq(d.enabled(), true, 'AI features enabled')
    eq('aiEnabled' in d.store.getState().settings, false, 'no preference was written')
    eq(await d.ask(), 'OK', 'provider reply')
    eq(d.calls.length, 1, 'provider requests')
    eq(d.calls[0].url, 'https://api.anthropic.com/v1/messages', 'request URL')
  })

  console.log('\noff suppresses every provider request')
  await check('aiChat refuses without touching the network', async () => {
    const d = await configured()
    d.setAIEnabled(false)
    eq(d.enabled(), false, 'AI features disabled')
    const e = await rejection(d.ask())
    eq(e.name, 'AIDisabled', 'rejection name')
    eq(d.calls.length, 0, 'provider requests')
  })

  await check('a caller holding its own AISettings copy still cannot reach a provider', async () => {
    const d = await configured()
    const captured = { ...AI }
    d.setAIEnabled(false)
    eq((await rejection(d.ask(captured))).name, 'AIDisabled', 'rejection name')
    eq(d.calls.length, 0, 'provider requests')
  })

  await check('the coach file stops syncing, and the stored conversation is left intact', async () => {
    cloud = {}
    const d = await configured()
    d.upsertThread({
      id: 't1',
      title: 'Leg day review',
      createdAt: 1,
      updatedAt: 2,
      philosophy: 'balanced',
      weeks: 4,
      messages: [{ role: 'user', content: 'how did it go?', at: 2 }],
    })
    const thread = JSON.parse(d.storage['wt.coach.v1']) as unknown
    d.setAIEnabled(false)
    dropboxCalls = 0
    eq(await d.syncCoach(), null, 'syncCoach reports no error')
    eq(dropboxCalls, 0, 'Dropbox calls')
    eq(JSON.parse(d.storage['wt.coach.v1']), thread, 'stored conversation')
    eq(cloud, {}, 'remote coach file')
  })

  await check('a request already on the wire is aborted, and not reported as an error', async () => {
    const d = await configured()
    d.hangNextCall()
    const pending = d.ask()
    eq(d.calls.length, 1, 'request started')
    eq(d.calls[0].signal?.aborted, false, 'signal before the switch flips')
    d.setAIEnabled(false)
    const e = await rejection(pending)
    eq(d.isCancelled(e), true, 'treated as a cancel, so the coach shows no error')
    eq(d.calls[0].signal?.aborted, true, 'the request was aborted')
  })

  console.log('\nthe preference survives a reload')
  await check('off is persisted and still off after a fresh load of the same storage', async () => {
    const d = await configured()
    d.setAIEnabled(false)
    eq(JSON.parse(d.storage['wt.active.v1']).settings.aiEnabled, false, 'persisted preference')

    // A reload: same localStorage, brand-new module instances.
    const reloaded = await install(d.storage)
    eq(reloaded.enabled(), false, 'still off after reload')
    eq((await rejection(reloaded.ask(AI))).name, 'AIDisabled', 'rejection name')
    eq(reloaded.calls.length, 0, 'provider requests')
    eq(reloaded.store.getState().settings.ai, AI, 'provider configuration survived')
  })

  await check('on is persisted too, so it is not mistaken for "never set"', async () => {
    const d = await configured()
    d.setAIEnabled(false)
    d.setAIEnabled(true)
    eq(JSON.parse(d.storage['wt.active.v1']).settings.aiEnabled, true, 'persisted preference')
    eq((await install(d.storage)).enabled(), true, 'on after reload')
  })

  console.log('\non again restores the feature')
  await check('re-enabling calls the provider with the configuration that was kept', async () => {
    const d = await configured()
    d.setAIEnabled(false)
    await rejection(d.ask())
    d.setAIEnabled(true)
    eq(await d.ask(), 'OK', 'provider reply')
    eq(d.calls.length, 1, 'provider requests')
    eq(d.store.getState().settings.ai, AI, 'provider configuration unchanged by the round trip')
  })

  await check('re-enabling after a reload resumes the coach file sync', async () => {
    cloud = {}
    const d = await configured()
    d.setAIEnabled(false)
    const reloaded = await install(d.storage)
    reloaded.upsertThread({
      id: 't2',
      title: 'Push day',
      createdAt: 1,
      updatedAt: 2,
      philosophy: 'balanced',
      weeks: 4,
      messages: [],
    })
    dropboxCalls = 0
    eq(await reloaded.syncCoach(), null, 'sync while off')
    eq(dropboxCalls, 0, 'Dropbox calls while off')
    reloaded.setAIEnabled(true)
    eq(await reloaded.syncCoach(), null, 'sync once on')
    if (dropboxCalls === 0) throw new Error('expected the coach file to sync once AI is back on')
    if (!cloud['/coach.jsonl']?.includes('"t2"')) throw new Error('expected the thread to reach the remote coach file')
  })

  console.log(`\n${checks - failures}/${checks} checks passed`)
  if (failures) process.exit(1)
}

void main()
