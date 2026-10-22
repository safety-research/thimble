// tray.ts: the cite and explain tray, one small panel above the prompt (0.10: shell.tsx openMark, stepMark, stepEnds,
// trayBand, trayFileLink, trayScope, the tray branch of emptyPromptKey; panes/tray.js; shell/cards.js explainerCard).
//
// It shows one mark at a time, the top of a stack (tray.mjs): a citation with its check and its evidence, or an
// explainer (what a term is, where it mattered here) or an important detail (a heads-up). ] and [ at an empty prompt
// step through the answers' citations, explainers, heads-ups and the cards under them, in reading order, and open the
// tray on the one reached; a press on a citation or an explainer opens it too. The marked words draw in focus (the
// answer view asks trayFocus). While it is open its keys are in the bar, after the busy step:
//
//   a ask       a side thread about the mark (threads/seam.ts openThread); 1 too, unnamed
//   c code      a citation computed by code: its whole code and whole output in place of the one line, and back
//   h explain   the explainer (or heads-up) on the citation's words, over it
//   e expand    an explainer written again at more length, in its place (explain/seam.ts expandExplainer)
//   2–9         a citation inside an explainer's words, over it (a click on it too), unnamed
//   0 close     back to the mark under it, or close
//   ] [         the next mark or card, and the one before
//
// A card ] reaches takes the keys (cards/store.ts setFocus); `a` asks about it and 0 gives the keys back. A question
// typed with the tray open is about the mark: its scope reaches Claude with the prompt (core/tell.ts), the person's
// prompt shows `▸ about …` under it, and the tray closes. What the person opens reaches main through core/engaged.ts.
//
//   state: tray ({stack} or null), trayCard (the card ] reached: {row, card}), trayAsked (by turn: what its prompt was
//          about)
import type { EngineInterface, Register } from 'claude-code'

import type { BarItem } from '../bar/bar'
import { failNotice, noticeLine } from '../bar/notice'
import type { MarkRef, Span } from '../core/answerview'
import { actingRow, messageOf, partOf, pickAnswer, textRows, turnOfRow, turnsNow } from '../core/answers'
import { tellOpened } from '../core/engaged'
import { startDir } from '../core/env'
import { openPane } from '../core/pane'
import { tellAtNextPrompt } from '../core/tell'
import { anchoredAt, metaOf, setFocus } from '../cards/store'
import { explainSpans, expandExplainer, type ExplainPart, type Gloss } from '../explain/seam'
import { highlighted, outputRows, wrapCode } from '../marks/evidence'
import { marksIn, withoutMarks } from '../marks/message.js'
import { looksByWords } from '../marks/register'
import { rowMarks, type MarkItem } from '../marks/store'
import { messageEl } from '../marks/view'
import { featureOn } from '../settings/features.mjs'
import { squeezeBar, squeezeView } from '../squeeze/seam'
import { openThread, threadAsked } from '../threads/seam'
import {
  aboutOf, back, base, cutTitle, drawsHyperlinks, evidenceLine, explainerText, fileHref, firstSentence, indexOf, lineWindow,
  open, push, refOf, sameRef, scopeText, stepFrom, stepWords, stopWhat, stopsOfRow, top,
} from './tray.mjs'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export type Frame = MarkRef & { open?: 'code' | null }
export type Tray = { stack: Frame[] } | null
type Stop = { row: string; kind?: 'citation' | 'explain' | 'heads'; n?: number; id?: string; at?: number; card?: string }
type Stand = { row: string; card: string } | null

const TRAY = { plugin: 'thimble', key: 'tray' } as const
const STAND = { plugin: 'thimble', key: 'trayCard' } as const
const ASKED = { plugin: 'thimble', key: 'trayAsked' } as const

/** The colors of the tray's frame by what it shows, the ones its words are drawn in (explain/place.mjs markColors): a
 *  citation's purple, an explainer's teal and a heads-up's orange, theme keys that follow the person's theme. */
const TONES = { citation: 'merged', explain: 'planMode', heads: 'claude' } as const

// the question the person typed with the tray open, until main's turn for it starts (then kept by its turn)
let pendingAbout: string | null = null

const quietly = (p: Promise<unknown> | unknown) => Promise.resolve(p).catch(() => undefined)

// ------------------------------------------------------------------------------------------------ state

export async function trayNow($: Engine): Promise<Tray> {
  const t = (await $.state.get(TRAY)).value as Tray | undefined
  return t && Array.isArray(t.stack) && t.stack.length ? t : null
}

async function standNow($: Engine): Promise<Stand> {
  return ((await $.state.get(STAND)).value ?? null) as Stand
}

/** The tray as it stands now: what a question asked with it open carries for Claude follows its top (core/tell.ts),
 *  and nothing once it closed. */
async function setTray($: Engine, tray: Tray): Promise<void> {
  const next = tray && tray.stack.length ? tray : null
  await $.state.set(TRAY, next as never)
  if (next) await $.state.set(STAND, null as never)
  const f = top(next) as Frame | null
  await tellAtNextPrompt($, 'tray', f ? scopeText(f, await infoOf($, f)) : '')
}

export async function closeTray($: Engine): Promise<void> {
  await setTray($, null)
}

// ------------------------------------------------------------------------------------------------ marks of a row

/** The text a row shows now (a squeezed version in its place), and its citations; null when it draws nothing. */
async function shownOf($: Engine, row: string): Promise<{ text: string; marks: { start: number; end: number; words: string }[]; own: boolean } | null> {
  const raw = (await messageOf($, row))?.text ?? ''
  if (!raw) return null
  let v: Any = null
  try { v = await squeezeView($, row, raw) } catch { v = null }
  if (v?.hidden) return null
  const shown = typeof v?.text === 'string' ? v.text : raw
  const marksOn = featureOn('marks')
  const text = marksOn ? shown : withoutMarks(shown)
  return { text, marks: marksOn ? marksIn(text) : [], own: text === raw }
}

/** The row's citations as it shows them: each with its number in the reply (0: one the check does not know). */
async function citesOf($: Engine, row: string, shown: { text: string; marks: { start: number; end: number; words: string }[]; own: boolean }): Promise<{ n: number; start: number; end: number; words: string }[]> {
  const items = (await rowMarks($, row))?.items ?? []
  const looks = shown.own ? shown.marks.map((_m, k) => ({ n: items[k]?.n ?? 0 })) : looksByWords(shown.marks, items, false)
  return shown.marks.map((m, k) => ({ ...m, n: looks[k]?.n ?? 0 }))
}

/** The explainers and heads-ups on the row's words (explain/seam.ts), each with its kind. */
async function spansOf($: Engine, row: string, shown: { text: string; marks: { start: number; end: number; words: string }[] }): Promise<(Span & { kind: 'explain' | 'heads' })[]> {
  let spans: Span[] = []
  try { spans = (await explainSpans($, row, shown.text, shown.marks)) ?? [] } catch { spans = [] }
  const part = await partOf<ExplainPart>($, row, 'explain')
  return (Array.isArray(spans) ? spans : [])
    .filter(s => s && typeof s.id === 'string' && s.end > s.start)
    .map(s => ({ ...s, kind: part?.items?.[s.id]?.kind === 'heads' ? 'heads' as const : 'explain' as const }))
}

/** One row's stops: its marks in reading order, then the cards drawn under it. */
async function rowStops($: Engine, row: string): Promise<Stop[]> {
  const shown = await shownOf($, row)
  if (!shown) return []
  const cards: string[] = []
  for (const id of await anchoredAt($, row)) {
    const m = await metaOf($, id)
    if (m && m.version > 0 && m.anchorRow === row) cards.push(id)
  }
  return stopsOfRow(row, await citesOf($, row, shown), await spansOf($, row, shown), cards) as Stop[]
}

/** What ] and [ move through, in reading order: each of Claude's text rows' marks, then the cards under it. */
async function allStops($: Engine): Promise<Stop[]> {
  const out: Stop[] = []
  for (const row of await textRows($)) out.push(...(await rowStops($, row)))
  return out
}

/** Where ] and [ stand now: the tray's first mark, else the card ] reached (-1: neither). */
async function stepPlace($: Engine): Promise<{ list: Stop[]; at: number }> {
  const list = await allStops($)
  const b = base(await trayNow($)) as Frame | null
  const stand = b ? null : await standNow($)
  return { list, at: indexOf(list, b ?? stand) }
}

/** Whether ] and [ go anywhere from where they stand, and what each goes to. */
export async function stepEnds($: Engine): Promise<{ next: boolean; prev: boolean; nextWhat?: string; prevWhat?: string }> {
  const { list, at } = await stepPlace($)
  if (at < 0) return { next: true, prev: true }
  const next = stepFrom(list, at, 1)
  const prev = stepFrom(list, at, -1)
  return { next: !!next, prev: !!prev, ...(next ? { nextWhat: stopWhat(next) } : {}), ...(prev ? { prevWhat: stopWhat(prev) } : {}) }
}

// ------------------------------------------------------------------------------------------------ what a mark is

type Info = { begins: string; words?: string; status?: string; evidence?: MarkItem['evidence']; item?: MarkItem; gloss?: Gloss }

async function itemOf($: Engine, row: string, n: number): Promise<MarkItem | null> {
  return (await rowMarks($, row))?.items.find(x => x.n === n) ?? null
}

async function glossOf($: Engine, row: string, id: string): Promise<Gloss | null> {
  return (await partOf<ExplainPart>($, row, 'explain'))?.items?.[id] ?? null
}

/** What the tray, the scope and the side thread read of a frame. */
async function infoOf($: Engine, f: Frame): Promise<Info> {
  const begins = (await shownOf($, f.row))?.text ?? (await messageOf($, f.row))?.text ?? ''
  if (f.kind === 'citation') {
    const item = await itemOf($, f.row, f.n)
    return { begins: withoutMarks(begins), words: item?.shown ?? item?.words ?? '', status: item?.status, evidence: item?.evidence, ...(item ? { item } : {}) }
  }
  return { begins: withoutMarks(begins), gloss: (await glossOf($, f.row, f.id)) ?? undefined }
}

/** The mark as core/engaged.ts tells it. */
function engagedMark(f: Frame, info: Info): Any {
  if (f.kind === 'citation') return { kind: 'citation', row: f.row, n: f.n, words: info.words ?? '', status: info.status }
  const g = info.gloss
  return f.kind === 'heads' ? { kind: 'heads', row: f.row, term: g?.term ?? '', title: g?.title ?? '' } : { kind: 'explain', row: f.row, term: g?.term ?? '' }
}

/** The person opened a mark: main hears it with their next prompt. */
async function told($: Engine, f: Frame): Promise<void> {
  const info = await infoOf($, f)
  await tellOpened($, engagedMark(f, info), info.begins).catch(() => undefined)
}

/** The explainer or heads-up on a citation's words, if any: a press on those words opens the citation, so its tray
 *  offers the explainer (h). */
async function innerOf($: Engine, f: Frame): Promise<Frame | null> {
  if (f.kind !== 'citation') return null
  const shown = await shownOf($, f.row)
  if (!shown) return null
  const c = (await citesOf($, f.row, shown)).find(x => x.n === f.n)
  if (!c) return null
  const s = (await spansOf($, f.row, shown)).find(x => x.start >= c.start + 1 && x.end <= c.start + 1 + c.words.length)
  return s ? { row: f.row, kind: s.kind, id: s.id } : null
}

/** The citations inside an explainer's words, each the reply's citation with the same words (marks/register.ts
 *  looksByWords): the frames they open, by their order in the words (0: none). */
async function linksOf($: Engine, f: Frame, text: string): Promise<{ marks: { start: number; end: number; words: string }[]; looks: Any[] }> {
  const marks = marksIn(text)
  const items = (await rowMarks($, f.row))?.items ?? []
  return { marks, looks: looksByWords(marks, items, false) }
}

// ------------------------------------------------------------------------------------------------ what the person does

/** Bring a mark into view where the chat draws it (a key may open one in a reply above the screen). */
async function reveal($: Engine, at: { row: string; card?: string }): Promise<void> {
  await quietly($.ui.scroll(at.card ? { to: { key: `frame-${at.card}` }, block: 'nearest' } : { to: { requestId: at.row }, block: 'nearest' }))
}

/** Open the tray on a mark (a press on it, ] and [): its answer becomes the one the keys act on. */
export async function openMark($: Engine, f: Frame, o: { reveal?: boolean } = {}): Promise<void> {
  await setTray($, open(f) as Tray)
  const t = await turnOfRow($, f.row)
  if (t?.answer) await pickAnswer($, t.answer)
  await told($, f)
  if (o.reveal) await reveal($, f)
}

/** A mark over the one the tray shows (a citation inside an explainer, the explainer on a citation's words). */
async function pushMark($: Engine, f: Frame): Promise<void> {
  await setTray($, push(await trayNow($), f) as Tray)
  await told($, f)
}

/** 0: the code back to the output, then the mark under this one, then closed. */
async function goBack($: Engine): Promise<void> {
  const tray = await trayNow($)
  const f = top(tray) as Frame | null
  if (!tray || !f) return
  if (f.open) { await setTray($, { stack: [...tray.stack.slice(0, -1), { ...f, open: null }] }); return }
  await setTray($, back(tray) as Tray)
}

/** c on a citation computed by code: its whole code and output in place of the one line of evidence, and back. */
async function toggleCode($: Engine): Promise<void> {
  const tray = await trayNow($)
  const f = top(tray) as Frame | null
  if (!tray || !f) return
  await $.state.set(TRAY, { stack: [...tray.stack.slice(0, -1), { ...f, open: f.open === 'code' ? null : 'code' }] } as never)
}

/** A card ] reached takes the keys, its own first, and shows framed in focus. */
async function standOn($: Engine, row: string, card: string): Promise<void> {
  await setTray($, null)
  await setFocus($, card)
  await $.state.set(STAND, { row, card } as never)
  const t = await turnOfRow($, row)
  if (t?.answer) await pickAnswer($, t.answer)
  await reveal($, { row, card })
}

/** ] and [: the next mark or card in reading order, and the one before. From rest, the answer the keys act on: ] its
 *  first, [ its last (else the newest answer's). At the newest reply's last stop, ] stays. */
export async function stepMark($: Engine, dir: number): Promise<void> {
  const { list, at } = await stepPlace($)
  let next: Stop | null = null
  if (at >= 0) { next = stepFrom(list, at, dir) as Stop | null; if (!next) return }
  else {
    const row = await actingRow($)
    const turn = row ? await turnOfRow($, row) : null
    const here = list.filter(p => (turn ? turn.rows.includes(p.row) : p.row === row))
    const pool = here.length ? here : list.filter(p => p.row === list[list.length - 1]?.row)
    next = (dir > 0 ? pool[0] : pool[pool.length - 1]) ?? null
  }
  if (!next) { noticeLine($, "Nothing to step to yet: each citation, explainer and card in Claude's replies opens here.", 'tray'); return }
  if (next.card) await standOn($, next.row, next.card)
  else await openMark($, refOf(next) as Frame, { reveal: true })
}

/** a: a side thread about the mark the tray shows; the tray gives way to it when it opened. */
async function askAbout($: Engine, f: Frame): Promise<void> {
  const info = await infoOf($, f)
  const placed = await openThread($, { about: aboutOf(f, info), mark: refOf(f) as MarkRef })
  if (placed) await setTray($, null)
}

/** a on the card ] reached: a side thread about it. */
async function askCard($: Engine, stand: NonNullable<Stand>): Promise<void> {
  const meta = await metaOf($, stand.card)
  await openThread($, { about: `the card "${meta?.title ?? stand.card}"`, card: stand.card })
}

/** e on an explainer: written again at more length, in its place; the tray shows the longer one when it lands. */
async function expand($: Engine, f: Frame): Promise<void> {
  const why = await expandExplainer($, refOf(f) as MarkRef)
  if (typeof why === 'string' && why) failNotice($, `The longer explainer was not written: ${why}. Press e in the tray to try again.`, 'tray:expand')
}

// ------------------------------------------------------------------------------------------------ the keys

/** Whether the squeeze chips hold the keys now (their items show as the bar's focus): [ and ] are theirs then. */
async function chipsOpen($: Engine): Promise<boolean> {
  try { return ((await squeezeBar($, featureOn, false)) ?? []).some(x => x?.focus) } catch { return false }
}

/** The tray's keys at an empty prompt (hooks/keys.ts takes them as a Take): ] and [ always (but while the squeeze chips
 *  are open at rest), its own while it is open, a's and 0 on a card ] reached. */
export async function trayKey($: Engine, key: string): Promise<Any | null> {
  const tray = await trayNow($)
  const stand = tray ? null : await standNow($)
  if (key === ']' || key === '[') {
    if (!tray && !stand && (await chipsOpen($))) return null
    return { now: () => stepMark($, key === ']' ? 1 : -1) }
  }
  if (stand) {
    if (key === 'a') return { later: () => askCard($, stand) }
    if (key === '0') return { now: () => $.state.set(STAND, null as never) }
    return null
  }
  const f = top(tray) as Frame | null
  if (!f) return null
  if (key === '0') return { now: () => goBack($) }
  if (key === 'a') return { later: () => askAbout($, f) }
  if (key === '1') return { now: () => askAbout($, f) }
  if (f.kind === 'citation') {
    const ev = (await itemOf($, f.row, f.n))?.evidence
    if (key === 'c' && ev?.kind === 'computed') return { now: () => toggleCode($), undo: () => toggleCode($) }
    if (key === 'h') {
      const inner = await innerOf($, f)
      if (inner) return { later: () => pushMark($, inner) }
    }
    return null
  }
  const g = await glossOf($, f.row, f.id)
  if (key === 'e' && f.kind === 'explain' && g && !g.expanded) return { later: () => expand($, f) }
  if (/^[2-9]$/.test(key) && g) {
    const { looks } = await linksOf($, f, explainerText(g))
    const links = looks.filter((l: Any) => l.n > 0).slice(0, 8)
    const l = links[Number(key) - 2]
    if (l) return { now: () => pushMark($, { row: f.row, kind: 'citation', n: l.n }) }
  }
  return null
}

// ------------------------------------------------------------------------------------------------ the bar

/** The tray's items at the bar's left: while it is open (or a card ] reached holds the keys), its keys, as `focus`
 *  items, so the bar names only those; at rest none. */
export async function trayBar($: Engine, _on: (key: string) => boolean, preview: boolean): Promise<BarItem[]> {
  if (preview) return []
  const tray = await trayNow($)
  const stand = tray ? null : await standNow($)
  const steps = (): Promise<BarItem[]> => stepEnds($).then(ends => stepWords(ends).map((s: Any) => ({ id: `tray-${s.key}`, key: s.key, words: s.words, focus: true, press: () => stepMark($, s.key === ']' ? 1 : -1) })))
  if (stand) {
    return [
      { id: 'tray-a', key: 'a', words: 'ask', focus: true, press: () => askCard($, stand) },
      ...(await steps()),
      { id: 'tray-0', key: '0', words: 'back', focus: true, press: () => $.state.set(STAND, null as never) },
    ]
  }
  const f = top(tray) as Frame | null
  if (!tray || !f) return []
  const out: BarItem[] = []
  const zero: BarItem = { id: 'tray-0', key: '0', words: f.open || tray.stack.length > 1 ? 'back' : 'close', focus: true, press: () => goBack($) }
  if (f.kind === 'citation') {
    out.push({ id: 'tray-a', key: 'a', words: 'ask', focus: true, press: () => askAbout($, f) })
    if ((await itemOf($, f.row, f.n))?.evidence?.kind === 'computed') out.push({ id: 'tray-c', key: 'c', words: 'code', focus: true, press: () => toggleCode($) })
    out.push(zero, ...(await steps()))
    const inner = await innerOf($, f)
    if (inner) {
      const g = inner.kind !== 'citation' ? await glossOf($, inner.row, inner.id) : null
      const term = String(g?.term ?? '')
      out.push({ id: 'tray-h', key: 'h', words: inner.kind === 'heads' ? 'heads up' : `explain ${term.length > 24 ? `${term.slice(0, 23)}…` : term}`, focus: true, press: () => pushMark($, inner) })
    }
    return out
  }
  const g = await glossOf($, f.row, f.id)
  if (f.kind === 'explain' && g && !g.expanded) out.push({ id: 'tray-e', key: 'e', words: 'expand', focus: true, press: () => expand($, f) })
  out.push({ id: 'tray-a', key: 'a', words: 'ask', focus: true, press: () => askAbout($, f) }, zero, ...(await steps()))
  return out
}

// ------------------------------------------------------------------------------------------------ the answer view

/** What the tray shows on this row, so the row draws it in focus. */
export async function trayFocus($: Engine, row: string): Promise<MarkRef | null> {
  const f = top(await trayNow($)) as Frame | null
  return f && f.row === row ? (refOf(f) as MarkRef) : null
}

/** A press on a citation opens the tray on it, as in 0.10 (its whole evidence is a click on its place there). */
export async function markPressed($: Engine, row: string, n: number): Promise<boolean> {
  if (!(n > 0)) return false
  const f: Frame = { row, kind: 'citation', n }
  if (sameRef(top(await trayNow($)), f)) return true
  await openMark($, f)
  return true
}

/** The tray on an explainer or a heads-up (a press on its words, explain/seam.ts). */
export async function openTray($: Engine, mark: MarkRef): Promise<boolean> {
  if (!mark || !mark.row) return false
  await openMark($, { ...mark })
  return true
}

// ------------------------------------------------------------------------------------------------ the band

async function hyperlinksHere($: Engine): Promise<boolean> {
  // each name literal at its call, so the variables the module reads can be listed
  const env: Record<string, string | undefined> = {
    FORCE_HYPERLINK: await $.env.get('FORCE_HYPERLINK'), TERM_PROGRAM: await $.env.get('TERM_PROGRAM'),
    TERM_PROGRAM_VERSION: await $.env.get('TERM_PROGRAM_VERSION'), LC_TERMINAL: await $.env.get('LC_TERMINAL'),
    TERMINAL_EMULATOR: await $.env.get('TERMINAL_EMULATOR'), WT_SESSION: await $.env.get('WT_SESSION'), TMUX: await $.env.get('TMUX'),
    TERM: await $.env.get('TERM'), CI: await $.env.get('CI'), TEAMCITY_VERSION: await $.env.get('TEAMCITY_VERSION'), VTE_VERSION: await $.env.get('VTE_VERSION'),
  }
  return drawsHyperlinks(env)
}

const STATUS: Record<string, { word: string; color?: string; dim?: boolean }> = {
  checking: { word: 'checking', dim: true },
  verified: { word: 'verified', color: 'success' },
  corrected: { word: 'corrected', color: 'merged' },
  failed: { word: 'wrong', color: 'error' },
  unconfirmed: { word: 'not confirmed', color: 'warning' },
  unchecked: { word: 'not checked', dim: true },
}

/** A citation's card. By default its status, why in one sentence, and the one line of its evidence that holds the
 *  cited value, the value in the citations' purple (a file's line with its number). With c, for a value code computed:
 *  the whole code, in code styling, then a blank line and the whole output, the value in purple as before. */
function citationBody(els: Any, f: Frame, m: MarkItem | null, w: number): Any[] {
  const { Box, Text } = els
  if (!m) return [Text({ key: 'gone', dimColor: true, wrap: 'wrap', children: 'This citation is no longer in the session.' })]
  const unconfirmed = m.status === 'failed' && m.failedBy === 'evidence'
  const st = STATUS[unconfirmed ? 'unconfirmed' : m.status] ?? STATUS.unchecked!
  const ev = m.evidence
  const why = m.reason ? firstSentence(m.reason) : m.status === 'checking' ? 'The check is running.' : ev ? '' : 'The check gave no evidence for it.'
  const rows: Any[] = [Text({ key: 'status', wrap: 'wrap', children: [
    Text({ key: 's', bold: true, ...(st.color ? { color: st.color } : {}), ...(st.dim ? { dimColor: true } : {}), children: st.word }),
    ...(why ? [Text({ key: 'why', ...(m.status === 'failed' && !unconfirmed ? { color: st.color } : { dimColor: true }), children: `  ${why}` })] : []),
  ] })]
  if (!ev || m.status === 'checking') return rows
  if (ev.kind === 'computed' && f.open === 'code') {
    const code = wrapCode(ev.code, w)
    rows.push(els.Code ? els.Code({ key: 'code', source: code, language: 'python' }) : Text({ key: 'code', color: 'permission', children: code }))
    rows.push(Text({ key: 'gap', children: ' ' }))
    rows.push(Box({ key: 'out', flexDirection: 'column', children: outputRows(els, ev.output, ev.highlight, Number.MAX_SAFE_INTEGER) }))
    return rows
  }
  const line = evidenceLine(ev)
  if (!line) return rows
  const gutter = line.n !== undefined ? `${line.n} │ ` : ''
  const cut = lineWindow(line, w - gutter.length)
  rows.push(Box({ key: 'ev', flexDirection: 'row', children: [
    ...(gutter ? [Text({ key: 'n', dimColor: true, children: gutter })] : []),
    Box({ key: 'l', flexShrink: 1, children: [highlighted(els, cut.text, cut.spans, 't')] }),
  ] }))
  return rows
}

/** Under a citation of a file's lines, the file's place (`runs.jsonl:41`): a click opens the citation's whole evidence
 *  in the side pane, which works over ssh too. Where Claude Code draws OSC 8 hyperlinks it is also a link to the file,
 *  which a ctrl or cmd click opens on this machine. */
async function fileLinkEl($: Engine, els: Any, f: Frame, m: MarkItem | null): Promise<Any | null> {
  const ev = m?.evidence
  if (!ev || ev.kind === 'computed' || f.kind !== 'citation') return null
  const label = `${ev.file}:${ev.line}`
  const openIt = () => {
    void openPane($, 'evidence', { row: f.row, n: f.n }, `citation ${f.n}`).then(placed => {
      if (!placed) noticeLine($, 'Claude Code did not open the side pane here. Click the citation in the reply to see its evidence.', 'tray')
    }, () => undefined)
  }
  if (els.Markdown && (await hyperlinksHere($))) {
    const start = await startDir($)
    const abs = ev.file.startsWith('/') ? ev.file : `${start.replace(/\/+$/, '')}/${ev.file}`
    const href = fileHref(abs, ev.line)
    return els.Markdown({ key: 'tray-file', text: `[${label.replace(/[[\]\\]/g, c => '\\' + c)}](${href})`, onLinkPress: openIt, pressableLinks: [href] })
  }
  return els.Button({ key: 'tray-file', plain: true, label: `open ${label}`, onPress: openIt, children: [els.Text({ color: 'merged', underline: true, children: label })] })
}

/** The tray, drawn above the bar while it is open: one frame, its title and its kind (cite, explain, heads up) on top,
 *  the mark's card under them, its rows starting where the title starts. */
export async function trayBand($: Engine, els: Any, width: number): Promise<Any[]> {
  const tray = await trayNow($)
  const f = top(tray) as Frame | null
  if (!tray || !f) return []
  const { Box, Text } = els
  const w = Math.max(40, Math.min(104, width - 3))
  const inner = w - 4
  let title = ''
  let body: Any[] = []
  let under: Any | null = null
  if (f.kind === 'citation') {
    const m = await itemOf($, f.row, f.n)
    title = (m?.shown ?? m?.words ?? `citation ${f.n}`).replace(/\*\*|`/g, '')
    body = citationBody(els, f, m, inner)
    under = await fileLinkEl($, els, f, m)
  } else {
    const g = await glossOf($, f.row, f.id)
    const heads = f.kind === 'heads'
    title = String(g?.term || g?.title || (heads ? 'heads up' : 'explain'))
    if (!g) body = [Text({ key: 'gone', dimColor: true, wrap: 'wrap', children: `This ${heads ? 'heads-up' : 'explainer'} is no longer in the session.` })]
    else {
      const text = explainerText(g)
      const { marks, looks } = await linksOf($, f, text)
      body = [messageEl(els, {
        text, marks, looks, key: `tray-${f.row}-${f.id}`, cols: inner, first: false, spin: '', gutter: false,
        onMark: (k: number) => { const n = looks[k]?.n; if (n > 0) void pushMark($, { row: f.row, kind: 'citation', n }) },
      })]
    }
  }
  // the thread about this mark, once a question was asked in it: a opens it
  const asked = f.open === 'code' ? null : await threadAsked($, { about: '', mark: refOf(f) as MarkRef })
  if (asked) body = [...body, Text({ key: 'thread', wrap: 'truncate-end', children: [
    Text({ key: 'a', dimColor: true, children: '↳ thread: ' }),
    Text({ key: 'q', children: asked.length > 60 ? asked.slice(0, 59) + '…' : asked }),
    Text({ key: 'b', dimColor: true, children: ' · a opens it' }),
  ] })]
  // the right of the title says what kind of mark it is, nothing more
  const right = f.kind === 'citation' ? 'cite' : f.kind === 'heads' ? 'heads up' : 'explain'
  const avail = inner - 2
  const room = title.length + right.length + 3 <= avail ? title.length : Math.max(8, avail - Math.min(right.length, Math.floor(avail / 2)) - 3)
  const tone = TONES[f.kind]
  const head = Box({ key: 'tray-head', flexDirection: 'row', justifyContent: 'space-between', children: [
    Text({ key: 't', bold: true, color: tone, wrap: 'truncate-end', children: cutTitle(title, room) }),
    Text({ key: 'r', dimColor: true, children: right }),
  ] })
  const frame = Box({ key: 'tray', flexDirection: 'column', borderStyle: 'round', borderColor: tone, paddingX: 1, width: w, children: [head, Box({ key: 'tray-body', flexDirection: 'column', children: body })] })
  return [Box({ key: 'tray-band', marginLeft: 2, flexDirection: 'column', children: [frame, ...(under ? [under] : [])] })]
}

// ------------------------------------------------------------------------------------------------ hooks

export const registerTray: Register = on => {
  // a question the person typed with the tray open is about its mark: its scope is already waiting for this prompt
  // (core/tell.ts sends it), so the tray closes without taking it back, and the prompt shows what it was about
  on('prompt.submit', { origin: { kind: /^(composer|bridge)$/ } }, async ($, e, next) => {
    try {
      if (!e.command && !e.isMeta) {
        const f = top(await trayNow($)) as Frame | null
        if (f) {
          pendingAbout = aboutOf(f, await infoOf($, f))
          await $.state.set(TRAY, null as never)
        } else pendingAbout = null
      }
    } catch {
      // the prompt goes in as typed
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // main's turn for that prompt: what it was about, kept by the turn, so its prompt row shows it
  on('turn.start', { turnId: /\S/ }, async ($, e, next) => {
    if (e.agentId === undefined && pendingAbout) {
      const about = pendingAbout
      pendingAbout = null
      try { await $.state.set({ ...ASKED, id: e.turnId } as never, about as never) } catch { /* the prompt shows as typed */ }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // a prompt asked with the tray open: under it, `▸ about the citation "…"`
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    try {
      const row = String((e as Any).requestId ?? '')
      if (!row) return next(e)
      const turn = (await turnsNow($)).find(t => t.prompt.row === row)
      const about = turn ? ((await $.state.get({ ...ASKED, id: turn.turnId } as never)).value as string | undefined) : undefined
      if (!about) return next(e)
      const { Box, Text } = $.ui.resolve(e) as Any
      const own = await next(e)
      return Box({ flexDirection: 'column', children: [own, Text({ key: 'tray-about', dimColor: true, wrap: 'truncate-end', children: `  ▸ about ${about}` })] })
    } catch {
      return next(e)
    }
  }).catch(($, e, next) => next(e))
}

/** For tests: the module's memory, cleared. */
export function resetTray(): void {
  pendingAbout = null
}
