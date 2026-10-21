// fix.ts: the terminal's part of "fix it yourself". The kernel's `thimble fix` verbs make a fix in a git worktree of
// thimble, load it into the person's thimble, and build the share (plugin/engine/kernel/fix.py); this module shows
// what the person needs to see of that and gives them its keys.
//
//   failNotice    a failure line: the one-line notice, with `f fix this · F report only`; the bar keeps the keys until
//                 the person types their next prompt. f or F sends a turn to main (fixask.js), as v does
//   refreshFixes  $THIMBLE_HOME/fixes/*/fix.json: a fix that works shows in the bar (`fixing: <title>`); one that the
//                 person's thimble now uses shows one line, `✓ Your thimble now has the fix: <title>`, with
//                 `p share it · u undo`. u runs `thimble fix undo` as the person. Each switch it sees (a fix on, a new
//                 round, the fix off) loads the plugins once, so the person never types /reload-plugins
//   fixCommand    /thimble:fix, the one way in: words are the change the person wants (the command's text asks Claude,
//                 commands/fix.md); submit, undo and try do what p and u do, for the fix that is on or the newest;
//                 remove turns a fix off and deletes its copy and its record
//   fixAskFromFeed  a `fix_ask` line of the change feed (`thimble fix draft` built the share and waits for the person):
//                 the preview opens in the side panel (panes/fix.js). y, w and k run `thimble fix send|keep … --ask -`
//                 as the person: each key press makes a new secret, held only here, writes its sha256 into
//                 share/ask.json and gives the secret on stdin. No file, argument or feed line holds it, so Claude's
//                 shell cannot send
//
//   state: fixline (the line whose keys the bar names: a failure, a fix in use, or a notice that a fix went off),
//   fixes (the fixes that work), fixshare (a fix's share, by slug)
import type { EngineInterface } from 'claude-code'

import { ask, leanEnv, noteForClaude, rootHere } from './shell'
import { openSide, sideBack, sideNow } from './side'
import { PANE as PANEL } from './detail'
import { FAIL_KEYS, fixRequest, fixVerb, lineKey, shareRequest, USE_KEYS } from './fixask.js'
import { busy } from './busy'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const LINE = { plugin: 'thimble', key: 'fixline' } as const
const FIXES = { plugin: 'thimble', key: 'fixes' } as const
const SHARE = { plugin: 'thimble', key: 'fixshare' } as const
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/

export type FixLine = { kind: 'failed'; text: string } | { kind: 'applied'; slug: string; title: string; said?: string } | { kind: 'notice'; text: string }
type Fix = { slug: string; title: string; kind: string; status: string; created: number; used: number }

const cut = (s: string, n: number) => ([...s].length <= n ? s : `${[...s].slice(0, n - 1).join('')}…`)

async function home($: Engine): Promise<string> {
  return String((await $.env.get('THIMBLE_HOME')) || `${(await $.env.get('HOME')) || '.'}/.thimble`).replace(/\/+$/, '')
}

async function readText($: Engine, path: string): Promise<string | null> {
  try { return String(await $.fs.read(path)) } catch { return null }
}

async function readJson($: Engine, path: string): Promise<Any> {
  const t = await readText($, path)
  if (t == null) return null
  try { return JSON.parse(t) } catch { return null }
}

/** `thimble fix …` as the person's own command: its exit code and its words. `stdin`: the secret of a key press. */
async function kernel($: Engine, args: string[], stdin?: string): Promise<{ ok: boolean; out: string }> {
  const root = (await rootHere($)) || (await home($))
  const dir = $.plugin.root.replace(/\/+$/, '')
  const env = await leanEnv($, root)
  const r = await busy($, 'fixing', () => $.process.run([`${dir}/bin/thimble`, 'fix', ...args], { cwd: root, env, timeoutMs: 300000, ...(stdin != null ? { stdin } : {}) }))
  return { ok: (r.exitCode ?? 1) === 0, out: `${String(r.stdout || '')}${r.stderr ? `\n${String(r.stderr)}` : ''}`.trim() }
}

const lastLine = (s: string) => s.split('\n').map(l => l.trim()).filter(Boolean).slice(-1)[0] || ''
/** The kernel's last line without its `thimble fix <verb>: ` prefix, and with its first letter a capital. */
const said = (s: string) => { const l = lastLine(s).replace(/^thimble fix \w+: /, ''); return l.charAt(0).toUpperCase() + l.slice(1) }

/** One line for the person: a toast, and when it holds a command to run (a --plugin-dir session's `quit and run: …`),
 *  also a row of the transcript, which keeps the whole command where the toast cuts it. */
function sayLine($: Engine, said: string): void {
  if (/quit and run: /.test(said)) {
    $.ui.log(said)
    $.ui.toast(said.replace(/: claude .*$/, ': the command in the transcript'))
  } else $.ui.toast(said)
}

/** A load of the plugins asked for and not run yet. Claude Code refuses one asked from inside a tool call (it would
 *  wait on the turn the call holds), so it stays due until the next look outside one: turn.complete looks again. */
let reloadDue = false

/** Load the plugins again once the session is idle, so the person sees the fix, or the release, without typing
 *  /reload-plugins. refreshFixes asks for it once per switch of thimble (a fix on, off, or a new round of it). */
async function reloadPlugins($: Engine): Promise<void> {
  if (!reloadDue) return
  reloadDue = false
  try {
    await $.command.run({ command: 'reload-plugins' })
  } catch {
    reloadDue = true
  }
}

// ------------------------------------------------------------------------------------------------ the failure line

/** A failure the person should know of, in one line, with the keys that fix or report it. */
export function failNotice($: Engine, text: string): void {
  const t = String(text || '').trim()
  if (!t) return
  // a long line is cut in its words, never in its keys: a toast shows only a few short lines
  $.ui.toast(`${cut(t, 85)}   ${FAIL_KEYS}`)
  void $.state.set(LINE, { kind: 'failed', text: t }).catch(() => undefined)
}

/** The line whose keys the bar names now, if any. */
export async function fixLineNow($: Engine): Promise<FixLine | null> {
  return ((await $.state.get(LINE)).value ?? null) as FixLine | null
}

/** The person typed their next prompt: a failure line's keys go, and a notice that a fix went off (they have seen it).
 *  A fix's line stays until p or u. */
export async function promptTyped($: Engine): Promise<void> {
  const l = await fixLineNow($)
  if (l?.kind === 'failed' || l?.kind === 'notice') await $.state.set(LINE, null)
}

/** What a key does to the fix line now, or null: f and F on a failure, p and u on a fix in use. */
export async function fixKeyOf($: Engine, k: string): Promise<'fix' | 'report' | 'share' | 'undo' | null> {
  return lineKey(await fixLineNow($), k) as 'fix' | 'report' | 'share' | 'undo' | null
}

/** The key's work: a turn to main (f, F, p with no draft), the preview (p), or undo (u). */
export async function pressFix($: Engine, what: 'fix' | 'report' | 'share' | 'undo'): Promise<void> {
  const l = await fixLineNow($)
  if (!l) return
  if (l.kind === 'failed' && (what === 'fix' || what === 'report')) {
    await $.state.set(LINE, null)
    await ask($, fixRequest({ failure: l.text, kind: what }), what, 'this')
    return
  }
  if (l.kind !== 'applied') return
  if (what === 'undo') { await undoFix($, l.slug, l.title); return }
  await submitFix($, l.slug, l.title)
}

/** The person's line for a switch of thimble: the fix's title, never the copy's or the release's path, which only
 *  Claude needs (noteForClaude gets the kernel's own line). A line with a command to run is the kernel's, whole. */
const switchLine = (said: string, line: string) => (/quit and run: /.test(said) ? said : line)

/** Back to the release (u, /thimble:fix undo): what happened in the person's words, or the one command to run. */
async function undoFix($: Engine, slug: string, title = slug): Promise<string> {
  const r = await kernel($, ['undo'])
  if (!r.ok) {
    const t = `× The fix was not undone: ${cut(lastLine(r.out) || 'thimble fix undo gave nothing', 200)}. Ask Claude to run \`thimble fix undo\`.`
    $.ui.toast(t)
    return t
  }
  const said = lastLine(r.out) || 'Your thimble is the release again.'
  // a --plugin-dir session runs the fix until it quits: its line stays until then
  if (!/quit and run: /.test(said)) await $.state.set(LINE, null)
  const line = switchLine(said, `thimble is back to the release, without your fix '${title}'.`)
  sayLine($, line)
  await noteForClaude($, `The analyst undid the fix ${slug}. ${said}`)
  // the fix went off: refreshFixes loads the release
  void refreshFixes($).catch(() => undefined)
  return line
}

/** Remove a fix (/thimble:fix remove): the kernel turns it off when it is on, then deletes its copy and its record. */
async function removeFix($: Engine, slug: string, title = slug): Promise<string> {
  const r = await kernel($, ['remove', slug])
  // a fix that was on went off: refreshFixes loads the release
  void refreshFixes($).catch(() => undefined)
  if (!r.ok) return `× The fix was not removed: ${cut(said(r.out) || 'thimble fix remove gave nothing', 220)}`
  const l = await fixLineNow($)
  if (l?.kind === 'applied' && l.slug === slug) await $.state.set(LINE, null)
  const out = lastLine(r.out)
  await noteForClaude($, `The analyst removed the fix ${slug}. ${out}`)
  const size = /\(([^()]+)\)\.?$/.exec(out)?.[1]
  const was = /back to the release/.test(out) ? 'thimble is back to the release. ' : ''
  return switchLine(out, `${was}Removed the fix '${title}': its copy and its record${size ? ` (${size})` : ''}.`)
}

/** The review of a fix (p, /thimble:fix submit): it opens when a draft waits for the person, else Claude writes the
 *  draft and the review opens on its fix_ask line. */
async function submitFix($: Engine, slug: string, title: string): Promise<string> {
  const h = await home($)
  if (await readJson($, `${h}/fixes/${slug}/share/ask.json`)) { await openShare($, slug); return '' }
  // the draft may come from a subagent, whose calls do not reach this plugin: its ask is looked for until it opens
  shareWait.add(slug)
  await ask($, shareRequest({ slug, title }), 'submit', 'the fix')
  void refreshFixes($).catch(() => undefined)
  return ''
}

/** The fix this session runs from, when thimble was started with --plugin-dir on a fix's copy. */
async function ownFix($: Engine): Promise<string | null> {
  const root = String($.plugin.root || '').replace(/\/+$/, '')
  const pre = `${await home($)}/fixes/`
  if (!root.startsWith(pre)) return null
  const m = /^([a-z0-9][a-z0-9-]{0,79})\/worktree\/plugin$/.exec(root.slice(pre.length))
  return m ? m[1]! : null
}

/** The fix that /thimble:fix submit, undo and try mean when none is named: the one that is on, else the newest that
 *  is not in a release (for submit, also not sent already). */
async function currentFix($: Engine, fixes: Fix[], active: string | null, verb = 'submit'): Promise<Fix | null> {
  const on = active || (await ownFix($))
  const f = fixes.find(x => x.slug === on)
  if (f) return f
  const done = verb === 'submit' ? ['sent', 'dropped', 'merged'] : ['dropped', 'merged']
  const open = fixes.filter(x => !done.includes(x.status)).sort((a, b) => b.created - a.created)
  return open[0] ?? null
}

/** /thimble:fix [words]: the result the command shows, or null when the words are a change for Claude to make (the
 *  command's own text asks for it). */
export async function fixCommand($: Engine, args: string): Promise<{ text?: string } | null> {
  const v = fixVerb(args) as { verb: string; slug?: string; text?: string }
  // the person acts on their fixes: a notice that one went off has been seen
  if ((await fixLineNow($))?.kind === 'notice') await $.state.set(LINE, null)
  if (v.verb === 'change') return null
  const { fixes, active } = await listFixes($)
  if (v.verb === 'status') {
    if (!fixes.length) return { text: 'No fixes yet. Say what you want changed: /thimble:fix <what you want changed>' }
    const r = await kernel($, ['status'])
    return { text: `${r.out}\n/thimble:fix submit shares the newest · /thimble:fix undo goes back to the release` }
  }
  const on = active || (await ownFix($))
  // removing deletes the copy: with no name, only the fix that is on
  if (v.verb === 'remove' && !v.slug && !fixes.some(x => x.slug === on)) return { text: 'Name the fix to remove: /thimble:fix remove <name>. /thimble:fix lists them.' }
  const f = v.slug ? fixes.find(x => x.slug === v.slug) ?? null : await currentFix($, fixes, active, v.verb)
  if (!f) return { text: v.slug ? `There is no fix ${v.slug}. /thimble:fix lists them.` : 'No fix yet. Say what you want changed: /thimble:fix <what you want changed>' }
  if (v.verb === 'undo') return { text: await undoFix($, f.slug, f.title) }
  if (v.verb === 'remove') return { text: await removeFix($, f.slug, f.title) }
  if (v.verb === 'try') {
    const r = await kernel($, ['use', f.slug])
    // the fix came on: refreshFixes says so and loads it
    void refreshFixes($).catch(() => undefined)
    if (r.ok) await noteForClaude($, `The analyst turned the fix ${f.slug} on again. ${r.out.split('\n')[0]}`)
    return { text: r.ok ? switchLine(r.out.split('\n')[0]!, `✓ Your thimble has the fix again: ${f.title}`) : `× ${cut(said(r.out) || 'thimble fix use gave nothing', 240)}` }
  }
  // submit, a moment after the command has answered: the review opens, or Claude writes the draft first
  $.clock.after(0, () => { void submitFix($, f.slug, f.title).catch(err => $.ui.toast(`× The review did not open: ${String((err as Error)?.message || err).slice(0, 200)}`)) })
  return { text: `Submitting your fix: ${f.title}` }
}

// ------------------------------------------------------------------------------------------------ fixes that work

/** Each fix as last seen: its status, the time of its last use (each `thimble fix use` is a round of the fix) and its
 *  title, so each round that came into use is said once. Empty until the first look. */
const seen = new Map<string, { status: string; used: number; title: string }>()
/** The fix the marketplace pointed at when last looked (fixes/active), so a fix that went off is seen once. */
let wasActive: string | null = null
/** The fixes whose draft the person asked for (p) and whose preview has not opened yet. */
const shareWait = new Set<string>()
/** Whether this load of the module looked already (its first look starts followFix). */
let looked = false
/** Whether the fixes were seen before this look, in this load of the module or in the one before a reload of the
 *  plugins. Each switch reloads them, and a later round must not look like the session's first look. */
let known = false
/** What was seen, kept for the session by the host ($.state outlives a reload of the plugin's code). */
const SEEN = { plugin: 'thimble', key: 'fixseen' } as const
let restoring: Promise<void> | null = null
function restoreSeen($: Engine): Promise<void> {
  restoring ??= (async () => {
    const v = (await $.state.get(SEEN).catch(() => ({ value: null }))).value as { fixes?: Record<string, { status: string; used: number; title: string }>; active?: string | null } | null | undefined
    if (!v) return
    for (const [slug, f] of Object.entries(v.fixes || {})) if (!seen.has(slug)) seen.set(slug, f)
    wasActive = v.active ?? null
    known = true
  })()
  return restoring
}
let poll: { cancel?: () => void } | null = null

/** For tests: this module's memory gone, as a reload of the plugin's code leaves it (the host's $.state stays). */
export function forgetFixes(): void {
  seen.clear()
  shareWait.clear()
  wasActive = null
  looked = false
  known = false
  restoring = null
  poll = null
  reloadDue = false
}

/** The fixes in $THIMBLE_HOME/fixes, and which is in use. */
async function listFixes($: Engine): Promise<{ fixes: Fix[]; active: string | null }> {
  const h = await home($)
  const r = await $.process.run(['ls', '-1', `${h}/fixes`], { timeoutMs: 5000 }).catch(() => null)
  const names = r && r.exitCode === 0 ? String(r.stdout || '').split('\n').map(s => s.trim()).filter(s => SLUG.test(s)) : []
  const fixes: Fix[] = []
  for (const slug of names) {
    const f = await readJson($, `${h}/fixes/${slug}/fix.json`)
    if (f && typeof f === 'object') fixes.push({ slug, title: String(f.title || slug), kind: String(f.kind || 'fix'), status: String(f.status || ''), created: Number(f.created) || 0, used: Number(f.used) || 0 })
  }
  const active = ((await readText($, `${h}/fixes/active`)) || '').trim() || null
  return { fixes, active }
}

/** Look at the fixes again: the bar's `fixing` note, and the one line when a fix came into use. While one works, it
 *  is looked at every few seconds (the person asked for that fix), and never once none works. Each switch of thimble
 *  seen here (a fix on, a new round of it, or the fix that was on gone off), whoever made it (Claude, a subagent, or
 *  the person's u, try or remove), loads the plugins once. */
export async function refreshFixes($: Engine): Promise<void> {
  await restoreSeen($)
  const { fixes, active } = await listFixes($)
  // the fix that was on went off (undo, remove), or another took its place: the session loads what is on now
  let reload = known && wasActive !== null && wasActive !== active
  wasActive = active
  // 'ready' is a fix that is not in use (after undo, or a send that was cancelled): only 'working' still works
  const working = fixes.filter(f => f.status === 'working')
  await $.state.set(FIXES, working.map(f => ({ slug: f.slug, title: f.title, kind: f.kind })))
  // at session start, a fix that is on follows the newest release and says so in one line (followFix)
  const on = looked ? null : fixes.find(f => f.slug === (active || null)) ?? null
  const own = looked ? null : await ownFix($)
  const following = on ?? fixes.find(f => f.slug === own) ?? null
  if (following) $.clock.after(0, () => { void followFix($, following).catch(() => undefined) })
  for (const f of fixes) {
    // a draft that waits for the person opens its preview, also when it was written outside a turn (a subagent's)
    await openAskOnce($, f.slug, !looked)
    const was = seen.get(f.slug)
    seen.set(f.slug, { status: f.status, used: f.used, title: f.title })
    if (!known || f.status !== 'applied' || active !== f.slug) continue
    if (was?.status !== 'applied' || was.used !== f.used) {
      // a fix turned on, or a later round of the same fix: the person tries the newest copy at once
      $.ui.toast(`✓ Your thimble now has the fix: ${f.title}   ${USE_KEYS}`)
      await $.state.set(LINE, { kind: 'applied', slug: f.slug, title: f.title })
      // the marketplace points at the copy (fixes/active), which Claude Code reads in place: the plugins load again
      // once the session is idle, so the person tries this round at once. That holds when the session already runs
      // the copy, from an earlier round
      reload = true
    } else if (was.title !== f.title) {
      // a round changed what the fix does, and its title says so now (`thimble fix title`)
      $.ui.toast(`✓ Your thimble now has the fix: ${f.title}   ${USE_KEYS}`)
      const l = await fixLineNow($)
      if (l?.kind === 'applied' && l.slug === f.slug) await $.state.set(LINE, { ...l, title: f.title })
    }
  }
  looked = true
  known = true
  // kept before the reload, so the module the reload loads goes on from here
  await $.state.set(SEEN, { fixes: Object.fromEntries(seen), active }).catch(() => undefined)
  if (reload) reloadDue = true
  await reloadPlugins($)
  if ((working.length || shareWait.size) && !poll) {
    try { poll = $.clock.every(3000, () => { void refreshFixes($).catch(() => undefined) }) as unknown as { cancel?: () => void } } catch { poll = null }
  } else if (!working.length && !shareWait.size && poll) {
    poll.cancel?.()
    poll = null
  }
}

/** A fix that is on, at session start: the kernel replays it on the newest release (at most once a day) and gives
 *  one line: still on (`thimble 0.11 + your fix '…' · u undo`), in the release now, or no longer fitting. The line
 *  shows once per session, also across a reload; a switch loads the plugin again, so the session runs what it says. */
async function followFix($: Engine, f: Fix): Promise<void> {
  const before = await readJson($, `${await home($)}/fixes/${f.slug}/fix.json`)
  const r = await kernel($, ['follow'])
  const line = lastLine(r.out)
  if (!line) return
  const off = /you are on the release/.test(line)
  const was = await fixLineNow($)
  const shown = was?.kind === 'applied' && was.slug === f.slug ? was.said : undefined
  if (off) {
    // the fix went off (no longer fits, or in the release now): the whole line, once, as a row of the transcript, and
    // on the bar until the person's next prompt; never a toast, which cuts it and goes by itself
    await $.state.set(LINE, { kind: 'notice', text: line })
    $.ui.log(line)
  } else {
    await $.state.set(LINE, { kind: 'applied', slug: f.slug, title: f.title, said: line })
    if (shown !== line) sayLine($, r.ok ? line : `× ${cut(line, 200)}`)
  }
  const after = await readJson($, `${await home($)}/fixes/${f.slug}/fix.json`)
  const moved = off || (before?.base && after?.base && before.base !== after.base)
  if (moved) {
    await noteForClaude($, `thimble's fix ${f.slug} followed the newest release: ${line}`)
    // this load is the switch's one: refreshFixes does not load it again when it sees the fix off
    wasActive = ((await readText($, `${await home($)}/fixes/active`)) || '').trim() || null
    await $.state.set(SEEN, { fixes: Object.fromEntries(seen), active: wasActive }).catch(() => undefined)
    reloadDue = true
    await reloadPlugins($)
  }
}

/** The fixes that work now (the bar's note). */
export async function fixesWorking($: Engine): Promise<{ slug: string; title: string; kind: string }[]> {
  return ((await $.state.get(FIXES)).value ?? []) as { slug: string; title: string; kind: string }[]
}

/** The bar's words for the fixes, at its left: `fixing: <title>` while one works, then the fix line's own keys. */
export async function fixBar($: Engine): Promise<{ key: string; words: string; short?: string; tone?: 'error'; status?: boolean; good?: boolean }[]> {
  const out: { key: string; words: string; short?: string; tone?: 'error'; status?: boolean; good?: boolean }[] = []
  const w = await fixesWorking($)
  if (w.length) out.push({ key: '', words: w.length === 1 ? `◌ fixing: ${cut(w[0]!.title, 32)}` : `◌ fixing ${w.length}`, status: true })
  const l = await fixLineNow($)
  if (l?.kind === 'failed') out.push({ key: 'f', words: 'fix this' }, { key: 'F', words: 'report only' })
  else if (l?.kind === 'notice') {
    // the whole line is in the transcript; the bar keeps its point and its command whole, which a cut at the line's
    // end would lose: `your fix '<title>' no longer fits 0.12.0 · /thimble:fix to redo it`
    const v = /^Your fix '([^']*)' no longer fits thimble (\S+?);/.exec(l.text)
    if (v) out.push({ key: '', words: `your fix '${cut(v[1]!, 16)}' no longer fits ${v[2]} · /thimble:fix to redo it`, short: 'your fix is off · /thimble:fix to redo it', status: true })
    else out.push({ key: '', words: l.text.replace(/'([^']*)'/, (_m, t: string) => `'${cut(t, 16)}'`), status: true })
  }
  else if (l?.kind === 'applied') out.push({ key: '', words: '✓ fixed', status: true, good: true }, { key: 'p', words: 'submit' }, { key: 'u', words: 'undo' })
  return out
}

// ------------------------------------------------------------------------------------------------ the preview

/** A fix's share as the preview reads it: never the ask's id, only whether an ask waits. */
async function loadShare($: Engine, slug: string): Promise<void> {
  const d = `${await home($)}/fixes/${slug}`
  const fix = await readJson($, `${d}/fix.json`)
  if (!fix) { await $.state.set({ ...SHARE, id: slug }, { problem: `There is no fix ${slug} in this thimble.` }); return }
  const scan = await readJson($, `${d}/share/scan.json`)
  await $.state.set({ ...SHARE, id: slug }, {
    title: String(fix.title || slug), kind: String(fix.kind || 'fix'), repo: String(fix.repo || ''), login: String(fix.login || ''),
    scan: Array.isArray(scan) ? scan.map((h: Any) => ({ id: String(h?.id ?? ''), kind: String(h?.kind || 'generic'), found: String(h?.found ?? ''), replacement: String(h?.replacement ?? ''), where: String(h?.where || ''), kept: !!h?.kept })) : [],
    issue: (await readText($, `${d}/share/issue.md`)) || '', diff: (await readText($, `${d}/share/diff.patch`)) || '',
    waiting: !!(await readJson($, `${d}/share/ask.json`)),
  })
}

/** The store panes/fix.js reads: the share as last loaded (loaded now when it never was). */
export async function fixStore($: Engine, slug: string): Promise<unknown> {
  if (!SLUG.test(slug)) return { problem: 'That is not the name of a fix.' }
  const v = (await $.state.get({ ...SHARE, id: slug })).value
  if (v === undefined) $.clock.after(0, () => { void loadShare($, slug).catch(() => undefined) })
  return v ?? {}
}

/** The preview of a fix's share, in the side panel. */
const showsShare = (v: Any, slug: string) => v?.kind === 'pane' && v.pane === 'fix' && v.args?.slug === slug

export async function openShare($: Engine, slug: string): Promise<boolean> {
  if (!SLUG.test(slug)) return false
  await loadShare($, slug)
  // a new draft of the preview the panel shows takes its place, so esc and a send never come back to the old one
  const keep = showsShare(await sideNow($), slug)
  return openSide($, { pane: 'fix', args: { slug }, title: 'Submit your fix' }, keep ? { keep: true } : { push: true })
}

/** The asks whose preview opened, by fix and the ask's time (never its id), so each opens once. */
const asked = new Set<string>()
async function openAskOnce($: Engine, slug: string, quiet = false): Promise<void> {
  const a = await readJson($, `${await home($)}/fixes/${slug}/share/ask.json`)
  if (!a) return
  const key = `${slug}|${a.created ?? ''}`
  if (asked.has(key)) return
  asked.add(key)
  shareWait.delete(slug)
  // at the session's first look, a draft from an earlier session waits for p rather than opening by itself
  if (!quiet) await openShare($, slug)
}

/** A `fix_ask` line of the change feed: the draft waits for the person, so the preview opens, once per draft. */
export async function fixAskFromFeed($: Engine, ev: Any): Promise<void> {
  const slug = String(ev?.slug || '')
  if (SLUG.test(slug)) await openAskOnce($, slug)
}

/** The preview closes: each view of this fix's preview the panel holds, then the panel if nothing is under them. */
async function closeShare($: Engine, slug: string): Promise<void> {
  for (let i = 0; i < 10 && showsShare(await sideNow($), slug); i++) {
    if (!(await sideBack($))) { await $.ui.close({ id: PANEL }).catch(() => undefined); return }
  }
}

/** The person's key press in the preview: a new secret, held only in this function, whose sha256 goes into the draft's
 *  share/ask.json for the kernel to check. The secret itself goes to the kernel on stdin, so no file, argument or line
 *  of the change feed holds it; null when no draft waits. */
async function keyPress($: Engine, slug: string): Promise<string | null> {
  const path = `${await home($)}/fixes/${slug}/share/ask.json`
  const a = await readJson($, path)
  if (!a || typeof a !== 'object') return null
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const secret = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
  const sum = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)))
  await $.fs.write(path, `${JSON.stringify({ ...a, key: [...sum].map(b => b.toString(16).padStart(2, '0')).join('') })}\n`)
  return secret
}

/** What the preview asks of the host (k.do): send or save (y, w), keep a hit (k), edit (e). Each runs as the person,
 *  with the secret of this key press (keyPress), which neither the program nor Claude sees. */
export async function fixAction($: Engine, args: Record<string, unknown>, a: Record<string, unknown>): Promise<string | void> {
  const slug = String(args.slug || a.slug || '')
  if (!SLUG.test(slug)) return '× That is not the name of a fix.'
  const name = String(a.do || '')
  if (name === 'edit') return 'Say in the chat what to change in the draft. Claude writes it again, and this preview opens with the new text.'
  if (name !== 'keep' && name !== 'send') return
  const key = await keyPress($, slug)
  if (!key) { await loadShare($, slug); return '× This draft no longer waits for you. Ask Claude for a new draft.' }
  if (name === 'keep') {
    const r = await kernel($, ['keep', slug, String(a.id || ''), '--ask', '-'], key)
    await loadShare($, slug)
    return r.ok ? undefined : `× That detail was not kept: ${cut(lastLine(r.out) || 'thimble fix keep gave nothing', 200)}.`
  }
  if (name === 'send') {
    const answer = a.answer === 'file' ? 'file' : 'send'
    const r = await kernel($, ['send', slug, '--answer', answer, '--ask', '-'], key)
    await loadShare($, slug)
    if (!r.ok) return `× Nothing was ${answer === 'file' ? 'saved' : 'sent'}: ${cut(lastLine(r.out) || 'thimble fix send gave nothing', 200)}. Press ${answer === 'file' ? 'w' : 'y'} to try again, or w to save it as a file.`
    const said = lastLine(r.out)
    await noteForClaude($, `The analyst ${answer === 'file' ? 'saved the share of the fix' : 'sent the issue and the draft pull request of the fix'} ${slug}. ${said}`)
    // after the program has drawn its answer to the key, which would otherwise keep the panel open
    $.clock.after(300, () => { void closeShare($, slug).catch(() => undefined) })
    // the line after the send, in the person's words: where it went
    const fx = await readJson($, `${await home($)}/fixes/${slug}/fix.json`) || {}
    const line = answer === 'file' ? `✓ Saved as one file, nothing sent: ${fx.file || ''}`
      : fx.pr_url ? `✓ Sent under your GitHub login: draft pull request ${fx.pr_url} · issue ${fx.issue_url || ''}`
        : `✓ Sent under your GitHub login: issue ${fx.issue_url || ''}`
    return line  // the host shows it as the line after the send
  }
}
