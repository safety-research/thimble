// thimble's hooks module: how a click in thimble's browser starts, messages and stops one of thimble's subagents in
// the analyst's Claude Code session with no turn of main, and how a typed start runs on exactly the model and effort
// its request names. The server's side is backend/app/module_bridge.py; the tests are thimble.test.ts beside this file.
//
// Scope. It acts only in thimble's main and checks that before its first fetch or registration: `isInteractive` first
// (an open long poll would hold every `claude -p` run open), THIMBLE_NO_MODULE unset, then either THIMBLE_LAUNCHED at
// session.start (the `thimble` command starts the server first, so the types are in main's first agent listing) or
// /thimble expanding in this session; then a server named by server.json that accepts its hello for this folder and
// session (only main's). The module hears of /thimble from skill.prompt for thimble:thimble, or at the end of main's
// turn from the marker /thimble's own hook leaves, <home>/up/<session>.active (app/cli.py hook_up), written anew at
// each /thimble: where an organization manages Claude Code (managed settings on the machine, or a Team or Enterprise
// account), Claude Code seats its built-in security plugin, and skill.prompt passes over the plugins a person installs,
// while turn.complete still reaches them. Whichever of the two comes first stands for that /thimble; a marker the
// module has seen (its mtime and size) never turns it on again, and neither does one the session already had when it
// started, from a /thimble of an earlier run of the session (`claude -c` or --resume, then /thimble again, as the
// skill.prompt route needs). In a session the launcher did not start, it waits for that server at most
// ACTIVATE_WAIT_MS after /thimble, then says hello once at the end of each of main's turns; a refused hello, or a folder
// the server does not know, leaves it idle until the next /thimble. Anywhere else it registers nothing and fetches
// nothing, and looks at nothing but that marker's file system entry at session.start and once per turn of main's. It
// starts no process: $.http.fetch only, every request proving the token of server.json and every answer proving it
// back (app/hook_auth.py), so a process on the port can neither hand it requests nor read them.
//
// The file guard (tool.call), from the moment the scope check passes: it refuses a call of a file tool (Read, Edit,
// Write, MultiEdit, NotebookEdit, Grep, Glob) on thimble's token files, a call of an edit tool on thimble's records or,
// when the analyst turned corpus edits off, on the corpus, and WebFetch and WebSearch when the analyst turned the web
// off, with the reason each rule names. The rules come with the roles (GET /api/module/roles: app/userconf.py
// module_rules); until they come, or when they cannot be fetched, only the token files in
// thimble's home are refused. The path is compared as spelled and as resolved ($.fs.stat with resolve), so a link to a
// token file is refused too; Grep and Glob are refused at thimble's home itself. Bash it leaves to the permission mode.
//
// What it does once the server accepts it:
// - registers thimble's roles and thimble:orient-helper from GET /api/module/roles (each with a full model id and an
//   explicit effort, from Settings); when the server is up at session start this happens inside session.start, so the
//   types are in main's first agent listing;
// - asks Claude Code's permission decision for a write it never makes every PLAN_POLL_MS and tells the server when main
//   went into plan mode or out of it (POST /api/module/mode), which no event of Claude Code's says while main is idle;
// - holds GET /api/module/next and handles the requests one at a time, in order, so a role's registration and the
//   spawn that needs it are never split by another request: register (all roles again), spawn (register the role with
//   the run's values if they differ, $.agent.spawn with no `model`, then the one-line note the server rendered), send
//   (register if needed, then SendMessage), stop (TaskStop of the agent and of the shells the server names), abort
//   (the analyst's Stop of main: $.turn.abort of main's running turn, by the id its turn.start carried, answered once
//   that turn completed or ABORT_WAIT_MS passed, after a TaskStop of each command of that turn the abort moved to the
//   background, where Esc would have ended it), note ($.session.append). It never starts, sends or stops anything the
//   server did not ask for;
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
import type { EngineInterface, Register } from 'claude-code'

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
export const ROLES = ['orientation', 'critic', 'writer', 'view-builder', 'view-reviewer', 'check', 'dev-ticket']
export const RETRY_MS = 2000 // between hellos while no server accepts one, and after a failed poll
export const SESSION_WAIT_MS = 10000 // how long /clear's new session id is waited for
export const SESSION_TICK_MS = 25
// how long the module waits for a server that accepts its hello after /thimble in a session the launcher did not start:
// the timeout of /thimble's own hook, which starts the server (hooks.json, UserPromptExpansion)
export const ACTIVATE_WAIT_MS = 600_000
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

// the file guard (module note): the tools whose path it reads, those of them that edit, those that search a folder
// (their `path`, else the working directory), and the web tools
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SEARCH_TOOLS = new Set(['Grep', 'Glob'])
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch'])
const PRIVATE_NAMES = ['server.json', 'session.key', 'paired.json', 'links'] // in thimble's home (userconf.module_rules)
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

type State = {
  active: boolean // in thimble's interactive main (the scope check passed) and not ended
  interactive: boolean // session.start said the session is interactive
  launched: boolean // the launcher started this session (THIMBLE_LAUNCHED at session.start)
  armed: boolean // /thimble expanded in this session the launcher did not start, and no hello was refused since
  expanded: boolean // skill.prompt reported /thimble in main's turn now running, so its marker is not a new /thimble
  marker: string // the stamp of the last marker /thimble's hook left that the module saw ('' for none)
  user: string // $HOME, for a path that starts with ~
  home: string // thimble's home, as spelled
  homeReal: string // and resolved, '' when it does not resolve
  rules: Rules | null // what the file guard refuses (null until the scope check passed)
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
  queue: Promise<void> // the requests, one at a time
  helloing: { sid: string; said: Promise<Hello> } | null
  leaving: string // the session /clear or /resume is taking main away from, until the new one is known
  plan: boolean | null // whether main's session was in plan mode at the last look, as the server heard it
  turn: string // main's running model turn: the id its turn.start carried, '' once it completed
  turnEnded: (() => void)[] // what waits for the end of `turn` (abortTurn)
}

function fresh(): State {
  return {
    active: false, interactive: false, launched: false, armed: false, expanded: false, marker: '', user: '', home: '',
    homeReal: '', rules: null,
    cwd: '', session: '', version: '', gen: 0, server: null, roles: {}, registered: {}, efforts: {},
    requests: {}, started: new Set(), queue: Promise.resolve(), helloing: null, leaving: '', plan: null, turn: '', turnEnded: [],
  }
}

const where = (m: State): string => new URLSearchParams({ cwd: m.cwd, session: m.session }).toString()

function stop(m: State): void {
  m.active = false
  m.gen += 1
}

/** A refused hello: idle, and in a session the launcher did not start, until the next /thimble. */
function refuse(m: State): void {
  stop(m)
  m.armed = false
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
    // 404, a folder that is no workspace: /thimble registers the folder before it expands, so after /thimble it did not
    // open this folder; for the launcher's session, a server that is starting
    if (r.status === 404) return m.launched ? 'wait' : 'refused'
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

/** What the module could not do: in the hello's `problem`. */
async function say($: Engine, m: State, problem: string): Promise<void> {
  await hello($, m, problem)
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

/** The scope check passed (session.start, /thimble, or the end of main's turn after /thimble): hello, roles and
 *  registrations, then the long poll. A session the launcher did not start waits at most `patience` for a server that
 *  accepts its hello, then stays idle, armed, until the end of main's next turn. */
async function begin($: Engine, m: State, cwd: string, patience: number): Promise<void> {
  await prepare($, m)
  m.cwd = cwd
  m.session = await $.session.id()
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))
    m.version = isObj(manifest) ? text(manifest.version) : ''
  } catch {
    m.version = ''
  }
  // a server that is up now: hello, roles and registrations inside session.start, for main's first agent listing
  const first = await connect($, m)
  if (first === 'refused') return refuse(m)
  const gen = m.gen
  const since = await $.clock.now()
  void (async () => {
    let state: Hello = first
    while (state === 'wait' && m.active && gen === m.gen) {
      if (!m.launched && (await $.clock.now()) - since >= patience) break
      await $.clock.sleep(RETRY_MS)
      state = await connect($, m)
    }
    if (gen !== m.gen) return
    if (state === 'ok') {
      void watchPlan($, m, gen)
      await poll($, m, gen)
    } else if (state === 'refused') refuse(m)
    else stop(m) // waited `patience` after /thimble: the end of main's next turn says hello again (still armed)
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
        if (!(await fetchRoles($, m))) return { error: 'the roles could not be fetched' }
        await registerAll($, m)
        return { ok: true }
      case 'spawn':
        return await spawn($, m, text(a.role), text(a.prompt), text(a.description), values, text(a.note))
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

async function spawn($: Engine, m: State, role: string, prompt: string, description: string, values: Values | undefined, line: string): Promise<Answer> {
  await ensure($, m, role, values)
  // no `model`: a spawn takes only an alias; the registration carries the full id
  const r = await $.agent.spawn({ subagentType: `${PLUGIN}:${role}`, prompt, description })
  if (r.deny !== undefined) return LIMIT.test(r.deny) ? { limit: r.deny } : { deny: r.deny }
  if (!r.agentId) return { error: 'Claude Code started no agent' }
  m.started.add(r.agentId)
  if (line) await note($, line.split('{agent}').join(r.agentId))
  return { agentId: r.agentId, model: r.model }
}

async function send($: Engine, m: State, agent: string, message: string, role: string, values: Values | undefined): Promise<Answer> {
  if (role && m.roles[role]) await ensure($, m, role, values)
  const r = await $.tool.call({ tool: 'SendMessage', to: agent, message } as Parameters<Engine['tool']['call']>[0])
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

/** The rules GET /api/module/roles carries (userconf.module_rules), with the token files of thimble's home as this
 *  module sees it kept; null when there are none. */
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

/** For the guard's catch, with no file system call: whether the call names a token file as spelled. */
function namesPrivate(m: State, e: Json): boolean {
  const raw = m.active ? pathOf(m, e) : ''
  if (!raw) return false
  const p = normal(m, raw)
  const rules = m.rules ?? fallbackRules(m)
  return under(p, rules.private) || (SEARCH_TOOLS.has(text(e.tool)) && [m.home, m.homeReal].filter(Boolean).includes(p))
}

const moduleOn = async ($: Engine): Promise<boolean> => OFF.has(((await $.env.get('THIMBLE_NO_MODULE')) ?? '').trim().toLowerCase())

/** A file's stamp (mtime and size), '' when it is missing. */
async function stamp($: Engine, path: string): Promise<string> {
  try {
    const st = await $.fs.stat(path)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return ''
  }
}

/** The stamp of this session's marker, <home>/up/<session>.active as app/cli.py hook_marker_path names it; '' for none. */
async function markerStamp($: Engine): Promise<string> {
  const name = (await $.session.id()).replace(/[^A-Za-z0-9_-]/g, '')
  return name ? await stamp($, `${await thimbleHome($)}/up/${name}.active`) : ''
}

/** At the end of main's turn: whether /thimble's hook left a marker for this session that the module has not seen
 *  (module note), and no skill.prompt reported the same /thimble in this turn. With THIMBLE_NO_MODULE it looks at
 *  nothing. */
async function expanded($: Engine, m: State): Promise<boolean> {
  const reported = m.expanded
  m.expanded = false
  if (!(await moduleOn($))) return false
  const seen = await markerStamp($)
  if (!seen || seen === m.marker) return false
  m.marker = seen
  return !reported
}

export const register: Register = on => {
  const m = fresh()

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    m.cwd = e.cwd
    m.interactive = e.isInteractive === true
    // the scope check, before any fetch or registration: interactive first, then launched by thimble (else idle until
    // /thimble, skill.prompt), module not off
    if (!e.isInteractive) return r
    if (!(await $.env.get('THIMBLE_LAUNCHED'))) {
      // a marker the session already has is a /thimble of an earlier run of it (claude -c, --resume), which a resumed
      // session types again, as for skill.prompt: it counts as seen (module note)
      if (await moduleOn($)) m.marker = await markerStamp($)
      return r
    }
    if (!(await moduleOn($))) return r
    m.launched = true
    m.active = true
    await begin($, m, e.cwd, 0)
    return r
  })

  // /thimble in a session the launcher did not start turns the module on, in that session only (module note)
  on('skill.prompt', async ($, e, next) => {
    const r = await next(e)
    if (e.skill !== `${PLUGIN}:thimble`) return r
    m.expanded = true // its marker, at the end of this turn, is this /thimble
    if (m.interactive && !m.launched && !m.active && (await moduleOn($))) {
      m.active = true
      m.armed = true
      void begin($, m, m.cwd, ACTIVATE_WAIT_MS)
    }
    return r
  })

  on('tool.call', async ($, e, next) => {
    if (!m.active) return next(e)
    const why = await refusal($, m, e as unknown as Json)
    return why ? { deny: why } : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : namesPrivate(m, e as unknown as Json) ? { deny: reason(m.rules ?? fallbackRules(m), 'private') } : next(e)))

  on('agent.spawn', async ($, e, next) => {
    if (!m.active) return next(e)
    const got = await spawning($, m, e)
    const r = await next(got.model ? { ...e, model: got.model } : e)
    if (r.agentId) {
      if (got.effort !== undefined) m.efforts[r.agentId] = got.effort
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
      const refusal = e.reason === 'refusal' && isObj(e.refusal) ? { refusal: e.refusal } : {}
      void call($, m, 'POST', '/api/module/ended', { cwd: m.cwd, session: m.session, agentId: e.agentId, answer: e.answer, reason: e.reason, ...refusal })
    } else if (e.agentId === undefined && m.interactive && !m.launched) {
      if ((await expanded($, m)) && !m.active) {
        // /thimble's marker, where skill.prompt passed over this plugin: what skill.prompt does (module note)
        m.active = true
        m.armed = true
        void begin($, m, m.cwd, ACTIVATE_WAIT_MS)
      } else if (m.armed && !m.active) {
        // after /thimble, once the wait for the server ended: one hello at the end of each of main's turns (module note)
        m.active = true
        void begin($, m, m.cwd, 0)
      }
    }
    return r
  })

  on('session.end', async ($, e, next) => {
    const r = await next(e)
    if (e.reason !== 'clear' && e.reason !== 'resume') m.armed = false
    if (!m.active) return r
    if (e.reason === 'clear' || e.reason === 'resume') void follow($, m, e.sessionId)
    else stop(m)
    return r
  })
}
