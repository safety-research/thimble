// A line under the top bar while the workspace's stream is down for longer than a restart takes. It names the way
// back and goes when the stream reopens. Its × hides it until the stream reopens and drops again.
import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { Mark } from '../components/Marks'
import { bus } from '../lib/bus'

/** A restart (a source change, a dev apply) is back within a few seconds; only a longer outage is shown. */
export const DOWN_AFTER_MS = 6_000

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
        thimble's server is not answering, so messages sent here do not arrive. Say <code>/thimble</code> in the Claude Code
        session to start it again; your work is saved. If it does not come back, run <code>thimble doctor</code> in a
        terminal.
      </span>
      <Button variant="icon" size="sm" icon="x" title="Dismiss" aria-label="Dismiss" className="shell-down-x" onClick={() => setHidden(true)} />
    </div>
  )
}
