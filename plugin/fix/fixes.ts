// fixes.ts: the person's fixes as the hooks module knows them, and what the person's keys do to them. The kernel
// (`thimble fix …`, engine/kernel/fixes.py) holds the records and makes every change to live; this module calls it as
// the person's own command and keeps what the bar and the line draw.
//
//   refreshFixes($)          the kernel's list, into $.state fixes
//   fixLineNow($), setFixLine  the one line above the bar for one fix (line.ts draws it)
//   applyFix($, id)          y, on the line: a secret made at this press, its sha256 in
//                            asks/<id>.json, the secret to `thimble fix apply` on stdin; then /reload-plugins, at
//                            once, or at the end of Claude's turn when it is mid-reply; in a session that loads
//                            thimble with --plugin-dir, the line names the restart instead
//   undoFix, notNow           the line's other keys
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
import { mainRuns } from '../core/turn'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const LIST = { plugin: 'thimble', key: 'fixes' } as const
const LINE = { plugin: 'thimble', key: 'fixLine' } as const

export type FixFile = { path: string; add: number | null; del: number | null }
export type Fix = {
  id: number; title: string; words: string[]; rounds: number; made_in: string; created: number; state: string
  work: string | null; commit: string | null; files: FixFile[]; tests: string | null; summary: string; error: string | null
  note?: string; pr?: string; saved?: string; tests_tail?: string; released_in?: string
  pending?: { why: string; version: string; files?: string[]; tests?: string; old?: string } | null
  on_at?: number
  /** a fix changed in place (a round of a fix that was on, off or ready): its version before the round, which stays as
   *  it was until the person's y puts the new version on, and which u brings back after it */
  prev?: { state: string; commit?: string | null; title?: string; summary?: string; on_at?: number } | null
  /** done's answer for a round of a fix changed in place that changed no code: the fix stays as it was */
  unchanged?: boolean
  /** the fixes merged into this one; fold_conflict: the fix this stray from before follows up on, whose lines conflict */
  merged?: number[]; fold_conflict?: number
  /** other fixes the person's words name ("fold in fix 4"): each one's change as a patch in the fixer's temp folder */
  patches?: { id: number; title: string; path: string }[]
  /** the Claude Code session whose fixer works on it (new, round, redo): only that session ends it */
  session?: string | null
  /** the last check did not use the change, and why; kept until the next check, so that the next fixer in the copy
   *  (another round, at once, or r) is told */
  refused?: Refusal | null
}
/** A fix as the person and Claude read it in a session: its name (its title), cut to `n` cells. The number is the
 *  shell's handle (thimble fix off 2), never the name. */
export const fixName = (f: Pick<Fix, 'id' | 'title'>, n = 60): string => cut(f.title || `fix ${f.id}`, n)

/** Whether a fix had a version before this round: a change to a fix the person has, not a new fix. */
export const isChange = (f: Pick<Fix, 'prev'>): boolean => !!f.prev

/** The bar's step while a fixer works: `fixing <name>` for a new fix, `changing <name>` for a fix the person has. */
export const fixingWord = (f: Fix): string => `${isChange(f) ? 'changing' : 'fixing'} ${fixName(f, 28)}`

/** The fixer's subagent, by the fix's name: `fix-click-card-elements`. A new fix's name is the start of the person's
 *  words until the fixer gives it a title. */
export function fixSlug(f: Pick<Fix, 'id' | 'title'>): string {
  const words = String(f.title || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
  const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'and', 'or', 'it', 'is', 'in', 'on', 'for', 'with', 'should', 'be', 'when', 'i', 'my', 'make', 'so'])
  const kept = words.filter(w => !STOP.has(w))
  let slug = ''
  for (const w of kept.length ? kept : words) {
    if (slug && slug.length + 1 + w.length > 28) break
    slug = slug ? `${slug}-${w}` : w.slice(0, 28)
  }
  return `fix-${slug || f.id}`
}

/** Why the check did not use a fixer's change: the files it may not change (safety files, a binary file), or the end of
 *  the tests' output when they failed. */
export type Refusal = { why: string; files: string[]; tests?: string }
export type FixList = { fixes: Fix[]; on: boolean; live: string; version: string; count_on: number; pointed: boolean; pending?: string | null; gen: number }
/** The line above the bar for one fix: ready (y use it now · d what changed · n later), applied (u undo), off (after
 *  u), failed (d what changed · r redo · n later), request (no code), a new release with the fixes replayed on it
 *  (update), a newer release is out (release), or a problem with what to do. `open`: d shows what changed under it. `reload` (applied): `pending` while
 *  the reload waits for Claude's turn to end, `restart` in a session that loads thimble with --plugin-dir. */
export type FixLine = {
  id: number; kind: 'ready' | 'applied' | 'off' | 'failed' | 'request' | 'problem' | 'update' | 'release'; said?: string; open?: boolean; reload?: 'pending' | 'restart'
  /** off: u brought back the fix's version before its last change, which is on (or off) as it was */
  back?: boolean
  /** request: a round of a fix the person has changed no code, so the fix stays as it was */
  kept?: boolean
}

export const fixesDir = (home: string) => `${home.replace(/\/+$/, '')}/fixes`

/** `thimble fix …` as the person's own command. `stdin`: words, or the secret of a key press. */
/** This Claude Code session's id, or '' when Claude Code does not give one. */
export async function sessionIdNow($: Engine): Promise<string> {
  try { return String((await $.session.id()) ?? '') } catch { return '' }
}

/** The verbs that start or end a fixer's work: the kernel records the session on them, and done refuses a fix whose
 *  fixer works in another session. */
const SESSION_VERBS = new Set(['new', 'round', 'again', 'redo', 'done'])

export async function kernelFix($: Engine, args: string[], o: { stdin?: string; timeoutMs?: number; doing?: string } = {}): Promise<{ ok: boolean; out: string; err: string }> {
  if (SESSION_VERBS.has(args[0] ?? '')) {
    const sid = await sessionIdNow($)
    if (sid) args = [...args, '--session', sid]
  }
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

/** A reload that was due runs now (the end of a turn). One that fails says so, with the command that loads it. */
export async function reloadIfDue($: Engine): Promise<void> {
  if (reloadDue && !(await reloadPlugins($))) failNotice($, 'thimble changed, and Claude Code did not load it again by itself. Type /reload-plugins.')
}

/** The reload a line waited for came (this module is a new load of the plugin): the line says thimble reloaded. */
export async function reloaded($: Engine): Promise<void> {
  const l = await fixLineNow($)
  if (l?.kind === 'applied' && l.reload === 'pending') await setFixLine($, { id: l.id, kind: 'applied' })
}

/** Whether this session loads thimble with --plugin-dir: then Claude Code's copy of the fixes is not what it loads, and
 *  a restart with the fixes' folder loads them. Claude Code names such a plugin's settings `<name>@inline.<field>`. */
export async function pluginDirSession($: Engine): Promise<boolean> {
  try {
    return (await $.config.list()).some(r => String(r.key).startsWith(`${$.plugin.name}@inline.`))
  } catch {
    return false
  }
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

/** y on a ready fix: the fix goes on, and the session loads it. */
export async function applyFix($: Engine, id: number): Promise<string | null> {
  const secret = await pressKey($, id)
  const was = await fixOf($, id)
  const name = was ? `“${fixName(was)}”` : `Fix ${id}`
  const r = await kernelFix($, ['apply', String(id), '--ask', '-'], { stdin: secret, timeoutMs: 300000, doing: `applying ${was ? fixName(was, 28) : `fix ${id}`}` })
  if (!r.ok) {
    await refreshFixes($)
    return `${name} was not applied: ${cut(r.err || 'thimble fix apply gave nothing', 220)}`
  }
  const d = jsonOf<Any>(r.out) ?? {}
  await refreshFixes($)
  const f = await fixOf($, id)
  // a --plugin-dir session loads its own folder: the line names the restart. Mid-reply, the reload waits for the turn's
  // end (turn.complete runs reloadIfDue), and the line says so until the new load (reloaded)
  const reload = (await pluginDirSession($)) ? 'restart' : d.reload && (await mainRuns($)) ? 'pending' : undefined
  await setFixLine($, { id, kind: 'applied', ...(reload ? { reload } : {}) })
  if (d.reload && !reload) $.ui.log(`thimble reloaded its plugins: ${f ? `“${f.title}”` : `fix ${id}`} is on${d.changed ? ', in its new version' : ''}.`)
  await tellAtNextPrompt($, `fix-${id}`, `The person applied their thimble fix "${f?.title ?? id}"${d.changed ? ' in its new version' : ''}: it is now part of their thimble${d?.version ? ` (${d.version})` : ''}.`)
  if (reload === 'pending') {
    reloadDue = true
    // the turn ended while the fix went on: its end found nothing due, so the reload runs now
    if (!(await mainRuns($))) {
      await setFixLine($, { id, kind: 'applied' })
      await load($, d)
    }
  } else if (!reload) await load($, d)
  return null
}

/** u: the fix comes out of mine, kept for later. */
export async function undoFix($: Engine, id: number): Promise<string | null> {
  const was = await fixOf($, id)
  const name = was ? `“${fixName(was)}”` : `Fix ${id}`
  const r = await kernelFix($, ['undo', String(id)], { timeoutMs: 300000, doing: `undoing ${was ? fixName(was, 28) : `fix ${id}`}` })
  if (!r.ok) return `${name} was not undone: ${cut(r.err || 'thimble fix undo gave nothing', 220)}. In a shell: thimble fix off ${id}`
  const d = jsonOf<Any>(r.out) ?? {}
  await refreshFixes($)
  const l = await fixLineNow($)
  // a fix changed in place goes back to its version before the change; else it goes off
  if (l?.id === id) await setFixLine($, { id, kind: 'off', ...(d.back ? { back: true } : {}) })
  if (d.reload) $.ui.log(`thimble reloaded its plugins: ${name} ${d.back ? 'is back to its version before' : 'is off'}.`)
  await tellAtNextPrompt($, `fix-${id}`, d.back
    ? `The person undid the last change to their thimble fix "${was?.title ?? id}": its version before is back.`
    : `The person undid their thimble fix "${was?.title ?? id}": it is off, kept in their list.`)
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

/** /thimble-fix alone: how to ask, and where the fixes are listed and managed (a shell: they act across sessions). */
export const FIX_ALONE = [
  'Ask for a change to thimble with /thimble-fix <what should work differently>.',
  'Your fixes are listed and managed in a shell: thimble fix list (thimble fix --help shows the rest).',
].join('\n')

/** /thimble-fix update: thimble update runs in a shell, not in this session, because it changes the thimble the session
 *  runs. The reply says so, with the commands. */
export const UPDATE_IN_SHELL = 'thimble update runs in a shell, not inside Claude Code: it changes the thimble this session runs. In a terminal, run thimble update; it says when to run thimble reapply for your fixes. Then type /reload-plugins here.'

/** At session start, while thimble runs from live: one line when a newer release is out. Nothing moves until the
 *  person runs thimble update (it can take minutes, and a fix that does not fit needs them). */
export async function checkUpdate($: Engine): Promise<void> {
  const r = await kernelFix($, ['update', '--check', '--json'], { timeoutMs: 60000 }).catch(() => null)
  const d = r?.ok ? jsonOf<Any>(r.out) : null
  if (d?.newer) await setFixLine($, { id: 0, kind: 'release', said: `thimble ${d.to} is out (you have ${d.from}) · in a shell: thimble update` })
}

/** Claude ran `thimble update` (the pending fixes' prompt asks for --continue): the session loads what it changed at the
 *  end of the turn, and the list shows the fixes as they are now. */
export async function updateRan($: Engine): Promise<void> {
  reloadDue = true
  await refreshFixes($)
}

/** The path of the fixes' home, as the person reads it (~ for the home folder). */
export async function shownPath($: Engine, p: string): Promise<string> {
  const home = String((await $.env.get('HOME')) || '').replace(/\/+$/, '')
  return home && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p
}
