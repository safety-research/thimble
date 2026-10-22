// The board's card filter, set in the controls' menu (Controls.tsx) or by a chat's set_filter: by kind, group, maker,
// check state, starred, locked, and by words (each must start a word of the card's question or takeaway). Within a part
// any choice keeps a card; across parts a card must pass each. It combines with the label filter. The server keeps the
// whole canvas filter so every tab and the chat see the same one, and backend filters.py reads it as this file does.
// Pure.
import type { CardFilterParts } from '../lib/types'

export interface CardFilter {
  kinds: string[]
  groups: string[]
  makers: string[]
  /** check states (lib/cardCheck.ts CheckFilterState) */
  checks: string[]
  starred: boolean
  locked: boolean
  text: string
}

export const NO_FILTER: CardFilter = { kinds: [], groups: [], makers: [], checks: [], starred: false, locked: false, text: '' }

/** What the filter reads of a card. */
export interface FilterCard {
  id: string
  kind: string
  /** its frame; null for a card on the board outside every frame */
  group: string | null
  maker: string
  /** its check state (lib/cardCheck.ts checkState) */
  check: string
  starred: boolean
  locked: boolean
  /** its question and takeaway as the text part searches them (searchText) */
  text: string
}

/** The parts of the filter, each on its own: what the band's chips name and what each keeps. */
export type FilterPart = 'kinds' | 'groups' | 'makers' | 'checks' | 'starred' | 'locked' | 'text'
export const PARTS: FilterPart[] = ['kinds', 'groups', 'makers', 'checks', 'starred', 'locked', 'text']

export const partOn = (f: CardFilter, part: FilterPart): boolean =>
  part === 'starred' || part === 'locked' ? f[part] : part === 'text' ? f.text.trim().length > 0 : f[part].length > 0
export const filterOn = (f: CardFilter): boolean => PARTS.some((p) => partOn(f, p))
export const activeParts = (f: CardFilter): FilterPart[] => PARTS.filter((p) => partOn(f, p))

/** The words the text part searches, lowercased: a card's question and takeaway, each citation read as its label
 * (`[[31|card:x#a/b]]` as 31) or as nothing (`[[card:x]]`). */
export function searchText(...texts: (string | null | undefined)[]): string {
  const joined = texts.map((t) => t ?? '').join(' ')
  return joined
    .replace(/\[\[([^\]|]*)\|[^\]]*\]\]/g, '$1')
    .replace(/\[\[[^\]]*\]\]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

const words = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean)

/** Whether each word of `query` starts a word of a card's search text, ignoring case: `merge` finds merged, not submerged. */
export function textMatches(text: string, query: string): boolean {
  const have = words(text)
  return words(query).every((q) => have.some((w) => w.startsWith(q)))
}

/** Whether a card passes one part of the filter (an unset part passes every card). */
export function passes(c: FilterCard, f: CardFilter, part: FilterPart): boolean {
  switch (part) {
    case 'kinds':
      return !f.kinds.length || f.kinds.includes(c.kind)
    case 'groups':
      return !f.groups.length || (c.group != null && f.groups.includes(c.group))
    case 'makers':
      return !f.makers.length || f.makers.includes(c.maker)
    case 'checks':
      return !f.checks.length || f.checks.includes(c.check)
    case 'starred':
      return !f.starred || c.starred
    case 'locked':
      return !f.locked || c.locked
    case 'text':
      return !f.text.trim() || textMatches(c.text, f.text)
  }
}

/** The cards the filter keeps (every set part passed), or null while no part is set. `only` keeps by that part alone. */
export function keptBy(cards: readonly FilterCard[], f: CardFilter, only?: FilterPart): Set<string> | null {
  const parts = only ? [only] : activeParts(f)
  if (!parts.length || (only && !partOn(f, only))) return null
  return new Set(cards.filter((c) => parts.every((p) => passes(c, f, p))).map((c) => c.id))
}

/** Two keep sets as one: a card either leaves out is left out; null (no filter) keeps every card. */
export function bothKeep(a: ReadonlySet<string> | null, b: ReadonlySet<string> | null): Set<string> | null {
  if (!a) return b ? new Set(b) : null
  if (!b) return new Set(a)
  return new Set([...a].filter((id) => b.has(id)))
}

/** The choices the menu lists for a part, each with how many cards have it, most first, then by name. */
export function choices(cards: readonly FilterCard[], part: 'kinds' | 'groups' | 'makers' | 'checks'): { value: string; count: number }[] {
  const n = new Map<string, number>()
  for (const c of cards) {
    const v = part === 'kinds' ? c.kind : part === 'groups' ? c.group : part === 'checks' ? c.check : c.maker
    if (v) n.set(v, (n.get(v) ?? 0) + 1)
  }
  return [...n].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
}

/** `list` with `value` added, or taken out when it is there. */
export const toggled = (list: readonly string[], value: string): string[] => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value])

/** The card filter the server's canvas filter holds, whatever it holds: what does not fit is left unset. */
export function readFilter(raw: unknown): CardFilter {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : [])
  return {
    kinds: strings(o.kinds),
    groups: strings(o.groups),
    makers: strings(o.makers),
    checks: strings(o.checks),
    starred: o.starred === true,
    locked: o.locked === true,
    text: typeof o.text === 'string' ? o.text : '',
  }
}

/** The card parts as the server takes them, every part named, the text's spaces collapsed as the server keeps them
 * (PUT /ws/{c}/filters/canvas/cards). */
export const cardParts = (f: CardFilter): Required<CardFilterParts> => ({
  kinds: f.kinds,
  groups: f.groups,
  makers: f.makers,
  checks: f.checks,
  starred: f.starred,
  locked: f.locked,
  text: f.text.split(/\s+/).filter(Boolean).join(' '),
})

/** Whether two card filters keep the same cards, so the one shown (with the space just typed) can stay. */
export const sameFilter = (a: CardFilter, b: CardFilter): boolean => JSON.stringify(cardParts(a)) === JSON.stringify(cardParts(b))

/** The filter to show: `next`, unless it keeps the same cards as `cur`, which then stays as it is. */
export const keepShown = (cur: CardFilter, next: CardFilter): CardFilter => (sameFilter(cur, next) ? cur : next)
