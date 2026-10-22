// evidence.tsx: the side pane of one mark (core/pane.ts kind `evidence`, args {row, n}): its status and, once the check
// gave it, its evidence.
//
//   computed   that call's real output, the marked words highlighted, first, so it is on the screen; then the code
//              the check ran
//   quote      each cited place: `path:line` on top (the terminal opens it), the cited lines with a line around them,
//   code       the substring highlighted
//
// A corrected mark says what it was; a wrong one says why, in red, and one the check could not confirm says why, in
// the warning color, with the evidence the check gave when it is real. What the check found wrong in the rest of the
// sentence follows. The mark's sentence shows as the person read it. Code is cut between tokens to fit the pane. The
// pane reads the reply's marks in the state, so it draws again when the check settles.
import type { EngineInterface } from 'claude-code'

import { plainSentence } from './message.js'
import { type Evidence, type MarkItem, type Place, rowMarks } from './store'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const OUTPUT_ROWS = 14 // output lines shown around the first highlight

const STATUS: Record<string, { word: string; color?: string; dim?: boolean }> = {
  checking: { word: 'checking', dim: true },
  verified: { word: 'verified', color: 'success' },
  corrected: { word: 'corrected', color: 'warning' },
  failed: { word: 'wrong', color: 'error' },
  unconfirmed: { word: 'not confirmed', color: 'warning' },
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

/** The output's lines around its first highlight, each with the parts of the spans that fall in it; `rows` of them
 *  (the tray shows fewer than the pane). */
export function outputRows(els: Any, output: string, spans: [number, number][], rows = OUTPUT_ROWS): Any[] {
  const lines = output.split('\n')
  const starts: number[] = []
  let at = 0
  for (const l of lines) { starts.push(at); at += l.length + 1 }
  const first = spans.length ? Math.max(0, starts.findIndex((s, i) => spans[0]![0] >= s && spans[0]![0] <= s + lines[i]!.length)) : 0
  const from = Math.max(0, Math.min(first - 3, lines.length - rows))
  const to = Math.min(lines.length, from + rows)
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

/** Code cut into lines that fit `width`, each cut at a break between tokens (after a space, or after `, ( [ { . = :`
 *  and an operator), the rest indented under its line, so no name breaks in two. A token wider than the line is cut. */
export function wrapCode(code: string, width: number): string {
  if (!(width >= 20)) return code
  return code.split('\n').map(line => {
    const out: string[] = []
    const indent = `${/^\s*/.exec(line)![0]}    `.slice(0, Math.floor(width / 2))
    let rest = line
    while (rest.length > width) {
      let cut = -1
      for (let i = width - 1; i > indent.length; i--) {
        if (rest[i] === ' ' || ',([{.=:+-*/'.includes(rest[i]!)) { cut = i + 1; break }
      }
      if (cut < 0) cut = width
      out.push(rest.slice(0, cut).trimEnd())
      rest = indent + rest.slice(cut).trimStart()
    }
    out.push(rest)
    return out.join('\n')
  }).join('\n')
}

/** One cited place: `path:line` of the line that holds the words (the terminal opens it there), with the cited
 *  range when it is wider, then its lines, the cited ones in full color. */
export function placeRows(els: Any, p: Place, key: string): Any[] {
  const { Box, Text } = els
  const gutter = Math.max(...p.lines.map(l => String(l.n).length))
  const hit = p.lines.find(l => l.highlight && inRange(l.n, p.line))?.n
  const at = hit !== undefined && String(hit) !== p.line ? `${p.file}:${hit}` : `${p.file}:${p.line}`
  return [
    Text({ key: `${key}at`, wrap: 'wrap', children: [Text({ key: 'a', bold: true, children: at }), ...(at.endsWith(`:${p.line}`) ? [] : [Text({ key: 'r', dimColor: true, children: `  (cited lines ${p.line})` })])] }),
    ...p.lines.map(l => Box({ key: `${key}l${l.n}`, flexDirection: 'row', children: [
      // the gap after the gutter is the box's margin: a trailing space of a Text is lost when the line beside it wraps
      Text({ dimColor: true, children: `${String(l.n).padStart(gutter)} ${l.decoded ? '›' : '│'}` }),
      Box({ flexShrink: 1, marginLeft: 1, children: [l.highlight ? highlighted(els, l.text, [l.highlight], 't') : Text({ wrap: 'wrap', dimColor: !inRange(l.n, p.line), children: l.text || ' ' })] }),
    ] })),
  ]
}

function evidenceRows(els: Any, ev: Evidence, width: number): Any[] {
  const { Box, Code, Text } = els
  if (ev.kind === 'computed') {
    return [
      Text({ key: 'oh', bold: true, children: ev.by === 'main' ? 'Output of the code Claude ran for the reply' : 'Output of the code the check ran' }),
      Box({ key: 'out', flexDirection: 'column', children: outputRows(els, ev.output, ev.highlight) }),
      Text({ key: 'ch', bold: true, children: ' ' }),
      Text({ key: 'ch2', bold: true, children: 'The code' }),
      Code({ key: 'code', source: wrapCode(ev.code, width), language: 'python' }),
    ]
  }
  const places = [ev, ...(ev.more ?? [])]
  return [
    ...places.flatMap((p, k) => [...(k ? [Text({ key: `gap${k}`, children: ' ' })] : []), ...placeRows(els, p, `p${k}`)]),
    ...(places.some(p => p.lines.some(l => l.decoded)) ? [Text({ key: 'dec', dimColor: true, children: '› the line\'s JSON text, decoded' })] : []),
  ]
}

/** The pane of one mark. */
export async function drawEvidence($: EngineInterface, e: Any, args: unknown, els: Any): Promise<unknown> {
  const { Box, Text } = els
  const { row, n } = (args ?? {}) as { row?: string; n?: number }
  const reply = row ? await rowMarks($, row) : null
  const m: MarkItem | undefined = reply?.items.find(x => x.n === n)
  if (!m) return Text({ dimColor: true, wrap: 'wrap', children: 'This citation is no longer in the session.' })
  const unconfirmed = m.status === 'failed' && m.failedBy === 'evidence'
  const st = STATUS[unconfirmed ? 'unconfirmed' : m.status] ?? STATUS.unchecked!
  const head = Text({ key: 'head', wrap: 'wrap', children: [
    Text({ key: 's', bold: true, ...(st.color ? { color: st.color } : {}), ...(st.dim ? { dimColor: true } : {}), children: st.word }),
    Text({ key: 'w', children: `  ${m.shown.replace(/\*\*|`/g, '')}` }),
  ] })
  const rows: Any[] = [head]
  if (m.status === 'corrected' && m.was) rows.push(Text({ key: 'was', dimColor: true, wrap: 'wrap', children: `was ${m.was.replace(/\*\*|`/g, '')}` }))
  if (m.reason) rows.push(Text({ key: 'why', wrap: 'wrap', ...(m.status === 'failed' ? { color: st.color } : { dimColor: true }), children: m.reason }))
  if (m.note) rows.push(Text({ key: 'note', wrap: 'wrap', color: 'error', children: `Also false in this sentence: ${m.note}` }))
  // the sentence as the person read it, the mark's own words in bold
  const sentence = plainSentence(m.sentence)
  const at = sentence.indexOf(m.words.replace(/`/g, ''))
  rows.push(Text({ key: 'sent', dimColor: true, italic: true, wrap: 'wrap', children: at < 0 ? sentence : [
    sentence.slice(0, at), Text({ key: 'mw', bold: true, children: sentence.slice(at, at + m.words.replace(/`/g, '').length) }), sentence.slice(at + m.words.replace(/`/g, '').length),
  ] }))
  if (m.status === 'checking') rows.push(Text({ key: 'wait', dimColor: true, children: 'The check is running; its evidence shows here when it ends.' }))
  if (m.evidence) rows.push(Box({ key: 'ev', flexDirection: 'column', marginTop: 1, children: evidenceRows(els, m.evidence, Number(e?.props?.bodyColumns) || 60) }))
  return Box({ flexDirection: 'column', children: rows })
}
