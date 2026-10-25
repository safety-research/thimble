// seam.ts: the explainers and the heads-ups on Claude's answers (0.10's explain and heads lenses).
// core/answerview.ts and observer/observer.ts call each function by name, since Claude Code follows `$` only into
// functions a file declares or imports.
//
// The observer's look after each answer gives explainers (terms the analyst may lack the background for) and at most
// one heads-up (a detail they should know before they rely on the answer). explainMerge places each on the words of the
// newest message that holds them (place.mjs mergeLook) and keeps it as that message's part `explain`. The row draws
// each as a press on its words: an explainer highlighted teal, a heads-up orange (place.mjs markColors); a press
// opens the tray on it (tray/seam.ts openTray). Claude hears with the next prompt the words of each one shown on its
// answer (tellComments), and which ones the analyst opened (core/engaged.ts). A term is explained once per
// conversation; the lenses' digests name the terms already explained and the heads-ups already given, which this
// module keeps in the conversation's folder (explain.json).
//
//   explainSpans($, row, text, marks)  the explainers and heads-ups on the words of a row as it shows now (`text`, a
//                                      squeezed version too: a term is found again there in another form)
//   explainState($)                    what the lenses' digests read: {glossed, headsGiven}
//   explainMerge($, look)              what one look gave for the explain and heads lenses, placed and kept
//   tellComments($, rows)              Claude hears the explainers and heads-ups shown on these answers with the next
//                                      prompt: each one's words
//   sessionGlosses($)                  every explainer of this session: a pane shows the one of words picked there
//   explainTerm($, row, term)          on demand: an explainer of words the analyst picked (a citation's words, a term
//                                      in a pane, /explain), written by the explain-expand call and kept on its message
//                                      as the look's are; explaining(term) says while it is written
//   explainKey($, key), explainBar     e at an empty prompt, `e explain` on the bar: an explainer of the words the
//                                      analyst selected with the mouse ($.ui.selection, fullscreen layout only), on
//                                      the answer they lie in, else the newest answer that holds them, opened in the
//                                      tray. Words inside an explainer or a heads-up (or on it) open that one; words
//                                      over or across marks get one explainer, whose mark covers those it overlaps
//   registerExplain                    /explain <words>: the same for typed words, in any layout
//
// The colors follow Claude Code's theme (core/theme.ts; place.mjs markColors).
// Each lens's switch (settings: Comments, its Explainers and Heads-ups) also hides what it gave while it is off.
import type { EngineInterface, Register } from 'claude-code'

import type { BarItem } from '../bar/bar'
import { failCleared, failNotice, noticeLine } from '../bar/notice'
import { fullscreenNow } from '../cards/draw'
import { answerRows, messageOf, partOf, setPart, textRows } from '../core/answers'
import type { MarkRef, Span } from '../core/answerview'
import { textView } from '../core/answerview'
import { themeNow } from '../core/theme'
import { tellOpened } from '../core/engaged'
import { commentsText } from '../core/engaged.mjs'
import { tellAtNextPrompt } from '../core/tell'
import { readKept, writeKept } from '../core/env'
import { sessionKey } from '../hooks/conversation'
import type { Take } from '../hooks/keys'
import { withoutMarks } from '../marks/message.js'
import type { Look } from '../observer/observer'
import { featureOn } from '../settings/features.mjs'
import { openTray } from '../tray/seam'
import { askGloss } from './expand'
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

export async function explainState($: Engine): Promise<Record<string, unknown>> {
  const m = await memory($)
  return { glossed: [...m.glossed], headsGiven: [...m.headsGiven] }
}

export async function explainMerge($: Engine, look: Look): Promise<void> {
  const m = await memory($)
  const msgs = []
  for (const x of look.msgs) {
    // what the person reads of it: Claude's words, and the version shown in their place (squeezed)
    const shownText = (await textView($, x.row, x.text)).text
    const part = await partOf<ExplainPart>($, x.row, 'explain')
    msgs.push({ row: x.row, text: shownText === x.text ? x.text : `${x.text}\n\n${shownText}`, part })
  }
  const r = mergeLook(msgs, look.out, { glossed: m.glossed }) as { parts: Record<string, ExplainPart>; placed: string[]; heads: string[] }
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

// the words being explained on demand now, and why the last try of each failed
const asking = new Set<string>()
const failed = new Map<string, string>()

/** Whether an explainer of these words is being written now; why the last one was not, else ''. */
export function explaining(term: string): { pending: boolean; why: string } {
  const t = normTerm(term)
  return { pending: asking.has(t), why: failed.get(t) ?? '' }
}

/**
 * An explainer of `term`, the words the analyst picked in the message `row`: the session's one when it has one, else
 * one written now (explain/expand.ts askGloss), kept on that message, so its words show it there too. Returns where it
 * is, or a sentence that says why there is none. The panes draw again when it is written.
 */
export async function explainTerm($: Engine, row: string, term: string): Promise<SessionGloss | string> {
  const words = termOf(term).replace(/\s+/g, ' ').trim()
  if (!words) return 'Pick some words to explain.'
  if (!featureOn('explain')) return 'Explainers are off. Turn on "Explainers" in /thimble-settings to use them.'
  const have = glossFor(await sessionGlosses($), words)
  if (have) return have
  const t = normTerm(words)
  if (asking.has(t)) return 'That explainer is being written.'
  asking.add(t)
  failed.delete(t)
  $.ui.invalidate('ui.render')
  try {
    const got = await askGloss($, row, words)
    if (typeof got === 'string') { failed.set(t, got); return got }
    const m = await memory($)
    m.glossed = [...m.glossed, words].slice(-GLOSSED_KEEP)
    await writeKept($, FILE, { glossed: m.glossed, headsGiven: m.headsGiven }).catch(() => undefined)
    const g = (await partOf<ExplainPart>($, row, 'explain'))?.items?.[got.id]
    await tellComments($, [row]).catch(() => undefined)
    return g ? { ...g, row } : 'The explainer was written, but its answer is not in this session any more.'
  } finally {
    asking.delete(t)
    $.ui.invalidate('ui.render')
  }
}

/** The newest answer that holds the words, else the newest answer; null with no answer yet. */
async function rowHolding($: Engine, words: string): Promise<string | null> {
  const rows = (await answerRows($).catch(() => [] as string[])).slice().reverse()
  for (const r of rows) {
    const text = (await messageOf($, r))?.text ?? ''
    if (holds(text, words) || anchorTerm(text, words)) return r
  }
  return rows[0] ?? null
}

/** The explainer of `words` on `row`, written now when there is none, then opened in the tray; a failure says why. */
function explainOpen($: Engine, row: string, words: string): void {
  void (async () => {
    const got = await explainTerm($, row, words)
    if (typeof got === 'string') failNotice($, got, 'explain')
    else {
      await failCleared($, 'explain')
      await openMark($, { row: got.row, kind: 'explain', id: got.id }, got)
    }
  })().catch(err => failNotice($, `The explainer was not written: ${String((err as Error)?.message || err).slice(0, 160)}`, 'explain'))
}

/** A mark opened in the tray, and main told so (core/engaged.ts). */
async function openMark($: Engine, mark: MarkRef & { id: string }, g: Gloss): Promise<void> {
  await openTray($, mark)
  const kind = g.kind === 'heads' ? 'heads' as const : 'explain' as const
  await tellOpened($, kind === 'heads' ? { kind, row: mark.row, term: g.term, title: g.title } : { kind, row: mark.row, term: g.term }, (await messageOf($, mark.row))?.text ?? '')
}

/** /explain <words>: the newest answer that holds the words (else the newest answer) explains them, in the tray. */
async function explainCommand($: Engine, args: string): Promise<{ text?: string }> {
  const words = String(args || '').replace(/^["“'‘]+|["”'’]+$/g, '').trim()
  if (!words) return { text: 'Type the words to explain after /explain, as in /explain hit counter.' }
  const row = await rowHolding($, words)
  if (!row) return { text: 'No answer to explain words in yet: ask Claude something first.' }
  const mark = await markOf($, row, words)
  if (mark) { await openMark($, { row, kind: mark.kind === 'heads' ? 'heads' : 'explain', id: mark.id }, mark); return {} }
  explainOpen($, row, words)
  return { text: `Writing an explainer of “${words}”. It opens under the answer when it is ready.` }
}

// ------------------------------------------------------------------------------------------------ the selection

/** The bar's key that explains the selected words. */
export const EXPLAIN_KEYS = ['e']
/** The most of a selection explained: as long a term as an explainer can stand on (place.mjs anchorTerm). */
const PICK_MAX = 120

/** The words of a selection to explain: on one line, without the space and quotes around them, at most PICK_MAX
 *  characters, cut after a whole word (`cut`). */
export function pickedWords(text: string): { words: string; cut: boolean } {
  const quotes = /^[\s"“”'‘’`]+|[\s"“”'‘’`]+$/g
  const all = termOf(String(text ?? '')).replace(/\s+/g, ' ').replace(quotes, '')
  if (all.length <= PICK_MAX) return { words: all, cut: false }
  const head = all.slice(0, PICK_MAX + 1)
  const at = head.lastIndexOf(' ')
  return { words: (at > PICK_MAX / 2 ? head.slice(0, at) : head.slice(0, PICK_MAX)).replace(quotes, '').replace(/[,;:]$/, ''), cut: true }
}

/** The explainer or heads-up on `row` that the words stand inside, or on, as the row draws its marks now; null when
 *  they stand outside every mark, or over or across one (a new explainer covers those: place.mjs placeGlosses). */
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
  const sel = await $.ui.selection().catch(() => undefined)
  explained = selKey(sel)
  const { words, cut } = pickedWords(sel?.text ?? '')
  if (!words) {
    noticeLine($, fullscreenNow() === false
      ? 'Selecting words with the mouse needs Claude Code\'s fullscreen layout. Here, type /explain and the words.'
      : 'Select words in an answer with the mouse first, then press e to explain them.', 'explain')
    return
  }
  await failCleared($, 'explain')
  const own = sel?.requestId && (await messageOf($, sel.requestId)) ? sel.requestId : null
  const row = own ?? (await rowHolding($, words))
  if (!row) { noticeLine($, 'No answer to explain words in yet: ask Claude something first.', 'explain'); return }
  const mark = await markOf($, row, words)
  if (mark) { await openMark($, { row, kind: mark.kind === 'heads' ? 'heads' : 'explain', id: mark.id }, mark); return }
  // the bar's busy line says what is written until the tray opens on it (expand.ts); a line here would say it twice.
  // Only a cut selection says so, since the busy line names just the words it explains
  if (cut) noticeLine($, `The selection is long: the explainer covers its first ${words.length} characters.`, 'explain')
  explainOpen($, row, words)
}

/** e at an empty prompt, while Explainers is on and an answer exists: after the word window (an e that starts a word
 *  is typed), the selected words are explained. */
export async function explainKey($: Engine, key: string, _until: number): Promise<Take | null> {
  if (!EXPLAIN_KEYS.includes(key) || !featureOn('explain') || !(await answerRows($).catch(() => [])).length) return null
  return { later: () => explainSelection($) }
}

/** The selection e last explained, by its row and words: Claude Code answers the last selection until the person
 *  selects again or sends their next prompt, so the bar stops naming e once e has explained it. */
let explained: string | null = null
const selKey = (sel: { text?: string; requestId?: string } | undefined) => `${sel?.requestId ?? ''}\n${sel?.text ?? ''}`

/** Words selected that e has not explained yet. */
async function selectionWaits($: Engine): Promise<boolean> {
  const sel = await $.ui.selection().catch(() => undefined)
  return !!pickedWords(sel?.text ?? '').words && selKey(sel) !== explained
}

/** Whether words are selected now (the bar's `w where from` stands while they are, marks/where.ts). */
export async function wordsSelected($: Engine): Promise<boolean> {
  return !!pickedWords((await $.ui.selection().catch(() => undefined))?.text ?? '').words
}

/** `e explain` on the bar while words are selected (Claude Code's fullscreen layout reports a selection; elsewhere
 *  /explain takes the words, and e at an empty prompt says so) that e has not explained yet, Explainers is on and an
 *  answer exists; a click does what e does. The settings' preview shows it, as it would show with words selected. */
export async function explainBar($: Engine, on: (key: string) => boolean, preview: boolean): Promise<BarItem[]> {
  if (!on('explain')) return []
  if (preview) return [{ id: 'explain', key: 'e', words: 'explain' }]
  if (!(await selectionWaits($))) return []
  if (!(await answerRows($).catch(() => [])).length) return []
  return [{ id: 'explain', key: 'e', words: 'explain', press: () => explainSelection($) }]
}

export const registerExplain: Register = on => {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const r = await next(e)
    try {
      await $.command.register({ name: 'explain', description: 'Explain words of an answer: /explain hit counter', argumentHint: '<words to explain>', immediate: true })
    } catch {
      // the panes' presses still explain
    }
    watchSelection($)
    return r
  }).catch(($, e, next) => next(e))
  on('command.run', { command: /^(thimble:)?explain$/ }, async ($, e) => explainCommand($, String((e as { args?: string }).args ?? '')))
}

/** How often the selection is read while the bar waits for one (watchSelection). */
const SELECTION_MS = 300
let watching = 0

/** The bar names `e explain` and `w where from` only while words are selected, and Claude Code tells no hook when the
 *  person selects: so while its fullscreen layout is drawn (the only one that reports a selection), the selection is
 *  read every SELECTION_MS and the bar drawn again when one starts or ends. One watch per load of the plugin; a watch of an
 *  earlier load stops at its next read. */
function watchSelection($: Engine): void {
  const mine = ++watching
  let had = ''
  const tick = async () => {
    if (mine !== watching) return
    try {
      if (fullscreenNow() === true && (featureOn('explain') || featureOn('where'))) {
        const has = `${await selectionWaits($)} ${await wordsSelected($)}`
        if (has !== had) { had = has; $.ui.invalidate('ui.render') }
      }
    } catch {
      return
    }
    $.clock.after(SELECTION_MS, () => { void tick() })
  }
  $.clock.after(SELECTION_MS, () => { void tick() })
}
