// The typed client for every route of the backend's API.
import type {
  CanvasResponse,
  Extensions,
  LocalExtension,
  Cell,
  CellName,
  CellPatch,
  ChatDetail,
  ChatMeta,
  ChatPatch,
  Concept,
  CorpusInfo,
  DocumentType,
  CardFilterParts,
  Filters,
  FilterScope,
  Group,
  LabelRowsResponse,
  LabelsForPath,
  NewCellBody,
  NewThreadBody,
  NewTicketBody,
  OrientRun,
  Proposal,
  ResolvedRef,
  Settings,
  SettingsPatch,
  FileFind,
  GrepDone,
  GrepFile,
  GrepProgress,
  SourceFind,
  SourceInfo,
  SourceLines,
  SourcePage,
  SourceTurns,
  StartAnswer,
  StoredCall,
  SubagentRequest,
  CallIndex,
  Ticket,
  View,
  ViewSuggestion,
  ViewOpen,
  ViewQuery,
  ViewProblems,
  ViewShown,
  Writeup,
} from './types'
import { heavy } from './limit'

const BASE = '/api'

/** FastAPI `detail` as one line: a string, pydantic's `{loc, msg}` list, or an object with a message. */
export function describeDetail(d: unknown): string {
  if (typeof d === 'string') return d
  if (d && typeof d === 'object' && !Array.isArray(d) && typeof (d as { message?: unknown }).message === 'string') return (d as { message: string }).message
  if (Array.isArray(d)) {
    return d.map((e) => (e && typeof e === 'object' && 'msg' in e ? `${((e as { loc?: unknown[] }).loc ?? []).join('.')}: ${(e as { msg: string }).msg}` : JSON.stringify(e))).join('; ')
  }
  try {
    return JSON.stringify(d)
  } catch {
    return String(d)
  }
}

let keyReady: Promise<void> | null = null
const CLAIM_WAITS_MS = [0, 500, 2000] // before each try of the claim while the server does not answer

/** Trade the key in the link thimble showed (`#k=`) for the cookie that proves this browser to the server (permission
 * answers and mode changes, and every write behind hook_auth.LocalWriteGuard), and take it out of the address once the
 * server has answered. Memoised: with no key in the link the cookie the browser already holds stands; a claim the server
 * never answered leaves the key in the address and is tried again by the next call. `j` awaits it, so a write never
 * races the claim. */
export function claimKey(): Promise<void> {
  if (keyReady) return keyReady
  if (typeof window === 'undefined') return (keyReady = Promise.resolve())
  const key = new URLSearchParams(window.location.hash.slice(1)).get('k')
  keyReady = key ? claim(key) : Promise.resolve()
  return keyReady
}

async function claim(key: string): Promise<void> {
  for (const wait of CLAIM_WAITS_MS) {
    if (wait) await new Promise((r) => setTimeout(r, wait))
    try {
      const res = await fetch(`${BASE}/ui/key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) })
      // 204 claimed it, 403 names a key that is not this server's: neither changes on another try
      if (res.status === 204 || res.status === 403) {
        if (new URLSearchParams(window.location.hash.slice(1)).get('k') === key) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
        return
      }
    } catch {
      /* no answer: try again */
    }
  }
  keyReady = null
}

/** A link with a key opened in a tab already on its page changes only the address's hash, and loads nothing. */
export function claimOnHashChange(): void {
  if (typeof window === 'undefined') return
  window.addEventListener('hashchange', () => {
    if (!new URLSearchParams(window.location.hash.slice(1)).get('k')) return
    keyReady = null
    void claimKey()
  })
}

/** A click start's answer as the server's subagents.Answer gives it, with its refusal's `kind` and `reason` filled in
 * from the key that carries it when the route left them out (`deny` thimble's own check, `limit` Claude Code's
 * concurrency limit, `no-module`, `error`; start-it and again answer the raw Answer). Pure. */
export function startAnswer<T extends object>(raw: T): T & StartAnswer {
  const a = { ...(raw as Record<string, unknown>) }
  if (a.agentId || a.program || a.kind) return a as T & StartAnswer
  const keys: [string, string][] = [['deny', 'hook'], ['limit', 'limit'], ['no-module', 'no-module'], ['no_module', 'no-module'], ['error', a.gone ? 'earlier-session' : 'error']]
  for (const [key, kind] of keys) {
    if (key in a) return { ...a, kind, reason: typeof a.reason === 'string' && a.reason ? a.reason : String(a[key] ?? '') } as T & StartAnswer
  }
  return a as T & StartAnswer
}

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  await claimKey()
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      detail = describeDetail(body.detail ?? body)
    } catch {
      /* the status text stands */
    }
    throw new Error(`${res.status} ${detail}`)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

const q = (params: Record<string, string | number | undefined | null>) =>
  '?' +
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')

/** A stream of JSON lines read so far cut into its whole lines and the part of a line still arriving; at the stream's
 * end (`last`) that part is a line too. Blank lines are dropped. Pure. */
export function takeLines(text: string, last = false): { lines: string[]; rest: string } {
  const parts = text.split('\n')
  const rest = last ? '' : parts.pop() ?? ''
  return { lines: parts.filter((l) => l.trim()), rest }
}

const enc = encodeURIComponent
const ws = (c: string) => `${BASE}/ws/${enc(c)}`
const inv = (c: string, slug: string) => `${ws(c)}/investigations/main/types/${enc(slug)}`

/** How a message stream ended: `ended` when the last record was the turn's `done`, `failed` on a rejected request. */
/** What `POST /ws/{c}/events` answers: the event's id and kind, how many subscriptions it reached, and its thread. */
export interface EventPosted {
  id: string
  kind: string
  delivered: number
  thread?: string
}

export const api = {
  // ---- the product tour's first-launch state, one for the install (backend tour.py) ----
  tour: () => j<{ seen: boolean }>(`${BASE}/tour`),
  tourSeen: () => j<{ seen: boolean }>(`${BASE}/tour/seen`, { method: 'POST' }),
  // ---- corpora and files ----
  corpora: () => j<CorpusInfo[]>(`${BASE}/corpora`),
  sources: (c: string) => j<SourceInfo[]>(`${BASE}/corpora/${enc(c)}/sources`),
  source: (c: string, path: string, start = 1, count = 100) => j<SourcePage>(`${BASE}/corpora/${enc(c)}/source${q({ path, start, count })}`),
  /** `clamp`: a line past the end answers with the file's last lines, not a 404 (a move made while the count is an estimate) */
  sourceAround: (c: string, path: string, line: number, before = 50, after = 50, clamp = false) =>
    j<SourcePage>(`${BASE}/corpora/${enc(c)}/source/around${q({ path, line, before, after, clamp: clamp ? 1 : undefined })}`),
  /** `GET /corpora/{c}/source/lines`: a file's line count, an estimate while a big file's line index is being built. */
  sourceLines: (c: string, path: string) => j<SourceLines>(`${BASE}/corpora/${enc(c)}/source/lines${q({ path })}`),
  /** `GET /corpora/{c}/source/turns`: `count` turns of a JSON transcript from turn `start`, or around `line`; with
   * `span`, a span of that line (block and UTF-16 offsets), around the turn holding the words it quotes. */
  sourceTurns: (c: string, path: string, start = 0, count = 200, line?: number, span?: { block: number; start: number; end: number }) =>
    j<SourceTurns>(`${BASE}/corpora/${enc(c)}/source/turns${q({ path, start, count, line, block: span?.block, char_start: span?.start, char_end: span?.end })}`),
  /** `GET /corpora/{c}/source/speakers`: the names the corpus gives speaker ids (`ids`, joined by commas) that a file
   * keeps under `key` (an agents.jsonl beside it, whose records carry an id and a name). */
  speakerNames: (c: string, path: string, key: string, ids: string) => j<{ names: Record<string, string> }>(`${BASE}/corpora/${enc(c)}/source/speakers${q({ path, key, ids })}`),
  /** The URL a PDF of the corpus opens from in the browser's viewer, at `page` when given. */
  pdfUrl: (c: string, path: string, page?: number | null) => `${BASE}/corpora/${enc(c)}/pdf/${path.split('/').map(enc).join('/')}${page ? `#page=${page}` : ''}`,
  /** `GET /corpora/{c}/source/find`: the lines of one file past `after` that hold `text`, searched on the server. */
  findInSource: (c: string, path: string, text: string, after = 0, signal?: AbortSignal) =>
    j<SourceFind>(`${BASE}/corpora/${enc(c)}/source/find${q({ path, q: text, after: after || undefined })}`, { signal }),
  /** `GET /corpora/{c}/sources/find`: the files whose path holds every word of `text`, best first. */
  findFiles: (c: string, text: string, signal?: AbortSignal) => j<FileFind>(`${BASE}/corpora/${enc(c)}/sources/find${q({ q: text })}`, { signal }),
  /** `GET /corpora/{c}/sources/grep`: the files whose text holds `text`, each handed to `onFile` as the server finds it,
   * how many files it has read to `onProgress`, then the closing line to `onDone`. `onSearch` hears the search's id,
   * which stopGrep takes, as the stream opens. Resolves when the stream ends; rejects on a refusal or an abort. */
  grepFiles: async (
    c: string,
    text: string,
    onFile: (f: GrepFile) => void,
    onDone: (d: GrepDone) => void,
    signal?: AbortSignal,
    onProgress?: (p: GrepProgress) => void,
    onSearch?: (id: number) => void,
  ): Promise<void> => {
    const res = await fetch(`${BASE}/corpora/${enc(c)}/sources/grep${q({ q: text })}`, { signal })
    if (!res.ok || !res.body) {
      let detail = res.statusText
      try {
        detail = describeDetail((await res.json()).detail)
      } catch {
        /* the status text stands */
      }
      throw new Error(`${res.status} ${detail}`)
    }
    const id = Number(res.headers.get('x-search'))
    if (Number.isInteger(id) && id > 0) onSearch?.(id)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let rest = ''
    const take = (line: string) => {
      const item = JSON.parse(line) as GrepFile | GrepDone | GrepProgress
      if ('done' in item) onDone(item)
      else if ('progress' in item) onProgress?.(item)
      else if (typeof item.path === 'string') onFile(item)
    }
    for (;;) {
      const { value, done } = await reader.read()
      const got = takeLines(rest + (value ? decoder.decode(value, { stream: !done }) : ''), done)
      got.lines.forEach(take)
      rest = got.rest
      if (done) break
    }
  },
  /** `POST /corpora/{c}/sources/grep/stop`: stop the content search `search` (grepFiles' onSearch); its stream then
   * ends with its closing line. */
  stopGrep: (c: string, search: number) =>
    j<{ stopped: boolean }>(`${BASE}/corpora/${enc(c)}/sources/grep/stop`, { method: 'POST', body: JSON.stringify({ search }) }),
  forgeTables: (c: string, path: string) => j<{ name: string; row_count: number }[]>(`${BASE}/corpora/${enc(c)}/forge/tables${q({ path })}`),
  forgeRows: (c: string, path: string, table: string, offset = 0, limit = 100, order?: string, where?: string) =>
    j<{ table: string; columns: string[]; rows: any[][]; pk: string; total: number }>(`${BASE}/corpora/${enc(c)}/forge/rows${q({ path, table, offset, limit, order, where })}`),
  forgeQuery: (c: string, path: string, sql: string) =>
    j<{ columns: string[]; rows: any[][]; truncated: boolean }>(`${BASE}/corpora/${enc(c)}/forge/query${q({ path })}`, { method: 'POST', body: JSON.stringify({ sql }) }),
  resolveRef: (c: string, ref: string) => j<ResolvedRef>(`${BASE}/corpora/${enc(c)}/ref${q({ ref })}`),
  /** `GET /corpora/{c}/csv-rows?path=&lines=a-b`: the rows of a CSV or TSV file that start on lines a..b, [line, n] each,
   * n the number a row is cited by (`<path>#row=<n>`). */
  csvRows: (c: string, path: string, a: number, b: number) => j<{ rows: [number, number][] }>(`${BASE}/corpora/${enc(c)}/csv-rows${q({ path, lines: `${a}-${b}` })}`),

  // ---- chats ----
  chats: (c: string) => j<ChatMeta[]>(`${ws(c)}/chats`),
  instance: (c: string) => j<{ stamp: string | null }>(`${ws(c)}/instance`),
  main: (c: string) => j<ChatDetail>(`${ws(c)}/chats/main`),
  chat: (c: string, id: string) => j<ChatDetail>(`${ws(c)}/chats/${enc(id)}`),
  createThread: (c: string, body: NewThreadBody) => j<ChatMeta>(`${ws(c)}/chats`, { method: 'POST', body: JSON.stringify(body) }),
  updateChat: (c: string, id: string, patch: ChatPatch) => j<ChatMeta>(`${ws(c)}/chats/${enc(id)}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteChat: (c: string, id: string) => j<{ deleted: string }>(`${ws(c)}/chats/${enc(id)}`, { method: 'DELETE' }),
  /** Stop (agents.interrupt_route): one of thimble's agents through thimble's plugin, a click (403 without the
   * analyst's cookie); `done` when it had ended already, `kind` and `reason` when thimble could not pass it on (no
   * module); a subagent of main the analyst started is asked of main. */
  interrupt: (c: string, id: string) => j<{ stopped: boolean; done?: boolean; asked?: 'main'; kind?: string; reason?: string }>(`${ws(c)}/chats/${enc(id)}/interrupt`, { method: 'POST' }),
  askAgain: (c: string, id: string) => j<{ asked: string; event: string; questions: number }>(`${ws(c)}/chats/${enc(id)}/ask-again`, { method: 'POST' }),
  /**
     * Send the analyst's Claude Code session an event (`POST /ws/{c}/events {kind, payload}`), e.g. a message typed in main
     * (`main`, {text}) or in a thread (`thread`, {thread, text}). The reply arrives through the chat's log. A 409 says no
     * session is listening.
     */
  postEvent: (c: string, kind: string, payload: Record<string, unknown>) =>
    j<EventPosted>(`${ws(c)}/events`, { method: 'POST', body: JSON.stringify({ kind, payload }) }),
  /** The composer's effort chip: main's effort (and its threads') from its next request (events.effort_route). */
  setEffort: (c: string, effort: MainEffort) => j<{ effort: string; choice: MainEffort }>(`${ws(c)}/session/effort`, { method: 'PUT', body: JSON.stringify({ effort }) }),
  /** Turn fast mode off or back on for main and its threads from main's next request (events.fast_route). */
  setFast: (c: string, fast: boolean) => j<{ fast: boolean }>(`${ws(c)}/session/fast`, { method: 'PUT', body: JSON.stringify({ fast }) }),
  /** Allow or deny a permission prompt of main's session that its hook relayed (events.permission_route). */
  answerPermission: (c: string, id: string, allow: boolean) => j<{ answered: string }>(`${ws(c)}/permission`, { method: 'POST', body: JSON.stringify({ id, allow }) }),
  /** Allow or deny a permission request of a code ticket's session (agent_session.permission_route), the one kind of
     * session thimble still runs beside main; `always` also applies Claude Code's suggested "don't ask again" rules for
     * the rest of the session, and `shown` is how many of the later calls that joined it the card listed. */
  answerSessionPermission: (c: string, chat: string, id: string, allow: boolean, always = false, shown = 0) =>
    j<{ answered: string }>(`${ws(c)}/chats/${enc(chat)}/permission`, { method: 'POST', body: JSON.stringify({ id, allow, ...(always ? { always } : {}), shown }) }),
  /** The orientation thread's composer: a click, through thimble's plugin to the orientation's agent (orient_session.
     * message_route): `sent`, or `held` while the coverage line is measured (it goes when that ends). 409 with the
     * earlier-session text (and for a pre-cache, plan mode, or a module that did not pass it on), 410 with the
     * earlier-version text; 403 without the analyst's cookie. */
  messageOrientation: (c: string, text: string) =>
    j<{ status: 'sent' | 'held' | (string & {}); chat?: string }>(`${ws(c)}/orientation/message`, { method: 'POST', body: JSON.stringify({ text }) }),
  /** Start it on a refused typed start (`POST /ws/{c}/subagents/start-it`): the same request, with the same values,
     * started through thimble's plugin as a click. */
  startIt: (c: string, request: string) => j<StartAnswer>(`${ws(c)}/subagents/start-it`, { method: 'POST', body: JSON.stringify({ request }) }).then(startAnswer),
  /** Try again, Send again and Write again (`POST /ws/{c}/subagents/again`): the request made anew as a click. */
  again: (c: string, request: string) => j<StartAnswer>(`${ws(c)}/subagents/again`, { method: 'POST', body: JSON.stringify({ request }) }).then(startAnswer),
  /** A pending request as the refused card shows it before Start it: its role, its exact call, its values, its state. */
  subagentRequest: (c: string, request: string) => j<SubagentRequest>(`${ws(c)}/subagents/requests/${enc(request)}`),
  /** The numbers of an orientation's calls by tool_use id (backend calls.py's store, built from its transcript when the
   * store has none). */
  callIndex: (c: string, chat: string) => j<CallIndex>(`${ws(c)}/calls/${enc(chat)}`),
  /** One call of an orientation's store: its tool, its input and its whole output. */
  call: (c: string, chat: string, n: number) => j<StoredCall>(`${ws(c)}/calls/${enc(chat)}/${n}`),

  // ---- the workspace stream ----
  eventsUrl: (c: string, after?: number | string | null, log?: string | null) => {
    const q = [after != null && after !== '' ? `after=${enc(String(after))}` : '', log ? `log=${enc(log)}` : ''].filter(Boolean)
    return `${ws(c)}/events${q.length ? `?${q.join('&')}` : ''}`
  },

  // ---- canvas ----
  canvas: (c: string) => j<CanvasResponse>(`${ws(c)}/canvas`),
  notebooks: (c: string) => j<Group[]>(`${ws(c)}/notebooks`),
  createGroup: (c: string, body: { title: string; parent?: string; kind?: 'sequence' | 'split'; role?: string }) => j<Group>(`${ws(c)}/notebooks`, { method: 'POST', body: JSON.stringify(body) }),
  updateGroup: (c: string, nb: string, patch: { title?: string; parent?: string | null; kind?: 'sequence' | 'split' }) => j<Group>(`${ws(c)}/notebooks/${enc(nb)}`, { method: 'PUT', body: JSON.stringify(patch) }),
  addCell: (c: string, nb: string, body: NewCellBody) => j<Cell>(`${ws(c)}/notebooks/${enc(nb)}/cells`, { method: 'POST', body: JSON.stringify(body) }),
  updateCell: (c: string, id: string, patch: CellPatch) => j<Cell>(`${ws(c)}/cells/${enc(id)}`, { method: 'PUT', body: JSON.stringify(patch) }),
  runCell: (c: string, id: string) => j<Cell>(`${ws(c)}/cells/${enc(id)}/run`, { method: 'POST' }),
  /** `POST …/cells/{id}/fixes/{fix}/undo`: restore the card from before a check's fix (backend checkstore.undo_fix); the
     * fix is marked undone and is not applied again. */
  undoCardFix: (c: string, id: string, fix: string) => j<Cell>(`${ws(c)}/cells/${enc(id)}/fixes/${enc(fix)}/undo`, { method: 'POST' }),
  /** `POST …/cells/{id}/check`: run the card's check again (Check again in its details or its ✕); 409 for a card that gets none. */
  checkCardAgain: (c: string, id: string) => j<{ card: string; check: string }>(`${ws(c)}/cells/${enc(id)}/check`, { method: 'POST' }),
  /** `POST …/cells/{id}/check/stop`: stop the card's check (Stop in its details); the card stays as it is. */
  stopCardCheck: (c: string, id: string) => j<{ card: string; stopped: boolean }>(`${ws(c)}/cells/${enc(id)}/check/stop`, { method: 'POST' }),
  /** `GET /card-checks`: whether the automatic check is on, and the checks running now with their phase. */
  cardChecks: (c: string) => j<CardCheckStatus>(`${ws(c)}/card-checks`),
  /** `POST /card-checks/stop`: stop every card check of the workspace. */
  stopCardChecks: (c: string) => j<{ stopped: string[] }>(`${ws(c)}/card-checks/stop`, { method: 'POST' }),
  /** `POST /notebooks/{nb}/run`: a runnable card made and run in one call; `created_by` defaults to the analyst. */
  runCode: (c: string, nb: string, body: { code: string; title: string; created_by?: string; kind?: 'code' | 'plot' | 'table' }) =>
    j<Cell>(`${ws(c)}/notebooks/${enc(nb)}/run`, { method: 'POST', body: JSON.stringify({ created_by: 'user', ...body }) }),
  deleteCell: (c: string, id: string) => j<{ ok: boolean }>(`${ws(c)}/cells/${enc(id)}`, { method: 'DELETE' }),
  /** `GET …/outputs/{i}/full`: the complete text of a truncated stream output, as text. */
  outputFull: async (c: string, nb: string, id: string, i: number): Promise<string> => {
    const res = await fetch(`${ws(c)}/notebooks/${enc(nb)}/cells/${enc(id)}/outputs/${i}/full`)
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    return res.text()
  },
  ipynbUrl: (c: string, nb: string) => `${ws(c)}/notebooks/${enc(nb)}/ipynb`,
  cellNames: (c: string) => j<CellName[]>(`${ws(c)}/cells/names`),

  // ---- labels and filters ----
  concepts: (c: string) => j<Concept[]>(`${ws(c)}/concepts`),
  concept: (c: string, id: string) => j<Concept>(`${ws(c)}/concepts/${enc(id)}`),
  conceptRows: (c: string, id: string, opts: { value?: string; limit?: number; offset?: number } = {}) => j<LabelRowsResponse>(`${ws(c)}/concepts/${enc(id)}/rows${q(opts)}`),
  labelsForPath: (c: string, path: string) => j<LabelsForPath[]>(`${ws(c)}/labels${q({ path })}`),
  filters: (c: string) => j<Filters>(`${ws(c)}/filters`),
  putFilter: (c: string, scope: FilterScope, concept: string, value: string) => j<Filters>(`${ws(c)}/filters`, { method: 'PUT', body: JSON.stringify({ scope, concept, value }) }),
  /** the scope's label filter; `whole` clears the canvas's card parts too */
  deleteFilter: (c: string, scope: FilterScope, whole = false) => j<Filters>(`${ws(c)}/filters/${scope}${whole ? '?whole=true' : ''}`, { method: 'DELETE' }),
  /** the canvas filter's card parts, all at once (a part left out is unset); its label part stays */
  putCardFilter: (c: string, parts: Required<CardFilterParts>) => j<Filters>(`${ws(c)}/filters/canvas/cards`, { method: 'PUT', body: JSON.stringify(parts) }),

  // ---- views and proposals ----
  proposals: (c: string) => j<Proposal[]>(`${ws(c)}/views/proposals`),
  /** what thimble proposes for a file opened in the File browser: whether a viewer may be proposed for its type, and
   * the proposal for the type when there is one (backend views.suggestion_for) */
  viewSuggestions: (c: string, path: string) => j<ViewSuggestion>(`${ws(c)}/views/suggestions${q({ path })}`),
  /** ask for a viewer for the type of a file the analyst opened: the suggested proposal's slug, or null */
  suggestView: (c: string, path: string) => j<{ slug: string | null }>(`${ws(c)}/views/suggest`, { method: 'POST', body: JSON.stringify({ path }) }),
  /** build a suggested viewer */
  acceptProposal: (c: string, slug: string) => j<Proposal>(`${ws(c)}/views/proposals/${enc(slug)}/accept`, { method: 'POST' }),
  retryProposal: (c: string, slug: string) => j<Proposal>(`${ws(c)}/views/proposals/${enc(slug)}/retry`, { method: 'POST' }),
  /** Build or Retry on a proposal's chip (`POST /ws/{c}/views/{slug}/build`): a click that starts a view builder through
   * thimble's plugin, with the run's model and effort (Settings' dev row when left out). */
  buildView: (c: string, slug: string, values: { model?: string; effort?: string } = {}) =>
    j<Proposal & StartAnswer>(`${ws(c)}/views/${enc(slug)}/build`, { method: 'POST', body: JSON.stringify(values) }).then(startAnswer),
  /** Stop the proposal's build (backend views.stop_build): it then fails, with Retry. */
  stopViewBuild: (c: string, slug: string) => j<{ ok: boolean }>(`${ws(c)}/views/proposals/${enc(slug)}/stop`, { method: 'POST' }),
  /** A message typed in a view build's thread: logged there and queued as a change to the view, whose run goes on in
   * that thread (views.message); answers the proposal. */
  messageView: (c: string, slug: string, text: string) => j<Proposal>(`${ws(c)}/views/proposals/${enc(slug)}/message`, { method: 'POST', body: JSON.stringify({ text }) }),
  deleteProposal: (c: string, slug: string) => j<{ ok: boolean }>(`${ws(c)}/views/proposals/${enc(slug)}`, { method: 'DELETE' }),
  /** every view of the workspace; with `wait`, never `files_pending` */
  views: (c: string, wait = false) => j<View[]>(`${ws(c)}/views${wait ? q({ wait: 1 }) : ''}`),
  /** the working views that claim a file, in the order a citation into it opens them */
  viewsForFile: (c: string, path: string) => j<View[]>(`${ws(c)}/views${q({ path })}`),
  deleteView: (c: string, slug: string) => j<{ ok: boolean }>(`${ws(c)}/views/${enc(slug)}`, { method: 'DELETE' }),
  /** the view's page as a sandboxed frame loads it: the policy, the bridge, the libraries and view.html, at `version`
     * when given (the calls below then answer for the same version). The page's origin is sent so the frame's media URLs
     * name the host this browser reaches. */
  viewFrame: async (c: string, slug: string, version?: string): Promise<string> => {
    const res = await fetch(`${ws(c)}/views/${enc(slug)}/frame${q({ origin: location.origin, v: version })}`)
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    return res.text()
  },
  /** reader.records(index, query), for the page's thimble.fetch, with no time limit, through the gate of slow calls
   * (lib/limit.ts heavy): `call` names it for viewCall and viewCancel, and `signal` drops the request; with a label
   * filter on, `hidden` is how many records the reader left out for it in what the frame shows (the page's fetch `key`,
   * the `frame` and its `turn`), null when that cannot be counted exactly */
  viewRecords: (c: string, slug: string, query: unknown, version?: string, opts?: { call?: string; signal?: AbortSignal; key?: string; frame?: string; turn?: number }) =>
    heavy(
      () =>
        j<{ data: unknown; hidden?: number | null }>(`${ws(c)}/views/${enc(slug)}/records${q({ v: version })}`, {
          method: 'POST',
          body: JSON.stringify({ query, call: opts?.call, key: opts?.key, frame: opts?.frame, turn: opts?.turn }),
          signal: opts?.signal,
        }),
      opts?.signal,
    ),
  /** how far the page's call has got: seconds since it started, whether the reader reads the files (`index`), waits for
   * a kernel (`wait`) or answers (`call`), and what it reported; {running: false} once it is over */
  viewCall: (c: string, slug: string, call: string) =>
    j<{ running: boolean; seconds?: number; phase?: string; done?: number; total?: number; note?: string }>(`${ws(c)}/views/${enc(slug)}/calls/${enc(call)}`),
  /** cancel the page's call: the reader's kernel is interrupted */
  viewCancel: (c: string, slug: string, call: string) => j<{ cancelled: boolean }>(`${ws(c)}/views/${enc(slug)}/calls/${enc(call)}/cancel`, { method: 'POST' }),
  /** the `open` message for a ref in the view */
  /** the marks of the labels that are on for refs a view's page shows, its units' above all: {ref: {bar, names, spans, keep?}} */
  viewMarks: (c: string, slug: string, refs: string[], version?: string) => j<Record<string, { bar?: string; names?: string[]; spans?: { text: string; colour: string }[]; keep?: boolean }>>(`${ws(c)}/views/${enc(slug)}/marks${q({ v: version })}`, { method: 'POST', body: JSON.stringify({ refs }) }),
  /** review the built view's pictures again; stop a review; put the view back as it was built before its review */
  viewReviewAgain: (c: string, slug: string) => j<{ ok: boolean }>(`${ws(c)}/views/${enc(slug)}/review`, { method: 'POST' }),
  viewReviewStop: (c: string, slug: string) => j<{ ok: boolean }>(`${ws(c)}/views/${enc(slug)}/review`, { method: 'DELETE' }),
  viewReviewUndo: (c: string, slug: string) => j<{ ok: boolean }>(`${ws(c)}/views/${enc(slug)}/review/undo`, { method: 'POST' }),
  /** with `path`, of that one file, as a file viewer shows it */
  viewProblems: (c: string, slug: string, version?: string, path?: string) => j<ViewProblems>(`${ws(c)}/views/${enc(slug)}/problems${q({ v: version, path })}`),
  viewShown: (c: string, slug: string, version?: string, path?: string) => j<ViewShown>(`${ws(c)}/views/${enc(slug)}/shown${q({ v: version, path })}`),
  viewOpen: (c: string, slug: string, ref: string, version?: string) => j<ViewOpen>(`${ws(c)}/views/${enc(slug)}/resolve${q({ ref, v: version })}`),
  /** a card type's page as a card's frame loads it (backend cardtypes.frame_route) */
  cardTypeFrame: async (c: string, type: string): Promise<string> => {
    const res = await fetch(`${ws(c)}/cardtypes/${enc(type)}/frame`)
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    return res.text()
  },
  /** reader.records(index, query) for a card's page, under the labels the card names */
  cardTypeRecords: (c: string, type: string, card: string, query: unknown) =>
    heavy(() => j<{ data: unknown }>(`${ws(c)}/cardtypes/${enc(type)}/records`, { method: 'POST', body: JSON.stringify({ query, card }) })),
  /** Keep: a card type's card with its call's arguments changed by `patch`, run again and checked (backend
   * cardtypes.keep_route); the card as stored */
  keepCard: (c: string, card: string, patch: Record<string, unknown>) =>
    j<{ cell: Cell; written: string[] }>(`${ws(c)}/cells/${enc(card)}/keep`, { method: 'POST', body: JSON.stringify({ patch }) }),
  /** whether Keep can write `patch` into the card's call: the arguments its code computed that it would write out, or
   * the error it would give */
  keepCheck: (c: string, card: string, patch: Record<string, unknown>) =>
    j<{ cell: null; written: string[] }>(`${ws(c)}/cells/${enc(card)}/keep`, { method: 'POST', body: JSON.stringify({ patch, dry: true }) }),
  /** Open as view: the view of a card's type made ready, with the card's labels on, and the card and arguments it opens
   * with */
  cardAsView: (c: string, card: string) => j<{ slug: string; query: ViewQuery }>(`${ws(c)}/cells/${enc(card)}/as-view`, { method: 'POST' }),
  // ---- orientation ----
  /** Start (`POST /ws/{c}/start`): a click, which starts the orientation through thimble's plugin with no turn of main;
     * the answer is the agent id, or the refusal's kind and reason, which orient/run.json also holds (`orientation`).
     * 403 without the analyst's cookie. */
  start: (c: string, body: Partial<StartBody> = {}) => j<StartAnswer>(`${ws(c)}/start`, { method: 'POST', body: JSON.stringify(body) }).then(startAnswer),
  /** The orientation's record (`GET /ws/{c}/orientation`, orient/run.json): {} before any was asked for. */
  orientation: (c: string) => j<OrientRun>(`${ws(c)}/orientation`),

  // ---- documents ----
  frame: (c: string, slug: DocumentType) => j<Writeup>(`${inv(c, slug)}/frame`),
  addFrameSection: (c: string, slug: DocumentType, heading: string) => j<Writeup>(`${inv(c, slug)}/frame/sections`, { method: 'POST', body: JSON.stringify({ heading }) }),
  addFrameParagraph: (c: string, slug: DocumentType, sid: string, text: string) => j<Writeup>(`${inv(c, slug)}/frame/sections/${enc(sid)}/paragraphs`, { method: 'POST', body: JSON.stringify({ text }) }),
  addFrameFigure: (c: string, slug: DocumentType, sid: string, body: { cell: string; caption?: string; after?: string }) => j<Writeup>(`${inv(c, slug)}/frame/sections/${enc(sid)}/figures`, { method: 'POST', body: JSON.stringify(body) }),
  deleteFrameUnit: (c: string, slug: DocumentType, uid: string) => j<Writeup>(`${inv(c, slug)}/frame/units/${enc(uid)}`, { method: 'DELETE' }),
  putFrameUnit: (c: string, slug: DocumentType, uid: string, patch: { text?: string; heading?: string; caption?: string }) => j<Writeup>(`${inv(c, slug)}/frame/units/${enc(uid)}`, { method: 'PUT', body: JSON.stringify(patch) }),
  /** Write (`POST /ws/{c}/write`): a click, which starts the document's writer through thimble's plugin; it writes it,
   * or revises it once written. `text` is a request typed at one place, `after` that place, and `model` and `effort`
   * the run's values (Settings' writer row when left out). The answer is the agent id or the refusal's kind and reason;
   * 403 without the analyst's cookie. */
  write: (c: string, slug: DocumentType, body: { text?: string; after?: string; model?: string; effort?: string } = {}) =>
    j<StartAnswer>(`${ws(c)}/write`, { method: 'POST', body: JSON.stringify({ doc: slug, ...body }) }).then(startAnswer),
  /** Send the analyst's session what the analyst wrote at one place (`POST /ws/{c}/events {kind: card}`, the `card`
   * bullet of prompts/main.md): a request sent with ⌘↵ (lib/agentKey) or /card, made in document `doc` after the
   * passage `after` names, or on card `card`. A card main makes for it with add_card in the group
   * `request:<request>` lands in the analyst's Your work, and the stream's `card-request {request, card}` names it. */
  askCard: (c: string, body: { text: string; request: string; doc?: string; after?: string; card?: string }) =>
    j<EventPosted>(`${ws(c)}/events`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'card', payload: { text: body.text, group: `request:${body.request}`, ...(body.doc ? { doc: body.doc } : {}), ...(body.after ? { after: body.after } : {}), ...(body.card ? { card: body.card } : {}) } }),
    }),

  // ---- tickets ----
  tickets: (workspace: string) => j<Ticket[]>(`${BASE}/dev/tickets${q({ workspace })}`),
  ticket: (id: string) => j<Ticket>(`${BASE}/dev/tickets/${enc(id)}`),
  /** the address of a ticket's before or after shot (`GET /dev/tickets/{id}/shots/{name}`), for an <img> */
  ticketShotUrl: (id: string, name: string) => `${BASE}/dev/tickets/${enc(id)}/shots/${enc(name)}`,
  fileTicket: (body: NewTicketBody) => j<Ticket>(`${BASE}/dev/tickets`, { method: 'POST', body: JSON.stringify(body) }),
  retryTicket: (id: string) => j<Ticket>(`${BASE}/dev/tickets/${enc(id)}/retry`, { method: 'POST' }),
  dismissTicket: (id: string) => j<Ticket>(`${BASE}/dev/tickets/${enc(id)}/dismiss`, { method: 'POST' }),
  /** stop a running ticket: nothing is applied and it ends `stopped`, which Retry runs again */
  stopTicket: (id: string) => j<{ ok: boolean }>(`${BASE}/dev/tickets/${enc(id)}/stop`, { method: 'POST' }),

  // ---- settings ----
  settings: (c: string) => j<Settings>(`${ws(c)}/settings`),
  putSettings: (c: string, patch: SettingsPatch) => j<Settings>(`${ws(c)}/settings`, { method: 'PUT', body: JSON.stringify(patch) }),
  /** the extensions added, found again for this workspace (backend extensions.list_route) */
  extensions: (c: string) => j<Extensions>(`${ws(c)}/extensions`),
  /** this workspace's switch of one extension; the analyst's browser alone may turn it */
  switchExtension: (c: string, name: string, on: boolean) => j<Extensions>(`${ws(c)}/extensions/${enc(name)}`, { method: 'PUT', body: JSON.stringify({ on }) }),
  /** adds an extension thimble ships, as `thimble extension add <name>` does */
  addExtension: (c: string, name: string) => j<Extensions>(`${ws(c)}/extensions/${enc(name)}/add`, { method: 'POST' }),
  /** this workspace's switch of one extension's view, which overrides the check on whether it fits */
  switchExtensionView: (c: string, name: string, slug: string, on: boolean) =>
    j<Extensions>(`${ws(c)}/extensions/${enc(name)}/views/${enc(slug)}`, { method: 'PUT', body: JSON.stringify({ on }) }),
  /** this workspace's switch of a view built for it; the analyst's browser alone may turn it (backend views.set_view_on) */
  switchLocalView: (c: string, slug: string, on: boolean) => j<LocalExtension>(`${ws(c)}/views/${enc(slug)}/on`, { method: 'PUT', body: JSON.stringify({ on }) }),
  /** the answer to Settings' offer to run an extension's orientation instructions now: Run now (true) or Not now */
  answerExtensionOrientation: (c: string, name: string, run: boolean) =>
    j<Extensions & { status: string }>(`${ws(c)}/extensions/${enc(name)}/orientation`, { method: 'POST', body: JSON.stringify({ run }) }),
  /** the paper and accent this browser shows, so the card harness draws a card in them (backend/app/render.py) */
  reportTheme: (c: string, paper: string, accent: string) => j<{ paper: string; accent: string }>(`${ws(c)}/render/theme`, { method: 'PUT', body: JSON.stringify({ paper, accent }) }),
}

/** Whether an error is the route's 404 (a backend without the route, or nothing there yet). */
export const isNotFound = (e: unknown): boolean => /^404\b/.test((e as Error)?.message ?? '')

// --- the canvas's layout ---
import type { CellMoveBody, GroupPatch, MainEffort, Pos, StartBody } from './types'

/** The canvas' layout routes: where a group's column sits and how wide a card is. */
export const canvasApi = {
  /** `PUT /notebooks/{nb}`: rename, nest (`parent`), place (`pos`, `order`); null returns the frame to the default placement. */
  patchGroup: (c: string, nb: string, patch: GroupPatch) => j<Group>(`${ws(c)}/notebooks/${enc(nb)}`, { method: 'PUT', body: JSON.stringify(patch) }),
  /** `POST /notebooks`: a new group, at the root or under `parent`, placed by `pos` or `order`. */
  createGroup: (c: string, body: { title: string; parent?: string | null; pos?: Pos | null; order?: number | null }) => j<Group>(`${ws(c)}/notebooks`, { method: 'POST', body: JSON.stringify(body) }),
  /** `DELETE /notebooks/{nb}`: the group with every group and card in it. */
  deleteGroup: (c: string, nb: string) => j<{ ok: boolean }>(`${ws(c)}/notebooks/${enc(nb)}`, { method: 'DELETE' }),
  /** `PUT /cells/{id}`: the card's size, star or pos (the backend holds width to 220..1200, height to 100 up). */
  patchCell: (c: string, id: string, patch: CellPatch) => j<Cell>(`${ws(c)}/cells/${enc(id)}`, { method: 'PUT', body: JSON.stringify(patch) }),
  /** `POST /cells/move`: reorder cards, move them to another group, or place one free. */
  move: (c: string, body: CellMoveBody) => j<Cell[]>(`${ws(c)}/cells/move`, { method: 'POST', body: JSON.stringify(body) }),
  /** `PUT /canvas/active-group`: the frame the analyst last selected or worked in, where a model's card goes when its call names no group. */
  activeGroup: (c: string, group: string) => j<{ group: string }>(`${ws(c)}/canvas/active-group`, { method: 'PUT', body: JSON.stringify({ group }) }),
}

// --- the report editor ---
import type { ReportBlocksBody } from './types'

/** The report editor's save route. */
export const reportApi = {
  /** `PUT …/types/{slug}/blocks`: the editor's whole document as blocks; answers the stored document or frame. */
  putBlocks: (c: string, slug: DocumentType, body: ReportBlocksBody) => j<Writeup>(`${inv(c, slug)}/blocks`, { method: 'PUT', body: JSON.stringify(body) }),
  /** `PUT …/types/{slug}/locks/{block}`: the analyst's lock on one block (the title's id is `title`); answers the stored document or frame. */
  lock: (c: string, slug: DocumentType, block: string, body: { locked: boolean; client?: string }) =>
    j<Writeup>(`${inv(c, slug)}/locks/${enc(block)}`, { method: 'PUT', body: JSON.stringify(body) }),
}

// ---- the problem report (shell/ProblemReport.tsx; backend feedback.py) ----
export const feedbackApi = {
  /** `POST /ws/{c}/feedback`: writes the bundle on the server's machine and answers where it is and how to send it. */
  prepare: (c: string, body: import('./types').ProblemReportBody) => j<import('./types').ProblemReport>(`${ws(c)}/feedback`, { method: 'POST', body: JSON.stringify(body) }),
  /** `POST /feedback/reveal`: shows the bundle in the file manager of the server's machine. */
  reveal: (path: string) => j<{ ok: boolean }>(`${BASE}/feedback/reveal`, { method: 'POST', body: JSON.stringify({ path }) }),
  /** `GET /feedback/download`: the zip itself, for a browser on another machine than the server. */
  downloadUrl: (path: string) => `${BASE}/feedback/download?path=${enc(path)}`,
}

// --- label cards: the details drawer (canvas/LabelDetails.tsx) ---
import type { ApplyBody, ConceptCoverage, ConceptDetail, ConceptPatch, ConceptRun, ConceptUnit, LabelDraft, LabelPresence, LabelRowText, LabelRuler, VerdictResult } from './types'

export const labelApi = {
  /** `GET /concepts/{id}`: the concept with its kept runs and the live run record. */
  detail: (c: string, id: string) => j<ConceptDetail>(`${ws(c)}/concepts/${enc(id)}`),
  /** `PUT /concepts/{id}`: a partial update (the description edited in place; the Files pane's edit card, its toggles). */
  update: (c: string, id: string, patch: ConceptPatch) => j<ConceptDetail>(`${ws(c)}/concepts/${enc(id)}`, { method: 'PUT', body: JSON.stringify(patch) }),
  /** `POST /concepts`: a new label from the Files pane's edit card, over files, cards (`cell`) or sentences (`span`). */
  create: (c: string, body: ConceptPatch & { name: string; unit?: ConceptUnit }) => j<ConceptDetail>(`${ws(c)}/concepts`, { method: 'POST', body: JSON.stringify(body) }),
  /** `GET /labels/presence`: per label over files, the values it left on each file (the tree's dots). */
  presence: (c: string) => j<LabelPresence[]>(`${ws(c)}/labels/presence`),
  /** `GET /labels/ruler?path=&bins=`: where each label's values fall on one file (the reader's overview ruler). */
  ruler: (c: string, path: string, bins: number) => j<LabelRuler>(`${ws(c)}/labels/ruler${q({ path, bins })}`),
  /** `POST /concepts/draft`: the labels model defines a label from the analyst's description, reading the first records
   * of the files it would apply to; nothing is stored. */
  draft: (c: string, text: string, paths: string[]) => j<LabelDraft>(`${ws(c)}/concepts/draft`, { method: 'POST', body: JSON.stringify({ text, paths }) }),
  /** `GET /labels/glob?pattern=`: the files a glob applies to. */
  glob: (c: string, pattern: string) => j<{ files: string[]; total: number }>(`${ws(c)}/labels/glob${q({ pattern })}`),
  /** `GET /concepts/{id}/rows?text=1`: one page of rows with the effective value, each with the unit's own text. */
  rows: (c: string, id: string, opts: { value?: string; limit?: number; offset?: number }) =>
    j<{ rows: LabelRowText[]; total: number }>(`${ws(c)}/concepts/${enc(id)}/rows${q({ ...opts, text: 1 })}`),
  /** `GET /concepts/{id}/coverage?offset=`: how many corpus files the label covers, the first covered files, and a page
   * of the files it does not cover from `offset`. */
  coverage: (c: string, id: string, offset = 0) => j<ConceptCoverage>(`${ws(c)}/concepts/${enc(id)}/coverage${offset > 0 ? `?offset=${offset}` : ''}`),
  /** `POST /concepts/{id}/labels`: the analyst's verdict on one unit. */
  verdict: (c: string, id: string, ref: string, label: string, note?: string) =>
    j<VerdictResult>(`${ws(c)}/concepts/${enc(id)}/labels`, { method: 'POST', body: JSON.stringify({ ref, label, note }) }),
  /** `POST /concepts/{id}/apply`: start a run (202 with the run record); a prompt label's carries the analyst's values as examples. */
  apply: (c: string, id: string, body: ApplyBody) => j<ConceptRun>(`${ws(c)}/concepts/${enc(id)}/apply`, { method: 'POST', body: JSON.stringify(body) }),
}

// --- documents: the Report tab's switcher, the story, the deck and the page (report/) ---
import type { AnyDoc, DeckBody, DeckDoc, DocHistory, DocPreset, NewDocBody, PageDoc, ReportType, StoryBody, StoryDoc, TypesState } from './types'

export const docsApi = {
  /** `GET …/investigations/main/types`: per type, whether its document exists, its renderer and its name. */
  types: (c: string) => j<TypesState>(`${ws(c)}/investigations/main/types`),
  /** `GET …/types/{slug}`: the stored document of any shape (404 before a write). */
  document: (c: string, slug: string) => j<AnyDoc>(inv(c, slug)),
  /** `GET …/types/{slug}/versions`: every generation of the written document, newest first (404 before a write). */
  versions: (c: string, slug: string) => j<DocHistory>(`${inv(c, slug)}/versions`),
  /** `GET …/types/{slug}/versions/{n}`: generation `n` as it stood (404 when its text is not kept). */
  version: (c: string, slug: string, n: number) => j<AnyDoc>(`${inv(c, slug)}/versions/${n}`),
  /** `GET …/types/{slug}/versions/{n}/revisions/{i}`: an earlier save of the writer run that wrote generation `n`. */
  revision: (c: string, slug: string, n: number, i: number) => j<AnyDoc>(`${inv(c, slug)}/versions/${n}/revisions/${i}`),
  /** `GET /report-types/presets`: the presets + New offers. */
  presets: (c: string) => j<DocPreset[]>(`${ws(c)}/report-types/presets`),
  /** `POST /report-types/new`: a preset's document, a page, or one of the analyst's own from a name and a brief. */
  createDoc: (c: string, body: NewDocBody) => j<ReportType>(`${ws(c)}/report-types/new`, { method: 'POST', body: JSON.stringify(body) }),
  /** `PUT /report-types/{slug}`: a type of the workspace's own renamed. */
  renameType: (c: string, slug: string, name: string) => j<ReportType>(`${ws(c)}/report-types/${enc(slug)}`, { method: 'PUT', body: JSON.stringify({ name }) }),
  /** `DELETE /report-types/{slug}`: a type of the workspace's own and its document. */
  deleteType: (c: string, slug: string) => j<{ ok: boolean }>(`${ws(c)}/report-types/${enc(slug)}`, { method: 'DELETE' }),
  /** `PUT …/types/{slug}/deck`: the deck editor's whole deck, into the written deck or its frame; answers what is stored. */
  putDeck: (c: string, slug: string, body: DeckBody) => j<DeckDoc>(`${inv(c, slug)}/deck`, { method: 'PUT', body: JSON.stringify(body) }),
  /** `PUT …/types/{slug}/story`: the story editor's whole story, into the written story or its frame; answers what is stored. */
  putStory: (c: string, slug: string, body: StoryBody) => j<StoryDoc>(`${inv(c, slug)}/story`, { method: 'PUT', body: JSON.stringify(body) }),
  /** `PUT …/types/{slug}/html`: the page's whole html from the code drawer; creates the page's document when none is written. */
  putHtml: (c: string, slug: string, html: string) => j<PageDoc>(`${inv(c, slug)}/html`, { method: 'PUT', body: JSON.stringify({ html }) }),
  /** `GET …/types/{slug}/film`: a video's film as its frame loads it, under the views' policy, with its timing and bridge. */
  film: (c: string, slug: string) => j<{ html: string }>(`${inv(c, slug)}/film`),
}

// --- scale: one folder at a time for the tree, one page of labels for the reader ---
import type { FolderListing, LabelRowsPage } from './types'

/** folders one stamps request asks about (backend corpus.STAMPS_MAX is 200), and the characters of their paths in its
 * URL, well under the 16 KB a server takes for a request line */
const STAMPS_AT_ONCE = 100
const STAMPS_URL_CHARS = 6000

/** `paths` as the `path=` parts of stamps requests, each within STAMPS_AT_ONCE folders and STAMPS_URL_CHARS. */
export function stampQueries(paths: readonly string[]): string[] {
  const out: string[] = []
  let parts: string[] = []
  let chars = 0
  for (const p of paths) {
    const part = `path=${encodeURIComponent(p)}`
    if (parts.length && (parts.length >= STAMPS_AT_ONCE || chars + part.length > STAMPS_URL_CHARS)) {
      out.push(parts.join('&'))
      parts = []
      chars = 0
    }
    parts.push(part)
    chars += part.length + 1
  }
  if (parts.length) out.push(parts.join('&'))
  return out
}

export const scaleApi = {
  /** `GET /corpora/{c}/sources?path=<folder>&depth=1`: the folder's own files and subfolders ('' is the root). */
  folder: (c: string, path: string) => j<FolderListing>(`${BASE}/corpora/${enc(c)}/sources${q({ path: path || '.', depth: 1 })}`),
  /** `GET /corpora/{c}/sources/stamps?path=…`: each folder's stamp now, null for one that is gone, so the tree lists
   * again only the folders whose stamp is not their listing's; as many requests as stampQueries makes. */
  stamps: async (c: string, paths: readonly string[]) => {
    const stamps: Record<string, string | null> = {}
    for (const query of stampQueries(paths))
      Object.assign(stamps, (await j<{ stamps: Record<string, string | null> }>(`${BASE}/corpora/${enc(c)}/sources/stamps?${query}`)).stamps)
    return { stamps }
  },
  /** `GET /ws/{c}/labels?path=&lines=a-b`: every concept's rows on lines a..b of one file, plus its whole-file rows. */
  labelsForLines: (c: string, path: string, a: number, b: number) => j<LabelsForPath[]>(`${ws(c)}/labels${q({ path, lines: `${a}-${b}` })}`),
  /** `GET /ws/{c}/labels?path=&lines=a-b,c-d,...`: every concept's rows on each of these ranges of one file's lines, plus
   * its whole-file rows, in one request. */
  labelsForSpans: (c: string, path: string, lines: string) => j<LabelsForPath[]>(`${ws(c)}/labels${q({ path, lines })}`),
  /** `POST /ws/{c}/labels/refs`: every concept's rows on these records that are no lines (a database row, a PDF page, a
   * JSON value, a CSV row, a view reader's own record). */
  labelsForRefs: (c: string, refs: string[]) => j<LabelsForPath[]>(`${ws(c)}/labels/refs`, { method: 'POST', body: JSON.stringify({ refs }) }),
  /** `GET /concepts/{id}/rows?after=<cursor>`: the page after the one whose `next` this is (`after` omitted: the first). */
  conceptRowsPage: (c: string, id: string, opts: { value?: string; limit?: number; after?: number | null }) =>
    j<LabelRowsPage>(`${ws(c)}/concepts/${enc(id)}/rows${q({ value: opts.value, limit: opts.limit, after: opts.after ?? undefined })}`),
}

// --- undo and redo over the workspace's cards and documents (backend undo.py) ---
import type { UndoLabels } from './types'

export const undoApi = {
  /** `GET /ws/{c}/undo`: the step an undo would revert and the one a redo would repeat, each by its label, or null. */
  labels: (c: string) => j<UndoLabels>(`${ws(c)}/undo`),
  /** `POST /ws/{c}/undo`: revert the last step (409 when there is none, or it cannot be reverted any more). */
  undo: (c: string) => j<UndoLabels & { applied: string }>(`${ws(c)}/undo`, { method: 'POST' }),
  /** `POST /ws/{c}/redo`: repeat the last step undone. */
  redo: (c: string) => j<UndoLabels & { applied: string }>(`${ws(c)}/redo`, { method: 'POST' }),
}

// --- report checks: the Checks pane's rows (report/Checks.tsx, backend checks.py) ---
import type { CardCheckStatus, Check, CheckPatch, CheckRun } from './types'

export const checksApi = {
  /** `GET /checks`: every check of the workspace, the built-ins first, each with its latest run per document. */
  list: (c: string) => j<Check[]>(`${ws(c)}/checks`),
  /** `POST /checks`: a new check from a name and a prompt (201), which the server turns on and runs; a 409 when the
   * name is taken. */
  create: (c: string, body: { name: string; prompt: string }) => j<Check>(`${ws(c)}/checks`, { method: 'POST', body: JSON.stringify(body) }),
  /** `PATCH /checks/{id}`: turned on or off, renamed, its prompt or colour changed; answers the check. The server runs
   * a check turned on, and one that is on given a new prompt, wherever it has passages it has not seen. */
  update: (c: string, id: string, patch: CheckPatch) => j<Check>(`${ws(c)}/checks/${enc(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  /** Run (`POST /checks/{id}/run`): a click that starts the check's agent on one document through thimble's plugin, for
   * the passages that changed since it last checked them; answers the run. */
  run: (c: string, id: string, doc: string) => j<CheckRun>(`${ws(c)}/checks/${enc(id)}/run`, { method: 'POST', body: JSON.stringify({ doc }) }),
  /** `POST /checks/{id}/runs/{doc}/stop`: stop the check's run on one document; answers the check. */
  stop: (c: string, id: string, doc: string) => j<Check>(`${ws(c)}/checks/${enc(id)}/runs/${enc(doc)}/stop`, { method: 'POST' }),
}
