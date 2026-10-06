// thimble-term's one way to thimble's data: the `thimble` command, with no server and no port.
//
//   readState(surface, args)   `thimble state <surface> --cwd <dir> [args]`, which prints the JSON the server's GET route
//                              for that surface gives the browser; `{error}` and exit 1 when it fails
//   act(kind, payload)         `thimble act <kind> --cwd <dir> <json>`, which calls what the browser's POST route calls
//                              and prints `{ok, …}`
//
// The renderer keeps no data of its own: what these print is drawn, and read again when the workspace changes. To see
// that it changed without starting Python, `signature` lists the workspace's folders (names, sizes and times only).
//
// The scope: thimble-term draws only in a session the `thimble` command started in terminal mode, which puts the
// workspace folder in THIMBLE_WS and writes `mode: "terminal"` in its trusted/launch.json. Anywhere else it is idle.
import type { Ctx } from './ctx'

/** Where this session's thimble lives: its workspace folder, the corpus folder, the command and the environment each
 *  call carries. */
export type Scope = { ws: string; cwd: string; bin: string; env: Record<string, string> }

export type Got<T = unknown> = { ok: true; value: T } | { ok: false; error: string }

const STATE_TIMEOUT_MS = 60_000
const ACT_TIMEOUT_MS = 60_000

/** The `thimble` command beside this plugin in thimble's tree (`<tree>/mods/thimble-term` → `<tree>/plugin/bin/thimble`),
 *  or the one THIMBLE_TERM_CLI names (the tests' and the live check's stand-in). */
export function cliOf(root: string, override: string | undefined): string {
  if (override) return override
  const dir = root.replace(/\/+$/, '').replace(/\/\.claude-plugin$/, '')
  return `${dir.replace(/\/mods\/[^/]+$/, '')}/plugin/bin/thimble`
}

/** launch.json's mode, or '' when it names none or cannot be read. */
export function launchMode(raw: string): string {
  try {
    const v = JSON.parse(raw) as { mode?: unknown }
    return typeof v?.mode === 'string' ? v.mode : ''
  } catch {
    return ''
  }
}

/** This session's scope when it runs in terminal mode, else null (thimble-term stays idle). */
export async function scopeOf(cx: Ctx): Promise<Scope | null> {
  const ws = ((await cx.env('THIMBLE_WS').catch(() => undefined)) ?? '').replace(/\/+$/, '')
  if (!ws) return null
  const raw = await cx.read(`${ws}/trusted/launch.json`).catch(() => '')
  if (launchMode(raw) !== 'terminal') return null
  const cwd = await cx.root()
  const bin = cliOf(cx.pluginRoot, (await cx.env('THIMBLE_TERM_CLI').catch(() => undefined)) || undefined)
  const env: Record<string, string> = { THIMBLE_WS: ws, THIMBLE_MODE: 'terminal' }
  for (const k of ['THIMBLE_HOME', 'THIMBLE_PORT', 'THIMBLE_UI_PORT']) {
    const v = await cx.env(k).catch(() => undefined)
    if (v) env[k] = v
  }
  return { ws, cwd, bin, env }
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

// ------------------------------------------------------------------------------------------------ what changed

/** The parts of a workspace a surface reads, each with the folders or files whose listing says it changed. */
export const AREAS = {
  cards: ['notebooks'],
  labels: ['concepts', 'labels'],
  docs: ['investigations/main', 'investigations/main/report'],
  chats: ['chats'],
  agents: ['trusted/subagents.json', 'orient/run.json', 'trusted/module.json'],
  ui: ['ui.jsonl'],
} as const

export type Area = keyof typeof AREAS
export type Signature = Record<Area, string>

async function stamp(cx: Ctx, path: string): Promise<string> {
  try {
    const st = await cx.stat(path)
    if (st.kind !== 'dir') return `${st.size}:${st.mtimeMs}`
    const entries = await cx.list(path)
    // a file's size and time, a folder's name: what an edit, an add or a remove changes
    return entries
      .map(e => `${e.name}:${e.kind === 'file' ? `${e.size}:${e.mtimeMs}` : e.kind}`)
      .sort()
      .join('|')
  } catch {
    return '-'
  }
}

/** One stamp per area: a change of any file it reads changes it. */
export async function signature(cx: Ctx, sc: Scope): Promise<Signature> {
  const out = {} as Signature
  for (const area of Object.keys(AREAS) as Area[]) {
    const parts: string[] = []
    for (const rel of AREAS[area]) parts.push(await stamp(cx, `${sc.ws}/${rel}`))
    out[area] = parts.join('#')
  }
  return out
}

/** The areas whose stamp differs between two signatures (every area when there was none before). */
export function changed(before: Signature | null, now: Signature): Area[] {
  return (Object.keys(now) as Area[]).filter(a => !before || before[a] !== now[a])
}
