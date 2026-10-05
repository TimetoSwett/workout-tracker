import { LegacyWeights } from './LegacyWeights'
import { useEffect, useState } from 'preact/hooks'
import type { AISettings, Workout } from '../types'
import { clearHistory, getState, setSettings, setWorkouts, useStore } from '../store'
import { sync } from '../sync'
import { syncMetrics } from '../metricsSync'
import { authorizeUrl, beginAuth, completeAuth, disconnectDropbox, dropboxConfigured, testConnection } from '../dropbox'
import { syncCoach } from '../coachStore'
import { clearMetrics } from '../metricsStore'
import { aiChat } from '../ai'
import { isNative, openExternal } from '../native'
import { useUpdateController } from '../useUpdate'
import { APP_VERSION, APP_VERSION_CODE } from '../version'
import type { Units } from '../units'
import { convertStoredWeights } from '../unitsMigration'
import {
  HEALTH_CONNECT_PLAY_STORE_URL,
  connectHealthConnect,
  getHealthConnectAvailability,
  getHealthConnectPermissions,
  isHealthConnectSupported,
  openHealthConnectSettings,
  syncHealthConnectNow,
  type HealthConnectAvailability,
  type HealthConnectPermissionResult,
} from '../healthConnect'

/** Quotes a CSV cell, doubling inner quotes and neutralizing spreadsheet formula prefixes. */
function csvCell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
  return `"${safe.replace(/"/g, '""')}"`
}

/** Minimal shape check so a malformed import can't persist data that crashes every render. */
function isWorkoutShape(w: unknown): w is Workout {
  if (typeof w !== 'object' || w === null) return false
  const o = w as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    o.id.length > 0 &&
    typeof o.startedAt === 'number' &&
    Array.isArray(o.exercises) &&
    o.exercises.every((ex) => typeof ex === 'object' && ex !== null && Array.isArray((ex as { sets?: unknown }).sets))
  )
}

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
  const [appKey, setAppKey] = useState(settings.dropboxAppKey ?? '')
  const [code, setCode] = useState('')
  const [ai, setAi] = useState<AISettings>(
    settings.ai ? { ...settings.ai, apiKey: '' } : { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: '', baseUrl: '' },
  )
  const [status, setStatus] = useState('')
  const [dbxStatus, setDbxStatus] = useState('')
  const [showHelp, setShowHelp] = useState(false)
  const [hcAvailability, setHcAvailability] = useState<HealthConnectAvailability | null>(null)
  const [hcPermissions, setHcPermissions] = useState<HealthConnectPermissionResult | null>(null)
  const [hcBusy, setHcBusy] = useState(false)
  const [hcStatus, setHcStatus] = useState('')

  useEffect(() => {
    if (!isHealthConnectSupported()) return
    void getHealthConnectAvailability().then((a) => {
      setHcAvailability(a)
      if (a.available) void getHealthConnectPermissions().then(setHcPermissions)
    })
  }, [])

  /** Every stored weight is a bare number in the current unit, so switching has to
   *  rewrite them all — otherwise a 5,050 lbs session just relabels as 5,050 kg. */
  function switchUnits(to: Units) {
    if (settings.units === to) return
    const from = settings.units
    if (!confirm(`Switch to ${to}? Every stored weight — logged sets, bodyweight, body metrics and your goal rate — will be converted from ${from} to ${to} on this device.`)) {
      return
    }
    const { workouts, metrics } = convertStoredWeights(from, to)
    flash(`Converted to ${to}: ${workouts} workout${workouts === 1 ? '' : 's'}, ${metrics} day${metrics === 1 ? '' : 's'} of body metrics`)
    if (dropboxConfigured(getState().settings)) {
      void sync()
      void syncMetrics()
    }
  }

  function flash(msg: string) {
    setStatus(msg)
    setTimeout(() => setStatus(''), 4000)
  }

  function flashDbx(msg: string) {
    setDbxStatus(msg)
    setTimeout(() => setDbxStatus(''), 5000)
  }

  function flashHc(msg: string) {
    setHcStatus(msg)
    setTimeout(() => setHcStatus(''), 5000)
  }

  async function handleHealthConnectSync() {
    setHcBusy(true)
    try {
      const res = await syncHealthConnectNow()
      flashHc(res.error ?? `${res.days.added} new days, ${res.days.updated} updated`)
    } finally {
      setHcBusy(false)
    }
  }

  async function handleHealthConnectConnect() {
    setHcBusy(true)
    try {
      const res = await connectHealthConnect()
      setHcPermissions(res)
      if (res.granted.length === 0) {
        flashHc('Permissions were denied — use "Open Health Connect" below to grant them.')
        return
      }
      if (!res.allGranted) {
        flashHc('Some permissions were denied — syncing what was granted. Use "Open Health Connect" below to grant the rest.')
      }
      await handleHealthConnectSync()
    } finally {
      setHcBusy(false)
    }
  }

  async function authorize() {
    const key = appKey.trim()
    if (!key) return flashDbx('Enter your app key first')
    setSettings({ ...settings, dropboxAppKey: key })
    await openExternal(await authorizeUrl(key, beginAuth()))
    flashDbx('Approve in Dropbox, then paste the code below')
  }

  async function connect() {
    const key = appKey.trim()
    if (!key) return flashDbx('Enter your app key first')
    if (!code.trim()) return flashDbx('Paste the code from Dropbox first')
    const err = await completeAuth(key, code)
    if (err) return flashDbx(err)
    setCode('')
    flashDbx('Connected ✓')
    void sync()
  }

  async function checkConnection() {
    flashDbx((await testConnection()) ?? 'Dropbox connection works ✓')
  }

  async function saveAI() {
    const key = ai.apiKey.trim() || settings.ai?.apiKey
    if (!key) {
      setSettings({ ...settings, ai: { ...ai, apiKey: '' } })
      return flash('AI settings saved (no key)')
    }
    const next = { ...ai, apiKey: key }
    try {
      // A one-token liveness probe, so it gets a much tighter cap than a real generation.
      const reply = await aiChat(next, 'Reply with exactly: OK', [{ role: 'user', content: 'ping' }], {
        timeoutMs: 20_000,
      })
      setSettings({ ...settings, ai: next })
      setAi({ ...ai, apiKey: '' })
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
          rows.push([w.date, csvCell(w.name ?? 'Workout'), csvCell(ex.name), i + 1, s.weight ?? '', s.reps ?? ''].join(','))
        })
      })
    }
    download('workouts.csv', rows.join('\n'), 'text/csv')
  }

  function importJson(file: File) {
    file.text().then((text) => {
      try {
        const parsed: unknown = JSON.parse(text)
        if (!Array.isArray(parsed)) throw new Error('expected an array of workouts')
        const bad = parsed.findIndex((w) => !isWorkoutShape(w))
        if (bad >= 0) throw new Error(`item ${bad + 1} is not a workout (needs id, startedAt, exercises[])`)
        // Start from the raw list so existing tombstones survive the write.
        const existing = getState().workouts
        const ids = new Set(existing.map((w) => w.id))
        const added = (parsed as Workout[]).filter((w) => !ids.has(w.id))
        setWorkouts([...existing, ...added])
        flash(`Imported (${added.length} new)`)
      } catch (e) {
        flash(`Import failed: ${e instanceof Error ? e.message : 'invalid JSON'}`)
      }
    })
  }

  return (
    <div class="view cols">
      <h1>Settings</h1>

      <div class="card">
        <h3>Preferences</h3>
        <div class="setting-row">
          <span>Units</span>
          <div class="seg">
            <button class={settings.units === 'lbs' ? 'active' : ''} onClick={() => switchUnits('lbs')}>
              lbs
            </button>
            <button class={settings.units === 'kg' ? 'active' : ''} onClick={() => switchUnits('kg')}>
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
        <LegacyWeights />
        <p class="muted small">
          Data file: <code>/Apps/Workout Tracker/workouts.jsonl</code>
          {settings.lastSyncAt && <> · last synced {new Date(settings.lastSyncAt).toLocaleString()}</>}
        </p>
        {settings.dropboxRefreshToken ? (
          <p class="muted small">Connected ✓ — the app renews its own access from here on.</p>
        ) : settings.dropboxToken ? (
          <p class="warn small">
            Using a pasted token, which Dropbox expires after 4 hours. Connect below to stay signed in.
          </p>
        ) : null}

        {!settings.dropboxRefreshToken && (
          <>
            <input
              class="text-input"
              type="text"
              placeholder="App key"
              autocomplete="off"
              value={appKey}
              onInput={(e) => setAppKey((e.target as HTMLInputElement).value)}
            />
            <div class="btn-row">
              <button class="btn" onClick={authorize}>
                Authorize…
              </button>
            </div>
            <input
              class="text-input"
              type="text"
              placeholder="Paste the code Dropbox shows you"
              autocomplete="off"
              value={code}
              onInput={(e) => setCode((e.target as HTMLInputElement).value)}
            />
            <div class="btn-row">
              <button class="btn primary" onClick={connect}>
                Connect
              </button>
            </div>
          </>
        )}

        <div class="btn-row">
          <button
            class="btn"
            disabled={!settings.dropboxRefreshToken && !settings.dropboxToken}
            onClick={() =>
              Promise.all([sync(), syncMetrics(), syncCoach()]).then(
                ([a, b, c]) => flashDbx(a ?? b ?? c ?? 'Synced ✓'),
              )
            }
          >
            Sync now
          </button>
          <button class="btn ghost" disabled={!settings.dropboxRefreshToken && !settings.dropboxToken} onClick={checkConnection}>
            Test
          </button>
          {settings.dropboxRefreshToken && (
            <button
              class="btn ghost danger-text"
              onClick={() => {
                disconnectDropbox()
                flashDbx('Disconnected')
              }}
            >
              Disconnect
            </button>
          )}
          {dbxStatus && <span class="muted small">{dbxStatus}</span>}
        </div>
        <button class="btn ghost wide" onClick={() => setShowHelp(!showHelp)}>
          {showHelp ? 'Hide' : 'How do I connect Dropbox?'}
        </button>
        {showHelp && (
          <ol class="help-list">
            <li>
              Go to{' '}
              <a
                href="https://www.dropbox.com/developers/apps"
                target="_blank"
                rel="noreferrer"
                onClick={(e) => {
                  e.preventDefault()
                  void openExternal('https://www.dropbox.com/developers/apps')
                }}
              >
                dropbox.com/developers/apps
              </a>{' '}
              and click "Create app".
            </li>
            <li>Choose "App folder" access (the app only sees its own folder) and name it "Workout Tracker".</li>
            <li>In the app's Permissions tab, grant <b>files.content.read</b> and <b>files.content.write</b>, then Submit.</li>
            <li>
              On the Settings tab copy the <b>App key</b> — not a generated token — and paste it above. The app key is
              public by design; there is no secret to leak.
            </li>
            <li>Tap "Authorize…", approve the app in Dropbox, and paste the code it shows you into the second box.</li>
            <li>
              That grants offline access, so the app renews itself from now on. A pasted access token would have died
              after 4 hours.
            </li>
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
          placeholder={settings.ai?.apiKey ? '•••• saved — enter to replace' : 'API key'}
          value={ai.apiKey}
          onInput={(e) => setAi({ ...ai, apiKey: (e.target as HTMLInputElement).value })}
        />
        <button class="btn wide" onClick={saveAI}>
          Save & test AI
        </button>
      </div>

      <div class="card">
        <h3>Health data (Samsung Health)</h3>
        <p class="muted small">
          Samsung Health app → Settings → Download personal data. Import the whole zip — weight, body
          composition, steps, and sleep are extracted automatically (raw/duplicate files are skipped).
          Re-import anytime; duplicates merge.
        </p>
        <label class="btn ghost wide file-btn">
          Import Samsung Health CSV / zip
          <input
            type="file"
            accept=".csv,.zip"
            multiple
            hidden
            onChange={async (e) => {
              const input = e.target as HTMLInputElement
              const files = Array.from(input.files ?? [])
              if (!files.length) return
              const { importSamsungHealth } = await import('../healthImport')
              const res = await importSamsungHealth(files, settings.units)
              input.value = ''
              flash(
                `${res.days.added} new days, ${res.days.updated} updated (${res.files.length} files recognized)` +
                  (res.bodyweight ? ` — bodyweight now ${res.bodyweight}${settings.units}` : '') +
                  (res.errors.length ? ` — issues: ${res.errors[0]}` : ''),
              )
              if (settings.dropboxToken) {
                const { syncMetrics } = await import('../metricsSync')
                void syncMetrics()
              }
            }}
          />
        </label>
      </div>

      {isHealthConnectSupported() && (
        <div class="card">
          <h3>Health Connect</h3>
          {hcAvailability == null ? (
            <p class="muted small">Checking Health Connect…</p>
          ) : !hcAvailability.available ? (
            <>
              <p class="muted small">
                {hcAvailability.needsUpdate
                  ? 'Health Connect is installed but needs an update before it can share data.'
                  : "Health Connect isn't installed. It's how Samsung Health and MyFitnessPal share steps, sleep, weight, and nutrition with other apps."}
              </p>
              <button class="btn ghost wide" onClick={() => openExternal(HEALTH_CONNECT_PLAY_STORE_URL)}>
                Open Health Connect in Play Store
              </button>
            </>
          ) : (
            <>
              <p class="muted small">
                Reads steps, sleep, weight, body fat, resting heart rate, and logged calories/macros from Health
                Connect — whatever Samsung Health, MyFitnessPal, or other connected apps write there. For
                calories and macros, turn on MyFitnessPal's Health Connect link (Settings → set up your MFP account
                in the Health Connect app, or from within MyFitnessPal's own app-permissions screen), alongside
                steps. Re-sync anytime; duplicates merge.
              </p>
              <div class="btn-row">
                <button class="btn ghost" disabled={hcBusy} onClick={handleHealthConnectConnect}>
                  {hcPermissions?.allGranted ? 'Re-check permissions' : 'Connect Health Connect'}
                </button>
                <button
                  class="btn ghost"
                  disabled={hcBusy || !hcPermissions?.granted.length}
                  onClick={handleHealthConnectSync}
                >
                  Sync now
                </button>
              </div>
              {hcPermissions != null && !hcPermissions.allGranted && (
                <>
                  <p class="muted small">
                    {hcPermissions.granted.length > 0
                      ? 'Some permissions are still denied.'
                      : "Health Connect hasn't granted any permissions yet."}
                  </p>
                  <button class="btn ghost wide" disabled={hcBusy} onClick={() => openHealthConnectSettings()}>
                    Open Health Connect
                  </button>
                </>
              )}
              <p class="muted small">
                {settings.healthConnectLastSyncAt
                  ? `Last synced ${new Date(settings.healthConnectLastSyncAt).toLocaleString()}`
                  : 'Not synced yet.'}
              </p>
            </>
          )}
          {hcStatus && <p class="muted small">{hcStatus}</p>}
        </div>
      )}

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
              clearHistory()
              clearMetrics()
              location.reload()
            }
          }}
        >
          Reset local data
        </button>
      </div>

      <AboutCard />

      {status && <div class="toast visible">{status}</div>}
    </div>
  )
}

/** Answers "am I on the fix?" without guessing, and lets the board force an update check instead
 *  of waiting for the throttled launch one (TOM-2). APP_VERSION comes from package.json via a
 *  Vite define, and android/app/build.gradle derives versionName from the same value, so this
 *  string is the version of the artifact rather than a hand-maintained copy of it. */
function AboutCard() {
  const { check, busy, progress, message, runCheck, install } = useUpdateController()
  const updateReady = check?.kind === 'update-available' || check?.kind === 'web-update-ready'
  const pct = progress == null ? null : Math.round(progress * 100)

  return (
    <div class="card">
      <h3>About</h3>
      <p class="muted small">
        Version <strong>{APP_VERSION}</strong> (build {APP_VERSION_CODE})
        {isNative ? ' · Android' : ''}
      </p>
      <p class="muted small">
        Android's app info shows the same version. Quote it when reporting something broken so we know which
        build you are on.
      </p>
      <div class="btn-row">
        <button class="btn ghost" disabled={busy} onClick={runCheck}>
          {busy && !updateReady ? 'Checking…' : 'Check for updates'}
        </button>
        {check?.kind === 'update-available' && (
          <button class="btn primary" disabled={busy} onClick={install}>
            {`Update to ${check.version}`}
          </button>
        )}
        {check?.kind === 'web-update-ready' && (
          <button class="btn primary" disabled={busy} onClick={install}>
            Reload for the new version
          </button>
        )}
      </div>
      {pct != null && (
        <div class="update-progress">
          <div style={{ width: `${pct}%` }} />
        </div>
      )}
      {message && <p class="muted small">{message}</p>}
    </div>
  )
}
