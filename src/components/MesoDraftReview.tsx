import { useState } from 'preact/hooks'
import type { Mesocycle, MesoPriority, MesoTemplateDay, MesoTemplateExercise, Settings, Template, Workout } from '../types'
import { MUSCLE_GROUPS } from '../types'
import { clampDeloadWeek, deloadWeekOf, muscleGroupName } from '../mesoEngine'
import { collectKnownExerciseNames } from '../mesoDraft'
import { uid } from '../store'
import { ExercisePicker } from './ExercisePicker'

type PriorityType = MesoPriority['type']
const PRIORITY_TYPES: PriorityType[] = ['maintain', 'grow', 'emphasize']

interface Draft {
  name: string
  goal: string
  unit: 'lbs' | 'kg'
  weeksPlanned: number
  /** 0-based, same as `Mesocycle.deloadWeek`. */
  deloadWeek: number
  days: MesoTemplateDay[]
  priorities: Record<number, PriorityType>
}

function draftFromMeso(m: Mesocycle): Draft {
  const priorities: Record<number, PriorityType> = {}
  for (const p of m.priorities) priorities[p.muscleGroupId] = p.type
  return {
    name: m.name,
    goal: m.goal ?? '',
    unit: m.unit,
    weeksPlanned: m.weeksPlanned,
    // The coach can deliberately put the deload mid-block; honour what it drafted rather
    // than assuming the last week.
    deloadWeek: deloadWeekOf(m),
    days: m.days.map((d) => ({ ...d, exercises: d.exercises.map((ex) => ({ ...ex })) })),
    priorities,
  }
}

function parseRepRange(v: string): [number, number] | undefined {
  const m = v.trim().match(/^(\d+)\s*-\s*(\d+)$/)
  if (!m) return undefined
  return [Number(m[1]), Number(m[2])]
}

function repRangeText(r: [number, number] | undefined): string {
  return r ? `${r[0]}-${r[1]}` : ''
}

interface Props {
  /** Keying the parent by `meso.id` (it changes on every "Generate draft") is what
   *  resets this component's local edits when the coach produces a new draft. */
  meso: Mesocycle
  settings: Settings
  workouts: Workout[]
  templates: Template[]
  mesocycles: Mesocycle[]
  onAccept: (meso: Mesocycle) => void
  onDiscard: () => void
}

/** Editable review of a coach-drafted mesocycle, laid out like `MesocyclesView`'s own
 *  editor (name/unit/weeks, per-day exercises with sets/reps, priorities) plus the
 *  `goal` field that editor doesn't carry. Nothing here touches the meso store —
 *  the caller decides what Accept/Discard mean. */
export function MesoDraftReview({ meso, settings, workouts, templates, mesocycles, onAccept, onDiscard }: Props) {
  const [draft, setDraft] = useState<Draft>(() => draftFromMeso(meso))
  const [pickerDay, setPickerDay] = useState<number | null>(null)
  const [renameTarget, setRenameTarget] = useState<{ dayIdx: number; exIdx: number } | null>(null)

  const known = collectKnownExerciseNames(workouts, templates, mesocycles)

  function patch(fn: (d: Draft) => Draft) {
    setDraft(fn)
  }
  function patchDay(dayIdx: number, fn: (day: MesoTemplateDay) => MesoTemplateDay) {
    patch((d) => ({ ...d, days: d.days.map((day, i) => (i === dayIdx ? fn(day) : day)) }))
  }
  function patchExercise(dayIdx: number, exIdx: number, p: Partial<MesoTemplateExercise>) {
    patchDay(dayIdx, (day) => ({ ...day, exercises: day.exercises.map((ex, j) => (j === exIdx ? { ...ex, ...p } : ex)) }))
  }

  function addExercise(name: string) {
    if (pickerDay == null) return
    patchDay(pickerDay, (day) => ({ ...day, exercises: [...day.exercises, { id: uid(), name, sets: 3 }] }))
    setPickerDay(null)
  }

  function renameExercise(name: string) {
    if (!renameTarget) return
    patchExercise(renameTarget.dayIdx, renameTarget.exIdx, { name })
    setRenameTarget(null)
  }

  function accept() {
    const name = draft.name.trim()
    const days = draft.days.filter((d) => d.exercises.length > 0)
    if (!name || days.length === 0) return
    const priorities: MesoPriority[] = Object.entries(draft.priorities)
      .filter(([, type]) => type !== 'maintain')
      .map(([id, type]) => ({ muscleGroupId: Number(id), type }))
    const now = Date.now()
    const weeksPlanned = Math.max(1, draft.weeksPlanned)
    onAccept({
      id: meso.id,
      name,
      goal: draft.goal.trim() || undefined,
      unit: draft.unit,
      weeksPlanned,
      deloadWeek: clampDeloadWeek(draft.deloadWeek, weeksPlanned),
      days,
      priorities,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
  }

  const canAccept = draft.name.trim() !== '' && draft.days.some((d) => d.exercises.length > 0)

  return (
    <>
      <div class="card">
        <h3>Review draft mesocycle</h3>
        <input
          class="text-input"
          type="text"
          placeholder="Name (e.g. Upper/Lower Hypertrophy)"
          value={draft.name}
          onInput={(e) => patch((d) => ({ ...d, name: (e.target as HTMLInputElement).value }))}
        />
        <textarea
          class="text-input"
          rows={2}
          placeholder="Goal (e.g. Build upper body size while keeping squat strength)"
          value={draft.goal}
          onInput={(e) => patch((d) => ({ ...d, goal: (e.target as HTMLTextAreaElement).value }))}
        />
        <div class="setting-row">
          <span>Unit</span>
          <div class="seg">
            <button class={draft.unit === 'lbs' ? 'active' : ''} onClick={() => patch((d) => ({ ...d, unit: 'lbs' }))}>
              lbs
            </button>
            <button class={draft.unit === 'kg' ? 'active' : ''} onClick={() => patch((d) => ({ ...d, unit: 'kg' }))}>
              kg
            </button>
          </div>
        </div>
        <div class="setting-row">
          <span>Weeks</span>
          <input
            class="set-input narrow"
            type="number"
            inputMode="numeric"
            min="1"
            value={draft.weeksPlanned}
            onInput={(e) => {
              const n = parseInt((e.target as HTMLInputElement).value, 10)
              if (Number.isFinite(n) && n >= 1)
                patch((d) => ({ ...d, weeksPlanned: n, deloadWeek: clampDeloadWeek(d.deloadWeek, n) }))
            }}
          />
        </div>
        <div class="setting-row">
          <span>Deload week</span>
          <select
            class="select-input"
            value={String(draft.deloadWeek)}
            onChange={(e) =>
              patch((d) => ({ ...d, deloadWeek: Number((e.target as HTMLSelectElement).value) }))
            }
          >
            {Array.from({ length: Math.max(1, draft.weeksPlanned) }, (_, i) => (
              <option key={i} value={String(i)}>
                Week {i + 1}
                {i === draft.weeksPlanned - 1 ? ' (last)' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      {draft.days.map((day, dayIdx) => (
        <div key={day.id} class="card">
          <input
            class="text-input"
            type="text"
            value={day.label}
            onInput={(e) => patchDay(dayIdx, (dd) => ({ ...dd, label: (e.target as HTMLInputElement).value }))}
          />
          {day.exercises.map((ex, exIdx) => (
            <div key={ex.id} class="setting-row" style={{ alignItems: 'flex-start' }}>
              <span class={known.has(ex.name) ? '' : 'warn'}>
                {ex.name}
                {!known.has(ex.name) && ' ⚠'}
              </span>
              <button class="icon-btn sm" title="Rename" onClick={() => setRenameTarget({ dayIdx, exIdx })}>
                ✎
              </button>
              <input
                class="set-input narrow"
                type="number"
                inputMode="numeric"
                min="1"
                value={ex.sets}
                onInput={(e) => {
                  const n = parseInt((e.target as HTMLInputElement).value, 10)
                  if (Number.isFinite(n) && n >= 1) patchExercise(dayIdx, exIdx, { sets: n })
                }}
              />
              <input
                class="set-input narrow"
                type="text"
                placeholder="reps 8-12"
                value={repRangeText(ex.repTarget)}
                onInput={(e) => patchExercise(dayIdx, exIdx, { repTarget: parseRepRange((e.target as HTMLInputElement).value) })}
              />
              <button
                class="icon-btn danger"
                onClick={() => patchDay(dayIdx, (dd) => ({ ...dd, exercises: dd.exercises.filter((_, j) => j !== exIdx) }))}
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
                  onClick={() => patch((d) => ({ ...d, priorities: { ...d.priorities, [g.id]: t } }))}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div class="btn-row">
        <button class="btn primary wide" onClick={accept} disabled={!canAccept}>
          ✅ Accept & save
        </button>
        <button class="btn danger wide" onClick={onDiscard}>
          Discard
        </button>
      </div>
      <p class="muted small">
        Keep chatting below to ask the coach for changes, then tap "Generate draft" again to replace this.
      </p>

      {pickerDay != null && <ExercisePicker onPick={addExercise} onClose={() => setPickerDay(null)} />}
      {renameTarget && <ExercisePicker onPick={renameExercise} onClose={() => setRenameTarget(null)} />}
    </>
  )
}
