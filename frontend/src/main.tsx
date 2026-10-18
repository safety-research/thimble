// first, so that the tour's freeze sees every input before the app's own listeners do
import './tour/freeze'
import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/index.css'
import './lib/telemetry'
import { installProblemLog } from './lib/problemLog'
import { installChunkRecovery } from './lib/chunkRecovery'
import App from './App'
import { claimKey, claimOnHashChange } from './lib/api'
import { guardFetch } from './lib/stale'
import { SignInGate } from './shell/SignIn'

// before the first request: nothing under this browser's key goes to a server that has not proved itself (lib/stale)
guardFetch()
void claimKey()
claimOnHashChange()
installProblemLog()
installChunkRecovery()

// the app only for a signed-in browser; any other sees one line naming the way in (shell/SignIn)
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SignInGate>
      <App />
    </SignInGate>
  </React.StrictMode>,
)
