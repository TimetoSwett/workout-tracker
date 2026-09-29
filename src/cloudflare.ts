import type { Settings } from './types'
import { getState, setSettings } from './store'
import type { SyncFileName, SyncTarget } from './syncTargets'

const NOT_CONNECTED = 'Cloudflare sync is not set up — enter the Worker URL and token in Settings.'
const REJECTED = 'Cloudflare rejected the token — check it in Settings.'

export function cloudflareConfigured(settings: Settings): boolean {
  return Boolean(settings.cloudflareEnabled && settings.cloudflareEndpoint && settings.cloudflareToken)
}

function endpointBase(settings: Settings): string {
  return (settings.cloudflareEndpoint ?? '').replace(/\/+$/, '')
}

/** ETag seen on the last successful download of each file, used to make the
 *  next upload conditional (`If-Match`) per the Worker's optimistic-
 *  concurrency contract — see worker/README.md. Reset on page reload; a 428
 *  ("Precondition required") on the next write just triggers the same
 *  fetch-current-etag-and-retry path as a stale cache entry would. */
const etagCache = new Map<SyncFileName, string | null>()

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

export async function cloudflareDownload(file: SyncFileName): Promise<{ content: string | null; error?: string }> {
  const settings = getState().settings
  if (!cloudflareConfigured(settings)) return { content: null, error: NOT_CONNECTED }
  try {
    const res = await fetch(`${endpointBase(settings)}/files/${file}`, {
      headers: authHeaders(settings.cloudflareToken as string),
    })
    if (res.status === 404) {
      etagCache.set(file, null)
      return { content: null }
    }
    if (res.status === 401) return { content: null, error: REJECTED }
    if (!res.ok) return { content: null, error: `Cloudflare download failed (${res.status})` }
    etagCache.set(file, res.headers.get('ETag'))
    return { content: await res.text() }
  } catch (e) {
    return { content: null, error: `Network error: ${e instanceof Error ? e.message : String(e)}` }
  }
}

async function putOnce(url: string, token: string, content: string, etag: string | null): Promise<Response> {
  const headers = authHeaders(token)
  if (etag) headers['If-Match'] = etag
  return fetch(url, { method: 'PUT', headers, body: content })
}

async function readEtag(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { etag?: string | null }
    return body.etag ?? null
  } catch {
    return null
  }
}

export async function cloudflareUpload(file: SyncFileName, content: string): Promise<string | null> {
  const settings = getState().settings
  if (!cloudflareConfigured(settings)) return NOT_CONNECTED
  const token = settings.cloudflareToken as string
  const url = `${endpointBase(settings)}/files/${file}`
  try {
    let res = await putOnce(url, token, content, etagCache.get(file) ?? null)
    if (res.status === 401) return REJECTED

    if (res.status === 412 || res.status === 428) {
      // Our cached etag is stale or missing for a file that already exists on
      // the Worker. The error body carries the current etag — retry once
      // with it instead of a separate GET round trip.
      const currentEtag = await readEtag(res)
      res = await putOnce(url, token, content, currentEtag)
      if (res.status === 401) return REJECTED
      if (res.status === 412 || res.status === 428) {
        return 'Cloudflare write conflict (another device wrote at the same time) — will retry on next sync.'
      }
    }

    if (!res.ok) return `Cloudflare upload failed (${res.status})`
    etagCache.set(file, await readEtag(res))
    return null
  } catch (e) {
    return `Network error: ${e instanceof Error ? e.message : String(e)}`
  }
}

export async function testCloudflareConnection(): Promise<string | null> {
  const settings = getState().settings
  if (!cloudflareConfigured(settings)) return NOT_CONNECTED
  try {
    const res = await fetch(`${endpointBase(settings)}/files`, {
      headers: authHeaders(settings.cloudflareToken as string),
    })
    if (res.status === 401) return REJECTED
    if (!res.ok) return `Cloudflare connection failed (${res.status})`
    return null
  } catch (e) {
    return `Network error: ${e instanceof Error ? e.message : String(e)}`
  }
}

export function disconnectCloudflare() {
  const s = getState().settings
  setSettings({
    ...s,
    cloudflareEnabled: false,
    cloudflareEndpoint: undefined,
    cloudflareToken: undefined,
    cloudflareLastSyncAt: undefined,
    cloudflareLastError: undefined,
  })
}

export const cloudflareTarget: SyncTarget = {
  id: 'cloudflare',
  label: 'Cloudflare',
  configured: cloudflareConfigured,
  download: cloudflareDownload,
  upload: cloudflareUpload,
}
