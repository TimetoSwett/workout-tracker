import type { Settings } from './types'
import { dropboxTarget } from './dropbox'
import { cloudflareTarget } from './cloudflare'

/** Logical file names shared by every sync target, independent of how each
 *  target names things on its own side (Dropbox paths vs. Worker routes). */
export type SyncFileName = 'workouts' | 'mesocycles' | 'metrics' | 'coach'

export interface SyncTarget {
  readonly id: 'dropbox' | 'cloudflare'
  readonly label: string
  configured(settings: Settings): boolean
  download(file: SyncFileName): Promise<{ content: string | null; error?: string }>
  upload(file: SyncFileName, content: string): Promise<string | null>
}

export interface TargetError {
  targetId: SyncTarget['id']
  label: string
  message: string
}

export function activeTargets(settings: Settings): SyncTarget[] {
  return [dropboxTarget, cloudflareTarget].filter((t) => t.configured(settings))
}

/**
 * Downloads `file` from every active target, merges the results with the
 * local copy via `mergeContents`, then uploads the merged content back to
 * every target whose own copy doesn't already match it.
 *
 * Each target's download and upload runs independently — a failure on one
 * (network error, bad token, write conflict) is collected as an error but
 * never stops another target from syncing, so a broken Cloudflare setup
 * can't block Dropbox and vice versa.
 */
export async function syncFile(
  targets: SyncTarget[],
  file: SyncFileName,
  localContent: string,
  mergeContents: (contents: string[]) => string,
): Promise<{ merged: string; errors: TargetError[] }> {
  const downloads = await Promise.all(
    targets.map(async (target) => {
      const { content, error } = await target.download(file)
      return { target, content, error }
    }),
  )

  const errors: TargetError[] = downloads
    .filter((d): d is typeof d & { error: string } => !!d.error)
    .map((d) => ({ targetId: d.target.id, label: d.target.label, message: d.error }))

  const merged = mergeContents([localContent, ...downloads.map((d) => d.content ?? '')])

  const uploadErrors = await Promise.all(
    downloads
      .filter((d) => !d.error && (d.content ?? '') !== merged)
      .map(async (d) => {
        const message = await d.target.upload(file, merged)
        return message ? { targetId: d.target.id, label: d.target.label, message } : null
      }),
  )
  errors.push(...uploadErrors.filter((e): e is TargetError => !!e))

  return { merged, errors }
}
