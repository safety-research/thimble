// ui.ts: Squeeze on the screen: the chips under an answer, their keys at an empty prompt and in the chips, what the bar
// says, the catch-up drawn last, under the newest message it covers, and the lines a squeeze puts under an answer and its cards. The
// seam (seam.ts) hands each to its host (core/answerview.ts).
//
// The chips open under the whole answer the keys act on (core/answers.ts actingRow), after its cards: s opens them, and
// with two or more replies since the person's last prompt not yet caught up on, s writes one catch-up of them instead,
// drawn under the newest of them while they draw no text (term.ts catchUp), with the chips open on it. A letter right after s undoes it (hooks/keys.ts word window).
// While the chips are open their keys come first (core/answerview.ts restoredKey):
//   [ ] shorter / longer on the picked chip (Length: short · as written · longer · much longer); < > , . the same, unnamed
//   1–N pick a chip · 0 the original (on a catch-up: the replies again) · s done · + a chip in the person's own words
//   (typed as `/squeeze <words>`, with the earlier ones offered as it is typed)
// A click on the chips hands them the keyboard (their Client, chips.tsx): then tab and shift+tab move between the chips,
// ← and → between the levels, ↵ is done, and + types the chip's words in the chips, until esc gives the keys back.
//
//   state squeezeOpen: {id, focus, edge, typing, held, hint} | null   the record the chips are open on (term.ts ids)
//   state squeezeOwn: [words]                                          the chips the person typed this session
import { update, type EngineInterface } from 'claude-code'

import type { BarItem } from '../bar/bar'
import { markPressed } from '../core/answerview'
import { actingRow, pickAnswer, pickedRow } from '../core/answers'
import { openPane } from '../core/pane'
import { mainRuns } from '../core/turn'
import type { Take } from '../hooks/keys'
import { marksIn } from '../marks/message.js'
import { looksByWords } from '../marks/register'
import { rowMarks, type MarkItem } from '../marks/store'
import { messageEl } from '../marks/view'
import { featureOn } from '../settings/features.mjs'
import { cardDid, cardHidden } from './cards'
import { atOf, cardNotes, chipsOf, isOriginal, levelWords, ownWords, revealCut, rowsOf, setWords, stepAt, withOwn } from './chips.mjs'
import { catchUp, catchUpAt, catchUpOn, cuId, drawnAt, dismissCatchUp, partNow, pileUp, recOf, saveRec, seeView, setLevels, uiOf, wantLevels, type Rec } from './term'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type At = Record<string, number>
type Open = { id: string; focus: string; edge: string | null; typing: string | null; held: boolean; hint: boolean }

const OPEN = { plugin: 'thimble', key: 'squeezeOpen' } as const
const OWN = { plugin: 'thimble', key: 'squeezeOwn' } as const
/** What [ and ] do to each chip, in its words: the way down, then the way up. */
const WAYS: Record<string, string> = { length: 'shorter / longer', interpret: 'facts / interpretation', familiarity: 'newer / more expert' }
/** thimble's color, as the rule down a catch-up's side and its name in its head line. */
const RULE = 'permission'
/** The color of a key the bar names, lit (as bar.tsx's keys). */
const LIT = 'suggestion'

const same = (a: unknown, b: unknown) => JSON.stringify(a || {}) === JSON.stringify(b || {})

// ------------------------------------------------------------------------------------------------ the chips' state

export async function openNow($: Engine): Promise<Open | null> {
  return ((await $.state.get(OPEN)).value ?? null) as Open | null
}
async function setOpen($: Engine, change: Partial<Open> | null): Promise<void> {
  if (change === null) { await $.state.set(OPEN, null); return }
  await update($, OPEN, cur => (cur ? { ...cur, ...change } : null))
}

/** The record the keys act on: the catch-up standing on the answer the keys act on, else that answer. */
export async function targetNow($: Engine): Promise<string | null> {
  const row = await actingRow($)
  if (!row) return null
  return (await catchUpOn($, row)) ? cuId(row) : row
}

/** The chips open on a record, its first chip picked; scrolled into view. */
export async function openChips($: Engine, id: string, focus = 'length'): Promise<void> {
  await $.state.set(OPEN, { id, focus, edge: null, typing: null, held: false, hint: false })
  await $.ui.scroll({ to: { key: `sq-${id}` }, block: 'nearest' }).catch(() => undefined)
}

export async function closeChips($: Engine): Promise<void> {
  if (await openNow($)) await setOpen($, null)
}

/** Where the chips of a record stand now: where a change on its way goes, else the levels shown. */
async function levelsNow($: Engine, rec: Rec): Promise<{ at: At; pending: boolean }> {
  const ui = await uiOf($, rec.id)
  const shown = atOf(rec) as At
  return ui.want && !same(ui.want, shown) ? { at: ui.want, pending: true } : { at: shown, pending: false }
}

/** The chips in the order drawn: the fixed ones, then the person's own. */
function rowOf(rec: Rec, at: At): Any[] {
  const chips = chipsOf({ ...rec, squeeze: { ...rec.squeeze, at } })
  return [...chips.filter((c: Any) => c.kind !== 'own'), ...chips.filter((c: Any) => c.kind === 'own')]
}

/** A level that would bring a catch-up to its original: it never stands there (0 shows the replies again). */
const toOriginal = (rec: Rec, to: At) => !!rec.catchup && isOriginal(chipsOf({ ...rec, squeeze: { ...rec.squeeze, at: to } }))

/** One chip moved a step: the rewrite asked for, or the edge said when it goes no further. On a catch-up a step that
 *  would land on the original goes on past it. */
async function step($: Engine, open: Open, cid: string, dir: number, key: string | null): Promise<void> {
  const rec = await recOf($, open.id)
  if (!rec) return
  const { at } = await levelsNow($, rec)
  const probe = (a: At) => ({ ...rec, squeeze: { ...rec.squeeze, at: a } })
  let to = stepAt(probe(at), cid, dir) as At | null
  if (to && toOriginal(rec, to)) to = stepAt(probe(to), cid, dir) as At | null
  if (!to) { await setOpen($, { focus: cid, edge: cid }); return }
  await setOpen($, { focus: cid, edge: null })
  await wantLevels($, open.id, to)
  void setLevels($, open.id, to, key).catch(() => undefined)
}

/** 0: the original again; on a catch-up, the replies it stands in for. */
async function revert($: Engine, open: Open): Promise<void> {
  const rec = await recOf($, open.id)
  if (!rec) return
  if (rec.catchup) { await dismissNow($, open.id); return }
  const { at, pending } = await levelsNow($, rec)
  if (isOriginal(chipsOf({ ...rec, squeeze: { ...rec.squeeze, at } })) && typeof rec.shown !== 'string' && !pending) return
  await setOpen($, { edge: null })
  await wantLevels($, open.id, {})
  void setLevels($, open.id, {}).catch(() => undefined)
}

/** A level of a chip set by a press on its dot. */
async function setLevel($: Engine, open: Open, cid: string, lv: number): Promise<void> {
  const rec = await recOf($, open.id)
  if (!rec) return
  const { at } = await levelsNow($, rec)
  const c = rowOf(rec, at).find((x: Any) => x.id === cid)
  await setOpen($, { focus: cid, edge: null, typing: null })
  if (!c || lv === c.level || toOriginal(rec, { ...at, [cid]: lv })) return
  const to = { ...at, [cid]: lv }
  await wantLevels($, open.id, to)
  void setLevels($, open.id, to).catch(() => undefined)
}

/** A press on the picked chip steps it up, and from its last level back to its first; on another chip, picks it. */
async function pressChip($: Engine, open: Open, cid: string): Promise<void> {
  const rec = await recOf($, open.id)
  if (!rec) return
  if (cid !== open.focus) { await setOpen($, { focus: cid, edge: null, typing: null }); return }
  const { at } = await levelsNow($, rec)
  const to = (stepAt({ ...rec, squeeze: { ...rec.squeeze, at } }, cid, 1) as At | null) ?? { ...at, [cid]: 0 }
  await setOpen($, { edge: null, typing: null })
  if (toOriginal(rec, to)) return
  await wantLevels($, open.id, to)
  void setLevels($, open.id, to).catch(() => undefined)
}

/** A chip of the person's own on a record, from the words they typed after + (or `/squeeze <words>`): added at as
 *  written, picked, and kept for the session so + offers it again. */
export async function addOwn($: Engine, id: string, typed: string): Promise<string | null> {
  const rec = await recOf($, id)
  const made = rec ? withOwn(rec, typed) : null
  if (!rec || !made) return null
  await saveRec($, { ...rec, squeeze: made.squeeze })
  const words = ownWords(typed)
  await update($, OWN, cur => [...((cur as string[] | undefined) ?? []).filter(d => d.toLowerCase() !== words.toLowerCase()), words].slice(-8))
  if ((await openNow($))?.id === id) await setOpen($, { focus: made.id, typing: null, edge: null })
  else await openChips($, id, made.id)
  return made.id
}

/** The chips the person typed earlier this session, newest last. */
export async function ownEarlier($: Engine): Promise<string[]> {
  return ((await $.state.get(OWN)).value ?? []) as string[]
}

/** + with the prompt holding the keys: the prompt takes the words, as `/squeeze <words>`, and the bar says so. */
async function askOwn($: Engine): Promise<void> {
  await $.prompt.fill({ text: '/squeeze ', mode: 'replace' }).catch(() => undefined)
  await setOpen($, { hint: true })
}

// ------------------------------------------------------------------------------------------------ the catch-up

/** s with replies piled up: one catch-up of every message since the person's last prompt, under the newest of them,
 *  with the chips open on it while its first version is written. An earlier catch-up of some of them goes. Returns its id. */
export async function catchUpNow($: Engine): Promise<string | null> {
  const pile = await pileUp($)
  if (!pile) return null
  const host = pile.replies[pile.replies.length - 1]!
  for (const r of pile.replies) if ((await partNow($, r)).cu) await dismissCatchUp($, cuId(r), { quiet: true })
  const id = await catchUp($, { host, rows: pile.rows, replies: pile.n, question: pile.prompt?.text ?? '', prompt: pile.prompt?.row ?? null })
  if (!id) return null
  await pickAnswer($, null)
  await openChips($, id)
  const cu = await recOf($, id)
  await $.ui.scroll({ to: { key: `ans-${cu ? drawnAt(cu) : host}` }, block: 'nearest' }).catch(() => undefined)
  return id
}

/** A catch-up dismissed (its chips' 0, or undone): the chips close, and the keys go back to the newest reply. */
export async function dismissNow($: Engine, id: string, undo = false): Promise<void> {
  await dismissCatchUp($, id, { undo })
  if ((await openNow($))?.id === id) await setOpen($, null)
}

// ------------------------------------------------------------------------------------------------ keys

/** Whether the chips are open: their keys come before the tray's and the label ask's, as in 0.10. */
export async function chipsHold($: Engine): Promise<boolean> {
  return featureOn('squeeze') && !!(await openNow($))
}

/** A key at an empty prompt: the chips' keys while they are open; s at rest (the chips, or a catch-up). */
export async function squeezeKeyTake($: Engine, key: string): Promise<Take | null> {
  if (!featureOn('squeeze')) return null
  const open = await openNow($)
  if (open) {
    if (open.held || open.hint) await setOpen($, { held: false, hint: false })
    const rec = await recOf($, open.id)
    if (!rec) { await setOpen($, null); return null }
    const dir = '[<,'.includes(key) ? -1 : ']>.'.includes(key) ? 1 : 0
    if (dir) return { now: () => step($, open, open.focus, dir, key === '[' || key === ']' ? key : null) }
    if (/^[1-9]$/.test(key)) {
      const c = rowOf(rec, (await levelsNow($, rec)).at)[Number(key) - 1]
      return c ? { now: () => setOpen($, { focus: c.id, edge: null }) } : null
    }
    if (key === '0') return { now: () => revert($, open) }
    if (key === '+') return { now: () => askOwn($) }
    if (key === 's') return { now: () => setOpen($, null), undo: () => $.state.set(OPEN, open) }
    return null
  }
  if (key !== 's') return null
  const row = await actingRow($)
  if (!row) return null
  if (!(await pickedRow($)) && (await pileUp($))) {
    let made: string | null = null
    return { now: async () => { made = await catchUpNow($) }, undo: async () => { if (made) await dismissNow($, made, true) } }
  }
  const id = (await catchUpOn($, row)) ? cuId(row) : row
  return { now: () => openChips($, id), undo: () => setOpen($, null) }
}

/** What a key in the chips does, once a click gave them the keyboard: tab and shift+tab move between the chips, ← and
 *  → between the levels, ↵ is done; + types a chip's words, ↵ adds it, tab lets it go. The prompt's keys work too. */
async function heldKey($: Engine, open: Open, key: string, shift: boolean): Promise<void> {
  const rec = await recOf($, open.id)
  if (!rec) return
  await setOpen($, { held: true, hint: false })
  if (open.typing != null) {
    const typing = open.typing
    if (key === 'return' || key === 'enter') { await setOpen($, { typing: null }); if (ownWords(typing)) await addOwn($, open.id, typing); return }
    if (key === 'tab') { await setOpen($, { typing: null }); return }
    if (key === 'backspace' || key === 'delete') { await setOpen($, { typing: typing.slice(0, -1) }); return }
    if (key === 'space') { await setOpen($, { typing: `${typing} ` }); return }
    if ([...key].length === 1 && typing.length < 40) await setOpen($, { typing: typing + key })
    return
  }
  const row = rowOf(rec, (await levelsNow($, rec)).at)
  const at0 = Math.max(0, row.findIndex((c: Any) => c.id === open.focus))
  if (key === 'tab') { await setOpen($, { focus: row[(at0 + (shift ? -1 : 1) + row.length) % row.length].id, edge: null }); return }
  if (key === 'left' || key === 'right') { await step($, open, open.focus, key === 'left' ? -1 : 1, null); return }
  if (key === 'return' || key === 'enter') { await setOpen($, null); return }
  if (key === '+') { await setOpen($, { typing: '', edge: null }); return }
  const t = await squeezeKeyTake($, key)
  if (t?.now) await t.now()
}

/** What the chips' Client posted: presses and keys, each handled once, in order. Answers the Client's next props. */
const handled = new Map<string, number>()
export async function chipsPost($: Engine, id: string, data: Any): Promise<Any> {
  if (!data || typeof data !== 'object' || !Array.isArray(data.events)) return {}
  const client = String(data.client ?? '')
  const from = `${id}:${client}`
  let last = handled.get(from) ?? 0
  for (const ev of data.events) {
    const n = Number(ev?.n)
    if (!Number.isInteger(n) || n <= last) continue
    last = n
    handled.set(from, n)
    const open = await openNow($)
    if (!open || open.id !== id) continue
    if (typeof ev.key === 'string') { await heldKey($, open, ev.key, !!ev.shift); continue }
    const r = String(ev.press ?? '')
    if (r === 'add') { await setOpen($, { typing: '', held: true, edge: null }); continue }
    const dot = /^lvl-(.+)-(\d+)$/.exec(r)
    if (dot) { await setLevel($, open, dot[1]!, Number(dot[2])); continue }
    const cid = r.replace(/^(chip|word)-/, '')
    if (cid !== r) await pressChip($, open, cid)
  }
  return { props: { ...(await chipsProps($, id, 0)), ack: { [client]: last } } }
}

// ------------------------------------------------------------------------------------------------ the bar

/** The chips' keys and lines on the bar while they are open; at rest, s: `s squeeze`, lit with the levels set while
 *  the answer shows a version of the person's (`s ● short · interpret`), or `s catch up` while replies piled up. */
export async function barItems($: Engine, on: (key: string) => boolean, preview: boolean): Promise<BarItem[]> {
  if (!on('squeeze')) return []
  if (preview) return [{ id: 'squeeze', key: 's', words: 'squeeze' }]
  const open = await openNow($)
  const rec = open ? await recOf($, open.id) : null
  if (open && rec) return openItems($, open, rec)
  const row = await actingRow($)
  if (!row) return []
  const id = (await catchUpOn($, row)) ? cuId(row) : row
  const pile = !(await pickedRow($)) ? await pileUp($, on) : null
  if (pile) return [{ id: 'squeeze', key: 's', words: 'catch up', color: LIT, bold: true, press: () => catchUpNow($) }]
  const now = await recOf($, id)
  const lit = now && !now.catchup && typeof now.shown === 'string'
  return [{ id: 'squeeze', key: 's', words: lit ? `● ${setWords(now) || 'squeezed'}` : 'squeeze', ...(lit ? { color: LIT } : {}), press: () => openChips($, id) }]
}

async function openItems($: Engine, open: Open, rec: Rec): Promise<BarItem[]> {
  const ui = await uiOf($, open.id)
  const { at, pending } = await levelsNow($, rec)
  const row = rowOf(rec, at)
  const focus = row.find((c: Any) => c.id === open.focus) ?? row[0]
  const orig = isOriginal(chipsOf({ ...rec, squeeze: { ...rec.squeeze, at } })) && typeof rec.shown !== 'string'
  const ways = WAYS[focus.id] || (String(focus.id).startsWith('x-') ? 'less / more' : 'change')
  const out: BarItem[] = []
  const say = (id: string, words: string, color?: string) => out.push({ id, words, focus: true, ...(color ? { color } : {}) })
  const key = (id: string, k: string, words: string, press?: () => unknown) => out.push({ id, key: k, words, focus: true, ...(press ? { press } : {}) })
  if (open.typing != null) { say('sq-typing', `+ ${open.typing}▏ ↵ adds it · tab lets it go`, 'warning'); return out }
  if (open.hint) {
    const dims = await ownEarlier($)
    say('sq-hint', `type what to squeeze for, such as "for my manager", then ↵${dims.length ? `; earlier: ${dims.slice(-3).reverse().join(' · ')}` : ''}`, 'warning')
    return out
  }
  if (ui.error) say('sq-error', `× ${ui.error}`, 'error')
  else if (open.edge && focus) say('sq-edge', `${focus.name} goes no further than ${focus.levels[focus.level]}`, 'warning')
  else if ((rec.squeeze?.problems ?? [])[0] && typeof rec.shown === 'string') say('sq-problem', `! ${rec.squeeze.problems[0]}`, 'warning')
  const revertable = !!rec.catchup || !orig || pending
  if (open.held) {
    key('sq-tab', 'tab', 'next chip')
    key('sq-lr', '← →', ways, () => step($, open, focus.id, 1, null))
    key('sq-done', '↵', 'done', () => setOpen($, null))
    if (revertable) key('sq-revert', '0', 'revert', () => revert($, open))
    key('sq-own', '+', 'your own', () => setOpen($, { typing: '', edge: null }))
    key('sq-esc', 'esc', 'back to the prompt')
    return out
  }
  key('sq-step', '[ ]', ways, () => step($, open, focus.id, 1, ']'))
  key('sq-pick', row.length > 1 ? `1–${Math.min(9, row.length)}` : '1', 'chip')
  if (revertable) key('sq-revert', '0', 'revert', () => revert($, open))
  key('sq-done', 's', 'done', () => setOpen($, null))
  key('sq-own', '+', 'your own', () => askOwn($))
  return out
}

// ------------------------------------------------------------------------------------------------ the drawing

/** The chips' props: each chip with its digit, its levels and where it stands, the picked one, what is typed after +. */
async function chipsProps($: Engine, id: string, width: number): Promise<Any> {
  const open = await openNow($)
  const rec = await recOf($, id)
  if (!open || !rec) return { items: [], plus: null, width }
  const row = rowOf(rec, (await levelsNow($, rec)).at)
  const focus = row.some((c: Any) => c.id === open.focus) ? open.focus : row[0].id
  return {
    items: row.map((c: Any, i: number) => ({ id: c.id, n: i + 1, name: c.name, levels: c.levels, level: c.level, word: levelWords(c), picked: c.id === focus && open.typing == null })),
    plus: open.typing, width,
  }
}

/** The chips under the record `id`, when they are open on it: their Client, keyed so a click keeps the keyboard in
 *  them while the answer above draws again. */
async function chipsEl($: Engine, els: Any, id: string, cols: number): Promise<Any | null> {
  const open = await openNow($)
  if (!open || open.id !== id) return null
  const w = Math.max(30, cols - 2)
  return els.Box({ key: `sq-${id}`, marginLeft: 2, marginTop: 1, children: [els.Client({ key: `sqchips-${id}`, module: './chips.tsx', width: w, props: await chipsProps($, id, w) })] })
}

/** The text a row shows in place of what Claude wrote: its version (the part written in so far, dim while a rewrite
 *  runs); nothing while a catch-up that covers it shows, unless the catch-up draws at this row (catchUpEl); dim at the
 *  row a catch-up draws at while its first version is being written. */
export async function viewOf($: Engine, row: string): Promise<{ text?: string | null; hidden?: boolean; dim?: boolean } | null> {
  if (!featureOn('squeeze')) return null
  const part = await partNow($, row)
  // the catch-up this row keeps, else the one that covers it (a row may keep one dismissed before)
  const cu = (part.cu ? await catchUpOn($, row) : null) ?? (part.inCatchUp ? await catchUpOn($, part.inCatchUp) : null)
  if (cu && cu.catchup?.rows.includes(row)) {
    const at = drawnAt(cu) === row
    if (typeof cu.shown === 'string') return at ? { dim: true } : { hidden: true }
    if (at) return { dim: true }
  }
  if (!part.own) {
    const ui = await uiOf($, row)
    return ui.running ? { dim: true } : null
  }
  const rec = await recOf($, row)
  if (!rec) return null
  const ui = await uiOf($, row)
  const text = typeof rec.shown === 'string' ? (ui.reveal ? revealCut(rec.shown, ui.reveal.n) : rec.shown) : null
  if (text == null && !ui.running) return null
  return { text, dim: !!ui.running }
}

/** The catch-up drawn at the newest message it covers (term.ts drawnAt), in place of that message's words, once a
 *  version of it is written, and as it stands at every level of its chips: a rule down its left side beside its
 *  head line and its text (its first characters while a version writes itself in, dim while one is written). Its
 *  citations look as the checked citations of the replies with the same words, and open their evidence. */
export async function catchUpEl($: Engine, els: Any, row: string, cols: number): Promise<Any | null> {
  if (!featureOn('squeeze')) return null
  const cu = await catchUpAt($, row)
  if (!cu || typeof cu.shown !== 'string') return null
  seeView(cols)
  const ui = await uiOf($, cu.id)
  const text = ui.reveal ? revealCut(cu.shown, ui.reveal.n) : cu.shown
  const items: MarkItem[] = []
  for (const r of cu.catchup?.rows ?? []) items.push(...((await rowMarks($, r))?.items ?? []))
  const marks = marksIn(text)
  const looks = looksByWords(marks, items, await mainRuns($))
  const replies = Number(cu.catchup?.replies) || 0
  const w = Math.max(20, cols - 2)
  const body = messageEl(els, {
    text, marks, looks, key: `cu-${row}`, cols: w, first: false, spin: '⠋', dim: !!ui.running,
    onMark: async (k: number) => {
      const it = items.find(x => x.n === looks[k]?.n && x.words.replace(/\s+/g, ' ').trim().toLowerCase() === marks[k]!.words.replace(/\s+/g, ' ').trim().toLowerCase())
      if (!it) return
      if (await markPressed($, it.row, it.n)) return
      await openPane($, 'evidence', { row: it.row, n: it.n }, `citation ${it.n}`)
    },
  })
  const head = els.Text({ key: 'cu-head', children: [els.Text({ color: RULE, bold: true, children: 'thimble' }), els.Text({ dimColor: true, children: `  catch-up of the ${replies} ${replies === 1 ? 'reply' : 'replies'} since your last message` })] })
  // the rule: as tall as the text is likely to be, cut at the catch-up's own height
  const tall = rowsOf(text, w) + 4
  const rule = els.Box({ key: 'cu-rule', position: 'absolute', top: 0, bottom: 0, left: 0, width: 2, overflow: 'hidden', flexDirection: 'column', children: [els.Text({ color: RULE, children: Array.from({ length: tall }, () => '▎').join('\n') })] })
  return els.Box({ key: `cu-${row}`, flexDirection: 'column', marginTop: 1, children: [
    els.Box({ key: 'cu-ruled', flexDirection: 'column', paddingLeft: 2, children: [rule, head, body] }),
  ] })
}

/** What stands under a row after its cards: why a catch-up drawn at it failed, what a squeeze left out of its cards,
 *  and the chips while they are open on it or on the catch-up drawn at it (under the whole answer, last). */
export async function underRow($: Engine, els: Any, row: string, cols: number): Promise<Any[]> {
  if (!featureOn('squeeze')) return []
  const out: Any[] = []
  const part = await partNow($, row)
  const recs: Rec[] = []
  if (part.own) { const r = await recOf($, row); if (r) recs.push(r) }
  const cu = await catchUpAt($, row)
  if (cu) recs.push(cu)
  if (cu && typeof cu.shown !== 'string') {
    const ui = await uiOf($, cu.id)
    if (ui.error) out.push(els.Text({ key: `cu-note-${row}`, color: 'error', wrap: 'wrap', children: `× ${ui.error}` }))
  }
  const left = recs.flatMap(r => (cardNotes(r) as { left: string[] }).left)
  if (left.length) out.push(els.Box({ key: `lo-${row}`, marginLeft: 2, marginTop: 1, children: [els.Text({ dimColor: true, wrap: 'truncate-end', children: `left out by squeeze: ${left.map(t => `"${t.length > 48 ? `${t.slice(0, 47)}…` : t}"`).join(', ')}` })] }))
  for (const id of [row, ...(cu ? [cu.id] : [])]) {
    const chips = await chipsEl($, els, id, cols)
    if (chips) out.push(chips)
  }
  return out
}

/** The line under a card a squeeze changed: `edited by squeeze` or `added by squeeze`. */
export async function underCardLine($: Engine, els: Any, id: string): Promise<Any[]> {
  if (!featureOn('squeeze')) return []
  const did = await cardDid($, id)
  return did ? [els.Text({ key: `sq-did-${id}`, dimColor: true, children: `  ${did} by squeeze` })] : []
}

/** Whether a card is left out of the version of its answer shown now. */
export async function hidesCard($: Engine, id: string): Promise<boolean> {
  return featureOn('squeeze') && cardHidden($, id)
}
