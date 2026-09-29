import { useEffect, useRef, useState } from 'preact/hooks'
import { App as CapacitorApp } from '@capacitor/app'
import { useStore } from './store'
import { sync } from './sync'
import { dropboxConfigured } from './dropbox'
import { isNative } from './native'
import { LogView } from './components/LogView'
import { HistoryView } from './components/HistoryView'
import { CoachView } from './components/CoachView'
import { SettingsView } from './components/SettingsView'
import { MesocyclesView } from './components/MesocyclesView'
import { BodyView } from './components/BodyView'
import { ActivityView } from './components/ActivityView'
import { syncMetrics } from './metricsSync'
import { syncCoach } from './coachStore'
import { isHealthConnectSupported, syncHealthConnectNow } from './healthConnect'

type Tab = 'log' | 'history' | 'insights' | 'body' | 'meso' | 'activity' | 'settings'

const DEFAULT_TAB: Tab = 'log'

export function App() {
  const [tab, setTab] = useState<Tab>(DEFAULT_TAB)
  const { settings } = useStore()
  const tabRef = useRef(tab)
  tabRef.current = tab

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
        {tab === 'log' && <LogView />}
        {tab === 'history' && <HistoryView />}
        {tab === 'insights' && <CoachView />}
        {tab === 'body' && <BodyView />}
        {tab === 'activity' && <ActivityView />}
        {tab === 'meso' && <MesocyclesView />}
        {tab === 'settings' && <SettingsView />}
      </main>
      <nav class="tabbar">
        <button class={tab === 'log' ? 'active' : ''} onClick={() => setTab('log')}>
          <span class="tab-icon">🏋️</span>Log
        </button>
        <button class={tab === 'meso' ? 'active' : ''} onClick={() => setTab('meso')}>
          <span class="tab-icon">📅</span>Plan
        </button>
        <button class={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          <span class="tab-icon">📊</span>History
        </button>
        <button class={tab === 'insights' ? 'active' : ''} onClick={() => setTab('insights')}>
          <span class="tab-icon">🧠</span>Coach
        </button>
        <button class={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}>
          <span class="tab-icon">🧗</span>Activity
        </button>
        <button class={tab === 'body' ? 'active' : ''} onClick={() => setTab('body')}>
          <span class="tab-icon">⚖️</span>Body
        </button>
        <button class={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
          <span class="tab-icon">⚙️</span>Settings
        </button>
      </nav>
    </div>
  )
}
