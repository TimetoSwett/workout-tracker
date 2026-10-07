import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { ActiveWorkout, LoggedExercise, LoggedSet, MuscleFeedback, Template, Workout } from '../types'
import { getState, setActive, setTemplates, uid, upsertWorkout, useStore } from '../store'
import { sync } from '../sync'
import { dropboxConfigured } from '../dropbox'
import { generateWorkoutExercises, mesoPosition, muscleGroupName } from '../mesoEngine'
import { ExercisePicker, emptyExercise } from './ExercisePicker'
import { RestTimer } from './RestTimer'
import { armRestAlert, type AlertOutcome } from '../restAlert'
import { restDone, subscribeRestDone } from '../restWatch'
import { localDate, localDateDaysAgo } from '../dates'

const PUMP_VALUES = [0, 1, 2]
const SORENESS_VALUES = [-1, 0, 1, 2, 3]
const WORKLOAD_VALUES = [0, 1, 2, 3]

type FeedbackDraft = Record<number, { pump?: number; soreness?: number; workload?: number }>

/** The one channel that always arrives. A chime can be blocked by autoplay policy and a buzz
 *  can be swallowed by the platform, so when neither got through the timer status says so instead of
 *  implying the rest quietly ended on its own. */
function restDoneStatus(o: AlertOutcome): string {
  if (o.sound === 'played') return 'Rest done 💪'
  if (o.vibration === 'sent') return 'Rest done 💪 — buzz only, no sound here'
  return 'Rest done 💪 — no sound or buzz on this device'
}

export function LogView() {
  const { active, settings, workouts, templates, mesocycles } = useStore()
  const [picker, setPicker] = useState<'add' | number | null>(null)
  const [tick, setTick] = useState(0)
  const [toast, setToast] = useState('')
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [pendingFinish, setPendingFinish] = useState<ActiveWorkout | null>(null)
  const [feedback, setFeedback] = useState<FeedbackDraft | null>(null)

  const activeMeso = mesocycles.find((m) => m.status === 'active' && !m.imported) ?? null

  useEffect(() => {
    const iv = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(iv)
  }, [])

  const restLeft = useMemo(() => {
    void tick
    if (!active?.restEndsAt) return 0
    return Math.max(0, Math.ceil((active.restEndsAt - Date.now()) / 1000))
  }, [active, tick])

  /** The expiry itself — the alert, and clearing the stored deadline — belongs to
   *  `restWatch`, which keeps running while this view is unmounted. All this does is paint
   *  the outcome of the last rest that ran out, which is still worth reading on return from
   *  another tab, especially when neither the chime nor the buzz could be delivered. */
  const [done, setDone] = useState(restDone())
  useEffect(() => subscribeRestDone(() => setDone(restDone())), [])
  const restStatus = done ? restDoneStatus(done.outcome) : ''

  const elapsed = useMemo(() => {
    void tick
    if (!active) return 0
    return Math.floor((Date.now() - active.startedAt) / 60000)
  }, [active, tick])

  /** One timer, not one per toast, so a new message gets its full display time. */
  const toastTimer = useRef(0)
  function showToast(message: string) {
    setToast(message)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 2500) as unknown as number
  }

  /** Reads the live store rather than the render-time `active`. Two patches in one
   *  handler both build from the same snapshot otherwise, and the second silently
   *  discards the first — `active` only refreshes on the next render. */
  function patch(fn: (a: ActiveWorkout) => ActiveWorkout) {
    const cur = getState().active
    if (!cur) return
    setActive(fn(cur))
  }

  function startWorkout(name?: string, exercises?: LoggedExercise[]) {
    setActive({
      id: uid(),
      date: localDate(),
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

  function pickExercise(name: string) {
    if (picker === 'add') {
      patch((a) => ({ ...a, exercises: [...a.exercises, emptyExercise(name)] }))
    } else if (typeof picker === 'number') {
      const idx = picker
      // A swap changes which lift occupies this slot, nothing else: anything already
      // logged into it, its note, and its prescription all stay. Replacing the whole
      // exercise silently threw away completed sets with no undo.
      patch((a) => ({ ...a, exercises: a.exercises.map((e, i) => (i !== idx ? e : { ...e, name })) }))
    }
    setPicker(null)
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

  function patchExercise(exIdx: number, e: Partial<LoggedExercise>) {
    patch((a) => ({ ...a, exercises: a.exercises.map((ex, i) => (i !== exIdx ? ex : { ...ex, ...e })) }))
  }

  function removeSet(exIdx: number, setIdx: number) {
    patch((a) => ({
      ...a,
      exercises: a.exercises.map((ex, i) =>
        i !== exIdx ? ex : { ...ex, sets: ex.sets.filter((_, j) => j !== setIdx) },
      ),
    }))
  }

  /** Marking done and starting the rest timer are one write: as two they raced, and
   *  the timer patch overwrote the `done` flag with the pre-tap value. */
  function completeSet(exIdx: number, setIdx: number) {
    const set = getState().active?.exercises[exIdx]?.sets[setIdx]
    if (!set) return
    const done = !set.done
    // This tap is the user gesture that lets the completion chime play when the rest it starts
    // runs out, minutes later and with no gesture of its own. Nothing is heard now.
    if (done) armRestAlert()
    patch((a) => ({
      ...a,
      exercises: a.exercises.map((ex, i) =>
        i !== exIdx
          ? ex
          : { ...ex, sets: ex.sets.map((s, j) => (j !== setIdx ? s : { ...s, done })) },
      ),
      ...(done ? { restEndsAt: Date.now() + settings.restSeconds * 1000, restTotal: settings.restSeconds } : null),
    }))
  }

  function saveFinished(base: ActiveWorkout, muscleFeedback?: MuscleFeedback[]) {
    const finished: Workout = { ...base, endedAt: Date.now(), updatedAt: Date.now(), muscleFeedback }
    upsertWorkout(finished)
    setActive(null)
    setConfirmDiscard(false)
    setPendingFinish(null)
    setFeedback(null)
    showToast('Workout saved ✓')
    if (dropboxConfigured(settings)) sync()
  }

  function finish() {
    if (!active) return
    const trimmed: ActiveWorkout = {
      ...active,
      exercises: active.exercises
        .map((ex) => ({ ...ex, sets: ex.sets.filter((s) => (s.weight ?? 0) > 0 || (s.reps ?? 0) > 0) }))
        .filter((ex) => ex.sets.length > 0),
    }
    if (trimmed.exercises.length === 0) {
      setActive(null)
      setConfirmDiscard(false)
      showToast('Nothing logged — workout discarded')
      return
    }
    if (trimmed.mesoId) {
      const groupIds = [...new Set(trimmed.exercises.map((ex) => ex.muscleGroupId).filter((id): id is number => id != null))]
      if (groupIds.length > 0) {
        setPendingFinish(trimmed)
        setFeedback(Object.fromEntries(groupIds.map((id) => [id, {}])))
        return
      }
    }
    saveFinished(trimmed)
  }

  function startMesoWorkout() {
    if (!activeMeso) return
    const pos = mesoPosition(activeMeso, workouts)
    const exercises = generateWorkoutExercises(activeMeso, pos, workouts)
    setActive({
      id: uid(),
      date: localDate(),
      startedAt: Date.now(),
      name: activeMeso.days[pos.dayIndex]?.label ?? activeMeso.name,
      exercises,
      mesoId: activeMeso.id,
      mesoWeek: pos.weekIndex,
      mesoDayPosition: pos.dayIndex,
    })
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
    showToast(`Template “${name}” saved`)
  }

  if (feedback && pendingFinish) {
    const groupIds = Object.keys(feedback).map(Number)
    return (
      <div class="view cols">
        <h1>How'd it feel?</h1>
        {groupIds.map((id) => (
          <div key={id} class="card">
            <h3>{muscleGroupName(id, settings.muscleGroupNames)}</h3>
            <div class="setting-row">
              <span class="muted small">Pump</span>
              <div class="seg">
                {PUMP_VALUES.map((v) => (
                  <button
                    key={v}
                    class={feedback[id].pump === v ? 'active' : ''}
                    onClick={() => setFeedback((f) => (f ? { ...f, [id]: { ...f[id], pump: v } } : f))}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
            <div class="setting-row">
              <span class="muted small">Soreness</span>
              <div class="seg">
                {SORENESS_VALUES.map((v) => (
                  <button
                    key={v}
                    class={feedback[id].soreness === v ? 'active' : ''}
                    onClick={() => setFeedback((f) => (f ? { ...f, [id]: { ...f[id], soreness: v } } : f))}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
            <div class="setting-row">
              <span class="muted small">Workload</span>
              <div class="seg">
                {WORKLOAD_VALUES.map((v) => (
                  <button
                    key={v}
                    class={feedback[id].workload === v ? 'active' : ''}
                    onClick={() => setFeedback((f) => (f ? { ...f, [id]: { ...f[id], workload: v } } : f))}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ))}
        <div class="btn-row">
          <button
            class="btn primary wide"
            onClick={() => saveFinished(pendingFinish, groupIds.map((id) => ({ muscleGroupId: id, ...feedback[id] })))}
          >
            Save workout
          </button>
          <button class="btn ghost wide" onClick={() => saveFinished(pendingFinish)}>
            Skip feedback
          </button>
        </div>
      </div>
    )
  }

  if (!active) {
    return (
      <div class="view cols">
        <h1>Ready to train?</h1>
        {activeMeso && (
          <div class="card">
            <h3>{activeMeso.name}</h3>
            {(() => {
              const pos = mesoPosition(activeMeso, workouts)
              const day = activeMeso.days[pos.dayIndex]
              return (
                <>
                  <div class="muted small">
                    Week {pos.weekIndex + 1}/{activeMeso.weeksPlanned} — {day?.label ?? 'Day'}
                    {pos.isDeload ? ' (deload)' : ''}
                  </div>
                  <button class="btn primary big" onClick={startMesoWorkout}>
                    Start {day?.label ?? 'workout'}
                  </button>
                </>
              )
            })()}
          </div>
        )}
        <button class={`btn big wide ${activeMeso ? 'ghost' : 'primary'}`} onClick={() => startWorkout()}>
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
              <div class="stat-num">{workouts.filter((w) => w.date >= localDateDaysAgo(7)).length}</div>
              <div class="stat-label">this week</div>
            </div>
          </div>
        )}
        {toast && <div class="toast">{toast}</div>}
      </div>
    )
  }

  return (
    <div class="active-log">
      {/* Rendered unconditionally: `restLeft` is already 0 when no rest is running, and the
          strip keeps its height in that state so starting or ending rest moves nothing. */}
      <RestTimer
        secondsLeft={restLeft}
        status={restStatus}
        total={active.restTotal ?? settings.restSeconds}
        onAdd={(s) =>
          patch((a) => ({ ...a, restEndsAt: (a.restEndsAt ?? Date.now()) + s * 1000, restTotal: (a.restTotal ?? 0) + s }))
        }
        onStop={() => patch((a) => ({ ...a, restEndsAt: undefined, restTotal: undefined }))}
      />
    <div class="view log-scroll">
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
            <div class="btn-row" style={{ margin: 0 }}>
              <button class="icon-btn" title="Swap exercise (just for today)" onClick={() => setPicker(exIdx)}>
                ⇄
              </button>
              <button
                class="icon-btn danger"
                title="Remove exercise"
                onClick={() => patch((a) => ({ ...a, exercises: a.exercises.filter((_, i) => i !== exIdx) }))}
              >
                ✕
              </button>
            </div>
          </div>
          <div class="set-grid">
            <div class="set-row set-labels">
              <span>SET</span>
              <span>{settings.units}</span>
              <span>REPS</span>
              <span />
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
                  placeholder={s.weightTarget != null ? String(s.weightTarget) : undefined}
                  value={s.weight ?? ''}
                  onInput={(e) => patchSet(exIdx, setIdx, { weight: numOrNull((e.target as HTMLInputElement).value) })}
                />
                <input
                  class="set-input"
                  type="number"
                  inputMode="numeric"
                  min="0"
                  placeholder={s.repsTarget != null ? String(s.repsTarget) : undefined}
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
                <button
                  class="icon-btn sm"
                  title={`Remove set ${setIdx + 1}`}
                  aria-label={`Remove set ${setIdx + 1}`}
                  onClick={() => removeSet(exIdx, setIdx)}
                >
                  ✕
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
          <input
            class={`note-input ${ex.notes ? 'filled' : ''}`}
            type="text"
            placeholder="Note…"
            value={ex.notes ?? ''}
            onInput={(e) => patchExercise(exIdx, { notes: (e.target as HTMLInputElement).value || undefined })}
          />
        </div>
      ))}

      <button class="btn wide" onClick={() => setPicker('add')}>
        ＋ Add exercise
      </button>

      <div class="log-actions">
        <button class="btn ghost" onClick={saveAsTemplate}>
          Save as template
        </button>
        {confirmDiscard ? (
          <>
            <span class="confirm-text">Discard workout?</span>
            <button
              class="btn danger"
              onClick={() => {
                setActive(null)
                setConfirmDiscard(false)
              }}
            >
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
    </div>
      {picker != null && <ExercisePicker onPick={pickExercise} onClose={() => setPicker(null)} />}
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
