// line.ts: the one line above the bar for a fix (bar.tsx draws it under the failure line), between two rules, and its
// keys at an empty prompt (hooks/keys.ts asks fixKey first while the line shows):
//
//   ready     ✓ Fix ready: <title> · 3 files +29 −2 · tests passed      y apply · d diff · n not now
//   applied   ✓ <title> is on · thimble reloaded · u undo               If thimble stops loading: sh …/off.sh
//   off       ○ <title> is off · thimble reloaded                        (until the next prompt)
//   failed    × Fix 7 did not pass: <title> · <why>                     d diff · r redo · n not now
//   request   ◇ Saved as a request with no code: <title>                n ok · /thimble-fix lists it
//   update    ↑ thimble 0.10.3 · 3 fixes carried · 1 needs redo         (a new release at session start; until the next
//                                                                        prompt)
//   problem   × <what went wrong, with what to do>                      (until the next prompt)
//
// y applies: from then on the fix's code runs outside the sandbox, so only the person's key does it (fixes.ts).
import type { EngineInterface } from 'claude-code'

import { thimbleHome } from '../core/home'
import { cut, textWidth } from '../core/text.js'
import { ACCENT } from '../core/theme'
import { applyFix, type Fix, fixesDir, fixLineNow, fixOf, notNow, setFixLine, shownPath, sizeOf, undoFix } from './fixes'
import { openFixes } from './pane'
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
  const l = await fixLineNow($)
  if (!l || !(KEYS[l.kind] ?? []).includes(k)) return null
  return { later: () => pressLine($, l.id, l.kind, k) }
}

async function pressLine($: Engine, id: number, kind: string, k: string): Promise<void> {
  let said: string | null = null
  if (k === 'y') said = await applyFix($, id)
  else if (k === 'u') said = await undoFix($, id)
  else if (k === 'd') await openFixes($, { sel: id, diff: true })
  else if (k === 'r') said = await redoFix($, id)
  else if (k === 'n') {
    if (kind === 'request' || kind === 'failed') {
      await setFixLine($, null)
      if (kind === 'failed') said = await notNow($, id)
    } else said = await notNow($, id)
    if (!said && kind === 'ready') $.ui.toast(`Fix ${id} waits in Your fixes, off. /thimble-fix lists it.`)
  }
  if (said) await setFixLine($, { id, kind: 'problem', said })
}

/** The person's next prompt: a line that only told something goes. A fix that waits for y stays. */
export async function lineSeen($: Engine): Promise<void> {
  const l = await fixLineNow($)
  if (l && (l.kind === 'applied' || l.kind === 'off' || l.kind === 'problem' || l.kind === 'update')) await setFixLine($, null)
}

function keyText(els: Any, k: string, words: string, i: number): Any[] {
  const { Text } = els
  return [...(i ? [Text({ key: `s${i}`, dimColor: true, children: ' · ' })] : []),
    Text({ key: `k${i}`, color: KEY_COLOR, bold: true, children: k }), Text({ key: `w${i}`, children: ` ${words}` })]
}

/** The line's rows, `width` cells wide, or none. */
export async function fixLineRows($: Engine, els: Any, width: number): Promise<Any[]> {
  const l = await fixLineNow($)
  if (!l) return []
  const { Box, Text } = els
  const f: Fix | null = l.id ? await fixOf($, l.id) : null
  const title = cut(f?.title || `fix ${l.id}`, Math.max(12, width - 40))
  const rule = (key: string) => Text({ key, color: 'warning', children: '─'.repeat(Math.max(4, width)) })
  const row = (key: string, children: Any[]) => Box({ key, flexDirection: 'row', flexWrap: 'wrap', width, children })
  const dim = (key: string, children: string) => Text({ key, dimColor: true, children })
  let first: Any[] = []
  let second: Any[] = []
  if (l.kind === 'ready' && f) {
    first = [Text({ key: 'g', color: 'success', children: '✓ ' }), Text({ key: 'h', bold: true, children: 'Fix ready: ' }), Text({ key: 't', children: title }),
      dim('m', ` · ${sizeOf(f)} · tests ${f.tests === 'passed' ? 'passed in the sandbox' : f.tests || 'not run'}`)]
    second = [Text({ key: 'i', children: '  ' }), ...keyText(els, 'y', 'apply', 0), ...keyText(els, 'd', 'diff', 1), ...keyText(els, 'n', 'not now', 2)]
  } else if (l.kind === 'applied') {
    const off = await shownPath($, `${fixesDir(await thimbleHome($))}/off.sh`)
    first = [Text({ key: 'g', color: 'success', children: '✓ ' }), Text({ key: 't', children: `${title} is on` }), dim('m', ' · thimble reloaded · '),
      ...keyText(els, 'u', 'undo', 0)]
    second = [dim('o', `  If thimble stops loading: sh ${off}`)]
  } else if (l.kind === 'off') {
    first = [Text({ key: 'g', dimColor: true, children: '○ ' }), Text({ key: 't', children: `${title} is off` }), dim('m', ' · thimble reloaded · /thimble-fix turns it on again')]
  } else if (l.kind === 'failed') {
    first = [Text({ key: 'g', color: 'error', children: '× ' }), Text({ key: 'h', children: `Fix ${l.id} did not pass: ` }), Text({ key: 't', children: title }),
      dim('m', ` · ${cut(f?.error || 'its tests failed', Math.max(20, width - textWidth(title) - 30))}`)]
    second = [Text({ key: 'i', children: '  ' }), ...keyText(els, 'd', 'diff', 0), ...keyText(els, 'r', 'redo', 1), ...keyText(els, 'n', 'not now', 2)]
  } else if (l.kind === 'request') {
    first = [Text({ key: 'g', color: KEY_COLOR, children: '◇ ' }), Text({ key: 'h', children: 'Saved as a request with no code: ' }), Text({ key: 't', children: title })]
    second = [Text({ key: 'i', children: '  ' }), ...keyText(els, 'n', 'ok', 0), dim('m', ' · /thimble-fix lists it, and s submits it')]
  } else if (l.kind === 'update') {
    first = [Text({ key: 'g', color: KEY_COLOR, children: '↑ ' }), Text({ key: 't', children: l.said || 'thimble moved to a new release' }), dim('m', ' · thimble reloaded · /thimble-fix lists your fixes')]
  } else if (l.kind === 'problem') {
    first = [Text({ key: 't', color: 'error', wrap: 'wrap', children: `× ${l.said || `fix ${l.id} did not go through`}` })]
  } else return []
  return [rule('fix-rule-a'), row('fix-line-1', first), ...(second.length ? [row('fix-line-2', second)] : []), rule('fix-rule-b')]
}
