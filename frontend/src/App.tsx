// The page shell for the workspace named in the URL. A URL that names no workspace, or one this server does not hold, is
// thimble's start page (shell/StartPage), which lists the server's workspaces. A URL naming a workspace renamed since
// (`thimble demo` renames a demo workspace demo-<dataset>: a row's `renamed_from`) goes to the new name, taking the
// workspace's browser storage with it. Before the shell mounts (it reads browser storage as it does), the workspace's
// instance is checked, so a workspace made again under an old name does not open on the old one's state
// (lib/workspace.ts syncInstance); a failure or a slow answer lets the shell mount with the state as it is.
import { useEffect, useState } from 'react'
import { api } from './lib/api'
import { useTheme } from './lib/theme'
import { moveWorkspaceStorage, renamedTo, syncInstance, withWorkspace, workspaceFromUrl } from './lib/workspace'
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
  // bumped when the URL goes to a renamed workspace's new name, so the page reads the URL again
  const [, setMoved] = useState(0)
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
      .then(async (cs) => {
        if (!alive) return
        if (cs.some((c) => c.name === ws)) return setMissing(false)
        const to = await api
          .workspaces()
          .then((rows) => renamedTo(rows, ws))
          .catch(() => null)
        if (!alive) return
        if (!to) return setMissing(true)
        moveWorkspaceStorage(ws, to)
        const { pathname, search, hash } = window.location
        window.history.replaceState(null, '', withWorkspace(to, pathname, search, hash))
        setMoved((n) => n + 1)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [ws])
  if (!ws) return <StartPage />
  if (missing) return <StartPage missing={ws} />
  if (!checked) return null
  return <Shell key={ws} ws={ws} />
}

