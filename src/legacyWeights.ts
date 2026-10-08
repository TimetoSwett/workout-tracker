import { dropboxDownload, dropboxUpload, REVISION_CONFLICT } from './dropbox'
import type { Units } from './units'

export const WEIGHT_PATHS = ['/workouts.jsonl', '/metrics.jsonl'] as const
export type LegacyFile = { path: string; content: string; rev: string }
export type Declaration = { raw: string; unit: Units }

/** Parse strictly: skipping malformed lines would silently delete recoverable data. */
export function weightLines(content: string): { raw: string; record: Record<string, unknown> }[] {
  return content.split('\n').filter(line => line.trim()).map(raw => {
    const record = JSON.parse(raw)
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid weight record; keep the raw file for recovery.')
    return { raw, record }
  })
}

export async function inspectLegacyFile(path: string): Promise<LegacyFile> {
  const result = await dropboxDownload(path)
  if (result.error) throw new Error(result.error)
  if (!result.content || !result.rev) throw new Error('No weight file found.')
  weightLines(result.content)
  return { path, content: result.content, rev: result.rev }
}

/** Only append a tag to an explicitly identified raw line. Preserve numeric literals,
 * whitespace, unknown fields and all already-tagged records byte for byte. */
export function tagLegacyContent(content: string, declarations: Declaration[]): string {
  weightLines(content)
  return content.split('\n').map(raw => {
    if (!raw.trim()) return raw
    const record = JSON.parse(raw)
    if (record.weightUnit === 'lbs' || record.weightUnit === 'kg') return raw
    if ('weightUnit' in record) throw new Error('Invalid existing unit tag: resolve from the raw backup; no automatic rewrite.')
    const selected = declarations.filter(d => d.raw === raw)
    if (!selected.length || selected.some(d => d.unit !== selected[0].unit) || !['lbs', 'kg'].includes(selected[0].unit)) {
      throw new Error('Every unknown record needs an explicit original unit. A changed or new record requires a fresh review.')
    }
    const end = raw.lastIndexOf('}')
    return raw.slice(0, end) + (Object.keys(record).length ? ',' : '') + '"weightUnit":' + JSON.stringify(selected[0].unit) + raw.slice(end)
  }).join('\n')
}

export async function migrateLegacyFile(file: LegacyFile, declarations: Declaration[]): Promise<string> {
  // Validate all declarations before even creating a backup. No inference from settings.
  tagLegacyContent(file.content, declarations)
  let current = file
  let backup = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    const tagged = tagLegacyContent(current.content, declarations)
    if (tagged === current.content) throw new Error('File was resolved by another device. Reload and review its unit declarations.')
    // Unique, create-only raw backup for EVERY revision we might replace.
    backup = `${file.path}.before-units-${crypto.randomUUID()}.jsonl`
    const backupError = await dropboxUpload(current.content, backup, null)
    if (backupError) throw new Error(`Backup failed; original file unchanged. ${backupError}`)
    const error = await dropboxUpload(tagged, file.path, current.rev)
    if (!error) return backup
    if (error !== REVISION_CONFLICT) throw new Error(`${error} Raw backup: ${backup}`)
    // Re-read and merge tags only for identical raw records. New/changed unknowns
    // require review; concurrent declarations are never overwritten with our choice.
    current = await inspectLegacyFile(file.path)
    for (const declaration of declarations) {
      const expected = JSON.parse(declaration.raw)
      const key = file.path === '/workouts.jsonl' ? 'id' : 'date'
      for (const { record } of weightLines(current.content)) {
        if (record[key] === expected[key] && record.weightUnit && record.weightUnit !== declaration.unit) {
          throw new Error(`Another device declared different units; reload and review. Raw backup: ${backup}`)
        }
      }
    }
  }
  throw new Error(`File keeps changing; retry after other devices finish. Raw backup: ${backup}`)
}
