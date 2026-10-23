// screen.ts: a text copy of what thimble shows now, for the fixer's first message: the person's "this" may be on the
// screen, not in the conversation. Three parts, each drawn by the code that draws it on screen, with plain elements
// that a few lines here turn into text:
//
//   the bar      what stands above the prompt (bar/bar.tsx barRows, core/answerview.ts aboveBar): the failure line, a
//                fix's line, the tray, the bar itself
//   the pane     the side pane, when one is open (core/pane.ts paneDrawing)
//   the card     the newest card's text copy (cards/draw.ts cardText)
//
// A part that cannot be drawn says why in its place; none holds up the fixer for long.
import type { EngineInterface } from 'claude-code'

import { barRows } from '../bar/bar'
import { cardText, screenColumns } from '../cards/draw'
import { metaOf, seenNow } from '../cards/store'
import { turnsNow } from '../core/answers'
import { aboveBar } from '../core/answerview'
import { paneDrawing } from '../core/pane'
import { cut } from '../core/text.js'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** How long one part may take before the copy goes without it. */
const PART_MS = 4000
/** The longest text of one part. */
const PART_CHARS = 4000

/** Plain elements: each keeps its kind and its props, for textOf. */
const el = (type: string) => (props: Any = {}) => ({ type, props })
export const TEXT_ELS = new Proxy({} as Record<string, (p?: Any) => Any>, { get: (_t, k) => el(String(k)) })

/** A drawing of plain elements as text: a Box's children side by side, or one under another in a column. */
export function textOf(n: Any): string {
  if (n == null || n === false || n === true) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  const p = n.props ?? {}
  if (n.type === 'Box') {
    const parts = (Array.isArray(p.children) ? p.children : [p.children]).map(textOf)
    // a row spread to both edges (the bar) keeps a gap between its parts
    return p.flexDirection === 'column' ? parts.filter(x => x !== '').join('\n') : parts.join(p.justifyContent === 'space-between' ? '   ' : '')
  }
  if (n.type === 'Button') return p.children != null ? textOf(p.children) : String(p.label ?? '')
  if (n.type === 'Markdown') return String(p.text ?? '')
  if (n.type === 'Code') return String(p.source ?? '')
  if (n.type === 'Input') return `[${String(p.value || p.placeholder || '')}]`
  if (n.type === 'Client') return '(a card is drawn here)'
  if (n.type === 'Image' || n.type === 'Raster') return '(an image)'
  return textOf(p.children)
}

/** `work`, or `instead` after PART_MS or when it throws. */
async function within<T>($: Engine, work: Promise<T>, instead: (why: string) => T): Promise<T> {
  let t: { cancel?: () => void } | null = null
  const late = new Promise<T>(done => {
    try { t = $.clock.after(PART_MS, () => done(instead('it took too long'))) as unknown as { cancel?: () => void } } catch { /* no limit */ }
  })
  try {
    return await Promise.race([work.catch(err => instead(cut(String((err as Error)?.message || err), 160))), late])
  } finally {
    (t as { cancel?: () => void } | null)?.cancel?.()
  }
}

/** The newest card that drew: the cards of main's turns and the cards drawn on screen, by when they were made. */
async function newestCard($: Engine): Promise<{ id: string; title: string } | null> {
  const ids = new Set<string>()
  for (const t of await turnsNow($).catch(() => [])) for (const c of t.cards) ids.add(c.id)
  for (const id of await seenNow($).catch(() => [] as string[])) ids.add(id)
  let best: { id: string; title: string; at: number } | null = null
  for (const id of ids) {
    const m = await metaOf($, id).catch(() => null)
    if (m && m.version > 0 && (!best || (m.at ?? 0) >= best.at)) best = { id, title: m.title, at: m.at ?? 0 }
  }
  return best
}

/** The text copy: the bar, the open pane and the newest card, each under a line that says what it is. */
export async function screenCopy($: Engine): Promise<string> {
  const width = Math.max(60, screenColumns() || 120)
  const bar = await within($, (async () => {
    const rows = [...(await aboveBar($, TEXT_ELS, width).catch(() => [])), ...(await barRows($, TEXT_ELS, width))]
    return rows.map(textOf).filter(x => x.trim()).join('\n')
  })(), why => `(the bar could not be copied: ${why})`)
  const pane = await within($, (async () => {
    const p = await paneDrawing($, TEXT_ELS)
    return p ? { kind: p.kind, text: textOf(p.drawn) } : null
  })(), why => ({ kind: '?', text: `(the pane could not be copied: ${why})` }))
  const card = await newestCard($)
  const copy = card ? await within($, cardText($, card.id), why => `(the card could not be copied: ${why})`) : ''
  return [
    `Above the prompt (${width} columns):`, '```', cut(bar || '(nothing)', PART_CHARS), '```',
    ...(pane ? ['', `The side pane, open on ${pane.kind}:`, '```', cut(pane.text || '(empty)', PART_CHARS), '```'] : ['', 'No side pane is open.']),
    ...(card ? ['', `The newest card, “${card.title}”:`, '```', cut(copy || '(empty)', PART_CHARS), '```'] : ['', 'No card is drawn.']),
  ].join('\n')
}
