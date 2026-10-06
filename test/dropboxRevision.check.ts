import assert from 'node:assert/strict'
require.cache[require.resolve('../src/store')] = { id: require.resolve('../src/store'), filename: require.resolve('../src/store'), loaded: true, exports: { getState: () => ({ settings: { dropboxToken: 'synthetic' } }) } } as NodeJS.Module
const { dropboxDownload, dropboxUpload, REVISION_CONFLICT } = require('../src/dropbox') as typeof import('../src/dropbox')
let response: Response
let arg: Record<string, unknown>
globalThis.fetch = async (_input, init) => { arg = JSON.parse((init!.headers as Record<string, string>)['Dropbox-API-Arg']); return response }
async function main() {
  response = new Response('raw', { headers: { 'Dropbox-API-Result': '{"rev":"abc"}' } })
  assert.deepEqual(await dropboxDownload(), { content: 'raw', rev: 'abc' })
  response = new Response('raw')
  assert.ok((await dropboxDownload()).error)
  response = new Response('{"error_summary":"path/not_found/"}', { status: 409 })
  assert.deepEqual(await dropboxDownload(), { content: null })
  response = new Response('{"error_summary":"path/restricted_content/"}', { status: 409 })
  assert.ok((await dropboxDownload()).error)
  response = new Response('{}')
  assert.equal(await dropboxUpload('tagged', '/workouts.jsonl', 'abc'), null)
  assert.deepEqual(arg!.mode, { '.tag': 'update', update: 'abc' }); assert.equal(arg!.strict_conflict, true); assert.equal(arg!.autorename, false)
  response = new Response('{}')
  await dropboxUpload('raw', '/backup.jsonl', null); assert.equal(arg!.mode, 'add')
  response = new Response('{}', { status: 409 })
  assert.equal(await dropboxUpload('tagged', '/workouts.jsonl', 'old'), REVISION_CONFLICT)
  console.log('7/7 Dropbox revision transport checks passed')
}
main().catch(e => { console.error(e); process.exit(1) })
