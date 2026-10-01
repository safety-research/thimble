// A view on its own in a pane (shell/PaneArea), on the file a ref named or the first file the view claims, with the
// Labels sidebar Files shows beside a view (ViewSide). While a pane shows it, refs Files would open in this view open
// here instead (bus `openInView`).
import { useCallback, useEffect, useState } from 'react'
import { bus, type Events } from '../lib/bus'
import { inferKind } from './params'
import { kindIn, parentOf, useFolderStore } from './Tree'
import { useFilesLabels } from './useLabels'
import { ViewPane } from './ViewPane'
import { useViewSide } from './ViewSide'
import type { BuiltView } from './ViewsBar'

type Place = Omit<Events['openInView'], 'slug'>
/** Each view's place, by workspace and slug. */
const places = new Map<string, Place>()

export function ViewSurface({ ws, view, active }: { ws: string; view: BuiltView; active: boolean }) {
  const labels = useFilesLabels(ws)
  const folders = useFolderStore(ws)
  const key = `${ws}\n${view.slug}`
  const [at, setAt] = useState<Place | null>(() => places.get(key) ?? null)
  useEffect(
    () =>
      bus.on('openInView', ({ slug, ...place }) => {
        if (slug !== view.slug) return
        places.set(key, place)
        setAt(place)
      }),
    [view.slug, key],
  )
  // a quoted span the page did not show opens in the File browser, which highlights it
  const quoteMissing = useCallback(() => {
    if (at?.quote) bus.emit('openRef', { ref: at.quote.span, browser: true })
  }, [at])
  // the view dropped the arguments of the card it was opened from
  const clearQuery = useCallback(() => {
    if (!at?.query) return
    const next = { ...at, query: undefined }
    places.set(key, next)
    setAt(next)
  }, [at, key])
  const path = at?.path ?? view.first_file ?? null
  const { ensure } = folders
  useEffect(() => {
    if (path && active) ensure(parentOf(path))
  }, [path, active, ensure])
  const kind = path ? kindIn(folders.store, path) ?? inferKind(path) : 'text'
  const side = useViewSide(ws, view, labels)
  return (
    <div className="view-surface files-body is-view">
      {side.side}
      <ViewPane ws={ws} view={view} path={path} picked={!!at?.path} kind={kind} targetRef={at?.ref} quote={at?.quote} query={at?.query} onClearQuery={clearQuery} onQuoteMissing={quoteMissing} labels={labels} first={side.first} onEditLabel={side.editLabel} />
      {side.card}
    </div>
  )
}
