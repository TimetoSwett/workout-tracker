const CONTENT_API = 'https://content.dropboxapi.com/2'

export const DATA_PATH = '/workouts.jsonl'

export async function dropboxDownload(token: string, path: string = DATA_PATH): Promise<{ content: string | null; error?: string }> {
  try {
    const res = await fetch(`${CONTENT_API}/files/download`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Dropbox-API-Arg': JSON.stringify({ path }),
      },
    })
    if (res.status === 409) return { content: null }
    if (!res.ok) {
      if (res.status === 401) return { content: null, error: 'Dropbox rejected the token (401). Generate a new one in the Dropbox App Console.' }
      return { content: null, error: `Download failed (${res.status})` }
    }
    return { content: await res.text() }
  } catch (e) {
    return { content: null, error: `Network error: ${e instanceof Error ? e.message : String(e)}` }
  }
}

export async function dropboxUpload(token: string, content: string, path: string = DATA_PATH): Promise<string | null> {
  try {
    const res = await fetch(`${CONTENT_API}/files/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Dropbox-API-Arg': JSON.stringify({ path, mode: 'overwrite', mute: true }),
        'Content-Type': 'application/octet-stream',
      },
      body: content,
    })
    if (!res.ok) {
      if (res.status === 401) return 'Dropbox rejected the token (401). Generate a new one in the Dropbox App Console.'
      return `Upload failed (${res.status})`
    }
    return null
  } catch (e) {
    return `Network error: ${e instanceof Error ? e.message : String(e)}`
  }
}
