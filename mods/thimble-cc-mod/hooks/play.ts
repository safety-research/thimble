// Playing an answer as an animated report (pure, no `$`): the storyboard built from the answer's own text and cards,
// each scene's timing, and the player's clock and keys. register.tsx builds the storyboard, play.tsx plays it.
//
// - A title scene: the heading the answer opens with, else its opening line (a card's question when it opens with a card),
//   with the scenes to come listed one by one; text before the first heading that no card takes types under it.
// - One scene per card, under the heading of its section. Each paragraph of a section goes to the card it cites, else
//   to the card just before it (its takeaway), else to the next card; its sentences are the scene's captions, each
//   with the paragraph it is from, so the player shows them as the paragraphs they were.
// - A section without a card is one scene of its paragraphs. An answer without cards plays one scene per paragraph,
//   numbered, its cited values shown as tiles.
// - Each caption names the value it cites on the scene's card (`focus`, a ref) or among its tiles, so the player
//   lights that value while the caption is on screen.
import type { Focus } from './anim'
import { plainCites } from './cite'
import type { ChipView } from './cite'
import { cut, width } from './draw'
import type { CardData } from './draw'
import { EMBED_RE, chipLabel, citations, citeSpans } from './lib'
import type { Citation, Run } from './lib'

/** `para`: which paragraph of its scene the sentence is from, so the player runs a paragraph's sentences on and sets
 *  paragraphs apart; `item`: that paragraph is a list item. A video's lines of narration have neither. */
export type Caption = { text: string; focus: string; para?: number; item?: boolean }
export type SceneKind = 'title' | 'card' | 'text'
export type Scene = {
  kind: SceneKind
  /** the section's heading; a title scene's title */
  heading: string
  card?: string
  /** a paragraph's number, in an answer without cards */
  n?: number
  captions: Caption[]
  /** a text scene's cited values with a shown value, each once */
  numbers?: Citation[]
  /** a title scene's list of the scenes to come */
  contents?: string[]
  /** a video report's scene (report.ts): each caption is a line of narration, `secs` long and followed by `pauses`
   *  seconds of silence, so the scene runs at a speaking pace rather than the typing pace */
  secs?: number[]
  pauses?: number[]
}

/** A caption as the player draws it: its words as runs, each citation a chip with its claim's key, and the value it
 *  cites on the scene's card. */
export type PlayCap = { block: { prefix: string; heading: number; quote: boolean; runs: Run[] }; chips: ChipView[]; ids: string[]; raws: string[]; focus: Focus | null }
/** A cited value shown as a tile: what it shows, and a short name of its place. */
export type PlayTile = { ref: string; display: string; place: string }
/** A scene as register.tsx hands it to the player: with its card's data, its captions drawn, its tiles. */
export type PlayScene = Scene & { data?: CardData; why?: string; caps: PlayCap[]; tiles?: PlayTile[] }

type Para = { text: string; item: boolean }
type Chunk = { kind: 'head'; text: string } | { kind: 'card'; id: string } | ({ kind: 'para' } & Para)

/** The answer as headings, card embeds and paragraphs (a list item is one); code, tables and rules are left out. */
function chunksOf(answer: string): Chunk[] {
  const out: Chunk[] = []
  let para: string[] = []
  let item = false
  const flush = () => {
    const text = para.join(' ').trim()
    if (text) out.push({ kind: 'para', text, item })
    para = []
    item = false
  }
  const lines = answer.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/^\s*```/.test(line)) {
      flush()
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) i++
      continue
    }
    const embed = EMBED_RE.exec(line)
    if (embed) {
      flush()
      out.push({ kind: 'card', id: (embed[1] ?? embed[2])! })
      continue
    }
    const head = /^#{1,6}\s+(.*)$/.exec(line)
    if (head) {
      flush()
      out.push({ kind: 'head', text: head[1]!.trim() })
      continue
    }
    if (!line.trim() || /^\s*\|/.test(line) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush()
      continue
    }
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (bullet) {
      flush()
      para.push(bullet[1]!)
      item = true
      continue
    }
    para.push(line.replace(/^\s*>\s?/, '').trim())
  }
  flush()
  return out
}

/** A paragraph's sentences, cut where cite.ts's sentenceAt cuts (a full stop inside a citation or code is none), so a
 *  caption's claims are the reply's own. */
export function sentences(text: string): string[] {
  const out: string[] = []
  const spans = citeSpans(text)
  let start = 0
  for (const m of text.matchAll(/[.!?](?=\s|$)/g)) {
    const i = (m.index ?? 0) + 1
    const before = text.slice(0, i)
    if (spans.some(sp => sp.at < i && i < sp.end)) continue
    if ((before.match(/`/g)?.length ?? 0) % 2) continue
    const s = text.slice(start, i).trim()
    if (s) out.push(s)
    start = i
  }
  const rest = text.slice(start).trim()
  if (rest) out.push(rest)
  return out
}

const citesCard = (text: string, id: string) => citations(text).some(c => c.ref === `card:${id}` || c.ref.startsWith(`card:${id}#`))

/** The captions of a scene: each sentence of its paragraphs, with its paragraph's place and the ref of the value it
 *  cites on `card` (a value of the card, or a record the card shows when `data` says so) or among `numbers`. */
function captionsOf(paras: Para[], card?: string, data?: CardData | null, focusOf?: (data: CardData, ref: string) => boolean, numbers?: Citation[]): Caption[] {
  return paras.flatMap((p, para) =>
    sentences(p.text).map(text => {
      const cs = citations(text)
      let focus = ''
      if (card) focus = cs.find(c => c.ref.startsWith(`card:${card}#`))?.ref ?? (data && focusOf ? (cs.find(c => focusOf(data, c.ref))?.ref ?? '') : '')
      else if (numbers) focus = cs.find(c => numbers.some(n => n.ref === c.ref))?.ref ?? ''
      return { text, focus, para, ...(p.item ? { item: true } : {}) }
    }),
  )
}

/** Cited numbers, then quotes, each place once (link words such as "for example" are no value): a text scene's tiles. */
export function numbersIn(paras: string[]): Citation[] {
  const seen = new Set<string>()
  const cs = paras.flatMap(p => citations(p)).filter(c => c.display !== null && !seen.has(c.ref) && Boolean(seen.add(c.ref)))
  const num = cs.filter(c => /^[^\s\d]{0,2}\d[\d,.]*\s*\S{0,4}$/.test(c.display!.trim()))
  const quote = cs.filter(c => /^["“'‘]/.test(c.display!.trim()))
  return [...num, ...quote].slice(0, 9)
}

/** What a tile's value is, under it: a card's value by its column and row ("labels · All 107 groups"), a whole card by
 *  its question, a command's output by its line, a file's place as its link names it. `cardOf` gives the cited card
 *  when it is loaded, which tells a column whose name holds a slash. */
export function tilePlace(ref: string, cardOf?: (id: string) => CardData | null | undefined): string {
  const m = /^card:([A-Za-z0-9_-]+)(?:#(.*))?$/.exec(ref)
  if (m) {
    const card = cardOf?.(m[1]!)
    const frag = (m[2] ?? '').trim()
    if (!frag) return card?.question || 'a card'
    const names = card ? [card.y || 'value', ...(card.columns ?? []), ...(card.series ?? []).map(s => s.name)] : []
    const col = names.filter(n => n && frag.startsWith(`${n}/`)).sort((a, b) => b.length - a.length)[0] ?? frag.split('/')[0]!
    const row = frag.slice(col.length + 1)
    return row ? `${col} · ${row}` : col
  }
  const call = /^call:[A-Za-z0-9_-]+(?:#L(\d+)(?:-L?(\d+))?)?$/.exec(ref)
  if (call) return call[1] ? `output · line ${call[1]}${call[2] ? `-${call[2]}` : ''}` : 'output'
  return chipLabel({ raw: `[[${ref}]]`, ref, display: null })
}

/** A card's top line in the player and the film, `inner` wide: its question, and at its right the label of the value
 *  lit. The question keeps its words; the label is cut first, to no less than a third of the line. */
export function headParts(question: string, tip: string, inner: number): { q: string; tip: string } {
  if (!tip) return { q: cut(question, inner), tip: '' }
  const t = cut(tip, Math.min(width(tip), Math.max(Math.floor(inner / 3), inner - width(question) - 2)))
  return { q: cut(question, Math.max(8, inner - width(t) - 2)), tip: t }
}

export type StoryOpts = {
  /** a card's data, to title an answer that opens with a card and to find a record a caption cites on it */
  card?: (id: string) => CardData | null | undefined
  /** whether a ref names something on a card (anim.ts focusFromRef) */
  focusOf?: (data: CardData, ref: string) => boolean
}

export function storyboard(answer: string, opts: StoryOpts = {}): Scene[] {
  const chunks = chunksOf(answer)
  const secs: { heading: string; items: Chunk[] }[] = [{ heading: '', items: [] }]
  for (const c of chunks) {
    if (c.kind === 'head') secs.push({ heading: c.text, items: [] })
    else secs.at(-1)!.items.push(c)
  }
  // a heading is the title only when the answer opens with it; else the opening line, which then does not type again
  const head = chunks.find(c => c.kind === 'head')
  const first = chunks[0]
  const opening = first?.kind === 'para' ? (sentences(first.text)[0] ?? '') : ''
  const title =
    first?.kind === 'head'
      ? first.text
      : opening ||
        (first?.kind === 'card' ? (opts.card?.(first.id)?.question ?? '') : '') ||
        (head?.kind === 'head' ? head.text : '')
  const top: Scene = { kind: 'title', heading: plainCites(title).replace(/\*\*|__|`/g, ''), captions: [], contents: [] }
  const scenes: Scene[] = [top]
  const hasCards = chunks.some(c => c.kind === 'card')
  let n = 0
  secs.forEach((sec, si) => {
    const paras = sec.items.flatMap(c => (c.kind === 'para' ? [{ text: c.text, item: c.item }] : []))
    const texts = paras.map(p => p.text)
    if (!hasCards) {
      for (const p of paras) {
        const numbers = numbersIn([p.text])
        scenes.push({ kind: 'text', heading: sec.heading, n: ++n, captions: captionsOf([p], undefined, null, undefined, numbers), numbers })
      }
      return
    }
    const cards = [...new Set(sec.items.flatMap(c => (c.kind === 'card' ? [c.id] : [])))]
    if (!cards.length) {
      if (!paras.length) return
      // the text before the first heading, or under the heading the answer opens with, types under the title
      if (si === 0 || (si === 1 && first?.kind === 'head')) top.captions.push(...captionsOf(paras).filter((c, i) => !(i === 0 && opening && c.text === opening)))
      else {
        const numbers = numbersIn(texts)
        scenes.push({ kind: 'text', heading: sec.heading, captions: captionsOf(paras, undefined, null, undefined, numbers), numbers })
      }
      return
    }
    const byCard = new Map<string, Para[]>(cards.map(id => [id, []]))
    let prev = ''
    let sincePrev = 0
    sec.items.forEach((c, i) => {
      if (c.kind === 'card') {
        prev = c.id
        sincePrev = 0
        return
      }
      if (c.kind !== 'para') return
      const next = sec.items.slice(i + 1).find(x => x.kind === 'card')
      const nextId = next?.kind === 'card' ? next.id : ''
      const cited = cards.find(id => citesCard(c.text, id))
      const to = cited ?? (prev && (sincePrev === 0 || !nextId) ? prev : nextId || prev)
      sincePrev++
      byCard.get(to)!.push({ text: c.text, item: c.item })
    })
    for (const id of cards) scenes.push({ kind: 'card', heading: sec.heading, card: id, captions: captionsOf(byCard.get(id)!, id, opts.card?.(id), opts.focusOf) })
  })
  // the title scene lists what comes: each scene's heading once, else its card's question, else its first words
  const contents: string[] = []
  for (const s of scenes.slice(1)) {
    const name = s.heading || (s.card ? (opts.card?.(s.card)?.question ?? '') : '') || plainCites(s.captions[0]?.text ?? '')
    const line = plainCites(name).replace(/\*\*|__|`/g, '')
    if (line && contents.at(-1) !== line) contents.push(line)
  }
  top.contents = contents
  return scenes
}

// ------------------------------------------------------------------------------------------------ timing

export const FRAME_MS = 80
export const ANIM_MS = 2000
const TITLE_MS = 1400
const CHARS_PER_S = 55
const HOLD_MS = 1600

/** When a scene's animation ends, when each caption starts and ends typing, and how long the scene lasts: the
 *  animation, then the captions typed at one speed (1.2 to 4.5 s in all), then a pause; 5 to 8 s (a title 3.5 s). */
export type Timing = { anim: number; starts: number[]; ends: number[]; total: number }

export function timing(scene: Scene): Timing {
  if (scene.secs?.length) return pacedTiming(scene, scene.secs)
  const anim = scene.kind === 'title' ? TITLE_MS : ANIM_MS
  const lens = scene.captions.map(c => Math.max(1, plainCites(c.text).length))
  const sum = lens.reduce((a, b) => a + b, 0)
  const typing = sum ? Math.min(4500, Math.max(1200, (sum / CHARS_PER_S) * 1000)) : 0
  const starts: number[] = []
  const ends: number[] = []
  let at = anim
  for (const l of lens) {
    starts.push(Math.round(at))
    at += (typing * l) / sum
    ends.push(Math.round(at))
  }
  return { anim, starts, ends, total: Math.round(Math.max(at + HOLD_MS, scene.kind === 'title' ? 3500 : 5000)) }
}

const LEAD_MS = 500
const PACED_CHARS_PER_S = 40
const PACED_HOLD_MS = 700

/** A narrated scene: each line starts once the one before it has been said and its pause kept (the first half a second
 *  in, while the card draws), types in at a reading speed, and stays until the next starts. */
function pacedTiming(scene: Scene, secs: number[]): Timing {
  const anim = scene.kind === 'title' ? TITLE_MS : ANIM_MS
  const starts: number[] = []
  const ends: number[] = []
  let at = LEAD_MS
  scene.captions.forEach((c, i) => {
    const window = Math.max(1000, (secs[i] ?? 4.5) * 1000)
    starts.push(Math.round(at))
    ends.push(Math.round(at + Math.min(window, (Math.max(1, plainCites(c.text).length) / PACED_CHARS_PER_S) * 1000)))
    at += window + Math.max(0, (scene.pauses?.[i] ?? 0) * 1000)
  })
  return { anim, starts, ends, total: Math.round(Math.max(at + PACED_HOLD_MS, anim + PACED_HOLD_MS)) }
}

const clamp = (v: number) => Math.max(0, Math.min(1, v))

/** A scene at `ms`: the animation's progress t, how much of each caption is typed (0 to 1), and the caption on
 *  screen (the one typing, or the last typed; -1 before the first). */
export type SceneFrame = { t: number; typed: number[]; current: number }

export function frameAt(scene: Scene, ms: number, tm: Timing = timing(scene)): SceneFrame {
  const typed = tm.starts.map((s, i) => clamp((ms - s) / Math.max(1, tm.ends[i]! - s)))
  let current = -1
  typed.forEach((f, i) => {
    if (f > 0) current = i
  })
  return { t: clamp(ms / tm.anim), typed, current }
}

// ------------------------------------------------------------------------------------------------ the clock and keys

export type PlayState = { scene: number; ms: number; paused: boolean; done: boolean }
export const START: PlayState = { scene: 0, ms: 0, paused: false, done: false }
export type PlayOp = 'pause' | 'back' | 'next' | 'restart' | 'close'

/** What a key does in the player: space pauses and resumes, ←/→ step scenes, r restarts, q closes; p, b and n are
 *  the panel buttons' letters for the first three. */
export function keyOp(key: string): PlayOp | null {
  switch (key) {
    case ' ':
    case 'space':
    case 'p':
      return 'pause'
    case 'left':
    case 'b':
      return 'back'
    case 'right':
    case 'n':
      return 'next'
    case 'r':
      return 'restart'
    case 'q':
      return 'close'
    default:
      return null
  }
}

/** The clock moved on `dt` ms: the scene's time, then the next scene, and at the end of the last it stops there. */
export function tick(st: PlayState, dt: number, tms: readonly Timing[]): PlayState {
  if (st.paused || st.done || !tms.length) return st
  const total = tms[st.scene]?.total ?? 0
  const ms = st.ms + dt
  if (ms < total) return { ...st, ms }
  if (st.scene >= tms.length - 1) return { ...st, ms: total, done: true }
  return { ...st, scene: st.scene + 1, ms: 0 }
}

/** A step while paused shows the scene whole, so a paused player is never left on an empty chart. */
export function seek(st: PlayState, scene: number, tms: readonly Timing[]): PlayState {
  const tm = tms[scene]
  return { scene, ms: st.paused && tm ? (tm.ends.at(-1) ?? tm.anim) : 0, paused: st.paused, done: false }
}

export function applyOp(st: PlayState, op: PlayOp, tms: readonly Timing[]): PlayState {
  const last = tms.length - 1
  switch (op) {
    case 'pause':
      return st.done ? { ...START } : { ...st, paused: !st.paused }
    case 'back':
      return seek(st, Math.max(0, st.scene - 1), tms)
    case 'next':
      return st.scene >= last ? { ...st, scene: Math.max(0, last), ms: tms[last]?.total ?? 0, done: true } : seek(st, st.scene + 1, tms)
    case 'restart':
      return { ...START }
    default:
      return st
  }
}

/** How far the whole play is, in ms, of how long. */
export function progress(st: PlayState, tms: readonly Timing[]): { at: number; total: number } {
  const total = tms.reduce((a, t) => a + t.total, 0)
  const at = tms.slice(0, st.scene).reduce((a, t) => a + t.total, 0) + st.ms
  return { at: Math.min(at, total), total }
}

/** The scene at a point of the progress bar (0 to 1). */
export function sceneAt(frac: number, tms: readonly Timing[]): number {
  const total = tms.reduce((a, t) => a + t.total, 0)
  let at = 0
  for (let i = 0; i < tms.length; i++) {
    at += tms[i]!.total
    if (frac * total < at) return i
  }
  return Math.max(0, tms.length - 1)
}

export function clockText(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
