import { useEffect, useState } from 'preact/hooks'
import { useStore } from './store'
import { sync } from './sync'
import { LogView } from './components/LogView'
import { HistoryView } from './components/HistoryView'
import { CoachView } from './components/CoachView'
import { SettingsView } from './components/SettingsView'
import { MesocyclesView } from './components/MesocyclesView'
import { BodyView } from './components/BodyView'
import { syncMetrics } from './metricsSync'
import { syncCoach } from './coachStore'

type Tab = 'log' | 'history' | 'insights' | 'body' | 'meso' | 'settings'

export function App() {
  const [tab, setTab] = useState<Tab>('log')
  const { settings } = useStore()

  useEffect(() => {
    if (settings.dropboxToken) {
      sync()
      syncMetrics()
      syncCoach()
    }
  }, [])

  return (
    <div class="app">
      <main>
        {tab === 'log' && <LogView />}
        {tab === 'history' && <HistoryView />}
        {tab === 'insights' && <CoachView />}
        {tab === 'body' && <BodyView />}
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
