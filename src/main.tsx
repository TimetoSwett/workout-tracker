import { render } from 'preact'
import './index.css'
import { App } from './app.tsx'
import { initStatusBar } from './native'

void initStatusBar()
render(<App />, document.getElementById('app')!)
