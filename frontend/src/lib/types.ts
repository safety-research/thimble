// Every shape the frontend shares with the backend. Field names are the wire's.

// ---- chats and records ----

export type ChatKind = 'main' | 'thread' | 'agent'
export type AgentRole = 'orient' | 'propose' | 'writer' | 'check' | 'labels' | 'dev'
export type AgentStatus = 'running' | 'done' | 'failed' | 'stopped'

/** `chats/<id>.meta.json`; the list route adds `n_messages`, `last_ts`, `running`. */
export interface ChatMeta {
  id: string
  kind: ChatKind
  role: string
  title: string
  created_at: string
  parent: string | null
  anchor: string | null
  anchor_text: string | null
  model: string | null
  effort: string | null
  group: string | null
  status?: AgentStatus
  result?: string | null
  ts_end?: string | null
  n_messages?: number
  last_ts?: string | null
  running?: boolean
  /** the analyst's name for a chat that is no thread, which the thread tree shows in place of the one it derives */
  name?: string | null
  /** a writer's document (write_session.start) */
  doc?: string | null
  /** a writer that answers the orientation's report pass: the orientation's chat and its run then; null on a writer
     * the analyst asked for; may be absent (write_session.start) */
  orient?: string | null
  orient_run?: number | null
}

export type ChipKind = 'say' | 'filter' | 'label' | 'ticket' | 'artifact' | 'view' | 'thread'

/** One line of `chats/<id>.jsonl`; its index in the log is its id. */
export type ChatRecord =
  | { type: 'user'; ts?: string; text: string; by?: RecordBy | 'main' | 'extension'; event?: string; run?: number; extension?: string }
  | { type: 'text'; delta: string; parent_tool_use_id?: string; reply?: boolean; by?: RecordBy }
  | { type: 'tool_use'; ts?: string; id: string; name: string; input: unknown; parent_tool_use_id?: string; n?: number }
  | { type: 'tool_result'; ts?: string; id: string; summary: string; is_error?: boolean; not_run?: boolean; cell_id?: string; label_card?: string; notebook?: string; parent_tool_use_id?: string }
  | { type: 'refs'; ts?: string; resolved: string[]; broken: string[]; why?: Record<string, string>; links?: unknown[]; unlinked?: unknown[] }
  | { type: 'done'; ts?: string; session_id?: string | null; cells?: string[]; result?: string | null }
  | { type: 'error'; ts?: string; message: string; kind?: string; detail?: string }
  | { type: 'chip'; ts?: string; kind: ChipKind | string; text: string; ref?: string; [k: string]: unknown }
  | { type: 'agent'; ts?: string; chat: string; role: string; title: string; run?: number; tool_use_id?: string }
  | { type: 'shot'; ts?: string; phase: string; ticket: string; name: string; note?: string }

export interface ChatDetail {
  meta: ChatMeta
  events: ChatRecord[]
}

/** One call of an orientation as its store keeps it (backend calls.py, `workspaces/<c>/calls/<chat>.jsonl`): its number
 * in the orientation's one sequence, the chat whose log holds its record (the orientation's, or a step's), the tool, its
 * input, and its whole output as text, null while it runs (`output` read the same). */
export interface StoredCall {
  n: number
  id: string
  chat?: string
  name: string
  input: unknown
  result?: string | null
  output?: string | null
  is_error?: boolean
}

/** The index of an orientation's calls: each call's number by its tool_use id. A bare list reads the same. */
export type CallIndex = { calls: { n: number; id: string; name?: string }[] } | { n: number; id: string; name?: string }[]

export interface NewThreadBody {
  anchor?: string | null
  anchor_text?: string | null
  title?: string | null
  /** the part of the browser the element is in (its `data-panel`) */
  surface?: string | null
  /** the element's kind: its component class, else its tag */
  element?: string | null
  /** its CSS selector */
  selector?: string | null
  /** a PNG of the element captured at the click, as a data URL */
  image?: string | null
  /** the chat the analyst was reading when they asked, which the new thread hangs under */
  parent?: string | null
  /** the first question: sent as the thread's first event in the same request, which makes nothing when no session
   * listens */
  text?: string | null
}

export interface ChatPatch {
  title?: string
  model?: string
  effort?: string
  /** the name the thread tree shows: a thread's title, another chat's `name` */
  name?: string
}

// ---- the workspace stream ----

export type WsEvent = { ts?: string; seq?: number } & (
  | { type: 'chat'; chat: string; deleted?: boolean }
  | { type: 'cell'; notebook: string; cell: string; kind: 'ran' | 'note' | 'verified' | string }
  | { type: 'orient'; status: 'started' | 'done' | 'failed' | 'stopped' | string; [k: string]: unknown }
  | { type: 'report'; slug: string; status: 'generating' | 'generated' | 'failed' | 'verified' | 'figures' | 'rewritten' | string; span?: string; run?: string }
  | { type: 'view'; slug: string; status: 'queued' | 'building' | 'built' | 'failed' | 'deleted' | string; path?: string; chat?: string; version?: string }
  | { type: 'ticket'; id: string; n: number; status: string }
  | { type: 'concepts'; concept: string; what: 'defined' | 'applied' | 'deleted' | string; rows?: boolean }
  | { type: 'filter'; scope: FilterScope; concept?: string; value?: string }
  | { type: 'check'; id: string; doc: string; status: CheckRunStatus | string; run?: string; chat?: string }
  | { type: 'job'; status: string }
  | { type: 'server'; status: string }
  | { type: string; [k: string]: unknown }
)

// ---- canvas: groups and cells ----

/** how a group lays out its children: a column, a row, two columns; a loose group draws no frame (backend notebook.GROUP_KINDS) */
export type GroupKind = 'sequence' | 'split' | 'grid' | 'loose'

export interface Group {
  id: string
  title: string
  parent: string | null
  kind: GroupKind
  anchor: string | null
  chat: string | null
  role: string
  n_cells?: number
  ts?: string
  /** the session thimble ran beside main whose own group this is, such as `writer:report` (backend tools.SESSION_GROUP_KEY) */
  session?: string
}

export type CellKind = 'plot' | 'table' | 'code' | 'example' | 'note' | 'diagram' | 'timeline' | 'label' | 'custom'

export type MimeBundle = Record<string, any> & { _stream?: 'stdout' | 'stderr'; _out?: number; truncated?: OutputTruncation }

export interface OutputTruncation {
  total_lines: number
  kept_head: number
  kept_tail: number
  path: string
}

export type CellPayload =
  | { refs: string[] }
  | { text: string }
  | { concept: string }
  | { html: string }
  | { dataset: unknown }
  | Record<string, unknown>

export type CellStatus = 'idle' | 'running' | 'ok' | 'error'

export interface Cell {
  id: string
  notebook: string
  kind: CellKind | 'md' | string
  /** the question */
  title: string
  /** its short name, made from the question and unique in the workspace (backend notebook.slug_of): what shows where an
   * id would */
  slug?: string | null
  takeaway?: string
  takeaway_author?: string
  /** the takeaway was written before the card's last run changed its outputs (backend notebook.TAKEAWAY_STALE) */
  takeaway_stale?: boolean
  created_by: string
  created_at_event?: number | null
  created_ts?: string
  ts: string
  labels?: string[]
  /** the revision of each label in `labels` as the card's last run read it (backend concepts.py, Revisions); a card
     * whose label has a later revision is stale (canvas/concepts staleLabels). Absent is taken as current. */
  label_revs?: Record<string, number> | null
  /** the labels thimble is running the card again for, since they changed after its last run; set while that run
   * lasts */
  regenerating_for?: string[] | null
  verification?: unknown
  code?: string
  outputs?: MimeBundle[]
  status?: CellStatus
  exec_count?: number | null
  /** the last run's wall time in seconds */
  duration_s?: number | null
  payload?: CellPayload
  /** a note's text, mirrored from its payload */
  text?: string
  /** the analyst's lock: no model may change or delete the card */
  locked?: boolean
  /** the latest card check (lib/cardCheck) */
  check?: unknown
  /** the changes checks made to the card, oldest first (lib/cardCheck) */
  fixes?: unknown[]
}

export interface CanvasResponse {
  groups: Group[]
  cells: Cell[]
  /** the ids of the cards the route leaves out: a legacy orientation Scratch (backend notebook.canvas) */
  hidden?: string[]
}

export interface NewCellBody {
  kind: CellKind
  title: string
  code?: string
  payload?: CellPayload
  after?: string
}

export interface CellPatch {
  code?: string
  title?: string
  takeaway?: string
  payload?: CellPayload
  locked?: boolean
}

export interface CellName {
  id: string
  notebook: string
  title: string
  slug?: string | null
  exec_count?: number | null
  ts?: string | null
  status?: string | null
}

// ---- labels and filters ----

export type ConceptKind = 'prompt' | 'regex' | 'code'
export type ConceptUnit = 'record' | 'cell' | 'span' | 'agent' | 'run'
export type FilterScope = 'files' | 'canvas' | 'report'

/** What a label over files marks in the reader: the texts that carry the value, the record, or the file. */
export type LabelMarks = 'span' | 'record' | 'file'

/** One value of a label as the Files pane draws it: its colour (1..12 a --label-N, 0 the grey of "no match") and whether
 * the reader highlights it. */
export interface LabelClass {
  name: string
  color: number
  highlight: boolean
}

export interface Concept {
  id: string
  name: string
  description: string
  unit: ConceptUnit
  kind: ConceptKind
  spec: string
  labels: string[]
  created_by: string
  ts: string
  version?: number
  counts?: Record<string, number>
  n_labeled?: number
  /** the records the analyst gave a value by hand that the label's run labelled too */
  n_reviewed?: number
  /** every record the analyst gave a value by hand */
  n_marked?: number
  /** a label over files: what it marks; null for a label of cards or report sentences */
  marks?: LabelMarks | null
  /** what it applies to: comma-separated globs */
  glob?: string
  /** the prompt kind's classifier model; '' for the labels role's */
  model?: string
  /** the values in order, each with its colour and highlight */
  classes?: LabelClass[]
  /** on in Files */
  shown?: boolean
  /** a trial: apply_label ran it on a few units with `limit` (backend concepts.py, Trials); no label until it runs on everything */
  trial?: boolean
  /** GET /concepts carries these too: the last kept run (the Files pane's outcome line) and the live run record */
  last_run?: ConceptApplication | null
  run?: ConceptRun | null
  /** how many times what a card reads from the label has changed (backend concepts.py, Revisions), and the last of
   * those changes in words */
  rev?: number
  changes?: LabelChange[]
}

/** One change to a label that a card counting by it did not see (backend concepts.note_change): a redefinition, a run
 * that ended, or a run of corrected values, one entry over the revisions `first` to `rev`. */
export interface LabelChange {
  what: 'redefined' | 'corrected' | 'ran'
  first: number
  rev: number
  text: string
  ts: string
}

/** `GET /ws/{c}/labels/presence`: per label over files, the values it left on each file. */
export interface LabelPresence {
  concept_id: string
  paths: Record<string, Record<string, number>>
}

/** `GET /ws/{c}/labels/ruler?path=`: where on one file each label's values fall, the file's lines cut into `bins`. */
export interface LabelRuler {
  path: string
  total: number
  bins: number
  labels: { concept_id: string; bins: Record<string, number[]> }[]
}

/** `PUT /concepts/{id}`: what the Files pane's edit card changes. */
/** A label the labels model defined from the analyst's description (backend concepts.draft_of): what it labels, its
 * scope, its classifier and its values, the positive first. Nothing is stored until the row creates it. */
export interface LabelDraft {
  name: string
  over: 'files' | 'cards' | 'sentences'
  marks: LabelMarks | null
  glob: string
  kind: ConceptKind
  text: string
  values: string[]
}

export interface ConceptPatch {
  name?: string
  description?: string
  kind?: ConceptKind
  spec?: string
  labels?: string[]
  marks?: LabelMarks
  glob?: string
  model?: string
  classes?: { name: string; color?: number | null; highlight?: boolean }[]
  shown?: boolean
}
export type Label = Concept

export interface LabelRow {
  ref: string
  label: string | null
  confidence: number | null
  rationale?: string | null
  source: string | null
  ts?: string
  analyst?: string | null
  /** the texts of the record a span label marks */
  spans?: string[]
  /** the line a record whose ref names none starts on (a CSV row, a JSON document's record) */
  line?: number
}

export interface LabelRowsResponse {
  rows: LabelRow[]
  total: number
}

/** `GET /ws/{c}/labels?path=`: one entry per concept with rows on the file. */
export interface LabelsForPath {
  concept_id: string
  name: string
  labels: string[]
  unit: ConceptUnit
  rows: LabelRow[]
}

export interface FilterEntry {
  concept: string
  value: string
}
/** The card parts of the canvas's filter, each present only while set (backend concepts.py, the filters section). */
export interface CardFilterParts {
  kinds?: string[]
  /** group ids */
  groups?: string[]
  /** who made the cards, as their top row names them (layout.ts cellThread) */
  makers?: string[]
  /** what the card check found (lib/cardCheck.ts CheckFilterState) */
  checks?: string[]
  starred?: boolean
  locked?: boolean
  /** words, each of which starts a word of a kept card's question or takeaway */
  text?: string
}
/** The canvas's filter: a label value, the card parts, or both. */
export type CanvasFilterEntry = Partial<FilterEntry> & CardFilterParts
export interface Filters {
  files?: FilterEntry
  report?: FilterEntry
  canvas?: CanvasFilterEntry
}

// ---- views and proposals ----

/** A view ticket's build: `dropped` is an orientation proposal that could not be built, shown nowhere (backend
 * views.drop); `suggested` a viewer for a file type, such as one the orientation proposes, shown only in the File
 * browser until the analyst accepts it (backend views.accept). */
export type ProposalStatus = 'queued' | 'building' | 'built' | 'failed' | 'dropped' | 'suggested'

/** A view ticket (the propose_view tool): what the analyst sees in the view and why, the files it reads, the unit and
 * the layout, and the state of the dev agent's build, whose agent chat is `chat`. */
export interface Proposal {
  slug: string
  name: string
  why: string
  claims: string[]
  arrangement: string
  proposed_by: string
  /** the analyst asked for it (backend views.propose): it opens by itself once built (files/viewReady.ts) */
  asked?: boolean
  /** an orientation's proposal whose view has not passed its checks yet: its card shows the build, the views bar not */
  held?: boolean
  /** its view is switched off in Settings (backend views.views_off): the views bar leaves it out */
  off?: boolean
  status: ProposalStatus
  ts: string
  error?: string
  /** the request of a change to the built view that failed, which Retry makes again (backend views.end_revision) */
  failed_change?: string
  /** a change to a built view is being made (backend views.revise); the view stays open at the version it last passed */
  revision?: boolean
  chat?: string | null
  attempts?: number
  /** the review of the built view's pictures (backend view_review) */
  review?: ViewReview
}

/** The review of a built view's pictures: running, done (with what it revised and what problems are left), failed
 * or stopped, with a note that says why; `undo` once the analyst put the view back as it was built. */
export interface ViewReview {
  state: 'running' | 'done' | 'failed' | 'stopped'
  round?: number
  ts?: string
  revised?: string[]
  left?: string[]
  note?: string
  undo?: boolean
  /** the pictures the review took */
  shots?: number
}

/** `GET /ws/{c}/views/suggestions?path=`: whether a viewer may be proposed for the type of a file opened in the File
 * browser, why not, the workspace's answer for the type and its proposal (backend views.suggestion_for). */
export interface ViewSuggestion {
  path: string
  suffix: string
  eligible: boolean
  reason: string
  answer: 'suggested' | 'none' | 'dismissed' | null
  proposal: Proposal | null
}

/** One form a view adds to the citation grammar: a fragment of a file it claims, or view:<slug>/<key>. */
export interface ViewForm {
  form: string
  means: string
}

/** `GET /ws/{c}/views[?path=]`: a viewer written for this corpus (backend views.py). */
export interface View {
  slug: string
  /** written for this corpus, or a file-type viewer thimble ships (plugin/viewers) */
  origin: 'workspace' | 'builtin'
  name: string
  /** what it shows, in a sentence */
  description: string
  claims: string[]
  accepts: ViewForm[]
  /** its own citable units, cited as view:<slug>/<key> */
  units: ViewForm[]
  /** the fields its reader made rather than read, as view.json lists them */
  derived?: ViewDerived[]
  libs: string[]
  built: string
  /** the digest of its files when it last passed its checks: a page loaded at it keeps it until reloaded */
  version?: string
  /** reader.py, view.html and claims are all there */
  ok: boolean
  /** the forms as written in a citation */
  forms: ViewForm[]
  /** the first file it claims, which Raw shows for a view opened on its own */
  first_file?: string | null
  /** the files it claims, the first 500 of them, and how many there are */
  files?: string[]
  n_files?: number
  /** its claims are globs and the corpus has not been walked yet: no files are known (the list read again shortly) */
  files_pending?: boolean
  /** "file" for a file viewer; what one unit of a corpus view is otherwise, as view.json gives it */
  unit?: string | Record<string, string> | null
  /** a file viewer, a mode of the File browser for the files it claims rather than a view in the views bar: its unit is
   * "file", or with no unit every claim is one extension's glob (backend views.file_type_viewer) */
  /** its page draws label controls of its own (elements with data-label) */
  label_controls?: boolean
  file_type?: boolean
}

/** A diagram card's dataset (canvas/DataViz.tsx). */
export interface GraphDataset {
  nodes: ({ id: string; label?: string; size?: number } & Record<string, unknown>)[]
  edges: ({ source: string; target: string; weight?: number } & Record<string, unknown>)[]
}
/** A timeline card's dataset (canvas/DataViz.tsx). */
export interface TimelineDataset {
  events: ({ time: string | number; label: string; lane?: string; end?: string | number } & Record<string, unknown>)[]
}

/** `GET /ws/{c}/views/{slug}/problems`: the lines of its files a view's reader could not read, the first few of them. */
export interface ViewProblems {
  /** null for one file's when the reader did not list them all, so the file's count is not known */
  count: number | null
  examples: { ref: string; why: string }[]
}

/** A field a view's reader made rather than read as the files hold it, `kind` "inferred" for a value the files do not
 * state (a join, an estimate, a classification), shown as computed, `key` the key the reader's records hold it under
 * where that differs, `record` the kind of record that holds it ('' or absent when the view names none). */
export interface ViewDerived {
  record?: string
  field: string
  from: string
  how: string
  kind?: 'inferred' | ''
  key?: string
}

/** `GET /ws/{c}/views/{slug}/shown`: of the files a view claims, those it does not show whole, the first 500 of them,
 * each with why its reader hides it ('' when it gives no why) and how many of its bytes were read, with `claimed`
 * false for a file of a folder beside the claimed ones; what the claims expect and the corpus lacks; the records its
 * reader could not place; and the fields its reader derived, by kind of record, the inferred ones first in each. */
export interface ViewShown {
  files: number
  not_shown: { count: number; unexplained: number; files: { path: string; size: number; read: number; why: string; claimed?: boolean }[] }
  missing?: { path: string; why: string }[]
  unplaced?: ViewProblems
  derived: ViewDerived[]
  errors: string[]
}

/** What a view's page gets as `open` (`GET /ws/{c}/views/{slug}/resolve?ref=`). */
/** A view opened from a card of a card type (Open as view): the card, its question and the arguments of its call, which
 * choose the view's records. */
export interface ViewQuery {
  card: string
  title: string
  args: Record<string, unknown>
}

export interface ViewOpen {
  ref: string | null
  path?: string
  /** `path` is a file the analyst opened the view on (Open in), not the first file thimble opens a view on */
  picked?: boolean
  fragment?: string
  key?: string | null
  target?: unknown
  label?: string
  excerpt?: string
  refs?: string[]
  error?: string
  /** in a view: the card it is drawn from, or null for none */
  query?: ViewQuery | null
}

// ---- orientation ----

/** The Start card's switches: the orientation's deck (`final`), its view proposals, the report, and its critic's
 * review. Ultracode is the effort menu's highest level (StartGate). */
export type OrientPass = 'final' | 'views' | 'critique' | 'report'

/** The orientation's reasoning effort below Ultracode, Claude Code's level names (orientation.EFFORTS). */
export type OrientEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** An effort menu's choice, the Start gate's for the orientation and the composer's for main and its threads: Claude
 * Code's levels, then Ultracode, which runs at xhigh with workflows (cc_settings.EFFORTS and ultracode). */
export type MainEffort = OrientEffort | 'ultracode'

/** A permission request waiting for the analyst: main's, relayed by its hook (events.py), or one of a session thimble
 * started beside main, the orientation's or a writer's (agent_session.ask). `what` is what the call would do, `input`
 * its arguments as text. */
export interface PermissionRequest {
  id: string
  tool: string
  what: string
  input?: string
  since?: string
  /** the subagent or workflow agent that asked, absent for the session itself (backend agent_session.ask) */
  agent_id?: string | null
  /** its agent type (general-purpose, Explore), and the title and chat of its step once the session's follower has
   * made one */
  agent_type?: string | null
  agent_title?: string
  agent_chat?: string
  /** a Bash request's command, whole, which the card shows as code rather than the input's JSON */
  command?: string
  /** what Claude Code's own "don't ask again" would add for the session (`Bash(npm test *)`, `all edits`), when the
   * request suggests it: the card's third choice (backend agent_session, don't ask again) */
  always?: string
  /** on main's meta: the thread or subagent chat whose agent asked, when the hook said which (backend events._hold) */
  chat?: string | null
  /** why auto mode refused the call, when the request is one it refused and the analyst may allow (backend
   * agent_session, auto mode) */
  refused?: string
  /** how many times thimble sent the call back to auto mode after its classifier gave no verdict, before asking */
  rechecked?: number
  /** how long a request auto mode could not judge waits unanswered before it is declined, in seconds */
  deny_after_s?: number
  /** when nobody answered it in time and it was declined: it stays on the card until dismissed (backend agent_session,
   * permissions) */
  expired?: string
  /** the seconds it waits before it is declined unanswered; absent for main's, which Claude Code also asks in the
   * terminal */
  wait_s?: number
  /** the mode of the session that asks (manual, auto, bypass) */
  mode?: string
  /** the later calls for the same site, or later searches, that wait on this request's answer, each listed whole */
  also?: string[]
  /** a web call's "don't ask again", kept for the workspace: its site, or `web search` */
  keep?: string
  /** the length of the command or input when the card shows only its start (backend PERMISSION_INPUT_CHARS); such a
   * request offers no "don't ask again" */
  cut?: number
  /** why thimble itself asks, which the card says in place of the mode's reason (backend dev.CODE_WHY) */
  why?: string
  /** what in thimble's config sends the call to the analyst in every permission mode: an edit of thimble's config
   * files, an edit of the corpus, an install, or any command (backend userconf.Session.ask_cause) */
  asked_by?: 'config' | 'data' | 'installs' | 'commands'
}

/** A session held where the browser cannot answer: the model-switch dialog after a safety stop (session.py). */
export interface SessionAlert {
  kind: string
  text: string
  since?: string
  /** kind `retry` (agent_session's retry): why the session waits, "Anthropic's API is overloaded" */
  reason?: string
  /** kind `retry`: when it starts again, ISO */
  until?: string
  /** kind `retry`: the retry this wait comes before, from 1 */
  attempt?: number
}

/** The body of the `start` event (prompts/main.md, the `start` bullet; orientation.start_requested). */
/** The `start` event's body: start_orientation's three switches, which main passes on (`final_notebook` turns on the
 * deck, the group Orientation), then the settings the server keeps for the orientation's session
 * (orientation.start_requested). */
export interface StartBody {
  final_notebook: boolean
  propose_views: boolean
  generate_report: boolean
  critique: boolean
  ultracode: boolean
  effort: OrientEffort
  text?: string
}

/** A permission mode of the sessions thimble starts (backend modes.MODES): `manual` sends each request Claude Code makes
 * to the card, `auto` runs in Claude Code's auto mode and sends the calls it refuses there, `bypass` grants every
 * request without asking. */
export type OrientPermissions = 'manual' | 'auto' | 'bypass'

/** The agents that each run in a permission mode of their own (backend modes.AGENTS). */
export type ModeAgent = 'orient' | 'writer' | 'critic' | 'checks' | 'dev'

// ---- documents ----

export type WriteupTag = 'crucial' | 'judgment' | 'unverified' | 'fact' | 'caveat'

export interface WriteupRevision {
  text: string
  ts?: string
  by?: 'analyst' | 'rewrite' | string
  comment?: string
  instruction?: string
}

export interface HealChange {
  value: string
  ref: string
  state: 'linked' | 'quiet' | 'contradicted' | string
  how?: string
  to?: string
  tier?: number
  derivation?: string
  source?: string
  was?: string
  corrected?: boolean
  why?: string
}

export interface WriteupSentence {
  id: string
  text: string
  refs: string[]
  tags: WriteupTag[]
  tag_notes?: Partial<Record<WriteupTag, string>>
  history?: (WriteupRevision | string)[]
  edited_by?: 'analyst'
  healed?: HealChange[]
  bullet?: '-' | '1.' | null
  /** a frame's bullet the analyst put there */
  pinned?: boolean
  by?: string
  rewritten_at?: string
  /** a slide's quote of a record, and who said it (backend slides.py) */
  quote?: boolean
  speaker?: string
}

export interface WriteupParagraph {
  id: string
  sentences: WriteupSentence[]
  pinned?: boolean
  by?: string
  rewritten_at?: string
  /** the analyst's lock on the paragraph (a list is one paragraph): no model may change it */
  locked?: boolean
  /** a story's block of a kind other than text or a list; a divider has no sentences */
  kind?: StoryBlockKind
  /** a story quote's speaker */
  speaker?: string
}

export interface WriteupFigure {
  id: string
  cell: string | null
  caption: string
  after_paragraph?: string | null
  make?: string
  kind?: 'timeline' | 'comparison' | 'distribution' | 'trend' | null
  status?: 'pending' | 'made' | 'fell_back' | string
  note?: string
  pinned?: boolean
  /** the analyst's lock on the figure */
  locked?: boolean
  /** a story's step on its figure (backend story.step_of): the rows, events or nodes its beat highlights, or a number
   * or phrase it calls out over the figure */
  highlight?: string[]
  callout?: string
  /** in a story, the section's card (`main`) or a picture of a card among the blocks (`image`); a card among the
   * blocks has none */
  role?: 'main' | 'image'
}

export interface WriteupSection {
  id: string
  heading: string
  /** 3 or deeper for a subheading; absent for a heading */
  level?: number
  paragraphs: WriteupParagraph[]
  figures?: WriteupFigure[]
  /** the analyst's lock on the section's heading (the section's own block), not on the blocks under it */
  locked?: boolean
  /** a frame unit pinned into a written document (report_types._pinned), and who pinned it */
  pinned?: boolean
  by?: string
  history?: (WriteupRevision | string)[]
  edited_by?: 'analyst'
  rewriting?: boolean
  /** in a story, where the section's card stands (right when unset) */
  card?: StoryCardSide
}

export interface WriteupReply {
  text: string
  proposal: string | null
  ts: string
  model_used?: string | null
}

export type WriteupCommentStatus = 'open' | 'incorporated' | 'dismissed'

export interface WriteupComment {
  id: string
  sentence_id: string
  /** a check's comment on a whole paragraph, kept on its first sentence (backend checks.tool_add_comment) */
  paragraph?: boolean | null
  text: string
  /** `check` for a report check's comment (add_comment in a check's session), `claude` for main's note (add_comment
   * from main, backend comments.py), the analyst's or the terminal's else */
  author: 'analyst' | 'check' | 'claude' | 'terminal' | string
  ts: string
  reply: WriteupReply | null
  status: WriteupCommentStatus
  tag?: string | null
  quote?: string | null
  /** the check whose run left it, and that run (a check's comment only) */
  check?: string | null
  run?: string | null
  evidence?: string | null
  generation?: number | null
  section?: string | null
  proposal?: string | null
}

/** A written document, or (`frame: true`) the frame of pinned figures and bullets before any write. */
export interface Writeup {
  id?: string
  title: string
  generated_at?: string
  model?: string
  sections: WriteupSection[]
  comments?: WriteupComment[]
  generation?: number
  source?: string | null
  what_changed?: string[]
  frame?: boolean
  partial?: boolean
  sections_done?: number
  sections_total?: number
  /** the analyst's lock on the title */
  title_locked?: boolean
  /** the locked blocks a model's save changed and the server put back, this generation's (report_types.hold_locks) */
  lock_reverts?: LockRevert[]
}

/** One generation of a document in its history (backend versions.history), newest first. */
export interface DocVersion {
  n: number
  /** when it was written (ISO); empty when its record is gone */
  ts: string
  /** who saved it: `first` for the first generation, the save's author (`terminal`, `analyst`, `chat:<id>`) otherwise */
  source: string
  /** what the analyst asked for, when the write was asked for with words */
  instructions: string | null
  /** what changed from the generation before: the writer's closing "What changed" lines, else a section-level diff */
  summary: string[]
  summary_from: 'writer' | 'diff' | null
  run: string | null
  current: boolean
  /** whether its text is kept, so it can be opened */
  available: boolean
  words: number | null
  /** the writer's chat it was saved in, if any */
  writer: string | null
  /** the earlier saves of the writer run that wrote it, oldest first (its last save is the generation itself); or, where
     * the workspace has no per-run saves, the older generations one writer's chat saved, each with its `generation` */
  revisions: DocRevision[]
}

export interface DocRevision {
  /** from 1, oldest first: `GET …/versions/{n}/revisions/{i}` */
  i: number
  ts: string
  words: number | null
  available: boolean
  generation: number | null
}

export interface DocHistory {
  slug: string
  generation: number
  versions: DocVersion[]
}

/** A locked block a model's save changed, deleted, split or moved, which the server put back as the analyst left it. */
export interface LockRevert {
  /** the block's ref: `report:<slug>#p<id>` for a paragraph, `#<id>` for a heading or a figure, `#title` */
  ref: string
  /** the block's text as it stands (cut), for the note's tooltip */
  text: string
  generation: number
  tool: 'write_document' | 'edit_document'
  by?: string
  ts?: string
}

export type DocumentType = 'report' | 'story' | 'slides' | string

/** How a check's run on one document went (backend checks.py). */
export type CheckRunStatus = 'running' | 'done' | 'failed' | 'stopped'

/** One run of a check on one document: its session's chat, the passages it covered and the fingerprints it has seen
 * (the cache: a passage whose fingerprint is seen is not checked again), how many comments it left, its last line. */
export interface CheckRun {
  run: string
  status: CheckRunStatus | string
  chat: string
  started: string
  ended?: string | null
  covered: string[]
  seen: string[]
  comments: number
  summary: string
  /** `writer` while the run is queued until the document's writer ends (backend checks.py, while a writer runs) */
  waiting?: string | null
}

/** A report check (`GET /ws/{c}/checks`): a prompt a session reads a written document against, commenting on its
 * passages. `colour` is an index into the label palette (1..12); `shown` is whether its comments show, kept on the
 * server so main can turn on a check it made; `runs` is the latest run per document slug. */
export interface Check {
  id: string
  name: string
  prompt: string
  colour: number
  shown: boolean
  builtin: boolean
  created_by: string
  ts: string
  version: number
  runs: Record<string, CheckRun>
}

/** `PATCH /ws/{c}/checks/{id}`: what the sidebar changes. */
export interface CheckPatch {
  shown?: boolean
  name?: string
  prompt?: string
  colour?: number
}

/** `GET /ws/{c}/card-checks` (backend card_check.status_route): whether the card check runs, whether it starts by
 * itself on a new card (`auto`, the canvas's switch), and the checks running now, each with its phase. */
export interface CardCheckStatus {
  enabled: boolean
  auto: boolean
  render: boolean
  /** why no card can be drawn here (no Chromium, the harness off); empty while the harness runs or starts */
  render_why: string
  concurrency: number
  running: { card: string; author: string; check: string; effort: string; phase: string; for_s: number }[]
  timings: Record<string, unknown>[]
}


// ---- tickets ----

/** backend dev.STATUSES */
export type TicketStatus =
  | 'queued'
  | 'running'
  | 'applied'
  | 'applied, restart pending'
  | 'failed'
  | 'needs manual merge'
  | 'reverted'
  | 'rolled back'
  | 'stopped'
  | 'dismissed'
  | (string & {})

export interface Ticket {
  id: string
  n: number
  workspace: string
  title: string
  body: string
  target?: unknown
  status: TicketStatus
  chat?: string | null
  ts?: string
  error?: string | null
}

export interface NewTicketBody {
  workspace: string
  title: string
  body: string
  target?: unknown
}

// ---- settings ----

/** Every role that runs a model, as the settings popover lists them (backend config.MODEL_ROLES, with main first, whose
 * model, effort and fast mode are its session's and the composer chip's). */
export const ROLES = ['main', 'orient', 'subagents', 'critic', 'writer', 'checks', 'verify', 'labels', 'dev'] as const
export type Role = (typeof ROLES)[number]
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]

export interface ModelConf {
  model: string
  effort: Effort | string
  fast: boolean
  /** the role whose model this one takes while the analyst has picked none (the orientation's subagents: `orient`) */
  follows?: string
}

/** `GET /ws/{c}/settings` layers the effective `models` and permission modes in from thimble's config; a PUT merges
 * what it is given. */
export interface Settings {
  models: Record<string, ModelConf>
  /** the agents whose permission mode the analyst set; any other runs in the mode of their Claude Code session */
  permission_modes?: Partial<Record<ModeAgent, OrientPermissions>>
  /** the modes the analyst's Claude Code settings turn off */
  disabled_modes?: OrientPermissions[]
  /** why thimble's config cannot be used, '' when it can (backend userconf.problem) */
  config_error?: string
  /** who runs each agent thimble starts and what it may do, by its permission-mode row (backend ledger.agent_rows) */
  agents?: Partial<Record<ModeAgent | CallAgent, AgentRow>> & { main?: { additions: string[] } }
  /** who runs each of thimble's seven tasks (backend ledger.task_rows) */
  tasks?: TaskRow[]
  [k: string]: unknown
}

/** One of thimble's tasks in the settings (backend tasks.public): thimble's own or an extension's prompt, Agent SDK
 * program or command, the extensions adding to its prompt, and those that all replace it. */
export interface TaskRow {
  task: string
  way: AgentRow['way']
  extension: string
  additions: string[]
  conflict: string[]
}

/** The agents of thimble's config that are one model call each, unless an extension's program runs their tasks (backend
 * userconf.CALLS). */
export type CallAgent = 'labels' | 'cardCheck'

/** One agent's row in the settings (backend ledger.agent_rows): thimble's own agent or an extension's (its prompt in
 * place of thimble's, an Agent SDK program or a command), the extensions adding to its prompt, two that both replace
 * it, and its consent settings from thimble's config. */
export interface AgentRow {
  way: 'thimble' | 'prompt' | 'sdk' | 'command'
  /** labels and cardCheck only: the tasks whose programs run under its settings (backend tasks.TASKS) */
  tasks?: string[]
  extension: string
  additions: string[]
  conflict: string[]
  sandbox: 'on' | 'off'
  sandbox_runs: boolean
  network: 'on' | 'off'
  web: 'ask' | 'off' | 'allow'
  data: 'ask' | 'allow' | 'off'
  config: string
}

/** `PUT /ws/{c}/settings`: `models` merges per role and within a role, so a role's patch names only what changes;
 * `permission_modes` merges per agent, null putting an agent back on the session's mode. */
export interface SettingsPatch {
  models?: Record<string, Partial<ModelConf>>
  permission_modes?: Partial<Record<ModeAgent, OrientPermissions | null>>
  [k: string]: unknown
}

/** One view an extension gives, as this workspace finds it (backend extensions.public): whether it shows here, the
 * check's reason, where its switch stands (switched here, else as the check says), and whether that switch can change
 * anything (`locked`: the extension does not run here, or no file here matches the view's claims). */
export interface ExtensionViewRow {
  slug: string
  name: string
  shown: boolean
  note: string
  on: boolean
  locked: boolean
}

/** One extension added to thimble, as this workspace finds it (backend extensions.public): whether it runs here and
 * why not, this workspace's switch, whether it cannot run here whatever that switch says (`locked`), what it gives,
 * the settings it runs under, its orientation instructions and the offer to run them, and its views. */
export interface ExtensionRow {
  name: string
  version: string
  /** what it is, from its extension.json */
  description?: string
  /** one thimble ships, whose version is thimble's */
  builtin?: boolean
  active: boolean
  why: string
  /** the line Settings shows: why it does not run, unless this workspace's switch turned it off */
  note: string
  on: boolean
  locked: boolean
  views: ExtensionViewRow[]
  /** what it gives, each in a few words */
  parts?: string[]
  /** the settings of the agents it changes or adds, in words */
  consent?: string
  /** whether its code runs in a sandbox; null for one with no code */
  sandboxed?: boolean | null
  /** whether Run now can run its orientation here once it is on: its instructions, or its own orientation program */
  orients?: boolean
  /** whether Settings offers to run its orientation now: it came on after an orientation ran here */
  offer?: boolean
  /** an extension thimble ships that is not added: turning its switch on adds it */
  addable?: boolean
  /** for one not added: the extensions thimble ships that adding it adds with it */
  needs?: string[]
}

/** One view built for this workspace, in its local extension (backend views.local_extension). */
export interface LocalViewRow {
  slug: string
  name: string
  /** what it shows, from its view.json */
  description?: string
  /** a file viewer, which opens in the File browser */
  file_viewer: boolean
  /** its switch in Settings: off, it leaves the views bar and the File browser */
  on: boolean
}

/** The workspace's local extension: the views built for this workspace, which no other workspace shows. */
export interface LocalExtension {
  name: string
  views: LocalViewRow[]
}

/** `GET /ws/{c}/extensions`: the extensions added, the conflicts among those that run here, in words, whether an
 * orientation ran here, and the workspace's local extension. */
export interface Extensions {
  extensions: ExtensionRow[]
  conflicts: string[]
  orientation_ran?: boolean
  local?: LocalExtension | null
}

// ---- the corpus (backend corpus.py) ----

export interface Manifest {
  name?: string
  run_id?: string
  [k: string]: unknown
}

export interface CorpusInfo {
  name: string
  manifest: Manifest
  /** the folder the corpus was opened from */
  path?: string
  /** the same folder as the analyst named it, through a symlink, which the dashboard shows in place of `path` */
  shown?: string
}

export type SourceKind = 'agent' | 'board' | 'events' | 'forge' | 'prompt' | 'text' | 'dir'

export interface SourceInfo {
  path: string
  kind: SourceKind
  size_bytes: number
  title: string
  hidden?: boolean
}

export interface Block {
  kind: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'event' | 'raw'
  text: string
}

export interface SourceRecord {
  line: number
  record: any
  blocks: Block[]
  meta: Record<string, any>
}

/** The server's sniff of a file that reads as a transcript (backend transcripts.sniff): its format, how sure it is
 * (0.95 makes Transcript the first mode, 0.5 only offers it), and where a message keeps who speaks, the words and the
 * time (dotted keys into a record, or a CSV's columns); for whole conversations, `keys.list` is the key of their list of
 * messages and `pair` the keys of a prompt and its response. `lines`: JSON lines in a file the server pages as text. */
export interface TranscriptHint {
  format: 'stream' | 'messages' | 'conversations' | 'json' | 'csv' | 'text'
  score: number
  /** where a message keeps who speaks, its words and its time: dotted keys into a record (`message.author`), and for
   * who speaks, alternatives the first of which a record holds counts (`speakerName|agentName`) */
  keys?: { speaker: string; text: string; time?: string; list?: string }
  pair?: [string, string]
  lines?: boolean
  /** a stream whose records each nest a Claude Code stream record under this key */
  wrap?: string
  style?: string
  /** who may start a turn in a text chat log, when the style alone would take any heading or `Word:` line */
  speakers?: string[]
  delimiter?: string
}

/** A text chat log's line that starts a turn (`meta.turn`): who speaks, when, and the UTF-16 offset of the words. */
export interface ChatTurn {
  speaker: string
  time?: string
  at: number
}

/** One turn of a whole-file JSON transcript (`GET /corpora/{c}/source/turns`), with the line it stands on. */
export interface SourceTurn {
  i: number
  line: number
  speaker: string
  role: 'user' | 'assistant' | 'system' | 'tool' | 'other'
  text: string
  time?: string
  group?: number
  /** the turn's whole length when its text was cut */
  cut?: number
}

export interface SourceTurns {
  path: string
  total: number
  start: number
  turns: SourceTurn[]
  /** the conversations the page's turns belong to, by index, each with its title and first turn */
  groups: Record<string, { title: string; first: number }>
  /** how many conversations the file holds */
  n_groups: number
  /** the turn holding the words a cited span quotes, and those words as its text holds them */
  cited?: { i: number; quote: string }
}

export interface SourcePage {
  path: string
  kind: SourceKind
  total_lines: number
  /** `total_lines` is an estimate: the file is big and its line index is still being built (GET /source/lines) */
  total_estimated?: boolean
  start: number
  records: SourceRecord[]
  /** the file reads as a transcript */
  transcript?: TranscriptHint
  /** the file is binary, judged from its first bytes: no records, and its size */
  binary?: boolean
  size_bytes?: number
}

/** `GET /corpora/{c}/source/lines`: a file's line count; while a big file's line index is being built, an estimate and
 * the share of the file indexed so far. */
export interface SourceLines {
  path: string
  total_lines: number
  estimated: boolean
  indexed: number
}

/** `GET /corpora/{c}/source/find`: the lines of a file that hold the text, the first 5,000 of them listed; `complete`
 * is false when the search stopped at its time limit, after line `scanned`. */
export interface SourceFind {
  path: string
  q: string
  lines: number[]
  /** how many times each listed line matches */
  counts?: number[]
  /** how many lines matched */
  total: number
  /** how many times they matched in all */
  matches?: number
  complete: boolean
  scanned: number
  total_lines: number
  binary?: boolean
}

/** `GET /corpora/{c}/sources/find`: the files the name search found, best first, and how many matched. */
export interface FileFind {
  q: string
  files: SourceInfo[]
  total: number
}

/** One line of `GET /corpora/{c}/sources/grep` for a file that holds the words: its count and its first lines, each the
 * part of the line around its match with the match's place in it (backend corpus.grep_files). */
export interface GrepFile {
  path: string
  total: number
  /** false when the search stopped inside this file, so its count is a floor */
  complete: boolean
  matches: { line: number; text: string; hit: [number, number] }[]
}

/** A line of that stream while it reads: how many of the files it has read. */
export interface GrepProgress {
  progress: true
  scanned: number
  of: number
}

/** The closing line of that stream: how many files matched and how many lines, and how far the search read. */
export interface GrepDone {
  done: true
  files: number
  hits: number
  scanned: number
  of: number
  complete: boolean
}

export interface ResolvedRef {
  ref: string
  kind: 'record' | 'range' | 'block' | 'span' | 'row' | 'table' | 'cell' | string
  path?: string
  line?: number
  record?: any
  blocks?: Block[]
  excerpt: string
  meta?: Record<string, any>
  /** a view ref: the short label its reader gives, and the file refs it stands for */
  label?: string
  refs?: string[]
  /** a file ref a view resolved: that view, and the reader's label for the place */
  view?: { slug: string; name: string; label: string; key?: string | null }
}

// --- the canvas's layout ---

/** A point on the canvas plane, in plane pixels at 1x. */
export interface Pos {
  x: number
  y: number
}

/**
 * Where a group's frame sits (`canvas/layout.ts`): `pos` on the board for a root, inside its parent's frame for a nested
 * group; null for the default placement, in the parent's flow after `order` of the parent's cards (null: after all).
 */
export interface Group {
  pos?: Pos | null
  order?: number | null
}

/**
 * A card's place and size on the board: `pos` inside its group's frame (on the board for a loose card), null for its
 * place in the group's flow; `width` 220 to 1200 and `height` 100 up, null for defaults; `starred` by the analyst.
 */
export interface Cell {
  width?: number | null
  height?: number | null
  pos?: Pos | null
  starred?: boolean
  /** the corpus files the last run read, and how many more it read than are listed */
  reads?: string[]
  reads_more?: number
  /** who changed its code, payload or question, and when */
  edited?: { by: string; ts: string }[]
}

export interface CellPatch {
  width?: number
  height?: number
  starred?: boolean
  pos?: Pos | null
}

/** `PUT /ws/{c}/notebooks/{nb}`: the fields a group takes. */
export interface GroupPatch {
  title?: string
  parent?: string | null
  kind?: GroupKind
  pos?: Pos | null
  order?: number | null
}

/** `POST /ws/{c}/cells/move`: the cards in order into `group` (null for the loose group), `after` a card of it (null
 * first, left out last), or one card free at `pos`. */
export interface CellMoveBody {
  cells: string[]
  group: string | null
  after?: string | null
  pos?: Pos | null
}

// --- the report editor ---

/** One block of the report editor's save (`PUT …/types/{slug}/blocks`): `id` is the unit's id, or the editor's for a new block. */
export interface ReportBlock {
  id: string
  type: 'heading' | 'paragraph' | 'bullet' | 'figure'
  /** the heading, the paragraph's sentences joined, or the bullet item, with `[[…]]` citations */
  text?: string
  level?: number
  /** a figure's `card:<id>` (or legacy `cell:<id>`), '' before one is picked */
  cell?: string
  caption?: string
  /** a bullet's list marker: `-` (default) or `1.` */
  marker?: '-' | '1.'
  children?: ReportBlock[]
}

export interface ReportBlocksBody {
  title: string
  blocks: ReportBlock[]
  /** the saving tab's token, echoed in the `report edited` event */
  client?: string
}

/** A figure placed before every paragraph of its section (the reconciler's `lead`). */
export interface WriteupFigure {
  lead?: boolean
}

// ---- label cards: the details drawer (canvas/LabelDetails.tsx) ----

/** One kept run summary on a concept (`applications[]`, `last_run`). */
export interface ConceptApplication {
  ts: string
  paths: string[]
  total: number | null
  matched_total?: number | null
  labeled: number
  failed: number
  status: 'done' | 'error' | string
  message?: string | null
  created_by?: string
  version?: number
  /** the few-shot examples the run carried (prompt kind, `examples: true`) */
  examples?: number
  /** the units the run gave the first value (may be absent) */
  matches?: number
}

/** The live run record GET /concepts/{id} carries as `run` while and after an apply on this server. */
export interface ConceptRun {
  run_id?: string | null
  status: 'running' | 'done' | 'error' | string
  done?: number
  total?: number | null
  labeled?: number
  failed?: number
  message?: string | null
  examples?: number
  /** when the run began, the `ts` of the application it records */
  started?: string | null
  /** the units given the first value so far */
  matches?: number
  /** the files the run covers and the ones indexed so far, while `total` is not known yet */
  files_total?: number | null
  files_indexed?: number
  [k: string]: unknown
}

/** GET /concepts/{id}: the concept card with its kept runs, calibration and the live run. */
export interface ConceptDetail extends Concept {
  n_reviewed?: number
  est_precision?: number | null
  calibration?: { n: number; agreed: number; disagreed: number; est_precision: Record<string, number | null> }
  applications?: ConceptApplication[]
  last_run?: ConceptApplication | null
  run?: ConceptRun | null
}

/** GET /concepts/{id}/coverage?offset=: how many corpus files the label's rows cover, with a page of each group (file
 * units; a cell or span unit has none). */
export interface CoverageFile {
  path: string
  covered: boolean
  rows: number
}
export interface ConceptCoverage {
  unit: ConceptUnit | string
  /** the files the Files tree lists */
  n_files: number
  /** the files the label has rows on, and its rows over them */
  n_covered: number
  rows: number
  /** the first covered files, by path */
  files: CoverageFile[]
  /** a page of the files with no rows, by path, from `offset` */
  not_covered: string[]
  n_not_covered: number
  offset: number
}

/** POST /concepts/{id}/apply */
export interface ApplyBody {
  paths?: string[]
  limit?: number | null
  comment?: boolean
  /** prompt kind: carry the analyst's verdicts as few-shot examples */
  examples?: boolean
  wait?: boolean
}

/** POST /concepts/{id}/labels: the analyst's verdict on one unit. */
export interface VerdictResult {
  row: LabelRow
  calibration: { n: number; agreed: number; disagreed: number; est_precision: Record<string, number | null> }
}

// --- documents: the Report tab's switcher, the story, the deck and the page (report/) ---

/** One type's entry in `GET …/investigations/main/types`: whether its document exists and what it is. */
export interface TypeState {
  exists: boolean
  renderer: 'document' | 'slides' | 'story' | 'custom' | string
  /** the type's name, as the switcher shows it */
  name: string
  /** a custom type that is a page (one html document) */
  page?: boolean
  frame?: boolean
  generation?: number | null
  generated_at?: string | null
  title?: string | null
  open_comments?: number
  status?: 'generating' | string
}

export type TypesState = Record<string, TypeState>

/** Where a story section's card stands (backend story.SIDES): at the right, at the left, across the page under the
 * section's text, or not shown. */
export type StoryCardSide = 'right' | 'left' | 'full' | 'none'
/** A story paragraph's kind (backend story.BLOCK_KINDS); a paragraph without one is text, or a list when its sentences
 * carry a bullet. */
export type StoryBlockKind = 'headline' | 'quote' | 'callout' | 'divider'

/** A story (backend story.py): sections of blocks beside their card, each a section in the report's shape whose
 * `card` says where its card stands, its paragraphs the text blocks and its figures the section's card (role `main`)
 * and the cards among the blocks. The frame before a write has the same shape. */
export interface StoryDoc {
  id?: string
  type?: string
  renderer: 'story'
  title: string
  sections: WriteupSection[]
  comments?: WriteupComment[]
  generation?: number
  generated_at?: string
  model?: string
  frame?: boolean
  title_locked?: boolean
  lock_reverts?: LockRevert[]
}

/** `PUT …/types/{slug}/story`: the story editor's whole story (backend story.apply_story). A block's `text` is its
 * sentences as typed, a bullets block one item per line. */
export interface StoryBody {
  title: string
  client?: string
  sections: {
    id: string
    heading: string
    card: StoryCardSide
    main: { id: string; cell: string; caption: string } | null
    blocks: { id: string; type: string; text?: string; speaker?: string; cell?: string; caption?: string }[]
  }[]
}

/** A deck's slide: a heading, its layout, its lines as sentences (a quote marked `quote`), up to four figures (or a
 * single `figure`), its format (figure side and share, card slots, a grid), speaker notes. */
export interface DeckSlide {
  id: string
  heading: string
  layout?: 'title' | 'text' | 'figure' | 'card' | 'figures' | 'quote' | string
  sentences: WriteupSentence[]
  figure?: { id: string; cell: string; caption: string } | null
  figures?: { id: string; cell: string; caption: string; pinned?: boolean }[]
  format?: { side?: 'left' | 'right'; width?: number; slots?: number; grid?: boolean }
  notes?: string
  pinned?: boolean
}

export interface DeckDoc {
  id?: string
  type?: string
  renderer: 'slides'
  title: string
  slides: DeckSlide[]
  comments?: WriteupComment[]
  generation?: number
  generated_at?: string
  model?: string
  /** a deck not written yet: its frame (GET …/frame), which the deck's editor lays out */
  frame?: boolean
}

/** `PUT …/types/{slug}/deck`: the deck editor's whole deck (backend report_types.apply_deck). */
export interface DeckBody {
  title: string
  client?: string
  slides: {
    id: string
    heading: string
    layout: string
    format: { side?: 'left' | 'right'; width?: number; slots?: number; grid?: boolean } | null
    lines: { id: string; text: string }[]
    bullets: boolean
    quote: { id: string; text: string; speaker: string } | null
    figures: { id: string; cell: string; caption: string }[]
    notes: string
  }[]
}

/** A page: one html document and the claims it makes as sentences. */
export interface PageDoc {
  id?: string
  type?: string
  renderer: 'custom'
  title: string
  html?: string
  html_edited_by?: string
  html_edited_at?: string
  claims?: WriteupSentence[]
  comments?: WriteupComment[]
  generation?: number
  generated_at?: string
  model?: string
}

/** A video's line (backend video.py): what the voice says, one or two cited sentences, and the seconds of silence
 * after it. */
export interface VideoLine {
  id: string
  sentences: WriteupSentence[]
  pause_after?: number
}

/** When each line starts and ends in the film, in seconds, the lines in script order (backend video.timing). */
export interface VideoTiming {
  duration: number
  lines: { id: string; start: number; end: number }[]
}

/** A video: its narration as lines and its film, one html page drawn at 1280×720 from `window.seek(t)`. */
export interface VideoDoc {
  id?: string
  type?: string
  renderer: 'video'
  title: string
  lines: VideoLine[]
  film?: string
  timing?: VideoTiming
  comments?: WriteupComment[]
  generation?: number
  generated_at?: string
  model?: string
}

/** Any stored document the Report tab shows. */
export type AnyDoc = Writeup | StoryDoc | DeckDoc | PageDoc | VideoDoc

/** A preset + New offers (`GET /report-types/presets`, backend prompts/types/<id>.md). */
export interface DocPreset {
  id: string
  name: string
  description: string
  renderer: string
}

/** `POST /report-types/new`: a preset's document by its id, a page (`page`), or one of the analyst's own
 * (`document`) from a name and a brief; the server numbers a name a type has already. */
export interface NewDocBody {
  kind: string
  name?: string
  brief?: string
}

export interface ReportType {
  slug: string
  name: string
  description: string
  renderer: string
  builtin: boolean
  page?: boolean
  /** the preset the type was made from */
  preset?: string
}

/** A row of `GET /concepts/{id}/rows?text=1`: the unit's own words travel with it, or for a row with spans the words
 * around the first span, which is `match` (the words that earned the unit its value). */
export interface LabelRowText extends LabelRow {
  text?: string
  match?: string
}

// ---- the chat: the mirror of the analyst's session ----

/** The Claude Code session mirrored as main while `/thimble` has it attached. */
export interface Attached {
  session: string
  cwd: string
  since: string
  /** the model the session's replies came from, as the mirror last read it */
  model?: string
  /** the effort they ran at, as the mirror last read it */
  effort?: string
  /** what the composer's chip chose for main's next launch, while this session runs */
  effort_choice?: MainEffort
  /** the effort the analyst's own Claude Code settings choose (cc_settings.analyst_effort), where main's effort menu opens */
  settings_effort?: MainEffort
  /** whether the session's last reply ran in fast mode, as the mirror read it */
  fast?: boolean
  /** the permission mode Claude Code last reported to the session's hooks (default, acceptEdits, auto, plan,
   * bypassPermissions, dontAsk), which each agent's permission mode follows until the analyst sets it (backend modes.py) */
  permission_mode?: string
  /** what the composer's fast-mode switch chose for main's next launch, while this session runs */
  fast_choice?: boolean
  /** the session that was main until this one took its place while it runs on in another terminal */
  after?: string
}
/** Main's last session once none is attached: the folder it ran in is where `thimble --continue` resumes it. */
export interface SessionEnded {
  session: string
  cwd: string
  at: string
}
export interface ChatMeta {
  /** a thread: the fork of main that answers it, once main forked it (backend threads.fork_started); `ended` once it
   * cannot be reached, and the next question forks anew */
  fork?: { agent_id?: string | null; ended?: string | null } | null
  /** main only: the Claude Code session that is main, null or absent when none is attached */
  attached?: Attached | null
  /** main only: the session that was main last, while none is attached */
  ended?: SessionEnded | null
  /** main only: the orientation's status from orient/run.json (requested, running, done, failed or stopped), null
   * before any orientation was asked for */
  orientation?: string | null
  /** a dev ticket's agent chat: the ticket it runs (dev.py) */
  ticket?: string | null
  /** a view ticket's agent chat: the slug of the proposal it builds (dev.run_view) */
  view?: string | null
  /** a view ticket's agent chat: the analyst asked for the view, so it is their dev thread; the orientation's builds
   * are not listed (dev._view_chat, chat/threads.ts) */
  asked?: boolean | null
  /** main, the orientation or a writer: a dialog holds the session where the browser cannot answer it */
  alert?: SessionAlert | null
  /** main, the orientation or a writer: permission requests waiting for Allow or Deny */
  permissions?: PermissionRequest[]
  /** a session thimble started: what the analyst's "don't ask again" answers added for the rest of it, each in Claude
   * Code's words (backend agent_session, don't ask again) */
  session_rules?: { text: string }[]
  /** a session thimble started: the permission mode it runs in now, which its card's switcher shows and changes
   * (agent_session, permissions) */
  permission_mode?: OrientPermissions
  /** the mode a switch into or out of Auto goes to, while the session waits for a pause to restart in it */
  mode_switch?: OrientPermissions | null
  /** a session thimble started: its agent's row of the permission modes (backend modes.AGENTS) */
  mode_agent?: ModeAgent
  /** the agent a session or a program runs as: an extension's program's is `<extension>:<role or task>` (backend
   * harness.start) */
  agent_type?: string | null
  /** the orientation's session: whether it runs with Ultracode, and its critique */
  ultracode?: boolean
  critique?: boolean
  /** a writer's session: the document it writes (write_session.py) */
  doc?: string | null
  /** a session thimble started beside main: what it was asked, for its card, when its first message is longer (a
   * writer's task) */
  brief?: string | null
  /** the orientation: the messages sent while a run of it went on, which go together when it ends (backend
   * orientation.message) */
  queued?: QueuedMessage[]
  /** the orientation: each follow-up, its run's number, state and times, and once it ends what it changed, counted from
   * its undo steps (backend orientation.run_finished) */
  followups?: FollowUpRecord[]
  /** a session thimble started: the run the next server resumed after the server stopped or died under it, and when;
   * null once a later run starts (backend agent_session, restart) */
  restarted?: { run: number; ts?: string } | null
  /** a session thimble started: its run's number, 0 for its start, then one per resume */
  run?: number
  /** the orientation, in a workspace `thimble demo` installed from a pre-cache: it ran in advance, and its session was
   * kept only from a full export (backend precached.py, demo.install) */
  precached?: PrecachedMark | null
}

/** What `thimble demo` installed a workspace from (backend demo.install): the dataset, when its orientation ran and on
 * what model, the folder of the files it ran on, the orientation's chat, and whether its session came with it. */
export interface PrecachedMark {
  dataset?: string | null
  created?: string | null
  /** when the orientation ended (or started) */
  ran?: string | null
  installed?: string | null
  folder?: string | null
  orientation?: string | null
  model?: string | null
  /** `full` for a full export, `outputs-only` for the outputs alone (what demos/ holds) */
  format?: string | null
  /** whether the orientation's Claude Code session came with it, so a message in its thread continues it */
  kept?: boolean | null
}

/** A follow-up of the orientation as its chat's meta keeps it. */
export interface FollowUpRecord {
  run: number
  status?: string
  started?: string | null
  ended?: string | null
  messages?: { text: string; by?: string }[]
  added?: number
  revised?: number
  deleted?: number
  views?: number
}

/** A message to the orientation waiting for its run to end: from the analyst in its thread (`browser`) or from main. */
export interface QueuedMessage {
  text: string
  by?: string
  ts?: string
}
/** Where the analyst's line was typed: the terminal of the Claude Code session, or the browser's composer. */
export type RecordBy = 'terminal' | 'browser'

// ---- scale: the tree fetches one folder at a time; the rows route pages by cursor ----

/** A subfolder in `GET /corpora/{c}/sources?path=&depth=1`: the files under it at any depth and its direct subfolders
 * (where the server knows them already), the tree's run mark. */
export interface FolderEntry {
  path: string
  name: string
  n_files?: number
  n_folders?: number
  is_run: boolean
  hidden?: boolean
}

/** One folder's own entries (`path` '' is the corpus root): its files as SourceInfo and its subfolders, and the files
 * under it at any depth where the server knows them already. */
export interface FolderListing {
  path: string
  files: SourceInfo[]
  folders: FolderEntry[]
  n_files?: number
  /** the folder's modification time when it was read, which `GET /sources/stamps` compares (backend folder_stamp) */
  stamp?: string
}

/** `GET /concepts/{id}/rows` with `next`, the rowid cursor for the page after this one (null at the end). */
export interface LabelRowsPage extends LabelRowsResponse {
  next: number | null
}

// ---- undo and redo (backend undo.py) ----

/** `GET /ws/{c}/undo`: what an undo would revert and a redo repeat, each a label such as `delete card runs-one-end`. */
export interface UndoLabels {
  undo: string | null
  redo: string | null
  /** `<orientation chat>/<run>` while the step an undo would revert belongs to a follow-up of the orientation, whose
   * steps one undo reverts together (backend undo.py) */
  undo_run?: string | null
  /** why a session that still runs holds the undo (a writer changed the passage since), which Undo's tooltip says */
  held?: string | null
}

// ---- the problem report (backend feedback.py) ----

/** `POST /ws/{c}/feedback`: what the Report a problem dialog sends. */
export interface ProblemReportBody {
  description: string
  /** a data URL of the tab, when the browser captured it */
  screenshot?: string | null
  /** the reporter asked for a screenshot, so the bundle says when there is none */
  screenshot_asked?: boolean
  /** the server log's tail and the workspace's chats and event stream */
  logs: boolean
  user_agent: string
  /** the tab's recent console errors and failed requests (lib/problemLog), sent with the logs */
  browser?: import('./problemLog').ProblemEntry[]
  /** the chats the failure concerns, which the bundle takes first */
  focus?: string[]
}

/** Where the bundle was written and how to send it. */
export interface ProblemReport {
  path: string
  name: string
  bytes: number
  /** the zip's size in words, such as `184 KB` */
  size: string
  files: string[]
  /** the server's machine can show the zip in its file manager (POST /feedback/reveal) */
  can_reveal: boolean
  /** a screenshot was asked for and not captured */
  screenshot_missing?: boolean
  /** the maintainer's GitHub handle, which `instructions` names for private logs, and their profile's URL */
  contact: string
  contact_url: string
  /** the sentence that says to attach the zip to an issue only if it may be public, naming `contact` */
  instructions: string
  /** the new-issue page, prefilled with the description, the versions and the doctor's summary, none of the logs */
  issue_url: string
}
