// A line under the top bar while the workspace's stream is down for longer than a restart takes. It names the way
// back and goes when the stream reopens. Its × hides it until the stream reopens and drops again. And the stopped page
// (StoppedPage), which shell/SignIn shows in place of the app once the page stopped (lib/stale): the server stopped
// with the Claude Code session, the session ended, or the server could not be reached or prove itself; the page then
// sends nothing more, and the line says how to start it again: `thimble` in the folder, since the session that could
// take `/thimble browser` is gone (bug hunt G11). A demo page (lib/demo) has no session and no terminal of its own, so
// both lines name `thimble demo` there (bug hunt F7).
import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { Mark } from '../components/Marks'
import { bus } from '../lib/bus'
import { useDemo } from '../lib/demo'

/** A restart (a source change, a dev apply) is back within a few seconds; only a longer outage is shown. */
export const DOWN_AFTER_MS = 6_000

/** What a stopped page says, whatever stopped it: `thimble`, run in the folder, starts a session and its page again,
 * since after `/exit` there is no session to type `/thimble browser` in (bug hunt G11). */
export const STOPPED_LINE = "thimble's page stopped with the Claude Code session. To start again, run thimble in a terminal, in the folder with your files."
/** What a demo page says once it stopped: a demo needs no session, and `thimble demo` opens it again. */
export const DEMO_STOPPED_LINE = "thimble's demo stopped. Run thimble demo in a terminal to open it again."

export function ServerDown() {
  const demo = useDemo()
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
      {demo ? (
        <span>
          thimble's server is not answering. Run <code>thimble demo</code> in a terminal to start it again. If it does not
          come back, run <code>thimble doctor</code> there.
        </span>
      ) : (
        <span>
          thimble's server is not answering, so messages sent here do not arrive. Type <code>/thimble browser</code> in the
          Claude Code session to start it again; your work is saved. If it does not come back, run <code>thimble doctor</code>{' '}
          in a terminal.
        </span>
      )}
      <Button variant="icon" size="sm" icon="x" title="Dismiss" aria-label="Dismiss" className="shell-down-x" onClick={() => setHidden(true)} />
    </div>
  )
}

/** The page in place of the app once it stopped (module note); `demo` when it was a demo page. */
export function StoppedPage({ demo = false }: { demo?: boolean }) {
  return (
    <p className="signin-line stopped-line" role="status">
      {(demo ? DEMO_STOPPED_LINE : STOPPED_LINE).split(/(?<=[Rr]un )(thimble demo|thimble)(?= in a terminal)/).map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part))}
    </p>
  )
}
