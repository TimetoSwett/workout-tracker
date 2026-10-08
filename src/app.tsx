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
import { isHealthConnectSupported, syncHealthConnectNow } from './healthConnect'

type Tab = 'log' | 'history' | 'insights' | 'body' | 'meso' | 'activity' | 'settings'

const DEFAULT_TAB: Tab = 'log'

/** Tab bar order, left to right. Kept as a table so the active-tab wiring — the `active` class
 *  and `aria-current` — stays in one place instead of being repeated per button. */
const TABS: { id: Tab; icon: string; caption: string }[] = [
  { id: 'log', icon: '🏋️', caption: 'Log' },
  { id: 'meso', icon: '📅', caption: 'Plan' },
  { id: 'history', icon: '📊', caption: 'History' },
  { id: 'insights', icon: '🧠', caption: 'Coach' },
  { id: 'activity', icon: '🧗', caption: 'Activity' },
  { id: 'body', icon: '⚖️', caption: 'Body' },
  { id: 'settings', icon: '⚙️', caption: 'Settings' },
]

/** Below this the fixed bands around the set editor (timer, page padding, tab bar) eat more of
 *  the box than the rows do — 214px of visual viewport left a 67px editor, one set row. That is
 *  landscape with the on-screen keyboard up; portrait with the keyboard up still has ~460px and
 *  stays as-is. See the `.logging.compact` block in index.css for what the class trims. */
const COMPACT_HEIGHT_PX = 420

const readViewportHeight = () => window.visualViewport?.height ?? window.innerHeight

/** Scroll the field being typed into back inside the shrunken app box.
 *
 *  The box below already resizes to the visual viewport when the keyboard opens, but resizing
 *  it does not move the scroll position: a weight input low in the list ended up below its own
 *  clipped scroller, invisible, and reachable only by scrolling by hand. The app had no focus
 *  handling at all and was relying on the browser's automatic reveal, which a WebView may or
 *  may not do — headless Chromium does not do it at all. Do it explicitly instead.
 *
 *  `nearest` scrolls the minimum needed and is a no-op when the field is already fully visible,
 *  so this never yanks the view away from where the user put it. Deferred two frames so the new
 *  box height is rendered and laid out before we measure against it. */
function revealFocusedField() {
  const el = document.activeElement
  if (!(el instanceof HTMLElement) || !el.matches('input, textarea, select')) return
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (document.activeElement === el) el.scrollIntoView({ block: 'nearest' })
    }),
  )
}

export function App() {
  const [tab, setTab] = useState<Tab>(DEFAULT_TAB)
  const [coachIntent, setCoachIntent] = useState<CoachIntent | null>(null)
  const { settings, active } = useStore()
  const [viewportHeight, setViewportHeight] = useState(readViewportHeight)
  useEffect(() => {
    const update = () => {
      setViewportHeight(readViewportHeight())
      revealFocusedField()
    }
    window.visualViewport?.addEventListener('resize', update)
    window.addEventListener('resize', update)
    return () => {
      window.visualViewport?.removeEventListener('resize', update)
      window.removeEventListener('resize', update)
    }
  }, [])
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

  const logging = tab === 'log' && !!active
  const compact = logging && viewportHeight <= COMPACT_HEIGHT_PX

  return (
    <div
      class={`app ${logging ? 'logging' : ''} ${compact ? 'compact' : ''}`}
      style={logging ? { height: `${viewportHeight}px` } : undefined}
    >
      <main>
        <UpdateBanner />
        {tab === 'log' && <LogView />}
        {tab === 'history' && <HistoryView />}
        {tab === 'insights' && (
          <CoachView
            intent={coachIntent}
            onIntentHandled={() => setCoachIntent(null)}
            onDraftAccepted={() => setTab('meso')}
          />
        )}
        {tab === 'body' && <BodyView />}
        {tab === 'activity' && <ActivityView />}
        {tab === 'meso' && (
          <MesocyclesView
            onPlanMeso={() => {
              setCoachIntent('plan-meso')
              setTab('insights')
            }}
          />
        )}
        {tab === 'settings' && <SettingsView />}
      </main>
      <nav class="tabbar">
        {TABS.map((t) => (
          <button
            key={t.id}
            class={tab === t.id ? 'active' : ''}
            /* The caption survives a zeroed font size in the a11y tree, but nothing announced
               which tab was current. `aria-current` does, in compact and otherwise. */
            aria-current={tab === t.id ? 'page' : undefined}
            onClick={() => setTab(t.id)}
          >
            <span class="tab-icon">{t.icon}</span>
            {t.caption}
          </button>
        ))}
      </nav>
    </div>
  )
}
