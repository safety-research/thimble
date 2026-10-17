// A line under the top bar while the workspace's stream is down for longer than a restart takes. It names the way
// back and goes when the stream reopens. Its × hides it until the stream reopens and drops again. And the stopped page
// (StoppedPage), which shell/SignIn shows in place of the app once the page stopped (lib/stale): the server stopped
// with the Claude Code session, the session ended, or the server could not be reached or prove itself; the page then
// sends nothing under its key. The line names the ways to start the page again (`thimble` in the folder, or the
// session continued with `claude -c` and `/thimble browser`: bug hunts G11, H6), and the page asks quietly, with no
// credentials, whether thimble's server answers again (lib/stale serverBack), then reloads, which is all it needs: the
// browser's sign-in outlives the server (bug hunt H6: the tab stayed stopped beside the new one). A demo page
// (lib/demo) has no session and no terminal of its own, so both lines name `thimble demo` there (bug hunt F7).
import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { Mark } from '../components/Marks'
import { bus } from '../lib/bus'
import { useDemo } from '../lib/demo'
import { serverBack } from '../lib/stale'

/** A restart (a source change, a dev apply) is back within a few seconds; only a longer outage is shown. */
export const DOWN_AFTER_MS = 6_000

/** What a stopped page says, whatever stopped it: the ways to start the page again, and that this tab comes back by
 * itself once it runs (a span in backticks is drawn as code). */
export const STOPPED_LINE =
  "thimble's page stopped with the Claude Code session. To start it again, run `thimble` in a terminal in the folder with your files, or continue the session there with `claude -c` and type `/thimble browser`. This tab reloads by itself once the page runs again."
/** What a demo page says once it stopped: a demo needs no session, and `thimble demo` opens it again. */
export const DEMO_STOPPED_LINE = "thimble's demo stopped. Run `thimble demo` in a terminal to open it again. This tab reloads by itself once the demo runs again."
/** What a stopped page says once thimble's server answers again, as it reloads: a reload is the fix. */
export const BACK_LINE = "thimble's page runs again, so this tab reloads. If it does not, reload it."
/** How long a stopped page waits before it first asks whether thimble's server answers again: a server stops a few
 * seconds after its session ended (backend session.STOP_AFTER_S), and a page brought back into it would stop again. */
export const BACK_FIRST_MS = 8_000
/** How often a stopped page asks after that. */
export const BACK_EVERY_MS = 4_000
/** What brings a stopped page back once the server answers (a test replaces it). */
export const comeBack = { reload: (): void => window.location.reload() }

/** A line with its backticked spans drawn as code. */
const withCode = (text: string) => text.split(/(`[^`]+`)/).map((part, i) => (part.length > 2 && part.startsWith('`') && part.endsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part))

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

/** The page in place of the app once it stopped (module note); `demo` when it was a demo page. It asks whether thimble's
 * server answers again after BACK_FIRST_MS, then every BACK_EVERY_MS, and reloads once it does. */
export function StoppedPage({ demo = false }: { demo?: boolean }) {
  const [back, setBack] = useState(false)
  useEffect(() => {
    let alive = true
    let timer = 0
    const ask = async () => {
      const answered = await serverBack()
      if (!alive) return
      if (!answered) {
        timer = window.setTimeout(() => void ask(), BACK_EVERY_MS)
        return
      }
      setBack(true)
      comeBack.reload()
    }
    timer = window.setTimeout(() => void ask(), BACK_FIRST_MS)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [])
  return (
    <p className="signin-line stopped-line" role="status">
      {withCode(back ? BACK_LINE : demo ? DEMO_STOPPED_LINE : STOPPED_LINE)}
    </p>
  )
}
