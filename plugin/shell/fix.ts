// fix.ts: the terminal's part of "fix it yourself". The kernel's `thimble fix` verbs make a fix in a git worktree of
// thimble, load it into the person's thimble, and build the share (plugin/engine/kernel/fix.py); this module shows
// what the person needs to see of that and gives them its keys.
//
//   failNotice    a failure line: the one-line notice, with `f fix this · F report only`; the bar keeps the keys until
//                 the person types their next prompt. f or F sends a turn to main (fixask.js), as v does
//   refreshFixes  $THIMBLE_HOME/fixes/*/fix.json: a fix that works shows in the bar (`fixing: <title>`); one that the
//                 person's thimble now uses shows one line, `✓ Your thimble now has the fix: <title>`, with
//                 `p share it · u undo`. u runs `thimble fix undo` as the person
//   fixCommand    /thimble:fix, the one way in: words are the change the person wants (the command's text asks Claude,
//                 commands/fix.md); submit, undo and try do what p and u do, for the fix that is on or the newest
//   fixAskFromFeed  a `fix_ask` line of the change feed (`thimble fix draft` built the share and waits for the person):
//                 the preview opens in the side panel (panes/fix.js). y and w run `thimble fix send <slug> --answer …
//                 --ask ID` as the person, with the id from share/ask.json, which never reaches Claude
//
//   state: fixline (the line whose keys the bar names), fixes (the fixes that work), fixshare (a fix's share, by slug)
import type { EngineInterface } from 'claude-code'

import { ask, leanEnv, noteForClaude, rootHere } from './shell'
import { openSide, sideBack, sideNow } from './side'
import { PANE as PANEL } from './detail'
import { FAIL_KEYS, fixRequest, fixVerb, lineKey, shareRequest, USE_KEYS } from './fixask.js'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const LINE = { plugin: 'thimble', key: 'fixline' } as const
const FIXES = { plugin: 'thimble', key: 'fixes' } as const
const SHARE = { plugin: 'thimble', key: 'fixshare' } as const
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/

export type FixLine = { kind: 'failed'; text: string } | { kind: 'applied'; slug: string; title: string }
type Fix = { slug: string; title: string; kind: string; status: string; created: number }

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

/** `thimble fix …` as the person's own command: its exit code and its words. */
async function kernel($: Engine, args: string[]): Promise<{ ok: boolean; out: string }> {
  const root = (await rootHere($)) || (await home($))
  const dir = $.plugin.root.replace(/\/+$/, '')
  const r = await $.process.run([`${dir}/bin/thimble`, 'fix', ...args], { cwd: root, env: await leanEnv($, root), timeoutMs: 300000 })
  return { ok: (r.exitCode ?? 1) === 0, out: `${String(r.stdout || '')}${r.stderr ? `\n${String(r.stderr)}` : ''}`.trim() }
}

const lastLine = (s: string) => s.split('\n').map(l => l.trim()).filter(Boolean).slice(-1)[0] || ''

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

/** The person typed their next prompt: a failure line's keys go (a fix's line stays until p or u). */
export async function promptTyped($: Engine): Promise<void> {
  const l = await fixLineNow($)
  if (l?.kind === 'failed') await $.state.set(LINE, null)
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
  if (what === 'undo') { await undoFix($, l.slug); return }
  await submitFix($, l.slug, l.title)
}

/** Back to the release (u, /thimble:fix undo): the kernel's own words say what happened, or the one command to run. */
async function undoFix($: Engine, slug: string): Promise<string> {
  const r = await kernel($, ['undo'])
  if (!r.ok) {
    const t = `× The fix was not undone: ${cut(lastLine(r.out) || 'thimble fix undo gave nothing', 200)}. Ask Claude to run \`thimble fix undo\`.`
    $.ui.toast(t)
    return t
  }
  await $.state.set(LINE, null)
  const said = lastLine(r.out) || 'Your thimble is the release again.'
  $.ui.toast(said)
  await noteForClaude($, `The analyst undid the fix ${slug}. ${said}`)
  return said
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
 *  was neither sent nor dropped. */
async function currentFix($: Engine, fixes: Fix[], active: string | null): Promise<Fix | null> {
  const on = active || (await ownFix($))
  const f = fixes.find(x => x.slug === on)
  if (f) return f
  const open = fixes.filter(x => !['sent', 'dropped', 'merged'].includes(x.status)).sort((a, b) => b.created - a.created)
  return open[0] ?? null
}

/** /thimble:fix [words]: the result the command shows, or null when the words are a change for Claude to make (the
 *  command's own text asks for it). */
export async function fixCommand($: Engine, args: string): Promise<{ text?: string } | null> {
  const v = fixVerb(args) as { verb: string; slug?: string; text?: string }
  if (v.verb === 'change') return null
  const { fixes, active } = await listFixes($)
  if (v.verb === 'status') {
    if (!fixes.length) return { text: 'No fixes yet. Say what you want changed: /thimble:fix <what you want changed>' }
    const r = await kernel($, ['status'])
    return { text: `${r.out}\n/thimble:fix submit shares the newest · /thimble:fix undo goes back to the release` }
  }
  const f = v.slug ? fixes.find(x => x.slug === v.slug) ?? null : await currentFix($, fixes, active)
  if (!f) return { text: v.slug ? `There is no fix ${v.slug}. /thimble:fix lists them.` : 'No fix yet. Say what you want changed: /thimble:fix <what you want changed>' }
  if (v.verb === 'undo') return { text: await undoFix($, f.slug) }
  if (v.verb === 'try') {
    const r = await kernel($, ['use', f.slug])
    void refreshFixes($).catch(() => undefined)
    return { text: r.ok ? lastLine(r.out) : `× ${cut(lastLine(r.out) || 'thimble fix use gave nothing', 240)}` }
  }
  // submit, a moment after the command has answered: the review opens, or Claude writes the draft first
  $.clock.after(0, () => { void submitFix($, f.slug, f.title).catch(err => $.ui.toast(`× The review did not open: ${String((err as Error)?.message || err).slice(0, 200)}`)) })
  return { text: `Submitting your fix: ${f.title}` }
}

// ------------------------------------------------------------------------------------------------ fixes that work

/** Each fix's status as last seen, so a fix that came into use is said once. Empty until the first look. */
const seen = new Map<string, string>()
/** The fixes whose draft the person asked for (p) and whose preview has not opened yet. */
const shareWait = new Set<string>()
let looked = false
let poll: { cancel?: () => void } | null = null

/** The fixes in $THIMBLE_HOME/fixes, and which is in use. */
async function listFixes($: Engine): Promise<{ fixes: Fix[]; active: string | null }> {
  const h = await home($)
  const r = await $.process.run(['ls', '-1', `${h}/fixes`], { timeoutMs: 5000 }).catch(() => null)
  const names = r && r.exitCode === 0 ? String(r.stdout || '').split('\n').map(s => s.trim()).filter(s => SLUG.test(s)) : []
  const fixes: Fix[] = []
  for (const slug of names) {
    const f = await readJson($, `${h}/fixes/${slug}/fix.json`)
    if (f && typeof f === 'object') fixes.push({ slug, title: String(f.title || slug), kind: String(f.kind || 'fix'), status: String(f.status || ''), created: Number(f.created) || 0 })
  }
  const active = ((await readText($, `${h}/fixes/active`)) || '').trim() || null
  return { fixes, active }
}

/** Look at the fixes again: the bar's `fixing` note, and the one line when a fix came into use. While one works, it
 *  is looked at every few seconds (the person asked for that fix), and never once none works. */
export async function refreshFixes($: Engine): Promise<void> {
  const { fixes, active } = await listFixes($)
  // 'ready' is a fix that is not in use (after undo, or a send that was cancelled): only 'working' still works
  const working = fixes.filter(f => f.status === 'working')
  await $.state.set(FIXES, working.map(f => ({ slug: f.slug, title: f.title, kind: f.kind })))
  const own = looked ? null : await ownFix($)
  for (const f of fixes) {
    if (own === f.slug) {
      $.ui.toast(`✓ This session runs your fix: ${f.title}   ${USE_KEYS}`)
      await $.state.set(LINE, { kind: 'applied', slug: f.slug, title: f.title })
    }
    // a draft that waits for the person opens its preview, also when it was written outside a turn (a subagent's)
    await openAskOnce($, f.slug, !looked)
    const was = seen.get(f.slug)
    seen.set(f.slug, f.status)
    if (looked && f.status === 'applied' && was !== 'applied' && active === f.slug) {
      $.ui.toast(`✓ Your thimble now has the fix: ${f.title}   ${USE_KEYS}`)
      await $.state.set(LINE, { kind: 'applied', slug: f.slug, title: f.title })
    }
  }
  looked = true
  if ((working.length || shareWait.size) && !poll) {
    try { poll = $.clock.every(3000, () => { void refreshFixes($).catch(() => undefined) }) as unknown as { cancel?: () => void } } catch { poll = null }
  } else if (!working.length && !shareWait.size && poll) {
    poll.cancel?.()
    poll = null
  }
}

/** The fixes that work now (the bar's note). */
export async function fixesWorking($: Engine): Promise<{ slug: string; title: string; kind: string }[]> {
  return ((await $.state.get(FIXES)).value ?? []) as { slug: string; title: string; kind: string }[]
}

/** The bar's words for the fixes, at its left: `fixing: <title>` while one works, then the fix line's own keys. */
export async function fixBar($: Engine): Promise<{ key: string; words: string; tone?: 'error'; status?: boolean; good?: boolean }[]> {
  const out: { key: string; words: string; tone?: 'error'; status?: boolean; good?: boolean }[] = []
  const w = await fixesWorking($)
  if (w.length) out.push({ key: '', words: w.length === 1 ? `◌ fixing: ${cut(w[0]!.title, 32)}` : `◌ fixing ${w.length}`, status: true })
  const l = await fixLineNow($)
  if (l?.kind === 'failed') out.push({ key: 'f', words: 'fix this' }, { key: 'F', words: 'report only' })
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

/** What the preview asks of the host (k.do): send or save (y, w), keep a hit (k), edit (e). Each runs as the person,
 *  with the ask's id from share/ask.json, which neither the program nor Claude sees. */
export async function fixAction($: Engine, args: Record<string, unknown>, a: Record<string, unknown>): Promise<string | void> {
  const slug = String(args.slug || a.slug || '')
  if (!SLUG.test(slug)) return '× That is not the name of a fix.'
  const name = String(a.do || '')
  if (name === 'edit') return 'Say in the chat what to change in the draft. Claude writes it again, and this preview opens with the new text.'
  const id = String((await readJson($, `${await home($)}/fixes/${slug}/share/ask.json`))?.id || '')
  if (!id) { await loadShare($, slug); return '× This draft no longer waits for you. Ask Claude for a new draft.' }
  if (name === 'keep') {
    const r = await kernel($, ['keep', slug, String(a.id || ''), '--ask', id])
    await loadShare($, slug)
    return r.ok ? undefined : `× That detail was not kept: ${cut(lastLine(r.out) || 'thimble fix keep gave nothing', 200)}.`
  }
  if (name === 'send') {
    const answer = a.answer === 'file' ? 'file' : 'send'
    const r = await kernel($, ['send', slug, '--answer', answer, '--ask', id])
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
