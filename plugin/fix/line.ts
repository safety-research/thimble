// line.ts: the one line above the bar for a fix (bar.tsx draws it under the failure line), and its keys at an empty
// prompt (hooks/keys.ts asks fixKey first while the line shows):
//
//   ready     ✓ thimble fixed: <title> · tests pass
//               This fix changes the sandbox (plugin/cards/argv.mjs).   (a fix that changes such files: fixes.ts noticeText)
//               y use it now · d what changed · n later
//             (a round of a fix the person has: ✓ thimble changed: <title> · tests pass; the version they have stays
//             until y, and d shows each round's words)
//             d shows what changed in its place, in a few lines, not a diff:
//             <title>
//               You asked   <the person's words, else the request's>
//               Claude did  <what it does>
//               Changed     2 files · tests pass
//               Note        This fix changes the sandbox (plugin/cards/argv.mjs).
//               y use it now · n later
//   applied   ✓ <title> is on · thimble reloaded · u undo (or: reloads when Claude finishes; or, in a session that
//               If thimble stops loading: sh …/off.sh       loads thimble with --plugin-dir, the restart that loads it)
//   off       ○ <title> is off · thimble reloaded           (until the next prompt)
//             ↺ <title> is back to its version before · thimble reloaded   (u after y on a changed fix)
//   failed    × <title> did not pass · <why>                y try again · d ask Claude · n dismiss   (until the
//             next prompt; the fix stays failed in thimble fixes)
//             (× The change to <title> did not pass, for a round of a fix the person has: n leaves the fix as it was;
//             a <why> too long for the row, such as a refusal that names files, gets a row of its own; a fix whose
//             fixer could not do without the files no fix may change (blocked) offers no y: d ask Claude · n dismiss)
//             d shows what it tried in its place, and the prompt box takes the failure as a message to Claude, which
//             the person sends with ↵ or not: Claude, outside the fixer's sandbox, can look into it and change what the
//             fixer could not, in the fix's copy, with its own permission prompts (/thimble-fix N <words> then goes on in
//             that copy):
//             <title>
//               You asked   <the person's words>
//               Claude did  <what the fixer says it did>
//               Tried       <the files it changed>
//               Why         <why it did not pass>
//               y try again · n dismiss   (only while the prompt box is empty: the keys type into the message d put
//                                         there, so they show again once the person sends it or clears the box)
//   request   ◇ Saved as a request with no code: <title>    n ok · thimble fix list, in a shell, lists it   (until the
//             ◇ Claude changed no code: <title> stays as it was   (a round of a fix the person has)    next prompt)
//   update    ↑ thimble 0.10.3 · 3 fixes carried · 1 needs redo   (until the next prompt)
//   release   ↑ thimble 0.10.3 is out (you have 0.10.2) · thimble update in a shell   (at session start)
//   problem   × <what went wrong, with what to do>           (until the next prompt)
//
// y applies a ready fix: from then on the fix's code runs as thimble, so only the person's key does it (fixes.ts); on a
// failed fix, y tries it again in a new copy (request.ts redoFix). n leaves a ready
// fix ready in the person's list (thimble fix list, in a shell), where thimble fix apply N turns it on later. No key sends
// anything to Claude: the person's ↵ does.
import type { EngineInterface } from 'claude-code'

import { thimbleHome } from '../core/home'
import { quiet } from '../core/askcell.js'
import { cut, textWidth } from '../core/text.js'
import { accent } from '../core/theme'
import { testsWord } from './fixer'
import { applyFix, askedWords, type Fix, fixesDir, fixesNow, type FixLine, fixLineNow, fixName, fixOf, noticeText, notNow, setFixLine, shownPath, undoFix } from './fixes'
import { redoFix } from './request'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** The keys the line takes now, by its kind. A failed fix's y tries it again, except for a blocked one (keysOf). */
const KEYS: Record<string, string[]> = { ready: ['y', 'd', 'n'], applied: ['u'], failed: ['y', 'd', 'n'], request: ['n'] }

/** The keys the line takes for this fix: a failed fix whose fixer could not do without the files no fix may change
 *  (blocked) offers no y, which would fail the same way; once d asked Claude, what it tried shows, with y and n alone. */
const keysOf = (l: Pick<FixLine, 'kind' | 'open'>, f: Pick<Fix, 'blocked'> | null): string[] =>
  (KEYS[l.kind] ?? []).filter(k => !(l.kind === 'failed' && ((k === 'y' && f?.blocked?.length) || (k === 'd' && l.open))))

/** What a key on the line does, once the word window closed (it cannot be undone). */
export async function fixKey($: Engine, k: string): Promise<{ later: () => Promise<unknown> } | null> {
  // a key no line takes reads nothing: a key's hook has a few milliseconds of its own time
  if (!Object.values(KEYS).some(ks => ks.includes(k))) return null
  const l = await fixLineNow($)
  if (!l || !keysOf(l, l.kind === 'failed' ? await fixOf($, l.id) : null).includes(k)) return null
  return { later: () => pressLine($, l.id, l.kind, k) }
}

/** A failed fix's view after d as the bar last drew it: whether its keys showed, which they do only while the prompt box
 *  is empty, as they act only there; null while no such view shows. The drawing keeps it (fixLineRows). */
let keysShown: boolean | null = null

/** Whether the bar should draw again for a prompt box that is now empty (`empty`) or not: a failed fix's view shows its
 *  keys while the box is not empty, or hides them while it is (register.ts asks at each change of the box). */
export const redrawFor = (empty: boolean): boolean => keysShown !== null && keysShown !== empty

/** Whether the person's prompt box is empty, where the line's keys act (hooks/keys.ts); a session with no box reads as
 *  empty. */
async function boxEmpty($: Engine): Promise<boolean> {
  try {
    return (await $.prompt.read()).text === ''
  } catch {
    return true
  }
}

async function pressLine($: Engine, id: number, kind: string, k: string): Promise<void> {
  let said: string | null = null
  if (k === 'y') said = kind === 'failed' ? await redoFix($, id) : await applyFix($, id)
  else if (k === 'u') said = await undoFix($, id)
  else if (k === 'd') {
    // what changed, in the line's place, or the line again; a failed fix's failure goes into the prompt box too
    const l = await fixLineNow($)
    if (l?.id === id) {
      await setFixLine($, { ...l, open: !l.open })
      if (kind === 'failed' && !l.open) await askClaude($, id)
    }
  } else if (k === 'n') {
    // a ready fix stays ready in the person's list (thimble fix list), where thimble fix apply turns it on later; a failed
    // one stays failed there
    await setFixLine($, null)
    if (kind === 'failed') said = await notNow($, id)
    const f = !said && kind === 'ready' ? await fixOf($, id) : null
    if (f?.prev) $.ui.toast(`The new version of “${fixName(f)}” waits; the one you have stays. In a shell, thimble fix apply ${id} puts the new one on.`)
    else if (!said && kind === 'ready') $.ui.toast(`“${f ? fixName(f) : `Fix ${id}`}” waits, ready: in a shell, thimble fix apply ${id} turns it on, and thimble fix list lists your fixes.`)
  }
  if (said) await setFixLine($, { id, kind: 'problem', said })
}

/** The failure of a failed fix, as a message to Claude in the person's words: what they asked, what the fixer tried and
 *  why it did not pass, where its change is, and how a change Claude makes in its copy gets tested: the person's
 *  /thimble-fix N <words> goes on in that copy (a new try, y or the number alone, starts a new one). `copy`: the fix's
 *  copy of thimble as the person reads its path, or null when it has none. */
export function askClaudeText(f: Fix, copy: string | null): string {
  const one = (s: string) => cut(String(s || '').replace(/\s+/g, ' ').trim(), 240).replace(/[\s.]+$/, '')
  const words = askedWords(f).filter(w => w.trim())
  const asked = words.length ? ` I asked: “${one(words.join(' · then '))}”.` : ''
  const tried = f.summary ? ` Its fixer, which works in a sandbox, tried this: ${one(f.summary)}.` : ' Its fixer works in a sandbox.'
  const where = `${copy ? ` Its copy of thimble is ${copy}, and` : ''} thimble fix diff ${f.id} shows its change.`
  const ask = copy
    ? ` Find why it failed, and make the change in that copy if you can. Then I type /thimble-fix ${f.id} and what you changed, so that thimble tests it.`
    : ` Find why it failed, and tell me what to add with /thimble-fix ${f.id}.`
  return `My thimble fix ${f.id}, “${fixName(f)}”, did not pass: ${one(f.error || 'its tests failed')}.${asked}${tried}${where}${ask}`
}

/** d on a failed fix: the prompt box takes its failure as a message to Claude (askClaudeText), after what the person
 *  typed there; nothing is sent until their ↵. */
async function askClaude($: Engine, id: number): Promise<void> {
  const f = await fixOf($, id)
  if (!f) return
  const text = askClaudeText(f, f.work ? await shownPath($, f.work) : null)
  try {
    const draft = (await $.prompt.read()).text
    await $.prompt.fill(draft.trim() ? { text: `\n${text}`, mode: 'append' } : { text, mode: 'replace' })
  } catch {
    // no prompt box (a headless session): what it tried still shows in the line's place
  }
}

/** The person's next prompt: a line that only told something goes, a failed fix's and a request's too (thimble fixes
 *  keeps them, and /thimble-fix N tries again). A fix that waits for y stays. */
export async function lineSeen($: Engine): Promise<void> {
  const l = await fixLineNow($)
  if (l && (['off', 'problem', 'update', 'release', 'failed', 'request'].includes(l.kind) || (l.kind === 'applied' && !l.reload))) await setFixLine($, null)
}

/** A key and its words, a click that does what the key does (`press`). */
function keyText(els: Any, k: string, words: string, i: number, press: (k: string) => unknown): Any[] {
  const { Button, Text } = els
  return [...(i ? [Text({ key: `s${i}`, dimColor: true, children: ' · ' })] : []),
    Button({ key: `fix-key-${k}`, plain: true, label: `${k} ${words}`, hover: quiet(`fix-key-${k}`), onPress: () => press(k), children: [
      Text({ key: `k${i}`, color: accent(), bold: true, children: k }), Text({ key: `w${i}`, children: ` ${words}` })] })]
}

/** The keys' row: each key and its words, after the row's indent. */
function keysRow(els: Any, keys: [string, string][], press: (k: string) => unknown): Any[] {
  return [els.Text({ key: 'i', children: '    ' }), ...keys.flatMap(([k, w], i) => keyText(els, k, w, i, press))]
}

/** How many files a fix changed: `2 files`. */
const filesWord = (f: Fix) => `${(f.files || []).length} file${(f.files || []).length === 1 ? '' : 's'}`

/** What changed, in a few rows (d): the person's words, what Claude did, then `tail`, by label: what it changed
 *  (`Changed`), or for a failed fix what it tried and why it did not pass (`Tried`, `Why`), and the files the person is
 *  told of (noticeText). */
function whatChanged(els: Any, f: Fix, width: number, tail: [string, string][]): Any[] {
  const { Box, Text } = els
  const room = Math.max(20, width - 16)
  const row = (key: string, label: string, text: string) => Box({ key, flexDirection: 'row', width, children: [
    // the label keeps its width: a value that wraps beside it would take its trailing spaces
    Box({ key: 'l', width: 16, flexShrink: 0, children: [Text({ key: 't', dimColor: true, children: `    ${label}`.padEnd(16) })] }),
    Box({ key: 'v', flexShrink: 1, children: [Text({ key: 't', wrap: 'wrap', children: text })] }),
  ] })
  return [
    Box({ key: 'fix-what-head', flexDirection: 'row', width, children: [Text({ key: 'i', children: '  ' }), Text({ key: 't', bold: true, children: cut(f.title, Math.max(12, width - 4)) })] }),
    ...askedWords(f).map((w, i) => row(`fix-what-asked-${i}`, i ? 'then' : 'You asked', cut(w, room * 2))),
    ...(f.summary ? [row('fix-what-did', 'Claude did', cut(f.summary, room * 3))] : []),
    ...tail.map(([label, text]) => row(`fix-what-${label.toLowerCase()}`, label, cut(text, room * 3))),
    ...(noticeText(f) ? [row('fix-what-notice', 'Note', noticeText(f))] : []),
  ]
}

/** What a failed fix tried and why it did not pass (d): the files it changed, when it changed any, and its reason. */
const triedRows = (f: Fix): [string, string][] => [
  ...((f.files || []).length ? [['Tried', (f.files || []).map(x => x.path).join(', ')] as [string, string]] : []),
  ['Why', f.error || 'its tests failed'],
]

/** A failed fix's keys: y tries it again, unless its fixer could not do without the files no fix may change
 *  (blocked); d asks Claude (what it tried, and the prompt box takes its failure). `open`: the keys under what it
 *  tried, which d asked Claude for already. */
function failedKeys(els: Any, f: Fix | null, open: boolean, press: (k: string) => unknown): Any[] {
  const blocked = !!f?.blocked?.length
  const keys: [string, string][] = [...(blocked ? [] : [['y', 'try again'] as [string, string]]), ...(open ? [] : [['d', 'ask Claude'] as [string, string]]), ['n', 'dismiss']]
  return keysRow(els, keys, press)
}

/** The line's rows, `width` cells wide, or none. */
export async function fixLineRows($: Engine, els: Any, width: number): Promise<Any[]> {
  const l = await fixLineNow($)
  keysShown = null
  if (!l) return []
  const { Box, Text } = els
  const f: Fix | null = l.id ? await fixOf($, l.id) : null
  const title = cut(f?.title || `fix ${l.id}`, Math.max(12, width - 40))
  const row = (key: string, children: Any[]) => Box({ key, flexDirection: 'row', flexWrap: 'wrap', width, children: [Text({ key: 'in', children: '  ' }), ...children] })
  const dim = (key: string, children: string) => Text({ key, dimColor: true, children })
  // a click on a key's words does what the key does
  const press = (k: string) => pressLine($, l.id, l.kind, k)
  if (l.kind === 'ready' && f && l.open) {
    return [...whatChanged(els, f, width, [['Changed', `${filesWord(f)} · ${testsWord(f)}`]]), Box({ key: 'fix-line-2', flexDirection: 'row', width, children: keysRow(els, [['y', 'use it now'], ['n', 'later']], press) })]
  }
  if (l.kind === 'failed' && f && l.open) {
    // its keys while they act: not while the box holds the failure d put there, or anything the person typed
    keysShown = await boxEmpty($)
    const keys = keysShown ? [Box({ key: 'fix-line-2', flexDirection: 'row', width, children: failedKeys(els, f, true, press) })] : []
    return [...whatChanged(els, f, width, triedRows(f)), ...keys]
  }
  let first: Any[] = []
  let second: Any[] = []
  let why: Any[] = []
  let note: Any[] = []
  if (l.kind === 'ready' && f) {
    // a round of a fix the person has: its new version, which y puts in place of the one they have; a fix that changes
    // the files the person is told of says which, in a row of its own, before they press y
    first = [Text({ key: 'g', color: 'success', children: '✓ ' }), Text({ key: 'h', bold: true, children: f.prev ? 'thimble changed: ' : 'thimble fixed: ' }), Text({ key: 't', bold: true, children: title }), dim('m', ` · ${testsWord(f)}`)]
    if (noticeText(f)) note = [Text({ key: 'w', wrap: 'wrap', children: `  ${noticeText(f)}` })]
    second = keysRow(els, [['y', 'use it now'], ['d', 'what changed'], ['n', 'later']], press)
  } else if (l.kind === 'applied') {
    const off = await shownPath($, `${fixesDir(await thimbleHome($))}/off.sh`)
    const live = (await fixesNow($))?.live
    const how = l.reload === 'pending' ? ' · reloads when Claude finishes · '
      : l.reload === 'restart' ? ` · restart Claude Code with --plugin-dir ${live ? await shownPath($, `${live}/plugin`) : 'your fixes'} to load it · `
        : ' · thimble reloaded · '
    first = [Text({ key: 'g', color: 'success', children: '✓ ' }), Text({ key: 't', children: `${title} is on` }), dim('m', how), ...keyText(els, 'u', 'undo', 0, press)]
    second = [dim('o', `    If thimble stops loading: sh ${off}`)]
  } else if (l.kind === 'off') {
    first = l.back
      ? [Text({ key: 'g', dimColor: true, children: '↺ ' }), Text({ key: 't', children: `${title} is back to its version before` }), dim('m', ' · thimble reloaded')]
      : [Text({ key: 'g', dimColor: true, children: '○ ' }), Text({ key: 't', children: `${title} is off` }), dim('m', ' · thimble reloaded · thimble fix on, in a shell, turns it on again')]
  } else if (l.kind === 'failed') {
    // the reason whole: after the title when it fits there, else on a row of its own
    const reason = f?.error || 'its tests failed'
    const lead = f?.prev ? 'The change to ' : ''
    const fits = textWidth(`  × ${lead}${title} did not pass · ${reason}`) <= width
    first = [Text({ key: 'g', color: 'error', children: '× ' }), Text({ key: 'h', children: lead }), Text({ key: 't', children: title }), Text({ key: 'p', children: ' did not pass' }),
      ...(fits ? [dim('m', ` · ${reason}`)] : [])]
    if (!fits) why = [Text({ key: 'w', dimColor: true, wrap: 'wrap', children: `  ${reason}` })]
    second = failedKeys(els, f, false, press)
  } else if (l.kind === 'request') {
    first = l.kept
      ? [Text({ key: 'g', color: accent(), children: '◇ ' }), Text({ key: 'h', children: 'Claude changed no code: ' }), Text({ key: 't', children: title }), Text({ key: 'm', children: ' stays as it was' })]
      : [Text({ key: 'g', color: accent(), children: '◇ ' }), Text({ key: 'h', children: 'Saved as a request with no code: ' }), Text({ key: 't', children: title })]
    second = l.kept ? keysRow(els, [['n', 'ok']], press) : [...keysRow(els, [['n', 'ok']], press), dim('m', ' · thimble fix list, in a shell, lists it')]
  } else if (l.kind === 'update') {
    first = [Text({ key: 'g', color: accent(), children: '↑ ' }), Text({ key: 't', children: l.said || 'thimble moved to a new release' }), dim('m', ' · thimble reloaded · thimble fix list, in a shell, lists your fixes')]
  } else if (l.kind === 'release') {
    first = [Text({ key: 'g', color: accent(), children: '↑ ' }), Text({ key: 't', children: l.said || 'a new thimble release is out' })]
  } else if (l.kind === 'problem') {
    first = [Text({ key: 't', color: 'error', wrap: 'wrap', children: `× ${l.said || `${f ? `“${fixName(f)}”` : `fix ${l.id}`} did not go through`}` })]
  } else return []
  return [row('fix-line-1', first), ...(why.length ? [row('fix-line-why', why)] : []), ...(note.length ? [row('fix-line-notice', note)] : []),
    ...(second.length ? [Box({ key: 'fix-line-2', flexDirection: 'row', flexWrap: 'wrap', width, children: second })] : [])]
}
