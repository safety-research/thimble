// A line under the top bar while the workspace's stream is down for longer than a restart takes. It names the way
// back and goes when the stream reopens. Its × hides it until the stream reopens and drops again. And the stopped page
// (StoppedPage), which shell/SignIn shows in place of the app once the page stopped (lib/stale): the server stopped
// with the Claude Code session, the session ended, or the server could not be reached or prove itself; the page then
// sends nothing more, and the line says how to open it again.
import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { Mark } from '../components/Marks'
import { bus } from '../lib/bus'

/** A restart (a source change, a dev apply) is back within a few seconds; only a longer outage is shown. */
export const DOWN_AFTER_MS = 6_000

/** What a stopped page says, whatever stopped it. */
export const STOPPED_LINE = "thimble's page stopped with the Claude Code session. Type /thimble open in the terminal to open it again."

export function ServerDown() {
  const [down, setDown] = useState(false)
  const [hidden, setHidden] = useState(false)
  useEffect(() => {
    let timer: number | null = null
    const off = bus.on('wsStream', (e) => {
      if (e.connected) {
        if (timer != null) window.clearTimeout(timer)
        timer = null
        setDown(false)
        setHidden(false)
      } else if (timer == null) {
        timer = window.setTimeout(() => setDown(true), DOWN_AFTER_MS)
      }
    })
    return () => {
      off()
      if (timer != null) window.clearTimeout(timer)
    }
  }, [])
  if (!down || hidden) return null
  return (
    <div className="shell-down" role="alert">
      <Mark kind="failed" label="error" />
      <span>
        thimble's server is not answering, so messages sent here do not arrive. Type <code>/thimble open</code> in the
        Claude Code session to start it again; your work is saved. If it does not come back, run <code>thimble doctor</code>{' '}
        in a terminal.
      </span>
      <Button variant="icon" size="sm" icon="x" title="Dismiss" aria-label="Dismiss" className="shell-down-x" onClick={() => setHidden(true)} />
    </div>
  )
}

/** The page in place of the app once it stopped (module note). */
export function StoppedPage() {
  return (
    <p className="signin-line stopped-line" role="status">
      {STOPPED_LINE.split(/(\/thimble open)/).map((part, i) => (part === '/thimble open' ? <code key={i}>{part}</code> : part))}
    </p>
  )
}
