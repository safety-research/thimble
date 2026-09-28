// The document views behind one lazy import, so BlockNote loads the first time the tab is shown and switching documents
// is a prop change. One view per renderer: the report as a page with its sidebar and margin, slides as a deck, the story
// in its editor (StoryEditor.tsx), a page in its frame, a video in its player (Video.tsx). Each has the sidebar with the Checks pane (Checks.tsx); slides
// and story also list cards to drag in. Written documents take comments: a selection offers Comment (SelectComment.tsx)
// and a click on a tinted sentence holds its evidence card.
import { useMemo, useRef, useState, type MouseEvent } from 'react'
import { bus } from '../lib/bus'
import { track } from '../lib/telemetry'
import type { AnyDoc, DeckDoc, PageDoc, StoryDoc, VideoDoc, Writeup, WriteupComment } from '../lib/types'
import { ReadProbe } from '../shell/dock'
import { ChecksSidebar, SidebarShow, useChecks, useSidebar } from './Checks'
import { commentsApi } from './commentsApi'
import { DeckSidebar, DeckView, type DeckHandle } from './Deck'
import type { DocFilter } from './Editor'
import { docComments, EvidenceActions, type EvidenceActionsValue } from './Evidence'
import { PageView } from './Page'
import { ReportPage } from './ReportPage'
import { SelectComment } from './SelectComment'
import { StoryEditor, StorySidebar, type StoryEditorHandle } from './StoryEditor'
import { VideoView } from './Video'

export interface DocumentViewProps {
  ws: string
  slug: string
  renderer: string
  /** null for a page nobody has made yet */
  doc: AnyDoc | null
  filter: DocFilter | null
  /** the tab's token on the editor's saves */
  client: string
  /** the page's code drawer is open */
  drawer: boolean
  onSaved: (doc: AnyDoc) => void
}

export function DocumentView(props: DocumentViewProps) {
  const { ws, slug, renderer, doc, filter, client, onSaved } = props
  const key = `${ws}:${slug}`
  if (renderer === 'story' || renderer === 'slides' || renderer === 'custom' || renderer === 'video') return <Arranged key={key} {...props} />
  return doc ? <ReportPage key={key} ws={ws} slug={slug} doc={doc as Writeup} filter={filter} client={client} onSaved={onSaved} /> : null
}

/** A frame, the shape a slides or story type has before a write (GET …/frame), rather than its written document. */
const isFrame = (doc: AnyDoc | null): doc is Writeup => !!doc && (doc as Writeup).frame === true

/** The slides, the story, a page or a video beside the sidebar's Checks pane. */
function Arranged({ ws, slug, renderer, doc, filter, client, drawer, onSaved }: DocumentViewProps) {
  const side = useSidebar(ws)
  const checks = useChecks(ws)
  const [pickedId, setPickedId] = useState<string | null>(null)
  const comments = useMemo(() => (doc ? docComments(doc) : []), [doc])
  // the comment a click picked, while the document still has it open
  const picked = useMemo(() => comments.find((c) => c.id === pickedId) ?? null, [comments, pickedId])
  const viewRef = useRef<HTMLDivElement | null>(null)
  // a click on a tinted sentence picks its comment, the next one of the sentence's on each click; a click elsewhere in
  // the view lets it go, and a click in the evidence card or the selection's comment keeps it
  const onViewClick = (e: MouseEvent<HTMLDivElement>) => {
    const t = e.target as Element
    if (t.closest('.wu-evpop, .wu-selbar, .wu-selcard')) return
    const cids = t.closest('[data-cids]')?.getAttribute('data-cids')?.split(' ').filter(Boolean) ?? []
    if (!cids.length) {
      if (pickedId) setPickedId(null)
      return
    }
    const at = pickedId ? cids.indexOf(pickedId) : -1
    setPickedId(cids[(at + 1) % cids.length])
  }
  const written = !!doc && !isFrame(doc)
  const added = (cm: WriteupComment) => {
    if (!doc) return
    onSaved({ ...doc, comments: [...((doc as Writeup).comments ?? []), cm] } as AnyDoc)
    setPickedId(cm.id)
  }
  const actions = useMemo<EvidenceActionsValue>(
    () => ({
      onResolve: (cm) => {
        commentsApi
          .resolve(ws, slug, cm.id)
          .then((saved) => {
            track('ui-click', { target: `report:${slug}#${cm.sid}`, detail: { action: 'comment-resolve', check: cm.check } })
            onSaved(saved)
          })
          .catch((e) => bus.emit('toast', { text: `Could not resolve the comment. ${(e as Error).message}`, kind: 'error' }))
      },
    }),
    [ws, slug, onSaved],
  )
  const shared = { comments, on: checks.on, look: checks.look, picked }
  const deck = useRef<DeckHandle | null>(null)
  const story = useRef<StoryEditorHandle | null>(null)
  let view = null
  if (renderer === 'slides') {
    if (doc) view = <DeckView ref={deck} ws={ws} slug={slug} doc={doc as DeckDoc} client={client} onSaved={onSaved} filter={filter} {...shared} />
  } else if (renderer === 'story') {
    if (doc) view = <StoryEditor ref={story} ws={ws} slug={slug} doc={doc as StoryDoc} client={client} onSaved={onSaved} filter={filter} {...shared} />
  } else if (renderer === 'video') {
    if (doc) view = <VideoView ws={ws} slug={slug} doc={doc as VideoDoc} {...shared} />
  } else {
    view = <PageView ws={ws} slug={slug} doc={(doc as PageDoc | null) ?? null} drawer={drawer} onSaved={onSaved} {...shared} />
  }
  return (
    <div className={`wu-report wu-arranged${side.shown && !side.over ? '' : ' wu-side-hidden'}`} ref={side.row}>
      <ReadProbe probe={side.probe} />
      {side.shown && renderer === 'slides' ? (
        <DeckSidebar ws={ws} doc={doc as DeckDoc | null} onInsert={(id) => deck.current?.insertCard(id)} onHide={side.hide} over={side.over} slug={slug} checks={checks} comments={comments} />
      ) : side.shown && renderer === 'story' ? (
        <StorySidebar ws={ws} doc={doc as StoryDoc | null} onInsert={(id) => story.current?.insertCard(id)} onHide={side.hide} over={side.over} slug={slug} checks={checks} comments={comments} />
      ) : side.shown ? (
        <ChecksSidebar ws={ws} doc={slug} checks={checks} comments={comments} onHide={side.hide} over={side.over} />
      ) : (
        <SidebarShow onShow={side.show} />
      )}
      <div className="wu-arranged-view" ref={viewRef} onClick={onViewClick}>
        <EvidenceActions.Provider value={actions}>{view}</EvidenceActions.Provider>
        {written && <SelectComment ws={ws} slug={slug} root={viewRef} onAdded={added} />}
      </div>
    </div>
  )
}
