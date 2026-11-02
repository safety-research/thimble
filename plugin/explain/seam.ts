// seam.ts: the explainers and the heads-ups on Claude's answers (0.10's explain and heads lenses).
// core/answerview.ts and observer/observer.ts call each function by name, since Claude Code follows `$` only into
// functions a file declares or imports.
//
// The observer's look after each answer gives explainers (terms the analyst may lack the background for) and at most
// one heads-up (a detail they should know before they rely on the answer). explainMerge places each on the words of the
// newest message that holds them (place.mjs mergeLook) and keeps it as that message's part `explain`. An explainer
// and a heads-up never share words: the one already there keeps them, so a look's new one that would take words of
// the other kind is not added, and an explainer the analyst asks for is drawn only on words no heads-up stands on.
// Only what the analyst sees keeps words: one a switch hides keeps none.
// The row draws each as a press on its words: an explainer highlighted teal, a heads-up orange (place.mjs
// markColors); a press opens the tray on it (tray/seam.ts openTray). Claude hears with the next prompt the words of
// each one shown on its answer (tellComments), and which ones the analyst opened (core/engaged.ts). A term is
// explained once per conversation; the lenses' digests name the terms already explained and the heads-ups already
// given, which this module keeps in the conversation's folder (explain.json).
//
//   explainSpans($, row, text, marks)  the explainers and heads-ups on the words of a row as it shows now (`text`, a
//                                      squeezed version too: a term is found again there in another form)
//   explainSpansOf($, rows, text)      the explainers and heads-ups of those messages on the words of a text that stands
//                                      for them (a catch-up), where it says their terms as written, each opening on its
//                                      own message
//   explainState($)                    what the lenses' digests read: {glossed, headsGiven}
//   explainMerge($, look)              what one look gave for the explain and heads lenses, placed and kept
//   tellComments($, rows)              Claude hears the explainers and heads-ups shown on these answers with the next
//                                      prompt: each one's words
//   sessionGlosses($)                  every explainer of this session: a pane shows the one of words picked there
//   explainTerm($, row, term)          on demand: an explainer of words the analyst picked (a citation's words, a term
//                                      in a pane, the selection), written by the explain-expand call and kept on its message
//                                      as the look's are; explaining(term) says while it is written,
//                                      pendingSpans draws its words teal from the press on, and the tray opens on
//                                      them at once (pendingGloss), the explainer shown there once written. A
//                                      heads-up on words the analyst selected (h) is written the same way, by the
//                                      heads-expand call, its words orange from the press on
//   explainKey($, key), explainBar     e at an empty prompt, `e explain` on the bar (teal): an explainer of the words the
//                                      analyst selected with the mouse in Claude's words (core/selection.ts;
//                                      fullscreen layout only), on the answer they lie in, else the newest answer
//                                      that holds them, opened in the tray. Words inside an explainer or a heads-up (or on it) open that one; words
//                                      over or across marks get one explainer, whose mark covers the explainers it
//                                      overlaps; a heads-up keeps its words
//   headsKey($, key), headsBar         h at an empty prompt, `h heads-up` on the bar (orange), while words are selected
//                                      and Heads-ups is not off: a heads-up on them, as e gives an explainer (words
//                                      inside a heads-up open it). With none selected, while Heads-ups is on demand
//                                      (nothing is marked by itself then), `h heads-ups`: one look of the heads lens
//                                      alone at the answer the keys act on (observer/observer.ts headsUpsNow), once
//                                      per answer
//   registerExplain                    the watch of the selection, which draws the bar again when one starts or ends
//
// The colors follow Claude Code's theme (core/theme.ts; place.mjs markColors).
// Each lens's switch (settings: Comments, its Explainers and Heads-ups) also hides what it gave while it is off.
import type { EngineInterface, Register } from 'claude-code'

import type { BarItem } from '../bar/bar'
import { howTo, hintUsed } from '../bar/hints'
import { failCleared, failNotice, hintLine } from '../bar/notice'
import { fullscreenNow } from '../cards/draw'
import { actingRow, answerRows, messageOf, partOf, setPart, textRows } from '../core/answers'
import type { MarkRef, Span } from '../core/answerview'
import { textView } from '../core/answerview'
import { answerSelection, pickedWords, selectionKey, selectionNow, selectionUsed, selectionWaits, waitsNow } from '../core/selection'
import { themeLast, themeNow } from '../core/theme'
import { tellOpened } from '../core/engaged'
import { commentsText } from '../core/engaged.mjs'
import { tellAtNextPrompt } from '../core/tell'
import { readKept, writeKept } from '../core/env'
import { sessionKey } from '../hooks/conversation'
import type { Take } from '../hooks/keys'
import { citeShown } from '../marks/cite'
import { withoutMarks } from '../marks/message.js'
import { headsUpsNow, type Look } from '../observer/observer'
import { featureOn } from '../settings/features.mjs'
import { openTray, trayFocus, trayOffRow } from '../tray/seam'
import { askGloss, askHeads } from './expand'
import { anchorTerm, holds, markColors, markHolding, mergeLook, placeGlosses, termOf } from './place.mjs'

type Engine = EngineInterface

/** An explainer, or (kind `heads`) a heads-up, as 0.10's Gloss: the words it stands on as the person reads them
 *  (`term`), what it is (`body`), where it mattered here (`here`), a heads-up's `title` and `bullets`. Its words may
 *  link to the lines of a file that show a point, as `[words](path#L12-20)`. */
export type Gloss = {
  id: string; term: string; kind?: 'heads'; title?: string; body?: string; here?: string; bullets?: string[]
  /** written on demand: the analyst picked its words and asked (explainTerm) */
  asked?: boolean
}
/** A row's part `explain`: its explainers and heads-ups by id, in the order they were given. */
export type ExplainPart = { items: Record<string, Gloss>; order: string[] }

const GLOSSED_KEEP = 100 // terms already explained that the explain lens is told of
const HEADS_KEEP = 40 // heads-ups already given that the heads lens is told of
const FILE = 'explain.json'

// this conversation's memory, kept in its folder (a reload of the plugin reads it back)
const M = { session: '', loaded: false, glossed: [] as string[], headsGiven: [] as string[] }

async function memory($: Engine): Promise<typeof M> {
  const id = await sessionKey($)
  if (id !== M.session || !M.loaded) {
    const kept = await readKept<{ glossed?: string[]; headsGiven?: string[] }>($, FILE)
    Object.assign(M, { session: id, loaded: true, glossed: Array.isArray(kept?.glossed) ? kept!.glossed : [], headsGiven: Array.isArray(kept?.headsGiven) ? kept!.headsGiven : [] })
  }
  return M
}

/** Whether a lens's switch shows what it gave: Explainers for an explainer, Heads-ups for a heads-up. */
const shown = (g: Gloss) => featureOn(g.kind === 'heads' ? 'details' : 'explain')

export async function explainSpans($: Engine, row: string, text: string, _marks: { start: number; end: number; words: string }[]): Promise<Span[]> {
  const part = await partOf<ExplainPart>($, row, 'explain')
  if (!part?.items || !Object.keys(part.items).length) return []
  const order = (part.order ?? Object.keys(part.items)).filter(id => part.items[id] && shown(part.items[id]!))
  if (!order.length) return []
  const own = (await messageOf($, row))?.text ?? ''
  const original = text !== own && text !== withoutMarks(own)
  const c = markColors(await themeNow($))
  return (placeGlosses(text, { items: part.items, order }, original) as { id: string; start: number; end: number }[]).map(p => {
    const g = part.items[p.id]!
    const heads = g.kind === 'heads'
    const kind = heads ? 'heads' as const : 'explain' as const
    return {
      id: p.id,
      start: p.start,
      end: p.end,
      look: { backgroundColor: heads ? c.headsBg : c.glossBg, hoverBg: heads ? c.headsFocus : c.glossFocus },
      focus: { bold: true, backgroundColor: heads ? c.headsFocus : c.glossFocus },
      label: `${heads ? 'heads up' : 'explain'} ${withoutMarks(text.slice(p.start, p.end)).replace(/`/g, '')}`.slice(0, 120),
      onPress: async () => {
        await openTray($, { row, kind, id: p.id })
        await tellOpened($, heads ? { kind, row, term: g.term, title: g.title } : { kind, row, term: g.term }, own)
      },
    }
  })
}

/** The explainers and heads-ups of the messages `rows` on the words of a text that stands for them (a catch-up of
 *  those replies): each where the text says its term as written (place.mjs findTerm: a term found again in another form,
 *  as a squeezed version of one message does, would stand on loose words of a text that sums up several); a press
 *  opens it on its own message, as a press on it there does. */
export async function explainSpansOf($: Engine, rows: string[], text: string): Promise<Span[]> {
  const items: Record<string, Gloss> = {}
  const order: string[] = []
  const from: Record<string, { row: string; id: string }> = {}
  for (const row of rows) {
    const part = await partOf<ExplainPart>($, row, 'explain')
    for (const id of part?.order ?? Object.keys(part?.items ?? {})) {
      const g = part?.items?.[id]
      if (!g || !shown(g)) continue
      const k = `${row}|${id}`
      items[k] = g
      order.push(k)
      from[k] = { row, id }
    }
  }
  if (!order.length) return []
  const c = markColors(await themeNow($))
  return (placeGlosses(text, { items, order }) as { id: string; start: number; end: number }[]).map(p => {
    const g = items[p.id]!
    const { row, id } = from[p.id]!
    const heads = g.kind === 'heads'
    const kind = heads ? 'heads' as const : 'explain' as const
    return {
      id: p.id,
      start: p.start,
      end: p.end,
      look: { backgroundColor: heads ? c.headsBg : c.glossBg, hoverBg: heads ? c.headsFocus : c.glossFocus },
      focus: { bold: true, backgroundColor: heads ? c.headsFocus : c.glossFocus },
      label: `${heads ? 'heads up' : 'explain'} ${withoutMarks(text.slice(p.start, p.end)).replace(/`/g, '')}`.slice(0, 120),
      onPress: async () => {
        await openTray($, { row, kind, id })
        await tellOpened($, heads ? { kind, row, term: g.term, title: g.title } : { kind, row, term: g.term }, (await messageOf($, row))?.text ?? '')
      },
    }
  })
}

export async function explainState($: Engine): Promise<Record<string, unknown>> {
  const m = await memory($)
  return { glossed: [...m.glossed], headsGiven: [...m.headsGiven] }
}

export async function explainMerge($: Engine, look: Look): Promise<void> {
  const m = await memory($)
  const msgs = []
  for (const x of look.msgs) {
    // what the person reads of it: Claude's words, and the version shown in their place (squeezed); or a catch-up drawn
    // below it, whose words alone the look read (what it gives stands on them, kept on this message, where the
    // catch-up finds it)
    const part = await partOf<ExplainPart>($, x.row, 'explain')
    if (x.catchUp) { msgs.push({ row: x.row, text: x.catchUp, part }); continue }
    const shownText = (await textView($, x.row, x.text)).text
    msgs.push({ row: x.row, text: shownText === x.text ? x.text : `${x.text}\n\n${shownText}`, part })
  }
  const r = mergeLook(msgs, look.out, { glossed: m.glossed }, shown) as { parts: Record<string, ExplainPart>; placed: string[]; heads: string[] }
  for (const [row, part] of Object.entries(r.parts)) await setPart($, row, 'explain', part)
  if (r.placed.length) m.glossed = [...m.glossed, ...r.placed].slice(-GLOSSED_KEEP)
  if (r.heads.length) m.headsGiven = [...m.headsGiven, ...r.heads].slice(-HEADS_KEEP)
  look.log('glosses', r.placed)
  if (r.heads.length) look.log('heads', r.heads)
  if (r.placed.length || r.heads.length) {
    await writeKept($, FILE, { glossed: m.glossed, headsGiven: m.headsGiven }).catch(() => undefined)
    $.ui.invalidate('ui.render')
  }
  await tellComments($, Object.keys(r.parts)).catch(() => undefined)
}

/** Claude hears, with the next prompt, the explainers and heads-ups shown on each of these answers (one text per
 *  answer, so a later look's replaces it): their words, as core/engaged.mjs commentsText says them. Those a switch
 *  hides are not shown, so not told. */
export async function tellComments($: Engine, rows: string[]): Promise<void> {
  for (const row of rows) {
    const part = await partOf<ExplainPart>($, row, 'explain')
    const items = (part?.order ?? Object.keys(part?.items ?? {})).map(id => part?.items?.[id]).filter((g): g is Gloss => !!g && shown(g))
    await tellAtNextPrompt($, `comments:${row}`, commentsText(items, (await messageOf($, row))?.text ?? ''))
  }
}

/** For tests: the module's memory, cleared. */
export function resetExplain(): void {
  Object.assign(M, { session: '', loaded: false, glossed: [], headsGiven: [] })
}

// ------------------------------------------------------------------------------------------------ on demand

/** An explainer of the session, where it is kept: its message's row and its id there. */
export type SessionGloss = Gloss & { row: string }

const normTerm = (t: string) => termOf(t).toLowerCase().replace(/\s+/g, ' ').trim()

/** Every explainer of this session (none while Explainers is off), the newest message's first. */
export async function sessionGlosses($: Engine): Promise<SessionGloss[]> {
  if (!featureOn('explain')) return []
  const rows = [...new Set([...(await answerRows($).catch(() => [] as string[])), ...(await textRows($).catch(() => [] as string[]))])].reverse()
  const out: SessionGloss[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const part = await partOf<ExplainPart>($, row, 'explain').catch(() => null)
    for (const id of part?.order ?? Object.keys(part?.items ?? {})) {
      const g = part?.items?.[id]
      if (!g || g.kind === 'heads' || seen.has(normTerm(g.term))) continue
      seen.add(normTerm(g.term))
      out.push({ ...g, row })
    }
  }
  return out
}

/** The session's explainer of these words: the same words, or another form of them ("retry budgets" finds "retry
 *  budget"); never one whose term only stands inside longer words. */
export function glossFor(list: SessionGloss[], term: string): SessionGloss | null {
  const t = normTerm(term)
  // another form of the same words: the term found over the whole of them, not inside longer words
  return list.find(g => normTerm(g.term) === t) ?? list.find(g => { const at = anchorTerm(t, g.term); return !!at && at.how !== 'word' && at.start === 0 && at.end >= t.length - 1 }) ?? null
}

/** What a key writes on words the analyst picked: an explainer (e), or a heads-up (h). */
type Asked = 'explain' | 'heads'

/** The id of words being written on demand: `asking:<words>` for an explainer, `asking-heads:<words>` for a heads-up. */
const pendingId = (kind: Asked, t: string) => `${kind === 'heads' ? 'asking-heads' : 'asking'}:${t}`

// the words being written on demand now (and the message each stands on, and what is written), by pendingId, and why
// the last try of each failed
const asking = new Set<string>()
const askedOn = new Map<string, { row: string; words: string; kind: Asked }>()
const failed = new Map<string, string>()

/** The words of `row` being written on demand now, drawn at once where the explainer (teal) or the heads-up (orange)
 *  will be (core/answerview.ts spansFor puts them before the row's other marks, as the explainer covers the
 *  explainers it overlaps; like it, an explainer's never stand on a heads-up's words). Nothing opens on a press until it
 *  is written; a failed one is gone, and its failure line says why. */
export async function pendingSpans($: Engine, row: string, text: string): Promise<Span[]> {
  const mine = [...askedOn.entries()].filter(([, a]) => a.row === row && featureOn(a.kind === 'heads' ? 'details' : 'explain'))
  if (!mine.length) return []
  const own = (await messageOf($, row))?.text ?? ''
  const original = text !== own && text !== withoutMarks(own)
  const part = await partOf<ExplainPart>($, row, 'explain')
  const heads = Object.fromEntries(Object.entries(part?.items ?? {}).filter(([, g]) => g.kind === 'heads' && shown(g)))
  const items = { ...heads, ...Object.fromEntries(mine.map(([id, a]) => [id, { id, term: a.words, asked: true, ...(a.kind === 'heads' ? { kind: 'heads' as const } : {}) }])) }
  const c = markColors(await themeNow($))
  return (placeGlosses(text, { items, order: Object.keys(items) }, original) as { id: string; start: number; end: number }[]).filter(p => !heads[p.id]).map(p => {
    const kind = askedOn.get(p.id)?.kind
    const words = withoutMarks(text.slice(p.start, p.end)).replace(/`/g, '')
    return {
      id: p.id,
      start: p.start,
      end: p.end,
      look: kind === 'heads' ? { backgroundColor: c.headsBg, hoverBg: c.headsFocus } : { backgroundColor: c.glossBg, hoverBg: c.glossFocus },
      label: `${kind === 'heads' ? 'heads-up on' : 'explainer of'} ${words} being written`.slice(0, 120),
    }
  })
}

/** The explainer or heads-up of words asked for on `row` while it is written (`id` as pendingSpans names it): its words
 *  alone, which the tray shows as its title until it is written; null for any other id. */
export function pendingGloss(row: string, id: string): Gloss | null {
  const a = askedOn.get(String(id ?? ''))
  return a && a.row === row ? { id, term: a.words, asked: true, ...(a.kind === 'heads' ? { kind: 'heads' as const } : {}) } : null
}

/** Whether an explainer of these words is being written now; why the last one was not, else ''. */
export function explaining(term: string): { pending: boolean; why: string } {
  const id = pendingId('explain', normTerm(term))
  return { pending: asking.has(id), why: failed.get(id) ?? '' }
}

/**
 * An explainer of `term`, the words the analyst picked in the message `row`: the session's one when it has one, else
 * one written now (explain/expand.ts askGloss), kept on that message, so its words show it there too. Returns where it
 * is, or a sentence that says why there is none. The panes draw again when it is written. `opened` is called with
 * the explainer being written (pendingGloss) as soon as the call starts, so it can be shown before it is written.
 */
export async function explainTerm($: Engine, row: string, term: string, o: { opened?: (mark: MarkRef & { id: string }) => Promise<unknown> } = {}): Promise<SessionGloss | string> {
  return askOnDemand($, row, term, 'explain', o)
}

/** What `kind` writes on words the analyst picked in the message `row`: an explainer (explainTerm), or a heads-up
 *  (explain/expand.ts askHeads, kept on that message as an explainer is). A heads-up is about its own answer, so none
 *  is taken from another. The look's digest learns the term explained, or the heads-up given, as when the look gives
 *  one. */
async function askOnDemand($: Engine, row: string, term: string, kind: Asked, o: { opened?: (mark: MarkRef & { id: string }) => Promise<unknown> }): Promise<SessionGloss | string> {
  const heads = kind === 'heads'
  const what = heads ? 'heads-up' : 'explainer'
  const words = termOf(term).replace(/\s+/g, ' ').trim()
  if (!words) return heads ? 'Pick some words for a heads-up.' : 'Pick some words to explain.'
  if (!featureOn(heads ? 'details' : 'explain')) return heads ? 'Heads-ups are off. Turn on "Heads-ups" in /thimble-settings to use them.' : 'Explainers are off. Turn on "Explainers" in /thimble-settings to use them.'
  const have = heads ? null : glossFor(await sessionGlosses($), words)
  if (have) return have
  const id = pendingId(kind, normTerm(words))
  if (asking.has(id)) return `That ${what} is being written.`
  asking.add(id)
  askedOn.set(id, { row, words, kind })
  failed.delete(id)
  $.ui.invalidate('ui.render')
  try {
    if (o.opened) await o.opened({ row, kind, id }).catch(() => undefined)
    const got = heads ? await askHeads($, row, words) : await askGloss($, row, words)
    if (typeof got === 'string') { failed.set(id, got); return got }
    const g = (await partOf<ExplainPart>($, row, 'explain'))?.items?.[got.id]
    const m = await memory($)
    if (heads) m.headsGiven = [...m.headsGiven, g?.title || words].slice(-HEADS_KEEP)
    else m.glossed = [...m.glossed, words].slice(-GLOSSED_KEEP)
    await writeKept($, FILE, { glossed: m.glossed, headsGiven: m.headsGiven }).catch(() => undefined)
    await tellComments($, [row]).catch(() => undefined)
    return g ? { ...g, row } : `The ${what} was written, but its answer is not in this session any more.`
  } finally {
    asking.delete(id)
    askedOn.delete(id)
    $.ui.invalidate('ui.render')
  }
}

/** The newest answer that holds the words, else the newest answer; null with no answer yet. */
export async function rowHolding($: Engine, words: string): Promise<string | null> {
  const rows = (await answerRows($).catch(() => [] as string[])).slice().reverse()
  for (const r of rows) {
    const text = (await messageOf($, r))?.text ?? ''
    if (holds(text, words) || anchorTerm(text, words)) return r
  }
  return rows[0] ?? null
}

/** What `kind` writes on `words` of `row`, opened in the tray: an explainer the session has at once; else the tray opens
 *  at once on the words while it is written, and shows it there once written, unless the person moved the tray on
 *  meanwhile. A failure says why, and closes the tray on the words. */
function askOpen($: Engine, row: string, words: string, kind: Asked): void {
  const what = kind === 'heads' ? 'heads-up' : 'explainer'
  let pending: (MarkRef & { id: string }) | null = null
  const stillShown = async () => { const f = pending ? await trayFocus($, pending.row) : null; return !!f && f.kind === kind && f.id === pending!.id }
  void (async () => {
    const got = await askOnDemand($, row, words, kind, { opened: async mark => { pending = mark; await openTray($, mark) } })
    if (typeof got === 'string') {
      if (await stillShown()) await trayOffRow($, pending!.row)
      failNotice($, got, kind)
    } else {
      await failCleared($, kind)
      await hintUsed($, kind)
      if (!pending || (await stillShown())) await openMark($, { row: got.row, kind: got.kind === 'heads' ? 'heads' : 'explain', id: got.id }, got)
    }
  })().catch(err => failNotice($, `The ${what} was not written: ${String((err as Error)?.message || err).slice(0, 160)}`, kind))
}

/** A mark opened in the tray, and main told so (core/engaged.ts). */
async function openMark($: Engine, mark: MarkRef & { id: string }, g: Gloss): Promise<void> {
  await openTray($, mark)
  const kind = g.kind === 'heads' ? 'heads' as const : 'explain' as const
  await tellOpened($, kind === 'heads' ? { kind, row: mark.row, term: g.term, title: g.title } : { kind, row: mark.row, term: g.term }, (await messageOf($, mark.row))?.text ?? '')
}

// ------------------------------------------------------------------------------------------------ the selection

/** The bar's key that explains the selected words. */
export const EXPLAIN_KEYS = ['e']

/** The explainer or heads-up on `row` that the words stand inside, or on, as the row draws its marks now; null when
 *  they stand outside every mark, or over or across one (a new explainer covers the explainers among those, and a
 *  heads-up keeps its words: place.mjs placeGlosses). */
async function markOf($: Engine, row: string, words: string): Promise<(Gloss & { id: string }) | null> {
  const part = await partOf<ExplainPart>($, row, 'explain').catch(() => null)
  if (!part?.items) return null
  const own = (await messageOf($, row))?.text ?? ''
  const text = (await textView($, row, own)).text ?? own
  const spans = await explainSpans($, row, text, []).catch(() => [] as Span[])
  const host = markHolding(text, spans, words) as { id: string } | null
  const g = host ? part.items[host.id] : null
  return g ? { ...g, id: host!.id } : null
}

/** e, or a click on `e explain`: the words the analyst last selected with the mouse, explained in the tray, on the
 *  answer they lie in (else the newest answer that holds them). Words that are an explainer or a heads-up open it. */
export async function explainSelection($: Engine): Promise<void> {
  const sel = await answerSelection($)
  await selectionUsed($, 'explain', sel)
  const { words, cut } = pickedWords(sel?.text ?? '')
  if (!words) {
    if (fullscreenNow() === false) hintLine($, 'selecting a passage needs Claude Code\'s fullscreen layout ("tui": "fullscreen" in its settings).', 'explain')
    else await howTo($, 'explain', 'select a passage in an answer and press e to explain it.', 'explain')
    return
  }
  await failCleared($, 'explain')
  const own = sel?.requestId && (await messageOf($, sel.requestId)) ? sel.requestId : null
  const row = own ?? (await rowHolding($, words))
  if (!row) { await howTo($, 'explain', 'ask Claude something, then select a passage in its answer and press e to explain it.', 'explain'); return }
  const mark = await markOf($, row, words)
  if (mark) { await hintUsed($, 'explain'); await openMark($, { row, kind: mark.kind === 'heads' ? 'heads' : 'explain', id: mark.id }, mark); return }
  // the bar's busy line says what is written until the tray opens on it (expand.ts); a line here would say it twice.
  // Only a cut selection says so, since the busy line names just the words it explains
  if (cut) hintLine($, `the passage is long: the explainer covers its first ${words.length} characters.`, 'explain')
  askOpen($, row, words, 'explain')
}

/** e at an empty prompt, while Explainers is on and an answer exists: after the word window (an e that starts a word
 *  is typed), the selected words are explained. */
export async function explainKey($: Engine, key: string, _until: number): Promise<Take | null> {
  if (!EXPLAIN_KEYS.includes(key) || !featureOn('explain') || !(await answerRows($).catch(() => [])).length) return null
  return { later: () => explainSelection($) }
}

/** Whether words are selected now (the bar's `c cite` may stand while they are, marks/cite.ts). */
export async function wordsSelected($: Engine): Promise<boolean> {
  return !!pickedWords((await answerSelection($))?.text ?? '').words
}

/** `e explain` on the bar, in the explainers' teal, while words are selected (only Claude Code's fullscreen layout
 *  reports a selection; elsewhere e at an empty prompt says so) that e has not explained yet (core/selection.ts
 *  selectionWaits), Explainers is on and an answer exists; a click does what e does. The settings' preview shows it,
 *  as it would show with words selected. */
export async function explainBar($: Engine, on: (key: string) => boolean, preview: boolean): Promise<BarItem[]> {
  if (!on('explain')) return []
  // in the explainers' teal (place.mjs markColors): each key that acts on the selected words in the color of what it gives
  const item = { id: 'explain', key: 'e', words: 'explain', color: markColors(themeLast()).gloss }
  if (preview) return [item]
  if (!(await selectionWaits($, 'explain', await selectionNow($)))) return []
  if (!(await answerRows($).catch(() => [])).length) return []
  return [{ ...item, press: () => explainSelection($) }]
}

// ------------------------------------------------------------------------------------------------ heads-ups on demand

/** The bar's key that asks for a heads-up on the selected words, or heads-ups on an answer while Heads-ups is on demand
 *  and none are selected. */
export const HEADS_KEYS = ['h']

/** The answers h asked heads-ups for in this load: each once. */
const headsAsked = new Set<string>()

/** The answer h acts on now, while it has not asked for that one's heads-ups yet. */
async function headsRow($: Engine): Promise<string | null> {
  if (!featureOn('heads')) return null
  const row = await actingRow($).catch(() => null)
  return row && !headsAsked.has(row) ? row : null
}

async function askHeadsNow($: Engine, row: string): Promise<void> {
  headsAsked.add(row)
  $.ui.invalidate('ui.render')
  if (!(await headsUpsNow($, row).catch(() => false))) {
    headsAsked.delete(row)
    failNotice($, 'thimble could not ask for heads-ups on this answer now. Press h to try again.', 'heads')
  } else await hintUsed($, 'heads')
}

/** h, or a click on `h heads-up`: a heads-up on the words the analyst last selected with the mouse, on the answer they
 *  lie in (else the newest answer that holds them), opened in the tray, as e explains them. Words inside a heads-up
 *  open it. */
export async function headsSelection($: Engine): Promise<void> {
  const sel = await answerSelection($)
  await selectionUsed($, 'heads', sel)
  const { words, cut } = pickedWords(sel?.text ?? '')
  if (!words) {
    if (fullscreenNow() === false) hintLine($, 'selecting a passage needs Claude Code\'s fullscreen layout ("tui": "fullscreen" in its settings).', 'heads')
    else await howTo($, 'heads', 'select a passage in an answer and press h for a heads-up on it.', 'heads')
    return
  }
  await failCleared($, 'heads')
  const own = sel?.requestId && (await messageOf($, sel.requestId)) ? sel.requestId : null
  const row = own ?? (await rowHolding($, words))
  if (!row) { await howTo($, 'heads', 'ask Claude something, then select a passage in its answer and press h for a heads-up on it.', 'heads'); return }
  const mark = await markOf($, row, words)
  if (mark?.kind === 'heads') { await hintUsed($, 'heads'); await openMark($, { row, kind: 'heads', id: mark.id }, mark); return }
  if (cut) hintLine($, `the passage is long: the heads-up covers its first ${words.length} characters.`, 'heads')
  askOpen($, row, words, 'heads')
}

/** h at an empty prompt: while words are selected that h has not taken (core/selection.ts waitsNow) and Heads-ups is
 *  not off, after the word window (an h that starts a word is typed), a heads-up on them; else, while Heads-ups is on
 *  demand and an answer has no heads-ups asked for yet, heads-ups on it. */
export async function headsKey($: Engine, key: string, _until: number): Promise<Take | null> {
  if (!HEADS_KEYS.includes(key)) return null
  if (featureOn('details') && (await waitsNow($, 'heads'))) return { later: () => headsSelection($) }
  const row = await headsRow($)
  return row ? { later: () => askHeadsNow($, row) } : null
}

/** `h heads-up` on the bar, in the heads-ups' orange, while words are selected that h has not taken and Heads-ups is
 *  not off; else `h heads-ups` while h asks for an answer's. The settings' preview shows the first, as it would show
 *  with words selected. */
export async function headsBar($: Engine, on: (key: string) => boolean, preview: boolean): Promise<BarItem[]> {
  const item = { id: 'heads', key: 'h', words: 'heads-up', color: markColors(themeLast()).heads }
  if (preview) return on('details') ? [item] : []
  if (on('details') && (await selectionWaits($, 'heads', await selectionNow($)))) return [{ ...item, press: () => headsSelection($) }]
  if (!on('heads')) return []
  const row = await headsRow($)
  return row ? [{ id: 'heads', key: 'h', words: 'heads-ups', press: () => askHeadsNow($, row) }] : []
}

export const registerExplain: Register = on => {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const r = await next(e)
    watchSelection($)
    return r
  }).catch(($, e, next) => next(e))
}

/** How often the selection is read while the bar waits for one (watchSelection). */
const SELECTION_MS = 300
let watching = 0

/** The bar names the keys that act on the selected words (c cite, e explain, h heads-up, a ask) only while words are
 *  selected, and Claude Code tells no hook when the person selects: so while its fullscreen layout is drawn (the only
 *  one that reports a selection), the selection is read every SELECTION_MS and the bar drawn again when one starts or
 *  ends, or other words are selected. The keys read whether words wait for them as last worked out for the selection
 *  (marks/cite.ts for c, core/selection.ts for h and a), so a new selection is worked out here too, before the bar
 *  draws again. One watch per load of the plugin; a watch of an earlier load stops at its next read. */
function watchSelection($: Engine): void {
  const mine = ++watching
  let had = ''
  const tick = async () => {
    if (mine !== watching) return
    try {
      if (fullscreenNow() === true) {
        const raw = await selectionNow($)
        const has = `${await selectionWaits($, 'explain', raw)} ${await wordsSelected($)} ${selectionKey(raw)}`
        if (has !== had) {
          had = has
          await citeShown($).catch(() => false)
          await selectionWaits($, 'heads', raw).catch(() => false)
          await selectionWaits($, 'ask', raw).catch(() => false)
          $.ui.invalidate('ui.render')
        }
      }
    } catch {
      return
    }
    $.clock.after(SELECTION_MS, () => { void tick() })
  }
  $.clock.after(SELECTION_MS, () => { void tick() })
}
