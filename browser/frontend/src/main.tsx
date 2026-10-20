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
import { SignInGate } from './shell/SignIn'

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
