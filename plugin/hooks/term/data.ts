// The terminal UI's one way to thimble's data: the `thimble` command, with no server and no port.
//
//   readState(surface, args)   `thimble state <surface> --cwd <dir> [args]`, which prints the JSON the server's GET route
//                              for that surface gives the browser; `{error}` and exit 1 when it fails
//   act(kind, payload)         `thimble act <kind> --cwd <dir> <json>`, which calls what the browser's POST route calls
//                              and prints `{ok, …}`; actLong the same for an act that runs until a label's run ends;
//                              actStdin the same with the payload on standard input (coverage facts can name 100,000
//                              paths, past one argument's limit)
//
// The terminal UI keeps no data of its own: what these print is drawn, and read again when the workspace changes. To
// see that it changed without starting Python, `signature` lists the workspace's folders (names, sizes and times only).
//
// The scope: none until thimble is on in this session (activate.ts); then the workspace that `thimble activate` named.
// Before that every hook passes through and nothing here runs.
import type { Ctx } from './ctx'

/** Where this session's thimble lives once it is on: its workspace folder, the corpus folder, the command and the
 *  environment each call carries. */
export type Scope = { ws: string; cwd: string; bin: string; env: Record<string, string> }

export type Got<T = unknown> = { ok: true; value: T } | { ok: false; error: string }

const STATE_TIMEOUT_MS = 60_000
const ACT_TIMEOUT_MS = 60_000

/** The `thimble` command in this plugin's folder (`<plugin>/bin/thimble`), or the one THIMBLE_TERM_CLI names (the
 *  tests' and the live check's stand-in). */
export function cliOf(root: string, override: string | undefined): string {
  if (override) return override
  const dir = root.replace(/\/+$/, '').replace(/\/\.claude-plugin$/, '')
  return `${dir}/bin/thimble`
}

/** The `thimble` command this session's calls run: THIMBLE_TERM_CLI's stand-in, else the plugin's own. */
export async function binOf(cx: Ctx): Promise<string> {
  return cliOf(cx.pluginRoot, (await cx.env('THIMBLE_TERM_CLI').catch(() => undefined)) || undefined)
}

/** thimble's home: THIMBLE_HOME, else ~/.thimble. */
export async function homeOf(cx: Ctx): Promise<string> {
  const set = ((await cx.env('THIMBLE_HOME').catch(() => undefined)) ?? '').replace(/\/+$/, '')
  if (set) return set
  const home = ((await cx.env('HOME').catch(() => undefined)) ?? '').replace(/\/+$/, '')
  return `${home}/.thimble`
}

/** The environment every `thimble` call of this session carries (the ports and home the person set). */
export async function envOf(cx: Ctx): Promise<Record<string, string>> {
  const env: Record<string, string> = {}
  for (const k of ['THIMBLE_HOME', 'THIMBLE_PORT', 'THIMBLE_UI_PORT']) {
    const v = await cx.env(k).catch(() => undefined)
    if (v) env[k] = v
  }
  return env
}

/** The scope once `thimble activate` named the workspace folder `ws` for the corpus folder `cwd`. */
export async function scopeOf(cx: Ctx, ws: string, cwd: string): Promise<Scope> {
  return { ws: ws.replace(/\/+$/, ''), cwd, bin: await binOf(cx), env: await envOf(cx) }
}

/** What a run printed, as JSON: its value when it exited 0 and printed JSON without an `error` key, else why not. */
export function parsePrinted(r: { exitCode: number; stdout: string; stderr: string }): Got {
  const out = r.stdout.trim()
  let v: unknown
  try {
    v = out ? JSON.parse(out) : undefined
  } catch {
    v = undefined
  }
  const err = v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { error?: unknown }).error === 'string' ? (v as { error: string }).error : ''
  if (r.exitCode !== 0 || err || v === undefined) {
    const why = err || r.stderr.trim().split('\n').filter(Boolean).at(-1) || (out ? 'it printed no JSON' : 'it printed nothing')
    return { ok: false, error: why.slice(0, 300) }
  }
  return { ok: true, value: v }
}

export async function readState<T = unknown>(cx: Ctx, sc: Scope, surface: string, args: readonly string[] = []): Promise<Got<T>> {
  try {
    const r = await cx.run([sc.bin, 'state', surface, '--cwd', sc.cwd, ...args], { cwd: sc.cwd, env: sc.env, timeoutMs: STATE_TIMEOUT_MS })
    return parsePrinted(r) as Got<T>
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 300) }
  }
}

export async function act<T = Record<string, unknown>>(cx: Ctx, sc: Scope, kind: string, payload: Record<string, unknown>): Promise<Got<T>> {
  try {
    const r = await cx.run([sc.bin, 'act', kind, '--cwd', sc.cwd, JSON.stringify(payload)], { cwd: sc.cwd, env: sc.env, timeoutMs: ACT_TIMEOUT_MS })
    const got = parsePrinted(r)
    if (got.ok && (got.value as { ok?: unknown })?.ok === false) return { ok: false, error: String((got.value as { error?: unknown }).error ?? 'refused') }
    return got as Got<T>
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 300) }
  }
}

/** An act whose payload goes on standard input (`thimble act <kind> --cwd <dir> --stdin`): the coverage facts of a turn,
 *  which may name more paths than one argument holds. */
export async function actStdin<T = Record<string, unknown>>(cx: Ctx, sc: Scope, kind: string, payload: Record<string, unknown>): Promise<Got<T>> {
  try {
    const r = await cx.run([sc.bin, 'act', kind, '--cwd', sc.cwd, '--stdin'], { cwd: sc.cwd, env: sc.env, stdin: JSON.stringify(payload), timeoutMs: ACT_TIMEOUT_MS })
    const got = parsePrinted(r)
    if (got.ok && (got.value as { ok?: unknown })?.ok === false) return { ok: false, error: String((got.value as { error?: unknown }).error ?? 'refused') }
    return got as Got<T>
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 300) }
  }
}

/** An act that may run longer than a run allows (`label-run` on every record): started beside the session, which it ends
 *  with, its answer read once it exits. */
export async function actLong<T = Record<string, unknown>>(cx: Ctx, sc: Scope, kind: string, payload: Record<string, unknown>): Promise<Got<T>> {
  try {
    const r = await cx.runLong([sc.bin, 'act', kind, '--cwd', sc.cwd, JSON.stringify(payload)], { cwd: sc.cwd, env: sc.env })
    const got = parsePrinted(r)
    if (got.ok && (got.value as { ok?: unknown })?.ok === false) return { ok: false, error: String((got.value as { error?: unknown }).error ?? 'refused') }
    return got as Got<T>
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 300) }
  }
}

// ------------------------------------------------------------------------------------------------ what changed

/** The parts of a workspace a surface reads, each with the folders whose listing says it changed: a folder whole, or
 *  the entries of it that `names` lists. Only listings: a file that is not there yet costs no failed call. */
export const AREAS = {
  cards: [{ dir: 'notebooks' }],
  labels: [{ dir: 'concepts' }, { dir: 'labels' }],
  // a document, and a report check made, changed or run on one (report.ts reads its name and its runs)
  docs: [{ dir: 'investigations/main' }, { dir: 'checks' }],
  chats: [{ dir: 'chats' }],
  // thimble's agents, and their failures: the open notices (notices.json), which home's state gives the rows above the
  // prompt
  agents: [{ dir: 'trusted', names: ['subagents.json', 'module.json'] }, { dir: 'orient', names: ['run.json'] }, { dir: '', names: ['notices.json'] }],
  // a view built (its folder in the local extension) or proposed (proposals.json)
  views: [{ dir: 'extension/views' }, { dir: 'views', names: ['proposals.json'] }],
  // the answers of views' keys a process read from a view's index (views/key-refs.json), from which `thimble state
  // resolve` answers a `view:<slug>/<key>` citation
  viewKeys: [{ dir: 'views', names: ['key-refs.json'] }],
  ui: [{ dir: '', names: ['ui.jsonl'] }],
  // what the session's tool calls saw of the data (coverage.py touches the folder when a record count ends) and the
  // checks' comments on Claude's answers
  coverage: [{ dir: 'coverage' }],
  answers: [{ dir: '', names: ['answer-comments.json'] }],
} as const satisfies Record<string, readonly { dir: string; names?: readonly string[] }[]>

export type Area = keyof typeof AREAS
export type Signature = Record<Area, string>

type Listing = Awaited<ReturnType<Ctx['list']>> | null

/** A folder's entries, null when it cannot be listed (not there yet). */
async function listing(cx: Ctx, path: string): Promise<Listing> {
  try {
    return await cx.list(path)
  } catch {
    return null
  }
}

function stamp(entries: Listing, names?: readonly string[]): string {
  if (!entries) return '-'
  // a file's size and time, a folder's name: what an edit, an add or a remove changes
  return entries
    .filter(e => !names || names.includes(e.name))
    .map(e => `${e.name}:${e.kind === 'file' ? `${e.size}:${e.mtimeMs}` : e.kind}`)
    .sort()
    .join('|')
}

/** One stamp per area: a change of any file it reads changes it. Each folder is listed once a pass, whatever number of
 *  areas read it. */
export async function signature(cx: Ctx, sc: Scope): Promise<Signature> {
  const out = {} as Signature
  const listed = new Map<string, Promise<Listing>>()
  for (const area of Object.keys(AREAS) as Area[]) {
    const parts: string[] = []
    for (const spec of AREAS[area] as readonly { dir: string; names?: readonly string[] }[]) {
      if (!listed.has(spec.dir)) listed.set(spec.dir, listing(cx, spec.dir ? `${sc.ws}/${spec.dir}` : sc.ws))
      parts.push(stamp(await listed.get(spec.dir)!, spec.names))
    }
    out[area] = parts.join('#')
  }
  return out
}

/** The areas whose stamp differs between two signatures (every area when there was none before). */
export function changed(before: Signature | null, now: Signature): Area[] {
  return (Object.keys(now) as Area[]).filter(a => !before || before[a] !== now[a])
}
