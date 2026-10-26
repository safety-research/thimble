// line.ts: the one line above the bar for a fix (bar.tsx draws it under the failure line), and its keys at an empty
// prompt (hooks/keys.ts asks fixKey first while the line shows):
//
//   ready     ✓ thimble fixed: <title> · tests pass
//               y use it now · d what changed · n later
//             (a round of a fix the person has: ✓ thimble changed: <title> · tests pass; the version they have stays
//             until y, and d shows each round's words)
//             d shows what changed in its place, in a few lines, not a diff:
//             <title>
//               You asked   <the words>
//               Claude did  <what it does>
//               Changed     2 files · tests pass
//               y use it now · n later
//   applied   ✓ <title> is on · thimble reloaded · u undo (or: reloads when Claude finishes; or, in a session that
//               If thimble stops loading: sh …/off.sh       loads thimble with --plugin-dir, the restart that loads it)
//   off       ○ <title> is off · thimble reloaded           (until the next prompt)
//             ↺ <title> is back to its version before · thimble reloaded   (u after y on a changed fix)
//   failed    × <title> did not pass · <why>                d what changed · r redo · n later
//             (× The change to <title> did not pass, for a round of a fix the person has: n leaves the fix as it was;
//             a <why> too long for the row, such as a refusal that names files, gets a row of its own)
//   request   ◇ Saved as a request with no code: <title>    n ok · thimble fix list, in a shell, lists it
//             ◇ Claude changed no code: <title> stays as it was   (a round of a fix the person has)
//   update    ↑ thimble 0.10.3 · 3 fixes carried · 1 needs redo   (until the next prompt)
//   release   ↑ thimble 0.10.3 is out (you have 0.10.2) · thimble update in a shell   (at session start)
//   problem   × <what went wrong, with what to do>           (until the next prompt)
//
// y applies: from then on the fix's code runs as thimble, so only the person's key does it (fixes.ts). n leaves a ready
// fix ready in the person's list (thimble fix list, in a shell), where thimble fix apply N turns it on later.
import type { EngineInterface } from 'claude-code'

import { thimbleHome } from '../core/home'
import { quiet } from '../core/askcell.js'
import { cut, textWidth } from '../core/text.js'
import { accent } from '../core/theme'
import { testsWord } from './fixer'
import { applyFix, type Fix, fixesDir, fixesNow, fixLineNow, fixName, fixOf, notNow, setFixLine, shownPath, undoFix } from './fixes'
import { redoFix } from './request'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** The keys the line takes now, by its kind. */
const KEYS: Record<string, string[]> = { ready: ['y', 'd', 'n'], applied: ['u'], failed: ['d', 'r', 'n'], request: ['n'] }

/** What a key on the line does, once the word window closed (it cannot be undone). */
export async function fixKey($: Engine, k: string): Promise<{ later: () => Promise<unknown> } | null> {
  // a key no line takes reads nothing: a key's hook has a few milliseconds of its own time
  if (!Object.values(KEYS).some(ks => ks.includes(k))) return null
  const l = await fixLineNow($)
  if (!l || !(KEYS[l.kind] ?? []).includes(k)) return null
  return { later: () => pressLine($, l.id, l.kind, k) }
}

async function pressLine($: Engine, id: number, kind: string, k: string): Promise<void> {
  let said: string | null = null
  if (k === 'y') said = await applyFix($, id)
  else if (k === 'u') said = await undoFix($, id)
  else if (k === 'd') {
    // what changed, in the line's place, or the line again
    const l = await fixLineNow($)
    if (l?.id === id) await setFixLine($, { ...l, open: !l.open })
  } else if (k === 'r') said = await redoFix($, id)
  else if (k === 'n') {
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

/** The person's next prompt: a line that only told something goes. A fix that waits for y stays. */
export async function lineSeen($: Engine): Promise<void> {
  const l = await fixLineNow($)
  if (l && (l.kind === 'off' || l.kind === 'problem' || l.kind === 'update' || l.kind === 'release' || (l.kind === 'applied' && !l.reload))) await setFixLine($, null)
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

/** What changed, in a few rows (d): the person's words, what Claude did, and what it changed. */
function whatChanged(els: Any, f: Fix, width: number, changed: string): Any[] {
  const { Box, Text } = els
  const room = Math.max(20, width - 16)
  const row = (key: string, label: string, text: string) => Box({ key, flexDirection: 'row', width, children: [
    // the label keeps its width: a value that wraps beside it would take its trailing spaces
    Box({ key: 'l', width: 16, flexShrink: 0, children: [Text({ key: 't', dimColor: true, children: `    ${label}`.padEnd(16) })] }),
    Box({ key: 'v', flexShrink: 1, children: [Text({ key: 't', wrap: 'wrap', children: text })] }),
  ] })
  const words = f.words || []
  return [
    Box({ key: 'fix-what-head', flexDirection: 'row', width, children: [Text({ key: 'i', children: '  ' }), Text({ key: 't', bold: true, children: cut(f.title, Math.max(12, width - 4)) })] }),
    ...words.map((w, i) => row(`fix-what-asked-${i}`, i ? 'then' : 'You asked', cut(w, room * 2))),
    ...(f.summary ? [row('fix-what-did', 'Claude did', cut(f.summary, room * 3))] : []),
    row('fix-what-changed', 'Changed', changed),
  ]
}

/** The line's rows, `width` cells wide, or none. */
export async function fixLineRows($: Engine, els: Any, width: number): Promise<Any[]> {
  const l = await fixLineNow($)
  if (!l) return []
  const { Box, Text } = els
  const f: Fix | null = l.id ? await fixOf($, l.id) : null
  const title = cut(f?.title || `fix ${l.id}`, Math.max(12, width - 40))
  const row = (key: string, children: Any[]) => Box({ key, flexDirection: 'row', flexWrap: 'wrap', width, children: [Text({ key: 'in', children: '  ' }), ...children] })
  const dim = (key: string, children: string) => Text({ key, dimColor: true, children })
  // a click on a key's words does what the key does
  const press = (k: string) => pressLine($, l.id, l.kind, k)
  if (l.kind === 'ready' && f && l.open) {
    return [...whatChanged(els, f, width, `${filesWord(f)} · ${testsWord(f)}`), Box({ key: 'fix-line-2', flexDirection: 'row', width, children: keysRow(els, [['y', 'use it now'], ['n', 'later']], press) })]
  }
  if (l.kind === 'failed' && f && l.open) {
    return [...whatChanged(els, f, width, `${filesWord(f)} · ${f.error || 'its tests failed'}`), Box({ key: 'fix-line-2', flexDirection: 'row', width, children: keysRow(els, [['r', 'redo'], ['n', 'later']], press) })]
  }
  let first: Any[] = []
  let second: Any[] = []
  let why: Any[] = []
  if (l.kind === 'ready' && f) {
    // a round of a fix the person has: its new version, which y puts in place of the one they have
    first = [Text({ key: 'g', color: 'success', children: '✓ ' }), Text({ key: 'h', bold: true, children: f.prev ? 'thimble changed: ' : 'thimble fixed: ' }), Text({ key: 't', bold: true, children: title }), dim('m', ` · ${testsWord(f)}`)]
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
    second = keysRow(els, [['d', 'what changed'], ['r', 'redo'], ['n', 'later']], press)
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
  return [row('fix-line-1', first), ...(why.length ? [row('fix-line-why', why)] : []),
    ...(second.length ? [Box({ key: 'fix-line-2', flexDirection: 'row', flexWrap: 'wrap', width, children: second })] : [])]
}
