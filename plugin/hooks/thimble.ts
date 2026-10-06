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
// - registers thimble's six roles and thimble:helper from GET /api/module/roles (each with a full model id and an
//   explicit effort, from Settings); when the server is up at session start this happens inside session.start, so the
//   types are in main's first agent listing;
// - holds GET /api/module/next and handles the requests one at a time, in order, so a role's registration and the
//   spawn that needs it are never split by another request: register (all roles again), spawn (register the role with
//   the run's values if they differ, $.agent.spawn with no `model`, then the one-line note the server rendered), send
//   (register if needed, then SendMessage), stop (TaskStop), note ($.session.append). It never starts, sends or stops
//   anything the server did not ask for;
// - agent.spawn: main's Agent call for one of thimble's roles whose prompt's first line names a typed request gets that
//   request's full model id, and the agent it starts that request's effort, which turn.step sets on its every request;
//   a child of such an agent whose type is not thimble's gets the same effort (its model it inherits already). These
//   hooks never see a run of an agent this module started, which is why clicks register instead;
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

export const PLUGIN = 'thimble'
// thimble's roles: each names its own model and effort, so a typed run's effort never goes to one of them
export const ROLES = ['orientation', 'critic', 'writer', 'view-builder', 'view-reviewer', 'check']
export const RETRY_MS = 2000 // between hellos while no server accepts one, and after a failed poll
export const SESSION_WAIT_MS = 10000 // how long /clear's new session id is waited for
export const SESSION_TICK_MS = 25
const QUICK_MS = 1000 // a poll answered sooner than this with nothing is a server that is stopping
const LIMIT = /concurrent subagent limit/i // Claude Code's text when it runs as many subagents as it allows
const GONE = /is not running|no task found|could not be resumed|no transcript found/i
const QUEUED = /queued for delivery/i
const REQUEST_WORD = /[A-Za-z0-9_-]{8,64}/g // a request id on the first line of a typed start's prompt
const OFF = new Set(['', '0', 'false', 'no', 'off'])

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

type State = {
  active: boolean // in thimble's launched interactive main (the scope check passed) and not ended
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
}

function fresh(): State {
  return {
    active: false, cwd: '', session: '', version: '', gen: 0, server: null, roles: {}, registered: {}, efforts: {},
    requests: {}, started: new Set(), queue: Promise.resolve(), helloing: null, leaving: '',
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
  if (problems.length) await hello($, m, `Claude Code did not register ${problems.join('; ')}`)
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
    if (state === 'ok' && gen === m.gen) await poll($, m, gen)
    else if (state === 'refused') stop(m)
  })()
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
        if (!(await fetchRoles($, m))) return { error: 'the roles could not be fetched' }
        await registerAll($, m)
        return { ok: true }
      case 'spawn':
        return await spawn($, m, text(a.role), text(a.prompt), text(a.description), values, text(a.note))
      case 'send':
        return await send($, m, text(a.agent), text(a.text), text(a.role), values)
      case 'stop':
        return await stopAgent($, text(a.agent))
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

async function stopAgent($: Engine, agent: string): Promise<Answer> {
  const r = await $.tool.call({ tool: 'TaskStop', task_id: agent } as Parameters<Engine['tool']['call']>[0])
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
 *  agent's children of no thimble type run at. Never fails the call: a lookup that fails changes nothing. */
async function spawning($: Engine, m: State, e: { subagentType?: string; parentAgentId?: string; prompt?: string }): Promise<{ model?: string; effort?: Effort; typed?: string }> {
  try {
    const type = e.subagentType ?? ''
    const role = roleOf(type)
    if (role && !e.parentAgentId) {
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

export const register: Register = on => {
  const m = fresh()

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    // the scope check, before any fetch or registration: interactive first, then launched by thimble, module not off
    if (!e.isInteractive) return r
    if (!(await $.env.get('THIMBLE_LAUNCHED'))) return r
    if (!OFF.has(((await $.env.get('THIMBLE_NO_MODULE')) ?? '').trim().toLowerCase())) return r
    m.active = true
    await begin($, m, e.cwd)
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
      void call($, m, 'POST', '/api/module/ended', { cwd: m.cwd, session: m.session, agentId: e.agentId, answer: e.answer, reason: e.reason, ...refusal })
    }
    return r
  })

  on('session.end', async ($, e, next) => {
    const r = await next(e)
    if (!m.active) return r
    if (e.reason === 'clear' || e.reason === 'resume') void follow($, m, e.sessionId)
    else stop(m)
    return r
  })
}
