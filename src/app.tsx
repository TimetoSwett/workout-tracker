import { useEffect, useRef, useState } from 'preact/hooks'
import { App as CapacitorApp } from '@capacitor/app'
import { useStore } from './store'
import { sync } from './sync'
import { dropboxConfigured } from './dropbox'
import { isNative } from './native'
import { LogView } from './components/LogView'
import { HistoryView } from './components/HistoryView'
import { CoachView } from './components/CoachView'
import type { CoachIntent } from './components/CoachView'
import { SettingsView } from './components/SettingsView'
import { MesocyclesView } from './components/MesocyclesView'
import { BodyView } from './components/BodyView'
import { ActivityView } from './components/ActivityView'
import { UpdateBanner } from './components/UpdateBanner'
import { syncMetrics } from './metricsSync'
import { syncCoach } from './coachStore'
import { aiFeaturesEnabled } from './aiGate'
import { isHealthConnectSupported, syncHealthConnectNow } from './healthConnect'

type Tab = 'log' | 'history' | 'insights' | 'body' | 'meso' | 'activity' | 'settings'

const DEFAULT_TAB: Tab = 'log'

export function App() {
  const [tab, setTab] = useState<Tab>(DEFAULT_TAB)
  const [coachIntent, setCoachIntent] = useState<CoachIntent | null>(null)
  const { settings } = useStore()
  const aiOn = aiFeaturesEnabled(settings)
  // Turning the switch off while standing on an AI tab must not leave a blank screen, and
  // a stale tab must never render the coach, so the switch decides what shows — not just
  // which buttons exist.
  const shown: Tab = !aiOn && tab === 'insights' ? DEFAULT_TAB : tab
  const tabRef = useRef(shown)
  tabRef.current = shown

  useEffect(() => {
    if (dropboxConfigured(settings)) {
      sync()
      syncMetrics()
      syncCoach()
    }
    if (isHealthConnectSupported() && settings.healthConnectConnected) {
      void syncHealthConnectNow()
    }
  }, [])

  // The app has no browser history stack (no router), so Capacitor's default
  // back-button behavior — WebView.goBack() else exit — would exit the app
  // from a single back-press on any tab. Go to the Log tab first instead, and
  // only exit once already there.
  useEffect(() => {
    if (!isNative) return
    const handle = CapacitorApp.addListener('backButton', () => {
      if (tabRef.current !== DEFAULT_TAB) {
        setTab(DEFAULT_TAB)
      } else {
        CapacitorApp.exitApp()
      }
    })
    return () => {
      void handle.then((h) => h.remove())
    }
  }, [])

  return (
    <div class="app">
      <main>
        <UpdateBanner />
        {shown === 'log' && <LogView />}
        {shown === 'history' && <HistoryView />}
        {shown === 'insights' && (
          <CoachView
            intent={coachIntent}
            onIntentHandled={() => setCoachIntent(null)}
            onDraftAccepted={() => setTab('meso')}
          />
        )}
        {shown === 'body' && <BodyView />}
        {shown === 'activity' && <ActivityView />}
        {shown === 'meso' && (
          <MesocyclesView
            onPlanMeso={
              aiOn
                ? () => {
                    setCoachIntent('plan-meso')
                    setTab('insights')
                  }
                : undefined
            }
          />
        )}
        {shown === 'settings' && <SettingsView />}
      </main>
      <nav class="tabbar">
        <button class={shown === 'log' ? 'active' : ''} onClick={() => setTab('log')}>
          <span class="tab-icon">🏋️</span>Log
        </button>
        <button class={shown === 'meso' ? 'active' : ''} onClick={() => setTab('meso')}>
          <span class="tab-icon">📅</span>Plan
        </button>
        <button class={shown === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          <span class="tab-icon">📊</span>History
        </button>
        {aiOn && (
          <button class={shown === 'insights' ? 'active' : ''} onClick={() => setTab('insights')}>
            <span class="tab-icon">🧠</span>Coach
          </button>
        )}
        <button class={shown === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}>
          <span class="tab-icon">🧗</span>Activity
        </button>
        <button class={shown === 'body' ? 'active' : ''} onClick={() => setTab('body')}>
          <span class="tab-icon">⚖️</span>Body
        </button>
        <button class={shown === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
          <span class="tab-icon">⚙️</span>Settings
        </button>
      </nav>
    </div>
  )
}
