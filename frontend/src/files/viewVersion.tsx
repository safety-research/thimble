// The version of a view a pane shows (backend views.VERSIONS_SUBDIR): the one it opened with, until the analyst reloads,
// so a newer one, from a change, the review or the orientation, never reloads under them. ViewUpdated is the quiet
// notice, in the design system's style, that a newer one is there.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../components/Button'
import type { ViewerFrameHandle, ViewState } from './ViewerFrame'
import { holdShown, markOpened } from './viewReady'

/** The version of a view a pane shows: the one it opened with, until the analyst reloads. `stale` when a newer one has
 * passed its checks; `reload` asks the page what the analyst is looking at and loads the newer version with it; after
 * `follow`, the next newer version loads at once (the analyst's own Undo). The pane holds the view as shown meanwhile. */
export function usePinnedView(ws: string, slug: string, version: string | undefined) {
  const [pinned, setPinned] = useState(version)
  const [restore, setRestore] = useState<ViewState | null>(null)
  const frame = useRef<ViewerFrameHandle | null>(null)
  const following = useRef(false)
  useEffect(() => {
    setPinned(version)
    setRestore(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, slug])
  // a version the views list had not read yet when the pane opened
  useEffect(() => {
    if (!pinned && version) setPinned(version)
  }, [pinned, version])
  useEffect(() => {
    markOpened(ws, slug)
    return holdShown(ws, slug)
  }, [ws, slug])
  const reload = useCallback(async () => {
    const st = (await frame.current?.state()) ?? null
    setRestore(st)
    setPinned(version)
  }, [version])
  useEffect(() => {
    if (following.current && version && version !== pinned) {
      following.current = false
      void reload()
    }
  }, [version, pinned, reload])
  const follow = useCallback(() => {
    following.current = true
  }, [])
  return { pinned, stale: !!version && !!pinned && version !== pinned, restore, frame, reload, follow }
}

/** The quiet notice that a newer version of the view is there, with Reload. */
export function ViewUpdated({ onReload, className }: { onReload: () => void; className?: string }) {
  return (
    <span className={'view-updated' + (className ? ` ${className}` : '')} role="status">
      <span className="dot view-updated-dot" aria-hidden="true" />
      <span className="view-updated-text">Updated</span>
      <Button variant="ghost" size="sm" icon="refresh" className="view-updated-reload" onClick={onReload}>
        Reload
      </Button>
    </span>
  )
}
