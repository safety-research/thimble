// The page's typed event bus: the workspace stream fans out here, and the surfaces talk to each other through it.
import type { FilterScope, ViewQuery, WsEvent } from './types'

export type Tab = 'files' | 'canvas' | 'report'

/** What a failure offers Report a problem: its description, and the chats the bundle should take first. */
export interface ProblemPrefill {
  description: string
  focus?: string[]
}

export type Events = {
  /** every record of the workspace stream */
  wsEvent: WsEvent
  chat: { chat: string; deleted?: boolean }
  cell: { notebook: string; cell: string; kind: string }
  orient: { status: string; [k: string]: unknown }
  report: { slug: string; status: string; span?: string }
  /** `asked`: a view the analyst asked for is built (files/viewReady.ts); `version`: a new version of it passed its checks */
  /** `held`: one of the orientation's proposals before its view first passes, which only its chip follows */
  view: { slug: string; status: string; path?: string; chat?: string; asked?: boolean; version?: string; held?: boolean }
  ticket: { id: string; n: number; status: string }
  /** `rows` false: the label's rows stayed as they were (turned on or off, recoloured, a filter set) */
  concepts: { concept: string; what: string; rows?: boolean }
  filter: { scope: FilterScope; concept?: string; value?: string }
  /** the card main made for a card asked of it from the report (the stream's `card-request` record) */
  cardRequest: { request: string; card: string }
  /** a report check's run on a document started or ended (the stream's `check` record) */
  check: { id: string; doc: string; status: string; run?: string; chat?: string }
  /** the comments on the cards changed (the stream's `canvas-comments` record) */
  canvasComments: { card?: string }
  /** the stream connected or dropped */
  wsStream: { connected: boolean }
  /** a lazy chunk did not load and the server serves another build: ask for a reload (lib/chunkRecovery) */
  uiStale: Record<string, never>
  /** the workspace's log was replaced (`/thimble fresh` or `resume`): what the page shows is from the log that is gone */
  wsReset: { workspace: string }
  /** show the surface that owns `ref` and bring the element into view; `browser` opens a file's ref in the File browser
   * at its place, the passage highlighted, rather than in a view that claims the file (an example card's address) */
  openRef: { ref: string; browser?: boolean; focus?: boolean }
  /** show a surface (shell/panes.ts show): `tab` is Files, Canvas, Report, or a view as `view:<slug>`; `from` is the
     * pane the request came from (lib/surfaces pressedPane), else the pane pressed last */
  showTab: { tab: Tab | `view:${string}`; from?: string | null }
  /** a ref Files places in a view, opened in the pane that shows that view on its own (files/ViewSurface) */
  openInView: { slug: string; path: string; ref?: string; quote?: { record: string; text: string; span: string }; query?: ViewQuery; picked?: boolean }
  /** open a view with a card's arguments (a card type's Open as view, canvas/TypeCard, or main's open_view), or with
   * none (null), in Files or in its own pane */
  openView: { slug: string; query: ViewQuery | null }
  /** show the file at `path` in the File browser's mode `mode` (files/Reader pickKey), such as a file viewer's */
  fileMode: { path: string; mode: string }
  /** Open in on a file's panel: the file in the view `slug`, or in the File browser for null, kept as the view the
   * analyst last used for it */
  openIn: { path: string; ref?: string; slug: string | null }
  /** a layout main asked for with set_layout (the stream's `layout` record): a preset, and the surfaces its panes show
   * in reading order */
  layout: { layout: 'one' | 'columns' | 'rows' | 'three' | 'quadrants'; surfaces: string[] }
  /** open a label's edit card in Files, with the Labels pane open in the sidebar that holds it (Open in Files in a
   * label's popover on a card, files/LabelCard LabelSheet) */
  editLabel: { id: string }
  /** show a chat in the panel; `send` is a first message to post once it is shown */
  openChat: { chatId: string; send?: string }
  /** A toast (shell/Toasts) only confirms or fails the analyst's own click, or reports news with a link to it: `ref`
   * puts a chip of what it names on it, `thread` the chip of a thread (chat/Notes ThreadChip). A state that lasts, such
   * as a refused start or a write that failed, shows once next to what it concerns and is never also a toast. */
  toast: { text: string; kind?: 'info' | 'error'; ref?: string; thread?: { id: string; label: string } }
  /** open Report a problem under the top bar's bug, with what failed written in and the chats it concerns */
  reportProblem: ProblemPrefill
  /** a ⌘-click inside a view's frame (files/ViewerFrame): the pointer's box opens on that element, at `rect`; `view`
   * is the view's slug, which the thread names so its fork knows which view the element is in */
  pointAt: { anchor: string; text: string; element: string; rect: DOMRect; frame: HTMLIFrameElement; view?: string }
  /** open the ⌘ pointer's box on an anchored element, as a ⌘-click on it does (a card's Ask about this) */
  askAbout: { el: HTMLElement }
  /** the anchorable element under the pointer inside a view's frame while ⌘ is held; null when it left */
  pointHover: { rect: DOMRect | null }
  /** a box of a frame's page to bring into view (a frame's `reveal`): the canvas pans to it when the frame is on it */
  revealBox: { rect: DOMRect; frame: HTMLIFrameElement }
  /** a citation in a card's text is hovered (`ref`) or left (null), so a card that draws records can show the one it
   * names */
  citeHover: { card: string; ref: string | null }
  /** ⌘ went down or up: a view's frame shows the ⌘ arrow (`cursor`, a CSS cursor value) while it is held */
  cmdHeld: { on: boolean; cursor: string }
  /** run the product tour again (Settings' Take the tour) */
  tour: Record<string, never>
}

type Handler<T> = (payload: T) => void
const handlers = new Map<keyof Events, Set<Handler<any>>>()

export const bus = {
  on<K extends keyof Events>(event: K, fn: Handler<Events[K]>): () => void {
    let set = handlers.get(event)
    if (!set) {
      set = new Set()
      handlers.set(event, set)
    }
    set.add(fn)
    return () => {
      set!.delete(fn)
    }
  },
  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = handlers.get(event)
    if (!set) return
    for (const fn of Array.from(set)) {
      try {
        fn(payload)
      } catch (err) {
        console.error(`bus: a '${event}' handler threw`, err)
      }
    }
  },
}
