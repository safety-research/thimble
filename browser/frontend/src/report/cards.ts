// The report's card sidebar, pure: the canvas's cards grouped into Starred, Orientation, Figures and Your work,
// filtered by the search, plus the cards a document already uses.
import type { Cell, Group } from '../lib/types'
import { storageKey } from '../lib/workspace'

export type CardSectionKey = 'starred' | 'orientation' | 'figures' | 'yours'
/** what a card shows, for its glyph: a figure drawn (a chart, a timeline, a diagram, a custom page), a table, or text (a
 * note, a takeaway, a shell's output) */
export type CardShape = 'bars' | 'table' | 'text'

export interface SideCard {
  id: string
  /** the question */
  title: string
  takeaway: string
  shape: CardShape
}

export interface CardSection {
  key: CardSectionKey
  name: string
  cards: SideCard[]
}

const SECTION_NAMES: Record<CardSectionKey, string> = { starred: 'Starred', orientation: 'Orientation', figures: 'Figures', yours: 'Your work' }
/** the orientation's deck is a group of role `exploration`, as is an older workspace's Final group */
const ROLE_SECTION: Record<string, CardSectionKey> = { exploration: 'orientation' }

/** The glyph of what a card shows, from the figure it draws (components/Outputs figureKind): a table, another figure,
 * else text. */
export function cardShape(figure: string | null | undefined): CardShape {
  return figure === 'table' ? 'table' : figure ? 'bars' : 'text'
}

/** The section a group's cards list under: Orientation; Figures for a writer's figure group and its subgroups; else
 * Your work. */
export function sectionOf(group: Pick<Group, 'role' | 'session' | 'parent'> | undefined, byId?: ReadonlyMap<string, Pick<Group, 'role' | 'session' | 'parent'>>): CardSectionKey {
  const seen = new Set<string>()
  let g = group
  while (g) {
    if (g.session) return 'figures'
    if (!g.parent || seen.has(g.parent)) break
    seen.add(g.parent)
    g = byId?.get(g.parent)
  }
  return ROLE_SECTION[group?.role ?? ''] ?? 'yours'
}

/** Whether a card matches the search: every word of the query in its question or its takeaway, case aside. */
export function matches(card: Pick<SideCard, 'title' | 'takeaway'>, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = `${card.title} ${card.takeaway}`.toLowerCase()
  return words.every((w) => hay.includes(w))
}

/** The sidebar's sections: Starred, then Orientation, Figures and Your work in canvas order, each card once. Cards
 * without a question are left out. With a query, only matching cards and non-empty sections. */
export function cardSections(cells: readonly Cell[], groups: readonly Group[], query = '', figureOf: (cell: Cell) => string | null = () => null): CardSection[] {
  const byId = new Map(groups.map((g) => [g.id, g]))
  const lists: Record<CardSectionKey, SideCard[]> = { starred: [], orientation: [], figures: [], yours: [] }
  for (const c of cells) {
    const title = (c.title ?? '').trim()
    if (!title) continue
    const card: SideCard = { id: c.id, title, takeaway: (c.takeaway ?? '').trim(), shape: cardShape(figureOf(c)) }
    if (!matches(card, query)) continue
    if ((c as { starred?: boolean }).starred === true) lists.starred.push(card)
    lists[sectionOf(byId.get(c.notebook), byId)].push(card)
  }
  const keys: CardSectionKey[] = ['starred', 'orientation', 'figures', 'yours']
  return keys.map((key) => ({ key, name: SECTION_NAMES[key], cards: lists[key] })).filter((s) => !query.trim() || s.cards.length > 0)
}

/** The cards a document shows as figures, by card id, from `card:<id>` (or `cell:<id>`) refs. */
export function usedCells(figureRefs: Iterable<string>): Set<string> {
  const out = new Set<string>()
  for (const ref of figureRefs) {
    const m = /^(?:card|cell):([A-Za-z0-9_-]+)/.exec(String(ref ?? '').trim())
    if (m) out.add(m[1])
  }
  return out
}

/** The drag's data type: a card dragged from the sidebar carries its id under it. */
export const CARD_MIME = 'application/x-thimble-card'

/** The browser-storage keys of the sidebar's open state and of its sections', per workspace. */
export const sideKey = (ws: string): string => storageKey(ws, 'report-side')
export const sectionsKey = (ws: string): string => storageKey(ws, 'report-side-sections')
