import { useState } from 'preact/hooks'
import type { AISettings, Workout } from '../types'
import { setSettings, setWorkouts, useStore } from '../store'
import { sync, testToken } from '../sync'
import { aiChat } from '../ai'

function download(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function SettingsView() {
  const { settings, workouts } = useStore()
  const [token, setToken] = useState(settings.dropboxToken ?? '')
  const [ai, setAi] = useState<AISettings>(
    settings.ai ?? { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: '', baseUrl: '' },
  )
  const [status, setStatus] = useState('')
  const [showHelp, setShowHelp] = useState(false)

  function flash(msg: string) {
    setStatus(msg)
    setTimeout(() => setStatus(''), 4000)
  }

  async function testDropbox() {
    if (!token.trim()) return flash('Enter a token first')
    const err = await testToken(token.trim())
    flash(err ?? 'Dropbox token works ✓')
    if (!err) {
      setSettings({ ...settings, dropboxToken: token.trim() })
      void sync()
    }
  }

  async function saveAI() {
    setSettings({ ...settings, ai: { ...ai, apiKey: ai.apiKey.trim() } })
    if (!ai.apiKey.trim()) return flash('AI settings saved (no key)')
    try {
      const reply = await aiChat({ ...ai, apiKey: ai.apiKey.trim() }, 'Reply with exactly: OK', [{ role: 'user', content: 'ping' }])
      flash(`AI works ✓ (${reply.slice(0, 40)})`)
    } catch (e) {
      flash(`AI error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  function exportJson() {
    download('workouts.json', JSON.stringify(workouts, null, 2), 'application/json')
  }

  function exportCsv() {
    const rows = ['date,workout,exercise,set,weight,reps']
    for (const w of workouts) {
      w.exercises.forEach((ex) => {
        ex.sets.forEach((s, i) => {
          rows.push([w.date, `"${w.name ?? 'Workout'}"`, `"${ex.name}"`, i + 1, s.weight ?? '', s.reps ?? ''].join(','))
        })
      })
    }
    download('workouts.csv', rows.join('\n'), 'text/csv')
  }

  function importJson(file: File) {
    file.text().then((text) => {
      try {
        const parsed = JSON.parse(text) as Workout[]
        if (!Array.isArray(parsed)) throw new Error('expected array')
        const ids = new Set(workouts.map((w) => w.id))
        const merged = [...workouts, ...parsed.filter((w) => w.id && !ids.has(w.id))]
        setWorkouts(merged)
        flash(`Imported (${merged.length - workouts.length} new)`)
      } catch {
        flash('Import failed: invalid JSON')
      }
    })
  }

  return (
    <div class="view">
      <h1>Settings</h1>

      <div class="card">
        <h3>Preferences</h3>
        <div class="setting-row">
          <span>Units</span>
          <div class="seg">
            <button class={settings.units === 'lbs' ? 'active' : ''} onClick={() => setSettings({ ...settings, units: 'lbs' })}>
              lbs
            </button>
            <button class={settings.units === 'kg' ? 'active' : ''} onClick={() => setSettings({ ...settings, units: 'kg' })}>
              kg
            </button>
          </div>
        </div>
        <div class="setting-row">
          <span>Rest timer default</span>
          <input
            class="set-input narrow"
            type="number"
            inputMode="numeric"
            min="15"
            step="15"
            value={settings.restSeconds}
            onInput={(e) => {
              const n = parseInt((e.target as HTMLInputElement).value, 10)
              if (Number.isFinite(n) && n >= 0) setSettings({ ...settings, restSeconds: n })
            }}
          />
          <span class="muted">sec</span>
        </div>
      </div>

      <div class="card">
        <h3>Dropbox sync</h3>
        <p class="muted small">
          Data file: <code>/Apps/Workout Tracker/workouts.jsonl</code>
          {settings.lastSyncAt && <> · last synced {new Date(settings.lastSyncAt).toLocaleString()}</>}
        </p>
        <input
          class="text-input"
          type="password"
          placeholder="Access token"
          value={token}
          onInput={(e) => setToken((e.target as HTMLInputElement).value)}
        />
        <div class="btn-row">
          <button class="btn" onClick={testDropbox}>
            Save & test
          </button>
          <button
            class="btn"
            disabled={!settings.dropboxToken}
            onClick={() => sync().then((err) => flash(err ?? 'Synced ✓'))}
          >
            Sync now
          </button>
        </div>
        <button class="btn ghost wide" onClick={() => setShowHelp(!showHelp)}>
          {showHelp ? 'Hide' : 'How do I get a token?'}
        </button>
        {showHelp && (
          <ol class="help-list">
            <li>Go to dropbox.com/developers/apps and click "Create app".</li>
            <li>Choose "App folder" access (the app only sees its own folder) and name it "Workout Tracker".</li>
            <li>In the app's Permissions tab, grant <b>files.content.read</b> and <b>files.content.write</b>.</li>
            <li>In the Settings tab, click "Generate access token" and paste it above.</li>
            <li>Note: generated tokens don't expire by default. If sync stops working, generate a new one.</li>
          </ol>
        )}
      </div>

      <div class="card">
        <h3>AI provider</h3>
        <div class="setting-row">
          <span>Provider</span>
          <div class="seg">
            <button
              class={ai.provider === 'anthropic' ? 'active' : ''}
              onClick={() => setAi({ ...ai, provider: 'anthropic' })}
            >
              Claude
            </button>
            <button
              class={ai.provider === 'openai' ? 'active' : ''}
              onClick={() =>
                setAi({
                  ...ai,
                  provider: 'openai',
                  baseUrl: ai.baseUrl || 'https://nano-gpt.com/api/v1',
                  model: ai.model?.startsWith('claude') ? '' : ai.model,
                })
              }
            >
              OpenAI-compatible
            </button>
          </div>
        </div>
        {ai.provider === 'anthropic' ? (
          <p class="muted small">
            Get a key at console.anthropic.com. Default model: claude-sonnet-4-5.
          </p>
        ) : (
          <p class="muted small">
            Works with NanoGPT, OpenRouter, or any OpenAI-compatible API. Set the base URL and model name
            from your provider's docs.
          </p>
        )}
        <input
          class="text-input"
          type="text"
          placeholder="Model (e.g. claude-sonnet-4-5)"
          value={ai.model}
          onInput={(e) => setAi({ ...ai, model: (e.target as HTMLInputElement).value })}
        />
        {ai.provider === 'openai' && (
          <input
            class="text-input"
            type="text"
            placeholder="Base URL (e.g. https://nano-gpt.com/api/v1)"
            value={ai.baseUrl ?? ''}
            onInput={(e) => setAi({ ...ai, baseUrl: (e.target as HTMLInputElement).value })}
          />
        )}
        <input
          class="text-input"
          type="password"
          placeholder="API key"
          value={ai.apiKey}
          onInput={(e) => setAi({ ...ai, apiKey: (e.target as HTMLInputElement).value })}
        />
        <button class="btn wide" onClick={saveAI}>
          Save & test AI
        </button>
      </div>

      <div class="card">
        <h3>Data</h3>
        <div class="btn-row">
          <button class="btn ghost" onClick={exportJson}>
            Export JSON
          </button>
          <button class="btn ghost" onClick={exportCsv}>
            Export CSV
          </button>
          <label class="btn ghost file-btn">
            Import JSON
            <input
              type="file"
              accept="application/json"
              hidden
              onChange={(e) => {
                const f = (e.target as HTMLInputElement).files?.[0]
                if (f) importJson(f)
              }}
            />
          </label>
        </div>
        <button
          class="btn danger wide"
          onClick={() => {
            if (confirm('Clear ALL local data? Cloud copy (if any) is kept.')) {
              localStorage.removeItem('wt.v1')
              location.reload()
            }
          }}
        >
          Reset local data
        </button>
      </div>

      {status && <div class="toast visible">{status}</div>}
    </div>
  )
}
