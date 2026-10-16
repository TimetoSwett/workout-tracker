import { render } from 'preact'
import './index.css'
import { App } from './app.tsx'
import { initStatusBar } from './native'
import { reloadOnControllerChange } from './webUpdate'
import { startRestWatch } from './restWatch'

void initStatusBar()
reloadOnControllerChange()
// Outside the component tree on purpose: the rest deadline has to be watched for as long as
// the app is open, not for as long as the Log tab happens to be mounted.
startRestWatch()
render(<App />, document.getElementById('app')!)
