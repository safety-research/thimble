// The page shell for the workspace named in the URL. A URL that names no workspace goes to the one the server holds
// (pickWorkspace).
import { useEffect, useState } from 'react'
import { api } from './lib/api'
import { useTheme } from './lib/theme'
import { lastWorkspace, pickWorkspace, rememberWorkspace, urlForWorkspace, workspaceFromUrl } from './lib/workspace'
import { Shell } from './shell/Shell'
import { UnknownWorkspace } from './shell/UnknownWorkspace'

export default function App() {
  const ws = workspaceFromUrl()
  const [error, setError] = useState<string | null>(null)
  // a URL naming a workspace this server does not hold (a tab kept from another run or another server): the folders it
  // does hold, to offer instead
  const [held, setHeld] = useState<string[] | null>(null)
  const { paper, accent } = useTheme()
  // the card harness draws a card offscreen in the theme this browser last showed (backend/app/render.py)
  useEffect(() => {
    if (ws) api.reportTheme(ws, paper, accent).catch(() => undefined)
  }, [ws, paper, accent])
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
  return <Shell ws={ws} />
}

