import { useState } from 'preact/hooks'
import { useStore } from '../store'
import { aiChat } from '../ai'
import { COACH_SYSTEM, compileWorkouts } from '../prompts'

const TIMEFRAMES = [2, 4, 8, 12]

interface Turn {
  role: 'user' | 'assistant'
  content: string
}

export function InsightsView() {
  const { workouts, settings } = useStore()
  const [weeks, setWeeks] = useState(4)
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [followUp, setFollowUp] = useState('')

  const ai = settings.ai
  const cutoff = Date.now() - weeks * 7 * 864e5
  const recent = workouts.filter((w) => w.startedAt >= cutoff).sort((a, b) => a.startedAt - b.startedAt)

  async function run(messages: Turn[]) {
    if (!ai) return
    setBusy(true)
    setError(null)
    try {
      const reply = await aiChat(ai, COACH_SYSTEM + '\n\n# WORKOUT DATA\n\n' + compileWorkouts(recent, settings), messages)
      setTurns([...messages, { role: 'assistant', content: reply }])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function analyze() {
    if (recent.length === 0) {
      setError(`No workouts in the last ${weeks} weeks.`)
      return
    }
    setTurns([{ role: 'user', content: `Please review my last ${weeks} weeks of training.` }])
    void run([{ role: 'user', content: `Please review my last ${weeks} weeks of training.` }])
  }

  function send() {
    const text = followUp.trim()
    if (!text || busy || turns.length === 0) return
    setFollowUp('')
    void run([...turns, { role: 'user', content: text }])
  }

  if (!ai?.apiKey) {
    return (
      <div class="view">
        <h1>Insights</h1>
        <div class="card">
          <p>Connect an AI provider in Settings to get training analysis and suggestions.</p>
          <p class="muted small">Supported: Anthropic (Claude API) or any OpenAI-compatible endpoint (NanoGPT, OpenRouter, etc.)</p>
        </div>
      </div>
    )
  }

  return (
    <div class="view">
      <h1>Insights</h1>
      <div class="card analyze-bar">
        <label class="muted">Review last</label>
        <div class="timeframe-row">
          {TIMEFRAMES.map((t) => (
            <button key={t} class={`btn small ${t === weeks ? 'primary' : 'ghost'}`} onClick={() => setWeeks(t)}>
              {t}w
            </button>
          ))}
          <button class="btn primary" onClick={analyze} disabled={busy}>
            {busy ? 'Analyzing…' : 'Analyze'}
          </button>
        </div>
        <div class="muted small">{recent.length} workouts in range</div>
      </div>

      {error && <div class="card error-card">{error}</div>}

      {turns.map((t, i) => (
        <div key={i} class={`card chat-card ${t.role}`}>
          {t.role === 'user' ? <div class="chat-label">You</div> : <div class="chat-label">Coach</div>}
          <div class="chat-body">{t.content}</div>
        </div>
      ))}

      {busy && <div class="card chat-card assistant muted">Thinking…</div>}

      {turns.length > 0 && (
        <div class="followup-bar">
          <input
            class="text-input"
            type="text"
            placeholder="Ask a follow-up…"
            value={followUp}
            onInput={(e) => setFollowUp((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') send()
            }}
          />
          <button class="btn primary" onClick={send} disabled={busy || !followUp.trim()}>
            Send
          </button>
        </div>
      )}
    </div>
  )
}
