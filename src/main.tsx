import { render } from 'preact'
import './index.css'
import { App } from './app.tsx'
import { initStatusBar } from './native'
import { reloadOnControllerChange } from './webUpdate'
import { startRestWatch } from './restWatch'
import { flushHistory, initStore } from './store'
import { requestPersistentStorage } from './historyDb'

void initStatusBar()
reloadOnControllerChange()
// History lives in IndexedDB, so nothing may read it (render, rest watch, sync) before it is loaded.
// initStore() never rejects: on failure the app runs from memory with the error surfaced.
void initStore().then(() => {
  // Outside the component tree on purpose: the rest deadline has to be watched for as long as
  // the app is open, not for as long as the Log tab happens to be mounted.
  startRestWatch()
  render(<App />, document.getElementById('app')!)
  void requestPersistentStorage()
})

// Make sure a queued history write has started before the page goes away.
addEventListener('pagehide', () => void flushHistory())
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void flushHistory()
})
