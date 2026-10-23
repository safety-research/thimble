// seam.ts: the explainers and the important details (heads-ups) on Claude's answers (0.10's explain and heads lenses).
// core/answerview.ts and observer/observer.ts call each function by name, since Claude Code follows `$` only into
// functions a file declares or imports.
//
// The observer's look after each answer gives explainers (terms the analyst may lack the background for) and at most
// one heads-up (a detail they should know before they rely on the answer). explainMerge places each on the words of the
// newest message that holds them (place.mjs mergeLook) and keeps it as that message's part `explain`. The row draws
// each as a press on its words: an explainer highlighted teal, a heads-up orange (place.mjs markColors); a press
// opens the tray on it (tray/seam.ts openTray), and Claude hears with the next prompt that the analyst opened it
// (core/engaged.ts). A term is explained once per conversation; the lenses' digests name the terms already explained
// and the heads-ups already given, which this module keeps in the conversation's folder (explain.json).
//
//   explainSpans($, row, text, marks)  the explainers and heads-ups on the words of a row as it shows now (`text`, a
//                                      squeezed version too: a term is found again there in another form)
//   explainKey($, key, until)          e: Longer, on the explainer the tray shows
//   explainState($)                    what the lenses' digests read: {glossed, headsGiven}
//   explainMerge($, look)              what one look gave for the explain and heads lenses, placed and kept
//   expandExplainer($, mark)           Longer: the explainer written again at more length, in its place (expand.ts);
//                                      null when it did, else a sentence that says why not
//
// The colors follow Claude Code's theme (core/theme.ts; place.mjs markColors).
// Each lens's switch (settings: Explainers, Important details) also hides what it gave while it is off.
import type { EngineInterface } from 'claude-code'

import { failNotice } from '../bar/notice'
import { answerRows, messageOf, partOf, setPart, textRows } from '../core/answers'
import type { MarkRef, Span } from '../core/answerview'
import { textView } from '../core/answerview'
import { themeNow } from '../core/theme'
import { tellOpened } from '../core/engaged'
import { readKept, writeKept } from '../core/env'
import type { Take } from '../hooks/keys'
import { sessionKey } from '../hooks/conversation'
import { withoutMarks } from '../marks/message.js'
import type { Look } from '../observer/observer'
import { featureOn } from '../settings/features.mjs'
import { openTray, trayFocus } from '../tray/seam'
import { expandGloss } from './expand'
import { markColors, mergeLook, placeGlosses } from './place.mjs'

type Engine = EngineInterface

/** An explainer, or (kind `heads`) an important detail, as 0.10's Gloss: the words it stands on as the person reads
 *  them (`term`), what it is (`body`), where it mattered here (`here`), a heads-up's `title`, `bullets` and `todo`,
 *  and, once written at more length (`expanded`), the short one kept in `short`. Its words may link to the lines of a
 *  file that show a point, as `[words](path#L12-20)`. */
export type Gloss = {
  id: string; term: string; kind?: 'heads'; title?: string; body?: string; here?: string; bullets?: string[]; todo?: string
  expanded?: boolean; short?: { body: string; here: string }
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

/** Whether a lens's switch shows what it gave: Explainers for an explainer, Important details for a heads-up. */
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
      look: { backgroundColor: heads ? c.headsBg : c.glossBg },
      focus: { bold: true, backgroundColor: heads ? c.headsFocus : c.glossFocus },
      label: `${heads ? 'heads up' : 'explain'} ${text.slice(p.start, p.end).replace(/`/g, '')}`.slice(0, 120),
      onPress: async () => {
        await openTray($, { row, kind, id: p.id })
        await tellOpened($, heads ? { kind, row, term: g.term, title: g.title } : { kind, row, term: g.term }, own)
      },
    }
  })
}

/** The explainer the tray shows now, on any of the recent rows; null when it shows none. */
async function trayExplainer($: Engine): Promise<{ row: string; id: string } | null> {
  const rows = [...new Set([...(await answerRows($)), ...(await textRows($))])].slice(-60).reverse()
  for (const row of rows) {
    const f = await trayFocus($, row).catch(() => null)
    if (f && f.kind !== 'citation') return { row, id: f.id }
  }
  return null
}

export async function explainKey($: Engine, key: string, _until: number): Promise<Take | null> {
  if (key !== 'e' || !featureOn('explain')) return null
  const at = await trayExplainer($)
  if (!at) return null
  const g = (await partOf<ExplainPart>($, at.row, 'explain'))?.items?.[at.id]
  if (!g || g.kind === 'heads' || g.expanded) return null
  return {
    later: async () => {
      const why = await expandExplainer($, { row: at.row, kind: 'explain', id: at.id })
      if (why) failNotice($, why, 'explain')
    },
  }
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
}

export async function expandExplainer($: Engine, mark: MarkRef): Promise<string | null> {
  if (mark.kind !== 'explain') return mark.kind === 'heads' ? 'A heads-up is not written at more length.' : 'A citation is not an explainer.'
  const why = await expandGloss($, mark.row, mark.id)
  if (!why) $.ui.invalidate('ui.render')
  return why
}

/** For tests: the module's memory, cleared. */
export function resetExplain(): void {
  Object.assign(M, { session: '', loaded: false, glossed: [], headsGiven: [] })
}
