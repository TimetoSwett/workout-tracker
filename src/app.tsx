import { useEffect, useState } from 'preact/hooks'
import { useStore } from './store'
import { sync } from './sync'
import { LogView } from './components/LogView'
import { HistoryView } from './components/HistoryView'
import { InsightsView } from './components/InsightsView'
import { SettingsView } from './components/SettingsView'

type Tab = 'log' | 'history' | 'insights' | 'settings'

export function App() {
  const [tab, setTab] = useState<Tab>('log')
  const { settings } = useStore()

  useEffect(() => {
    if (settings.dropboxToken) sync()
  }, [])

  return (
    <div class="app">
      <main>
        {tab === 'log' && <LogView />}
        {tab === 'history' && <HistoryView />}
        {tab === 'insights' && <InsightsView />}
        {tab === 'settings' && <SettingsView />}
      </main>
      <nav class="tabbar">
        <button class={tab === 'log' ? 'active' : ''} onClick={() => setTab('log')}>
          <span class="tab-icon">🏋️</span>Log
        </button>
        <button class={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          <span class="tab-icon">📊</span>History
        </button>
        <button class={tab === 'insights' ? 'active' : ''} onClick={() => setTab('insights')}>
          <span class="tab-icon">🧠</span>Insights
        </button>
        <button class={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
          <span class="tab-icon">⚙️</span>Settings
        </button>
      </nav>
    </div>
  )
}
