// ui.ts: Squeeze on the screen: the simpler version that s writes, the row of choices under it, their keys at an empty
// prompt, what the bar says, the catch-up drawn below the newest message it covers, and the lines a squeeze puts under
// an answer and its cards. The seam (seam.ts) hands each to its host (core/answerview.ts).
//
// s (Simplify, the bar's `s simplify`) writes a simpler version of the newest answer (core/answers.ts latestAnswer) in
// one press: one call, drawn below the answer as a catch-up is (term.ts simplify), at Length short and Background
// learning, while the answer still shows as written. Once it is written, its last row names the choices, each with its
// key, as the bar draws a key:
//   1 shorter · 2 longer · 3 explain more · 4 assume more · 0 remove
// Each choice applies at once and rewrites the block in place (chips.mjs CHOICES: shorter and longer move Length one
// level, explain more moves Background one level toward novice, assume more one level toward expert). Every choice
// always shows, in the same place. A choice at its end draws dim, its key not in thimble's color, and its key or a
// click on it does nothing: the key is taken, so it types nothing, and no call is made. While a new version is written,
// the row stays: the choice being applied shows what it does in thimble's color (`3 explaining more…`), the other
// choices stay as they are and still act, and the old text dims; a version seen before comes back at once. 0 removes
// the block. The keys act while the block stands on the newest answer and main's turn does not run; in the fullscreen
// layout a click on a choice does the same. A catch-up has the same row.
// s on an answer that has a block already brings the block into view, with no call; the bar names s only while the
// newest answer has none.
// s while main's turn runs waits for the answer it writes and then does the same (answerDone). With two or more replies
// since the person's last prompt not yet caught up on, the bar also names `b catch up on N replies` (Catch-up): b writes
// one catch-up of them, drawn below the newest of them as one more answer, while the replies still show as written
// (term.ts catchUp), in place of a simpler version that stood there. A letter right after s, b or a choice undoes it
// (hooks/keys.ts word window): b undone puts back the simpler version or catch-up it replaced, a choice undone shows the
// version before it again, 0 undone puts the block back; a choice at its end has nothing to undo, so the letter types
// after its key. The hook of s or b returns before their writes end, since Claude Code runs the next key's hook only
// after it returns; the undo runs after those writes (startedTake). A message's own versions that s rewrote in place in
// 0.10.12 and earlier still draw in a resumed session (viewOf); s on such an answer shows its original again before it
// writes the simpler version. A block kept by an earlier release may hold chips the person typed (chips.mjs `own`):
// they still count in each rewrite of it.
//
//   state squeezeWait: {turn} | null    s pressed while main's turn ran: its answer was still being written, so s acts
//                                       on it when the turn ends (answerDone), never on the one before
import type { EngineInterface } from 'claude-code'

import type { BarItem } from '../bar/bar'
import { hintUsed } from '../bar/hints'
import { failNotice, reasonOf } from '../bar/notice'
import { quiet } from '../core/askcell.js'
import { markPressed, spansOver } from '../core/answerview'
import { latestAnswer, pickAnswer, turnOf } from '../core/answers'
import { openPane } from '../core/pane'
import { controlWords } from '../core/selection'
import { accent } from '../core/theme'
import { treeRows } from '../core/trail.mjs'
import { mainRuns, mainTurn } from '../core/turn'
import type { Take } from '../hooks/keys'
import { marksIn, withoutMarks } from '../marks/message.js'
import { looksByWords } from '../marks/register'
import { rowMarks, type MarkItem } from '../marks/store'
import { messageEl } from '../marks/view'
import { featureOn } from '../settings/features.mjs'
import { tourHolds } from '../tour/tour'
import { trayHeld } from '../tray/seam'
import { cardDid, cardHidden } from './cards'
import { CHOICES, atOf, cardNotes, catchUpStands, choiceAt, isSimplify, revealCut } from './chips.mjs'
import { blockKey, catchUp, catchUpAt, catchUpOn, cuId, drawnAt, dismissCatchUp, partNow, pileUp, recOf, running, seeView, setLevels, simpleId, simplify, slotOf, standAgain, stopLevels, uiOf, wantLevels, type Rec } from './term'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
/** The frames of the cards a text places on lines of their own (cards/draw.ts framesIn), each drawn there as at
 *  home when the card's line stood in one of `rows`. */
export type CardsIn = (text: string, rows: string[], o?: { indent?: number }) => Promise<Record<string, Any>>
type At = Record<string, number>
type Choice = (typeof CHOICES)[number]
/** s pressed while main's turn `turn` ran: s acts on its answer when it ends. */
type Wait = { turn: string }

const WAIT = { plugin: 'thimble', key: 'squeezeWait' } as const
const same = (a: unknown, b: unknown) => JSON.stringify(a || {}) === JSON.stringify(b || {})
/** The key of the row under a block besides the choices' digits. */
const REMOVE_KEY = '0'
/** The keys the row under a block takes at an empty prompt. */
export const ROW_KEYS = [...CHOICES.map(c => c.key), REMOVE_KEY]

// ------------------------------------------------------------------------------------------------ the state

/** A /clear or a /resume (seam.ts turnSqueeze): the wait goes. */
export async function turnChips($: Engine): Promise<void> {
  await writeWait($, null)
}

// The wait, as this module last wrote or read it: a key reads the copy, since Claude Code gives a key's hook a few
// milliseconds of its own time and each read of the state costs some of it under load; the bar and the turn's end read
// the state.
let waitKept: { wait: Wait | null } | null = null

async function waitNow($: Engine): Promise<Wait | null> {
  const wait = ((await $.state.get(WAIT)).value ?? null) as Wait | null
  waitKept = { wait }
  return wait
}

async function keptWait($: Engine): Promise<Wait | null> {
  return waitKept ? waitKept.wait : waitNow($)
}

async function writeWait($: Engine, wait: Wait | null): Promise<void> {
  await $.state.set(WAIT, wait)
  waitKept = { wait }
}

/** Main's turn ended: s, pressed while it ran, acts on its answer (none when it ended with none): a block standing on
 *  it comes into view, else a simpler version is written. The wait ends either way. (seam.ts, turn.complete) */
export async function answerDone($: Engine, turnId: string): Promise<void> {
  if (!(await waitNow($))) return
  await writeWait($, null)
  const row = (await turnOf($, turnId))?.answer
  if (!row || !featureOn('squeezeAnswers')) return
  const t = await restTake($, row)
  await t.now!()
}

/** The person's prompt went (seam.ts): the wait ends. */
export async function promptWent($: Engine): Promise<void> {
  if (await waitNow($)) await writeWait($, null)
}

/** The block the row's keys act on now: the simpler version or catch-up standing on the newest answer, once a version
 *  of it is written and while it shows; null while main's turn runs (its answer is the newest then). */
async function rowBlock($: Engine): Promise<Rec | null> {
  if (await mainTurn($)) return null
  const row = await latestAnswer($)
  const rec = row ? await catchUpOn($, row) : null
  return rec && typeof rec.shown === 'string' && blockOn(rec) ? rec : null
}

/** Where the chips of a record stand now: where a change on its way goes, else the levels shown. */
async function levelsNow($: Engine, rec: Rec): Promise<{ at: At; pending: boolean }> {
  const ui = await uiOf($, rec.id)
  const shown = atOf(rec) as At
  return ui.want && !same(ui.want, shown) ? { at: ui.want, pending: true } : { at: shown, pending: false }
}

// ------------------------------------------------------------------------------------------------ the choices

/** A choice on the block `rec`: its version asked for at once (from the record when it was written before, else one
 *  call after the short wait, term.ts setLevels); undone (a letter right after its key), the version before it shows
 *  again. At the choice's end, a take that does nothing: the key is taken, so it types nothing, and nothing is asked. */
async function chooseTake($: Engine, rec: Rec, c: Choice): Promise<Take> {
  const { at } = await levelsNow($, rec)
  const to = choiceAt(rec, at, c) as At | null
  if (!to) return {}
  return {
    now: async () => { await wantLevels($, rec.id, to, c.doing); void setLevels($, rec.id, to, c.key).catch(() => undefined) },
    undo: async () => { await wantLevels($, rec.id, at); void setLevels($, rec.id, at).catch(() => undefined) },
  }
}

/** 0: the block goes, and a change on its way stops; undone, it stands again as it stood. */
function removeTake($: Engine, rec: Rec): Take {
  return {
    now: async () => { await stopLevels($, rec.id).catch(() => null); await dismissNow($, rec.id) },
    undo: async () => { await standAgain($, rec) },
  }
}

// ------------------------------------------------------------------------------------------------ the simpler version

/** s at rest: a simpler version of the answer `row`, drawn below it. Returns its id. */
async function simplifyNow($: Engine, row: string): Promise<string | null> {
  const id = await simplify($, row)
  if (!id) return null
  await hintUsed($, 'rewrite')
  await $.ui.scroll({ to: { key: `ans-${row}` }, block: 'nearest' }).catch(() => undefined)
  return id
}

/**
 * A key whose writes its hook starts but does not wait for (s, b), and their undo (a letter right after the key).
 * Claude Code runs the next key's hook only after this one returns, so a hook that waited for the writes would close
 * the word window before it reads a letter typed right after the key. The undo runs after the writes, in the same chain
 * as they do: the letter's hook reads the state as it stood when that hook began, so an undo run in that hook would not
 * find writes that ended after it began. A failure of the writes shows on the failure line, as a key's failure does.
 */
function startedTake<T>($: Engine, key: string, write: () => Promise<T | null>, undo: (made: T | null) => Promise<unknown>): Take {
  let ask = () => {}
  let undone: Promise<unknown> = Promise.resolve()
  return {
    now: async () => {
      const asked = new Promise<void>(go => { ask = go })
      const made = write().catch(err => { failNotice($, `The ${key} key did not run: ${reasonOf(err, 200)}`); return null })
      undone = Promise.all([made, asked]).then(([m]) => undo(m))
    },
    undo: async () => { ask(); await undone },
  }
}

/** s: the simpler version written; undone, it goes. */
function simplifyTake($: Engine, row: string): Take {
  return startedTake($, 's', () => simplifyNow($, row), async id => { if (id) await dismissNow($, id, true) })
}

/** Whether a simpler version's first call failed: no version of it shows, none is on its way, and the call said why.
 *  Then s writes it again (its error says so). */
async function firstFailed($: Engine, rec: Rec): Promise<boolean> {
  return isSimplify(rec) && typeof rec.shown !== 'string' && !running(rec.id) && !!(await uiOf($, rec.id)).error
}

/** What s does at rest on the answer `row`: with a simpler version or a catch-up standing on it, the view goes to that
 *  block, with no call; else (or when a simpler version's first call failed) a simpler version is written. */
async function restTake($: Engine, row: string): Promise<Take> {
  const block = await catchUpOn($, row)
  if (!block || (await firstFailed($, block))) return simplifyTake($, row)
  return { now: () => $.ui.scroll({ to: { key: blockKey(block) }, block: 'nearest' }).catch(() => undefined) }
}

/** s, or a press on `s simplify`, while main's turn runs: s waits for the answer it writes (`to`; null: s again, it no
 *  longer waits); undone, the wait stands as it was. */
function waitTake($: Engine, to: Wait | null, was: Wait | null): Take {
  return {
    now: () => writeWait($, to),
    undo: () => writeWait($, was),
  }
}

/** Whether a block drawn below an answer shows: a simpler version while Simplify is on, a catch-up while Catch-up is. */
const blockOn = (rec: Rec) => featureOn(isSimplify(rec) ? 'squeezeAnswers' : 'catchUp')

// ------------------------------------------------------------------------------------------------ the catch-up

/** b with replies piled up: one catch-up of every message since the person's last prompt, under the newest of them.
 *  An earlier catch-up of some of them goes, and so does a simpler version of one of them that stands. Returns its id,
 *  and the records it replaced as they stood, which b undone puts back. */
async function catchUpWith($: Engine): Promise<{ id: string; was: Rec[] } | null> {
  const pile = await pileUp($)
  if (!pile) return null
  const host = pile.replies[pile.replies.length - 1]!
  const was: Rec[] = []
  for (const r of pile.replies) {
    for (const id of [cuId(r), simpleId(r)]) {
      const rec = await recOf($, id)
      if (!rec || (slotOf(id) === 'simple' && !catchUpStands(rec))) continue
      was.push(rec)
      await dismissCatchUp($, id, { quiet: true })
    }
  }
  const id = await catchUp($, { host, rows: pile.rows, replies: pile.n, question: pile.prompt?.text ?? '', prompt: pile.prompt?.row ?? null })
  if (!id) return null
  await pickAnswer($, null)
  const cu = await recOf($, id)
  await $.ui.scroll({ to: { key: `ans-${cu ? drawnAt(cu) : host}` }, block: 'nearest' }).catch(() => undefined)
  return { id, was }
}

/** b, or a press on `b catch up on N replies`: the catch-up written (catchUpWith). Returns its id. */
export async function catchUpNow($: Engine): Promise<string | null> {
  return (await catchUpWith($))?.id ?? null
}

/** b: the catch-up written; undone, it goes, and the simpler version or catch-up it replaced stands again. */
function catchUpTake($: Engine): Take {
  return startedTake($, CATCH_UP_KEY, () => catchUpWith($), async cu => {
    if (!cu) return
    await dismissNow($, cu.id, true)
    for (const rec of cu.was) await standAgain($, rec)
  })
}

/** The key that writes a catch-up, named on the bar while replies piled up (squeeze/seam.ts SQUEEZE_KEYS). */
export const CATCH_UP_KEY = 'b'

/** A simpler version or catch-up dismissed (0, or undone): the row's words go with it. */
export async function dismissNow($: Engine, id: string, undo = false): Promise<void> {
  await dismissCatchUp($, id, { undo })
  controlWords('squeeze', [])
}

// ------------------------------------------------------------------------------------------------ keys

/** A key at an empty prompt: s at rest writes a simpler version of the newest answer, or brings the block standing on
 *  it into view; b writes a catch-up; 1–4 and 0 act on the block standing on the newest answer (its row). */
export async function squeezeKeyTake($: Engine, key: string): Promise<Take | null> {
  if (key === CATCH_UP_KEY) return (await pileUp($)) ? catchUpTake($) : null
  if (ROW_KEYS.includes(key)) return rowKeyTake($, key)
  if (key !== 's' || !featureOn('squeezeAnswers')) return null
  // main's turn runs: its answer is still being written, so s waits for it (answerDone), never the answer before it
  const turn = await mainTurn($)
  if (turn) {
    const was = await keptWait($)
    return waitTake($, was ? null : { turn }, was)
  }
  const row = await latestAnswer($)
  if (!row) return null
  return restTake($, row)
}

/** A key of the row under the block on the newest answer: a choice (one at its end does nothing), 0 remove. Null when
 *  no block's row shows there: the key types as usual. */
async function rowKeyTake($: Engine, key: string): Promise<Take | null> {
  const rec = await rowBlock($)
  if (!rec) return null
  if (key === REMOVE_KEY) return removeTake($, rec)
  const c = CHOICES.find(x => x.key === key)
  return c ? chooseTake($, rec, c) : null
}

// ------------------------------------------------------------------------------------------------ the bar

/** What the bar says: `s simplify` while the newest answer has no block standing on it (the block's row names its own keys), and `b catch
 *  up on N replies` while replies piled up since the person's last prompt. While main's turn runs, s waits for the
 *  answer it writes: while it waits, `s simplify` is lit (its words in thimble's color), and a press ends the wait, as
 *  s again does. */
export async function barItems($: Engine, on: (key: string) => boolean, preview: boolean): Promise<BarItem[]> {
  const squeezing = on('squeezeAnswers')
  if (preview) return [...(squeezing ? [{ id: 'squeeze', key: 's', words: 'simplify' }] : []), ...(on('catchUp') ? [{ id: 'catchup', key: CATCH_UP_KEY, words: 'catch up' }] : [])]
  const row = await latestAnswer($)
  // while main's turn runs, s waits for the answer it writes, lit while it waits
  const turn = squeezing ? await mainTurn($) : ''
  if (!row && !turn) return []
  const pile = row ? await pileUp($, on) : null
  const wait = turn ? await waitNow($) : null
  const block = !turn && row ? await catchUpOn($, row) : null
  const named = !block || !blockOn(block) || (await firstFailed($, block))
  const s: BarItem | null = turn
    ? { id: 'squeeze', key: 's', words: 'simplify', ...(wait ? { color: accent() } : {}), press: () => waitTake($, wait ? null : { turn }, wait).now!() }
    : named ? { id: 'squeeze', key: 's', words: 'simplify', press: async () => (await restTake($, row!)).now!() } : null
  return [
    ...(squeezing && s ? [s] : []),
    ...(pile ? [{ id: 'catchup', key: CATCH_UP_KEY, words: `catch up on ${pile.n} replies`, press: () => catchUpNow($) }] : []),
  ]
}

// ------------------------------------------------------------------------------------------------ the drawing

/** The text a row shows in place of what Claude wrote: its version (the part written in so far, dim while a rewrite
 *  runs). The replies a catch-up covers show as written, since the catch-up stands below them (underRow). */
export async function viewOf($: Engine, row: string): Promise<{ text?: string | null; hidden?: boolean; dim?: boolean } | null> {
  if (!featureOn('squeezeAnswers')) return null
  const part = await partNow($, row)
  // the old text dims from the moment a change is asked (its call waits a moment for more keys, then runs)
  const rec = await recOf($, row)
  const ui = await uiOf($, row)
  const busy = !!ui.running || (!!rec && (await levelsNow($, rec)).pending)
  if (!part.own || !rec) return busy ? { dim: true } : null
  const text = typeof rec.shown === 'string' ? (ui.reveal ? revealCut(rec.shown, ui.reveal.n) : rec.shown) : null
  if (text == null && !busy) return null
  return { text, dim: busy }
}

/** The lines at the end of the block on the newest answer: why its last rewrite failed or what it said that the
 *  original does not, then its row of choices, each its key and words as the bar draws a key, and a click that does
 *  what the key does; a key the open tray holds now shows no key (the tray takes it). Every choice always shows, in the
 *  same place: one at its end draws dim, its key not in thimble's color, and a click on it does nothing. While a
 *  version is on its way, the choice that asked for it says what it does (`3 explaining more…`) in thimble's color. */
async function rowEl($: Engine, els: Any, rec: Rec, w: number): Promise<Any> {
  const { Box, Text, Button } = els
  const ui = await uiOf($, rec.id)
  const { at, pending } = await levelsNow($, rec)
  const busy = pending || !!ui.running
  const lines: Any[] = []
  if (ui.error) lines.push(Text({ key: 'err', color: 'error', wrap: 'wrap', children: `× ${ui.error}` }))
  else if ((rec.squeeze?.problems ?? [])[0] && !busy) lines.push(Text({ key: 'problem', color: accent(), wrap: 'wrap', children: `! ${rec.squeeze.problems[0]}` }))
  const words: string[] = []
  const held = new Set(await trayHeld($, ROW_KEYS).catch(() => [] as string[]))
  // `look`: 'doing' (its version is on its way, all in thimble's color), 'end' (dim, no press) or 'on'
  const item = (id: string, k: string, said: string, look: 'on' | 'doing' | 'end', press: () => Promise<unknown>) => {
    words.push(`${k} ${said}`, said)
    const kids = [
      ...(held.has(k) ? [] : [Text({ key: 'k', ...(look === 'end' ? { dimColor: true } : { color: accent(), bold: true }), children: `${k} ` })]),
      Text({ key: 'w', ...(look === 'doing' ? { color: accent() } : { dimColor: true }), children: said }),
    ]
    if (look === 'end') return Box({ key: id, flexDirection: 'row', children: kids })
    return Button({ key: id, plain: true, label: `${k} ${said}`, hover: quiet(`sq-${rec.id}-${id}`), onPress: () => { void press().catch(() => undefined) }, children: kids })
  }
  const parts: Any[] = []
  for (const c of CHOICES) {
    const press = async () => (await chooseTake($, rec, c)).now?.()
    if (busy && ui.doing === c.doing) parts.push(item(`c${c.key}`, c.key, `${c.doing}…`, 'doing', press))
    else parts.push(item(`c${c.key}`, c.key, c.words, choiceAt(rec, at, c) ? 'on' : 'end', press))
  }
  parts.push(item('remove', REMOVE_KEY, 'remove', 'on', () => removeTake($, rec).now!()))
  lines.push(Box({ key: 'choices', flexDirection: 'row', flexWrap: 'wrap', children: parts.flatMap((p, i) => [
    ...(i ? [Text({ key: `sep${i}`, dimColor: true, children: ' · ' })] : []),
    p,
  ]) }))
  // the row's words are thimble's own controls: a click on them selects no answer's words (core/selection.ts)
  controlWords('squeeze', words, { inRow: true })
  // the rule runs down beside them, through the blank row above them, as beside the block's text
  const body = Box({ flexDirection: 'column', flexShrink: 1, width: w, paddingTop: 1, children: lines })
  const n = Math.max(2, treeRows(body, w))
  return Box({ key: `sq-row-${rec.id}`, flexDirection: 'row', children: [
    Box({ width: 4, flexShrink: 0, children: [Text({ color: accent(), children: Array.from({ length: n }, () => '▎').join('\n') })] }),
    body,
  ] })
}

/** The catch-up drawn below the newest message it covers (term.ts drawnAt), or the simpler version below its answer,
 *  after that message and its cards, once a version of it is written: a rule down its left side beside its head line
 *  (`catch-up of the N replies above`, `simpler version of the answer above`), its text (its first characters while a
 *  version writes itself in, dim while one is written) and, on the newest answer, its row of choices (rowEl). Its
 *  citations look as the checked citations of the replies they stand for (marks/register.ts looksByWords: the same
 *  words, else the same claim in new words), and a press on one acts as a press on that citation in its reply. The
 *  replies' citations are numbered across the catch-up, since each reply numbers its own from 1: so citations of two
 *  replies never share a hover group, and a press finds the reply's citation it stands for. The replies' explainers
 *  and heads-ups stand on its words where it says their terms (core/answerview.ts spansOver), and a card it places on
 *  a line of its own draws there, moved down from its reply (cards.ts placeCatchUpCards). */
async function catchUpEl($: Engine, els: Any, row: string, cols: number, cardsIn?: CardsIn): Promise<Any | null> {
  const cu = await catchUpAt($, row)
  if (!cu || typeof cu.shown !== 'string' || !blockOn(cu)) return null
  seeView(cols)
  const ui = await uiOf($, cu.id)
  const busy = !!ui.running || (await levelsNow($, cu)).pending
  const cut = ui.reveal ? revealCut(cu.shown, ui.reveal.n) : cu.shown
  // the simpler version of the tour's sample answer draws its citations as plain words until the tour's cite step
  // starts, as the answer does (tour/tour.ts tourHolds)
  let held = false
  for (const r of cu.catchup?.rows ?? []) held = held || (await tourHolds($, r))
  const text = held ? withoutMarks(cut) : cut
  const items: MarkItem[] = []
  const from: { row: string; n: number }[] = []
  for (const r of held ? [] : cu.catchup?.rows ?? []) {
    for (const it of (await rowMarks($, r))?.items ?? []) {
      from.push({ row: it.row, n: it.n })
      items.push({ ...it, n: from.length })
    }
  }
  const marks = marksIn(text)
  const looks = looksByWords(marks, items, await mainRuns($))
  const replies = Number(cu.catchup?.replies) || 0
  const w = Math.max(20, cols - 2)
  // a card it places on a line of its own draws there (its reply points down to it)
  // its cards fit beside the rule, whose column and padding take 2 columns more than an answer's text
  const cards = cardsIn ? await cardsIn(text, [cu.id], { indent: 2 }).catch(() => ({})) : {}
  const spans = await spansOver($, cu.catchup?.rows ?? [], text, marks)
  const body = messageEl(els, {
    text, marks, looks, key: `cu-${row}`, cols: w, first: false, spin: '⠋', dim: busy, cards, spans, rule: accent(),
    onMark: async (k: number) => {
      const it = from[(looks[k]?.n ?? 0) - 1]
      if (!it) return
      if (await markPressed($, it.row, it.n)) return
      await openPane($, 'evidence', { row: it.row, n: it.n }, `citation ${it.n}`)
    },
  })
  // the rule down its left side: one ▎ per row, beside its head line and in each row of its text (view.ts messageEl
  // `rule`), counted from what the catch-up draws at this width; nothing is placed absolutely, so it ends where the
  // catch-up ends, whatever width it is drawn at
  const head = els.Box({ key: 'cu-head', flexDirection: 'row', children: [
    els.Box({ width: 2, flexShrink: 0, children: [els.Text({ color: accent(), children: '▎' })] }),
    els.Text({ children: [els.Text({ color: accent(), bold: true, children: 'thimble' }), els.Text({ dimColor: true, children: isSimplify(cu) ? '  simpler version of the answer above' : `  catch-up of the ${replies} ${replies === 1 ? 'reply' : 'replies'} above` })] }),
  ] })
  // its row of choices, while it stands on the newest answer, where the keys act
  const newest = (await rowBlock($))?.id === cu.id
  const choices = newest ? await rowEl($, els, cu, w) : null
  return els.Box({ key: `cu-${row}`, flexDirection: 'column', marginTop: 1, children: [head, body, ...(choices ? [choices] : [])] })
}

/** What stands under a row after its cards: the simpler version or catch-up drawn below it, or why its first version
 *  failed, and what a squeeze left out of its cards. */
export async function underRow($: Engine, els: Any, row: string, cols: number, cardsIn?: CardsIn): Promise<Any[]> {
  const squeezing = featureOn('squeezeAnswers')
  if (!squeezing && !featureOn('catchUp')) return []
  const out: Any[] = []
  const drawn = await catchUpEl($, els, row, cols, cardsIn)
  if (drawn) out.push(drawn)
  const part = await partNow($, row)
  const recs: Rec[] = []
  if (squeezing && part.own) { const r = await recOf($, row); if (r) recs.push(r) }
  const drawnHere = await catchUpAt($, row)
  const cu = drawnHere && blockOn(drawnHere) ? drawnHere : null
  if (cu) recs.push(cu)
  if (cu && typeof cu.shown !== 'string') {
    const ui = await uiOf($, cu.id)
    if (ui.error) out.push(els.Text({ key: `cu-note-${row}`, color: 'error', wrap: 'wrap', children: `× ${ui.error}` }))
  }
  const left = recs.flatMap(r => (cardNotes(r) as { left: string[] }).left)
  if (left.length) out.push(els.Box({ key: `lo-${row}`, marginLeft: 2, marginTop: 1, children: [els.Text({ dimColor: true, wrap: 'truncate-end', children: `left out by thimble: ${left.map(t => `"${t.length > 48 ? `${t.slice(0, 47)}…` : t}"`).join(', ')}` })] }))
  return out
}

/** The line under a card a squeeze changed: `edited by thimble` or `added by thimble`. */
export async function underCardLine($: Engine, els: Any, id: string): Promise<Any[]> {
  if (!featureOn('squeezeAnswers')) return []
  const did = await cardDid($, id)
  return did ? [els.Text({ key: `sq-did-${id}`, dimColor: true, children: `  ${did} by thimble` })] : []
}

/** Whether a card is left out of the version of its answer shown now. */
export async function hidesCard($: Engine, id: string): Promise<boolean> {
  return featureOn('squeezeAnswers') && cardHidden($, id)
}
