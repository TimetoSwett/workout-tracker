import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { CoachMessage, CoachThread, Goal, Mesocycle, Philosophy, Profile, Workout } from '../types'
import { setSettings, saveMesocycle, useStore } from '../store'
import { sync } from '../sync'
import { dropboxConfigured } from '../dropbox'
import { aiChat, isCancelled } from '../ai'
import { renderMarkdown } from '../markdown'
import {
  MEMORY_SYSTEM,
  MESO_DRAFT_TRIGGER,
  PHILOSOPHY_LABELS,
  coachSystem,
  compileHistorySummary,
  compileWorkouts,
  mesoPlanSystem,
} from '../prompts'
import { buildMesoDraft, collectKnownExerciseNames, parseMesoDraftJson } from '../mesoDraft'
import { deleteThread, getMemory, getThreads, setMemory, subscribeCoach, syncCoach, upsertThread } from '../coachStore'
import { getMetrics } from '../metricsStore'
import { MesoDraftReview } from './MesoDraftReview'

export type CoachIntent = 'plan-meso'

type Win = 'last' | 'all' | number
const WINDOWS: { key: Win; label: string }[] = [
  { key: 'last', label: 'Last' },
  { key: 2, label: '2w' },
  { key: 4, label: '4w' },
  { key: 8, label: '8w' },
  { key: 12, label: '12w' },
  { key: 'all', label: 'All' },
]

function numOrUndef(v: string): number | undefined {
  const n = parseFloat(v)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

function uid(): string {
  return crypto.randomUUID()
}

interface Props {
  /** Set once by a caller (e.g. the "Plan next meso" link from Mesocycles) to auto-start
   *  that mode on mount. Consumed via `onIntentHandled` so it doesn't re-fire. */
  intent?: CoachIntent | null
  onIntentHandled?: () => void
  /** Called after a draft mesocycle is accepted and saved, so a caller can e.g. switch
   *  to the Mesocycles tab to show it landed. */
  onDraftAccepted?: () => void
}

export function CoachView({ intent, onIntentHandled, onDraftAccepted }: Props = {}) {
  const { workouts, settings, mesocycles, templates } = useStore()
  const [, force] = useState(0)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [showSetup, setShowSetup] = useState(false)
  const [win, setWin] = useState<Win>(4)
  const [draftBusy, setDraftBusy] = useState(false)
  const [draftError, setDraftError] = useState<string | null>(null)
  /** In-flight provider calls, so Cancel has something to abort. Refs, not state:
   *  aborting must reach the controller the running handler created, not a render-time copy. */
  const chatAbort = useRef<AbortController | null>(null)
  const draftAbort = useRef<AbortController | null>(null)

  useEffect(() => subscribeCoach(() => force((n) => n + 1)), [])

  // Don't leave a provider call running against a view that's gone.
  useEffect(
    () => () => {
      chatAbort.current?.abort()
      draftAbort.current?.abort()
    },
    [],
  )

  useEffect(() => {
    if (intent === 'plan-meso' && settings.ai?.apiKey) {
      planMeso()
      onIntentHandled?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent])

  const ai = settings.ai
  const threads = getThreads()
  const active = threads.find((t) => t.id === activeId) ?? null
  const memory = getMemory()

  const filteredThreads = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return threads
    return threads.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.messages.some((m) => m.content.toLowerCase().includes(q)),
    )
  }, [threads, search])

  function patchSettings(patch: Partial<typeof settings>) {
    setSettings({ ...settings, ...patch })
  }

  function patchProfile(patch: Partial<Profile>) {
    patchSettings({ profile: { ...settings.profile, ...patch } })
  }

  async function updateMemory(thread: CoachThread) {
    if (!ai?.apiKey) return
    try {
      const convo = thread.messages
        .slice(-8)
        .map((m) => `${m.role === 'user' ? 'USER' : 'COACH'}: ${m.content}`)
        .join('\n\n')
        .slice(-6000)
      const raw = await aiChat(
        ai,
        MEMORY_SYSTEM,
        [
          {
            role: 'user',
            content: `Current memory:\n${JSON.stringify(memory?.facts ?? [])}\n\nConversation:\n${convo}`,
          },
        ],
      )
      const match = raw.match(/\[[\s\S]*\]/)
      if (!match) return
      const facts = JSON.parse(match[0])
      if (Array.isArray(facts) && facts.every((f) => typeof f === 'string')) {
        setMemory(facts.slice(0, 15))
        void syncCoach()
      }
    } catch {
      // memory update is best-effort; never surface as user error
    }
  }

  /** Workouts inside a thread's review window. Derived from the thread itself, never
   *  from `active` — `analyze()` starts a new thread and runs in the same tick, before
   *  the activeId state update lands, so reading `active` here sends an empty log. */
  function windowOf(w: Win): Workout[] {
    const sorted = [...workouts].sort((a, b) => a.startedAt - b.startedAt)
    if (w === 'all') return sorted
    if (w === 'last') return sorted.slice(-1)
    const from = Date.now() - w * 7 * 864e5
    return sorted.filter((x) => x.startedAt >= from)
  }

  function windowFor(thread: CoachThread): Workout[] {
    return windowOf(thread.scope ?? thread.weeks)
  }

  function dataBlock(thread: CoachThread): string {
    const ws = windowFor(thread)
    return thread.scope === 'all'
      ? compileHistorySummary(ws, settings)
      : '\n\n# WORKOUT DATA\n\n' + compileWorkouts(ws, settings, mesocycles)
  }

  function systemFor(thread: CoachThread): string {
    if (thread.mode === 'meso-plan') {
      return (
        mesoPlanSystem(thread.philosophy, settings.profile, settings, getMetrics(), memory, mesocycles) +
        dataBlock(thread)
      )
    }
    return coachSystem(thread.philosophy, settings.profile, settings, getMetrics(), memory) + dataBlock(thread)
  }

  async function run(thread: CoachThread, history: CoachMessage[], userMsg: CoachMessage, isAnalysis: boolean) {
    if (!ai) return
    setBusy(true)
    setError(null)
    upsertThread({ ...thread, messages: [...history, userMsg], updatedAt: Date.now() })
    const abort = new AbortController()
    chatAbort.current = abort
    try {
      const reply = await aiChat(
        ai,
        systemFor(thread),
        history.concat(userMsg).map((m) => ({ role: m.role, content: m.content })),
        { signal: abort.signal },
      )
      const replyMsg: CoachMessage = { role: 'assistant', content: reply, at: Date.now() }
      const updated: CoachThread = {
        ...thread,
        messages: [...history, userMsg, replyMsg],
        updatedAt: Date.now(),
      }
      upsertThread(updated)
      void syncCoach()
      if (isAnalysis) void updateMemory(updated)
    } catch (e) {
      // A cancel is the board's own doing — the question stays in the thread so it can
      // be re-sent, but it isn't an error to report.
      if (!isCancelled(e)) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (chatAbort.current === abort) chatAbort.current = null
      setBusy(false)
    }
  }

  function cancelChat() {
    chatAbort.current?.abort()
  }

  function cancelDraft() {
    draftAbort.current?.abort()
  }

  function send() {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    let thread = active
    if (!thread) {
      thread = {
        id: uid(),
        title: text.slice(0, 60),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        philosophy: settings.philosophy,
        weeks: typeof win === 'number' ? win : 4,
        ...(typeof win === 'string' ? { scope: win } : {}),
        messages: [],
      }
      setActiveId(thread.id)
    }
    const msg: CoachMessage = { role: 'user', content: text, at: Date.now() }
    void run(thread, thread.messages, msg, false)
  }

  function analyze() {
    const label = WINDOWS.find((w) => w.key === win)?.label ?? '4w'
    const thread: CoachThread = {
      id: uid(),
      title:
        win === 'last' ? 'Last workout review' : win === 'all' ? 'All-time review' : `Training review — ${label}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      philosophy: settings.philosophy,
      weeks: typeof win === 'number' ? win : 4,
      ...(typeof win === 'string' ? { scope: win } : {}),
      messages: [],
    }
    if (windowFor(thread).length === 0) {
      setError(
        workouts.length === 0
          ? 'No workouts logged yet — log a session, or import your RP history from the Plan tab.'
          : `No workouts in the last ${thread.weeks} weeks. Log a session or ask a question directly instead.`,
      )
      return
    }
    setActiveId(thread.id)
    const msg: CoachMessage = {
      role: 'user',
      content:
        win === 'last'
          ? 'Please review my most recent workout — how did it go, and what should I adjust next session?'
          : win === 'all'
            ? 'Please review my whole training history: long-term trends, what has progressed, and what has stalled.'
            : `Please review my last ${thread.weeks} weeks of training.`,
      at: Date.now(),
    }
    void run(thread, [], msg, true)
  }

  function planMeso() {
    const thread: CoachThread = {
      id: uid(),
      title: 'Plan next meso',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      philosophy: settings.philosophy,
      weeks: typeof win === 'number' ? win : 4,
      ...(typeof win === 'string' ? { scope: win } : {}),
      mode: 'meso-plan',
      messages: [],
    }
    setActiveId(thread.id)
    const msg: CoachMessage = {
      role: 'user',
      content: 'Help me plan my next mesocycle.',
      at: Date.now(),
    }
    void run(thread, [], msg, false)
  }

  /** Asks the model to finalize the agreed-on plan as JSON (see MESO_JSON_CONTRACT),
   *  validates the reply, retries once with a correction if it doesn't parse/validate,
   *  then stores the resulting in-memory Mesocycle draft on the thread. Nothing is
   *  saved to the app's mesocycles here — that's a separate review/save step. */
  async function generateDraft() {
    if (!ai || !active || active.mode !== 'meso-plan' || draftBusy) return
    setDraftBusy(true)
    setDraftError(null)
    const sys = systemFor(active)
    const base = active.messages.map((m) => ({ role: m.role, content: m.content }))
    const triggerMsgs = [...base, { role: 'user' as const, content: MESO_DRAFT_TRIGGER }]
    const abort = new AbortController()
    draftAbort.current = abort
    try {
      let reply = await aiChat(ai, sys, triggerMsgs, { signal: abort.signal })
      try {
        const parsed = parseMesoDraftJson(reply)
        applyDraft(parsed)
        return
      } catch (firstErr) {
        const fixMsgs = [
          ...triggerMsgs,
          { role: 'assistant' as const, content: reply },
          {
            role: 'user' as const,
            content: `That reply didn't match the required JSON contract: ${
              firstErr instanceof Error ? firstErr.message : String(firstErr)
            }. Reply with ONLY the corrected JSON in a single \`\`\`json code block — no explanation, no other text.`,
          },
        ]
        reply = await aiChat(ai, sys, fixMsgs, { signal: abort.signal })
        const parsed = parseMesoDraftJson(reply)
        applyDraft(parsed)
      }
    } catch (e) {
      if (!isCancelled(e)) {
        setDraftError(
          `Couldn't produce a valid mesocycle draft: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    } finally {
      if (draftAbort.current === abort) draftAbort.current = null
      setDraftBusy(false)
    }

    function applyDraft(parsed: ReturnType<typeof parseMesoDraftJson>) {
      const known = collectKnownExerciseNames(workouts, templates, mesocycles)
      const { meso, unmatchedExerciseNames } = buildMesoDraft(parsed, known)
      upsertThread({ ...active!, draftMeso: meso, draftUnmatchedExercises: unmatchedExerciseNames, updatedAt: Date.now() })
      void syncCoach()
    }
  }

  /** Nothing is written to the app's mesocycles until this runs — `generateDraft`
   *  only ever stores an in-memory draft on the thread. */
  function acceptDraft(meso: Mesocycle) {
    if (!active) return
    saveMesocycle(meso)
    if (dropboxConfigured(settings)) void sync()
    upsertThread({ ...active, draftMeso: undefined, draftUnmatchedExercises: undefined, updatedAt: Date.now() })
    void syncCoach()
    onDraftAccepted?.()
  }

  function discardDraft() {
    if (!active) return
    upsertThread({ ...active, draftMeso: undefined, draftUnmatchedExercises: undefined, updatedAt: Date.now() })
    void syncCoach()
  }

  if (!ai?.apiKey) {
    return (
      <div class="view narrow">
        <h1>Coach</h1>
        <div class="card">
          <p>Connect an AI provider in Settings to talk to your coach.</p>
          <p class="muted small">
            Supported: Anthropic (Claude API) or any OpenAI-compatible endpoint (NanoGPT, OpenRouter, etc.)
          </p>
        </div>
      </div>
    )
  }

  return (
    <div class="view narrow">
      <h1>Coach</h1>

      <div class="card analyze-bar">
        <div class="timeframe-row">
          <label class="muted">Review</label>
          <div class="timeframe-opts">
            {WINDOWS.map((o) => (
              <button
                key={String(o.key)}
                class={`btn small ${(active ? (active.scope ?? active.weeks) : win) === o.key ? 'primary' : 'ghost'}`}
                onClick={() => {
                  setWin(o.key)
                  if (active) {
                    upsertThread({
                      ...active,
                      weeks: typeof o.key === 'number' ? o.key : active.weeks,
                      scope: typeof o.key === 'string' ? o.key : undefined,
                    })
                  }
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <div class="btn-row">
          <button class="btn primary" onClick={analyze} disabled={busy}>
            Analyze
          </button>
          <button class="btn ghost" onClick={planMeso} disabled={busy}>
            📅 Plan next meso
          </button>
        </div>
        <div class="muted small">
          {(() => {
            const n = windowOf(active ? (active.scope ?? active.weeks) : win).length
            const chars =
              (active ? (active.scope ?? active.weeks) : win) === 'all'
                ? compileHistorySummary(windowOf('all'), settings).length
                : compileWorkouts(windowOf(active ? (active.scope ?? active.weeks) : win), settings, mesocycles).length
            return `${n} session${n === 1 ? '' : 's'} in range · ~${Math.round((chars / 4 + 1500) / 100) / 10}k tokens per message`
          })()}
        </div>
      </div>

      {active ? (
        <div class="card chat-card assistant">
          <div class="chat-label">Conversation</div>
          <div class="muted small" style={{ marginBottom: 6 }}>
            {active.title}
            {active.mode === 'meso-plan' ? ' · meso planning' : ` · philosophy ${PHILOSOPHY_LABELS[active.philosophy]}`}
          </div>
          <div class="chat-body small muted">
            {active.messages.length} messages — data context: last {active.weeks}w attached to every
            message
          </div>
          <div class="btn-row" style={{ marginTop: 8 }}>
            <button class="btn small ghost" onClick={() => setActiveId(null)}>
              All conversations
            </button>
            {active.mode === 'meso-plan' && (
              <button class="btn small primary" onClick={generateDraft} disabled={busy || draftBusy}>
                {draftBusy ? 'Generating draft…' : '📋 Generate draft'}
              </button>
            )}
            {draftBusy && (
              <button class="btn small ghost" onClick={cancelDraft}>
                Cancel
              </button>
            )}
            <button
              class="btn small danger"
              onClick={() => {
                if (confirm('Delete this conversation?')) {
                  deleteThread(active.id)
                  setActiveId(null)
                }
              }}
            >
              Delete
            </button>
          </div>
        </div>
      ) : (
        threads.length > 0 && (
          <div class="card">
            <h3>Past conversations ({threads.length})</h3>
            <input
              class="text-input"
              type="text"
              placeholder="Search conversations…"
              value={search}
              onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
            />
            {filteredThreads.map((t) => (
              <button key={t.id} class="template-row" onClick={() => setActiveId(t.id)}>
                <span class="template-name">{t.title}</span>
                <span class="template-meta">
                  {new Date(t.updatedAt).toLocaleDateString()} · {t.messages.length} messages ·{' '}
                  {PHILOSOPHY_LABELS[t.philosophy]}
                </span>
              </button>
            ))}
          </div>
        )
      )}

      {active?.messages.map((m, i) => (
        <div key={i} class={`card chat-card ${m.role}`}>
          <div class="chat-label">{m.role === 'user' ? 'You' : 'Coach'}</div>
          {/* The board's own messages are shown verbatim; only the model writes markdown. */}
          {m.role === 'assistant' ? (
            <div class="chat-body md">{renderMarkdown(m.content)}</div>
          ) : (
            <div class="chat-body">{m.content}</div>
          )}
        </div>
      ))}

      {busy && (
        <div class="card chat-card assistant muted thinking-card">
          <span>Thinking…</span>
          <button class="btn small ghost" onClick={cancelChat}>
            Cancel
          </button>
        </div>
      )}

      {error && <div class="card error-card">{error}</div>}

      {draftError && <div class="card error-card">{draftError}</div>}

      {active?.draftMeso && (
        <MesoDraftReview
          key={active.draftMeso.id}
          meso={active.draftMeso}
          settings={settings}
          workouts={workouts}
          templates={templates}
          mesocycles={mesocycles}
          onAccept={acceptDraft}
          onDiscard={discardDraft}
        />
      )}

      <div class="followup-bar">
        <input
          class="text-input"
          type="text"
          placeholder={active ? 'Continue this conversation…' : 'Ask your coach anything…'}
          value={input}
          onInput={(e) => setInput((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send()
          }}
        />
        <button class="btn primary" onClick={send} disabled={busy || !input.trim()}>
          Send
        </button>
      </div>

      <button class="btn ghost wide" onClick={() => setShowSetup(!showSetup)}>
        {showSetup ? 'Hide' : 'Coaching setup'}
      </button>

      {showSetup && (
        <>
          <div class="card">
            <h3>Philosophy & goal</h3>
            <div class="setting-row">
              <span>Philosophy</span>
              <select
                class="select-input"
                value={settings.philosophy}
                onChange={(e) =>
                  patchSettings({ philosophy: (e.target as HTMLSelectElement).value as Philosophy })
                }
              >
                {(Object.entries(PHILOSOPHY_LABELS) as [Philosophy, string][]).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div class="setting-row">
              <span>Goal</span>
              <select
                class="select-input"
                value={settings.goal?.type ?? 'maintain'}
                onChange={(e) => {
                  const type = (e.target as HTMLSelectElement).value as Goal['type']
                  patchSettings({
                    goal: type === 'maintain' ? { type } : { type, ratePerWeek: settings.goal?.ratePerWeek },
                  })
                }}
              >
                <option value="cut">Cut (lose fat)</option>
                <option value="maintain">Maintain</option>
                <option value="bulk">Bulk (gain)</option>
              </select>
            </div>
            {settings.goal && settings.goal.type !== 'maintain' && (
              <div class="setting-row">
                <span>Target rate ({settings.units}/week)</span>
                <input
                  class="set-input narrow"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.1"
                  value={settings.goal.ratePerWeek ?? ''}
                  onInput={(e) =>
                    patchSettings({
                      goal: {
                        type: settings.goal!.type,
                        ratePerWeek: numOrUndef((e.target as HTMLInputElement).value),
                      },
                    })
                  }
                />
              </div>
            )}
          </div>

          <div class="card">
            <h3>Athlete</h3>
            <div class="setting-row">
              <span>Age</span>
              <input
                class="set-input narrow"
                type="number"
                inputMode="numeric"
                min="0"
                value={settings.profile?.age ?? ''}
                onInput={(e) => patchProfile({ age: numOrUndef((e.target as HTMLInputElement).value) })}
              />
            </div>
            <div class="setting-row">
              <span>Height ({settings.units === 'lbs' ? 'in' : 'cm'})</span>
              <input
                class="set-input narrow"
                type="number"
                inputMode="decimal"
                min="0"
                value={settings.profile?.height ?? ''}
                onInput={(e) => patchProfile({ height: numOrUndef((e.target as HTMLInputElement).value) })}
              />
            </div>
            <div class="setting-row">
              <span>Bodyweight ({settings.units})</span>
              <input
                class="set-input narrow"
                type="number"
                inputMode="decimal"
                min="0"
                value={settings.profile?.bodyweight ?? ''}
                onInput={(e) => patchProfile({ bodyweight: numOrUndef((e.target as HTMLInputElement).value) })}
              />
            </div>
            <input
              class="text-input"
              type="text"
              placeholder="Injuries / limitations"
              value={settings.profile?.injuries ?? ''}
              onInput={(e) => patchProfile({ injuries: (e.target as HTMLInputElement).value })}
            />
          </div>

          <div class="card">
            <h3>Notes for the coach</h3>
            <p class="muted small">
              Anything you want the coach to always know or remember — preferences, available
              equipment, life context, instructions.
            </p>
            <textarea
              class="text-input"
              rows={4}
              placeholder="e.g. Train in a home gym with rack + dumbbells; prefer 4 days/week; motivate me bluntly…"
              value={settings.coachNotes ?? ''}
              onInput={(e) => patchSettings({ coachNotes: (e.target as HTMLTextAreaElement).value })}
            />
          </div>

          <div class="card">
            <h3>Coach memory</h3>
            <p class="muted small">
              Facts the coach remembered from past analyses — updated automatically after each
              analysis. Edit or remove anything wrong.
            </p>
            {memory?.facts.length ? (
              memory.facts.map((f, i) => (
                <div key={i} class="setting-row">
                  <span class="small">{f}</span>
                  <button
                    class="icon-btn danger"
                    title="Forget"
                    onClick={() => setMemory(memory.facts.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </div>
              ))
            ) : (
              <p class="muted small">Nothing remembered yet — run an Analyze and check back.</p>
            )}
          </div>
        </>
      )}
    </div>
  )
}
