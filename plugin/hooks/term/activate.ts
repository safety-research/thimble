// thimble on in this session (SPEC-v2 3.3, 3.4, 3.21): the data rule that turns it on at the first data-file read, the
// one activation per session (single flight), the push that lists thimble's tools, the guide delivered once per need and
// marked sent only once the row that carries it is stored, and the quiet restore after a module reload, /clear or
// /resume.
//
// Before activation (S0) nothing here writes, spawns or fetches. A Read or Bash call that names a file is the only
// thing looked at: its path is tested against the data rule with a few $.fs.stat calls (the cwd root listed once per
// session for the code-tree test), and config.json is read once for the "Turn on when Claude reads data" switch. A
// coding session pays only that.
//
// What activation does, inside the hook of the call that set it off, after the call itself ran:
//   1. `thimble activate --mod --json` (C2): the folder registered, the session marker written
//   2. the push: `load_thimble` called on the shim with $.mcp.call (C5), which lists thimble's tools and answers the
//      guide; then one read of listed.json (C4) to learn whether the tools were listed
//   3. thimble.ts told at once (bridgeActivated), the timers and the drawing started, the settings synced after the hook
//   4. the guide handed back: as the call's `context` (main's call), as a hidden user row in main's conversation (a
//      subagent's call), or kept owed for the next delivery point
// A hook has 10 s of its own time and the clock runs while it awaits a plain promise, so parallel calls wait on the one
// activation for at most their budget less a second, and a late notice waits on a timer, never in a hook.
//
// Delivery points of an owed guide (3.4): a tool call of main's (its `context`), a prompt (`prompt.submit` context),
// `/thimble` (`command.run` context), after a compaction a hidden user row, after /clear the next prompt. While one is
// in flight (`pending`) no other sends it.
import type { Activated } from './contracts'
import type { Ctx } from './ctx'
import { binOf, envOf, homeOf, parsePrinted } from './data'
import { clean } from './lib'
import { postNotice } from './notices'
import { syncSoon } from './settings'
import { setTheme } from './paint'
import { restoreKept, rt, startTimers } from './term'
import { bashReads } from './tracker'

// ------------------------------------------------------------------------------------------------ the data rule

/** Folders whose files never turn thimble on and never count as data: tools', tests' and samples'. */
export const NEVER_SEGMENTS = ['node_modules', '.git', '.venv', 'venv', 'dist', 'build', '.claude', 'tests', 'test', 'fixtures', 'testdata', '__snapshots__', 'sample', 'samples', 'examples']
/** A file at a folder's root that makes the folder a code tree. */
export const CODE_TREE_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'setup.py', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'Gemfile', 'composer.json']
/** The extensions that turn thimble on outside a code tree. */
export const ACTIVATE_EXT = ['csv', 'tsv', 'jsonl', 'ndjson', 'parquet', 'arrow', 'feather', 'xlsx', 'sqlite', 'db', 'duckdb', 'json', 'log']
/** Inside a code tree, a file of these turns thimble on at 1 MiB or more (never json, sqlite, db or duckdb by size). */
export const SIZE_EXT = ['csv', 'tsv', 'jsonl', 'ndjson', 'parquet', 'arrow', 'feather', 'xlsx', 'log']
/** Folder names that mark data inside a code tree. */
export const DATA_SEGMENTS = ['data', 'datasets', 'runs', 'transcripts', 'traces', 'corpus', 'corpora']
/** Documents whose records coverage counts, which turn thimble on only through /thimble or load_thimble. */
export const DOC_EXT = ['pdf', 'txt', 'md', 'html', 'htm', 'xml', 'vtt', 'srt', 'eml']
/** Code and config files: never data. */
export const CODE_EXT = ['py', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'rb', 'php', 'sh', 'swift', 'kt', 'scala', 'css', 'scss', 'toml', 'ini', 'cfg', 'lock', 'yaml', 'yml']
export const SIZE_FLOOR = 1024 * 1024

const NEVER_NAME = /^(?:package.*\.json|tsconfig.*\.json|.*\.lock|composer\.json|\.eslintrc.*)$/

const extOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** `path` relative to the folder `root` (both absolute, as their realpaths), or null when it is not inside it. A
 *  relative `path` is taken as relative to `root` already. */
export function relInside(root: string, path: string): string | null {
  if (!path) return null
  const r = root.replace(/\/+$/, '')
  if (!path.startsWith('/')) {
    const rel = path.replace(/^\.\/+/, '')
    return rel && !rel.split('/').includes('..') ? rel : null
  }
  if (!path.startsWith(`${r}/`)) return null
  const rel = path.slice(r.length + 1)
  return rel && !rel.split('/').includes('..') ? rel : null
}

/** The parts the rules read of a path inside the folder: its folders, its name and its extension; null outside it, under
 *  a never-folder, for a never-name, or under one of `never` (thimble's home, Claude Code's config folder). */
function partsOf(cwd: string, path: string, never: readonly string[]): { dirs: string[]; ext: string } | null {
  const rel = relInside(cwd, path)
  if (rel === null) return null
  const abs = path.startsWith('/') ? path : `${cwd.replace(/\/+$/, '')}/${rel}`
  if (never.some(n => n && (abs === n || abs.startsWith(`${n.replace(/\/+$/, '')}/`)))) return null
  const segs = rel.split('/').filter(Boolean)
  const name = segs.at(-1) ?? ''
  const dirs = segs.slice(0, -1)
  if (dirs.some(d => NEVER_SEGMENTS.includes(d)) || NEVER_NAME.test(name)) return null
  return { dirs, ext: extOf(name) }
}

/** Whether reading this file turns thimble on (3.3): the file's realpath inside the session folder's, not under a
 *  never-folder or thimble's or Claude Code's home, not a never-name; outside a code tree an activation extension;
 *  inside one a data folder's file of those extensions (not log), or a csv/tsv/jsonl/ndjson/parquet/arrow/feather/
 *  xlsx/log file of 1 MiB or more. */
export function isDataRead(cwd: string, path: string, size: number, codeTree: boolean, never: readonly string[] = []): boolean {
  const p = partsOf(cwd, path, never)
  if (!p) return false
  if (!codeTree) return ACTIVATE_EXT.includes(p.ext)
  if (p.dirs.some(d => DATA_SEGMENTS.includes(d)) && ACTIVATE_EXT.includes(p.ext) && p.ext !== 'log') return true
  return SIZE_EXT.includes(p.ext) && size >= SIZE_FLOOR
}

/** Whether a file counts as data for coverage (3.9, the twin of backend coverage.is_data): never code or config; outside
 *  a code tree an activation extension or a document of records; inside one a data folder's file of those, or a
 *  csv/tsv/jsonl/ndjson/parquet/arrow/feather/xlsx/log file at any size. */
export function isDataFile(cwd: string, path: string, codeTree: boolean, never: readonly string[] = []): boolean {
  const p = partsOf(cwd, path, never)
  if (!p || CODE_EXT.includes(p.ext)) return false
  const known = ACTIVATE_EXT.includes(p.ext) || DOC_EXT.includes(p.ext)
  if (!codeTree) return known
  return (p.dirs.some(d => DATA_SEGMENTS.includes(d)) && known) || SIZE_EXT.includes(p.ext)
}

// ------------------------------------------------------------------------------------------------ module memory

/** The session folder as the rules read it: its path and realpath, thimble's home, the folders whose files never count
 *  (realpaths of thimble's home and Claude Code's config folder), whether it is a code tree, and the command. */
export type Pre = { cwd: string; real: string; home: string; never: string[]; codeTree: boolean; bin: string }

/** An activation's end: on (the workspace, and the text to hand Claude: the guide, or the line that says its tools did
 *  not load), or why not. */
export type Outcome = { ok: true; activated: Activated; context: string | null } | { ok: false; error: string; refused: boolean }

/** How an activation hands back the guide: as the triggering call's `context` (main's tool call, /thimble), as a hidden
 *  row in main's conversation (a subagent's call), or kept owed for the next delivery point. */
export type Deliver = 'context' | 'append' | 'owed'

/** What this module holds for the session; a module reload starts it over and session.start restores it. */
export const act = {
  /** session.start's word: a person at the prompt, on the terminal */
  interactive: false,
  surface: '' as string,
  /** the session id activation ran for (a /clear or /resume changes $.session.id()) */
  sid: '',
  pre: null as Pre | null,
  /** folders `thimble activate` refused: data reads there run no activation for the rest of the session */
  refused: new Set<string>(),
  refusedSaid: false,
  flight: null as Promise<Outcome> | null,
  active: null as Activated | null,
  /** the guide is owed (true), not owed (false), or unknown until `thimble guide --if-owed` says (null) */
  owed: false as boolean | null,
  /** the marker of the guide a delivery carries now ('' for none): no second delivery starts meanwhile */
  pending: '',
  /** a /clear or /resume ended the conversation `from`: the next call of the new one rekeys */
  rekey: null as { from: string; reason: string } | null,
  /** when the activation started (unix seconds), which a listed.json record must be newer than */
  started: 0,
  /** what activation did, in order (the debug log and the tests read it) */
  trail: [] as string[],
}

/** A fresh session (session.start): every value above as at the start. */
export function resetActivation(e: { isInteractive?: boolean; surface?: string | null }): void {
  act.interactive = e.isInteractive === true
  act.surface = e.surface ?? ''
  act.sid = ''
  act.pre = null
  act.refused = new Set()
  act.refusedSaid = false
  act.flight = null
  act.active = null
  act.owed = false
  act.pending = ''
  act.rekey = null
  act.started = 0
  act.trail = []
}

/** A step of activation, kept for the debug log (`thimble: activation <step>`) and activationTrail. */
function trail(cx: Ctx, step: string): void {
  act.trail.push(step)
  if (act.trail.length > 50) act.trail.shift()
  cx.debug(`thimble: activation ${step}`)
}

/** Whether thimble is on in this session (C13). */
export function isActive(): boolean {
  return act.active !== null
}

// ------------------------------------------------------------------------------------------------ before activation

/** The session folder as the rules read it, once per session: a few stats and one listing, no process. */
export async function preScope(cx: Ctx): Promise<Pre> {
  if (act.pre) return act.pre
  const cwd = (await cx.root()).replace(/\/+$/, '') || '/'
  const real = (await cx.real(cwd))?.realPath ?? cwd
  const home = await homeOf(cx)
  const userHome = ((await cx.env('HOME').catch(() => undefined)) ?? '').replace(/\/+$/, '')
  const config = ((await cx.env('CLAUDE_CONFIG_DIR').catch(() => undefined)) ?? '').replace(/\/+$/, '') || (userHome ? `${userHome}/.claude` : '')
  const never: string[] = []
  for (const p of [home, config]) if (p) never.push((await cx.real(p))?.realPath ?? p)
  const entries = await cx.list(real).catch(() => [])
  const codeTree = entries.some(en => CODE_TREE_MARKERS.includes(en.name))
  act.pre = { cwd, real, home, never, codeTree, bin: await binOf(cx) }
  return act.pre
}

/** The files a call reads that could be data: Read's file, and the files a Bash reader names (never an output
 *  argument). */
export function candidatePaths(tool: string, input: Record<string, unknown>): string[] {
  if (tool === 'Read') return typeof input.file_path === 'string' && input.file_path ? [input.file_path] : []
  if (tool === 'Bash') return typeof input.command === 'string' ? [...new Set(bashReads(input.command).map(r => r.path))] : []
  return []
}

/** A path as the session folder's: absolute as written, or under the folder. */
export function absolute(pre: Pre, path: string): string {
  return path.startsWith('/') ? path : `${pre.cwd}/${path.replace(/^\.\/+/, '')}`
}

/** Whether any of these files is a data read by the rule (one stat each, with its realpath). */
export async function anyDataRead(cx: Ctx, pre: Pre, paths: readonly string[]): Promise<boolean> {
  for (const p of paths) {
    const st = await cx.real(absolute(pre, p))
    if (!st?.realPath || st.kind !== 'file') continue
    if (isDataRead(pre.real, st.realPath, st.size, pre.codeTree, pre.never)) return true
  }
  return false
}


// ------------------------------------------------------------------------------------------------ activation

/** The line Claude reads when thimble's tools did not load after the push (logged in PROMPT-CHANGES.md). */
export const NOT_LISTED_LINE = "thimble's tools did not load in this session; do not call them."
/** The notices of 3.20 this module posts. */
export const REFUSED_TEXT = 'thimble does not open this folder (your home folder, `/`, a folder above them or a mount root). cd into the data folder and start `claude` there.'
export const NOT_LISTED_TEXT = "thimble's tools did not load in this session."
/** The toast of the first activation in a folder, which names the switch that stops it. */
export const FIRST_TOAST = 'thimble is on in this folder · /thimble browsers its panel · to turn it off, /plugin'
/** The shim, as /mcp lists the plugin's server, and the tool the push calls. */
export const SHIM = 'plugin:thimble:thimble'
export const LOAD_TOOL = 'load_thimble'
/** How long the tools:not-listed check waits after a push whose record did not come. */
export const LISTED_CHECK_MS = 10_000
const ACTIVATE_TIMEOUT_MS = 20_000
const GUIDE_TIMEOUT_MS = 60_000

/** The guide's lead line names its session's marker (`thimble guidance <marker>:`): the marker, or ''. */
export function markerOf(text: string): string {
  return /(?:^|\n)thimble guidance ([0-9a-f]{8}):/.exec(text)?.[1] ?? ''
}

/** The text of an MCP result's content blocks. */
export function resultText(r: unknown): string {
  const blocks = (r as { content?: unknown } | null | undefined)?.content
  return Array.isArray(blocks) ? blocks.map(b => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n') : ''
}

/** Whether `<home>/up/<sid>/listed.json` holds a record newer than `since` (unix seconds). */
async function listedSince(cx: Ctx, home: string, sid: string, since: number): Promise<boolean> {
  try {
    const v = JSON.parse(await cx.read(`${home}/up/${sid}/listed.json`)) as { at?: unknown }
    return typeof v.at === 'number' && v.at >= since
  } catch {
    return false
  }
}

/** Waits for `p` at most `ms` (a timer of the session's, not a sleep of the hook's), then gives up with null. */
function bounded<T>(cx: Ctx, p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise(resolve => {
    let done = false
    const t = cx.later(ms, () => {
      if (done) return
      done = true
      resolve(null)
    })
    p.then(
      v => {
        if (done) return
        done = true
        t.cancel()
        resolve(v)
      },
      () => {
        if (done) return
        done = true
        t.cancel()
        resolve(null)
      },
    )
  })
}

/** How long a call that did not start the activation waits for it: its budget less a second (C13 hook budget). */
export function waitMs(remainingMs: number): number {
  return Number.isFinite(remainingMs) ? Math.max(0, remainingMs - 1000) : 9000
}

/** thimble on in this session from a call's hook: the one activation, started by the first call and awaited by the
 *  others for at most `waitMs(remainingMs)`. The first call's `deliver` says where the guide goes. */
export async function activateOnce(cx: Ctx, via: string, deliver: Deliver, remainingMs: number): Promise<{ out: Outcome | null; mine: boolean }> {
  if (act.flight) return { out: await bounded(cx, act.flight, waitMs(remainingMs)), mine: false }
  const flight = runActivation(cx, via, deliver)
  act.flight = flight
  try {
    const out = await flight
    // a failure leaves no flight: /thimble may try again (a refused folder's data reads are stopped by `refused`)
    if (!out.ok) act.flight = null
    return { out, mine: true }
  } catch (err) {
    act.flight = null
    throw err
  }
}

/** The steps of one activation (see the file's head). */
async function runActivation(cx: Ctx, via: string, deliver: Deliver): Promise<Outcome> {
  trail(cx, `activate:${via}`)
  const pre = await preScope(cx)
  const sid = await cx.sessionId()
  act.sid = sid
  act.started = (await cx.now()) / 1000
  let printed: { ok?: unknown; ws?: unknown; path?: unknown; role?: unknown; first_in_folder?: unknown; error?: { code?: unknown; message?: unknown; fix?: unknown } } = {}
  try {
    const r = await cx.run([pre.bin, 'activate', '--cwd', pre.cwd, '--session', sid, '--via', via, '--mod', '--json'], { cwd: pre.cwd, env: await envOf(cx), timeoutMs: ACTIVATE_TIMEOUT_MS })
    const got = parsePrinted(r)
    printed = got.ok ? (got.value as typeof printed) : { ok: false, error: { code: 'IO', message: got.error } }
  } catch (err) {
    printed = { ok: false, error: { code: 'IO', message: String(err).slice(0, 300) } }
  }
  if (printed.ok !== true || typeof printed.path !== 'string') {
    const code = String(printed.error?.code ?? 'IO')
    const why = clean(String(printed.error?.message ?? 'it gave no answer'))
    const refused = code.startsWith('REFUSED')
    trail(cx, refused ? 'refused' : 'failed')
    if (refused) {
      act.refused.add(pre.real)
      if (!act.refusedSaid) {
        act.refusedSaid = true
        postNotice(cx, 'activate:refused', REFUSED_TEXT, ['dismiss'])
      }
    } else postNotice(cx, 'activate:failed', `thimble could not open this folder: ${why}`, ['try again', 'doctor'])
    return { ok: false, error: why, refused }
  }
  const activated: Activated = { ws: String(printed.ws ?? ''), path: printed.path, cwd: pre.cwd, via, role: printed.role === 'peer' ? 'peer' : 'main', at: act.started }
  // thimble.ts at once, so the thimble:* agent types are registered in this turn
  trail(cx, 'bridge')
  await cx.bridge(activated).catch(err => cx.log(`thimble: bridgeActivated failed: ${String(err).slice(0, 200)}`))
  trail(cx, 'push')
  let guide = ''
  let pushFailed = ''
  try {
    const m = await cx.mcp(SHIM, LOAD_TOOL, {})
    if ((m as { isError?: unknown }).isError) pushFailed = resultText(m) || 'load_thimble answered an error'
    else guide = resultText(m)
  } catch (err) {
    pushFailed = String(err).slice(0, 300)
  }
  const listed = !pushFailed && (await listedSince(cx, pre.home, sid, act.started))
  await turnOn(cx, activated)
  if (via === 'data') await firstToast(cx, pre.real)
  if (pushFailed || !listed) {
    trail(cx, 'not-listed')
    cx.log(`thimble: its tools did not load after the push${pushFailed ? `: ${pushFailed}` : ' (no listed.json record)'}`)
    act.owed = true
    const started = act.started
    cx.later(LISTED_CHECK_MS, () => {
      void (async () => {
        if (!(await listedSince(cx, pre.home, sid, started))) postNotice(cx, 'tools:not-listed', NOT_LISTED_TEXT, ['/mcp (reconnect thimble)', 'doctor'])
      })().catch(() => undefined)
    })
    return { ok: true, activated, context: deliver === 'context' ? NOT_LISTED_LINE : null }
  }
  const marker = markerOf(guide)
  if (!guide.trim() || !marker) {
    act.owed = true
    postNotice(cx, 'guide:failed', 'thimble could not give Claude its guidance: the shim answered no guidance', ['try again'])
    return { ok: true, activated, context: null }
  }
  if (deliver === 'context') {
    act.pending = marker
    act.owed = true
    trail(cx, 'context')
    return { ok: true, activated, context: guide }
  }
  if (deliver === 'append') {
    await appendGuide(cx, guide)
    return { ok: true, activated, context: null }
  }
  act.owed = true
  return { ok: true, activated, context: null }
}

/** thimble's drawing and runtime on for `a`: the scope, the state, what main's chat drew before (kept.ts), the timers,
 *  the band drawn again, and the settings synced once the hook that turned it on returns. */
export async function turnOn(cx: Ctx, a: Activated): Promise<void> {
  act.active = a
  rt.sc = { ws: a.path.replace(/\/+$/, ''), cwd: a.cwd, bin: (await preScope(cx)).bin, env: await envOf(cx) }
  rt.sig = null
  rt.uiN = -1
  // a turn that runs now (the call that turned thimble on is in it): its rows count from here, for its answer's lines
  if (!rt.turn) rt.turn = { id: '', at: new Date(await cx.now()).toISOString(), cards: [], row: '', parts: [[]], views: [], own: false }
  // the cards' colors in the theme's palette, the browser's (paint.ts)
  setTheme(await cx.theme())
  await cx.setActivated(a)
  await restoreKept(cx).catch(err => cx.log(`thimble: what main's chat drew before could not be read: ${String(err).slice(0, 200)}`))
  startTimers(cx)
  cx.invalidate('ui.render')
  cx.invalidate('command.describe')
  // a /config change may reload the module: never inside the hook that turned thimble on
  syncSoon(cx)
}

/** The toast of the first activation in a folder ($.store keeps the folders that had it). */
async function firstToast(cx: Ctx, folder: string): Promise<void> {
  const had = await cx.storeGet('toasted')
  const folders = Array.isArray(had) ? had.filter((x): x is string => typeof x === 'string') : []
  if (folders.includes(folder)) return
  await cx.storeSet('toasted', [...folders, folder].slice(-500))
  cx.toast(FIRST_TOAST)
}

/** thimble on from anywhere but a data read (`/thimble`, the launcher, a press; C13): the activation, with the guide
 *  kept owed for the caller's delivery point. */
export async function activateNow(cx: Ctx, via: 'data' | 'command' | 'tool' | 'launcher' | 'press'): Promise<{ ok: boolean; error?: string }> {
  if (act.active) return { ok: true }
  const { out } = await activateOnce(cx, via, 'owed', Infinity)
  return out?.ok ? { ok: true } : { ok: false, error: out && !out.ok ? out.error : 'thimble is still turning on' }
}

// ------------------------------------------------------------------------------------------------ the guide

/** `thimble guide` for this session: the guide, or '' when `ifOwed` and it is not owed (C3). */
async function guideRun(cx: Ctx, flags: readonly string[]): Promise<{ text: string; error: string }> {
  const pre = await preScope(cx)
  const sid = await cx.sessionId()
  try {
    const r = await cx.run([pre.bin, 'guide', '--cwd', pre.cwd, '--session', sid, ...flags], { cwd: pre.cwd, env: await envOf(cx), timeoutMs: GUIDE_TIMEOUT_MS })
    return r.exitCode === 0 ? { text: r.stdout, error: '' } : { text: '', error: clean(r.stderr.trim().split('\n').at(-1) ?? `exit ${r.exitCode}`) }
  } catch (err) {
    return { text: '', error: String(err).slice(0, 300) }
  }
}

/** The guide when it is owed now, else '' (none, or a delivery is in flight). Asks thimble once when unknown. */
export async function owedGuide(cx: Ctx): Promise<string> {
  if (!act.active || act.pending || act.owed === false) return ''
  const got = await guideRun(cx, act.owed === null ? ['--if-owed'] : [])
  if (got.error) {
    postNotice(cx, 'guide:failed', `thimble could not give Claude its guidance: ${got.error}`, ['try again'])
    return ''
  }
  const text = got.text
  if (!text.trim() || !markerOf(text)) {
    if (act.owed === null) act.owed = false
    return ''
  }
  act.owed = true
  return text
}

/** A delivery of `guide` starts (its row not stored yet). */
export function deliverStarts(guide: string): void {
  act.pending = markerOf(guide)
}

/** A delivery that did not go out (a dropped prompt, a refused row): the guide stays owed. */
export function deliveryLost(): void {
  act.pending = ''
  act.owed = true
}

/** The guide marked sent: `thimble guide --mark` (C3), once the row that carries it is stored. */
export async function markGuide(cx: Ctx): Promise<void> {
  act.pending = ''
  act.owed = false
  trail(cx, 'marked')
  const got = await guideRun(cx, ['--mark'])
  if (got.error) cx.log(`thimble: the guide could not be marked sent: ${got.error}`)
}

/** A stored row of main's conversation: when it carries the guide a delivery sent (its lead line with the session's
 *  marker), the guide is marked sent. */
export async function rowStored(cx: Ctx, row: { agentId?: string; text: string }): Promise<void> {
  if (!act.pending || row.agentId !== undefined) return
  if (!row.text.includes(`thimble guidance ${act.pending}:`)) return
  await markGuide(cx)
}

/** The guide as a hidden user row in main's conversation (after a compaction, after a subagent's activation): marked
 *  sent once the session stored it, owed when it refused. */
export async function appendGuide(cx: Ctx, guide: string): Promise<void> {
  // marked from the call's own answer (the stored row), not again by the session.append hook that sees the row
  act.pending = ''
  trail(cx, 'append')
  const r = await cx.append(guide)
  if (r.stored) await markGuide(cx)
  else {
    cx.log(`thimble: the guide's row was not stored: ${r.reason ?? 'refused'}`)
    deliveryLost()
  }
}

/** After a compaction of main's conversation (`session.compact` without `skip`): the guide owed again and appended
 *  whole as a hidden user row, which a running turn reads at its loop's next top. */
export async function guideAfterCompact(cx: Ctx): Promise<void> {
  if (!act.active) return
  act.pending = ''
  const un = await guideRun(cx, ['--unmark'])
  if (un.error) cx.log(`thimble: the guide could not be marked owed: ${un.error}`)
  act.owed = true
  const guide = await owedGuide(cx)
  if (guide) await appendGuide(cx, guide)
}

// ------------------------------------------------------------------------------------------------ session identity

/** A /clear or /resume ended the conversation `from` (session.end): the next call of the new conversation rekeys. */
export function conversationEnded(from: string, reason: string): void {
  if (!act.active || (reason !== 'clear' && reason !== 'resume')) return
  act.rekey = { from, reason }
}

/** The new conversation after a /clear or /resume: `thimble activate --rekey-from` (the SessionStart hook may have run
 *  it first; either one wins), thimble.ts told again, and the guide owed after /clear, unknown after /resume. */
export async function followConversation(cx: Ctx): Promise<void> {
  const k = act.rekey
  if (!k || !act.active) return
  const sid = await cx.sessionId()
  if (!sid || sid === k.from) return
  act.rekey = null
  act.sid = sid
  act.pending = ''
  const pre = await preScope(cx)
  try {
    await cx.run([pre.bin, 'activate', '--cwd', pre.cwd, '--session', sid, '--via', act.active.via === 'data' ? 'data' : 'command', '--rekey-from', k.from, '--mod', '--json'], { cwd: pre.cwd, env: await envOf(cx), timeoutMs: ACTIVATE_TIMEOUT_MS })
  } catch (err) {
    cx.log(`thimble: the new conversation could not take over thimble: ${String(err).slice(0, 200)}`)
  }
  act.owed = k.reason === 'clear' ? true : null
  trail(cx, `rekey:${k.reason}`)
  await cx.bridge(act.active).catch(() => undefined)
  trail(cx, 'bridge')
}

/** This session's marker (`<home>/up/<sid>.active`, C1) when it says thimble is on in this folder: a module reload or a
 *  resumed session restores from it quietly (no push; the guide only if owed). */
export async function restoreFromMarker(cx: Ctx): Promise<boolean> {
  const pre = await preScope(cx)
  const sid = await cx.sessionId()
  let m: { cwd?: unknown; ws?: unknown; path?: unknown; via?: unknown; role?: unknown; at?: unknown }
  try {
    m = JSON.parse(await cx.read(`${pre.home}/up/${sid}.active`)) as typeof m
  } catch {
    return false
  }
  if (typeof m.path !== 'string' || typeof m.cwd !== 'string') return false
  const cwdReal = (await cx.real(m.cwd))?.realPath ?? m.cwd
  if (cwdReal !== pre.real && m.cwd !== pre.cwd) return false
  act.sid = sid
  const a: Activated = { ws: String(m.ws ?? ''), path: m.path, cwd: pre.cwd, via: String(m.via ?? 'command'), role: m.role === 'peer' ? 'peer' : 'main', at: typeof m.at === 'number' ? m.at : 0 }
  act.flight = Promise.resolve({ ok: true, activated: a, context: null })
  trail(cx, 'restore')
  // thimble.ts told again, so a reloaded module keeps thimble's agent types registered
  await cx.bridge(a).catch(() => undefined)
  trail(cx, 'bridge')
  await turnOn(cx, a)
  act.owed = null
  return true
}

/** Claude called `load_thimble` (the shim turned thimble on and answered the guide): thimble on here too, with no
 *  second activation; the guide's tool-result row marks it sent once stored. */
export async function sawLoadThimble(cx: Ctx, answer: string): Promise<void> {
  const marker = markerOf(answer)
  if (marker && !act.pending) act.pending = marker
  if (act.active) return
  trail(cx, 'saw-load')
  // the guide went with the tool's result, which the shim marked or its stored row marks (rowStored)
  if ((await restoreFromMarker(cx)) && marker) {
    act.owed = false
    act.pending = marker
  }
}

/** What activation did, for the debug log and the tests. */
export function activationTrail(): readonly string[] {
  return act.trail
}

