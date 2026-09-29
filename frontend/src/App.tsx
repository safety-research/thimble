// The page shell for the workspace named in the URL. A URL that names no workspace goes to the one the server holds
// (pickWorkspace). Before the shell mounts (it reads browser storage as it does), the workspace's instance is checked, so
// a workspace made again under an old name does not open on the old one's state (lib/workspace.ts syncInstance); a
// failure or a slow answer lets the shell mount with the state as it is.
import { useEffect, useState } from 'react'
import { api } from './lib/api'
import { useTheme } from './lib/theme'
import { lastWorkspace, pickWorkspace, rememberWorkspace, syncInstance, urlForWorkspace, workspaceFromUrl } from './lib/workspace'
import { Shell } from './shell/Shell'
import { UnknownWorkspace } from './shell/UnknownWorkspace'

/** How long the page waits on the instance check before it mounts the shell anyway (ms). */
const INSTANCE_WAIT = 1500

export default function App() {
  const ws = workspaceFromUrl()
  const [error, setError] = useState<string | null>(null)
  // a URL naming a workspace this server does not hold (a tab kept from another run or another server): the folders it
  // does hold, to offer instead
  const [held, setHeld] = useState<string[] | null>(null)
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
    if (ws) {
      let alive = true
      api
        .corpora()
        .then((cs) => {
          const names = cs.map((c) => c.name)
          if (!alive) return
          if (names.includes(ws)) rememberWorkspace(ws)
          else setHeld(names)
        })
        .catch(() => rememberWorkspace(ws))
      return () => {
        alive = false
      }
    }
    api
      .corpora()
      .then((cs) => {
        const name = pickWorkspace(
          cs.map((c) => c.name),
          lastWorkspace(),
        )
        // a navigation rather than a state change, so everything that reads the workspace from the URL at load sees it
        if (name) window.location.replace(urlForWorkspace(name))
        else setError('No folder is open. Run /thimble in a Claude Code session in the folder to open it.')
      })
      .catch((e) => setError(`Could not reach the thimble server: ${(e as Error).message}`))
  }, [ws])
  if (!ws) return error ? <p className="app-error">{error}</p> : null
  if (held) return <UnknownWorkspace ws={ws} held={held} />
  if (!checked) return null
  return <Shell ws={ws} />
}

