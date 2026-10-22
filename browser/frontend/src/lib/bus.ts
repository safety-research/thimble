// The page's typed event bus: the workspace stream fans out here, and the surfaces talk to each other through it.
import type { CardDrawing } from './api'
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
  /** a card ran, changed, was added, deleted or moved; `slug` is the name a citation may give it in place of its id */
  cell: { notebook: string; cell: string; kind: string; slug?: string }
  report: { slug: string; status: string; span?: string }
  /** `asked`: a view the analyst asked for is built (files/viewReady.ts); `version`: a new version of it passed its checks */
  /** `held`: the proposal of an orientation from before 0.8.0 before its view first passes, which only its chip follows */
  /** `accepted`: the first build of a view the analyst accepted from a view proposal (files/viewReady.ts) */
  view: { slug: string; status: string; path?: string; chat?: string; asked?: boolean; accepted?: boolean; version?: string; held?: boolean }
  features: Record<string, never>
  /** open the Labels sidebar, and with `id` that label's detail */
  openLens: { tab: 'labels'; id?: string | null }
  /** a card Claude drew is drawn anew after a key the message box gave it (cards/keys.ts) */
  cardDrawn: { id: string; drawing: CardDrawing }
  /** `rows` false: the label's rows stayed as they were (turned on or off, recoloured, a filter set) */
  concepts: { concept: string; what: string; rows?: boolean }
  filter: { scope: FilterScope; concept?: string; value?: string }
  /** the stream connected or dropped */
  wsStream: { connected: boolean }
  /** a lazy chunk did not load and the server serves another build: ask for a reload (lib/chunkRecovery) */
  uiStale: Record<string, never>
  /** show the surface that owns `ref` and bring the element into view; `browser` opens a file's ref in the File browser
   * at its place, the passage highlighted, rather than in a view that claims the file (an example card's address);
   * `still` opens a canvas card neither selected nor flashed (a `?ref=` in the page's URL, lib/teleport refFromUrl) */
  openRef: { ref: string; browser?: boolean; focus?: boolean; still?: boolean }
  /** show a surface (shell/panes.ts show): `tab` is Files, Canvas, Report, or a view as `view:<slug>`; `from` is the
     * pane the request came from (lib/surfaces pressedPane), else the pane pressed last */
  showTab: { tab: Tab | `view:${string}`; from?: string | null }
  /** a ref Files places in a view, opened in the pane that shows that view on its own (files/ViewSurface) */
  openInView: { slug: string; path: string; ref?: string; quote?: { record: string; text: string; span: string }; query?: ViewQuery; picked?: boolean }
  /** open a view with a card's arguments (a card type's Open as view, canvas/TypeCard), or with none (null), in Files
   * or in its own pane */
  openView: { slug: string; query: ViewQuery | null }
  /** show the file at `path` in the File browser's mode `mode` (files/Reader pickKey), such as a file viewer's */
  fileMode: { path: string; mode: string }
  /** Open in on a file's panel: the file in the view `slug`, or in the File browser for null, kept as the view the
   * analyst last used for it */
  openIn: { path: string; ref?: string; slug: string | null }
  /** open a label's edit card in Files, with the Labels pane open in the sidebar that holds it (Open in Files in a
   * label's popover on a card, files/LabelCard LabelSheet) */
  editLabel: { id: string }
  /** show a chat in the panel; `send` is a first message to post once it is shown */
  openChat: { chatId: string; send?: string }
  /** A toast (shell/Toasts) only confirms or fails the analyst's own click, or reports news with a link to it: `ref`
   * puts a chip of what it names on it, `thread` the chip of a thread (chat/Notes ThreadChip). A state that lasts, such
   * as a refused start or a write that failed, shows once next to what it concerns and is never also a toast. */
  toast: { text: string; kind?: 'info' | 'error'; ref?: string; thread?: { id: string; label: string }; action?: ToastAction }
  /** open Report a problem under the top bar's bug, with what failed written in and the chats it concerns */
  reportProblem: ProblemPrefill
  /** Fix this or Report this on a failure (shell/ShareReport ReportThis), or Report a problem… in the settings menu
   * with no text: main drafts a report of it */
  reportThis: { mode: 'fix' | 'report'; text: string }
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
  /** open Settings under the top bar's gear (a notice's Open Settings) */
  openSettings: Record<string, never>
  /** the server refused a read because this browser is not signed in (401 with `signin: true`, lib/api signInNeeded):
   * `thimble unpair`, or a sign-in notice's Sign it out; shell/SignIn shows its line in place of the app */
  signedOut: Record<string, never>
  /** a link with a sign-in code was opened in this tab, which changed only the address's hash (lib/api
   * claimOnHashChange): shell/SignIn checks again whether this browser is signed in */
  newLink: Record<string, never>
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

/** A toast's one button, such as Reopen after a comment is resolved: its words and what it does. */
export interface ToastAction {
  label: string
  run: () => void
}
