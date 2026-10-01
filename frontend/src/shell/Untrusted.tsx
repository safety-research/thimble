// A warning line under the top bar, in the page's flow so it covers none of the panes, while Claude Code does not trust
// thimble's workspaces folder (the settings' `untrusted`), so the orientation, its critic, the writers and view builds
// cannot start. It names the command that trusts the folder, is read again when the window regains focus, and Hide
// dismisses it for this tab.
import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { Mark } from '../components/Marks'
import { loadSettings, onSettingsChange } from '../lib/models'
import type { Settings } from '../lib/types'

export function Untrusted({ ws }: { ws: string }) {
  const [untrusted, setUntrusted] = useState<Settings['untrusted']>(null)
  const [hidden, setHidden] = useState(false)
  useEffect(() => {
    let alive = true
    const read = (fresh = false) =>
      loadSettings(ws, fresh)
        .then((s) => alive && setUntrusted(s.untrusted ?? null))
        .catch(() => undefined)
    void read()
    const off = onSettingsChange((w) => w === ws && void read())
    const onFocus = () => void read(true)
    window.addEventListener('focus', onFocus)
    return () => {
      alive = false
      off()
      window.removeEventListener('focus', onFocus)
    }
  }, [ws])
  if (!untrusted || hidden) return null
  return (
    <div className="shell-untrusted" role="alert">
      <Mark kind="unchecked" label="warning" />
      <span>
        Claude Code does not trust thimble's workspaces folder, so the orientation, its critic, the writers and view
        builds can't start. To trust it, run this in a terminal: <code>{untrusted.command}</code>
      </span>
      <Button variant="secondary" size="sm" onClick={() => setHidden(true)}>
        Hide
      </Button>
    </div>
  )
}
