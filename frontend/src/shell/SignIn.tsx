// The page before the app. It signs this browser in with the link's code (lib/api claimKey), asks the server whether
// the browser is signed in (GET /ui/paired, which answers anyone), and shows the app only when it is: every read of the
// server's data needs the sign-in (backend hook_auth), so a browser that is not signed in sees one line naming the way
// in, and neither the start page nor the shell mounts, so nothing polls. A read refused later for want of sign-in
// (`thimble unpair`, a sign-in notice's Sign it out: bus `signedOut`) brings the line back. A link opened in this tab
// (bus `newLink`), or the tab shown again while it shows the line, checks once more. Nothing shows while the first check
// is under way; when the server does not answer it, the app mounts and says so itself.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { claimRefused, signedIn } from '../lib/api'
import { bus } from '../lib/bus'

/** The line a browser that is not signed in sees; a span in backticks is drawn as code. */
export const SIGN_IN_LINE = 'Open the link /thimble shows in your terminal, or run `thimble up` in a shell.'
/** Its start when the server refused the link's code with 410 (used, replaced by a newer one, or expired). */
export const CODE_GONE_START = 'This link was used or has expired: '

type State = 'wait' | 'in' | 'out'

export function SignInGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>('wait')
  const [gone, setGone] = useState(false)
  const shown = useRef<State>('wait')
  shown.current = state
  useEffect(() => {
    let alive = true
    let asked = 0
    const check = async (again = false) => {
      const mine = ++asked
      const paired = await signedIn(again)
      if (!alive || mine !== asked) return
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
      setGone(false)
      setState('out')
    })
    const offLink = bus.on('newLink', () => void check())
    document.addEventListener('visibilitychange', visible)
    return () => {
      alive = false
      offOut()
      offLink()
      document.removeEventListener('visibilitychange', visible)
    }
  }, [])
  if (state === 'wait') return null
  if (state === 'in') return <>{children}</>
  const text = (gone ? CODE_GONE_START : '') + SIGN_IN_LINE
  return (
    <p className="signin-line">
      {text.split(/(`[^`]+`)/).map((part, i) => (part.length > 2 && part.startsWith('`') && part.endsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part))}
    </p>
  )
}
