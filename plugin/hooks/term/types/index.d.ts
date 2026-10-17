// The terminal UI's state contract: every value the hooks module keeps in $.state, and the types the drawing files name
// (the Chat* types, and the 0.9.0 contract types that contracts.ts re-exports). The file stands alone: Claude Code reads
// it as the plugin's state contract, which may import nothing.
//
// The terminal UI keeps no data of its own: each value is what one `thimble state` call printed (hooks/data.ts) and what
// the screen shows now, and it is read again when the workspace changes.

// ------------------------------------------------------------------------------------- the drawing files' types

/** A verification script for one citation (thimble-term runs none). */
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

/** One question of a side thread and its answer, while running its tool calls and latest text; `cards` the cards its
 *  fork made or changed (its tool results' `cell_id`), drawn under the answer. */
/** A side thread's turn. `stopped`: its run ended as a stop, not a failure (its error record's kind: the analyst's stop, or
 *  the Claude Code session that ended under it). */
export type ChatThreadTurn = { q: string; a: string; state: string; tools: number; partial: string; cards?: string[]; stopped?: boolean }

/** A side thread: what it is about, its exchange, `parent` the thread it was asked from ('' or absent: main), `at` when
 *  it last changed (epoch ms). thimble-term fills it from a thread's chat (hooks/model.ts threadOf); `loading`: the chat is
 *  not read yet, so its one turn holds only the state its row gives. */
export type ChatThread = { id: string; label: string; ref: string; context: string; agentId: string; engine: string; turns: ChatThreadTurn[]; file: string; parent?: string; at?: number; passage?: string; loading?: boolean }

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
export type ChatTarget = { kind: 'card' | 'mark' | 'sentence' | 'citation' | 'row' | 'record' | 'node' | 'check'; ref?: string; text?: string; cardId?: string; script?: string; claim?: string; label?: string }

/** One step of the panel's way: its view, its pane's title, and what names it in that view. */
export type ChatNavStep = { view: string; title: string; thread?: string; open?: string; card?: string; mode?: string; slug?: string }

/** The panel's way: `trail` the steps from home to what it shows, `back` the trails it showed before. */
export type ChatNav = { trail: ChatNavStep[]; back: ChatNavStep[][] }

/** The home panel: the card groups and folders folded or unfolded against their default, the sections shown whole,
 *  and the row the keys chose (its key, '' for the first). */
export type ChatHomeUi = { folded: string[]; unfolded: string[]; more: string[]; pick: string }

// ------------------------------------------------------------------------------------------------- thimble-term's own

/** A card as thimble-term draws it: the card in its drawing form (hooks/draw.ts CardData, as JSON), its
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
  /** how its latest card check ended (cell.ts checkOf): `error` with why, and `unrun` when its revision of the card
   *  would not run; the card pane says which, dim */
  check?: { state: string; why: string; unrun?: boolean }
  /** the card check's latest rewrite of it that stands (the cell's last `fixes` entry `applied`): the parts it rewrote
   *  (`takeaway`, `title`, `code`) and why, which a note under the card says (cell.ts fixOf) */
  fixed?: { fields: string[]; why: string }
}

/** A card's takeaway as thimble's links check left it (backend verify.py, the cell's `verification.links`): `pending`
 *  while it runs; then each citation it linked (`ok`), each it found another value for (`broken`, with why and the
 *  value the place shows) and each whose value the card's code types in rather than computes (`typed`, with why), by
 *  `<value>|<ref>`. `fixed`: each citation the check rewrote in place, by its key as it reads now, with what Claude wrote
 *  (`was` its value, `from` its place; '' where the check kept it) and why. */
export type TermLinks = { pending: boolean; checked: boolean; ok: string[]; broken: { key: string; why: string; source: string }[]; typed: { key: string; why: string }[]; fixed?: { key: string; was: string; from: string; why: string }[] }

/** A citation as checked against `thimble state resolve`: ok (the place holds the value, or the citation shows none),
 *  differs (the place resolves, the value is not there), missing (the place does not resolve), pending (not checked
 *  yet). `why` says what was found; `lines` are the place's lines for the panel (`hit` on the cited ones, `spans` where
 *  the value stands), `card` the card a card ref names and `span` its cited column and row; `command` the command whose
 *  output a call ref cites. */
export type TermVerdict = {
  ref: string
  display: string | null
  status: string
  why: string
  kind: string
  path?: string
  line?: number
  /** the line of its file the cited place starts on, where its file opens: its line, or a record's first line (a JSON
   *  document's record cited by its pointer, `…json#/messages/<id>`, whose resolution has no line of its own) */
  fileLine?: number
  lines: { n: number; text: string; hit: boolean; spans?: number[][] }[]
  card?: string
  column?: string
  row?: string
  value?: string
  command?: string
  /** a database row's or a CSV row's fields, as its place resolved them */
  record?: Record<string, unknown>
  /** the turn a chat log's cited line starts: its speaker, and where its words start in the line (UTF-16 code units),
   *  as the server read it (`meta.turn`) */
  turn?: { speaker: string; at: number }
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
  /** the Coverage view's group of a folder's files: a name pattern (`agent-*.jsonl`) or a type (`.md`) */
  match?: string
  start?: number
  /** a file's record chosen (a citation's line), lit; a file's table sorted by a column (`<column>:asc|desc`) */
  line?: number
  sort?: string
  /** a database file's table shown, and its rows from row `start` */
  table?: string
  /** a whole-file JSON transcript's turns: the first of the page shown, and the one chosen, by their index (turns
   *  that share a line, as in a file of one line, are told apart by it) */
  from?: number
  turn?: number
  agent?: string
  target?: ChatTarget | null
  about?: string
  anchor?: string | null
  anchorText?: string
  /** a new thread's: the thread it is asked from, and where it was asked (a document's passage) */
  parent?: string
  element?: string
  /** a citation panel's: the sentence the citation stands in, and the passage an example's record quotes; `of` the card
   *  whose takeaway holds the citation, whose links check the panel shows as the chat does */
  sentence?: string
  quote?: string
  of?: string
  /** a label panel's: the value a link to the label named (`concept:<id>/<value>`), lit in its counts and examples */
  value?: string
}

/** A panel Claude Code left undrawn (its `$.ui.open` answered `isPlaced: false`), which the row above the prompt
 *  offers: its pane's title, and why it waits, from the answer's `reason`: `floor` the width from which Claude Code
 *  places a pane it was not asked for (144 columns, 110 for one the person opened before) and `columns` the width then;
 *  `noScreen` when no attached screen draws panes. */
export type TermPending = { title: string; floor?: number; columns?: number; noScreen?: boolean }

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

/** A row of the threads list (`thimble state threads`): a side thread with what the rows need; `element` where it was
 *  asked (a document's passage, `report:<slug>#<unit>`), `fork` the name its forks run under (a slug, which main's
 *  `↳ thread` line names and the chat shows as its first question), `turn` how its latest question stands as its records
 *  say (`answered`, `stopped`, `failed`, '' while it runs: backend local.last_turn). */
export type TermThreadRow = { id: string; title: string; anchor: string; anchorText: string; running: boolean; answers: number; seen: number; unread: number; at: string; parent: string; created?: string; element?: string; question?: string; fork?: string; turn?: string }

/** The label panel's state: the parts opened, by `<label>:<part>`; the kind picked in `type` and not yet saved, by
 *  label; and each label's run started from the panel (its size, 0 for every record) and its last word. */
export type TermLabelUi = { open: string[]; kind: Record<string, string>; runs: Record<string, { limit: number; at: number }>; said: Record<string, string> }

/** The file browser: the folders folded or unfolded against their default, the folders shown whole, the row the keys
 *  chose; the words of its find (`query`) and the row of what it found that the keys chose (`found`). */
export type TermFilesUi = { folded: string[]; unfolded: string[]; pick: string; whole?: string[]; query?: string; found?: string }

// ------------------------------------------------------------------------------------------------- 0.9.0 (SPEC-v2 C13)

/** The per-feature switches (`/config` → thimble, the browser's Settings; `thimble features`, C6). */
export type FeatureSettings = { viewProposals: boolean; labels: boolean; checks: boolean; citationMarks: boolean; coverage: boolean; cardCheck: boolean }
/** thimble on in this session (C2's answer): the workspace, the folder, how it turned on and the session's role. */
export type Activated = { ws: string; path: string; cwd: string; via: string; role: 'main' | 'peer'; at: number }
/** What Claude read (`seen`) or searched of the corpus in this session (`thimble state coverage --summary`): `totals` one
 *  entry per unit the corpus has, lines (line-based text), then entries (a JSON document's values, a database's rows),
 *  then files (everything else); `records` the first of lines or entries, with its unit; `size` the whole corpus's
 *  total by size (null with no index yet); `line` the line under answers (`read 2% · searched 41% of the data`). */
export type CoverageSummary = { files: { seen: number; searched: number; never: number; total: number }; records: { unit?: 'lines' | 'entries'; seen: number; searched?: number; total: number; counted: boolean }; totals?: CoverageTotal[]; size?: CoverageSize | null; line: string }
/** The corpus's total by size, in bytes: what Claude read, what was searched and not read, and the corpus's size. */
export type CoverageSize = { read: number; searched: number; total: number }
/** One unit's totals over the corpus: read (`seen`), searched and the total in that unit; for lines and entries, whether
 *  they are counted yet and the files that hold them. */
export type CoverageTotal = { unit: 'lines' | 'entries' | 'files'; seen: number; searched: number; total: number; counted?: boolean; files?: number; files_seen?: number; files_searched?: number }
/** One chat citation the transcript drew. */
export type CiteRow = { id: string; raw: string; display: string | null; ref: string; row: string; at: number }
/** A check's comment on a passage of one of Claude's answers (C9, in the terminal's spelling); `color` is the check's
 *  label palette place, 1-8. */
export type AnswerComment = { id: string; check: string; checkName: string; color: number; about: string; turn: string; row: string; ref: string; start: number; end: number; quote: string; text: string; details: string; status: 'open' | 'dismissed'; at: string }
/** The panel's per-section counts last seen (as 0.8.0's homeSeen). */
export type SummarySeen = { cards: number; labels: number; docs: number; views: number; threads: number; checks: number; at: number }

/** A label's records with no category fit and its unsure records, counted, for the summary line (term-panel). */
export type LabelUnsure = { id: string; name: string; noFit: number; unsure: number }

/** A press that opens the browser, while it runs (term-panel). */
export type Pressing = { at: number; ref: string }

/** The remote rows' commands: the SSH tunnel, the ET form, and the page's address, never a sign-in code (term-panel). */
export type Links = { tunnel: string; et: string | null; url: string }

declare module 'claude-code' {
  interface PluginState {
    'thimble': {
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
      // a panel Claude Code left undrawn, and why: the row above the prompt offers it
      pending: TermPending | null
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
      // 0.9.0 (SPEC-v2 C13; contracts.ts has the shapes). The transcript's: thimble on in this session (null before
      // activation), the feature switches, the session's coverage, the chat citations drawn, the checks' comments on
      // answers and how many checks read an answer now
      activated: Activated | null
      settings: FeatureSettings
      coverageSummary: CoverageSummary | null
      citeIndex: CiteRow[]
      answerComments: AnswerComment[]
      checksRunning: number
      // the panel's: the comment open in its Checks view (the transcript lights its passage), the labels' unsure
      // counts, the sections' counts last seen, a press in flight and the remote links
      checksOpen: string | null
      labelUnsure: { id: string; name: string; noFit: number; unsure: number }[]
      seen: SummarySeen | null
      pressing: { at: number; ref: string } | null
      links: { tunnel: string; et: string | null; url: string } | null
    }
  }
}
