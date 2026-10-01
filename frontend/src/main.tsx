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

void claimKey()
claimOnHashChange()
installProblemLog()
installChunkRecovery()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
