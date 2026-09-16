import { useState } from 'preact/hooks'
import type { Mesocycle, MesoPriority, MesoTemplateDay, MesoTemplateExercise } from '../types'
import { MUSCLE_GROUPS } from '../types'
import { getState, setHistory, setSettings, uid, upsertMesocycle, useStore } from '../store'
import { parseRpExport } from '../rpImport'
import { mesoPosition } from '../mesoEngine'
import { ExercisePicker } from './ExercisePicker'

type PriorityType = MesoPriority['type']
const PRIORITY_TYPES: PriorityType[] = ['maintain', 'grow', 'emphasize']

interface Draft {
  id?: string
  name: string
  unit: 'lbs' | 'kg'
  weeksPlanned: number
  days: MesoTemplateDay[]
  priorities: Record<number, PriorityType>
}

function emptyDay(n: number): MesoTemplateDay {
  return { id: uid(), label: `Day ${n}`, exercises: [] }
}

function draftFromMeso(m: Mesocycle): Draft {
  const priorities: Record<number, PriorityType> = {}
  for (const p of m.priorities) priorities[p.muscleGroupId] = p.type
  return { id: m.id, name: m.name, unit: m.unit, weeksPlanned: m.weeksPlanned, days: m.days.map((d) => ({ ...d, exercises: [...d.exercises] })), priorities }
}

function parseRepRange(v: string): [number, number] | undefined {
  const m = v.trim().match(/^(\d+)\s*-\s*(\d+)$/)
  if (!m) return undefined
  return [Number(m[1]), Number(m[2])]
}

function repRangeText(r: [number, number] | undefined): string {
  return r ? `${r[0]}-${r[1]}` : ''
}

function muscleGroupName(id: number, overrides: Record<number, string> | undefined): string {
  return overrides?.[id] ?? MUSCLE_GROUPS.find((g) => g.id === id)?.name ?? `Muscle ${id}`
}

export function MesocyclesView() {
  const { mesocycles, workouts, settings } = useStore()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [pickerDay, setPickerDay] = useState<number | null>(null)
  const [importMsg, setImportMsg] = useState('')
  const [showMuscleGroups, setShowMuscleGroups] = useState(false)

  const live = mesocycles.filter((m) => !m.deleted).sort((a, b) => b.createdAt - a.createdAt)
  const hasAny = live.length > 0

  function startCreate() {
    setDraft({ name: '', unit: settings.units, weeksPlanned: 5, days: [emptyDay(1)], priorities: {} })
  }

  function startEdit(m: Mesocycle) {
    setDraft(draftFromMeso(m))
  }

  function patchDraft(fn: (d: Draft) => Draft) {
    setDraft((d) => (d ? fn(d) : d))
  }

  function saveDraft() {
    if (!draft) return
    const name = draft.name.trim()
    const days = draft.days.filter((d) => d.exercises.length > 0)
    if (!name || days.length === 0) return
    const priorities: MesoPriority[] = Object.entries(draft.priorities)
      .filter(([, type]) => type !== 'maintain')
      .map(([id, type]) => ({ muscleGroupId: Number(id), type }))
    const now = Date.now()
    const { mesocycles: existing } = getState()
    let next = existing
    if (!draft.id) {
      // starting a new active meso retires any previous active one
      next = existing.map((m) => (m.status === 'active' && !m.imported ? { ...m, status: 'complete' as const, finishedAt: now, updatedAt: now } : m))
    }
    const meso: Mesocycle = {
      id: draft.id ?? uid(),
      name,
      unit: draft.unit,
      weeksPlanned: Math.max(1, draft.weeksPlanned),
      deloadWeek: Math.max(0, draft.weeksPlanned - 1),
      days,
      priorities,
      status: existing.find((m) => m.id === draft.id)?.status ?? 'active',
      createdAt: existing.find((m) => m.id === draft.id)?.createdAt ?? now,
      updatedAt: now,
      imported: false,
    }
    const i = next.findIndex((m) => m.id === meso.id)
    const merged = i >= 0 ? next.map((m) => (m.id === meso.id ? meso : m)) : [...next, meso]
    setHistory(getState().workouts, merged)
    setDraft(null)
  }

  function completeMeso(m: Mesocycle) {
    upsertMesocycle({ ...m, status: 'complete', finishedAt: Date.now(), updatedAt: Date.now() })
  }

  function addExercise(name: string) {
    if (pickerDay == null) return
    patchDraft((d) => ({
      ...d,
      days: d.days.map((day, i) =>
        i !== pickerDay ? day : { ...day, exercises: [...day.exercises, { id: uid(), name, sets: 3 } as MesoTemplateExercise] },
      ),
    }))
    setPickerDay(null)
  }

  function importFile(file: File) {
    file.text().then((text) => {
      try {
        const { workouts: importedWorkouts, mesocycles: importedMesos, ambiguousMuscleGroups } = parseRpExport(text)
        const { workouts: existingWorkouts, mesocycles: existingMesos } = getState()
        const importedWIds = new Set(importedWorkouts.map((w) => w.id))
        const importedMIds = new Set(importedMesos.map((m) => m.id))
        const mergedWorkouts = [...existingWorkouts.filter((w) => !importedWIds.has(w.id)), ...importedWorkouts]
        const mergedMesos = [...existingMesos.filter((m) => !importedMIds.has(m.id)), ...importedMesos]
        setHistory(mergedWorkouts, mergedMesos)
        setImportMsg(
          `Imported ${importedWorkouts.length} workouts across ${importedMesos.length} mesocycles. ` +
            `Muscle groups ${ambiguousMuscleGroups.map((id) => muscleGroupName(id, settings.muscleGroupNames)).join(', ')} are best-guess names — rename below if wrong.`,
        )
        setShowMuscleGroups(true)
      } catch (e) {
        setImportMsg(`Import failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    })
  }

  function renameMuscleGroup(id: number, name: string) {
    setSettings({ ...settings, muscleGroupNames: { ...settings.muscleGroupNames, [id]: name } })
  }

  if (draft) {
    return (
      <div class="view">
        <h1>{draft.id ? 'Edit mesocycle' : 'New mesocycle'}</h1>
        <div class="card">
          <input
            class="text-input"
            type="text"
            placeholder="Name (e.g. Upper/Lower Hypertrophy)"
            value={draft.name}
            onInput={(e) => patchDraft((d) => ({ ...d, name: (e.target as HTMLInputElement).value }))}
          />
          <div class="setting-row">
            <span>Unit</span>
            <div class="seg">
              <button class={draft.unit === 'lbs' ? 'active' : ''} onClick={() => patchDraft((d) => ({ ...d, unit: 'lbs' }))}>
                lbs
              </button>
              <button class={draft.unit === 'kg' ? 'active' : ''} onClick={() => patchDraft((d) => ({ ...d, unit: 'kg' }))}>
                kg
              </button>
            </div>
          </div>
          <div class="setting-row">
            <span>Weeks (last week is the deload)</span>
            <input
              class="set-input narrow"
              type="number"
              inputMode="numeric"
              min="1"
              value={draft.weeksPlanned}
              onInput={(e) => {
                const n = parseInt((e.target as HTMLInputElement).value, 10)
                if (Number.isFinite(n) && n >= 1) patchDraft((d) => ({ ...d, weeksPlanned: n }))
              }}
            />
          </div>
        </div>

        {draft.days.map((day, dayIdx) => (
          <div key={day.id} class="card">
            <input
              class="text-input"
              type="text"
              value={day.label}
              onInput={(e) =>
                patchDraft((d) => ({
                  ...d,
                  days: d.days.map((dd, i) => (i !== dayIdx ? dd : { ...dd, label: (e.target as HTMLInputElement).value })),
                }))
              }
            />
            {day.exercises.map((ex, exIdx) => (
              <div key={ex.id} class="setting-row">
                <span>{ex.name}</span>
                <input
                  class="set-input narrow"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  value={ex.sets}
                  onInput={(e) => {
                    const n = parseInt((e.target as HTMLInputElement).value, 10)
                    patchDraft((d) => ({
                      ...d,
                      days: d.days.map((dd, i) =>
                        i !== dayIdx
                          ? dd
                          : { ...dd, exercises: dd.exercises.map((e2, j) => (j !== exIdx ? e2 : { ...e2, sets: Number.isFinite(n) ? n : e2.sets })) },
                      ),
                    }))
                  }}
                />
                <input
                  class="set-input narrow"
                  type="text"
                  placeholder="reps 8-12"
                  value={repRangeText(ex.repTarget)}
                  onInput={(e) => {
                    const repTarget = parseRepRange((e.target as HTMLInputElement).value)
                    patchDraft((d) => ({
                      ...d,
                      days: d.days.map((dd, i) =>
                        i !== dayIdx ? dd : { ...dd, exercises: dd.exercises.map((e2, j) => (j !== exIdx ? e2 : { ...e2, repTarget })) },
                      ),
                    }))
                  }}
                />
                <button
                  class="icon-btn danger"
                  onClick={() =>
                    patchDraft((d) => ({
                      ...d,
                      days: d.days.map((dd, i) => (i !== dayIdx ? dd : { ...dd, exercises: dd.exercises.filter((_, j) => j !== exIdx) })),
                    }))
                  }
                >
                  ✕
                </button>
              </div>
            ))}
            <button class="btn small ghost wide" onClick={() => setPickerDay(dayIdx)}>
              ＋ Add exercise
            </button>
          </div>
        ))}

        <button class="btn ghost wide" onClick={() => patchDraft((d) => ({ ...d, days: [...d.days, emptyDay(d.days.length + 1)] }))}>
          ＋ Add day
        </button>

        <div class="card">
          <h3>Priorities</h3>
          {MUSCLE_GROUPS.map((g) => (
            <div key={g.id} class="setting-row">
              <span>{muscleGroupName(g.id, settings.muscleGroupNames)}</span>
              <div class="seg">
                {PRIORITY_TYPES.map((t) => (
                  <button
                    key={t}
                    class={(draft.priorities[g.id] ?? 'maintain') === t ? 'active' : ''}
                    onClick={() => patchDraft((d) => ({ ...d, priorities: { ...d.priorities, [g.id]: t } }))}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div class="btn-row">
          <button class="btn primary wide" onClick={saveDraft}>
            Save
          </button>
          <button class="btn ghost wide" onClick={() => setDraft(null)}>
            Cancel
          </button>
        </div>

        {pickerDay != null && <ExercisePicker onPick={addExercise} onClose={() => setPickerDay(null)} />}
      </div>
    )
  }

  return (
    <div class="view">
      <h1>Mesocycles</h1>

      {!hasAny && (
        <div class="card">
          <h3>Get started</h3>
          <p class="muted small">Import your RP Strength history, or build a mesocycle from scratch.</p>
          <div class="btn-row">
            <label class="btn ghost file-btn">
              Import RP Strength data
              <input
                type="file"
                accept="application/json"
                hidden
                onChange={(e) => {
                  const f = (e.target as HTMLInputElement).files?.[0]
                  if (f) importFile(f)
                }}
              />
            </label>
            <button class="btn primary" onClick={startCreate}>
              New mesocycle
            </button>
          </div>
        </div>
      )}

      {importMsg && <div class="card">{importMsg}</div>}

      {hasAny && (
        <button class="btn wide" onClick={startCreate}>
          ＋ New mesocycle
        </button>
      )}

      {live.map((m) => {
        const pos = !m.imported && m.status === 'active' ? mesoPosition(m, workouts) : null
        return (
          <div key={m.id} class="card">
            <div class="workout-title">
              {m.name} <span class="muted small">{m.imported ? '· imported' : m.status === 'active' ? '· active' : '· complete'}</span>
            </div>
            {pos && (
              <div class="muted small">
                Week {pos.weekIndex + 1}/{m.weeksPlanned} — {m.days[pos.dayIndex]?.label ?? 'Day'}
                {pos.isDeload ? ' (deload)' : ''}
              </div>
            )}
            <div class="muted small">{m.days.length} day template · {m.weeksPlanned} weeks</div>
            {!m.imported && (
              <div class="btn-row">
                <button class="btn small ghost" onClick={() => startEdit(m)}>
                  Edit template
                </button>
                {m.status === 'active' && (
                  <button class="btn small danger" onClick={() => completeMeso(m)}>
                    Mark complete
                  </button>
                )}
              </div>
            )}
          </div>
        )
      })}

      <div class="card">
        <button class="btn ghost wide" onClick={() => setShowMuscleGroups(!showMuscleGroups)}>
          {showMuscleGroups ? 'Hide' : 'Muscle group names'}
        </button>
        {showMuscleGroups && (
          <>
            {hasAny && (
              <label class="btn ghost file-btn wide" style={{ marginTop: 8 }}>
                Import RP Strength data
                <input
                  type="file"
                  accept="application/json"
                  hidden
                  onChange={(e) => {
                    const f = (e.target as HTMLInputElement).files?.[0]
                    if (f) importFile(f)
                  }}
                />
              </label>
            )}
            {MUSCLE_GROUPS.map((g) => (
              <div key={g.id} class="setting-row">
                <span class={g.inferred ? 'muted' : ''}>
                  {g.id}. {g.inferred ? 'unconfirmed' : g.name}
                </span>
                <input
                  class="text-input"
                  style={{ marginBottom: 0 }}
                  type="text"
                  placeholder={g.name}
                  value={settings.muscleGroupNames?.[g.id] ?? ''}
                  onInput={(e) => renameMuscleGroup(g.id, (e.target as HTMLInputElement).value)}
                />
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
