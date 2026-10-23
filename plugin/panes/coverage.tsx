// coverage.tsx: the coverage pane (core/pane.ts kind `coverage`): what this session did with the folder's files, from
// the last `thimble coverage --json` (bar/counts.ts lastCoverage; engine/kernel/coverage.py says what each measure
// is). The bar's `r coverage …` opens it, by a click or r. coverage-view.mjs lays it out as lines of runs; this file
// draws them with Claude Code's own elements and keeps the view.
//
// Each tree row is a Button (its key `dir:<folder>` or `file:<path>`): a click or ↵ on it opens a folder one level,
// or closes it, and picks a file. j k move the selection, and the focus with it, so ↵ acts on the row selected. The
// three shades are theme colors, so the pane reads on a dark and a light terminal: read into Claude's context in the
// citations' color (`merged`), computed over or searched in `inactive`, untouched in `subtle`.
//
//   state: paneView/coverage {open: the folders open, sel: the row selected, top: the first tree row shown}
import type { EngineInterface } from 'claude-code'

import { countsNow, lastCoverage } from '../bar/counts'
import { quiet } from '../core/askcell.js'
import { closePane, PANE_ID } from '../core/pane'
import { featureOn } from '../settings/features.mjs'
import { rowsUnder } from '../threads/seam'
import { coverageView, pressView, stepView } from './coverage-view.mjs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const VIEW = { plugin: 'thimble', key: 'paneView', id: 'coverage' } as const
type View = { open?: string[]; sel?: string | null; top?: number }
type Run = { s: string; tone?: string | null }

/** Each tone of the layout as Text props: the three shades as theme colors, the rest dim or bold. */
const TONE: Record<string, Record<string, unknown>> = {
  read: { color: 'merged' },
  comp: { color: 'inactive' },
  track: { color: 'subtle' },
  dim: { dimColor: true },
  rule: { dimColor: true },
  bold: { bold: true },
}
/** The selected row's name, tinted: the soft band Claude Code draws behind the person's own messages. */
const SEL_TINT = 'userMessageBackground'

export async function drawCoverage($: EngineInterface, e: Any, args: unknown, els: Any): Promise<unknown> {
  const { Box, Button, Text } = els
  const W = Math.max(24, Number(e?.props?.bodyColumns) || 80)
  const H = Math.max(12, Number(e?.props?.scroll?.bodyRows) || 40)
  const counts = await countsNow($)
  const cov = lastCoverage()
  if (!featureOn('counts')) return Text({ dimColor: true, wrap: 'wrap', children: 'Coverage is off. Turn it on in /thimble-settings.' })
  const failed = counts?.error ? Text({ key: 'failed', color: 'error', wrap: 'wrap', children: `× ${counts.error}${cov ? ' Below is the last count.' : ''}` }) : null
  if (!cov) return failed ?? Text({ dimColor: true, children: 'Counting what Claude touched…' })
  const view = ((await $.state.get(VIEW)).value ?? {}) as View
  const under = await rowsUnder($, e, 'coverage', args).catch(() => 5)
  const dims = { W, H: H - (failed ? 2 : 0), under }
  const v = coverageView(cov, view, dims)
  const focus = (key: string | null | undefined) => (key ? $.ui.focus({ requestId: PANE_ID, key }).catch(() => undefined) : undefined)
  const go = async (next: View) => { await $.state.set(VIEW, next); await focus(next.sel) }
  const press = (key: string) => () => $.state.set(VIEW, pressView(cov, view, key, dims))
  const step = (d: number) => () => go(stepView(cov, view, d, dims))

  const runs = (rs: Run[], sel = false) => rs.map((r, i) => Text({ key: `r${i}`, ...(r.tone ? TONE[r.tone] : {}),
    ...(sel && i === 0 ? { bold: true, backgroundColor: SEL_TINT } : {}), children: r.s }))
  const lines = v.lines.map((l: Any) => (l.press
    ? Button({ key: l.press, plain: true, label: l.press.replace(/^(dir|file):/, ''), onPress: press(l.press), ...(l.sel ? { autoFocus: true } : {}), children: runs(l.runs, l.sel) })
    : Text({ key: l.key, wrap: 'truncate-end', children: runs(l.runs) })))

  // the keys, under a rule: each a plain Button its key presses (Claude Code draws the key, lit, then a colon)
  const keys: [string | null, string, () => unknown][] = [
    ['k', 'up', step(-1)],
    ['j', 'down', step(1)],
    [null, v.anyOpen ? 'open / collapse' : 'open', () => (v.selKey ? press(v.selKey)() : undefined)],
    ['r', 'close', () => closePane($)],
  ]
  const keyRow = Box({ key: 'keys', flexDirection: 'row', flexWrap: 'wrap', children: keys.flatMap(([k, label, onPress], i) => [
    ...(i ? [Text({ key: `key-sep-${i}`, dimColor: true, children: ' · ' })] : []),
    k
      ? Button({ key: `key-${k}`, plain: true, hotkey: k, label, hover: quiet(`coverage-key-${k}`), onPress, children: [Text({ key: 'w', dimColor: true, children: label })] })
      : Button({ key: 'key-enter', plain: true, label, hover: quiet('coverage-key-enter'), onPress, children: [Text({ key: 'k', color: 'suggestion', bold: true, children: '↵' }), Text({ key: 'w', dimColor: true, children: ` ${label}` })] }),
  ]) })

  return Box({ flexDirection: 'column', width: W, children: [
    ...lines.slice(0, 1),
    ...(failed ? [failed] : []),
    ...lines.slice(1),
    Text({ key: 'keys-rule', dimColor: true, children: '─'.repeat(W) }),
    keyRow,
  ] })
}
