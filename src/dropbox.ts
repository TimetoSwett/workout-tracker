import type { Settings } from './types'
import { getState, setSettings } from './store'

const CONTENT_API = 'https://content.dropboxapi.com/2'
const OAUTH_AUTHORIZE = 'https://www.dropbox.com/oauth2/authorize'
const OAUTH_TOKEN = 'https://api.dropbox.com/oauth2/token'

export const DATA_PATH = '/workouts.jsonl'

/** Renew a little early — a token that dies mid-upload costs a whole sync. */
const EXPIRY_SKEW_MS = 60_000
const NOT_CONNECTED = 'Dropbox is not connected — set it up in Settings.'
const RECONNECT = 'Dropbox access was revoked. Reconnect in Settings.'

export function dropboxConfigured(settings: Settings): boolean {
  return Boolean(settings.dropboxRefreshToken || settings.dropboxToken)
}

// ---------------------------------------------------------------------------
// PKCE
//
// Dropbox stopped issuing long-lived access tokens in 2021: the App Console's
// "Generate access token" button hands out a token that dies after 4 hours, so
// a pasted token stops syncing the same day. The fix is an offline-access grant
// — a refresh token that doesn't expire, exchanged for a fresh access token as
// needed.
//
// PKCE rather than a client secret, because this is a static site with no
// backend and a secret shipped in the bundle isn't a secret. No redirect URI is
// requested, so Dropbox displays the authorization code for the user to paste
// back. That avoids registering a redirect per origin and, more importantly,
// avoids bouncing an installed PWA out into a browser tab mid-flow.
// ---------------------------------------------------------------------------

const PKCE_KEY = 'wt.dropbox.pkce'

function base64url(bytes: ArrayBuffer): string {
  let s = ''
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Kept outside component state: the user leaves the app to authorize, and a
 *  backgrounded PWA can be torn down before they paste the code back. */
export function beginAuth(): string {
  const bytes = new Uint8Array(64)
  crypto.getRandomValues(bytes)
  const verifier = base64url(bytes.buffer)
  try {
    localStorage.setItem(PKCE_KEY, verifier)
  } catch {
  }
  return verifier
}

function takeVerifier(): string | null {
  try {
    return localStorage.getItem(PKCE_KEY)
  } catch {
    return null
  }
}

function clearVerifier() {
  try {
    localStorage.removeItem(PKCE_KEY)
  } catch {
  }
}

export async function authorizeUrl(appKey: string, verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const params = new URLSearchParams({
    client_id: appKey,
    response_type: 'code',
    code_challenge: base64url(digest),
    code_challenge_method: 'S256',
    token_access_type: 'offline', // the part that yields a refresh token
  })
  return `${OAUTH_AUTHORIZE}?${params}`
}

/** `code` carries Dropbox's machine-readable error (e.g. `invalid_grant`).
 *  Callers must branch on that, never on the prose — `error_description` is
 *  what the message shows, and it does not contain the code. */
async function tokenRequest(
  body: URLSearchParams,
): Promise<{ json?: Record<string, unknown>; error?: string; code?: string }> {
  try {
    const res = await fetch(OAUTH_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    const text = await res.text()
    if (!res.ok) {
      // Dropbox returns {"error": "invalid_grant", ...} for a spent or revoked code.
      let detail = text.slice(0, 200)
      let code: string | undefined
      try {
        const j = JSON.parse(text) as { error_description?: string; error?: string }
        code = typeof j.error === 'string' ? j.error : undefined
        detail = j.error_description ?? j.error ?? detail
      } catch {
      }
      return { error: `Dropbox rejected the request (${res.status}): ${detail}`, code }
    }
    return { json: JSON.parse(text) as Record<string, unknown> }
  } catch (e) {
    return { error: `Network error: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** Exchanges the pasted code for a refresh token and stores both. */
export async function completeAuth(appKey: string, code: string): Promise<string | null> {
  const verifier = takeVerifier()
  if (!verifier) return 'Authorization expired — tap "Authorize" and try again.'
  const { json, error } = await tokenRequest(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: code.trim(),
      client_id: appKey,
      code_verifier: verifier,
    }),
  )
  if (error) return error
  const refresh = json?.refresh_token
  const access = json?.access_token
  if (typeof refresh !== 'string' || typeof access !== 'string') {
    return 'Dropbox did not return a refresh token. Make sure the app has files.content.read and files.content.write.'
  }
  clearVerifier()
  const expiresIn = typeof json?.expires_in === 'number' ? json.expires_in : 14400
  setSettings({
    ...getState().settings,
    dropboxAppKey: appKey,
    dropboxRefreshToken: refresh,
    dropboxToken: access,
    dropboxTokenExpiresAt: Date.now() + expiresIn * 1000,
  })
  return null
}

export function disconnectDropbox() {
  clearVerifier()
  const s = getState().settings
  setSettings({
    ...s,
    dropboxRefreshToken: undefined,
    dropboxToken: undefined,
    dropboxTokenExpiresAt: undefined,
  })
}

/** Concurrent syncs (workouts + metrics + coach fire together) must not each
 *  mint their own token — Dropbox would invalidate all but the last. */
let refreshing: Promise<{ token: string | null; error?: string }> | null = null

async function refreshAccessToken(): Promise<{ token: string | null; error?: string }> {
  const s = getState().settings
  if (!s.dropboxRefreshToken || !s.dropboxAppKey) return { token: null, error: NOT_CONNECTED }
  const { json, error, code } = await tokenRequest(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: s.dropboxRefreshToken,
      client_id: s.dropboxAppKey,
    }),
  )
  if (error) {
    // A revoked or withdrawn grant never recovers by retrying; clear it so the
    // UI can say "reconnect" instead of failing every sync forever.
    if (code === 'invalid_grant') {
      disconnectDropbox()
      return { token: null, error: RECONNECT }
    }
    return { token: null, error }
  }
  const access = json?.access_token
  if (typeof access !== 'string') return { token: null, error: 'Dropbox returned no access token' }
  const expiresIn = typeof json?.expires_in === 'number' ? json.expires_in : 14400
  setSettings({
    ...getState().settings,
    dropboxToken: access,
    dropboxTokenExpiresAt: Date.now() + expiresIn * 1000,
  })
  return { token: access }
}

async function getAccessToken(force = false): Promise<{ token: string | null; error?: string }> {
  const s = getState().settings
  if (!force && s.dropboxToken && (s.dropboxTokenExpiresAt ?? 0) > Date.now() + EXPIRY_SKEW_MS) {
    return { token: s.dropboxToken }
  }
  // Pre-PKCE setup: a hand-pasted token and nothing to refresh with. Keep using
  // it until Dropbox rejects it, so an existing install doesn't break on update.
  if (!s.dropboxRefreshToken || !s.dropboxAppKey) {
    return s.dropboxToken ? { token: s.dropboxToken } : { token: null, error: NOT_CONNECTED }
  }
  if (!refreshing) refreshing = refreshAccessToken().finally(() => (refreshing = null))
  return refreshing
}

/** Runs a request with a valid token, retrying once on 401 with a forced refresh. */
async function authed(run: (token: string) => Promise<Response>): Promise<{ res?: Response; error?: string }> {
  const first = await getAccessToken()
  if (!first.token) return { error: first.error ?? NOT_CONNECTED }
  try {
    const res = await run(first.token)
    if (res.status !== 401) return { res }
    const again = await getAccessToken(true)
    if (!again.token) return { error: again.error ?? RECONNECT }
    return { res: await run(again.token) }
  } catch (e) {
    return { error: `Network error: ${e instanceof Error ? e.message : String(e)}` }
  }
}

export async function dropboxDownload(path: string = DATA_PATH): Promise<{ content: string | null; error?: string }> {
  const { res, error } = await authed((token) =>
    fetch(`${CONTENT_API}/files/download`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': JSON.stringify({ path }) },
    }),
  )
  if (error || !res) return { content: null, error }
  if (res.status === 409) return { content: null } // not there yet — first sync
  if (!res.ok) {
    if (res.status === 401) return { content: null, error: RECONNECT }
    return { content: null, error: `Download failed (${res.status})` }
  }
  return { content: await res.text() }
}

export async function dropboxUpload(content: string, path: string = DATA_PATH): Promise<string | null> {
  const { res, error } = await authed((token) =>
    fetch(`${CONTENT_API}/files/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Dropbox-API-Arg': JSON.stringify({ path, mode: 'overwrite', mute: true }),
        'Content-Type': 'application/octet-stream',
      },
      body: content,
    }),
  )
  if (error) return error
  if (!res) return 'Upload failed'
  if (!res.ok) {
    if (res.status === 401) return RECONNECT
    return `Upload failed (${res.status})`
  }
  return null
}

export async function testConnection(): Promise<string | null> {
  const { res, error } = await authed((token) =>
    fetch('https://api.dropboxapi.com/2/users/get_current_account', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }),
  )
  if (error) return error
  if (!res?.ok) return `Token rejected (${res?.status ?? '?'})`
  return null
}
