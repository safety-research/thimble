// line.ts: the one line above the bar for a fix (bar.tsx draws it under the failure line), and its keys at an empty
// prompt (hooks/keys.ts asks fixKey first while the line shows):
//
//   ready     ✓ thimble fixed: <title> · tests pass
//               y use it now · d what changed · n later
//             d shows what changed in its place, in a few lines, not a diff:
//             <title> · fix 3
//               You asked   <the words>
//               Claude did  <what it does>
//               Changed     2 files · tests pass
//               y use it now · n later
//   applied   ✓ <title> is on · thimble reloaded · u undo (or: reloads when Claude finishes; or, in a session that
//               If thimble stops loading: sh …/off.sh       loads thimble with --plugin-dir, the restart that loads it)
//   off       ○ <title> is off · thimble reloaded           (until the next prompt)
//   failed    × Fix 7 did not pass: <title> · <why>         d what changed · r redo · n later
//             (a <why> too long for the row, such as a refusal that names files, gets a row of its own)
//   request   ◇ Saved as a request with no code: <title>    n ok · /thimble-fix lists it
//   update    ↑ thimble 0.10.3 · 3 fixes carried · 1 needs redo   (until the next prompt)
//   release   ↑ thimble 0.10.3 is out (you have 0.10.2) · thimble update in a shell   (at session start)
//   problem   × <what went wrong, with what to do>           (until the next prompt)
//
// y applies: from then on the fix's code runs as thimble, so only the person's key does it (fixes.ts). n leaves a ready
// fix ready in Your fixes, where y turns it on later.
import type { EngineInterface } from 'claude-code'

import { thimbleHome } from '../core/home'
import { cut, textWidth } from '../core/text.js'
import { ACCENT } from '../core/theme'
import { testsWord } from './fixer'
import { applyFix, type Fix, fixesDir, fixesNow, fixLineNow, fixOf, notNow, setFixLine, shownPath, undoFix } from './fixes'
import { redoFix } from './request'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** A key the person can press, in thimble's accent as the bar draws its keys (core/theme.ts). */
const KEY_COLOR = ACCENT

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
    // a ready fix stays ready in the list, where y turns it on later; a failed one stays failed there, for r
    await setFixLine($, null)
    if (kind === 'failed') said = await notNow($, id)
    if (!said && kind === 'ready') $.ui.toast(`Fix ${id} waits in Your fixes, ready: /thimble-fix lists it, and y there turns it on.`)
  }
  if (said) await setFixLine($, { id, kind: 'problem', said })
}

/** The person's next prompt: a line that only told something goes. A fix that waits for y stays. */
export async function lineSeen($: Engine): Promise<void> {
  const l = await fixLineNow($)
  if (l && (l.kind === 'off' || l.kind === 'problem' || l.kind === 'update' || l.kind === 'release' || (l.kind === 'applied' && !l.reload))) await setFixLine($, null)
}

function keyText(els: Any, k: string, words: string, i: number): Any[] {
  const { Text } = els
  return [...(i ? [Text({ key: `s${i}`, dimColor: true, children: ' · ' })] : []),
    Text({ key: `k${i}`, color: KEY_COLOR, bold: true, children: k }), Text({ key: `w${i}`, children: ` ${words}` })]
}

/** The keys' row: each key and its words, after the row's indent. */
function keysRow(els: Any, keys: [string, string][]): Any[] {
  return [els.Text({ key: 'i', children: '    ' }), ...keys.flatMap(([k, w], i) => keyText(els, k, w, i))]
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
    Box({ key: 'fix-what-head', flexDirection: 'row', width, children: [Text({ key: 'i', children: '  ' }), Text({ key: 't', bold: true, children: cut(f.title, Math.max(12, width - 14)) }), Text({ key: 'n', dimColor: true, children: ` · fix ${f.id}` })] }),
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
  if (l.kind === 'ready' && f && l.open) {
    return [...whatChanged(els, f, width, `${filesWord(f)} · ${testsWord(f)}`), Box({ key: 'fix-line-2', flexDirection: 'row', width, children: keysRow(els, [['y', 'use it now'], ['n', 'later']]) })]
  }
  if (l.kind === 'failed' && f && l.open) {
    return [...whatChanged(els, f, width, `${filesWord(f)} · ${f.error || 'its tests failed'}`), Box({ key: 'fix-line-2', flexDirection: 'row', width, children: keysRow(els, [['r', 'redo'], ['n', 'later']]) })]
  }
  let first: Any[] = []
  let second: Any[] = []
  let why: Any[] = []
  if (l.kind === 'ready' && f) {
    first = [Text({ key: 'g', color: 'success', children: '✓ ' }), Text({ key: 'h', bold: true, children: 'thimble fixed: ' }), Text({ key: 't', bold: true, children: title }), dim('m', ` · ${testsWord(f)}`)]
    second = keysRow(els, [['y', 'use it now'], ['d', 'what changed'], ['n', 'later']])
  } else if (l.kind === 'applied') {
    const off = await shownPath($, `${fixesDir(await thimbleHome($))}/off.sh`)
    const live = (await fixesNow($))?.live
    const how = l.reload === 'pending' ? ' · reloads when Claude finishes · '
      : l.reload === 'restart' ? ` · restart Claude Code with --plugin-dir ${live ? await shownPath($, `${live}/plugin`) : 'your fixes'} to load it · `
        : ' · thimble reloaded · '
    first = [Text({ key: 'g', color: 'success', children: '✓ ' }), Text({ key: 't', children: `${title} is on` }), dim('m', how), ...keyText(els, 'u', 'undo', 0)]
    second = [dim('o', `    If thimble stops loading: sh ${off}`)]
  } else if (l.kind === 'off') {
    first = [Text({ key: 'g', dimColor: true, children: '○ ' }), Text({ key: 't', children: `${title} is off` }), dim('m', ' · thimble reloaded · /thimble-fix turns it on again')]
  } else if (l.kind === 'failed') {
    // the reason whole: after the title when it fits there, else on a row of its own
    const reason = f?.error || 'its tests failed'
    const fits = textWidth(`  × Fix ${l.id} did not pass: ${title} · ${reason}`) <= width
    first = [Text({ key: 'g', color: 'error', children: '× ' }), Text({ key: 'h', children: `Fix ${l.id} did not pass: ` }), Text({ key: 't', children: title }),
      ...(fits ? [dim('m', ` · ${reason}`)] : [])]
    if (!fits) why = [Text({ key: 'w', dimColor: true, wrap: 'wrap', children: `  ${reason}` })]
    second = keysRow(els, [['d', 'what changed'], ['r', 'redo'], ['n', 'later']])
  } else if (l.kind === 'request') {
    first = [Text({ key: 'g', color: KEY_COLOR, children: '◇ ' }), Text({ key: 'h', children: 'Saved as a request with no code: ' }), Text({ key: 't', children: title })]
    second = [...keysRow(els, [['n', 'ok']]), dim('m', ' · /thimble-fix lists it, and s submits it')]
  } else if (l.kind === 'update') {
    first = [Text({ key: 'g', color: KEY_COLOR, children: '↑ ' }), Text({ key: 't', children: l.said || 'thimble moved to a new release' }), dim('m', ' · thimble reloaded · /thimble-fix lists your fixes')]
  } else if (l.kind === 'release') {
    first = [Text({ key: 'g', color: KEY_COLOR, children: '↑ ' }), Text({ key: 't', children: l.said || 'a new thimble release is out' })]
  } else if (l.kind === 'problem') {
    first = [Text({ key: 't', color: 'error', wrap: 'wrap', children: `× ${l.said || `fix ${l.id} did not go through`}` })]
  } else return []
  return [row('fix-line-1', first), ...(why.length ? [row('fix-line-why', why)] : []),
    ...(second.length ? [Box({ key: 'fix-line-2', flexDirection: 'row', flexWrap: 'wrap', width, children: second })] : [])]
}
