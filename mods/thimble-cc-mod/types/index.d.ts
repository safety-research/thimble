// thimble-cc-mod's state contract: every value the hooks module keeps in $.state.

/** One line of the place a citation names, as helper/resolve.py read it; `hit` on the cited lines, `spans` where the
 *  shown value stands in them. */
export type ChatLine = { n: number; text: string; hit: boolean; spans?: number[][] }

/** A citation as checked: ok (resolves, and its shown value is there or it shows none), differs (resolves, the value
 *  is not there), missing (does not resolve), unchecked (a whole file), pending (not checked yet). */
export type ChatVerdict = {
  id: string
  raw: string
  ref: string
  display: string | null
  status: string
  why: string
  kind: string
  file?: string
  start?: number
  end?: number
  window: ChatLine[]
  value?: string
  column?: string
  row?: string
  card?: string
  question?: string
  command?: string
  call?: string
}

/** A verification script for one citation: written by a forked subagent, then run by the mod. */
export type ChatVerify = {
  id: string
  state: string
  script: string
  expected: string | null
  source?: string
  stdout?: string
  stderr?: string
  exitCode?: number
  result?: string | null
  ranAt?: number
  /** the citation's place, which a result is compared with when its words show no value */
  ref?: string
  /** 'support' for a citation without a value, which a subagent judged by reading its place (a report's "verify
   *  section"): `why` says what it found */
  kind?: string
  why?: string
}

/** The citations of main's last reply, for the band, by the key of each claim (cite.ts claimKey). */
export type ChatTurn = { id: string; ids: string[] }

/** A card's script run by the mod (a param picked, or "rerun"): `rev` counts finished runs, so drawings reread it.
 *  `written`: while a picked choice shows, the param values the replies were written for (JSON), else absent. */
export type ChatRun = { rev: number; busy?: string; error?: string; stdout?: string; stderr?: string; exitCode?: number; at?: number; written?: string }

/** One question of a side thread and its answer, while running its tool calls and latest text. */
export type ChatThreadTurn = { q: string; a: string; state: string; tools: number; partial: string }

/** A side thread: what it is about, the subagent answering it, its exchange, and the file it is saved to; `parent` the
 *  thread it was asked from ('' or absent: main), `at` when it last changed (epoch ms). */
export type ChatThread = { id: string; label: string; ref: string; context: string; agentId: string; engine: string; turns: ChatThreadTurn[]; file: string; parent?: string; at?: number }

/** A side thread's turn that ended while the panel did not show the thread: one row in main's chat under the row it
 *  stands under (hooks/signal.ts), by its thread and its turn (from 1). */
export type ChatSignal = { thread: string; turn: number }

/** The threads holding answers the analyst has not read: how many, and the one when there is only one. */
export type ChatNews = { n: number; one: string }

/** A citation (by its claim's key) or a card (`card-<id>`) a fix round works on: `fixing` while its subagent runs, then `fixed`
 *  or `failed` with why. */
export type ChatFix = { state: string; why?: string }

/** One passage a fix round asks to correct: the reply's text as it stands (a sentence, or a card's embed line), what
 *  is wrong in it, the citations whose chips follow it, and the keys of their claims. */
export type ChatFixItem = { old: string; problems: { raw: string; why: string }[]; cites: string[]; keys?: string[]; card?: string }

/** A text row of main's reply, by its uuid (the `requestId` its drawing gets), as the model wrote it. */
export type ChatRow = { id: string; text: string }

/** A subagent the mod started: a side thread's, a fix round's, a verification's, a view's builder or reviewer
 *  (`view`: its slug) or a report's writer, verifier or highlighter (`report`: its slug; `claims`: the keys a verifier
 *  checks; `highlight`: the set a highlighter fills), with what its end updates. A fix round keeps the turn's rows and its answer's end, so its
 *  corrections reach their row and the answer file; one of a side thread's answer keeps the thread and its `turn` (from 1). */
export type ChatAgent = { kind: string; label: string; thread?: string; turn?: number; cite?: string; items?: ChatFixItem[]; reply?: string; endRow?: string; rows?: ChatRow[]; end?: ChatEnd; view?: string; report?: string; claims?: string[]; highlight?: string }

/** A proposal of a view as the row above the prompt shows it (the view pipeline, hooks/viewpipe.ts): its name, a mark
 *  and a few words for its state, and whether its view can be drawn. */
export type ChatViewPipeRow = { slug: string; name: string; mark: string; words: string; state: string; drawable: boolean }

/** A passage of a reply a fix round corrected: drawn as `new` in place of `old`, unmarked, in the row it was made for. */
export type ChatCorrection = { old: string; new: string; at: number; row: string }

/** The last text row of an answer, which carries the answer's summary line: the answer's rows as written, its cards,
 *  its file with its heading, and the coverage check of it, shown under it, when there was one. */
export type ChatEnd = { rows: ChatRow[]; cards: string[]; file: string; head: string; check?: string }

/** What a gesture acts on (hooks/gestures.tsx): `ref` the place it cites (bare, or a whole `[[value|ref]]`), `text` its
 *  shown value or its words, `cardId` the card it is on, `script` that card's script, `claim` the key of a reply
 *  citation's claim (its sentence and answer), `label` what a card's mark is called besides its value. */
export type ChatTarget = { kind: 'card' | 'mark' | 'sentence' | 'citation' | 'row' | 'record' | 'node'; ref?: string; text?: string; cardId?: string; script?: string; claim?: string; label?: string }

/** A pane a click opened that the engine left undrawn (an open no person asked for, on a terminal under its floor):
 *  the band offers it as a button, whose press opens it at any width. */
export type ChatPendingPane = { id: string; title: string; columns?: number; rows?: number; focus?: true; closeOnEscape?: true }

/** The answer the play view plays: its text as corrected, its rows (whose ids key its claims), the question asked,
 *  and a count of plays started, which keys the player so each starts fresh. */
export type ChatPlay = { text: string; rows: ChatRow[]; head: string; seq: number; video?: boolean }

/** The latest press of the play view's buttons (pause, back, next, restart), counted so the player applies each once. */
export type ChatPlayCmd = { n: number; op: string }

// ---- views (hooks/viewdraw.ts, hooks/viewpane.tsx; views/SPEC.md)

/** A row of a view: its collection and its key. */
export type ChatViewSel = { c: string; k: string }

/** What the analyst chose in a view (viewdraw.ts ViewState): its tab, search, facets, sorts, selection and the rows
 *  it followed, the window shown, the labels on and the label filter, facets shown whole, groups folded, the problems
 *  or derived fields opened under the view, and the time window each tab's lanes are zoomed to. */
export type ChatViewState = {
  tab: number
  q: string
  typing: boolean
  facets: Record<string, string[]>
  sorts: Record<string, { field: string; desc?: boolean }>
  sel: ChatViewSel | null
  back: ChatViewSel[]
  scroll: number
  dscroll: number
  labelsOn: string[]
  labelFilter: { id: string; value: string } | null
  open: string[]
  closed: string[]
  panel: '' | 'problems' | 'derived' | 'about'
  /** the time window a tab's lanes are zoomed to, by tab: epoch ms for a time field, else the field's numbers */
  zoom?: Record<string, [number, number]>
}
// ------------------------------------------------------------------------------------------ reports (hooks/reports.tsx)

/** A video report's MP4: `rendering`, `done` (its file, length, and the voice that spoke it, null for captions only),
 *  `error`, or `none` where nothing here can render it; `error` says why. */
export type ChatReportFilm = { state: string; file?: string; seconds?: number; frames?: number; voice?: string | null; error?: string; at?: number }

/** A passage a highlighter marked: the passage (report.ts passageKey, and its words for the analyst), the place that
 *  shows it and why. */
export type ChatHighlightMark = { key: string; text: string; ref: string; why: string }

/** A set of highlights the analyst asked for ("where the agents coordinate"): its words, colour, the subagent's state
 *  (`working`, `ready`, `error` with why) and the passages it marked. */
export type ChatHighlight = { id: string; request: string; label: string; color: string; state: string; why?: string; marks: ChatHighlightMark[] }

/** A report: its file under .thimble-cc-mod/reports/, its form and title, the analyst's request, its writer's progress
 *  (`writing`, then `ready`, or `error` with why), what its check found, the report it retells, a video's film, the
 *  highlights asked of it; an orientation's switches and the forks that did its analysis. */
export type ChatReport = { slug: string; form: string; title: string; request: string; file: string; state: string; why?: string; agentId?: string; tools: number; partial: string; problems: string[]; created: number; source?: string; film?: ChatReportFilm; highlights?: ChatHighlight[]; orient?: ChatOrientSwitches; orientBy?: string[] }

/** An orientation's switches, as thimble's Start gate offers them (hooks/commands.ts). */
export type ChatOrientSwitches = { deck: boolean; views: boolean; critique: boolean; report: boolean }

/** The report the panel shows: which, the slide (or a story's step) on screen, whether a slide's notes show, the
 *  toggles open, whether a story reads as one page, and the mark each highlight set last scrolled to. */
export type ChatReportNav = { slug: string; slide: number; notes: boolean; open: string[]; page?: boolean; at?: Record<string, number> }

// ---- the panel's way (hooks/nav.ts)

/** One step of the panel's way: its view, its pane's title, and what names it in that view (a thread, a citation's
 *  claim key or id, a card and its mode, a view's or a report's slug). */
export type ChatNavStep = { view: string; title: string; thread?: string; open?: string; card?: string; mode?: string; slug?: string }

/** The panel's way: `trail` the steps from home to what it shows (the breadcrumb, the last shown), `back` the trails
 *  it showed before, the latest last. */
export type ChatNav = { trail: ChatNavStep[]; back: ChatNavStep[][] }
// ------------------------------------------------------------- the harness (hooks/harness.tsx): coverage and labels

/** What this session's agents have read of the corpus (helper/coverage.py), for the row above the prompt: the line,
 *  the files read, only counted by code and never opened, the records seen of all, the largest files nothing opened,
 *  and when it was counted. */
export type ChatCoverage = { line: string; files: number; read: number; scanned: number; untouched: number; records: number; recordsSeen: number; unopened: string[]; at: number }

/** A record a label gave a value, as the label's panel shows it: its words, why, and whether the analyst set it or
 *  agreed with it (`analyst`; `was` the value the label gave). */
export type ChatLabelExample = { value: string; ref: string; text: string; rationale: string; confidence: number; analyst: boolean; was?: string }

/** A label (helper/labels.py): its definition, the label whose value narrows its records, the run's state (`running`,
 *  `ready`, `error` with why), a trial's limit (0 for all records), the records in its scope and labeled, the count of
 *  each value, examples, its card, its problems, and `status`, what its model calls recovered from. */
export type ChatLabel = { slug: string; name: string; kind: string; definition: string; values: string[]; paths: string[]; field: string; within?: { label: string; value?: string }; state: string; why?: string; trial: boolean; limit: number; total: number; labeled: number; counts: Record<string, number>; examples: ChatLabelExample[]; cards: string[]; errors: string[]; status?: string; created: number }

/** The home panel: `stacked` or `index`, the stacked sections folded and shown whole, the section the index draws
 *  whole under it ('' for none). */
export type ChatHomeUi = { layout: string; folded: string[]; more: string[]; pick: string }

declare module 'claude-code' {
  interface PluginState {
    'thimble-cc-mod': {
      verdicts: StateFamily<ChatVerdict>
      verify: StateFamily<ChatVerify>
      open: string
      turn: ChatTurn | null
      hidden: string
      paneCard: string
      picked: string
      hover: string
      runs: StateFamily<ChatRun>
      threads: StateFamily<ChatThread>
      thread: string
      threadList: string[]
      ends: StateFamily<ChatEnd>
      band: boolean
      paneMode: string
      fixes: StateFamily<ChatFix>
      agents: StateFamily<ChatAgent>
      corrections: ChatCorrection[]
      menu: ChatTarget | null
      pending: ChatPendingPane | null
      panelView: string
      // counts the panel's extra drawings, each drawing it again (register.tsx's panel hook)
      panelRedraw: number
      play: ChatPlay | null
      playCmd: ChatPlayCmd
      // views: the open view's slug, and each view's state by its slug
      view: string
      views: StateFamily<ChatViewState>
      // the view pipeline: the proposals as the row above the prompt shows them, and the one the views pane shows
      viewProposals: ChatViewPipeRow[]
      viewPane: string
      // the views pane's lists opened whole, as `<slug>:<list>`
      viewPaneMore: string[]
      reports: StateFamily<ChatReport>
      reportNav: ChatReportNav | null
      // the panel's way (hooks/nav.ts), and each side thread's answers the analyst has seen, by its id
      nav: ChatNav
      threadSeen: StateFamily<number>
      // the rows in main's chat saying a side thread answered, by the row they stand under; the threads with answers
      // unread (hooks/signal.ts)
      threadRows: StateFamily<ChatSignal[]>
      threadNews: ChatNews
      // the harness (hooks/harness.tsx): the coverage count, each label by its slug, and the label the panel shows
      coverage: ChatCoverage | null
      labels: StateFamily<ChatLabel>
      label: string
      // the home panel (hooks/home.ts): its layout, the sections folded and shown whole, the index's open one; and a
      // count that draws it again when what it lists changed on disk
      homeUi: ChatHomeUi
      homeTick: number
    }
  }
}
