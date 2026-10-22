// evidence.tsx: the side pane of one mark (core/pane.ts kind `evidence`, args {row, n}): its status and, once the check
// gave it, its evidence.
//
//   computed   the code the check ran, and that call's real output with the marked words highlighted
//   quote      the file at its line: `path:line` on top (the terminal opens it), the cited lines with a line or two
//   code       around them, the substring highlighted
//
// A corrected mark says what it was; a failed one says why, in red. The pane reads the reply's marks in the state, so
// it draws again when the check settles.
import type { EngineInterface } from 'claude-code'

import { type Evidence, type MarkItem, rowMarks } from './store'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const OUTPUT_ROWS = 14 // output lines shown around the first highlight

const STATUS: Record<string, { word: string; color?: string; dim?: boolean }> = {
  checking: { word: 'checking', dim: true },
  verified: { word: 'verified', color: 'success' },
  corrected: { word: 'corrected', color: 'warning' },
  failed: { word: 'failed', color: 'error' },
  unchecked: { word: 'not checked', dim: true },
}

/** A line of text with spans of it highlighted (the theme's warning color behind them), as Text runs. */
function highlighted(els: Any, text: string, spans: [number, number][], key: string): Any {
  const parts: Any[] = []
  let at = 0
  spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]).forEach(([a, b], k) => {
    if (a < at) return
    if (a > at) parts.push(text.slice(at, a))
    parts.push(els.Text({ key: `h${k}`, color: 'inverseText', backgroundColor: 'warning', bold: true, children: text.slice(a, b) }))
    at = b
  })
  if (at < text.length) parts.push(text.slice(at))
  return els.Text({ key, wrap: 'wrap', children: parts.length ? parts : ' ' })
}

/** The output's lines around its first highlight, each with the parts of the spans that fall in it. */
function outputRows(els: Any, output: string, spans: [number, number][]): Any[] {
  const lines = output.split('\n')
  const starts: number[] = []
  let at = 0
  for (const l of lines) { starts.push(at); at += l.length + 1 }
  const first = spans.length ? Math.max(0, starts.findIndex((s, i) => spans[0]![0] >= s && spans[0]![0] <= s + lines[i]!.length)) : 0
  const from = Math.max(0, Math.min(first - 3, lines.length - OUTPUT_ROWS))
  const to = Math.min(lines.length, from + OUTPUT_ROWS)
  const out: Any[] = []
  if (from > 0) out.push(els.Text({ key: 'up', dimColor: true, children: `… ${from} line${from === 1 ? '' : 's'} above` }))
  for (let i = from; i < to; i++) {
    const s = starts[i]!
    const mine = spans.map(([a, b]) => [Math.max(a, s) - s, Math.min(b, s + lines[i]!.length) - s] as [number, number]).filter(([a, b]) => b > a)
    out.push(highlighted(els, lines[i]!, mine, `o${i}`))
  }
  if (to < lines.length) out.push(els.Text({ key: 'down', dimColor: true, children: `… ${lines.length - to} line${lines.length - to === 1 ? '' : 's'} below` }))
  return out
}

/** Whether line n is one of the cited lines (`12` or `8-11`). */
function inRange(n: number, line: string): boolean {
  const [a, b] = line.split('-').map(Number)
  return n >= a! && n <= (b ?? a!)
}

function evidenceRows(els: Any, ev: Evidence): Any[] {
  const { Box, Code, Text } = els
  if (ev.kind === 'computed') {
    return [
      Text({ key: 'ch', bold: true, children: ev.by === 'main' ? 'Code Claude ran for the reply' : 'Code the check ran' }),
      Code({ key: 'code', source: ev.code, language: 'python' }),
      Text({ key: 'oh', bold: true, children: 'Its output' }),
      Box({ key: 'out', flexDirection: 'column', children: outputRows(els, ev.output, ev.highlight) }),
    ]
  }
  const gutter = Math.max(...ev.lines.map(l => String(l.n).length))
  return [
    Text({ key: 'at', bold: true, children: `${ev.file}:${ev.line}` }),
    ...ev.lines.map(l => Box({ key: `l${l.n}`, flexDirection: 'row', children: [
      Text({ dimColor: true, children: `${String(l.n).padStart(gutter)} ${l.decoded ? '›' : '│'} ` }),
      Box({ flexShrink: 1, children: [l.highlight ? highlighted(els, l.text, [l.highlight], 't') : Text({ wrap: 'wrap', dimColor: !inRange(l.n, ev.line), children: l.text || ' ' })] }),
    ] })),
    ...(ev.lines.some(l => l.decoded) ? [Text({ key: 'dec', dimColor: true, children: '› the line\'s JSON text, decoded' })] : []),
  ]
}

/** The pane of one mark. */
export async function drawEvidence($: EngineInterface, _e: Any, args: unknown, els: Any): Promise<unknown> {
  const { Box, Text } = els
  const { row, n } = (args ?? {}) as { row?: string; n?: number }
  const reply = row ? await rowMarks($, row) : null
  const m: MarkItem | undefined = reply?.items.find(x => x.n === n)
  if (!m) return Text({ dimColor: true, wrap: 'wrap', children: 'This mark is no longer in the session.' })
  const st = STATUS[m.status] ?? STATUS.unchecked!
  const head = Text({ key: 'head', wrap: 'wrap', children: [
    Text({ key: 's', bold: true, ...(st.color ? { color: st.color } : {}), ...(st.dim ? { dimColor: true } : {}), children: st.word }),
    Text({ key: 'w', children: `  ${m.shown}` }),
  ] })
  const rows: Any[] = [head]
  if (m.status === 'corrected' && m.was) rows.push(Text({ key: 'was', dimColor: true, wrap: 'wrap', children: `was ${m.was}` }))
  if (m.reason) rows.push(Text({ key: 'why', wrap: 'wrap', ...(m.status === 'failed' ? { color: 'error' } : { dimColor: true }), children: m.reason }))
  rows.push(Text({ key: 'sent', dimColor: true, italic: true, wrap: 'wrap', children: m.sentence }))
  if (m.status === 'checking') rows.push(Text({ key: 'wait', dimColor: true, children: 'The check is running; its evidence shows here when it ends.' }))
  if (m.evidence) rows.push(Box({ key: 'ev', flexDirection: 'column', marginTop: 1, children: evidenceRows(els, m.evidence) }))
  return Box({ flexDirection: 'column', children: rows })
}
