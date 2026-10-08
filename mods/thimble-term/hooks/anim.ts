// A card's focus: the value a citation or a report's caption names on a card, as the item cardLayout draws for it. Pure.
import { MAX_NODES, MAX_TABLE_ROWS, barRows } from './draw'
import type { CardData, Cell, Item } from './draw'
import { fmt } from './lib'

/** A value a caption cites, by the names its card uses: a line's series and x, a bar's or a table's row (and a
 *  table's column as `series`), a timeline's event (1-based, or its record), an example's record (1-based, or its
 *  ref), a diagram's node id or edge (1-based). */
export type Focus = { series?: string; x?: string | number; row?: string | number; event?: string | number; node?: string; edge?: number }

const same = (a: unknown, b: unknown) => {
  const s = String(a)
  const t = String(b)
  return s === t || (s.trim() !== '' && t.trim() !== '' && Number(s) === Number(t)) || s.toLowerCase() === t.toLowerCase()
}
const ordinal = (v: unknown, n: number) => (v !== undefined && String(v).trim() !== '' && Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= n ? Number(v) - 1 : -1)

// ---------------------------------------------------------------------------------------- focus

/** The item of `items` (cardLayout's, for this card) that a focus names, -1 for none. */
export function focusItem(card: CardData, items: readonly Item[], f: Focus): number {
  switch (card.kind) {
    case 'line': {
      const x = f.x ?? f.row
      if (x === undefined) return -1
      let i = 0
      for (const s of (card.series ?? []).filter(s => s.points.length > 0)) {
        for (const p of s.points) {
          if ((f.series === undefined || same(s.name, f.series)) && same(p[0], x)) return i
          i++
        }
      }
      return -1
    }
    case 'bar':
    case 'label': {
      const key = f.row ?? f.x
      if (key === undefined) return -1
      // a label card is a bar card of its counts: its records are the label panel's
      return barRows(card).rows.findIndex(r => same(r.label, key))
    }
    case 'table': {
      const key = f.row ?? f.x
      const heads = card.columns ?? []
      const r = key === undefined ? -1 : ((card.rows ?? []) as Cell[][]).slice(0, MAX_TABLE_ROWS).findIndex(row => same(fmt(row[0]), key))
      if (r < 0) return -1
      const c = f.series === undefined ? 0 : Math.max(0, heads.findIndex(h => same(h, f.series)))
      return r * heads.length + c
    }
    case 'timeline': {
      const evs = (card.events ?? []).slice(0, 30)
      const key = f.event ?? f.row
      if (key === undefined) return -1
      const n = ordinal(key, evs.length)
      return n >= 0 ? n : evs.findIndex(e => (e.ref && e.ref === key) || same(e.time, key) || (e.shown !== undefined && same(e.shown, key)))
    }
    case 'example': {
      const exs = (card.examples ?? []).slice(0, 8)
      const key = f.row ?? f.event
      if (key === undefined) return -1
      const n = ordinal(key, exs.length)
      return n >= 0 ? n : exs.findIndex(e => e.ref === key)
    }
    case 'diagram': {
      if (f.node !== undefined) return (card.nodes ?? []).slice(0, MAX_NODES).findIndex(n => String(n.id) === f.node || (n.ref !== undefined && n.ref === f.node))
      if (f.edge !== undefined) return items.findIndex(it => it.open === `card:${card.id}#edge/${f.edge}`)
      return -1
    }
    default:
      return -1
  }
}

/** The focus a citation's place names on this card: a card value (card:<id>#<column>/<row>) or a record the card
 *  shows (an example's, an event's or a node's ref); undefined when it names nothing on it. */
export function focusFromRef(card: CardData, ref: string): Focus | undefined {
  const pre = `card:${card.id}#`
  const longest = (names: string[], rest: string) => names.filter(n => rest.startsWith(`${n}/`)).sort((a, b) => b.length - a.length)[0]
  if (ref.startsWith(pre)) {
    const rest = ref.slice(pre.length)
    switch (card.kind) {
      case 'diagram':
        if (rest.startsWith('node/')) return { node: rest.slice(5) }
        if (rest.startsWith('edge/')) return { edge: Number(rest.slice(5)) }
        return undefined
      case 'timeline':
        return rest.startsWith('time/') ? { event: Number(rest.slice(5)) } : undefined
      case 'line': {
        const s = longest((card.series ?? []).map(s => s.name), rest)
        return s === undefined ? undefined : { series: s, x: rest.slice(s.length + 1) }
      }
      case 'bar':
      case 'label': {
        const col = card.y || 'value'
        return rest.startsWith(`${col}/`) ? { row: rest.slice(col.length + 1) } : undefined
      }
      case 'table': {
        const h = longest(card.columns ?? [], rest)
        return h === undefined ? undefined : { series: h, row: rest.slice(h.length + 1) }
      }
      default:
        return undefined
    }
  }
  if (card.kind === 'example' && (card.examples ?? []).some(e => e.ref === ref)) return { row: ref }
  if (card.kind === 'timeline') {
    const i = (card.events ?? []).findIndex(e => e.ref === ref)
    if (i >= 0) return { event: i + 1 }
  }
  if (card.kind === 'diagram') {
    const n = (card.nodes ?? []).find(n => n.ref === ref)
    if (n) return { node: n.id }
  }
  return undefined
}
