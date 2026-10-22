// A line under the top bar when the server serves a different build than this tab loaded (the stream's
// `server ui_updated`, or GET /api/health's `ui` after a restart). It offers Reload and never reloads on its own;
// lib/chunkRecovery reloads once when a lazy chunk is missing and no typed text would be lost. Its × hides it until the
// server serves a build other than the one it was dismissed for.
import { useEffect, useRef, useState } from 'react'
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
  // the build the line was dismissed for (×), undefined while it was not: it shows again only for another build
  const dismissed = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    let loaded: string | null = null
    let alive = true
    void thisBuild().then((b) => {
      loaded = b
    })
    // show the line, unless it was dismissed and the server still serves the build it was dismissed for
    const show = (words: string, served?: string | null) => {
      if (dismissed.current === undefined) return setWhy(words)
      void (served !== undefined ? Promise.resolve(served) : servedBuild()).then((b) => {
        if (alive && isNewer(dismissed.current ?? null, b)) {
          dismissed.current = undefined
          setWhy(words)
        }
      })
    }
    const offEvent = bus.on('wsEvent', (ev) => {
      const e = ev as { type?: string; status?: string; title?: string }
      // an update recorded before this page loaded is already running here
      if (e.type === 'server' && e.status === 'ui_updated' && !isReplay()) show(e.title ? `for “${e.title}”` : '')
    })
    const offStream = bus.on('wsStream', (e) => {
      if (!e.connected) return
      void servedBuild().then((b) => {
        if (alive && isNewer(loaded, b)) show('', b)
      })
    })
    // a lazy chunk did not load because the build changed, and a reload would lose typed text or just happened
    const offStale = bus.on('uiStale', () => alive && show(''))
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
      <Button
        variant="icon"
        size="sm"
        icon="x"
        title="Dismiss"
        aria-label="Dismiss"
        className="shell-down-x"
        onClick={() => {
          setWhy(null)
          dismissed.current = null
          void servedBuild().then((b) => {
            if (dismissed.current === null) dismissed.current = b
          })
        }}
      />
    </div>
  )
}
