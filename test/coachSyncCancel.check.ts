/** Real coach + Dropbox transport, synthetic data and deliberately delayed fetches. */
import assert from 'node:assert/strict'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function scenario(stage: 'download' | 'auth' | 'upload-auth' | 'retry' | 'retry-auth', reenable = false) {
  for (const name of ['store', 'coachStore', 'dropbox']) delete require.cache[require.resolve(`../src/${name}`)]
  const storage: Record<string, string> = {}
  globalThis.localStorage = {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => { storage[key] = value },
  } as Storage
  const store = await import('../src/store')
  const coach = await import('../src/coachStore')
  const dropbox = await import('../src/dropbox')
  store.setSettings({ ...store.getState().settings, aiEnabled: true,
    dropboxToken: 'synthetic', dropboxRefreshToken: 'synthetic-refresh', dropboxAppKey: 'synthetic-app',
    dropboxTokenExpiresAt: stage === 'auth' ? 0 : Date.now() + 3600000 })
  coach.upsertThread({ id: 't1', title: 'Synthetic', createdAt: 1, updatedAt: 2, philosophy: 'balanced', weeks: 4, messages: [] })
  const original = storage['wt.coach.v1']
  const held = deferred<Response>()
  const started = deferred<void>()
  const calls: string[] = []
  let signal: AbortSignal | null | undefined
  let first = true
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    const path = JSON.parse((init?.headers as Record<string, string>)?.['Dropbox-API-Arg'] ?? '{}').path
    calls.push(path ?? 'auth')
    const auth = url.endsWith('/oauth2/token')
    if (first && ((stage === 'auth' || stage === 'upload-auth' || stage === 'retry-auth') ? auth : path === '/coach.jsonl')) {
      first = false
      signal = init?.signal
      started.resolve()
      // Ignore abort deliberately: even if a response wins the race, no next request may start.
      return held.promise
    }
    if (auth) return new Response('{"access_token":"synthetic-new","expires_in":3600}')
    if (stage === 'retry-auth' && first) return new Response('', { status: 401 })
    if (stage === 'upload-auth' && first) store.setSettings({ ...store.getState().settings, dropboxTokenExpiresAt: 0 })
    return url.endsWith('/download') ? new Response('path/not_found', { status: 409 }) : new Response('{}')
  }
  const pending = coach.syncCoach()
  await started.promise
  store.setSettings({ ...store.getState().settings, aiEnabled: false })
  if (signal) assert.equal(signal.aborted, true, 'active coach transport is aborted')
  if (reenable) store.setSettings({ ...store.getState().settings, aiEnabled: true })
  const countAtOff = calls.length
  held.resolve(stage === 'download' ? new Response('path/not_found', { status: 409 })
    : stage === 'retry' ? new Response('', { status: 401 })
    : new Response('{"access_token":"synthetic-new","expires_in":3600}'))
  assert.equal(await pending, null, 'cancellation is silent')
  assert.equal(calls.length, countAtOff, 'no new transport after Off')
  assert.equal(storage['wt.coach.v1'], original, 'saved coach data is preserved')
  assert.equal(await dropbox.dropboxUpload('synthetic workout'), null, 'ordinary sync still works')
  assert.equal(calls.at(-1), '/workouts.jsonl')
  store.setSettings({ ...store.getState().settings, aiEnabled: true })
  const beforeResume = calls.length
  assert.equal(await coach.syncCoach(), null)
  assert.equal(calls.slice(beforeResume).filter(p => p === '/coach.jsonl').length, 2, 'new sync can download and upload')
  console.log(`ok: ${stage}${reenable ? ' with Off -> On' : ''}`)
}

async function main() {
  for (const stage of ['download', 'auth', 'upload-auth', 'retry', 'retry-auth'] as const) await scenario(stage)
  await scenario('download', true)
  console.log('6/6 coach sync cancellation checks passed')
}
main().catch(e => { console.error(e); process.exit(1) })
