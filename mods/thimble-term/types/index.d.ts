// thimble-term's state contract: every value the hooks module keeps in $.state, and the types the drawing files copied
// from thimble-cc-mod name (the Chat* types, copied from thimble-cc-mod's types/index.d.ts as they are).
//
// thimble-term keeps no data of its own: each value is what one `thimble state` call printed (hooks/data.ts) and what
// the screen shows now, and it is read again when the workspace changes.

// ------------------------------------------------------------------ copied from thimble-cc-mod (drawing files use them)

/** A verification script for one citation (thimble-cc-mod; thimble-term runs none). */
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
  ref?: string
  kind?: string
  why?: string
}

/** One question of a side thread and its answer, while running its tool calls and latest text. */
export type ChatThreadTurn = { q: string; a: string; state: string; tools: number; partial: string }

/** A side thread: what it is about, its exchange, `parent` the thread it was asked from ('' or absent: main), `at` when
 *  it last changed (epoch ms). thimble-term fills it from a thread's chat (hooks/model.ts threadOf). */
export type ChatThread = { id: string; label: string; ref: string; context: string; agentId: string; engine: string; turns: ChatThreadTurn[]; file: string; parent?: string; at?: number; passage?: string }

/** A side thread's turn that ended while the panel did not show the thread: one row in main's chat under the row it
 *  stands under (hooks/signal.ts), by its thread and its turn (from 1). */
export type ChatSignal = { thread: string; turn: number }

/** The threads holding answers the analyst has not read: how many, and the one when there is only one. */
export type ChatNews = { n: number; one: string }

export type ChatFix = { state: string; why?: string }
export type ChatFixItem = { old: string; problems: { raw: string; why: string }[]; cites: string[]; keys?: string[]; card?: string }
export type ChatRow = { id: string; text: string }
export type ChatCorrection = { old: string; new: string; at: number; row: string }
export type ChatEnd = { rows: ChatRow[]; cards: string[]; file: string; head: string; check?: string }

/** What a gesture acts on (hooks/gestures.tsx): `ref` the place it cites (bare, or a whole `[[value|ref]]`), `text` its
 *  shown value or its words, `cardId` the card it is on, `claim` the key of a reply citation's claim, `label` what a
 *  card's mark is called besides its value. */
export type ChatTarget = { kind: 'card' | 'mark' | 'sentence' | 'citation' | 'row' | 'record' | 'node'; ref?: string; text?: string; cardId?: string; script?: string; claim?: string; label?: string }

/** One step of the panel's way: its view, its pane's title, and what names it in that view. */
export type ChatNavStep = { view: string; title: string; thread?: string; open?: string; card?: string; mode?: string; slug?: string }

/** The panel's way: `trail` the steps from home to what it shows, `back` the trails it showed before. */
export type ChatNav = { trail: ChatNavStep[]; back: ChatNavStep[][] }

/** The home panel: the card groups and folders folded or unfolded against their default, the sections shown whole,
 *  and the row the keys chose (its key, '' for the first). */
export type ChatHomeUi = { folded: string[]; unfolded: string[]; more: string[]; pick: string }

// ------------------------------------------------------------------------------------------------- thimble-term's own

/** A card as thimble-term draws it: the card in thimble-cc-mod's drawing form (hooks/draw.ts CardData, as JSON), its
 *  takeaway, its state words (`waiting for its run`, `running`, an error), and what the cell carried that the drawing
 *  reads (its group, who made it, its label). `rev` counts the reads, so a drawing reads it again. */
export type TermCard = {
  id: string
  /** null when the card cannot be read (`error` says why) */
  data: unknown
  takeaway: string
  busy: string
  error: string
  group: string
  by: string
  kind: string
  label: string
  code: string
  rev: number
  /** thimble's links check of the takeaway (the cell's `verification.links`), when it ran */
  links?: TermLinks
  /** what its last run printed (cell.ts printed) */
  printed?: string
  /** how its last run ended: `ok`, `error`, or '' when it has not run */
  ran?: string
}

/** A card's takeaway as thimble's links check left it (backend verify.py, the cell's `verification.links`): `pending`
 *  while it runs; then each citation it linked (`ok`) and each it found another value for (`broken`, with why and the
 *  value the place shows), by `<value>|<ref>`. */
export type TermLinks = { pending: boolean; checked: boolean; ok: string[]; broken: { key: string; why: string; source: string }[] }

/** A citation as checked against `thimble state resolve`: ok (the place holds the value, or the citation shows none),
 *  differs (the place resolves, the value is not there), missing (the place does not resolve), pending (not checked
 *  yet). `why` says what was found; `lines` are the place's lines for the panel (`hit` on the cited ones, `spans` where
 *  the value stands), `card` the card a card ref names and `span` its cited column and row. */
export type TermVerdict = {
  ref: string
  display: string | null
  status: string
  why: string
  kind: string
  path?: string
  line?: number
  lines: { n: number; text: string; hit: boolean; spans?: number[][] }[]
  card?: string
  column?: string
  row?: string
  value?: string
  at: number
}

/** What the panel shows (register.tsx's one Pane): its view and what names the thing in it; `mode` a view's other face
 *  (a card's `code`, a file's `transcript`). */
export type TermPanel = {
  view: string
  title: string
  mode?: string
  card?: string
  ref?: string
  display?: string | null
  thread?: string
  label?: string
  slug?: string
  path?: string
  start?: number
  /** a file's record chosen (a citation's line), lit; a file's table sorted by a column (`<column>:asc|desc`) */
  line?: number
  sort?: string
  agent?: string
  target?: ChatTarget | null
  about?: string
  anchor?: string | null
  anchorText?: string
  /** a new thread's: the thread it is asked from, and where it was asked (a document's passage) */
  parent?: string
  element?: string
  /** a citation panel's: the sentence the citation stands in, and the passage an example's record quotes */
  sentence?: string
  quote?: string
}

/** A turn's answer (its last text part that cites or embeds a card, else its last), kept under its last row for the
 *  footer drawn there: its rows' uuids, its text, the cards it shows (embedded, or made in the turn). */
export type TermAnswer = { rows: string[]; text: string; cards: string[] }

/** The row above the prompt and the home panel's counts, from `thimble state home`. */
export type TermHome = { cards: number; labels: number; docs: number; threads: number; views: number; files: number; at: number }

/** One of thimble's agents as `thimble state agents` lists it: its type name, what it works on, its state, its chat,
 *  its role, and the time it started when known. */
export type TermAgent = { name: string; label: string; state: string; kind: string; chat: string; role: string; started: string }

/** A thread's chat as the panel and the rows above the prompt read it: its meta and the events read so far (`n`, the
 *  count, is passed back as `--after`). */
export type TermThread = { id: string; meta: Record<string, unknown>; events: Record<string, unknown>[]; n: number; rev: number }

/** A row of the threads list (`thimble state threads`): a side thread with what the rows need. */
/** A row of the threads list (`thimble state threads`): a side thread with what the rows need; `element` where it was
 *  asked (a document's passage, `report:<slug>#<unit>`). */
export type TermThreadRow = { id: string; title: string; anchor: string; anchorText: string; running: boolean; answers: number; seen: number; unread: number; at: string; parent: string; created?: string; element?: string; question?: string }

/** The label panel's state: the parts opened, by `<label>:<part>`; the kind picked in `type` and not yet saved, by
 *  label; and each label's run started from the panel (its size, 0 for every record) and its last word. */
export type TermLabelUi = { open: string[]; kind: Record<string, string>; runs: Record<string, { limit: number; at: number }>; said: Record<string, string> }

/** The file browser's state: the folders folded or unfolded against their default (the first open), and the file the
 *  keys chose. */
export type TermFilesUi = { folded: string[]; unfolded: string[]; pick: string; whole?: string[] }

declare module 'claude-code' {
  interface PluginState {
    'thimble-term': {
      // the cards by id, and the cards each row of main's chat carries under it (by the row's uuid)
      cards: StateFamily<TermCard>
      turnCards: StateFamily<string[]>
      // each citation's check, by the citation's id (lib.ts cid of its raw spelling)
      verdicts: StateFamily<TermVerdict>
      // the panel: what it shows and its way
      panel: TermPanel | null
      nav: ChatNav
      // a count that draws the panel again when what it shows changed on disk
      panelTick: number
      // a panel a click opened that waits undrawn on a narrow terminal: the row above the prompt offers it
      pending: { title: string } | null
      // the rows above the prompt: the workspace's counts, the agents, the threads
      home: TermHome | null
      // the workspace's counts when home was last opened: the row above the prompt shows only what is new since
      homeSeen: TermHome | null
      agents: TermAgent[]
      threads: TermThreadRow[]
      threadNews: ChatNews
      // a thread's chat as read, by its id
      thread: StateFamily<TermThread>
      // rows in main's chat saying a side thread answered, by the row they stand under
      threadRows: StateFamily<ChatSignal[]>
      // a turn's answer, by its last row, for the footer under it
      answers: StateFamily<TermAnswer>
      // the views main proposed, by the row their `↳ view` rows stand under
      viewRows: StateFamily<string[]>
      // the home panel: what is folded and shown whole, and the row the keys chose
      homeUi: ChatHomeUi
      // the label panel: its parts opened (`<label>:counts`, `:examples`, `:cards`), the kind picked and not yet saved
      labelUi: TermLabelUi
      // the file browser: the folders folded or unfolded against their default, and the file the keys chose
      filesUi: TermFilesUi
      // what `thimble state` said last for a surface the panel shows, by the surface and its arguments
      surface: StateFamily<unknown>
    }
  }
}
