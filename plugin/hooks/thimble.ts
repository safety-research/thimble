// thimble's hooks module: how a click in thimble's browser starts, messages and stops one of thimble's subagents in
// the analyst's Claude Code session with no turn of main, how a typed start runs on exactly the model and effort its
// request names, and how thimble's model calls run through the session's own API client. The server's side is
// backend/app/module_bridge.py; the tests are thimble.test.ts beside this file.
//
// Scope. It acts only in a session thimble is on in, and checks that before its first fetch or registration:
// `isInteractive` (an open long poll would hold every `claude -p` run open), THIMBLE_NO_MODULE unset, then the session's
// marker, <home>/up/<session>.active, which activation writes (app/activate.py). The terminal UI, which register.ts
// registers after this file in the plugin's one hooks module, tells it of an activation at once (bridgeActivated: right
// after the activation answer, and after a load_thimble call it saw), so thimble's agent types are registered in that
// turn. For an activation made outside the terminal UI (the /thimble skill where the terminal UI does not run, a shell),
// it looks for the marker at session.start and once at the end of each of main's turns. Anywhere else it registers
// nothing and fetches nothing. It starts no process: $.fs and $.http.fetch only.
//
// Transport. The workspace's trusted/launch.json says how the session reaches thimble (app/subagent_files.py
// transport): through the workspace's files until a press of the browser workbench (`transport: local`, below), and
// through thimble's server for the rest of the session once the press made main's transport the server's. A peer (a
// session turned on beside a live main) and a session another took main from always use the files, and as a peer it
// registers the agent types but takes no requests and writes no module.json. It reads launch.json again whenever the
// file changes and at the end of each of main's turns; at the switch it takes the requests still waiting in
// subagents.json, then goes on over HTTP, and nothing switches back. Over HTTP every request proves the token of
// server.json and every answer proves it back (app/hook_auth.py), so a process on the port can neither hand it requests
// nor read them.
//
// The file guard (tool.call), in every session from session.start, thimble on in it or not: it refuses a call of a file
// tool (Read, Edit, Write, MultiEdit, NotebookEdit, Grep, Glob) on thimble's token files, a call of an edit tool on
// thimble's records or,
// when the analyst turned corpus edits off, on the corpus, and WebFetch and WebSearch when the analyst turned the web
// off, with the reason each rule names. The rules come with the roles (GET /api/module/roles, or roles.json in terminal
// mode: app/userconf.py module_rules); until they come, or when they cannot be fetched, only the token files in
// thimble's home are refused. The path is compared as spelled and as resolved ($.fs.stat with resolve), so a link to a
// token file is refused too; Grep and Glob are refused at thimble's home itself. Bash it leaves to the permission mode,
// except that once thimble is on in the session it refuses a Bash command that names a token file under thimble's home
// literally (BASH_PRIVATE).
//
// What it does once it is on (over HTTP; through the files the same, below):
// - registers thimble's roles and thimble:orient-helper from GET /api/module/roles (each with a full model id and an
//   explicit effort, from Settings); when the server is up at session start this happens inside session.start, so the
//   types are registered before main's first request (agent.offer keeps them out of its listing, below);
// - asks Claude Code's permission decision for a write it never makes every PLAN_POLL_MS and tells the server when main
//   went into plan mode or out of it (POST /api/module/mode), which no event of Claude Code's says while main is idle;
// - holds GET /api/module/next and handles the requests one at a time, in order, so a role's registration and the
//   spawn that needs it are never split by another request: register (all roles again), spawn (register the role with
//   the run's values if they differ, $.agent.spawn with no `model`, then the one-line note the server rendered), send
//   (register if needed, then SendMessage), stop (TaskStop of the agent and of the shells the server names), abort
//   (the analyst's Stop of main: $.turn.abort of main's running turn, by the id its turn.start carried, answered once
//   that turn completed or ABORT_WAIT_MS passed, after a TaskStop of each command of that turn the abort moved to the
//   background, where Esc would have ended it), note ($.session.append). It never starts, sends or stops anything the
//   server did not ask for. A spawn of the call role, a model call's agent (backend/app/agent_call.py), carries `drop`,
//   the reason the terminal UI gives when it drops the agent's hand-back (callDone), and its type is never offered. A
//   spawn with `fork` (a model call that needs main's conversation, the view proposer's) spawns Claude Code's `fork`
//   type, with no registration and no note: the fork inherits main's context, model and effort, and its report is its
//   answer. A fork keeps main's tools and this module's hooks never see its calls (they skip the runs of agents this
//   module started), so the module lists each running fork in <home>/up/<session>/forks (forksFile), one agent id a
//   line, written again at each start and end, and the plugin's fork guard (bin/.thimble-watch --fork-guard, a
//   PreToolUse hook) refuses every tool call of an agent the file lists;
// - model calls (backend/app/model_call.py), which run at once, beside that queue, so many run together (BESIDE):
//   complete, one tool-less completion through the session's own API client and sign-in ($.model.complete, with an
//   AbortController that a later cancel aborts), and fork, one tool-less completion over main's own transcript
//   ($.model.fork). Neither is a subagent: no row in main, no tools, no permission asks. Each answers with the reply's
//   text and usage, or why there is none (modelAnswer); a request Claude Code refuses to send is an error. On local
//   transport the request's arguments and the answer are files of their own in the trusted folder (completions/<id>.json
//   and <id>.answer.json), so neither subagents.json nor module.json carries a prompt;
// - agent.offer and tool.call: thimble's types stay out of every model's agent listing, whose line for each spelled its
//   "All tools except …" list, until an agent of the type has started in the session. A type is offered while an Agent
//   call that names it runs, so main's typed starts and the orientation's own starts of its critic and helpers run as
//   before ($.agent.spawn is no offer), and while a SendMessage call runs. Once an agent of a type has started, the
//   type stays offered, since Claude Code checks the offer again when it resumes an agent: the orientation its critic
//   reports to, an agent a SendMessage continues;
// - agent.spawn: an Agent call for one of thimble's roles whose prompt's first line names a typed request, main's or a
//   subagent's (a subagent of main's own may start thimble's agents, as Claude Code lets a subagent start subagents;
//   a thread's fork makes none: main makes the call for it, tools._ask_main), gets that request's full model id, and
//   the agent it starts that request's effort, which turn.step sets on its every request;
//   a child of such an agent whose type is not thimble's gets the same effort (its model it inherits already). These
//   hooks never see a run of an agent this module started, which is why clicks register instead;
// - turn.start and turn.complete of main's own turns: the id of main's running turn, which abort names;
// - turn.complete: posts the end of each run of an agent it started (POST /api/module/ended), with why it ended and,
//   for a refusal, what the API said of it, since its other hooks skip those agents;
// - session.end: on /clear and /resume keeps its poll, waits for the new session id, says hello again under it,
//   refetches what the workspace's record holds and appends to the new main one note per running thimble agent; on
//   any other reason it stops polling.
// Its state lives in this module's memory, which /clear and /resume keep, with subagents.json as the record it
// refetches at session start and after a change of session; never in $.state, which both commands reset.
//
// Local transport (launch.json `transport: local`, module note) has no server, and the module makes no HTTP request
// there, even when server.json names a live server. It is main's when launch.json names its session, or one --rekey
// moved it to (the moves subagents.json records). It reads the roles from trusted/roles.json and registers them again
// whenever that file changes; as main it takes the requests addressed to it from subagents.json (entries of `requests`
// of kind `module` whose `module` is pending, for its session, not past `expires_at`), polling every FILE_POLL_MS, and
// handles them one at a time as it handles the long poll's; and it writes everything it says to trusted/module.json,
// which only main's module writes: its heartbeat every FILE_BEAT_MS, the requests it took, its answers, the ends of the
// runs it started, main's plan mode as its poll sees it, and what it could not register (backend/app/module_bridge.py
// has the file's form). After /clear it appends the notes --rekey left for the new main in subagents.json
// (`module.notes`).
import type { EngineInterface, Register } from 'claude-code'

import type { Activated } from './term/types'

type Engine = EngineInterface
type Json = Record<string, unknown>
type Effort = string | number
type Values = { model?: string; effort?: Effort | null }
type Spec = { name: string; description: string; prompt: string; model?: string; effort?: Effort } & Json
type Answer = Json
type Request = { id: string; op: string; args: Json; expires_in?: number }
type Server = { base: string; token: string }
type Reply = { status: number; data: Json }
type Hello = 'ok' | 'wait' | 'refused'
// what the file guard refuses (userconf.module_rules): absolute paths, each as spelled and as resolved
type Rules = { private: string[]; records: string[]; corpus: string | null; web_off: boolean; reasons: Record<string, string> }

export const PLUGIN = 'thimble'
// thimble's roles: each names its own model and effort, so a typed run's effort never goes to one of them
export const ROLES = ['orientation', 'critic', 'writer', 'view-builder', 'view-reviewer', 'check', 'dev-ticket', 'call']
// a model call's agent (backend/app/agent_call.py): never offered to a model, and its hand-back dropped (callDone)
const CALL = 'call'
/** A dropped hand-back's reason when the server named none (agent_call.DONE_DEFAULT). */
export const CALL_DONE = 'thimble finished a task'
// Claude Code's type of a fork of the spawning loop, which inherits its context (agent_call.py, a fork)
const FORK = 'fork'
/** The running forks of main's session, one agent id a line, which the fork guard reads (module note). */
export const forksFile = (home: string, session: string): string => `${home}/up/${session}/forks`
/** The requests that run at once, beside the queue of the others: thimble's model calls and their cancel (module note). */
export const BESIDE = new Set(['complete', 'fork', 'cancel'])
// a model call's id on local transport, which names its files in the trusted folder (module_bridge.COMPLETIONS)
const CALL_ID = /^[0-9a-f]{8,64}$/
export const RETRY_MS = 2000 // between hellos while no server accepts one, and after a failed poll
export const SESSION_WAIT_MS = 10000 // how long /clear's new session id is waited for
export const SESSION_TICK_MS = 25
const QUICK_MS = 1000 // a poll answered sooner than this with nothing is a server that is stopping
// how long abort waits for main's turn to complete after $.turn.abort, so that its answer comes once Claude Code has
// ended the turn
export const ABORT_WAIT_MS = 3000
// $.turn.abort's refusal when main's turn had ended already, or was ending (no turn runs, another turn runs, or this
// one is ending)
const NO_TURN = /no turn is running|is not the running turn|is already ending/i
// Claude Code's text when it runs as many subagents as it allows: the Agent tool's, and $.agent.spawn's when as many of
// this plugin's spawns run as CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS allows ("thimble: $.agent.spawn refused: 2 spawns are
// running at once", which it throws; live check L19)
const LIMIT = /concurrent subagent limit|spawns are running at once/i
const GONE = /is not running|no task found|could not be resumed|no transcript found/i
const QUEUED = /queued for delivery/i
const REQUEST_WORD = /[A-Za-z0-9_-]{8,64}/g // a request id on the first line of a typed start's prompt
const OFF = new Set(['', '0', 'false', 'no', 'off'])
// Claude Code tells no plugin of a mode change, so the module asks its permission decision for a write it never makes
// every PLAN_POLL_MS, and plan mode says so in the reason ("Cannot write to … while in plan mode"); the server hears a
// change at once, not at main's next turn (live check L21)
export const PLAN_POLL_MS = 2000
// never written; outside main's folder and every rule of thimble's, whose ask or deny would decide first and say nothing
// of plan mode
const PLAN_PROBE = '/tmp/.thimble-plan-probe'
const PLAN_REASON = /\bplan mode\b/i

// local transport (module note)
export const FILE_POLL_MS = 500 // how often subagents.json and roles.json are looked at
export const FILE_BEAT_MS = 2000 // the heartbeat in module.json; module_bridge counts a module live while it is fresh
const KEPT = 64 // the requests taken, the answers and the ends module.json keeps, the newest
const TYPED_LIVE = new Set(['', 'pending', 'claimed']) // module_bridge.TYPED_LIVE
const MODULE_KIND = 'module' // subagent_files.MODULE_KIND

// the file guard (module note): the tools whose path it reads, those of them that edit, those that search a folder
// (their `path`, else the working directory), and the web tools
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SEARCH_TOOLS = new Set(['Grep', 'Glob'])
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch'])
// in thimble's home (userconf.private_paths): the token files, the press's sign-in files and one-time links, and the
// sessions' activation files with their guide markers
const PRIVATE_NAMES = ['server.json', 'session.key', 'paired.json', 'open', 'links', 'up']
// what a Bash command may not name under thimble's home once thimble is on in the session (build spec S5)
const BASH_PRIVATE = ['server.json', 'session.key', 'paired.json', 'links', 'open']
// what a refusal of a token file says before the server's rules came: prompts/tools.md's module-deny-private
export const PRIVATE_FALLBACK = "thimble refused this call, since it keeps its token files (server.json, session.key, paired.json and the links folder in thimble's home) out of reach of the file tools of its sessions. Do the task without them."
const REFUSED = 'thimble refused this call.' // a refusal whose reason the rules lack

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown): string => (typeof v === 'string' ? v : '')
const roleOf = (type: string): string => (type.startsWith(`${PLUGIN}:`) && ROLES.includes(type.slice(PLUGIN.length + 1)) ? type.slice(PLUGIN.length + 1) : '')

// --------------------------------------------------------------------------------------------------- the proof

const encoder = new TextEncoder()

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data))
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

/** HMAC-SHA256 as hex, built on crypto.subtle.digest, the one digest this environment offers (app/hook_auth.py sign). */
export async function hmac(key: string, message: string): Promise<string> {
  let k = encoder.encode(key)
  if (k.length > 64) k = await sha256(k)
  const block = new Uint8Array(64)
  block.set(k)
  const body = encoder.encode(message)
  const inner = new Uint8Array(64 + body.length)
  inner.set(block.map(b => b ^ 0x36))
  inner.set(body, 64)
  const innerHash = await sha256(inner)
  const outer = new Uint8Array(64 + innerHash.length)
  outer.set(block.map(b => b ^ 0x5c))
  outer.set(innerHash, 64)
  return hex(await sha256(outer))
}

/** thimble's home: THIMBLE_HOME, else ~/.thimble. */
async function thimbleHome($: Engine): Promise<string> {
  const homeDir = (await $.env.get('HOME')) ?? ''
  const home = (await $.env.get('THIMBLE_HOME')) || `${homeDir}/.thimble`
  return home.startsWith('~/') ? `${homeDir}${home.slice(1)}` : home
}

/** <THIMBLE_HOME>/server.json's API base and token (`api`, then `port`, as bin/thimble-mcp reads it); null without. */
async function findServer($: Engine): Promise<Server | null> {
  const home = await thimbleHome($)
  let data: unknown
  try {
    data = JSON.parse(await $.fs.read(`${home}/server.json`))
  } catch {
    return null
  }
  if (!isObj(data) || !text(data.token)) return null
  const port = Number(data.port)
  const base = text(data.api) ? text(data.api).replace(/\/+$/, '') : Number.isInteger(port) && port > 0 ? `http://127.0.0.1:${port}` : ''
  return base ? { base, token: text(data.token) } : null
}

// --------------------------------------------------------------------------------------------------- the module
// One State per load of the module (register runs once per load); the functions below take `$` and it. Claude Code's
// check of a module (claude plugin validate) allows `$` to pass only to plain functions, never to a method.

type Ended = { n: number; agentId: string; answer: string; reason: string; refusal?: Json; at: number }
type Out = {
  session: string; version: string; load: string; beat: number; plan: boolean | null; plan_at: number; problem: string
  taken: string[]; answers: Record<string, Answer>; ended: Ended[]; gone?: boolean
}

type State = {
  active: boolean // thimble is on in this interactive session (the scope check passed) and it has not ended
  interactive: boolean // session.start said the session is interactive
  user: string // $HOME, for a path that starts with ~
  home: string // thimble's home, as spelled
  homeReal: string // and resolved, '' when it does not resolve
  rules: Rules | null // what the file guard refuses (null until the scope check passed)
  file: boolean // local transport: the trusted folder, not the server (module note)
  peer: boolean // on local transport, a session that is not main: it registers the types, takes no requests, writes nothing
  rechecking: Promise<boolean> | null // launch.json read again (recheck), one look at a time
  ws: string // the workspace folder
  out: Out // what module.json holds, on local transport
  writing: Promise<void> // module.json's writes, one at a time
  stamps: Record<string, string> // the files' stamps (mtime and size) as last read, on local transport
  n: number // the ends written to module.json, on local transport
  cwd: string
  session: string // main's session id, as the server accepted it
  version: string
  gen: number // a poll whose generation is past stops
  server: Server | null
  roles: Record<string, Spec> // the roles as Settings name them (GET /api/module/roles)
  registered: Record<string, Spec> // what each role is registered with now
  efforts: Record<string, Effort> // agent id -> the effort turn.step sets (typed runs and their children)
  requests: Record<string, { role: string; values: Values }> // typed starts waiting for main's Agent call
  started: Set<string> // agents this module spawned: their turn.complete is posted
  checks: Map<string, string> // agents of thimble's check role, this module's spawns and main's Agent calls: each one's check (checkName)
  calls: Map<string, string> // agents of the call role this module spawned: the reason their dropped hand-back gives (callDone)
  forks: Set<string> // the forks of main this module spawned that run now, which forksFile lists for the fork guard
  completions: Map<string, AbortController> // the completions that run now, by their request's id (a cancel aborts one)
  queue: Promise<void> // the requests, one at a time
  helloing: { sid: string; said: Promise<Hello> } | null
  leaving: string // the session /clear or /resume is taking main away from, until the new one is known
  plan: boolean | null // whether main's session was in plan mode at the last look, as the server heard it
  turn: string // main's running model turn: the id its turn.start carried, '' once it completed
  turnEnded: (() => void)[] // what waits for the end of `turn` (abortTurn)
  dispatching: Map<string, number> // thimble's types an Agent or SendMessage call offers while it runs, with how many
  used: Set<string> // thimble's types an agent of which started in this session: offered from then on (agent.offer)
}

function fresh(): State {
  return {
    active: false, interactive: false, user: '', home: '', homeReal: '', rules: null,
    cwd: '', session: '', version: '', gen: 0, server: null, roles: {}, registered: {}, efforts: {},
    requests: {}, started: new Set(), checks: new Map(), calls: new Map(), forks: new Set(), completions: new Map(), queue: Promise.resolve(), helloing: null, leaving: '', plan: null, turn: '', turnEnded: [],
    dispatching: new Map(), used: new Set(),
    file: false, peer: false, rechecking: null, ws: '', writing: Promise.resolve(), stamps: {}, n: 0,
    out: { session: '', version: '', load: '', beat: 0, plan: null, plan_at: 0, problem: '', taken: [], answers: {}, ended: [] },
  }
}

/** Whether `type` is one of the types this module registers (thimble:<role>, the helper and the extensions' agents). */
const ours = (m: State, type: string): boolean => type.startsWith(`${PLUGIN}:`) && Object.prototype.hasOwnProperty.call(m.roles, type.slice(PLUGIN.length + 1))

/** Every type this module registers, as Claude Code names it. */
const allOurs = (m: State): string[] => Object.keys(m.roles).map(name => `${PLUGIN}:${name}`)

/** The types of thimble's a call offers while it runs (agent.offer): the one an Agent call names, and all of them for a
 *  SendMessage, which names an agent by its id and may resume it; none for any other call. */
function dispatched(m: State, e: Json): string[] {
  if (e.tool === 'SendMessage') return allOurs(m)
  if (e.tool !== 'Agent' && e.tool !== 'Task') return []
  const type = text(e.subagent_type)
  return ours(m, type) ? [type] : []
}

/** `go` (the call) with `types` offered while it runs: counted, since the orientation starts several helpers at once. */
async function offering<T>(m: State, types: string[], go: () => Promise<T>): Promise<T> {
  for (const type of types) m.dispatching.set(type, (m.dispatching.get(type) ?? 0) + 1)
  try {
    return await go()
  } finally {
    for (const type of types) {
      const left = (m.dispatching.get(type) ?? 1) - 1
      if (left > 0) m.dispatching.set(type, left)
      else m.dispatching.delete(type)
    }
  }
}

const where = (m: State): string => new URLSearchParams({ cwd: m.cwd, session: m.session }).toString()

function stop(m: State): void {
  m.active = false
  m.gen += 1
}

/** A refused hello (the server follows another session as main): idle; the end of main's next turn looks again. */
function refuse(m: State): void {
  stop(m)
}

// ------------------------------------------------------------------------------------------------ the server

async function call($: Engine, m: State, method: string, path: string, body?: Json): Promise<Reply | null> {
  const server = m.server ?? (m.server = await findServer($))
  if (!server) return null
  // app/hook_auth.py's headers: the nonce's time and the port make the proof good on that port alone, for a few minutes,
  // once, so a process that holds the recorded port while thimble's server runs on another gains nothing from it
  const nonce = `${Math.floor(Date.now() / 1000)}.${hex(crypto.getRandomValues(new Uint8Array(16)))}`
  const port = /:(\d+)$/.exec(server.base)?.[1] ?? '80'
  const headers: Record<string, string> = { 'x-thimble-nonce': nonce, 'x-thimble-auth': await hmac(server.token, `hook@${port}:${nonce}`) }
  let payload: string | undefined
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  let r
  try {
    r = await $.http.fetch(`${server.base}${path}`, { method, headers, body: payload })
  } catch {
    m.server = null // the next call reads server.json again: a restarted server may have another port or token
    return null
  }
  if ((r.headers['x-thimble-proof'] ?? '') !== (await hmac(server.token, `server:${nonce}`))) {
    m.server = null // not thimble's server: believe nothing it says
    return null
  }
  let data: unknown = {}
  try {
    data = r.text ? JSON.parse(r.text) : {}
  } catch {
    data = {}
  }
  return { status: r.status, data: isObj(data) ? data : {} }
}

/** One hello per session at a time: 'ok' when the server accepted this session, 'refused' when it never will, else
 *  'wait'. An answer for a session this module has since left (/clear came meanwhile) counts as 'wait'. */
function hello($: Engine, m: State, problem = ''): Promise<Hello> {
  const sid = m.session
  if (m.helloing && m.helloing.sid === sid && !problem) return m.helloing.said
  const said = (async (): Promise<Hello> => {
    const r = await call($, m, 'POST', '/api/module/hello', { cwd: m.cwd, session: sid, version: m.version, problem })
    if (m.session !== sid || !r) return 'wait'
    if (r.status === 200 && r.data.ok === true) return 'ok'
    if (r.status === 403) return sid === m.leaving ? 'wait' : 'refused' // the server moved main first
    // 404, a folder the server does not know yet: a server that is starting
    return 'wait'
  })().finally(() => {
    if (m.helloing?.said === said) m.helloing = null
  })
  if (!problem) m.helloing = { sid, said }
  return said
}

async function fetchRoles($: Engine, m: State): Promise<boolean> {
  const r = await call($, m, 'GET', `/api/module/roles?${where(m)}`)
  if (!r || r.status !== 200 || !isObj(r.data.roles)) return false
  const roles: Record<string, Spec> = {}
  for (const [name, spec] of Object.entries(r.data.roles)) {
    if (isObj(spec) && text(spec.model) && text(spec.prompt)) roles[name] = { ...spec, name, description: text(spec.description), prompt: text(spec.prompt), background: true } as Spec
  }
  m.roles = roles
  m.rules = parseRules(m, r.data.rules) ?? m.rules
  return true
}

/** What subagents.json holds: the per-run efforts, the typed starts, the agents this module started. The notes it
 *  answers for the running agents are returned, for a new main after /clear or /resume. */
async function fetchState($: Engine, m: State): Promise<string[]> {
  if (m.file) {
    await fetchStateFile($, m)
    return []
  }
  const r = await call($, m, 'GET', `/api/module/state?${where(m)}`)
  if (!r || r.status !== 200) return []
  if (isObj(r.data.efforts)) {
    for (const [id, effort] of Object.entries(r.data.efforts)) {
      if (typeof effort === 'string' || typeof effort === 'number') m.efforts[id] = effort
    }
  }
  if (isObj(r.data.requests)) {
    const requests: State['requests'] = {}
    for (const [id, req] of Object.entries(r.data.requests)) {
      if (isObj(req) && text(req.role)) requests[id] = { role: text(req.role), values: isObj(req.values) ? (req.values as Values) : {} }
    }
    m.requests = requests
  }
  if (isObj(r.data.agents)) {
    for (const [id, agent] of Object.entries(r.data.agents)) if (isObj(agent) && agent.plugin_started === true) m.started.add(id)
  }
  return Array.isArray(r.data.notes) ? r.data.notes.filter((n): n is string => typeof n === 'string' && n !== '') : []
}

async function registerAll($: Engine, m: State): Promise<void> {
  const problems: string[] = []
  m.registered = {}
  for (const [name, spec] of Object.entries(m.roles)) {
    try {
      await $.agent.register(spec as Parameters<Engine['agent']['register']>[0])
      m.registered[name] = spec
    } catch (err) {
      problems.push(`${PLUGIN}:${name}: ${String(err)}`)
    }
  }
  if (problems.length) await say($, m, `Claude Code did not register ${problems.join('; ')}`)
}

/** What the module could not do: in the hello's `problem` (over HTTP), or module.json's (local transport). */
async function say($: Engine, m: State, problem: string): Promise<void> {
  if (!m.file) {
    await hello($, m, problem)
    return
  }
  m.out.problem = problem
  await writeOut($, m)
}

// ------------------------------------------------------------------------------------------------ the session

/** Once the scope check passed (module note): thimble's home as spelled and resolved, and the file guard's rules until
 *  the server's come (only the token files). */
async function prepare($: Engine, m: State): Promise<void> {
  m.user = (await $.env.get('HOME')) ?? ''
  m.home = normal(m, await thimbleHome($))
  const st = await $.fs.stat(m.home, { resolve: true }).catch(() => undefined)
  m.homeReal = st?.realPath ?? ''
  if (!m.rules) m.rules = fallbackRules(m)
}

/** Main on the server's transport (start, or recheck at the switch): hello, roles and registrations, then the long poll.
 *  While no server accepts the hello it says it again every RETRY_MS: a server that died stays the transport (H7). */
async function begin($: Engine, m: State, cwd: string): Promise<void> {
  await prepare($, m)
  m.cwd = cwd
  m.session = await $.session.id()
  await staleForks($, m)
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))
    m.version = isObj(manifest) ? text(manifest.version) : ''
  } catch {
    m.version = ''
  }
  // a server that is up now: hello, roles and registrations before this returns, so the types are registered in the
  // turn that turned thimble on
  const first = await connect($, m)
  if (first === 'refused') return refuse(m)
  const gen = m.gen
  void (async () => {
    let state: Hello = first
    while (state === 'wait' && m.active && gen === m.gen) {
      await $.clock.sleep(RETRY_MS)
      state = await connect($, m)
    }
    if (gen !== m.gen) return
    if (state === 'ok') {
      void watchPlan($, m, gen)
      await poll($, m, gen)
    } else if (state === 'refused') refuse(m)
  })()
}

/** Every PLAN_POLL_MS: whether main's session is in plan mode now (Claude Code's decision for a write the module never
 *  makes, PLAN_REASON), posted to the server when it changed. */
async function watchPlan($: Engine, m: State, gen: number): Promise<void> {
  while (m.active && gen === m.gen) {
    await $.clock.sleep(PLAN_POLL_MS)
    if (!m.active || gen !== m.gen) return
    let plan: boolean
    try {
      const got = await $.tool.check({ tool: 'Write', input: { file_path: PLAN_PROBE, content: '' } } as Parameters<Engine['tool']['check']>[0])
      plan = PLAN_REASON.test(text((got as Json).reason))
    } catch {
      continue
    }
    if (plan === m.plan) continue
    if (m.file) {
      m.plan = plan
      m.out.plan = plan
      m.out.plan_at = Date.now()
      await writeOut($, m)
      continue
    }
    const r = await call($, m, 'POST', '/api/module/mode', { cwd: m.cwd, session: m.session, plan })
    if (r?.status === 200) m.plan = plan
  }
}

async function connect($: Engine, m: State): Promise<Hello> {
  const said = await hello($, m)
  if (said !== 'ok') return said
  await fetchState($, m)
  if (await fetchRoles($, m)) await registerAll($, m)
  else await hello($, m, 'thimble’s module could not fetch the roles it registers')
  return 'ok'
}

async function poll($: Engine, m: State, gen: number): Promise<void> {
  while (m.active && gen === m.gen) {
    const asked = Date.now()
    const r = await call($, m, 'GET', `/api/module/next?${where(m)}`)
    if (!m.active || gen !== m.gen) return
    if (r?.status === 200 && isObj(r.data.request)) {
      take($, m, r.data.request as Request)
      continue
    }
    if (r?.status === 204) {
      // a server holds a poll up to 25 s; one that answers at once is stopping, and is not asked again at once
      if (Date.now() - asked < QUICK_MS) await $.clock.sleep(RETRY_MS)
      continue
    }
    if (r?.status === 409 && m.leaving && m.session === m.leaving) {
      await $.clock.sleep(SESSION_TICK_MS) // main is moving: follow says hello under the new id
      continue
    }
    if (r?.status === 409) {
      // not the accepted session (a server that restarted, or main moved): say hello again
      const said = await hello($, m)
      if (said === 'refused') return refuse(m)
      if (said === 'ok') continue
    }
    await $.clock.sleep(RETRY_MS)
  }
}

function take($: Engine, m: State, req: Request): void {
  if (BESIDE.has(req.op)) {
    void (async () => {
      const answer = await modelCall($, m, req.id, req.op, isObj(req.args) ? req.args : {})
      if (req.op !== 'cancel') await call($, m, 'POST', '/api/module/result', { cwd: m.cwd, session: m.session, id: req.id, answer })
    })().catch(() => undefined)
    return
  }
  const received = Date.now()
  m.queue = m.queue
    .then(async () => {
      const late = typeof req.expires_in === 'number' && Date.now() - received > req.expires_in
      const answer = late ? { error: 'the request expired before thimble’s module reached it' } : await handle($, m, req)
      await call($, m, 'POST', '/api/module/result', { cwd: m.cwd, session: m.session, id: req.id, answer })
    })
    .catch(() => undefined)
}

async function handle($: Engine, m: State, req: Request): Promise<Answer> {
  const a = isObj(req.args) ? req.args : {}
  const values = isObj(a.values) ? (a.values as Values) : undefined
  try {
    switch (req.op) {
      case 'register':
        if (!(await (m.file ? readRoles($, m) : fetchRoles($, m)))) return { error: 'the roles could not be fetched' }
        await registerAll($, m)
        return { ok: true }
      case 'spawn':
        if (a.fork === true) return await spawnFork($, m, text(a.prompt), text(a.description), text(a.drop))
        return await spawn($, m, text(a.role), text(a.prompt), text(a.description), values, text(a.note), text(a.drop))
      case 'send':
        return await send($, m, text(a.agent), text(a.text), text(a.role), values)
      case 'stop':
        return await stopAgent($, text(a.agent), Array.isArray(a.shells) ? a.shells.map(text).filter(Boolean) : [])
      case 'abort':
        return await abortTurn($, m)
      case 'note':
        return await note($, text(a.text))
      default:
        return { error: `thimble’s module has no op ${req.op}` }
    }
  } catch (err) {
    const why = String(err)
    return LIMIT.test(why) ? { limit: why } : { error: why }
  }
}

/** The role registered with `values` (the run's model and effort) when they differ from its registration now. */
async function ensure($: Engine, m: State, role: string, values: Values | undefined): Promise<void> {
  const base = m.roles[role]
  if (!base) throw new Error(`thimble’s role ${role} is not registered in this session`)
  const want: Spec = { ...base }
  if (values && text(values.model)) want.model = text(values.model)
  if (values && 'effort' in values) {
    if (values.effort === null || values.effort === undefined || values.effort === '') delete want.effort
    else want.effort = values.effort
  }
  const have = m.registered[role]
  if (have && have.model === want.model && have.effort === want.effort && have.prompt === want.prompt) return
  await $.agent.register(want as Parameters<Engine['agent']['register']>[0])
  m.registered[role] = want
}

async function spawn($: Engine, m: State, role: string, prompt: string, description: string, values: Values | undefined, line: string, drop = ''): Promise<Answer> {
  await ensure($, m, role, values)
  // no `model`: a spawn takes only an alias; the registration carries the full id
  const r = await $.agent.spawn({ subagentType: `${PLUGIN}:${role}`, prompt, description })
  if (r.deny !== undefined) return LIMIT.test(r.deny) ? { limit: r.deny } : { deny: r.deny }
  if (!r.agentId) return { error: 'Claude Code started no agent' }
  m.started.add(r.agentId)
  if (role === 'check') m.checks.set(r.agentId, checkOf(description))
  // a model call's type stays out of every listing: no model starts one or sends to one (agent.offer)
  if (role === CALL) m.calls.set(r.agentId, drop || CALL_DONE)
  else m.used.add(`${PLUGIN}:${role}`)
  if (line) await note($, line.split('{agent}').join(r.agentId))
  return { agentId: r.agentId, model: r.model }
}

/** A model call's fork of main (module note): Claude Code's fork type, no registration, no note; listed for the fork
 *  guard, and its hand-back dropped as a call agent's. */
async function spawnFork($: Engine, m: State, prompt: string, description: string, drop: string): Promise<Answer> {
  const r = await $.agent.spawn({ subagentType: FORK, prompt, description })
  if (r.deny !== undefined) return LIMIT.test(r.deny) ? { limit: r.deny } : { deny: r.deny }
  if (!r.agentId) return { error: 'Claude Code started no agent' }
  m.started.add(r.agentId)
  m.calls.set(r.agentId, drop || CALL_DONE)
  m.forks.add(r.agentId)
  await writeForks($, m)
  return { agentId: r.agentId, model: r.model }
}

/** forksFile written whole with the forks that run now; empty when none runs, which the guard's first shell line reads
 *  as nothing to guard. */
async function writeForks($: Engine, m: State): Promise<void> {
  if (!m.home || !m.session) return
  await $.fs.write(forksFile(m.home, m.session), [...m.forks].map(id => `${id}\n`).join('')).catch(() => undefined)
}

/** A list of forks an earlier load left (Claude Code quit while one ran, then this session was resumed) emptied, so the
 *  guard's first shell line exits again; no file is made where there is none. */
async function staleForks($: Engine, m: State): Promise<void> {
  if (m.forks.size > 0 || !m.home || !m.session) return
  const st = await $.fs.stat(forksFile(m.home, m.session)).catch(() => undefined)
  if (st && st.size > 0) await writeForks($, m)
}

/** A model call's text blocks as $.model.complete takes them, from the server's (a string is one block); undefined for
 *  none. */
function blocks(v: unknown): { text: string; cache?: true }[] | undefined {
  const all = typeof v === 'string' ? [{ text: v }] : Array.isArray(v) ? v.filter(isObj) : []
  const out = all.filter(b => text(b.text) !== '').map(b => (b.cache === true ? { text: text(b.text), cache: true as const } : { text: text(b.text) }))
  return out.length ? out : undefined
}

/** What a model call resolved to, as the server reads it (module_bridge._model_answer): the reply's text and usage, or
 *  why there is none, with the HTTP status and the error's kind for an API error. */
export function modelAnswer(r: Json): Answer {
  if (r.isAnswered === true) return { text: text(r.text), usage: r.usage }
  const reason = text(r.reason) || 'empty-reply'
  const api = reason === 'api-error' ? { status: typeof r.status === 'number' ? r.status : null, kind: text(r.error) || 'unknown' } : {}
  return { failed: reason, ...api, ...(isObj(r.usage) ? { usage: r.usage } : {}) }
}

/** A model call's arguments on local transport: its request file in the trusted folder (module note). */
async function callArgs($: Engine, m: State, id: string): Promise<Json> {
  if (!CALL_ID.test(id)) throw new Error('the model call names no request file of its own')
  const got = await readJson($, trusted(m, `completions/${id}.json`))
  if (!got) throw new Error('the model call’s request file could not be read')
  return got
}

/** One model call (module note): `complete` through $.model.complete with an AbortController that a `cancel` naming the
 *  request aborts, `fork` through $.model.fork (which nothing aborts), `cancel` itself. Never throws: a request Claude
 *  Code refuses to send (a model the organization does not allow, a bad cap) is an `error`. */
async function modelCall($: Engine, m: State, id: string, op: string, a: Json): Promise<Answer> {
  if (op === 'cancel') {
    m.completions.get(text(a.request))?.abort()
    return { ok: true }
  }
  const stop = new AbortController()
  if (op === 'complete') m.completions.set(id, stop) // before any wait, so a cancel taken next finds it
  try {
    const args = text(a.call) ? await callArgs($, m, text(a.call)) : a
    if (stop.signal.aborted) return { failed: 'aborted' }
    if (op === 'fork') return modelAnswer((await $.model.fork({ prompt: text(args.prompt) })) as unknown as Json)
    const prompt = blocks(args.prompt)
    if (!prompt || !text(args.model)) return { error: 'a model call with no model or no prompt' }
    const system = blocks(args.system)
    const request = {
      model: text(args.model), prompt, ...(system ? { system } : {}),
      ...(typeof args.maxTokens === 'number' ? { maxTokens: args.maxTokens } : {}),
      ...(text(args.effort) ? { effort: text(args.effort) } : {}),
      ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
    }
    return modelAnswer((await $.model.complete(request as Parameters<Engine['model']['complete']>[0], { signal: stop.signal })) as unknown as Json)
  } catch (err) {
    return { error: String(err) }
  } finally {
    if (m.completions.get(id) === stop) m.completions.delete(id)
  }
}

async function send($: Engine, m: State, agent: string, message: string, role: string, values: Values | undefined): Promise<Answer> {
  if (role && m.roles[role]) await ensure($, m, role, values)
  const r = await offering(m, allOurs(m), () => $.tool.call({ tool: 'SendMessage', to: agent, message } as Parameters<Engine['tool']['call']>[0]))
  if (r.deny !== undefined) return { deny: r.deny }
  const said = text(r.text)
  if (r.isError) return { error: said || 'SendMessage failed', ...(GONE.test(said) ? { gone: true } : {}) }
  const result = (r as { result?: unknown }).result
  if (isObj(result) && result.success === false) {
    const why = text(result.message) || said
    return { error: why, ...(GONE.test(why) ? { gone: true } : {}) }
  }
  return { agentId: agent, text: said, queued: QUEUED.test(said) }
}

async function stopAgent($: Engine, agent: string, shells: string[] = []): Promise<Answer> {
  const r = await $.tool.call({ tool: 'TaskStop', task_id: agent } as Parameters<Engine['tool']['call']>[0])
  // the background shells the agent started, which Claude Code's TaskStop of the agent leaves running; one that has
  // ended already answers an error, which changes nothing
  for (const shell of shells) await $.tool.call({ tool: 'TaskStop', task_id: shell } as Parameters<Engine['tool']['call']>[0]).catch(() => undefined)
  if (r.deny !== undefined) return { deny: r.deny }
  const said = text(r.text)
  if (r.isError) return { error: said || 'TaskStop failed', ...(GONE.test(said) ? { gone: true } : {}) }
  return { agentId: agent, text: said }
}

/** The analyst's Stop of main: main's running turn ended as Esc in the terminal ends it, with $.turn.abort and the id its
 *  turn.start carried, answered once the turn completed or ABORT_WAIT_MS passed, and the commands the abort moved to the
 *  background stopped (stopMoved); `gone` when no turn of main's runs. */
async function abortTurn($: Engine, m: State): Promise<Answer> {
  const turn = m.turn
  if (!turn) return { error: 'main is not running a turn', gone: true }
  try {
    await $.turn.abort({ turnId: turn })
  } catch (err) {
    const why = String(err)
    return NO_TURN.test(why) ? { error: why, gone: true } : { error: why }
  }
  if (m.turn === turn) await Promise.race([new Promise<void>(resolve => m.turnEnded.push(resolve)), $.clock.sleep(ABORT_WAIT_MS)])
  await stopMoved($)
  return { ok: true }
}

/** Where Esc ends a command that runs, $.turn.abort moves it to the background (Claude Code's backgroundedByTurnAbort on
 *  the call's stored result), where it runs on and its end starts a new turn of main's (live check L4-12l). Once the
 *  stopped turn ended, each such command of it, read from main's messages back to the turn's prompt (a user message with
 *  no tool results), is stopped with TaskStop; one that has ended already answers an error, which changes nothing. */
async function stopMoved($: Engine): Promise<void> {
  const rows: unknown = await $.session.messages().catch(() => [])
  if (!Array.isArray(rows)) return
  const shells = new Set<string>()
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (!isObj(row)) continue
    const results = Array.isArray(row.toolResults) ? row.toolResults : []
    if (row.role === 'user' && !results.length) break
    for (const one of [...(Array.isArray(row.toolUses) ? row.toolUses : []), ...results]) {
      const result = isObj(one) ? one.result : undefined
      if (isObj(result) && result.backgroundedByTurnAbort === true && text(result.backgroundTaskId)) shells.add(text(result.backgroundTaskId))
    }
  }
  for (const shell of shells) await $.tool.call({ tool: 'TaskStop', task_id: shell } as Parameters<Engine['tool']['call']>[0]).catch(() => undefined)
}

async function note($: Engine, line: string): Promise<Answer> {
  if (!line) return { error: 'an empty note' }
  const r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: line }] } })
  return r.deny !== undefined ? { deny: r.deny } : { ok: true }
}

/** The typed start a prompt's first line names, for `role`: from memory, else from the record fetched again. */
async function typedStart($: Engine, m: State, prompt: string, role: string): Promise<{ id: string; values: Values } | null> {
  const words = (prompt.split('\n', 1)[0] ?? '').match(REQUEST_WORD) ?? []
  if (!words.length) return null
  const find = () => {
    for (const id of words) {
      const req = m.requests[id]
      if (req && req.role === role) return { id, values: req.values }
    }
    return null
  }
  const known = find()
  if (known) return known
  await fetchState($, m)
  return find()
}

/** After /clear or /resume: the new session id, a hello under it, the record again, and a note per running agent. */
async function follow($: Engine, m: State, old: string): Promise<void> {
  m.leaving = old
  let sid = old
  for (let waited = 0; waited < SESSION_WAIT_MS && sid === old; waited += SESSION_TICK_MS) {
    await $.clock.sleep(SESSION_TICK_MS)
    sid = await $.session.id()
  }
  if (m.leaving === old) m.leaving = ''
  if (!m.active || sid === old) return
  m.session = sid
  let said = await hello($, m)
  while (said === 'wait' && m.active && m.session === sid) {
    await $.clock.sleep(RETRY_MS)
    said = await hello($, m)
  }
  if (said === 'refused') return refuse(m)
  if (said !== 'ok' || m.session !== sid) return
  for (const line of await fetchState($, m)) await note($, line)
}

/** What main's (or an agent's) Agent call starts with: a typed start's model, and the effort its agent and that
 *  agent's children of no thimble type run at. A typed start is found by the request its prompt's first line names,
 *  whoever makes the call: main, a subagent of main's own whose start tool call made the request, or the
 *  orientation for its critic. Never fails the call: a lookup that fails changes nothing. */
async function spawning($: Engine, m: State, e: { subagentType?: string; parentAgentId?: string; prompt?: string }): Promise<{ model?: string; effort?: Effort; typed?: string }> {
  try {
    const type = e.subagentType ?? ''
    const role = roleOf(type)
    if (role) {
      const typed = await typedStart($, m, e.prompt ?? '', role)
      if (!typed) return {}
      const effort = typed.values.effort
      return {
        typed: typed.id,
        ...(text(typed.values.model) ? { model: text(typed.values.model) } : {}),
        ...(effort !== null && effort !== undefined && effort !== '' ? { effort } : {}),
      }
    }
    if (e.parentAgentId && !type.startsWith(`${PLUGIN}:`) && m.efforts[e.parentAgentId] !== undefined) return { effort: m.efforts[e.parentAgentId] }
  } catch {
    // the call goes on as Claude Code made it
  }
  return {}
}

// ------------------------------------------------------------------------------------------------ local transport

async function readJson($: Engine, path: string): Promise<Json | null> {
  try {
    const data = JSON.parse(await $.fs.read(path))
    return isObj(data) ? data : null
  } catch {
    return null
  }
}

/** A file's stamp (mtime and size), '' when it is missing. */
async function stamp($: Engine, path: string): Promise<string> {
  try {
    const st = await $.fs.stat(path)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return ''
  }
}

const trusted = (m: State, name: string): string => `${m.ws}/trusted/${name}`

/** Session `sid` followed through the moves --rekey recorded (subagents.json `module.rekeyed`). */
function movedTo(state: Json, sid: string): string {
  const moves = isObj(state.module) && isObj(state.module.rekeyed) ? (state.module.rekeyed as Json) : {}
  const seen = new Set<string>()
  while (sid && typeof moves[sid] === 'string' && !seen.has(sid)) {
    seen.add(sid)
    sid = moves[sid] as string
  }
  return sid
}

/** module.json written whole, one write at a time, with a fresh heartbeat (module note); never by a peer. */
function writeOut($: Engine, m: State): Promise<void> {
  if (m.peer) return m.writing
  m.writing = m.writing
    .then(async () => {
      m.out.beat = Date.now()
      await $.fs.write(trusted(m, 'module.json'), JSON.stringify(m.out))
    })
    .catch(() => undefined)
  return m.writing
}

async function readRoles($: Engine, m: State): Promise<boolean> {
  const got = await readJson($, trusted(m, 'roles.json'))
  if (!got || !isObj(got.roles)) return false
  const roles: Record<string, Spec> = {}
  for (const [name, spec] of Object.entries(got.roles)) {
    if (isObj(spec) && text(spec.model) && text(spec.prompt)) roles[name] = { ...spec, name, description: text(spec.description), prompt: text(spec.prompt), background: true } as Spec
  }
  m.roles = roles
  m.rules = parseRules(m, got.rules) ?? m.rules
  return true
}

/** module_bridge._efforts: the per-run efforts of the typed starts and their children of no thimble type, then the
 *  record's own. */
function effortsOf(state: Json): Record<string, Effort> {
  const agents = isObj(state.agents) ? Object.entries(state.agents).filter((x): x is [string, Json] => isObj(x[1])) : []
  const out: Record<string, Effort> = {}
  for (const [id, e] of agents) {
    const effort = isObj(e.values) ? e.values.effort : undefined
    if (text(e.type).startsWith(`${PLUGIN}:`) && !e.plugin_started && (typeof effort === 'string' || typeof effort === 'number') && effort !== '') out[id] = effort
  }
  for (let changed = true; changed;) {
    changed = false
    for (const [id, e] of agents) {
      const parent = text(e.parent)
      if (!(id in out) && parent in out && !text(e.type).startsWith(`${PLUGIN}:`)) {
        out[id] = out[parent] as Effort
        changed = true
      }
    }
  }
  if (isObj(state.efforts)) for (const [id, v] of Object.entries(state.efforts)) if ((typeof v === 'string' || typeof v === 'number') && v !== '') out[id] = v
  return out
}

/** What fetchState fetches over HTTP, from subagents.json: the per-run efforts, the typed starts waiting for an Agent
 *  call (module_bridge._typed), the agents this module started. */
async function fetchStateFile($: Engine, m: State): Promise<Json> {
  const state = (await readJson($, trusted(m, 'subagents.json'))) ?? {}
  Object.assign(m.efforts, effortsOf(state))
  const requests: State['requests'] = {}
  for (const table of ['pending', 'requests']) {
    if (!isObj(state[table])) continue
    for (const [id, r] of Object.entries(state[table] as Json)) {
      if (!isObj(r) || r.route !== 'typed' || (text(r.kind) || 'start') !== 'start' || !TYPED_LIVE.has(text(r.state))) continue
      requests[text(r.id) || id] = { role: text(r.role).replace(/^thimble:/, ''), values: isObj(r.values) ? (r.values as Values) : {} }
    }
  }
  m.requests = requests
  if (isObj(state.agents)) for (const [id, a] of Object.entries(state.agents)) if (isObj(a) && a.plugin_started === true) m.started.add(id)
  return state
}

/** The local transport's start (module note): main or a peer by launch.json, the roles from roles.json, the record,
 *  module.json (main's), then the poll of the files and, for main, the plan poll. */
async function fileBegin($: Engine, m: State, cwd: string, ws: string, launch: Json): Promise<void> {
  m.file = true
  m.ws = ws.replace(/\/+$/, '')
  m.cwd = cwd
  await prepare($, m)
  m.session = await $.session.id()
  await staleForks($, m)
  const state = (await readJson($, trusted(m, 'subagents.json'))) ?? {}
  m.peer = !isMain(launch, state, m.session)
  m.stamps.launch = await stamp($, trusted(m, 'launch.json'))
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))
    m.version = isObj(manifest) ? text(manifest.version) : ''
  } catch {
    m.version = ''
  }
  m.out = { ...m.out, session: m.session, version: m.version, load: hex(crypto.getRandomValues(new Uint8Array(8))), gone: false }
  await fetchStateFile($, m)
  m.stamps.roles = await stamp($, trusted(m, 'roles.json'))
  if (await readRoles($, m)) await registerAll($, m)
  else m.out.problem = 'thimble’s module could not read the roles it registers (trusted/roles.json)'
  await writeOut($, m)
  const gen = m.gen
  if (!m.peer) void watchPlan($, m, gen)
  void pollFiles($, m, gen)
}

const sids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [])

/** Whether session `sid` is main's by launch.json (its `session`, through the moves --rekey recorded), and neither a
 *  peer nor a session another took main from. */
function isMain(launch: Json, state: Json, sid: string): boolean {
  if (sids(launch.peers).includes(sid) || sids(launch.moved).includes(sid)) return false
  return text(launch.session) !== '' && movedTo(state, text(launch.session)) === sid
}

/** Whether launch.json makes main's transport the server's (app/subagent_files.py transport): `transport: server`, or
 *  0.8.0's `mode: browser`, or a record with neither. */
function serverOf(launch: Json): boolean {
  const kind = text(launch.transport)
  if (kind === 'local' || kind === 'server') return kind === 'server'
  return launch.mode !== 'terminal'
}

/** launch.json read again (module note): a peer that became main starts taking main's requests and writing
 *  module.json, main another took main from stops; main whose transport a press made the server's takes the requests
 *  still waiting in subagents.json (H5), then goes on over HTTP for the rest of the session. True when it switched. One
 *  look at a time. */
function recheck($: Engine, m: State): Promise<boolean> {
  if (!m.rechecking) m.rechecking = recheckNow($, m).finally(() => { m.rechecking = null })
  return m.rechecking
}

async function recheckNow($: Engine, m: State): Promise<boolean> {
  if (!m.active || !m.file) return false
  const launch = await readJson($, trusted(m, 'launch.json'))
  if (!launch) return false
  const state = (await readJson($, trusted(m, 'subagents.json'))) ?? {}
  const main = isMain(launch, state, m.session)
  if (main && serverOf(launch)) {
    if (m.peer) m.peer = false
    else await takeFile($, m)
    await m.queue
    m.gen += 1 // the files' polls stop
    m.file = false
    void begin($, m, m.cwd)
    return true
  }
  if (main && m.peer) {
    m.peer = false
    m.out = { ...m.out, session: m.session, version: m.version, load: hex(crypto.getRandomValues(new Uint8Array(8))), gone: false }
    await writeOut($, m)
    void watchPlan($, m, m.gen)
    await takeFile($, m)
  } else if (!main && !m.peer) {
    m.peer = true
  }
  return false
}

/** Every FILE_POLL_MS: launch.json read again when it changed (recheck), roles.json registered again when it changed,
 *  the requests subagents.json addresses to this module taken when it changed, and the heartbeat every FILE_BEAT_MS
 *  (module note). */
async function pollFiles($: Engine, m: State, gen: number): Promise<void> {
  let beat = Date.now()
  while (m.active && gen === m.gen) {
    try {
      const launch = await stamp($, trusted(m, 'launch.json'))
      if (launch !== m.stamps.launch) {
        m.stamps.launch = launch
        if (await recheck($, m)) return
      }
      const roles = await stamp($, trusted(m, 'roles.json'))
      if (roles && roles !== m.stamps.roles) {
        m.stamps.roles = roles
        if (await readRoles($, m)) {
          m.queue = m.queue.then(() => registerAll($, m)).catch(() => undefined)
          await m.queue
        }
      }
      const state = await stamp($, trusted(m, 'subagents.json'))
      if (state && state !== m.stamps.state) {
        m.stamps.state = state
        await takeFile($, m)
      }
      if (Date.now() - beat >= FILE_BEAT_MS) {
        beat = Date.now()
        await writeOut($, m)
      }
    } catch {
      // the next look tries again
    }
    await $.clock.sleep(FILE_POLL_MS)
  }
}

/** The requests subagents.json addresses to this module that it has not taken, oldest first, each taken (module.json
 *  `taken`) and handled in turn, its answer written under its id. */
async function takeFile($: Engine, m: State): Promise<void> {
  if (m.peer) return
  const state = await readJson($, trusted(m, 'subagents.json'))
  if (!state || !isObj(state.requests)) return
  const now = Date.now()
  const mine = Object.entries(state.requests)
    .filter((x): x is [string, Json] => isObj(x[1]) && x[1].kind === MODULE_KIND && x[1].module === 'pending' && !m.out.taken.includes(x[0])
      && (!text(x[1].session) || text(x[1].session) === m.session) && typeof x[1].expires_at === 'number' && x[1].expires_at * 1000 > now)
    .sort((a, b) => Number(a[1].asked_at ?? 0) - Number(b[1].asked_at ?? 0))
  if (!mine.length) return
  m.out.taken = [...m.out.taken, ...mine.map(([id]) => id)].slice(-KEPT)
  await writeOut($, m)
  for (const [id, r] of mine) {
    const req: Request = { id, op: text(r.op), args: isObj(r.args) ? r.args : {} }
    if (BESIDE.has(req.op)) {
      // a model call's answer is a file of its own beside its request's (module note)
      void (async () => {
        const answer = await modelCall($, m, id, req.op, req.args)
        const call = text(req.args.call)
        if (req.op !== 'cancel' && CALL_ID.test(call)) await $.fs.write(trusted(m, `completions/${call}.answer.json`), JSON.stringify(answer))
      })().catch(() => undefined)
      continue
    }
    const due = Number(r.expires_at) * 1000
    m.queue = m.queue
      .then(async () => {
        const answer = Date.now() > due ? { error: 'the request expired before thimble’s module reached it' } : await handle($, m, req)
        const answers = { ...m.out.answers, [id]: answer }
        m.out.answers = Object.fromEntries(Object.entries(answers).slice(-KEPT))
        await writeOut($, m)
      })
      .catch(() => undefined)
  }
}

/** After /clear or /resume on local transport: the new session id, the move --rekey recorded to it, module.json under
 *  it, the record again, and the notes --rekey left for the new main (subagents.json `module.notes`). */
async function followFile($: Engine, m: State, old: string): Promise<void> {
  let sid = old
  for (let waited = 0; waited < SESSION_WAIT_MS && sid === old; waited += SESSION_TICK_MS) {
    await $.clock.sleep(SESSION_TICK_MS)
    sid = await $.session.id()
  }
  if (!m.active || sid === old) return
  let state: Json = {}
  for (let waited = 0; waited < SESSION_WAIT_MS; waited += RETRY_MS / 4) {
    state = (await readJson($, trusted(m, 'subagents.json'))) ?? {}
    if (movedTo(state, old) === sid) break
    await $.clock.sleep(RETRY_MS / 4)
  }
  if (movedTo(state, old) !== sid) {
    stop(m) // no record says the new session is main's: idle, as a refused hello leaves it
    return
  }
  m.session = sid
  m.out.session = sid
  await writeOut($, m)
  await fetchStateFile($, m)
  const notes = isObj(state.module) && isObj(state.module.notes) ? (state.module.notes as Json) : {}
  if (text(notes.session) === sid && Array.isArray(notes.lines)) {
    for (const line of notes.lines) if (typeof line === 'string' && line) await note($, line)
  }
}

// ------------------------------------------------------------------------------------------------ the file guard

/** A path made absolute against the working directory, `~` read as $HOME, `.`, `..` and repeated slashes folded. */
function normal(m: State, path: string): string {
  let p = path.trim()
  if (p === '~') p = m.user
  else if (p.startsWith('~/')) p = `${m.user}${p.slice(1)}`
  if (!p.startsWith('/')) p = `${m.cwd}/${p}`
  const parts: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

/** Whether `path` is one of `roots` or inside one. */
function under(path: string, roots: string[]): boolean {
  return roots.some(r => {
    const root = r.replace(/\/+$/, '')
    return root !== '' && (path === root || path.startsWith(`${root}/`))
  })
}

/** Where a path lands, every link followed: its own realPath, else its folder's with its name (a file not there yet);
 *  '' when neither resolves. */
async function placed($: Engine, path: string): Promise<string> {
  const own = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  if (own?.realPath) return own.realPath
  const cut = path.lastIndexOf('/')
  const dir = await $.fs.stat(cut > 0 ? path.slice(0, cut) : '/', { resolve: true }).catch(() => undefined)
  return dir?.realPath ? `${dir.realPath.replace(/\/+$/, '')}/${path.slice(cut + 1)}` : ''
}

/** The rules before the server's: the token files in thimble's home, as spelled and as resolved. */
function fallbackRules(m: State): Rules {
  const homes = [m.home, m.homeReal].filter((h, i, all) => h !== '' && all.indexOf(h) === i)
  return { private: homes.flatMap(h => PRIVATE_NAMES.map(n => `${h}/${n}`)), records: [], corpus: null, web_off: false, reasons: { private: PRIVATE_FALLBACK } }
}

/** The rules GET /api/module/roles or roles.json carries (userconf.module_rules), with the token files of thimble's
 *  home as this module sees it kept; null when there are none. */
function parseRules(m: State, v: unknown): Rules | null {
  if (!isObj(v)) return null
  const paths = (x: unknown): string[] => (Array.isArray(x) ? x.filter((p): p is string => typeof p === 'string' && p.startsWith('/')) : [])
  const base = fallbackRules(m)
  const reasons: Record<string, string> = { ...base.reasons }
  if (isObj(v.reasons)) for (const [key, why] of Object.entries(v.reasons)) if (text(why)) reasons[key] = text(why)
  return {
    private: [...new Set([...base.private, ...paths(v.private)])],
    records: paths(v.records),
    corpus: text(v.corpus).startsWith('/') ? text(v.corpus) : null,
    web_off: v.web_off === true,
    reasons,
  }
}

/** The path a file tool's call names: Grep's and Glob's `path`, else the working directory; the others' `file_path`
 *  or `notebook_path`. '' for no file tool, or none named. */
function pathOf(m: State, e: Json): string {
  const tool = text(e.tool)
  if (!FILE_TOOLS.has(tool)) return ''
  return SEARCH_TOOLS.has(tool) ? text(e.path) || m.cwd : text(e.file_path) || text(e.notebook_path)
}

const reason = (rules: Rules, kind: string): string => rules.reasons[kind] || (kind === 'private' ? PRIVATE_FALLBACK : REFUSED)

/** Why the file guard refuses the call (module note), '' when it does not. */
async function refusal($: Engine, m: State, e: Json): Promise<string> {
  const tool = text(e.tool)
  if (tool === 'Bash') {
    if (!m.active || !text(e.command)) return ''
    if (!m.rules) await prepare($, m)
    return bashNamesPrivate(m, text(e.command)) ? reason(m.rules ?? fallbackRules(m), 'private') : ''
  }
  if (WEB_TOOLS.has(tool)) {
    if (!m.rules) await prepare($, m)
    const rules = m.rules ?? fallbackRules(m)
    return rules.web_off ? reason(rules, 'web') : ''
  }
  const raw = pathOf(m, e)
  if (!raw) return ''
  if (!m.rules) await prepare($, m)
  const rules = m.rules ?? fallbackRules(m)
  const spelled = normal(m, raw)
  const real = await placed($, spelled)
  const paths = real && real !== spelled ? [spelled, real] : [spelled]
  const homes = [m.home, m.homeReal].filter(Boolean)
  if (paths.some(p => under(p, rules.private) || (SEARCH_TOOLS.has(tool) && homes.includes(p)))) return reason(rules, 'private')
  if (!EDIT_TOOLS.has(tool)) return ''
  if (paths.some(p => under(p, rules.records))) return reason(rules, 'records')
  if (rules.corpus !== null && paths.some(p => under(p, [rules.corpus as string]))) return reason(rules, 'data')
  return ''
}

const escaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whether a Bash command names one of BASH_PRIVATE under thimble's home literally: the home as spelled, as resolved,
 *  as $THIMBLE_HOME, and for the default home as ~/.thimble and $HOME/.thimble (module note). */
function bashNamesPrivate(m: State, command: string): boolean {
  const homes = new Set([m.home, m.homeReal, '$THIMBLE_HOME', '${THIMBLE_HOME}'].filter(Boolean))
  if (m.user && m.home === `${m.user}/.thimble`) for (const h of ['~/.thimble', '$HOME/.thimble', '${HOME}/.thimble']) homes.add(h)
  const names = BASH_PRIVATE.map(escaped).join('|')
  return [...homes].some(h => new RegExp(`${escaped(h)}/+(?:${names})(?![A-Za-z0-9_.-])`).test(command))
}

/** For the guard's catch, with no file system call: whether the call names a token file as spelled. */
function namesPrivate(m: State, e: Json): boolean {
  const raw = pathOf(m, e)
  if (!raw) return false
  const p = normal(m, raw)
  const rules = m.rules ?? fallbackRules(m)
  return under(p, rules.private) || (SEARCH_TOOLS.has(text(e.tool)) && [m.home, m.homeReal].filter(Boolean).includes(p))
}

const moduleOn = async ($: Engine): Promise<boolean> => OFF.has(((await $.env.get('THIMBLE_NO_MODULE')) ?? '').trim().toLowerCase())

/** This session's marker, <home>/up/<session>.active (activation writes it, app/activate.py): the workspace it names,
 *  null when thimble is not on in the session. */
async function readMarker($: Engine): Promise<Activated | null> {
  const name = (await $.session.id()).replace(/[^A-Za-z0-9_-]/g, '')
  const got = name ? await readJson($, `${await thimbleHome($)}/up/${name}.active`) : null
  if (!got || !text(got.path)) return null
  return { ws: text(got.ws), path: text(got.path), cwd: text(got.cwd), via: text(got.via), role: got.role === 'peer' ? 'peer' : 'main', at: Number(got.at) || 0 }
}

/** Thimble on in this session (bridgeActivated, or the marker): over HTTP when launch.json makes this session's
 *  transport the server's, else through the files; the agent types are registered before it returns. Nothing in a
 *  session that is not interactive, with THIMBLE_NO_MODULE, when it is on already, or when the workspace has no
 *  launch.json to follow (the end of main's next turn looks again). */
async function start($: Engine, m: State, a: Activated): Promise<void> {
  if (m.active || !m.interactive || !(await moduleOn($))) return
  const ws = a.path.replace(/\/+$/, '')
  const launch = ws ? await readJson($, `${ws}/trusted/launch.json`) : null
  if (!launch || m.active) return
  m.active = true
  m.ws = ws
  const cwd = a.cwd || m.cwd
  const state = (await readJson($, `${ws}/trusted/subagents.json`)) ?? {}
  if (serverOf(launch) && isMain(launch, state, await $.session.id())) await begin($, m, cwd)
  else await fileBegin($, m, cwd, ws, launch)
}

// the module memory of the latest register (one per load of the module), for bridgeActivated
const live: { m: State | null } = { m: null }

/** thimble turned on in this session by the terminal UI (term/activate.ts, C13 of the 0.9.0 build): register thimble's
 *  agent types and turn the bridge on in this turn (start). A second call, or a call once the marker turned it on,
 *  changes nothing. */
export async function bridgeActivated($: Engine, a: Activated): Promise<void> {
  const m = live.m
  if (m) await start($, m, a)
}

/** The check's name in a check run's description, `check: <name> · <what it reads>` (backend/app/checks.py _launch). */
function checkOf(description: string): string {
  return /^check: (.+) · [^·]*$/.exec(description)?.[1]?.trim() || 'A thimble check'
}

/** The name of the check (`Judgment calls`) that `agentId` runs, when it is an agent of thimble's check role this session
 *  started; the terminal UI drops its hand-back. */
export function checkName(agentId: string): string | undefined {
  return live.m?.checks.get(agentId)
}

/** The reason Claude Code prints when the terminal UI drops the hand-back of `agentId`, when it is a model call's agent
 *  this module spawned (the server names it: `thimble checked the card "…"`); undefined for any other agent. */
export function callDone(agentId: string): string | undefined {
  return live.m?.calls.get(agentId)
}

export const register: Register = on => {
  const m = fresh()
  live.m = m

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    m.cwd = e.cwd
    m.interactive = e.isInteractive === true
    // the scope check, before any fetch or registration (module note): a session thimble is on in already (a resumed
    // one, or an activation before this load of the module)
    const marker = m.interactive && (await moduleOn($)) ? await readMarker($) : null
    if (marker) await start($, m, marker)
    return r
  })

  // thimble's types are offered to a model only inside an Agent call that names them, or once one started (module note)
  on('agent.offer', async ($, e, next) => (ours(m, e.agent) && !m.dispatching.has(e.agent) && !m.used.has(e.agent) ? { isOffered: false } : next(e)))
    .catch(($, e, next) => next(e)) // not a guard: if it fails, the type is offered as Claude Code offers it

  // the file guard, in every session, and an Agent or SendMessage call with its types offered while it runs (module note)
  on('tool.call', async ($, e, next) => {
    const why = await refusal($, m, e as unknown as Json)
    if (why) return { deny: why }
    const types = dispatched(m, e as unknown as Json)
    return types.length ? offering(m, types, () => next(e)) : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : namesPrivate(m, e as unknown as Json) ? { deny: reason(m.rules ?? fallbackRules(m), 'private') } : next(e)))

  on('agent.spawn', async ($, e, next) => {
    if (!m.active) return next(e)
    const got = await spawning($, m, e)
    const r = await next(got.model ? { ...e, model: got.model } : e)
    if (r.agentId && ours(m, e.subagentType ?? '')) m.used.add(e.subagentType ?? '') // offered from now on (module note)
    if (r.agentId) {
      if (got.effort !== undefined) m.efforts[r.agentId] = got.effort
      if (roleOf(e.subagentType ?? '') === 'check') m.checks.set(r.agentId, checkOf(e.description ?? ''))
      if (got.typed) delete m.requests[got.typed]
    }
    return r
  }).catch(($, e, next) => next(e)) // not a guard: if it fails, the call goes on as Claude Code made it

  on('turn.step', async function* ($, e, next) {
    const effort = m.active && e.agentId !== undefined ? m.efforts[e.agentId] : undefined
    // a request with no effort is to a model without one, which takes none
    return yield* next(effort !== undefined && e.effort !== undefined ? { ...e, effort: effort as typeof e.effort } : e)
  })

  // main's own turns, whatever the scope check found, so that a stop of main names the turn that runs (abortTurn)
  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) m.turn = e.turnId
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && e.turnId === m.turn) {
      m.turn = ''
      for (const ended of m.turnEnded.splice(0)) ended()
    }
    if (m.active && e.agentId !== undefined && m.started.has(e.agentId)) {
      if (m.forks.delete(e.agentId)) await writeForks($, m) // its run ended: the guard no longer needs it
      const refusal = e.reason === 'refusal' && isObj(e.refusal) ? { refusal: e.refusal } : {}
      if (m.file) {
        m.out.ended = [...m.out.ended, { n: ++m.n, agentId: e.agentId, answer: text(e.answer), reason: text(e.reason), ...refusal, at: Date.now() }].slice(-KEPT)
        void writeOut($, m)
      } else {
        void call($, m, 'POST', '/api/module/ended', { cwd: m.cwd, session: m.session, agentId: e.agentId, answer: e.answer, reason: e.reason, ...refusal })
      }
    } else if (e.agentId === undefined && m.interactive) {
      if (m.active && m.file) void recheck($, m) // launch.json at each of main's turns (module note)
      else if (!m.active && (await moduleOn($))) {
        // an activation made outside the terminal UI, which tells no one but the marker (module note)
        const marker = await readMarker($)
        if (marker) void start($, m, marker)
      }
    }
    return r
  })

  on('session.end', async ($, e, next) => {
    const r = await next(e)
    if (!m.active) return r
    if (e.reason === 'clear' || e.reason === 'resume') void (m.file ? followFile($, m, e.sessionId) : follow($, m, e.sessionId))
    else {
      stop(m)
      if (m.file) {
        m.out.gone = true
        await writeOut($, m)
      }
    }
    return r
  })
}
