import { useEffect, useMemo, useState } from 'preact/hooks'
import type { CoachMessage, CoachThread, Goal, Philosophy, Profile, Workout } from '../types'
import { setSettings, useStore } from '../store'
import { aiChat } from '../ai'
import { MEMORY_SYSTEM, PHILOSOPHY_LABELS, coachSystem, compileWorkouts } from '../prompts'
import { deleteThread, getMemory, getThreads, setMemory, subscribeCoach, syncCoach, upsertThread } from '../coachStore'
import { getMetrics } from '../metricsStore'

const TIMEFRAMES = [2, 4, 8, 12]

function numOrUndef(v: string): number | undefined {
  const n = parseFloat(v)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

function uid(): string {
  return crypto.randomUUID()
}

export function CoachView() {
  const { workouts, settings, mesocycles } = useStore()
  const [, force] = useState(0)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [showSetup, setShowSetup] = useState(false)

  useEffect(() => subscribeCoach(() => force((n) => n + 1)), [])

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

  const cutoff = active ? Date.now() - active.weeks * 7 * 864e5 : 0
  const recent = useMemo(
    () =>
      active
        ? workouts.filter((w) => w.startedAt >= cutoff).sort((a, b) => a.startedAt - b.startedAt)
        : [],
    [workouts, active],
  )

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
  function windowFor(thread: CoachThread): Workout[] {
    const from = Date.now() - thread.weeks * 7 * 864e5
    return workouts.filter((w) => w.startedAt >= from).sort((a, b) => a.startedAt - b.startedAt)
  }

  async function run(thread: CoachThread, history: CoachMessage[], userMsg: CoachMessage, isAnalysis: boolean) {
    if (!ai) return
    setBusy(true)
    setError(null)
    upsertThread({ ...thread, messages: [...history, userMsg], updatedAt: Date.now() })
    try {
      const reply = await aiChat(
        ai,
        coachSystem(thread.philosophy, settings.profile, settings, getMetrics(), memory) +
          '\n\n# WORKOUT DATA\n\n' +
          compileWorkouts(windowFor(thread), settings, mesocycles),
        history.concat(userMsg).map((m) => ({ role: m.role, content: m.content })),
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
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
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
        weeks: 4,
        messages: [],
      }
      setActiveId(thread.id)
    }
    const msg: CoachMessage = { role: 'user', content: text, at: Date.now() }
    void run(thread, thread.messages, msg, false)
  }

  function analyze() {
    const thread: CoachThread = {
      id: uid(),
      title: `${settings.philosophy} review — last ${4}w`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      philosophy: settings.philosophy,
      weeks: 4,
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
      content: `Please review my last ${thread.weeks} weeks of training.`,
      at: Date.now(),
    }
    void run(thread, [], msg, true)
  }

  if (!ai?.apiKey) {
    return (
      <div class="view">
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
    <div class="view">
      <h1>Coach</h1>

      <div class="card analyze-bar">
        <div class="timeframe-row">
          <label class="muted">Review last</label>
          {TIMEFRAMES.map((t) => (
            <button
              key={t}
              class={`btn small ${active?.weeks === t ? 'primary' : 'ghost'}`}
              onClick={() => active && upsertThread({ ...active, weeks: t })}
              disabled={!active}
            >
              {t}w
            </button>
          ))}
          <button class="btn primary" onClick={analyze} disabled={busy}>
            Analyze
          </button>
        </div>
        {active && recent.length > 0 && (
          <div class="muted small">{recent.length} workouts in range</div>
        )}
      </div>

      {active ? (
        <div class="card chat-card assistant">
          <div class="chat-label">Conversation</div>
          <div class="muted small" style={{ marginBottom: 6 }}>
            {active.title} · philosophy {PHILOSOPHY_LABELS[active.philosophy]}
          </div>
          <div class="chat-body small muted">
            {active.messages.length} messages — data context: last {active.weeks}w attached to every
            message
          </div>
          <div class="btn-row" style={{ marginTop: 8 }}>
            <button class="btn small ghost" onClick={() => setActiveId(null)}>
              All conversations
            </button>
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
          <div class="chat-body">{m.content}</div>
        </div>
      ))}

      {busy && <div class="card chat-card assistant muted">Thinking…</div>}

      {error && <div class="card error-card">{error}</div>}

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
