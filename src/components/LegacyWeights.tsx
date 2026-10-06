import { useState } from 'preact/hooks'
import { inspectLegacyFile, migrateLegacyFile, weightLines, WEIGHT_PATHS } from '../legacyWeights'
import type { LegacyFile } from '../legacyWeights'
import type { Units } from '../units'

export function LegacyWeights() {
  const [file, setFile] = useState<LegacyFile | null>(null)
  const [units, setUnits] = useState<Record<number, Units | ''>>({})
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const unknown = file ? weightLines(file.content).filter(({ record }) => record.weightUnit !== 'lbs' && record.weightUnit !== 'kg') : []
  async function inspect(path: string) {
    setBusy(true); setFile(null); setUnits({}); setStatus('')
    try { setFile(await inspectLegacyFile(path)) } catch (e) { setStatus(String(e)) }
    finally { setBusy(false) }
  }
  async function save() {
    if (!file) return
    setBusy(true)
    try {
      const backup = await migrateLegacyFile(file, unknown.map(({ raw }, i) => ({ raw, unit: units[i] as Units })))
      setStatus(`Units saved without changing measurements. Raw backup in Dropbox: ${backup}. Sync again to import. Keep this backup for recovery.`)
      setFile(null)
    } catch (e) { setStatus(String(e)); setFile(null) }
    finally { setBusy(false) }
  }
  return <details>
    <summary>Resolve legacy weight units</summary>
    <p class="muted small">Help: older Dropbox records may have no unit label. This is not an unresolved-data warning; review a file to check. Choose the original unit for each record only if you know it. Leave unknown records unresolved. Mixed-unit files need a choice per record. A raw Dropbox backup is required before saving; measurements are never rounded.</p>
    <div class="btn-row">{WEIGHT_PATHS.map(path => <button class="btn ghost" disabled={busy} onClick={() => inspect(path)}>Review {path === '/workouts.jsonl' ? 'workouts' : 'body metrics'}</button>)}</div>
    {file && !unknown.length && <p>All records already have units.</p>}
    {file && weightLines(file.content).some(({ record }) => record.weightUnit === 'kg') && <p role="alert">This file contains explicit kg labels. If you entered everything in pounds, these labels conflict with that history. They will not be overwritten; compare them with your original backup.</p>}
    {!!unknown.length && <>
      <p role="status">{unknown.length} unresolved {unknown.length === 1 ? 'record' : 'records'} in this file. Existing unit labels are retained.</p>
      {unknown.some(({ record }) => 'weightUnit' in record) && <p role="alert">An existing unit label is invalid. Saving is blocked; review the raw file rather than replacing that label.</p>}
      <button class="btn ghost wide" disabled={busy} onClick={() => setUnits(Object.fromEntries(unknown.map((_, i) => [i, 'lbs'])))}>I entered all unlabeled records in pounds (lb)</button>
    </>}
    {unknown.map(({ record }, i) => <label style={{ display: 'block', overflowWrap: 'anywhere' }}>
      {String(record.date ?? record.id ?? i + 1)} · {String(record.name ?? '')}
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '10rem', overflow: 'auto' }}>{JSON.stringify(record, null, 2)}</pre>
      <select aria-label={`Original unit for record ${i + 1}`} value={units[i] ?? ''} disabled={busy} onChange={e => setUnits({ ...units, [i]: e.currentTarget.value as Units | '' })}>
        <option value="">Unknown — do not migrate</option><option value="lbs">Originally lbs</option><option value="kg">Originally kg</option>
      </select>
    </label>)}
    {!!unknown.length && <button class="btn ghost wide" disabled={busy || unknown.some(({ record }, i) => !units[i] || 'weightUnit' in record)} onClick={save}>Back up raw file and save selected units</button>}
    {status && <p role="status" style={{ overflowWrap: 'anywhere' }}>{status}</p>}
  </details>
}
