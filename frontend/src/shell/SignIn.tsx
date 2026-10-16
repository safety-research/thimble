// The page before the app. It signs this browser in with the link's code (lib/api claimKey), asks the server whether
// the browser is signed in (GET /ui/paired, which answers anyone), and shows the app only when it is, or when the
// server answers its reads all the same (lib/api signedIn: a page thimble's screenshot tool loads with a read
// credential of its own). Every read of the server's data needs one of them (backend hook_auth), so a browser that is
// not signed in sees one line that says so and names the way in, and neither the start page nor the shell mounts, so nothing polls. A read refused later for want of sign-in
// (`thimble unpair`, a sign-in notice's Sign it out: bus `signedOut`) brings the line back. A link opened in this tab
// (bus `newLink`), or the tab shown again while it shows the line, checks once more. Nothing shows while the first check
// is under way; when the server does not answer it, the app mounts and says so itself. Once the page stopped (lib/stale:
// the server stopped for good, the session ended, or the server could not be reached or prove itself), the stopped page
// (shell/ServerDown StoppedPage) takes the app's place for good, so nothing polls and nothing is sent.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { claimRefused, signedIn } from '../lib/api'
import { bus } from '../lib/bus'
import { pageStopped } from '../lib/stale'
import { StoppedPage } from './ServerDown'

/** The way in, which ends the line; a span in backticks is drawn as code. */
export const WAY_IN = "Type `/thimble open` in your Claude Code terminal, or press o in thimble's panel."
/** The line a browser that is not signed in sees. */
export const SIGN_IN_LINE = `This browser isn't signed in. ${WAY_IN}`
/** The line when the server refused the link's code with 410 (used, replaced by a newer one, or expired). */
export const CODE_GONE_LINE = `This link was used or has expired, so this browser isn't signed in. ${WAY_IN}`

type State = 'wait' | 'in' | 'out' | 'stopped'

export function SignInGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(pageStopped() ? 'stopped' : 'wait')
  const [gone, setGone] = useState(false)
  const shown = useRef<State>('wait')
  shown.current = state
  useEffect(() => {
    let alive = true
    let asked = 0
    const check = async (again = false) => {
      const mine = ++asked
      const paired = await signedIn(again)
      if (!alive || mine !== asked || shown.current === 'stopped') return
      if (paired === null) {
        // no answer: the app mounts and shows the server's failure itself; a line or an app already shown stays
        if (shown.current === 'wait') setState('in')
        return
      }
      setGone(!paired && claimRefused())
      setState(paired ? 'in' : 'out')
    }
    void check()
    const visible = () => {
      if (document.visibilityState === 'visible' && shown.current === 'out') void check(true)
    }
    const offOut = bus.on('signedOut', () => {
      if (shown.current === 'stopped') return
      setGone(false)
      setState('out')
    })
    const offStopped = bus.on('pageStopped', () => setState('stopped'))
    const offLink = bus.on('newLink', () => void check())
    document.addEventListener('visibilitychange', visible)
    return () => {
      alive = false
      offOut()
      offStopped()
      offLink()
      document.removeEventListener('visibilitychange', visible)
    }
  }, [])
  if (state === 'wait') return null
  if (state === 'stopped') return <StoppedPage />
  if (state === 'in') return <>{children}</>
  const text = gone ? CODE_GONE_LINE : SIGN_IN_LINE
  return (
    <p className="signin-line">
      {text.split(/(`[^`]+`)/).map((part, i) => (part.length > 2 && part.startsWith('`') && part.endsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part))}
    </p>
  )
}
