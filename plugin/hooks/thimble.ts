// thimble's hooks module: how a click in thimble's browser starts, messages and stops one of thimble's subagents in
// the analyst's Claude Code session with no turn of main, and how a typed start runs on exactly the model and effort
// its request names. The server's side is backend/app/module_bridge.py; the tests are thimble.test.ts beside this file.
//
// Scope. It acts only in thimble's launched interactive main and checks that before its first fetch or registration:
// `isInteractive` first (an open long poll would hold every `claude -p` run open), then THIMBLE_LAUNCHED set and
// THIMBLE_NO_MODULE unset, then a server named by <THIMBLE_HOME>/server.json that accepts its hello for this folder and
// session (only main's, inside thimble's fence). Anywhere else it registers nothing. It starts no process: $.http.fetch
// only, every request proving the token of server.json and every answer proving it back (app/hook_auth.py), so a
// process on the port can neither hand it requests nor read them, and nothing it does runs outside the sandbox.
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
//   (register if needed, then SendMessage), stop (TaskStop of the agent and of the shells the server names), note
//   ($.session.append). It never starts, sends or stops anything the server did not ask for;
// - agent.spawn: an Agent call for one of thimble's roles whose prompt's first line names a typed request, main's or a
//   subagent's (a subagent of main's own may start thimble's agents, as Claude Code lets a subagent start subagents;
//   a thread's fork makes none: its start tool is refused, tools._as_caller, or main makes the call for it,
//   tools._ask_main), gets that request's full model id, and the agent it starts that request's effort, which turn.step sets on its every request;
//   a child of such an agent whose type is not thimble's gets the same effort (its model it inherits already). These
//   hooks never see a run of an agent this module started, which is why clicks register instead;
// - turn.complete: posts the end of each run of an agent it started (POST /api/module/ended), with why it ended and,
//   for a refusal, what the API said of it, since its other hooks skip those agents;
// - session.end: on /clear and /resume keeps its poll, waits for the new session id, says hello again under it,
//   refetches what the workspace's record holds and appends to the new main one note per running thimble agent; on
//   any other reason it stops polling.
// Its state lives in this module's memory, which /clear and /resume keep, with subagents.json as the record it
// refetches at session start and after a change of session; never in $.state, which both commands reset.
//
// Terminal mode (THIMBLE_WS names the workspace folder and its trusted/launch.json says `mode: terminal`) has no
// server, and the module makes no HTTP request there, even when server.json names a live server. Its scope check reads
// launch.json: terminal mode, `fenced: true`, and a session that is $.session.id() or one --rekey moved it to (the
// moves subagents.json records). It reads the roles from trusted/roles.json and registers them again whenever that
// file changes; it takes the requests addressed to it from subagents.json (entries of `requests` of kind `module`
// whose `module` is pending, for its session, not past `expires_at`), polling every FILE_POLL_MS, and handles them one
// at a time as it handles the long poll's; and it writes everything it says to trusted/module.json, which only it
// writes: its heartbeat every FILE_BEAT_MS, the requests it took, its answers, the ends of the runs it started, main's
// plan mode as its poll sees it, and what it could not register (backend/app/module_bridge.py has the file's form).
// After /clear it appends the notes --rekey left for the new main in subagents.json (`module.notes`).
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

export const PLUGIN = 'thimble'
// thimble's roles: each names its own model and effort, so a typed run's effort never goes to one of them
export const ROLES = ['orientation', 'critic', 'writer', 'view-builder', 'view-reviewer', 'check', 'dev-ticket']
export const RETRY_MS = 2000 // between hellos while no server accepts one, and after a failed poll
export const SESSION_WAIT_MS = 10000 // how long /clear's new session id is waited for
export const SESSION_TICK_MS = 25
const QUICK_MS = 1000 // a poll answered sooner than this with nothing is a server that is stopping
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
// never written; outside main's folder and every rule of thimble's fence, whose ask or deny would decide first and say
// nothing of plan mode (main's corpus is an ask rule)
const PLAN_PROBE = '/tmp/.thimble-plan-probe'
const PLAN_REASON = /\bplan mode\b/i

// terminal mode (module note)
export const FILE_POLL_MS = 500 // how often subagents.json and roles.json are looked at
export const FILE_BEAT_MS = 2000 // the heartbeat in module.json; module_bridge counts a module live while it is fresh
const KEPT = 64 // the requests taken, the answers and the ends module.json keeps, the newest
const TYPED_LIVE = new Set(['', 'pending', 'claimed']) // module_bridge.TYPED_LIVE
const MODULE_KIND = 'module' // subagent_files.MODULE_KIND

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

/** <THIMBLE_HOME>/server.json's API base and token (`api`, then `port`, as bin/thimble-mcp reads it); null without. */
async function findServer($: Engine): Promise<Server | null> {
  const homeDir = (await $.env.get('HOME')) ?? ''
  let home = (await $.env.get('THIMBLE_HOME')) || `${homeDir}/.thimble`
  if (home.startsWith('~/')) home = `${homeDir}${home.slice(1)}`
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
  active: boolean // in thimble's launched interactive main (the scope check passed) and not ended
  file: boolean // terminal mode: the trusted folder, not the server (module note)
  ws: string // the workspace folder, in terminal mode
  out: Out // what module.json holds, in terminal mode
  writing: Promise<void> // module.json's writes, one at a time
  stamps: Record<string, string> // the files' stamps (mtime and size) as last read, in terminal mode
  n: number // the ends written to module.json, in terminal mode
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
}

function fresh(): State {
  return {
    active: false, cwd: '', session: '', version: '', gen: 0, server: null, roles: {}, registered: {}, efforts: {},
    requests: {}, started: new Set(), queue: Promise.resolve(), helloing: null, leaving: '', plan: null,
    file: false, ws: '', writing: Promise.resolve(), stamps: {}, n: 0,
    out: { session: '', version: '', load: '', beat: 0, plan: null, plan_at: 0, problem: '', taken: [], answers: {}, ended: [] },
  }
}

const where = (m: State): string => new URLSearchParams({ cwd: m.cwd, session: m.session }).toString()

function stop(m: State): void {
  m.active = false
  m.gen += 1
}

// ------------------------------------------------------------------------------------------------ the server

async function call($: Engine, m: State, method: string, path: string, body?: Json): Promise<Reply | null> {
  const server = m.server ?? (m.server = await findServer($))
  if (!server) return null
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)))
  const headers: Record<string, string> = { 'x-thimble-nonce': nonce, 'x-thimble-auth': await hmac(server.token, `hook:${nonce}`) }
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
    return 'wait' // 404: the folder is no workspace yet; a server that is starting
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

/** What the module could not do: in the hello's `problem` (browser mode), or module.json's (terminal mode). */
async function say($: Engine, m: State, problem: string): Promise<void> {
  if (!m.file) {
    await hello($, m, problem)
    return
  }
  m.out.problem = problem
  await writeOut($, m)
}

// ------------------------------------------------------------------------------------------------ the session

async function begin($: Engine, m: State, cwd: string): Promise<void> {
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
  if (first === 'refused') return stop(m)
  const gen = m.gen
  void (async () => {
    let state: Hello = first
    while (state === 'wait' && m.active && gen === m.gen) {
      await $.clock.sleep(RETRY_MS)
      state = await connect($, m)
    }
    if (state === 'ok' && gen === m.gen) {
      void watchPlan($, m, gen)
      await poll($, m, gen)
    } else if (state === 'refused') stop(m)
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
      if (said === 'refused') return stop(m)
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
        if (!(await (m.file ? readRoles($, m) : fetchRoles($, m)))) return { error: 'the roles could not be fetched' }
        await registerAll($, m)
        return { ok: true }
      case 'spawn':
        return await spawn($, m, text(a.role), text(a.prompt), text(a.description), values, text(a.note))
      case 'send':
        return await send($, m, text(a.agent), text(a.text), text(a.role), values)
      case 'stop':
        return await stopAgent($, text(a.agent), Array.isArray(a.shells) ? a.shells.map(text).filter(Boolean) : [])
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
  if (said === 'refused') return stop(m)
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

// ------------------------------------------------------------------------------------------------ terminal mode

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

/** module.json written whole, one write at a time, with a fresh heartbeat (module note). */
function writeOut($: Engine, m: State): Promise<void> {
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
        out[id] = out[parent]
        changed = true
      }
    }
  }
  if (isObj(state.efforts)) for (const [id, v] of Object.entries(state.efforts)) if ((typeof v === 'string' || typeof v === 'number') && v !== '') out[id] = v
  return out
}

/** What fetchState fetches in browser mode, from subagents.json: the per-run efforts, the typed starts waiting for an
 *  Agent call (module_bridge._typed), the agents this module started. */
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

/** Terminal mode's start (module note): the scope check against launch.json, the roles from roles.json, the record,
 *  module.json, then the poll of the files and the plan poll. */
async function fileBegin($: Engine, m: State, cwd: string, ws: string, launch: Json): Promise<void> {
  m.file = true
  m.ws = ws.replace(/\/+$/, '')
  m.cwd = cwd
  m.session = await $.session.id()
  const state = (await readJson($, trusted(m, 'subagents.json'))) ?? {}
  if (launch.fenced !== true || !text(launch.session) || movedTo(state, text(launch.session)) !== m.session) return stop(m)
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
  void watchPlan($, m, gen)
  void pollFiles($, m, gen)
}

/** Every FILE_POLL_MS: roles.json registered again when it changed, the requests subagents.json addresses to this
 *  module taken when it changed, and the heartbeat every FILE_BEAT_MS (module note). */
async function pollFiles($: Engine, m: State, gen: number): Promise<void> {
  let beat = Date.now()
  while (m.active && gen === m.gen) {
    try {
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

/** After /clear or /resume in terminal mode: the new session id, the move --rekey recorded to it, module.json under it,
 *  the record again, and the notes --rekey left for the new main (subagents.json `module.notes`). */
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

export const register: Register = on => {
  const m = fresh()

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    // the scope check, before any fetch or registration: interactive first, then launched by thimble, module not off
    if (!e.isInteractive) return r
    if (!(await $.env.get('THIMBLE_LAUNCHED'))) return r
    if (!OFF.has(((await $.env.get('THIMBLE_NO_MODULE')) ?? '').trim().toLowerCase())) return r
    // terminal mode: THIMBLE_WS's launch.json says so (module note); browser mode otherwise
    const ws = (await $.env.get('THIMBLE_WS')) ?? ''
    const launch = ws ? await readJson($, `${ws}/trusted/launch.json`) : null
    if (ws && launch === null) return r // a workspace the launcher named whose launch.json cannot be read: idle
    m.active = true
    if (launch !== null && launch.mode === 'terminal') await fileBegin($, m, e.cwd, ws, launch)
    else await begin($, m, e.cwd)
    return r
  })

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

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (m.active && e.agentId !== undefined && m.started.has(e.agentId)) {
      const refusal = e.reason === 'refusal' && isObj(e.refusal) ? { refusal: e.refusal } : {}
      if (m.file) {
        m.out.ended = [...m.out.ended, { n: ++m.n, agentId: e.agentId, answer: text(e.answer), reason: text(e.reason), ...refusal, at: Date.now() }].slice(-KEPT)
        void writeOut($, m)
      } else {
        void call($, m, 'POST', '/api/module/ended', { cwd: m.cwd, session: m.session, agentId: e.agentId, answer: e.answer, reason: e.reason, ...refusal })
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
