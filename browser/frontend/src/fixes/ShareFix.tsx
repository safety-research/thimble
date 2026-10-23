// ShareFix.tsx: Share on a fix, wherever the page shows one (its row in Your fixes, its notice). A click opens a new tab
// at once (so no pop-up blocker stops it), asks the server for the share page (share.ts), and shows the page in that
// tab. The line under the actions then says what the privacy check took out, with the share page and GitHub's
// new-issue page to open again. Nothing is sent from thimble.
//
//   useShare(id, ws)   { share, busy, line }: the click, whether it runs, and the line (null before a share), for a
//                      row of actions that places the button and the line itself
//   ShareFix           the Share button with its line under it
import { type ReactNode, useState } from 'react'
import { Button } from '../components/Button'
import { apiUrl } from '../lib/browserKey'
import { type Shared, shareFix, sharedLine } from './share'

const LINE = { margin: '6px 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' } as const

export function useShare(id: number, ws: string | null): { share: () => Promise<void>; busy: boolean; line: ReactNode } {
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ s: Shared; opened: boolean } | null>(null)
  const [error, setError] = useState('')
  const share = async () => {
    const tab = window.open('about:blank', '_blank')
    try {
      if (tab) {
        tab.document.title = `Share fix ${id} · thimble`
        tab.document.body.textContent = `Claude writes the text of fix ${id}…`
      }
    } catch {
      /* the tab shows the page when it comes */
    }
    setBusy(true)
    setError('')
    try {
      setDone({ s: await shareFix(id, ws, tab), opened: !!tab })
    } catch (err) {
      setDone(null)
      setError(String((err as Error)?.message || err))
    } finally {
      setBusy(false)
    }
  }
  const line = error ? (
    <p style={{ ...LINE, color: 'var(--status-negative)' }} role="alert">
      {error}
    </p>
  ) : done ? (
    <p style={LINE} data-testid="fix-share-line">
      {sharedLine(done.s, done.opened)}{' '}
      <a href={apiUrl(done.s.page)} target="_blank" rel="noopener">
        Share page
      </a>
      {' · '}
      <a href={done.s.url} target="_blank" rel="noopener noreferrer">
        Open a GitHub issue directly
      </a>
    </p>
  ) : null
  return { share, busy, line }
}

export function ShareFix({ id, ws }: { id: number; ws: string | null }) {
  const { share, busy, line } = useShare(id, ws)
  return (
    <div className="fix-share" data-section="fix-share">
      <Button variant="secondary" size="sm" busy={busy} disabled={busy} onClick={share} data-tel="fix-share">
        Share
      </Button>
      {line}
    </div>
  )
}
