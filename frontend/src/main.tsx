import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/index.css'
import './lib/telemetry'
import { installProblemLog } from './lib/problemLog'
import { installChunkRecovery } from './lib/chunkRecovery'
import App from './App'

installProblemLog()
installChunkRecovery()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
