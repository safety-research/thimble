// The typed client for every route of the backend's API.
import type {
  CanvasResponse,
  Extensions,
  LocalExtension,
  Cell,
  CardVersion,
  CellName,
  PlanRun,
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
  DevStatus,
  OrientRun,
  Proposal,
  ResolvedRef,
  Settings,
  SettingsPatch,
  FileFind,
  GrepDone,
  GrepFile,
  GrepProgress,
  SourceEvents,
  SourceFind,
  SourceInfo,
  SourceLines,
  SourceKeys,
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
  WorkspaceRow,
  Writeup,
} from './types'
import { bus } from './bus'
import { heavy } from './limit'
import { clearCodeGone, setBrowserId, showCodeGone } from './notices'
import { apiBase, setBrowserKey } from './browserKey'

// Every path below starts with apiBase(): `/b/<key>/api` once this browser holds its key, which the server scopes the
// browser's cookie to (lib/browserKey), else `/api`. It is read at each request, so a key a later sign-in gives (in
// this tab or another) is used at once.

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
// whether the server refused the last code this page posted with 410: used, replaced by a newer one, or expired
let codeGone = false

/** Whether the server refused the link's sign-in code with 410 at the last claim (used, replaced by a newer one, or
 * expired); shell/SignIn starts its line with it. */
export const claimRefused = (): boolean => codeGone

/** The address's hash as parameters: `p` is a link's sign-in code. */
const hashParams = (): URLSearchParams => new URLSearchParams(window.location.hash.slice(1))

/** The address with `params` as its hash (none when empty), in place: no reload, no history entry. */
function setHash(params: URLSearchParams): void {
  const rest = params.toString()
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search + (rest ? `#${rest}` : ''))
}

/** Sign this browser in with the one-time code in the link thimble showed (`#p=`, made as the link is shown: backend
 * hook_auth.mint), which the server trades for the cookie that every read of the server's data and every analyst
 * action needs (backend hook_auth), and take the code out of the address once the server has answered. 200 {key}:
 * signed in, with the key of the path the cookie is scoped to, which the page keeps (lib/browserKey) and sends every
 * later request under. 204: signed in already (the claim went under this browser's path with its cookie), so the key
 * it holds stands. 410 (or any other refusal): the code was used, replaced by a newer one, or expired, which
 * shell/SignIn's line and a notice this page makes say (claimRefused, lib/notices showCodeGone; a later sign-in takes
 * the notice away). The key an earlier version's link carried (`k` in the hash)
 * is taken out of the address and never sent. After the claim the page asks which browser it is (GET /ui/paired), so
 * it leaves out the notice of its own sign-in (lib/notices setBrowserId). Memoised: with no code in the link the
 * cookie the browser already holds stands; a claim the server never answered leaves the code in the address and is
 * tried again by the next call. `j` awaits it, so a write never races the claim. */
export function claimKey(): Promise<void> {
  if (keyReady) return keyReady
  if (typeof window === 'undefined') return (keyReady = Promise.resolve())
  const hash = hashParams()
  if (hash.has('k')) {
    hash.delete('k')
    setHash(hash)
  }
  const code = hash.get('p')
  keyReady = (code ? claim(code) : Promise.resolve(true)).then((answered) => {
    if (answered) afterClaim = learnBrowser()
  })
  return keyReady
}

async function claim(code: string): Promise<boolean> {
  const ws = new URLSearchParams(window.location.search).get('ws')
  for (const wait of CLAIM_WAITS_MS) {
    if (wait) await new Promise((r) => setTimeout(r, wait))
    try {
      const res = await fetch(`${apiBase()}/ui/key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ws ? { code, ws } : { code }) })
      // 200 or 204 signed in, 410 (or any refusal) a code that is gone: neither changes on another try
      const signed = res.status === 200 || res.status === 204
      if (signed || (res.status >= 400 && res.status < 500)) {
        if (res.status === 200) {
          try {
            setBrowserKey(((await res.json()) as { key?: unknown } | null)?.key)
          } catch {
            /* no key in the answer: the page goes on without one, and shows the sign-in line */
          }
        }
        const now = hashParams()
        if (now.get('p') === code) {
          now.delete('p')
          setHash(now)
        }
        codeGone = res.status === 410
        if (!signed) showCodeGone()
        else clearCodeGone()
        return true
      }
    } catch {
      /* no answer: try again */
    }
  }
  keyReady = null
  return false
}

type Paired = { paired: boolean; id: string }
// what GET /ui/paired answered after the last claim the server answered; null before one, or when the read failed
let afterClaim: Promise<Paired | null> = Promise.resolve(null)

/** This browser's id (GET /ui/paired), for lib/notices; a read that fails leaves it unknown. The answer, or null when
 * the read failed. */
async function learnBrowser(): Promise<Paired | null> {
  try {
    const got = await api.paired()
    setBrowserId(typeof got?.id === 'string' ? got.id : '')
    return got ?? null
  } catch {
    return null // unknown: every sign-in notice shows
  }
}

/** Whether the server answers this page's reads: this browser is signed in, as GET /ui/paired answered after the claim
 * of the link's code (the read that learns its id, not one more), or else a read the server guards answers all the
 * same (GET /tour), as it does for a page thimble's screenshot tool loads with a read credential of its own, which
 * /ui/paired does not count. null when the server did not answer. `again` asks /ui/paired anew. For shell/SignIn. */
export async function signedIn(again = false): Promise<boolean | null> {
  await claimKey()
  const got = again ? await learnBrowser() : await afterClaim
  if (!got) return null
  if (got.paired === true) return true
  try {
    return (await fetch(`${apiBase()}/tour`)).status !== 401
  } catch {
    return null
  }
}

/** A link with a code opened in a tab already on its page changes only the address's hash, and loads nothing: the code
 * is claimed, and shell/SignIn checks again whether this browser is signed in (bus `newLink`). */
export function claimOnHashChange(): void {
  if (typeof window === 'undefined') return
  window.addEventListener('hashchange', () => {
    const hash = hashParams()
    if (!hash.get('p') && !hash.has('k')) return
    keyReady = null
    void claimKey()
    bus.emit('newLink', {})
  })
}

/** Whether `res` is a read the server refused because this browser is not signed in (backend hook_auth: 401 with
 * `signin: true`); when it is, the page learns it (bus `signedOut`) and shell/SignIn shows its line in place of the app.
 * Every request of the page's own that reads the server's data hands its failed answer here. Reads a copy of the body,
 * so `res` can still be read. */
export async function signInNeeded(res: Response): Promise<boolean> {
  if (res.status !== 401) return false
  try {
    const body = (await res.clone().json()) as { signin?: unknown } | null
    if (body?.signin !== true) return false
  } catch {
    return false
  }
  bus.emit('signedOut', {})
  return true
}

/** After a stream the server closed (lib/sse): when the server no longer answers this page's reads (signedIn), the
 * page learns it (bus `signedOut`), so it shows shell/SignIn's line rather than that the server is down. A server that
 * does not answer says nothing: lib/sse's own failure stands. */
export async function checkSignedIn(): Promise<void> {
  if ((await signedIn(true)) === false) bus.emit('signedOut', {})
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
    await signInNeeded(res)
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

/** The error of a request that answered text rather than JSON, by its status (signInNeeded heard it first). */
async function failed(res: Response): Promise<Error> {
  await signInNeeded(res)
  return new Error(`${res.status} ${res.statusText}`)
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
const ws = (c: string) => `${apiBase()}/ws/${enc(c)}`
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
  tour: () => j<{ seen: boolean }>(`${apiBase()}/tour`),
  tourSeen: () => j<{ seen: boolean }>(`${apiBase()}/tour/seen`, { method: 'POST' }),
  // ---- corpora and files ----
  corpora: () => j<CorpusInfo[]>(`${apiBase()}/corpora`),
  /** `GET /workspaces`: every workspace this server knows, as the start page lists them (backend start_page.py). */
  workspaces: () => j<WorkspaceRow[]>(`${apiBase()}/workspaces`),
  sources: (c: string) => j<SourceInfo[]>(`${apiBase()}/corpora/${enc(c)}/sources`),
  source: (c: string, path: string, start = 1, count = 100) => j<SourcePage>(`${apiBase()}/corpora/${enc(c)}/source${q({ path, start, count })}`),
  /** `clamp`: a line past the end answers with the file's last lines, not a 404 (a move made while the count is an estimate) */
  sourceAround: (c: string, path: string, line: number, before = 50, after = 50, clamp = false) =>
    j<SourcePage>(`${apiBase()}/corpora/${enc(c)}/source/around${q({ path, line, before, after, clamp: clamp ? 1 : undefined })}`),
  /** `GET /corpora/{c}/source/lines`: a file's line count, an estimate while a big file's line index is being built. */
  sourceLines: (c: string, path: string) => j<SourceLines>(`${apiBase()}/corpora/${enc(c)}/source/lines${q({ path })}`),
  /** `GET /corpora/{c}/source/turns`: `count` turns of a JSON transcript from turn `start`, or around `line`; with
   * `span`, a span of that line (block and UTF-16 offsets), around the turn holding the words it quotes. */
  sourceTurns: (c: string, path: string, start = 0, count = 200, line?: number, span?: { block: number; start: number; end: number }) =>
    j<SourceTurns>(`${apiBase()}/corpora/${enc(c)}/source/turns${q({ path, start, count, line, block: span?.block, char_start: span?.start, char_end: span?.end })}`),
  /** `GET /corpora/{c}/source/speakers`: the names the corpus gives speaker ids (`ids`, joined by commas) that a file
   * keeps under `key` (an agents.jsonl beside it, whose records carry an id and a name). */
  speakerNames: (c: string, path: string, key: string, ids: string) => j<{ names: Record<string, string> }>(`${apiBase()}/corpora/${enc(c)}/source/speakers${q({ path, key, ids })}`),
  /** the keys of the file's records that name a kind or a who, over the whole file (backend source_keys.py) */
  sourceKeys: (c: string, path: string, bins?: number) => j<SourceKeys>(`${apiBase()}/corpora/${enc(c)}/source/keys${q({ path, bins })}`),
  /** the file's records with a time, in time order, for the Timeline mode (backend source_events.py) */
  sourceEvents: (c: string, path: string) => j<SourceEvents>(`${apiBase()}/corpora/${enc(c)}/source/events${q({ path })}`),
  /** the Timeline mode's page as its sandboxed frame loads it: the view kit over files_timeline.html */
  timelinePage: async (c: string): Promise<string> => {
    const res = await fetch(`${apiBase()}/corpora/${enc(c)}/source/timeline`)
    if (!res.ok) throw await failed(res)
    return res.text()
  },
  /** The URL a PDF of the corpus opens from in the browser's viewer, at `page` when given. */
  pdfUrl: (c: string, path: string, page?: number | null) => `${apiBase()}/corpora/${enc(c)}/pdf/${path.split('/').map(enc).join('/')}${page ? `#page=${page}` : ''}`,
  /** `GET /corpora/{c}/download/<path>`: the file as it is on disk, an attachment under its own name (the File browser's
   * Download). */
  downloadUrl: (c: string, path: string) => `${apiBase()}/corpora/${enc(c)}/download/${path.split('/').map(enc).join('/')}`,
  /** `GET /corpora/{c}/source/find`: the lines of one file past `after` that hold `text`, searched on the server. */
  findInSource: (c: string, path: string, text: string, after = 0, signal?: AbortSignal) =>
    j<SourceFind>(`${apiBase()}/corpora/${enc(c)}/source/find${q({ path, q: text, after: after || undefined })}`, { signal }),
  /** `GET /corpora/{c}/sources/find`: the files whose path holds every word of `text`, best first. */
  findFiles: (c: string, text: string, signal?: AbortSignal) => j<FileFind>(`${apiBase()}/corpora/${enc(c)}/sources/find${q({ q: text })}`, { signal }),
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
    const res = await fetch(`${apiBase()}/corpora/${enc(c)}/sources/grep${q({ q: text })}`, { signal })
    if (!res.ok || !res.body) {
      await signInNeeded(res)
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
    j<{ stopped: boolean }>(`${apiBase()}/corpora/${enc(c)}/sources/grep/stop`, { method: 'POST', body: JSON.stringify({ search }) }),
  forgeTables: (c: string, path: string) => j<{ name: string; row_count: number }[]>(`${apiBase()}/corpora/${enc(c)}/forge/tables${q({ path })}`),
  forgeRows: (c: string, path: string, table: string, offset = 0, limit = 100, order?: string, where?: string) =>
    j<{ table: string; columns: string[]; rows: any[][]; pk: string; total: number }>(`${apiBase()}/corpora/${enc(c)}/forge/rows${q({ path, table, offset, limit, order, where })}`),
  forgeQuery: (c: string, path: string, sql: string) =>
    j<{ columns: string[]; rows: any[][]; truncated: boolean }>(`${apiBase()}/corpora/${enc(c)}/forge/query${q({ path })}`, { method: 'POST', body: JSON.stringify({ sql }) }),
  /** `value`: a citation's own words, so a card value is read from the version of the card that states it. */
  resolveRef: (c: string, ref: string, value?: string) => j<ResolvedRef>(`${apiBase()}/corpora/${enc(c)}/ref${q(value ? { ref, value } : { ref })}`),
  /** `GET /corpora/{c}/csv-rows?path=&lines=a-b`: the rows of a CSV or TSV file that start on lines a..b, [line, n] each,
   * n the number a row is cited by (`<path>#row=<n>`). */
  csvRows: (c: string, path: string, a: number, b: number) => j<{ rows: [number, number][] }>(`${apiBase()}/corpora/${enc(c)}/csv-rows${q({ path, lines: `${a}-${b}` })}`),

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
  /**
     * Send the analyst's Claude Code session an event (`POST /ws/{c}/events {kind, payload}`), e.g. a message typed in main
     * (`main`, {text}) or in a thread (`thread`, {thread, text}). The reply arrives through the chat's log. A 409 says no
     * session is listening.
     */
  postEvent: (c: string, kind: string, payload: Record<string, unknown>) =>
    j<EventPosted>(`${ws(c)}/events`, { method: 'POST', body: JSON.stringify({ kind, payload }) }),
  /** The composer's effort chip: main's effort (and its threads') from its next request (events.effort_route). */
  setEffort: (c: string, effort: MainEffort) => j<{ effort: string; choice: MainEffort }>(`${ws(c)}/session/effort`, { method: 'PUT', body: JSON.stringify({ effort }) }),
  /** The composer's bolt: fast mode for main and its threads, from their next request, on a model that has it. */
  setFast: (c: string, fast: boolean) => j<{ fast: boolean; choice: boolean }>(`${ws(c)}/session/fast`, { method: 'PUT', body: JSON.stringify({ fast }) }),
  /** Start it on a refused typed start (`POST /ws/{c}/subagents/start-it`): the same request, with the same values,
     * started through thimble's plugin as a click. */
  startIt: (c: string, request: string) => j<StartAnswer>(`${ws(c)}/subagents/start-it`, { method: 'POST', body: JSON.stringify({ request }) }).then(startAnswer),
  /** Try again, Send again and Write again (`POST /ws/{c}/subagents/again`): the request made anew as a click. */
  again: (c: string, request: string) => j<StartAnswer>(`${ws(c)}/subagents/again`, { method: 'POST', body: JSON.stringify({ request }) }).then(startAnswer),
  /** A pending request as the refused card shows it before Start it (chat/Refused.tsx, while the report reads it). */
  subagentRequest: (c: string, request: string) => j<SubagentRequest>(`${ws(c)}/subagents/requests/${enc(request)}`),

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
  /** the card as it stood before its edit `entry` (backend notebook.card_version_route) */
  cardVersion: (c: string, id: string, entry: string) => j<CardVersion>(`${ws(c)}/cells/${enc(id)}/versions/${enc(entry)}`),
  /** make the card as it stood before its edit `entry` again, as an edit of the analyst's (backend notebook.restore_version) */
  restoreVersion: (c: string, id: string, entry: string) => j<Cell>(`${ws(c)}/cells/${enc(id)}/versions/${enc(entry)}/restore`, { method: 'POST' }),
  /** `POST /notebooks/{nb}/run`: a runnable card made and run in one call; `created_by` defaults to the analyst. */
  runCode: (c: string, nb: string, body: { code: string; title: string; created_by?: string; kind?: 'code' | 'plot' | 'table' }) =>
    j<Cell>(`${ws(c)}/notebooks/${enc(nb)}/run`, { method: 'POST', body: JSON.stringify({ created_by: 'user', ...body }) }),
  deleteCell: (c: string, id: string) => j<{ ok: boolean }>(`${ws(c)}/cells/${enc(id)}`, { method: 'DELETE' }),
  /** `GET …/outputs/{i}/full`: the complete text of a truncated stream output, as text. */
  outputFull: async (c: string, nb: string, id: string, i: number): Promise<string> => {
    const res = await fetch(`${ws(c)}/notebooks/${enc(nb)}/cells/${enc(id)}/outputs/${i}/full`)
    if (!res.ok) throw await failed(res)
    return res.text()
  },
  ipynbUrl: (c: string, nb: string) => `${ws(c)}/notebooks/${enc(nb)}/ipynb`,
  cellNames: (c: string) => j<CellName[]>(`${ws(c)}/cells/names`),
  /** the live rows of a plan card's runs (backend plans.plan_runs_route) */
  planRuns: (c: string, id: string) => j<{ runs: PlanRun[] }>(`${ws(c)}/cards/${enc(id)}/plan-runs`),
  /** take off a plan's marks of what its last edit changed (backend plans.clear_edit_route) */
  clearPlanEdit: (c: string, id: string) => j<{ cleared: boolean }>(`${ws(c)}/cards/${enc(id)}/plan-edit/clear`, { method: 'POST' }),

  // ---- labels and filters ----
  concepts: (c: string) => j<Concept[]>(`${ws(c)}/concepts`),
  /** `GET /label-runs/{id}`: a label run's live state, for its row in the chat. */
  labelRun: (c: string, id: string) => j<LabelRunLive>(`${ws(c)}/label-runs/${enc(id)}`),
  /** `POST /label-runs/{id}`: the analyst's choice for a run Claude asked about: all, a random sample, or none. */
  answerLabelRun: (c: string, id: string, choice: 'all' | 'sample' | 'cancel') =>
    j<{ id: string; state: string }>(`${ws(c)}/label-runs/${enc(id)}`, { method: 'POST', body: JSON.stringify({ choice }) }),
  /** `POST /concepts/{id}/apply/cancel`: stop the label's run, keeping what it labeled. */
  stopLabelRun: (c: string, concept: string) => j<unknown>(`${ws(c)}/concepts/${enc(concept)}/apply/cancel`, { method: 'POST' }),
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
  /** ask for a viewer for the type of a file the analyst opened: the slug of the view proposal it wrote (which the
   * stream's `view {status: suggested}` brings to the view proposal card), or null */
  suggestView: (c: string, path: string) => j<{ slug: string | null }>(`${ws(c)}/views/suggest`, { method: 'POST', body: JSON.stringify({ path }) }),
  /** Accept on a view proposal: its build queued as one the analyst asked for; a start that cannot happen comes back
   * as the row's `refused`. 403 without the analyst's cookie. */
  acceptProposal: (c: string, slug: string) => j<Proposal>(`${ws(c)}/views/proposals/${enc(slug)}/accept`, { method: 'POST' }),
  /** Reject on a view proposal: the proposal dropped as rejected (backend views.answer_offer). 403 without the
   * analyst's cookie, 409 for a row that is no open proposal. */
  rejectProposal: (c: string, slug: string) => j<Proposal>(`${ws(c)}/views/proposals/${enc(slug)}/reject`, { method: 'POST' }),
  /** The open notices (backend notices.list_route): failures of main and of thimble's agents, each with its fix,
   * oldest first. */
  notices: (c: string) => j<unknown[]>(`${ws(c)}/notices`),
  /** × on a notice, or a fix of the analyst's that went through: the server forgets it (backend notices.dismiss_route). */
  dismissNotice: (c: string, id: string) => j<{ dismissed: boolean }>(`${ws(c)}/notices/${enc(id)}/dismiss`, { method: 'POST' }),
  /** Whether this browser is signed in, and its id: the first 12 hex digits of its cookie's hash, '' when not signed in
   * (backend main.ui_paired). */
  paired: () => j<{ paired: boolean; id: string }>(`${apiBase()}/ui/paired`),
  /** A sign-in notice's Sign it out: the server signs the browser `id` out and clears its notice in workspace `c`
   * (backend main.ui_signout). */
  signOut: (id: string, c?: string) => j<{ signed_out: boolean }>(`${apiBase()}/ui/signout`, { method: 'POST', body: JSON.stringify(c ? { id, ws: c } : { id }) }),
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
    if (!res.ok) throw await failed(res)
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
  /** the libraries a custom card names (`libs`, comma-separated) as inline elements for its frame's head (backend
   * card_libs.libs_route) */
  cardLibs: (c: string, libs: string) => j<{ head: string; problems: string[] }>(`${ws(c)}/card-libs${q({ libs })}`),
  /** a card type's page as a card's frame loads it (backend cardtypes.frame_route) */
  cardTypeFrame: async (c: string, type: string): Promise<string> => {
    const res = await fetch(`${ws(c)}/cardtypes/${enc(type)}/frame`)
    if (!res.ok) throw await failed(res)
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

  // ---- documents ----
  /** Write (`POST /ws/{c}/write`): the analyst's request for the report, which goes to Claude in the chat; `text` is
   * their instructions and `after_text` the words of the passage a request placed in the report follows. Answers the
   * chat it went to, or `kind: busy` with the reason while Claude still answers there. */
  write: (c: string, slug: DocumentType, body: { text?: string; after_text?: string } = {}) =>
    j<{ chat?: string; kind?: string; reason?: string }>(`${ws(c)}/write`, { method: 'POST', body: JSON.stringify({ doc: slug, ...body }) }),
  /** Send the analyst's session what the analyst wrote at one place (`POST /ws/{c}/events {kind: card}`, the `card`
   * bullet of prompts/main.md): a request sent with ⌘↵ (lib/agentKey) or /card, made in document `doc` after the
   * passage `after` names, or on card `card`. A card main makes for it with add_card in the group
   * `request:<request>` lands in the analyst's Your work, and the stream's `card-request {request, card}` names it. */
  askCard: (c: string, body: { text: string; request: string; doc?: string; after?: string; card?: string }) =>
    j<EventPosted>(`${ws(c)}/events`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'card', payload: { text: body.text, group: `request:${body.request}`, ...(body.doc ? { doc: body.doc } : {}), ...(body.after ? { after: body.after } : {}), ...(body.card ? { card: body.card } : {}) } }),
    }),
  /** the address of a ticket's before or after shot (`GET /dev/tickets/{id}/shots/{name}`), for an <img> */
  ticketShotUrl: (id: string, name: string) => `${apiBase()}/dev/tickets/${enc(id)}/shots/${enc(name)}`,
  fileTicket: (body: NewTicketBody) => j<Ticket>(`${apiBase()}/dev/tickets`, { method: 'POST', body: JSON.stringify(body) }),

  // ---- settings ----
  settings: (c: string) => j<Settings>(`${ws(c)}/settings`),
  putSettings: (c: string, patch: SettingsPatch) => j<Settings>(`${ws(c)}/settings`, { method: 'PUT', body: JSON.stringify(patch) }),
  /** `PUT /settings/api-key`: keep the API key the analyst pasted; the answer says only that one is saved */
  saveApiKey: (c: string, key: string) => j<Settings>(`${ws(c)}/settings/api-key`, { method: 'PUT', body: JSON.stringify({ key }) }),
  /** `DELETE /settings/api-key`: remove the saved API key */
  removeApiKey: (c: string) => j<Settings>(`${ws(c)}/settings/api-key`, { method: 'DELETE' }),
  /** `POST /settings/check`: one Models API call with the saved sign-in: whether it works, in words */
  checkSignIn: (c: string) => j<{ ok: boolean; message: string }>(`${ws(c)}/settings/check`, { method: 'POST' }),
  /** the paper and accent this browser shows, so the card harness draws a card in them (backend/app/render.py) */
  reportTheme: (c: string, paper: string, accent: string) => j<{ paper: string; accent: string }>(`${ws(c)}/render/theme`, { method: 'PUT', body: JSON.stringify({ paper, accent }) }),
}

/** Whether an error is the route's 404 (a backend without the route, or nothing there yet). */
export const isNotFound = (e: unknown): boolean => /^404\b/.test((e as Error)?.message ?? '')

// --- the canvas's layout ---
import type { CellMoveBody, GroupPatch, LabelRunLive, MainEffort, Pos } from './types'

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
  /** `PUT …/types/{slug}/blocks`: the editor's whole document as blocks; answers the stored document. */
  putBlocks: (c: string, slug: DocumentType, body: ReportBlocksBody) => j<Writeup>(`${inv(c, slug)}/blocks`, { method: 'PUT', body: JSON.stringify(body) }),
  /** `GET /lenses`: the lenses whose marks the report draws, each with its color (a viz family name). */
  lenses: (c: string) => j<{ id: string; name: string; color: string }[]>(`${ws(c)}/lenses`),
  /** `POST /marks/{id}/dismiss`: a mark the analyst is done with, which no longer shows. */
  dismissMark: (c: string, id: string) => j<{ ok: boolean }>(`${ws(c)}/marks/${enc(id)}/dismiss`, { method: 'POST' }),
}

// ---- the problem report (shell/ProblemReport.tsx; backend feedback.py) ----
export const feedbackApi = {
  /** `POST /ws/{c}/feedback`: writes the bundle on the server's machine and answers where it is and how to send it. */
  prepare: (c: string, body: import('./types').ProblemReportBody) => j<import('./types').ProblemReport>(`${ws(c)}/feedback`, { method: 'POST', body: JSON.stringify(body) }),
  /** `POST /feedback/reveal`: shows the bundle in the file manager of the server's machine. */
  reveal: (path: string) => j<{ ok: boolean }>(`${apiBase()}/feedback/reveal`, { method: 'POST', body: JSON.stringify({ path }) }),
  /** `GET /feedback/download`: the zip itself, for a browser on another machine than the server. */
  downloadUrl: (path: string) => `${apiBase()}/feedback/download?path=${enc(path)}`,
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
  /** `DELETE /concepts/{id}`: the label with its marks, its card and any filter that uses it; the top bar's Undo restores it. */
  remove: (c: string, id: string) => j<{ ok: boolean }>(`${ws(c)}/concepts/${enc(id)}`, { method: 'DELETE' }),
  /** `GET /labels/presence`: per label over files, the values it left on each file (the tree's dots). */
  presence: (c: string) => j<LabelPresence[]>(`${ws(c)}/labels/presence`),
  /** `GET /labels/ruler?path=&bins=&turns=`: where each label's values fall on one file (the reader's overview ruler);
   * with `turns` (the Transcript mode), a whole-file JSON transcript's turns over every line they cover. */
  ruler: (c: string, path: string, bins: number, turns = false) => j<LabelRuler>(`${ws(c)}/labels/ruler${q({ path, bins, turns: turns ? 1 : undefined })}`),
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

// --- the report's state and its kept drafts (report/) ---
import type { AnyDoc, DocHistory, NewDocBody, ReportType, TypesState } from './types'

export const docsApi = {
  /** `GET …/investigations/main/types`: per type, whether its document exists, its renderer and its name. */
  types: (c: string) => j<TypesState>(`${ws(c)}/investigations/main/types`),
  /** `GET …/types/{slug}`: the report as stored, an empty one before anything is written. */
  document: (c: string, slug: string) => j<AnyDoc>(inv(c, slug)),
  /** `GET …/types/{slug}/versions`: the drafts kept around Claude's changes to the report. */
  versions: (c: string, slug: string) => j<DocHistory>(`${inv(c, slug)}/versions`),
  /** `GET …/types/{slug}/versions/{n}`: generation `n` as it stood (404 when its text is not kept). */
  version: (c: string, slug: string, n: number) => j<AnyDoc>(`${inv(c, slug)}/versions/${n}`),
  /** `POST …/types/{slug}/versions/{n}[/revisions/{i}]/restore`: that draft, or that save of it, made the newest draft
   * again, as the analyst's; answers the document. The top bar's Undo reverts it. */
  restore: (c: string, slug: string, n: number, i: number | null) =>
    j<AnyDoc>(`${inv(c, slug)}/versions/${n}${i != null ? `/revisions/${i}` : ''}/restore`, { method: 'POST' }),
  /** `POST /report-types/new`: another document of the report's kind, from a name. */
  createDoc: (c: string, body: NewDocBody) => j<ReportType>(`${ws(c)}/report-types/new`, { method: 'POST', body: JSON.stringify(body) }),
  /** `PUT /report-types/{slug}`: a document of the person's own renamed. */
  renameType: (c: string, slug: string, name: string) => j<ReportType>(`${ws(c)}/report-types/${enc(slug)}`, { method: 'PUT', body: JSON.stringify({ name }) }),
  /** `DELETE /report-types/{slug}`: a document of the person's own, with its drafts. */
  deleteType: (c: string, slug: string) => j<{ ok: boolean }>(`${ws(c)}/report-types/${enc(slug)}`, { method: 'DELETE' }),
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
  folder: (c: string, path: string) => j<FolderListing>(`${apiBase()}/corpora/${enc(c)}/sources${q({ path: path || '.', depth: 1 })}`),
  /** `GET /corpora/{c}/sources/stamps?path=…`: each folder's stamp now, null for one that is gone, so the tree lists
   * again only the folders whose stamp is not their listing's; as many requests as stampQueries makes. */
  stamps: async (c: string, paths: readonly string[]) => {
    const stamps: Record<string, string | null> = {}
    for (const query of stampQueries(paths))
      Object.assign(stamps, (await j<{ stamps: Record<string, string | null> }>(`${apiBase()}/corpora/${enc(c)}/sources/stamps?${query}`)).stamps)
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
