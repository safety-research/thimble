// A line under the top bar when the server serves a different build than this tab loaded (the stream's
// `server ui_updated`, or GET /api/health's `ui` after a restart). It offers Reload and never reloads on its own;
// lib/chunkRecovery reloads once when a lazy chunk is missing and no typed text would be lost.
import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { bus } from '../lib/bus'
import { isReplay } from '../lib/events'
import { servedBuild, thisBuild } from '../lib/chunkRecovery'

export { servedBuild }

/** Whether the server serves another build than the one this tab loaded; unknown on either side is no. */
export function isNewer(loaded: string | null, served: string | null): boolean {
  return loaded != null && served != null && loaded !== served
}

export function NewVersion() {
  const [why, setWhy] = useState<string | null>(null)
  useEffect(() => {
    let loaded: string | null = null
    let alive = true
    void thisBuild().then((b) => {
      loaded = b
    })
    const offEvent = bus.on('wsEvent', (ev) => {
      const e = ev as { type?: string; status?: string; title?: string }
      // an update recorded before this page loaded is already running here
      if (e.type === 'server' && e.status === 'ui_updated' && !isReplay()) setWhy(e.title ? `for “${e.title}”` : '')
    })
    const offStream = bus.on('wsStream', (e) => {
      if (!e.connected) return
      void servedBuild().then((b) => {
        if (alive && isNewer(loaded, b)) setWhy('')
      })
    })
    // a lazy chunk did not load because the build changed, and a reload would lose typed text or just happened
    const offStale = bus.on('uiStale', () => alive && setWhy(''))
    return () => {
      alive = false
      offStale()
      offEvent()
      offStream()
    }
  }, [])
  if (why == null) return null
  return (
    <div className="shell-down shell-newer" role="status">
      <span>thimble was updated{why ? ` ${why}` : ''} while this tab was open. Reload it to use the new version.</span>
      <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </div>
  )
}
