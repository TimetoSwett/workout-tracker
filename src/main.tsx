import { render } from 'preact'
import './index.css'
import { App } from './app.tsx'
import { initStatusBar } from './native'
import { reloadOnControllerChange } from './webUpdate'

void initStatusBar()
reloadOnControllerChange()
render(<App />, document.getElementById('app')!)
