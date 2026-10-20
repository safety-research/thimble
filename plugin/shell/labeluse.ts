// labeluse.ts: the labels a card or an answer rests on, drawn beside it. A card whose data came through a label (its
// lineage's queries read it with use() or label_rows(), or the card is the label's own), and an answer whose citations
// rest on one, get one row under them: each label's name and its values in their colors, the colors the label's card
// and the label panel give them. A click on the name opens the label in the side panel; a click on a value opens it
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
import { valueTone } from '../panes/labels.js'
import { openLabel } from './dock'
import { currentTheme, leanEnv, rootHere } from './shell'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
export type UsedLabel = { name: string; values: string[] }

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
  const got = JSON.parse(String(r.stdout || '{}')) as { labels?: { name?: unknown; values?: unknown }[] }
  return (got.labels || []).filter(l => typeof l.name === 'string' && Array.isArray(l.values)).map(l => ({ name: String(l.name), values: (l.values as unknown[]).map(String) }))
}

/** The row under a card or an answer: `label  editor_kind  ● agent  ● person  ● unclear`, each name and value a press. */
export function labelRowEl(els: Any, used: UsedLabel[], o: { key: string; theme: 'dark' | 'light'; onOpen: (name: string, value: string | null) => unknown }): Any | null {
  if (!used.length) return null
  const { Box, Button, Text } = els
  const kids: Any[] = [Text({ key: `${o.key}-w`, dimColor: true, children: used.length === 1 ? 'label ' : 'labels ' })]
  used.forEach((l, i) => {
    if (i) kids.push(Text({ key: `${o.key}-s${i}`, dimColor: true, children: '   ' }))
    kids.push(Button({ key: `${o.key}-n${i}`, plain: true, label: `open the label ${l.name}`, onPress: () => o.onOpen(l.name, null), children: [Text({ bold: true, children: l.name })] }))
    l.values.slice(0, 8).forEach((v, j) => {
      const color = termColor(valueTone(l.values, v), o.theme)
      kids.push(Text({ key: `${o.key}-g${i}-${j}`, children: '  ' }))
      kids.push(Button({ key: `${o.key}-v${i}-${j}`, plain: true, label: `the records of ${l.name} that are ${v}`, onPress: () => o.onOpen(l.name, v), children: [Text({ ...(color ? { color } : {}), children: `● ${v}` })] }))
    })
  })
  return Box({ key: o.key, flexDirection: 'row', flexWrap: 'wrap', children: kids })
}

/** The row beside a card (its refs: [the card's id]) or an answer (its citations' refs), as shell.tsx draws it under
 *  them; null while the labels are read and when they rest on none. `root` defaults to the folder under analysis. */
export async function labelsRow($: Engine, els: Any, key: string, refs: string[], root?: string | null, o: { marginLeft?: number } = {}): Promise<Any | null> {
  const where = root ?? (await rootHere($))
  const used = await labelsBeside($, `${key}|${hash(refs.join(' '))}`, refs, where)
  const row = used ? labelRowEl(els, used, { key: `lu-${key}`, theme: currentTheme(), onOpen: (name, value) => { void openLabel($, name, value) } }) : null
  return row ? els.Box({ key: `lu-box-${key}`, marginLeft: o.marginLeft ?? 0, children: [row] }) : null
}

/** The labels a card rests on, read once per card and version (the same read as its row under the reply). */
export async function cardLabels($: Engine, id: string, v: number | null | undefined, root: string): Promise<UsedLabel[] | null> {
  return labelsBeside($, `card-${id}-${v ?? ''}|${hash(id)}`, [id], root)
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
