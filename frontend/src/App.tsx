// The page shell for the workspace named in the URL. A URL that names no workspace, or one this server does not hold, is
// thimble's start page (shell/StartPage), which lists the server's workspaces. Before the shell mounts (it reads browser
// storage as it does), the workspace's instance is checked, so a workspace made again under an old name does not open on
// the old one's state (lib/workspace.ts syncInstance); a failure or a slow answer lets the shell mount with the state as
// it is.
import { useEffect, useState } from 'react'
import { api } from './lib/api'
import { useTheme } from './lib/theme'
import { syncInstance, workspaceFromUrl } from './lib/workspace'
import { Shell } from './shell/Shell'
import { StartPage } from './shell/StartPage'

/** How long the page waits on the instance check before it mounts the shell anyway (ms). */
const INSTANCE_WAIT = 1500

export default function App() {
  const ws = workspaceFromUrl()
  // a URL naming a workspace this server does not hold (a tab kept from another run or another server): the start page
  const [missing, setMissing] = useState(false)
  // the instance check has settled (INSTANCE_WAIT caps it)
  const [checked, setChecked] = useState(false)
  const { paper, accent } = useTheme()
  // the card harness draws a card offscreen in the theme this browser last showed (backend/app/render.py)
  useEffect(() => {
    if (ws) api.reportTheme(ws, paper, accent).catch(() => undefined)
  }, [ws, paper, accent])
  useEffect(() => {
    if (!ws) return
    let done = false
    const settle = () => {
      if (done) return
      done = true
      setChecked(true)
    }
    const timer = window.setTimeout(settle, INSTANCE_WAIT)
    api
      .instance(ws)
      .then(({ stamp }) => {
        // an answer after the shell mounted still applies, and a page whose state it cleared loads again, since the
        // shell already read that state
        const cleared = syncInstance(ws, stamp)
        if (done && cleared) window.location.reload()
      })
      .catch(() => undefined)
      .finally(settle)
    return () => {
      done = true
      window.clearTimeout(timer)
    }
  }, [ws])
  useEffect(() => {
    if (!ws) return
    let alive = true
    api
      .corpora()
      .then((cs) => alive && setMissing(!cs.some((c) => c.name === ws)))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [ws])
  if (!ws) return <StartPage />
  if (missing) return <StartPage missing={ws} />
  if (!checked) return null
  return <Shell ws={ws} />
}

