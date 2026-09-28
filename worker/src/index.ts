/**
 * Backup sync API — a second sync target alongside Dropbox (see src/dropbox.ts,
 * src/sync.ts in the app). Stores the same four JSONL files in R2 and serves
 * them behind an owner-only bearer token, with conditional PUT so a stale
 * write can't clobber a newer one.
 *
 * R2 over D1: the app already treats each file as an opaque JSONL blob and
 * does its own record-level merge (last-writer-wins by id) on the client —
 * see `merge()` in src/sync.ts. The Worker only needs whole-file get/put with
 * a version check, which is exactly what an R2 object + its ETag gives for
 * free. D1 would add a schema and per-record writes the client doesn't need.
 */

export interface Env {
  BUCKET: R2Bucket
  /** Long random token pasted into the app's Settings. */
  API_TOKEN: string
  /** Comma-separated list of allowed CORS origins. */
  ALLOWED_ORIGINS: string
}

/** Logical name (used in the URL) -> R2 object key. Keeps the API from ever
 *  writing an arbitrary key into the bucket. */
const FILES: Record<string, string> = {
  workouts: 'workouts.jsonl',
  mesocycles: 'mesocycles.jsonl',
  metrics: 'metrics.jsonl',
  coach: 'coach.jsonl',
}

const CONTENT_TYPE = 'application/x-ndjson; charset=utf-8'

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function parseOrigins(raw: string): Set<string> {
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
}

function corsHeaders(origin: string | null, allowed: Set<string>): HeadersInit {
  if (!origin || !allowed.has(origin)) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match, If-None-Match',
    'Access-Control-Expose-Headers': 'ETag',
    'Access-Control-Max-Age': '86400',
  }
}

/** Digest-then-compare so neither the token's length nor its bytes leak
 *  through response timing. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder()
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ])
  const va = new Uint8Array(da)
  const vb = new Uint8Array(db)
  let diff = 0
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i]
  return diff === 0
}

async function requireAuth(request: Request, env: Env, cors: HeadersInit): Promise<Response | null> {
  const header = request.headers.get('Authorization') ?? ''
  const [scheme, token] = header.split(' ')
  if (scheme !== 'Bearer' || !token || !(await safeEqual(token, env.API_TOKEN))) {
    return json({ error: 'Unauthorized' }, 401, cors)
  }
  return null
}

async function handleList(env: Env, cors: HeadersInit): Promise<Response> {
  const entries = await Promise.all(
    Object.entries(FILES).map(async ([name, key]) => {
      const head = await env.BUCKET.head(key)
      return head
        ? { name, etag: head.httpEtag, size: head.size, uploadedAt: head.uploaded.toISOString() }
        : { name, etag: null, size: 0, uploadedAt: null }
    }),
  )
  return json({ files: entries }, 200, cors)
}

async function handleGet(env: Env, key: string, cors: HeadersInit): Promise<Response> {
  const obj = await env.BUCKET.get(key)
  if (!obj) return json({ error: 'Not found' }, 404, cors)
  return new Response(await obj.text(), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, ETag: obj.httpEtag, ...cors },
  })
}

/** Strips the HTTP quoting (and weak-validator prefix) from an ETag header
 *  value — R2's `onlyIf.etagMatches` compares against the raw etag. */
function unquoteEtag(etag: string): string {
  return etag.replace(/^W\//, '').replace(/^"|"$/g, '')
}

async function handlePut(request: Request, env: Env, key: string, cors: HeadersInit): Promise<Response> {
  const ifMatch = request.headers.get('If-Match')
  const ifNoneMatch = request.headers.get('If-None-Match')
  const existing = await env.BUCKET.head(key)

  if (existing) {
    if (ifNoneMatch === '*') {
      return json({ error: 'Already exists', etag: existing.httpEtag }, 409, cors)
    }
    if (!ifMatch) {
      return json(
        { error: 'Precondition required: fetch the current ETag and send it as If-Match', etag: existing.httpEtag },
        428,
        cors,
      )
    }
  } else if (ifMatch) {
    // Caller expected an existing version to update; there's nothing here to match.
    return json({ error: 'Precondition failed: remote file does not exist' }, 412, cors)
  }

  const body = await request.text()
  const result = await env.BUCKET.put(key, body, {
    httpMetadata: { contentType: CONTENT_TYPE },
    // R2's onlyIf wants the raw etag, not the quoted If-Match header form.
    onlyIf: existing && ifMatch ? { etagMatches: unquoteEtag(ifMatch) } : undefined,
  })

  if (!result) {
    // Lost a race between head() and put(): someone else wrote in between.
    const current = await env.BUCKET.head(key)
    return json({ error: 'Precondition failed: remote file changed', etag: current?.httpEtag ?? null }, 412, cors)
  }

  return json({ etag: result.httpEtag, size: result.size, uploadedAt: result.uploaded.toISOString() }, 200, cors)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const allowed = parseOrigins(env.ALLOWED_ORIGINS)
    const origin = request.headers.get('Origin')
    const cors = corsHeaders(origin, allowed)
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    const authFailure = await requireAuth(request, env, cors)
    if (authFailure) return authFailure

    const parts = url.pathname.split('/').filter(Boolean)

    if (parts[0] === 'files' && parts.length === 1 && request.method === 'GET') {
      return handleList(env, cors)
    }

    if (parts[0] === 'files' && parts.length === 2) {
      const key = FILES[parts[1]]
      if (!key) return json({ error: 'Unknown file' }, 404, cors)
      if (request.method === 'GET') return handleGet(env, key, cors)
      if (request.method === 'PUT') return handlePut(request, env, key, cors)
      return json({ error: 'Method not allowed' }, 405, cors)
    }

    return json({ error: 'Not found' }, 404, cors)
  },
}
