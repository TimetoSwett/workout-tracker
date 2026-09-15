import { useEffect, useMemo, useState } from 'preact/hooks'
import type { ActiveWorkout, LoggedExercise, LoggedSet, Template } from '../types'
import { setActive, setTemplates, uid, upsertWorkout, useStore } from '../store'
import { sync } from '../sync'
import { ExercisePicker, emptyExercise } from './ExercisePicker'
import { RestTimer } from './RestTimer'

function nowDate(): string {
  return new Date().toISOString().slice(0, 10)
}

export function LogView() {
  const { active, settings, workouts, templates } = useStore()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [tick, setTick] = useState(0)
  const [toast, setToast] = useState('')
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  useEffect(() => {
    const iv = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(iv)
  }, [])

  const restLeft = useMemo(() => {
    void tick
    if (!active?.restEndsAt) return 0
    return Math.max(0, Math.ceil((active.restEndsAt - Date.now()) / 1000))
  }, [active, tick])

  useEffect(() => {
    if (restLeft === 0 && active?.restEndsAt) {
      if ('vibrate' in navigator) navigator.vibrate?.(400)
      setActive({ ...active, restEndsAt: undefined })
    }
  }, [restLeft])

  const elapsed = useMemo(() => {
    void tick
    if (!active) return 0
    return Math.floor((Date.now() - active.startedAt) / 60000)
  }, [active, tick])

  function patch(fn: (a: ActiveWorkout) => ActiveWorkout) {
    if (!active) return
    setActive(fn(active))
  }

  function startWorkout(name?: string, exercises?: LoggedExercise[]) {
    setActive({
      id: uid(),
      date: nowDate(),
      startedAt: Date.now(),
      name,
      exercises: exercises ?? [],
    })
  }

  function startTemplate(t: Template) {
    startWorkout(
      t.name,
      t.exercises.map((ex) => emptyExercise(ex.name)),
    )
  }

  function addExercise(name: string) {
    if (!active) return
    patch((a) => ({ ...a, exercises: [...a.exercises, emptyExercise(name)] }))
    setPickerOpen(false)
  }

  function patchSet(exIdx: number, setIdx: number, s: Partial<LoggedSet>) {
    patch((a) => {
      const exercises = a.exercises.map((ex, i) =>
        i !== exIdx
          ? ex
          : { ...ex, sets: ex.sets.map((set, j) => (j !== setIdx ? set : { ...set, ...s })) },
      )
      return { ...a, exercises }
    })
  }

  function completeSet(exIdx: number, setIdx: number) {
    const set = active?.exercises[exIdx]?.sets[setIdx]
    if (!set) return
    const done = !set.done
    patchSet(exIdx, setIdx, { done })
    if (done) {
      patch((a) => ({ ...a, restEndsAt: Date.now() + settings.restSeconds * 1000, restTotal: settings.restSeconds }))
    }
  }

  function finish() {
    if (!active) return
    const finished = {
      ...active,
      endedAt: Date.now(),
      exercises: active.exercises
        .map((ex) => ({ ...ex, sets: ex.sets.filter((s) => (s.weight ?? 0) > 0 || (s.reps ?? 0) > 0) }))
        .filter((ex) => ex.sets.length > 0),
      updatedAt: Date.now(),
    }
    if (finished.exercises.length === 0) {
      setActive(null)
      setToast('Nothing logged — workout discarded')
      return
    }
    upsertWorkout(finished)
    setActive(null)
    setToast('Workout saved ✓')
    if (settings.dropboxToken) sync()
    setTimeout(() => setToast(''), 2500)
  }

  function saveAsTemplate() {
    if (!active || active.exercises.length === 0) return
    const name = prompt('Template name', active.name ?? '')?.trim()
    if (!name) return
    const t: Template = {
      id: uid(),
      name,
      exercises: active.exercises.map((ex) => ({ name: ex.name, sets: Math.max(1, ex.sets.length) })),
    }
    setTemplates([...templates, t])
    patch((a) => ({ ...a, name }))
    setToast(`Template “${name}” saved`)
    setTimeout(() => setToast(''), 2500)
  }

  if (!active) {
    return (
      <div class="view">
        <h1>Ready to train?</h1>
        <button class="btn primary big" onClick={() => startWorkout()}>
          Start empty workout
        </button>
        {templates.length > 0 && (
          <div class="card">
            <h3>Templates</h3>
            {templates.map((t) => (
              <button key={t.id} class="template-row" onClick={() => startTemplate(t)}>
                <span class="template-name">{t.name}</span>
                <span class="template-meta">
                  {t.exercises.map((e) => e.name).join(' · ').slice(0, 60)}
                </span>
              </button>
            ))}
          </div>
        )}
        {workouts.length > 0 && (
          <div class="card stat-row">
            <div>
              <div class="stat-num">{workouts.length}</div>
              <div class="stat-label">workouts logged</div>
            </div>
            <div>
              <div class="stat-num">{workouts.filter((w) => w.date >= new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)).length}</div>
              <div class="stat-label">this week</div>
            </div>
          </div>
        )}
        {toast && <div class="toast">{toast}</div>}
      </div>
    )
  }

  return (
    <div class="view">
      <div class="log-header">
        <div>
          <div class="log-title">{active.name ?? 'Workout'}</div>
          <div class="log-sub">
            {active.date} · {elapsed} min elapsed
          </div>
        </div>
        <button class="btn primary" onClick={finish}>
          Finish
        </button>
      </div>

      {active.exercises.map((ex, exIdx) => (
        <div key={ex.id} class="card exercise-card">
          <div class="exercise-head">
            <span class="exercise-name">{ex.name}</span>
            <button
              class="icon-btn danger"
              title="Remove exercise"
              onClick={() => patch((a) => ({ ...a, exercises: a.exercises.filter((_, i) => i !== exIdx) }))}
            >
              ✕
            </button>
          </div>
          <div class="set-grid">
            <div class="set-row set-labels">
              <span>SET</span>
              <span>{settings.units}</span>
              <span>REPS</span>
              <span />
            </div>
            {ex.sets.map((s, setIdx) => (
              <div key={setIdx} class={`set-row ${s.done ? 'done' : ''}`}>
                <span class="set-num">{setIdx + 1}</span>
                <input
                  class="set-input"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="2.5"
                  value={s.weight ?? ''}
                  onInput={(e) => patchSet(exIdx, setIdx, { weight: numOrNull((e.target as HTMLInputElement).value) })}
                />
                <input
                  class="set-input"
                  type="number"
                  inputMode="numeric"
                  min="0"
                  value={s.reps ?? ''}
                  onInput={(e) => patchSet(exIdx, setIdx, { reps: numOrNull((e.target as HTMLInputElement).value) })}
                />
                <button
                  class={`icon-btn ${s.done ? 'success' : ''}`}
                  title={s.done ? 'Un-complete' : 'Complete set'}
                  onClick={() => completeSet(exIdx, setIdx)}
                >
                  ✓
                </button>
              </div>
            ))}
            <button
              class="btn small ghost wide"
              onClick={() =>
                patch((a) => ({
                  ...a,
                  exercises: a.exercises.map((e, i) =>
                    i === exIdx ? { ...e, sets: [...e.sets, { weight: lastWeight(ex), reps: null, done: false }] } : e,
                  ),
                }))
              }
            >
              ＋ Add set
            </button>
          </div>
        </div>
      ))}

      <button class="btn wide" onClick={() => setPickerOpen(true)}>
        ＋ Add exercise
      </button>

      <div class="log-actions">
        <button class="btn ghost" onClick={saveAsTemplate}>
          Save as template
        </button>
        {confirmDiscard ? (
          <>
            <span class="confirm-text">Discard workout?</span>
            <button class="btn danger" onClick={() => setActive(null)}>
              Yes, discard
            </button>
            <button class="btn ghost" onClick={() => setConfirmDiscard(false)}>
              No
            </button>
          </>
        ) : (
          <button class="btn ghost danger-text" onClick={() => setConfirmDiscard(true)}>
            Discard
          </button>
        )}
      </div>

      {restLeft > 0 && active?.restEndsAt && (
        <RestTimer
          secondsLeft={restLeft}
          total={active.restTotal ?? settings.restSeconds}
          onAdd={(s) =>
            patch((a) => ({ ...a, restEndsAt: (a.restEndsAt ?? Date.now()) + s * 1000, restTotal: (a.restTotal ?? 0) + s }))
          }
          onStop={() => patch((a) => ({ ...a, restEndsAt: undefined, restTotal: undefined }))}
        />
      )}

      {pickerOpen && <ExercisePicker onPick={addExercise} onClose={() => setPickerOpen(false)} />}
      {toast && <div class="toast">{toast}</div>}
    </div>
  )
}

function numOrNull(v: string): number | null {
  const n = parseFloat(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function lastWeight(ex: LoggedExercise): number | null {
  for (let i = ex.sets.length - 1; i >= 0; i--) if (ex.sets[i].weight != null) return ex.sets[i].weight
  return null
}
