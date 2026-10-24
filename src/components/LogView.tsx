import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { ActiveWorkout, LoggedExercise, LoggedSet, MuscleFeedback, Template, Workout, WorkoutRatings } from '../types'
import { ConversionInProgressError, finishWorkout, getState, setActive as storeSetActive, setTemplates, uid, upsertWorkout, useStore } from '../store'
import { sync } from '../sync'
import { dropboxConfigured } from '../dropbox'
import { buildSkippedWorkout, generateWorkoutExercises, mesoPosition, muscleGroupName } from '../mesoEngine'
import { skipExercise, unskipExercise } from '../skipExercise'
import { SkipReasonDialog } from './SkipReason'
import { ExercisePicker, emptyExercise } from './ExercisePicker'
import { LogCalendar } from './LogCalendar'
import { NextDays } from './NextDays'
import { RestTimer } from './RestTimer'
import { armRestAlert, type AlertOutcome } from '../restAlert'
import { restDone, subscribeRestDone } from '../restWatch'
import { localDate, localDateDaysAgo } from '../dates'
import { isScoringWorkout } from '../records'
import { dayMarkers } from '../calendar'
import { exerciseHistory, weightsFilledForward } from '../setEntry'
import { withExerciseFeel } from '../ratings'

const PUMP_VALUES = [0, 1, 2]
const SORENESS_VALUES = [-1, 0, 1, 2, 3]
const WORKLOAD_VALUES = [0, 1, 2, 3]
const RECOVERY_VALUES = [0, 1, 2, 3]
const JOINT_VALUES = [0, 1, 2, 3, 4, 5]

type FeedbackDraft = Record<number, { pump?: number; soreness?: number; workload?: number; recovery?: number }>

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
  const [historyId, setHistoryId] = useState<string | null>(null)
  const [skipPrompt, setSkipPrompt] = useState<null | { kind: 'day' } | { kind: 'exercise'; id: string }>(null)
  const weightBefore = useRef<number | null>(null)
  const [tick, setTick] = useState(0)
  const [toast, setToast] = useState('')
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [pendingFinish, setPendingFinish] = useState<ActiveWorkout | null>(null)
  const [feedback, setFeedback] = useState<FeedbackDraft | null>(null)
  const [exerciseFeel, setExerciseFeel] = useState<Record<string, { pump?: number; recovery?: number }>>({})
  const [jointSoreness, setJointSoreness] = useState<number | undefined>(undefined)

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
   *  another tab, especially when neither the chime nor the buzz could be delivered.
   *
   *  `subscribeRestDone` delivers whatever is already recorded as it attaches, which covers a
   *  rest that runs out between this render and this effect — the ordinary case when the app
   *  opens on a deadline that has only just passed. */
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

  /** Active-workout edits are refused while a unit conversion runs; say so instead of dropping them silently. */
  function setActive(next: ActiveWorkout | null) {
    try {
      storeSetActive(next)
    } catch (e) {
      if (!(e instanceof ConversionInProgressError)) throw e
      showToast(`Change not saved: ${e.message}`)
    }
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

  /** The field already holds the typed weight. Spreading it waits until the edit is
   *  committed (blur or Enter), and a cleared field stays on this set alone. */
  function commitWeight(exIdx: number, setIdx: number) {
    const previous = weightBefore.current
    patch((a) => {
      const ex = a.exercises[exIdx]
      if (!ex) return a
      const sets = weightsFilledForward(ex.sets, setIdx, previous)
      if (sets === ex.sets) return a
      return { ...a, exercises: a.exercises.map((e, i) => (i === exIdx ? { ...e, sets } : e)) }
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

  async function saveFinished(base: ActiveWorkout, muscleFeedback?: MuscleFeedback[], ratings?: WorkoutRatings) {
    const finished: Workout = { ...base, endedAt: Date.now(), updatedAt: Date.now(), muscleFeedback, ratings }
    // The active workout is cleared only after the history write is committed; on failure it stays.
    const err = await finishWorkout(finished)
    if (err) {
      showToast(`Workout not saved: ${err}`)
      return
    }
    setConfirmDiscard(false)
    setPendingFinish(null)
    setFeedback(null)
    setExerciseFeel({})
    setJointSoreness(undefined)
    showToast('Workout saved ✓')
    if (dropboxConfigured(settings)) sync()
  }

  function finish() {
    if (!active) return
    const trimmed: ActiveWorkout = {
      ...active,
      exercises: active.exercises
        .map((ex) =>
          ex.skipReason
            ? ex
            : { ...ex, sets: ex.sets.filter((s) => (s.weight ?? 0) > 0 || (s.reps ?? 0) > 0) },
        )
        .filter((ex) => ex.skipReason || ex.sets.length > 0),
    }
    if (trimmed.exercises.length === 0) {
      setActive(null)
      setConfirmDiscard(false)
      showToast('Nothing logged — workout discarded')
      return
    }
    const rated = Object.fromEntries(trimmed.exercises.filter((ex) => !ex.skipReason).map((ex) => [ex.id, {}]))
    setExerciseFeel(rated)
    const groupIds = [...new Set(trimmed.exercises.filter((ex) => !ex.skipReason).map((ex) => ex.muscleGroupId).filter((id): id is number => id != null))]
    setPendingFinish(trimmed)
    setFeedback(Object.fromEntries(groupIds.map((id) => [id, {}])))
  }

  function skipMesoDay(reason: string) {
    if (!activeMeso || getState().active) return
    const pos = mesoPosition(activeMeso, getState().workouts)
    const day = activeMeso.days[pos.dayIndex]
    if (!day) return
    upsertWorkout(buildSkippedWorkout(activeMeso, pos, Date.now(), uid(), reason))
    showToast('Day skipped')
    if (dropboxConfigured(settings)) sync()
  }

  function applySkip(reason: string) {
    const prompt = skipPrompt
    setSkipPrompt(null)
    if (!prompt) return
    if (prompt.kind === 'day') {
      skipMesoDay(reason)
      return
    }
    patch((a) => ({
      ...a,
      exercises: a.exercises.map((ex) => (ex.id === prompt.id ? skipExercise(ex, reason) : ex)),
    }))
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

  // This screen is only reachable from finish() on the active workout. Skipped workouts
  // (status: 'skipped') are saved directly and never land here, so they never see this card.
  if (feedback && pendingFinish) {
    const groupIds = Object.keys(feedback).map(Number)
    return (
      <div class="view cols">
        <h1>How'd it feel?</h1>
        <div class="card">
          <h3>Joint soreness</h3>
          <div class="setting-row">
            <span class="muted small">0 = not sore at all · 5 = very painful</span>
            <div class="seg">
              {JOINT_VALUES.map((v) => (
                <button
                  key={v}
                  class={jointSoreness === v ? 'active' : ''}
                  onClick={() => setJointSoreness(v)}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
        </div>
        {pendingFinish.exercises.filter((ex) => !ex.skipReason).map((ex) => (
          <div key={ex.id} class="card">
            <h3>{ex.name}</h3>
            <div class="setting-row">
              <span class="muted small">Pump</span>
              <div class="seg">
                {PUMP_VALUES.map((v) => (
                  <button
                    key={v}
                    type="button"
                    class={exerciseFeel[ex.id]?.pump === v ? 'active' : ''}
                    onClick={() => setExerciseFeel((f) => ({ ...f, [ex.id]: { ...f[ex.id], pump: v } }))}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
            <div class="setting-row">
              <span class="muted small">Recovery</span>
              <div class="seg">
                {RECOVERY_VALUES.map((v) => (
                  <button
                    key={v}
                    type="button"
                    class={exerciseFeel[ex.id]?.recovery === v ? 'active' : ''}
                    onClick={() => setExerciseFeel((f) => ({ ...f, [ex.id]: { ...f[ex.id], recovery: v } }))}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ))}
        {pendingFinish.exercises.some((ex) => !ex.skipReason) && (
          <p class="muted small">Pump: 0 = none, 2 = lots. Recovery: 0 = not recovered since last time, 3 = fully recovered.</p>
        )}
        {groupIds.map((id) => (
          <div key={id} class="card">
            <h3>{muscleGroupName(id, settings.muscleGroupNames)}</h3>
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
            onClick={() => {
              const muscles = groupIds.flatMap((id) => {
                const row = feedback[id]
                if (row?.soreness == null && row?.workload == null) return []
                return [{ muscleGroupId: id, soreness: row.soreness, workload: row.workload }]
              })
              saveFinished(
                { ...pendingFinish, exercises: withExerciseFeel(pendingFinish.exercises, exerciseFeel) },
                muscles.length ? muscles : undefined,
                jointSoreness != null ? { jointSoreness } : undefined,
              )
            }}
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
                  {day && (
                    <button class="btn ghost" type="button" onClick={() => setSkipPrompt({ kind: 'day' })}>
                      Skip day
                    </button>
                  )}
                </>
              )
            })()}
          </div>
        )}
        <button class={`btn big wide ${activeMeso ? 'ghost' : 'primary'}`} onClick={() => startWorkout()}>
          Start empty workout
        </button>
        <NextDays meso={activeMeso} workouts={workouts} />
        <LogCalendar
          workouts={workouts}
          units={settings.units}
          dropbox={dropboxConfigured(settings)}
          meso={activeMeso}
          onStartPlanned={startMesoWorkout}
        />
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
              <div class="stat-num">{workouts.filter(isScoringWorkout).length}</div>
              <div class="stat-label">workouts logged</div>
            </div>
            <div>
              <div class="stat-num">{[...dayMarkers(workouts, { from: localDateDaysAgo(7) }).values()].reduce((n, m) => n + m.done, 0)}</div>
              <div class="stat-label">this week</div>
            </div>
          </div>
        )}
        {toast && <div class="toast">{toast}</div>}
        {skipPrompt?.kind === 'day' && (
          <SkipReasonDialog
            title={
              activeMeso
                ? `Skip ${activeMeso.days[mesoPosition(activeMeso, workouts).dayIndex]?.label ?? 'day'}?`
                : 'Skip day?'
            }
            onChoose={applySkip}
            onCancel={() => setSkipPrompt(null)}
          />
        )}
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
      <LogCalendar workouts={workouts} units={settings.units} activeId={active.id} dropbox={dropboxConfigured(settings)} meso={activeMeso} />

      {active.exercises.map((ex, exIdx) => (
        <div key={ex.id} class="card exercise-card">
          <div class="exercise-head">
            <span class="exercise-name">{ex.name}</span>
            <div class="btn-row" style={{ margin: 0 }}>
              <button
                class="text-btn"
                type="button"
                aria-label={`History for ${ex.name}`}
                onClick={() => setHistoryId(ex.id)}
              >
                History
              </button>
              {ex.skipReason ? (
                <button
                  class="text-btn"
                  type="button"
                  onClick={() =>
                    patch((a) => ({
                      ...a,
                      exercises: a.exercises.map((e) => (e.id === ex.id ? unskipExercise(e) : e)),
                    }))
                  }
                >
                  Undo
                </button>
              ) : (
                <button
                  class="text-btn"
                  type="button"
                  aria-label={`Skip ${ex.name}`}
                  onClick={() => setSkipPrompt({ kind: 'exercise', id: ex.id })}
                >
                  Skip
                </button>
              )}
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
          {ex.skipReason ? (
            <p class="muted">Skipped · {ex.skipReason}</p>
          ) : (
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
                  onFocus={() => { weightBefore.current = s.weight }}
                  onInput={(e) => patchSet(exIdx, setIdx, { weight: numOrNull((e.target as HTMLInputElement).value) })}
                  onBlur={() => commitWeight(exIdx, setIdx)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
                  }}
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
          )}
          {!ex.skipReason && (
          <input
            class={`note-input ${ex.notes ? 'filled' : ''}`}
            type="text"
            placeholder="Note…"
            value={ex.notes ?? ''}
            onInput={(e) => patchExercise(exIdx, { notes: (e.target as HTMLInputElement).value || undefined })}
          />
          )}
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
      {historyId != null && active.exercises.some((ex) => ex.id === historyId) && (
        <ExerciseHistory
          name={active.exercises.find((ex) => ex.id === historyId)!.name}
          sessions={exerciseHistory(
            workouts,
            active.exercises.find((ex) => ex.id === historyId)!,
            active.id,
          )}
          unit={settings.units}
          onClose={() => setHistoryId(null)}
        />
      )}
      {toast && <div class="toast">{toast}</div>}
      {skipPrompt?.kind === 'exercise' && (
        <SkipReasonDialog
          title={`Skip ${active.exercises.find((ex) => ex.id === skipPrompt.id)?.name ?? 'exercise'}?`}
          onChoose={applySkip}
          onCancel={() => setSkipPrompt(null)}
        />
      )}
    </div>
  )
}

function numOrNull(v: string): number | null {
  const n = parseFloat(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function formatHistorySet(weight: number | null, reps: number | null, unit: string): string {
  const load = weight == null ? null : `${weight} ${unit}`
  const repsText = reps == null ? null : `${reps} ${reps === 1 ? 'rep' : 'reps'}`
  if (load && repsText) return `${load} × ${repsText}`
  return load ?? repsText ?? 'Completed'
}

function ExerciseHistory({
  name,
  sessions,
  unit,
  onClose,
}: {
  name: string
  sessions: ReturnType<typeof exerciseHistory>
  unit: string
  onClose: () => void
}) {
  return (
    <div class="modal-backdrop" onClick={onClose}>
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-label={`History for ${name}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="history-head">
          <h3>{name}</h3>
          <button class="text-btn" type="button" onClick={onClose}>
            Close
          </button>
        </div>
        {sessions.length === 0 ? (
          <p class="muted">No completed sets for this exercise yet.</p>
        ) : (
          <ul class="history-sessions">
            {sessions.map((sess, i) => (
              <li key={`${sess.workoutId}-${i}`}>
                <div class="history-date">{sess.date}</div>
                <ol>
                  {sess.sets.map((s, j) => (
                    <li key={j}>{formatHistorySet(s.weight, s.reps, unit)}</li>
                  ))}
                </ol>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function lastWeight(ex: LoggedExercise): number | null {
  for (let i = ex.sets.length - 1; i >= 0; i--) if (ex.sets[i].weight != null) return ex.sets[i].weight
  return null
}
