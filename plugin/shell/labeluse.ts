// labeluse.ts: the labels a card or an answer rests on, shown once, where they add something. A card whose data came
// through a label (its lineage's queries read it with use() or label_rows()) gets one row under it: each label's name,
// how it was made in plain words (a rule over the text, or read by Claude), and its values in their colors. A card that
// names the label's values in its own colors (a chart's legend) gets no row: its legend opens the label instead
// (cardLegend), and the label's own card gets none either. An answer gets a row only for the labels its citations rest
// on that none of its cards shows. A click on the name opens the label in the side panel; a click on a value opens it
// with its records filtered to that value.
//
//   labelsBeside($, key, refs, root)   the labels the refs rest on (`thimble label --used-by`), read once per key, after
//                                      the drawing that asked (the row draws again with them); null until then, and []
//                                      when the refs rest on none
//   labelRowEl(els, used, o)           the row
//
// The read is the person's (shell.tsx leanEnv): it never counts as what Claude read.
import type { EngineInterface } from 'claude-code'

import { termColor } from '../draw/palette.js'
import { howMade, spotsIn, toneBeside, tonesIn } from '../panes/labels.js'
import { openLabel } from './dock'
import { currentTheme, leanEnv, rootHere } from './shell'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
export type UsedLabel = { name: string; values: string[]; tones?: Record<string, string>; kind?: string; card?: string | null }

const USE = { plugin: 'thimble', key: 'labeluse' } as const
/** The keys being read now, so a drawing asks once. */
const reading = new Set<string>()

/** The labels `refs` rest on, kept under `key`: null while they are read (the drawing that asked draws again). */
export async function labelsBeside($: Engine, key: string, refs: string[], root: string | null): Promise<UsedLabel[] | null> {
  const list = [...new Set(refs.filter(r => typeof r === 'string' && r && r.length < 400))].slice(0, 60)
  if (!list.length || !root) return []
  const at = { ...USE, id: key }
  const kept = (await $.state.get(at)).value as { labels: UsedLabel[] } | null | undefined
  if (kept) return kept.labels
  if (!reading.has(key)) {
    reading.add(key)
    $.clock.after(0, () => {
      void readUsed($, list, root).then(labels => $.state.set(at, { labels })).catch(() => $.state.set(at, { labels: [] })).finally(() => reading.delete(key))
    })
  }
  return null
}

async function readUsed($: Engine, refs: string[], root: string): Promise<UsedLabel[]> {
  const dir = $.plugin.root.replace(/\/+$/, '')
  const r = await $.process.run([`${dir}/bin/thimble`, 'label', '--used-by', ...refs, '--json'], { cwd: root, env: await leanEnv($, root), timeoutMs: 30000 })
  if ((r.exitCode ?? 1) !== 0) return []
  const got = JSON.parse(String(r.stdout || '{}')) as { labels?: { name?: unknown; values?: unknown; kind?: unknown; card?: unknown }[] }
  return (got.labels || []).filter(l => typeof l.name === 'string' && Array.isArray(l.values)).map(l => ({
    name: String(l.name), values: (l.values as unknown[]).map(String),
    ...(typeof l.kind === 'string' ? { kind: l.kind } : {}), card: typeof l.card === 'string' ? l.card : null,
  }))
}

/** The row under a card or an answer: `label editor_kind · read by Claude  ● agent  ● person  ● unclear`, each name and
 *  value a press. */
export function labelRowEl(els: Any, used: UsedLabel[], o: { key: string; theme: 'dark' | 'light'; onOpen: (name: string, value: string | null) => unknown }): Any | null {
  if (!used.length) return null
  const { Box, Button, Text } = els
  const kids: Any[] = [Text({ key: `${o.key}-w`, dimColor: true, children: used.length === 1 ? 'label ' : 'labels ' })]
  used.forEach((l, i) => {
    if (i) kids.push(Text({ key: `${o.key}-s${i}`, dimColor: true, children: '   ' }))
    kids.push(Button({ key: `${o.key}-n${i}`, plain: true, label: `open the label ${l.name}`, onPress: () => o.onOpen(l.name, null), children: [Text({ bold: true, children: l.name })] }))
    if (howMade(l.kind)) kids.push(Text({ key: `${o.key}-h${i}`, dimColor: true, children: ` · ${howMade(l.kind)}` }))
    l.values.slice(0, 8).forEach((v, j) => {
      const color = termColor(toneBeside(l, v), o.theme)
      kids.push(Text({ key: `${o.key}-g${i}-${j}`, children: '  ' }))
      kids.push(Button({ key: `${o.key}-v${i}-${j}`, plain: true, label: `the records of ${l.name} that are ${v}`, onPress: () => o.onOpen(l.name, v), children: [Text({ ...(color ? { color } : {}), children: `● ${v}` })] }))
    })
  })
  return Box({ key: o.key, flexDirection: 'row', flexWrap: 'wrap', children: kids })
}

/** The row beside a card (its refs: [the card's id]) or an answer (its citations' refs), as shell.tsx draws it under
 *  them; null while the labels are read and when they rest on none. `root` defaults to the folder under analysis.
 *  Under a card (`grid`, its cells), the values take the colors the card gives them (tonesIn). */
export async function labelsRow($: Engine, els: Any, key: string, refs: string[], root?: string | null, o: { marginLeft?: number; grid?: Any; card?: string; except?: string[] } = {}): Promise<Any | null> {
  const where = root ?? (await rootHere($))
  const found = await labelsBeside($, `${key}|${hash(refs.join(' '))}`, refs, where)
  let used = found && o.grid ? withTones(found, o.grid) : found
  // under a card: not the label whose own card it is, nor one its legend names already; under an answer: not one a
  // card of the answer shows
  if (used && o.card) used = used.filter(l => l.card !== o.card && !inLegend(l))
  if (used && o.except) used = used.filter(l => !o.except!.includes(l.name))
  const row = used ? labelRowEl(els, used, { key: `lu-${key}`, theme: currentTheme(), onOpen: (name, value) => { void openLabel($, name, value) } }) : null
  return row ? els.Box({ key: `lu-box-${key}`, marginLeft: o.marginLeft ?? 0, children: [row] }) : null
}

/** The labels a card rests on, read once per card and version (the same read as its row under the reply); with the
 *  card's cells, each with the colors the card gives its values. */
export async function cardLabels($: Engine, id: string, v: number | null | undefined, root: string, grid?: Any): Promise<UsedLabel[] | null> {
  const found = await labelsBeside($, `card-${id}-${v ?? ''}|${hash(id)}`, [id], root)
  return found && grid ? withTones(found, grid) : found
}

/** Whether a card names a label's values in their own colors, as a legend does (two of them at least, or its one). */
function inLegend(l: UsedLabel): boolean {
  return Object.keys(l.tones || {}).length >= Math.min(2, l.values.length)
}

/** The labels the cards under an answer rest on (each read once per card, as cardsRow reads them), or null while one
 *  is still being read. */
export async function cardsLabels($: Engine, cards: { id: string; v?: number | null; root?: string | null }[]): Promise<string[] | null> {
  const names = new Set<string>()
  for (const c of cards) {
    const where = c.root ?? (await rootHere($))
    const key = `cards-${c.id}-${c.v ?? ''}`
    const found = await labelsBeside($, `${key}|${hash(c.id)}`, [c.id], where)
    if (!found) return null
    for (const l of found) names.add(l.name)
  }
  return [...names]
}

/** Where a card's legend names a label's values: [{name, value, kind, rect}], each a press that opens the label on
 *  that value, in place of a row under the card. The same read as the card's row (labelsRow with its key). */
export async function cardLegend($: Engine, key: string, id: string, root: string | null | undefined, grid: Any): Promise<{ name: string; value: string; kind?: string; rect: { x: number; y: number; w: number; h: number } }[]> {
  const where = root ?? (await rootHere($))
  const found = await labelsBeside($, `${key}|${hash(id)}`, [id], where)
  const out: { name: string; value: string; kind?: string; rect: { x: number; y: number; w: number; h: number } }[] = []
  for (const l of withTones(found || [], grid)) {
    if (l.card === id || !inLegend(l)) continue
    for (const [value, at] of Object.entries(spotsIn(grid, l.values) as Record<string, { y: number; x: number; w: number }>)) out.push({ name: l.name, value, ...(l.kind ? { kind: l.kind } : {}), rect: { x: at.x, y: at.y, w: at.w, h: 1 } })
  }
  return out
}

/** Each label with the tones the card's cells give its values. */
function withTones(used: UsedLabel[], grid: Any): UsedLabel[] {
  return used.map(l => ({ ...l, tones: tonesIn(grid, l.values) as Record<string, string> }))
}

/** A short hash of a text (djb2), for a state key. */
function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/** For tests: nothing being read. */
export function resetLabelUse(): void {
  reading.clear()
}
