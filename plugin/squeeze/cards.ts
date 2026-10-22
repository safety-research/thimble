// cards.ts: the cards of an answer that a squeeze may change (the switch "Squeeze changes cards"). The chips belong to
// the whole answer: its text and the cards drawn in its turn (core/answers.ts TurnRec.cards) and under it (v's). A
// rewrite's request shows each card (chips.mjs cardsBlock): its title, columns, first rows, what it draws (draw.ts
// cardText) and its view, with the card guide its view is written by (cards/tool.ts cardGuide). The reply may
// edit a card (a new title or view, drawn as a new version in the card's place), add one (a new view over the rows of
// a card it was shown, drawn under the answer as v's cards are), or leave one out of its version (the card is not drawn
// while that version shows). Each is made through the card runner as the person's version (cards/tool.ts
// personVersion); one that does not draw is left out, and the version's problems say why.
//
// Each version keeps the cards it shows, as copies of their views and rows in the conversation's kept folder
// (squeeze/cards/<card>/<copy>/), so a version seen before and the original (0) come back with theirs: showing a
// version draws again each card whose copy on screen differs. A card someone else drew since (Claude, v) stays as they
// drew it.
//
//   state squeezeCards: {shown: {card: {copy, v}}, hidden: [card], did: {card: 'edited' | 'added'}}, kept as
//   squeeze-cards.json
import { update, type EngineInterface } from 'claude-code'

import { turnOfRow } from '../core/answers'
import { keptDir, readKept, writeKept } from '../core/env'
import { cardText } from '../cards/draw'
import { anchoredAt, cardIdOf, metaOf, versionDir } from '../cards/store'
import { cardGuide, personVersion } from '../cards/tool'
import { cardListsAt, cardNotes, cardsKnown } from './chips.mjs'
import type { Rec } from './term'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export type CardIn = { id: string; title: string; columns: string[]; sample: string; drawn: string; view: string; rows: string }
export type Answer = { orig: Record<string, { id: string; copy: string }[]>; cards: CardIn[]; guide: string }
type Shown = { shown: Record<string, { copy: string; v: number }>; hidden: string[]; did: Record<string, string> }

const STATE = { plugin: 'thimble', key: 'squeezeCards' } as const
const FILE = 'squeeze-cards.json'
/** The first rows a request shows of a card, at most this many characters. */
const SAMPLE_CHARS = 1500
const SAMPLE_ROWS = 3
/** A rows file larger than this is not read for its first rows. */
const READ_MAX = 2 * 1024 * 1024

async function stateNow($: Engine): Promise<Shown> {
  return { shown: {}, hidden: [], did: {}, ...(((await $.state.get(STATE)).value ?? {}) as Partial<Shown>) }
}
async function setState($: Engine, edit: (s: Shown) => Shown): Promise<void> {
  const next = await update($, STATE, cur => edit({ shown: {}, hidden: [], did: {}, ...((cur as Partial<Shown> | undefined) ?? {}) }))
  await writeKept($, FILE, next).catch(() => undefined)
}

/** A resumed session: the cards' versions as the squeezes left them. */
export async function restoreCardsShown($: Engine): Promise<void> {
  const kept = await readKept<Shown>($, FILE)
  if (kept && !(await $.state.get(STATE)).value) await $.state.set(STATE, kept)
}

async function copyDir($: Engine, id: string, copy: string): Promise<string> {
  return `${await keptDir($)}/squeeze/cards/${id}/${copy}`
}

/** A copy of a card's version on screen (its view and rows, and its title), under `copy`. */
async function keepCopy($: Engine, id: string, copy: string): Promise<boolean> {
  const meta = await metaOf($, id)
  if (!meta || meta.version < 1) return false
  const from = await versionDir($, id, meta.version)
  const to = await copyDir($, id, copy)
  try {
    await $.fs.write(`${to}/view.js`, String(await $.fs.read(`${from}/view.js`)))
    await $.fs.write(`${to}/meta.json`, JSON.stringify({ title: meta.title }))
    const r = await $.process.run(['cp', '--', `${from}/rows.json`, `${to}/rows.json`])
    return r.exitCode === 0
  } catch {
    return false
  }
}

async function readCopy($: Engine, id: string, copy: string): Promise<{ title: string; view: string; rows: string } | null> {
  const dir = await copyDir($, id, copy)
  try {
    const meta = JSON.parse(String(await $.fs.read(`${dir}/meta.json`))) as { title?: string }
    return { title: String(meta.title ?? ''), view: String(await $.fs.read(`${dir}/view.js`)), rows: `${dir}/rows.json` }
  } catch {
    return null
  }
}

/** The first rows of a rows file, as JSON lines, for the request. */
async function sampleOf($: Engine, path: string): Promise<string> {
  try {
    const st = await $.fs.stat(path)
    if ((st?.size ?? 0) > READ_MAX) return '(the rows file is too large to show here)'
    const data = JSON.parse(String(await $.fs.read(path)))
    const rows = Array.isArray(data) ? data : Array.isArray(data?.rows) ? data.rows : [data]
    const out = rows.slice(0, SAMPLE_ROWS).map((r: unknown) => JSON.stringify(r)).join('\n')
    return out.length > SAMPLE_CHARS ? `${out.slice(0, SAMPLE_CHARS)}…` : out
  } catch {
    return ''
  }
}

/** The cards drawn in a row's turn and under it (v's), in order. */
async function cardsOfRow($: Engine, row: string): Promise<string[]> {
  const t = await turnOfRow($, row)
  const own = t && t.answer === row ? t.cards.map(c => c.id) : []
  return [...new Set([...own, ...(await anchoredAt($, row))])]
}

/**
 * The cards of an answer as its original has them, by row (the message's own row; for a catch-up, each reply it covers),
 * each with the copy of it as first shown to a rewrite, and the card guide. Null when the answer has none: then the
 * request shows no cards.
 */
export async function answerCards($: Engine, rec: Rec): Promise<Answer | null> {
  const s = (rec.squeeze ?? {}) as Any
  const orig: Answer['orig'] = {}
  if (s.orig?.cards && typeof s.orig.cards === 'object') Object.assign(orig, s.orig.cards)
  else {
    for (const r of rec.catchup ? rec.catchup.rows : [rec.row]) {
      const ids = await cardsOfRow($, r)
      if (ids.length) orig[r] = ids.map(id => ({ id, copy: 'orig' }))
    }
  }
  const cards: CardIn[] = []
  for (const { id } of Object.values(orig).flat()) {
    let c = await readCopy($, id, 'orig')
    if (!c && (await keepCopy($, id, 'orig'))) c = await readCopy($, id, 'orig')
    const meta = await metaOf($, id)
    if (!c || !meta) continue
    cards.push({ id, title: c.title, columns: meta.columns ?? [], sample: await sampleOf($, c.rows), drawn: await cardText($, id).catch(() => ''), view: c.view, rows: c.rows })
  }
  if (!cards.length) return null
  return { orig, cards, guide: await cardGuide($) }
}

/**
 * The card changes of a reply, made as the person's: each edit drawn as a new version of its card (a new title or view
 * over its rows), each add drawn as a new card under the answer `row` (a view over the rows of a card the request
 * showed), each drop only noted. One that does not draw is left out with a problem that says why. Returns what held, in
 * order, each with the copy that version shows, and the problems.
 */
export async function applyCards($: Engine, answer: Answer, changes: Any[], row: string, levels: string): Promise<{ done: Any[]; problems: string[]; unknown: string[] }> {
  const done: Any[] = []
  const problems: string[] = []
  const unknown: string[] = []
  const now = Number(await $.clock.now())
  for (const [k, c] of changes.entries()) {
    const card = answer.cards.find(x => x.id === c.id) ?? null
    const from = c.op === 'add' ? answer.cards.find(x => x.id === c.rows) ?? null : card
    // a card the request never showed: nothing to change, and nothing the person asked for failed (the log keeps it)
    if (c.op !== 'add' && !card) { unknown.push(String(c.id).slice(0, 60)); continue }
    if (c.op === 'drop') { done.push({ op: 'drop', id: card!.id, title: card!.title }); continue }
    const what = c.op === 'edit' ? `the change to "${card!.title}"` : `the new card "${String(c.title || c.id).slice(0, 50)}"`
    if (!from) { problems.push(`${what} names rows of no card shown, so it was left out`); continue }
    const id = c.op === 'edit' ? card!.id : cardIdOf(`squeeze:${row}:${String(c.id)}:${now}:${k}`)
    const title = String(c.title || (c.op === 'edit' ? card!.title : c.id))
    const made = await personVersion($, { id, title, view: String(c.view ?? from.view), rows: from.rows, ...(c.op === 'add' ? { anchorRow: row } : {}) })
    if (made.error !== undefined) { problems.push(`${what} did not draw (${made.error.split('\n')[0]!.slice(0, 120)}), so ${c.op === 'edit' ? 'the card stays as it was' : 'it was left out'}`); continue }
    const copy = `s${now.toString(36)}${k}`
    await keepCopy($, id, copy)
    await setState($, s => ({ ...s, shown: { ...s.shown, [id]: { copy, v: made.version } } }))
    done.push({ op: c.op, id, copy, v: made.version, title, levels })
  }
  return { done, problems, unknown }
}

/**
 * The cards a record's version shows, drawn as that version has them: each card it shows at the copy it shows (drawn
 * again when the copy on screen is another one a squeeze drew), each card it does not show hidden, and the notes under
 * the cards it changed. A card someone else drew since the squeeze last did stays as they drew it. Nothing for a record
 * no rewrite ever changed a card of. Returns why a card could not be drawn again, one line each.
 */
export async function showCards($: Engine, rec: Rec): Promise<string[]> {
  const want = cardListsAt(rec) as Record<string, { id: string; copy: string }[]> | null
  if (!want) return []
  const wanted = Object.values(want).flat()
  const st = await stateNow($)
  const problems: string[] = []
  const hide: string[] = []
  const show: string[] = []
  const shown: Shown['shown'] = {}
  for (const c of cardsKnown(rec) as { id: string }[]) {
    const w = wanted.find(x => x.id === c.id)
    if (!w) { hide.push(c.id); continue }
    show.push(c.id)
    const meta = await metaOf($, c.id)
    if (!meta) continue
    const now = st.shown[c.id] ?? { copy: 'orig', v: meta.version }
    if (now.copy === w.copy) continue
    // drawn since by Claude or v: theirs stays
    if (now.v !== meta.version) continue
    const copy = await readCopy($, c.id, w.copy)
    if (!copy) { problems.push(`"${meta.title}": its copy is gone`); continue }
    const made = await personVersion($, { id: c.id, title: copy.title, view: copy.view, rows: copy.rows })
    if (made.error !== undefined) problems.push(`"${meta.title}" (${made.error.slice(0, 120)})`)
    else shown[c.id] = { copy: w.copy, v: made.version }
  }
  const notes = cardNotes(rec) as { marks: Record<string, string>; left: string[] }
  await setState($, s => {
    const did = { ...s.did }
    for (const id of [...hide, ...show]) delete did[id]
    Object.assign(did, notes.marks)
    return { shown: { ...s.shown, ...shown }, hidden: [...s.hidden.filter(id => !show.includes(id)), ...hide.filter(id => !s.hidden.includes(id))], did }
  })
  return problems
}

/** Whether a card is left out of the version shown now of the answer it belongs to. */
export async function cardHidden($: Engine, id: string): Promise<boolean> {
  return (await stateNow($)).hidden.includes(id)
}

/** What the version shown now did to a card: 'edited', 'added', or null. */
export async function cardDid($: Engine, id: string): Promise<string | null> {
  return (await stateNow($)).did[id] ?? null
}
