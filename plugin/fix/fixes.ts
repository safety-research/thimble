// fixes.ts: the person's fixes as the hooks module knows them, and what the person's keys do to them. The kernel
// (`thimble fix …`, engine/kernel/fixes.py) holds the records and makes every change to live; this module calls it as
// the person's own command and keeps what the bar, the line and the pane draw.
//
//   refreshFixes($)          the kernel's list, into $.state fixes
//   fixLineNow($), setFixLine  the one line above the bar for one fix (line.ts draws it)
//   applyFix($, id)          y, or u on an off fix in the list: a secret made at this press, its sha256 in
//                            asks/<id>.json, the secret to `thimble fix apply` on stdin; then /reload-plugins
//   undoFix, notNow, removeFix, allOff, allOn   the other keys
//   reloadPlugins($)         /reload-plugins, once the session is idle, so the person never types it
//
//   state: fixes (the list), fixLine (the line)
import type { EngineInterface } from 'claude-code'

import { busy } from '../bar/busy'
import { failNotice } from '../bar/notice'
import { rootHere, runThimble, startDir } from '../core/env'
import { thimbleHome } from '../core/home'
import { tellAtNextPrompt } from '../core/tell'
import { cut } from '../core/text.js'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const LIST = { plugin: 'thimble', key: 'fixes' } as const
const LINE = { plugin: 'thimble', key: 'fixLine' } as const

export type FixFile = { path: string; add: number | null; del: number | null }
export type Fix = {
  id: number; title: string; words: string[]; rounds: number; made_in: string; created: number; state: string
  work: string | null; commit: string | null; files: FixFile[]; tests: string | null; summary: string; error: string | null
  note?: string; pr?: string; saved?: string; tests_tail?: string
}
export type FixList = { fixes: Fix[]; on: boolean; live: string; version: string; count_on: number; pointed: boolean; gen: number }
/** The line above the bar for one fix: ready (y apply · d diff · n not now), applied (u undo), off (after u),
 *  failed (d diff · r redo · n not now), request (no code), a new release with the fixes replayed on it (update), or a
 *  problem with what to do. */
export type FixLine = { id: number; kind: 'ready' | 'applied' | 'off' | 'failed' | 'request' | 'problem' | 'update'; said?: string }

export const fixesDir = (home: string) => `${home.replace(/\/+$/, '')}/fixes`

/** `thimble fix …` as the person's own command. `stdin`: words, or the secret of a key press. */
export async function kernelFix($: Engine, args: string[], o: { stdin?: string; timeoutMs?: number; doing?: string } = {}): Promise<{ ok: boolean; out: string; err: string }> {
  const root = (await rootHere($)) || (await startDir($))
  const call = () => runThimble($, root, ['fix', ...args], { timeoutMs: o.timeoutMs ?? 120000, ...(o.stdin != null ? { stdin: o.stdin } : {}) })
  const r = o.doing ? await busy($, o.doing, call) : await call()
  return { ok: r.code === 0, out: r.stdout, err: r.stderr.trim().replace(/^thimble fix \w+: /, '') }
}

/** The kernel's JSON answer, or null. */
export function jsonOf<T>(s: string): T | null {
  try { return JSON.parse(s) as T } catch { return null }
}

/** The fixes, read again from the kernel. */
export async function refreshFixes($: Engine): Promise<FixList | null> {
  const r = await kernelFix($, ['list', '--json'], { timeoutMs: 30000 }).catch(() => null)
  const d = r?.ok ? jsonOf<FixList>(r.out) : null
  if (!d) return fixesNow($)
  const was = await fixesNow($)
  const next = { ...d, gen: (was?.gen ?? 0) + 1 }
  await $.state.set(LIST, next as never)
  return next
}

export async function fixesNow($: Engine): Promise<FixList | null> {
  return ((await $.state.get(LIST)).value ?? null) as FixList | null
}

export async function fixOf($: Engine, id: number): Promise<Fix | null> {
  return (await fixesNow($))?.fixes.find(f => f.id === id) ?? null
}

export async function fixLineNow($: Engine): Promise<FixLine | null> {
  return ((await $.state.get(LINE)).value ?? null) as FixLine | null
}

export async function setFixLine($: Engine, l: FixLine | null): Promise<void> {
  await $.state.set(LINE, l as never)
}

/** The files a fix changed, in a few words: `3 files +29 −2`. */
export function sizeOf(f: Pick<Fix, 'files'>): string {
  const files = f.files || []
  const add = files.reduce((n, x) => n + (x.add || 0), 0)
  const del = files.reduce((n, x) => n + (x.del || 0), 0)
  return `${files.length} file${files.length === 1 ? '' : 's'} +${add} −${del}`
}

/** A load of the plugins asked for and not run yet: Claude Code refuses one asked inside a hook a turn waits on, so it
 *  stays due until the next look outside one. */
let reloadDue = false

export async function reloadPlugins($: Engine): Promise<boolean> {
  reloadDue = true
  try {
    await $.command.run({ command: 'reload-plugins', args: '' } as Any)
    reloadDue = false
    return true
  } catch {
    return false
  }
}

/** A reload that was due runs now (the end of a turn). */
export async function reloadIfDue($: Engine): Promise<void> {
  if (reloadDue) await reloadPlugins($)
}

/** The person's key press: a new secret held only here, its sha256 in asks/<id>.json for the kernel to check. The
 *  secret goes to the kernel on stdin, so no file, argument or line of the feed holds it. */
export async function pressKey($: Engine, id: number): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const secret = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
  const sum = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)))
  const hex = [...sum].map(b => b.toString(16).padStart(2, '0')).join('')
  await $.fs.write(`${fixesDir(await thimbleHome($))}/asks/${id}.json`, `${JSON.stringify({ key: hex })}\n`)
  return secret
}

/** The session loads what live shows now, when the kernel says it changed. Last in a key's work: the reload loads
 *  this module again, so what the person should see is in $.state before it. Claude Code refuses a reload asked
 *  inside a hook it waits on (a slash command's), so a refused one is asked again a moment after that hook. */
async function load($: Engine, d: Any): Promise<void> {
  if (!d?.reload) return
  if (await reloadPlugins($)) return
  $.clock.after(300, () => {
    void reloadPlugins($).then(ok => { if (!ok) failNotice($, 'thimble changed, and Claude Code did not load it again by itself. Type /reload-plugins.') })
  })
}

/** y on a ready fix, or u on an off one in the list: the fix goes on, and the session loads it. */
export async function applyFix($: Engine, id: number): Promise<string | null> {
  const secret = await pressKey($, id)
  const r = await kernelFix($, ['apply', String(id), '--ask', '-'], { stdin: secret, timeoutMs: 300000, doing: `applying fix ${id}` })
  if (!r.ok) {
    await refreshFixes($)
    return `Fix ${id} was not applied: ${cut(r.err || 'thimble fix apply gave nothing', 220)}`
  }
  const d = jsonOf<Any>(r.out) ?? {}
  await refreshFixes($)
  const f = await fixOf($, id)
  await setFixLine($, { id, kind: 'applied' })
  if (d.reload) $.ui.log(`thimble reloaded its plugins: fix ${id}${f ? `, “${f.title}”,` : ''} is on.`)
  await tellAtNextPrompt($, `fix-${id}`, `The person applied thimble fix ${id}${f ? ` ("${f.title}")` : ''}: it is now part of their thimble${d?.version ? ` (${d.version})` : ''}.`)
  await load($, d)
  return null
}

/** u: the fix comes out of mine, kept for later. */
export async function undoFix($: Engine, id: number): Promise<string | null> {
  const r = await kernelFix($, ['undo', String(id)], { timeoutMs: 300000, doing: `undoing fix ${id}` })
  if (!r.ok) return `Fix ${id} was not undone: ${cut(r.err || 'thimble fix undo gave nothing', 220)}. In a shell: thimble fix off`
  const d = jsonOf<Any>(r.out) ?? {}
  await refreshFixes($)
  const l = await fixLineNow($)
  if (l?.id === id) await setFixLine($, { id, kind: 'off' })
  if (d.reload) $.ui.log(`thimble reloaded its plugins: fix ${id} is off.`)
  await tellAtNextPrompt($, `fix-${id}`, `The person undid thimble fix ${id}: it is off, kept in their list.`)
  await load($, d)
  return null
}

/** n: the fix stays in the list, off. */
export async function notNow($: Engine, id: number): Promise<string | null> {
  const r = await kernelFix($, ['notnow', String(id)], { timeoutMs: 60000 })
  await refreshFixes($)
  if ((await fixLineNow($))?.id === id) await setFixLine($, null)
  return r.ok ? null : `× ${cut(r.err || 'thimble fix notnow gave nothing', 220)}`
}

/** x in the list: the fix leaves the list (off first when it was on). */
export async function removeFix($: Engine, id: number): Promise<string | null> {
  const r = await kernelFix($, ['remove', String(id)], { timeoutMs: 300000, doing: `removing fix ${id}` })
  if (!r.ok) return `× ${cut(r.err || 'thimble fix remove gave nothing', 220)}`
  await refreshFixes($)
  if ((await fixLineNow($))?.id === id) await setFixLine($, null)
  await load($, jsonOf<Any>(r.out))
  return null
}

/** Turn every fix off (the plain release), or on again. */
export async function allOffOn($: Engine, on: boolean): Promise<string | null> {
  const r = await kernelFix($, [on ? 'on' : 'off'], { timeoutMs: 300000, doing: on ? 'turning your fixes on' : 'turning your fixes off' })
  if (!r.ok) return `× ${cut(r.err || 'thimble fix gave nothing', 220)}`
  await refreshFixes($)
  if (/reload-plugins/.test(r.out)) await load($, { reload: true })
  return null
}

/** A fix's change, as `git show` gives it. */
export async function diffText($: Engine, id: number): Promise<string> {
  const r = await kernelFix($, ['diff', String(id)], { timeoutMs: 30000 }).catch(() => null)
  return r?.ok ? r.out : ''
}

/** A newer release, and the fixes replayed on it (at session start, and /thimble-fix update): the line says what came
 *  of it, and the session loads it. The words, or '' when nothing changed. */
export async function updateFixes($: Engine): Promise<string> {
  const r = await kernelFix($, ['update', '--json'], { timeoutMs: 600000, doing: 'replaying your fixes on a new thimble' })
  if (!r.ok) {
    await setFixLine($, { id: 0, kind: 'problem', said: `Your fixes could not move to the new thimble: ${cut(r.err || 'thimble fix update gave nothing', 200)}. They stay as they were.` })
    return ''
  }
  const d = jsonOf<Any>(r.out) ?? {}
  await refreshFixes($)
  if (!d.said) return ''
  await setFixLine($, { id: 0, kind: 'update', said: String(d.said) })
  await tellAtNextPrompt($, 'fix-update', `thimble moved to a new release and replayed the person's fixes on it: ${d.said}.`)
  await load($, d)
  return String(d.said)
}

/** The path of the fixes' home, as the person reads it (~ for the home folder). */
export async function shownPath($: Engine, p: string): Promise<string> {
  const home = String((await $.env.get('HOME')) || '').replace(/\/+$/, '')
  return home && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p
}
