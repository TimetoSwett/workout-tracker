/**
 * Backup sync API — a second sync target alongside Dropbox (see src/dropbox.ts,
 * src/sync.ts in the app). Stores the same four JSONL files in D1 and serves
 * them behind an owner-only bearer token, with conditional PUT so a stale
 * write can't clobber a newer one.
 *
 * D1 over R2: the app already treats each file as an opaque JSONL blob and
 * does its own record-level merge (last-writer-wins by id) on the client —
 * see `merge()` in src/sync.ts. The Worker only needs whole-file get/put with
 * a version check, one row per file. R2 would be the more natural fit for
 * that (an object + its ETag give the version check for free), but this
 * account's R2 subscription has not been enabled in the Cloudflare dashboard
 * (a one-time manual step with no API equivalent — `POST .../r2/buckets`
 * returns error 10042 `NotEntitled` until it's done), which blocked
 * provisioning the bucket for an unattended deploy. D1 needs no such
 * enablement, so a single `files` table with the same whole-file semantics
 * (conditional UPDATE ... WHERE etag = ? in place of R2's `onlyIf`) covers
 * the same behavior without waiting on that step. R2 remains a reasonable
 * swap later if the Owner enables it — only this file's storage calls would
 * change, the HTTP API is unaffected.
 */

export interface Env {
  DB: D1Database
  /** Long random token pasted into the app's Settings. */
  API_TOKEN: string
  /** Comma-separated list of allowed CORS origins. */
  ALLOWED_ORIGINS: string
}

/** Logical name (used in the URL) -> storage row key. Keeps the API from ever
 *  writing an arbitrary key into the table. */
const FILES: Record<string, string> = {
  workouts: 'workouts.jsonl',
  mesocycles: 'mesocycles.jsonl',
  metrics: 'metrics.jsonl',
  coach: 'coach.jsonl',
}

const CONTENT_TYPE = 'application/x-ndjson; charset=utf-8'

interface FileRow {
  name: string
  content: string
  etag: string
  size: number
  uploaded_at: string
}

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

/** Content hash used as the row's version token — the same role R2's
 *  object ETag plays for conditional writes. */
async function computeEtag(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Format a raw hex etag the way an HTTP ETag header/JSON field is quoted. */
function toHttpEtag(hex: string): string {
  return `"${hex}"`
}

/** Strips the HTTP quoting (and weak-validator prefix) from an ETag header
 *  value so it can be compared against the raw hex stored in the row. */
function unquoteEtag(etag: string): string {
  return etag.replace(/^W\//, '').replace(/^"|"$/g, '')
}

async function handleList(env: Env, cors: HeadersInit): Promise<Response> {
  const { results } = await env.DB.prepare('SELECT name, etag, size, uploaded_at FROM files').all<FileRow>()
  const byKey = new Map(results.map((r) => [r.name, r]))
  const entries = Object.entries(FILES).map(([name, key]) => {
    const row = byKey.get(key)
    return row
      ? { name, etag: toHttpEtag(row.etag), size: row.size, uploadedAt: row.uploaded_at }
      : { name, etag: null, size: 0, uploadedAt: null }
  })
  return json({ files: entries }, 200, cors)
}

async function handleGet(env: Env, key: string, cors: HeadersInit): Promise<Response> {
  const row = await env.DB.prepare('SELECT content, etag FROM files WHERE name = ?').bind(key).first<FileRow>()
  if (!row) return json({ error: 'Not found' }, 404, cors)
  return new Response(row.content, {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, ETag: toHttpEtag(row.etag), ...cors },
  })
}

async function handlePut(request: Request, env: Env, key: string, cors: HeadersInit): Promise<Response> {
  const ifMatch = request.headers.get('If-Match')
  const ifNoneMatch = request.headers.get('If-None-Match')
  const existing = await env.DB.prepare('SELECT etag FROM files WHERE name = ?').bind(key).first<Pick<FileRow, 'etag'>>()

  if (existing) {
    if (ifNoneMatch === '*') {
      return json({ error: 'Already exists', etag: toHttpEtag(existing.etag) }, 409, cors)
    }
    if (!ifMatch) {
      return json(
        { error: 'Precondition required: fetch the current ETag and send it as If-Match', etag: toHttpEtag(existing.etag) },
        428,
        cors,
      )
    }
  } else if (ifMatch) {
    // Caller expected an existing version to update; there's nothing here to match.
    return json({ error: 'Precondition failed: remote file does not exist' }, 412, cors)
  }

  const bodyText = await request.text()
  const bodyBytes = new TextEncoder().encode(bodyText)
  const etag = await computeEtag(bodyBytes)
  const uploadedAt = new Date().toISOString()

  if (existing) {
    const result = await env.DB.prepare(
      'UPDATE files SET content = ?, etag = ?, size = ?, uploaded_at = ? WHERE name = ? AND etag = ?',
    )
      .bind(bodyText, etag, bodyBytes.length, uploadedAt, key, unquoteEtag(ifMatch as string))
      .run()

    if (result.meta.changes === 0) {
      // Lost a race between the SELECT above and this UPDATE: someone else wrote in between.
      const current = await env.DB.prepare('SELECT etag FROM files WHERE name = ?').bind(key).first<Pick<FileRow, 'etag'>>()
      return json(
        { error: 'Precondition failed: remote file changed', etag: current ? toHttpEtag(current.etag) : null },
        412,
        cors,
      )
    }
  } else {
    try {
      await env.DB.prepare('INSERT INTO files (name, content, etag, size, uploaded_at) VALUES (?, ?, ?, ?, ?)')
        .bind(key, bodyText, etag, bodyBytes.length, uploadedAt)
        .run()
    } catch {
      // Lost a race between the SELECT above and this INSERT: someone else created it in between.
      const current = await env.DB.prepare('SELECT etag FROM files WHERE name = ?').bind(key).first<Pick<FileRow, 'etag'>>()
      return json(
        { error: 'Precondition failed: remote file changed', etag: current ? toHttpEtag(current.etag) : null },
        412,
        cors,
      )
    }
  }

  return json({ etag: toHttpEtag(etag), size: bodyBytes.length, uploadedAt }, 200, cors)
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
