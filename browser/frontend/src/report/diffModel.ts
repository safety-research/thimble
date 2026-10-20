// What changed between two drafts of a document, for History's Compare: blocks aligned by a longest common
// subsequence, similar deleted/inserted blocks paired as changed, and changed blocks diffed by sentence, then by word.
// A citation stays one token. Pure and dependency-free.
import type { WriteupSection } from '../lib/types'

export type BlockKind = 'title' | 'heading' | 'subheading' | 'para' | 'item' | 'figure'

export interface DocBlock {
  kind: BlockKind
  /** the block's sentences, each its text with its citations as written (`[[value|ref]]`, `[[ref]]`) */
  sentences: string[]
  /** a figure's card */
  cell?: string
}

export type PartOp = 'eq' | 'ins' | 'del'
export interface DiffPart {
  op: PartOp
  text: string
}

/** `same` a block both drafts hold, `ins` one only the newer holds, `del` one only the older, `mod` one changed */
export type BlockOp = 'same' | 'ins' | 'del' | 'mod'
export interface DiffBlock {
  op: BlockOp
  kind: BlockKind
  parts: DiffPart[]
  cell?: string
}

export interface DocDiff {
  blocks: DiffBlock[]
  added: number
  removed: number
  changed: number
}

export interface DiffSource {
  title?: string | null
  sections: readonly WriteupSection[]
}

/** blocks whose likeness (word overlap) reaches this pair as one changed block; sentences, SENTENCE_PAIR */
export const BLOCK_PAIR = 0.35
export const SENTENCE_PAIR = 0.5
/** the largest table a subsequence is found in; beyond it the run is all deleted, then all inserted */
const CELLS_CAP = 400_000

const REF_RE = /\[\[[^[\]]*\]\]/g

/** A sentence's inline markdown as its text: a link its words, emphasis and code their letters. Citations stay. */
export function plainInline(text: string): string {
  return text
    .replace(/(^|[^[])\[([^[\]]+)\]\(([^)\s]+)\)/g, '$1$2')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A draft as blocks in reading order. */
export function docBlocks(doc: DiffSource): DocBlock[] {
  const out: DocBlock[] = []
  const title = plainInline(doc.title ?? '')
  if (title) out.push({ kind: 'title', sentences: [title] })
  for (const sec of doc.sections) {
    const figs = sec.figures ?? []
    const figure = (f: { cell: string | null; caption: string }): DocBlock => ({
      kind: 'figure',
      sentences: [plainInline(f.caption ?? '')],
      cell: f.cell ?? undefined,
    })
    const heading = plainInline(sec.heading ?? '')
    if (heading) out.push({ kind: sec.level && sec.level >= 3 ? 'subheading' : 'heading', sentences: [heading] })
    const pids = new Set(sec.paragraphs.map((p) => p.id))
    for (const f of figs) if ((f as { lead?: boolean }).lead) out.push(figure(f))
    for (const p of sec.paragraphs) {
      const sentences = (p.sentences ?? []).map((s) => plainInline(s.text)).filter(Boolean)
      if (sentences.length && (p.sentences ?? []).every((s) => s.bullet)) {
        for (const s of sentences) out.push({ kind: 'item', sentences: [s] })
      } else if (sentences.length) {
        out.push({ kind: 'para', sentences })
      }
      for (const f of figs) if ((f.after_paragraph ?? null) === p.id) out.push(figure(f))
    }
    for (const f of figs) if (!(f as { lead?: boolean }).lead && (!f.after_paragraph || !pids.has(f.after_paragraph))) out.push(figure(f))
  }
  return out
}

type Step = { op: 'eq'; i: number; j: number } | { op: 'del'; i: number } | { op: 'ins'; j: number }

/** The steps from `a` to `b` by a longest common subsequence of equal keys, the common ends trimmed first. */
export function align(a: readonly string[], b: readonly string[]): Step[] {
  let lo = 0
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++
  let ea = a.length
  let eb = b.length
  while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) {
    ea--
    eb--
  }
  const head: Step[] = Array.from({ length: lo }, (_, k) => ({ op: 'eq', i: k, j: k }))
  const tail: Step[] = Array.from({ length: a.length - ea }, (_, k) => ({ op: 'eq', i: ea + k, j: eb + k }))
  const n = ea - lo
  const m = eb - lo
  const mid: Step[] = []
  if (n * m > CELLS_CAP) {
    for (let i = lo; i < ea; i++) mid.push({ op: 'del', i })
    for (let j = lo; j < eb; j++) mid.push({ op: 'ins', j })
    return [...head, ...mid, ...tail]
  }
  // table[i][j]: the subsequence's length from a[lo+i] and b[lo+j] on
  const w = m + 1
  const table = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[i * w + j] = a[lo + i] === b[lo + j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1])
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[lo + i] === b[lo + j]) {
      mid.push({ op: 'eq', i: lo + i, j: lo + j })
      i++
      j++
    } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) {
      mid.push({ op: 'del', i: lo + i++ })
    } else {
      mid.push({ op: 'ins', j: lo + j++ })
    }
  }
  while (i < n) mid.push({ op: 'del', i: lo + i++ })
  while (j < m) mid.push({ op: 'ins', j: lo + j++ })
  return [...head, ...mid, ...tail]
}

/** A citation as its chip reads, `[[27]]` for `[[27|card:x]]` and the ref for a bare one, so a citation moved to
 * another record with the same value is no change of the text. */
export const chipKey = (s: string) =>
  s.replace(REF_RE, (m) => {
    const inner = m.slice(2, -2)
    const bar = inner.indexOf('|')
    return bar >= 0 ? `[[${inner.slice(0, bar)}]]` : m
  })

const norm = (s: string) => chipKey(s).replace(/\s+/g, ' ').trim()

/** The words of a text, lower case, citations as themselves. */
const wordsOf = (s: string) => new Set(chipKey(s).toLowerCase().match(/\[\[[^[\]]*\]\]|[\p{L}\p{N}]+/gu) ?? [])

/** How alike two texts read: the share of their words both hold (Dice), 0 to 1. */
export function likeness(a: string, b: string): number {
  const x = wordsOf(a)
  const y = wordsOf(b)
  if (!x.size && !y.size) return 1
  let both = 0
  for (const t of x) if (y.has(t)) both++
  return (2 * both) / (x.size + y.size)
}

/** A text's tokens: each citation whole, each run of spaces, each word with its punctuation. */
export function tokens(s: string): string[] {
  return s.match(/\[\[[^[\]]*\]\]|\s+|[^\s[]+|\[/g) ?? []
}

/** Parts with the same op run together, and in each stretch of changes the deleted text before the inserted. */
function tidy(parts: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = []
  let del = ''
  let ins = ''
  const flush = () => {
    if (del) out.push({ op: 'del', text: del })
    if (ins) out.push({ op: 'ins', text: ins })
    del = ''
    ins = ''
  }
  for (const p of parts) {
    if (!p.text) continue
    if (p.op === 'del') del += p.text
    else if (p.op === 'ins') ins += p.text
    else {
      flush()
      const last = out[out.length - 1]
      if (last && last.op === 'eq') last.text += p.text
      else out.push({ ...p })
    }
  }
  flush()
  return out
}

/** Two sentences word by word; a space between two changes goes with them, so the change reads as one phrase. */
export function wordDiff(a: string, b: string): DiffPart[] {
  const ta = tokens(a)
  const tb = tokens(b)
  const steps = align(ta.map(chipKey), tb.map(chipKey))
  const raw: DiffPart[] = steps.map((s) => (s.op === 'eq' ? { op: 'eq', text: tb[s.j] } : s.op === 'del' ? { op: 'del', text: ta[s.i] } : { op: 'ins', text: tb[s.j] }))
  const changed = (p: DiffPart | undefined) => p != null && p.op !== 'eq'
  const spread: DiffPart[] = []
  raw.forEach((p, k) => {
    if (p.op === 'eq' && /^\s+$/.test(p.text) && changed(raw[k - 1]) && changed(raw[k + 1])) {
      spread.push({ op: 'del', text: p.text }, { op: 'ins', text: p.text })
    } else spread.push(p)
  })
  return tidy(spread)
}

/** Pair the deleted and inserted items of one stretch whose kinds match and that read alike, in order. */
function pairUp<T>(dels: T[], inss: T[], fits: (d: T, i: T) => boolean): Map<number, number> {
  const pairs = new Map<number, number>() // del index -> ins index
  let from = 0
  dels.forEach((d, k) => {
    for (let x = from; x < inss.length; x++) {
      if (fits(d, inss[x])) {
        pairs.set(k, x)
        from = x + 1
        return
      }
    }
  })
  return pairs
}

/** Walk the steps, handing each stretch of deletions and insertions between two kept items to `stretch`. */
function stretches(steps: Step[], keep: (s: Extract<Step, { op: 'eq' }>) => void, stretch: (dels: number[], inss: number[]) => void) {
  let dels: number[] = []
  let inss: number[] = []
  const flush = () => {
    if (dels.length || inss.length) stretch(dels, inss)
    dels = []
    inss = []
  }
  for (const s of steps) {
    if (s.op === 'eq') {
      flush()
      keep(s)
    } else if (s.op === 'del') dels.push(s.i)
    else inss.push(s.j)
  }
  flush()
}

/** In a stretch, deleted items before inserted ones; a paired deletion is emitted with its insertion. */
function emitStretch(dels: number[], inss: number[], pairs: Map<number, number>, on: {
  del: (i: number) => void
  ins: (j: number) => void
  pair: (i: number, j: number) => void
}) {
  const byIns = new Map<number, number>()
  pairs.forEach((x, k) => byIns.set(x, k))
  const pairedDels = [...pairs.keys()].sort((p, q) => p - q)
  let d = 0
  const upTo = (end: number) => {
    for (; d < end; d++) if (!pairs.has(d)) on.del(dels[d])
  }
  inss.forEach((j, x) => {
    const k = byIns.get(x)
    upTo(pairedDels.find((p) => p >= d) ?? dels.length)
    if (k != null) {
      d = k + 1
      on.pair(dels[k], j)
    } else on.ins(j)
  })
  upTo(dels.length)
}

/** A changed block's sentences: kept ones as they are, a pair that reads alike word by word, the rest whole. */
export function sentenceDiff(a: readonly string[], b: readonly string[]): DiffPart[] {
  const parts: DiffPart[] = []
  const gap = () => {
    if (parts.length) parts.push({ op: 'eq', text: ' ' })
  }
  const steps = align(a.map(norm), b.map(norm))
  stretches(
    steps,
    (s) => {
      gap()
      parts.push({ op: 'eq', text: b[s.j] })
    },
    (dels, inss) => {
      const pairs = pairUp(dels, inss, (i, j) => likeness(a[i], b[j]) >= SENTENCE_PAIR)
      emitStretch(dels, inss, pairs, {
        del: (i) => {
          gap()
          parts.push({ op: 'del', text: a[i] })
        },
        ins: (j) => {
          gap()
          parts.push({ op: 'ins', text: b[j] })
        },
        pair: (i, j) => {
          gap()
          parts.push(...wordDiff(a[i], b[j]))
        },
      })
    },
  )
  return tidy(parts)
}

const keyOf = (b: DocBlock) => `${b.kind}\u0000${b.cell ?? ''}\u0000${norm(b.sentences.join(' '))}`
const family = (k: BlockKind) => (k === 'title' || k === 'heading' || k === 'subheading' ? 'head' : k)

/** What changed from draft `older` to draft `newer`. */
export function diffDocs(older: DiffSource, newer: DiffSource): DocDiff {
  const a = docBlocks(older)
  const b = docBlocks(newer)
  const blocks: DiffBlock[] = []
  const whole = (op: 'same' | 'ins' | 'del', x: DocBlock): DiffBlock => ({
    op,
    kind: x.kind,
    cell: x.cell,
    parts: [{ op: op === 'same' ? 'eq' : op, text: x.sentences.join(' ') }],
  })
  stretches(
    align(a.map(keyOf), b.map(keyOf)),
    (s) => blocks.push(whole('same', b[s.j])),
    (dels, inss) => {
      const pairs = pairUp(dels, inss, (i, j) => {
        const x = a[i]
        const y = b[j]
        if (family(x.kind) !== family(y.kind)) return false
        if (x.kind === 'figure') return x.cell === y.cell
        return likeness(x.sentences.join(' '), y.sentences.join(' ')) >= BLOCK_PAIR
      })
      emitStretch(dels, inss, pairs, {
        del: (i) => blocks.push(whole('del', a[i])),
        ins: (j) => blocks.push(whole('ins', b[j])),
        pair: (i, j) => blocks.push({ op: 'mod', kind: b[j].kind, cell: b[j].cell, parts: sentenceDiff(a[i].sentences, b[j].sentences) }),
      })
    },
  )
  return {
    blocks,
    added: blocks.filter((x) => x.op === 'ins').length,
    removed: blocks.filter((x) => x.op === 'del').length,
    changed: blocks.filter((x) => x.op === 'mod').length,
  }
}

/** A diff's one line: `2 added · 1 removed · 3 changed`, or `No changes`. */
export function diffLine(d: Pick<DocDiff, 'added' | 'removed' | 'changed'>): string {
  const bits = [d.added && `${d.added} added`, d.removed && `${d.removed} removed`, d.changed && `${d.changed} changed`].filter(Boolean)
  return bits.length ? bits.join(' · ') : 'No changes'
}

export type TextPiece = { text: string } | { ref: string; value: string | null }

/** A part's text as plain text and citations: `[[value|ref]]` a citation with its value, `[[ref]]` a bare one. */
export function splitRefs(text: string): TextPiece[] {
  const out: TextPiece[] = []
  let at = 0
  for (const m of text.matchAll(REF_RE)) {
    const idx = m.index ?? 0
    if (idx > at) out.push({ text: text.slice(at, idx) })
    const inner = m[0].slice(2, -2)
    const bar = inner.indexOf('|')
    out.push(bar >= 0 ? { ref: inner.slice(bar + 1).trim(), value: inner.slice(0, bar) } : { ref: inner.trim(), value: null })
    at = idx + m[0].length
  }
  if (at < text.length) out.push({ text: text.slice(at) })
  return out
}

export type DiffItem = { blocks: DiffBlock[] } | { fold: DiffBlock[] }

/** blocks kept beside a change on each side of a folded run */
export const CONTEXT_BLOCKS = 1
/** the shortest run of unchanged blocks that folds */
export const FOLD_MIN = 3

/** The diff's blocks with each long run of unchanged ones folded but for CONTEXT_BLOCKS beside a change; a diff with no
 * change folds nothing, so the draft reads whole. */
export function foldSame(blocks: readonly DiffBlock[]): DiffItem[] {
  if (!blocks.some((b) => b.op !== 'same')) return blocks.length ? [{ blocks: [...blocks] }] : []
  const out: DiffItem[] = []
  const shown = (xs: DiffBlock[]) => {
    if (!xs.length) return
    const last = out[out.length - 1]
    if (last && 'blocks' in last) last.blocks.push(...xs)
    else out.push({ blocks: xs })
  }
  for (let k = 0; k < blocks.length; ) {
    if (blocks[k].op !== 'same') {
      shown([blocks[k++]])
      continue
    }
    const start = k
    while (k < blocks.length && blocks[k].op === 'same') k++
    const run = blocks.slice(start, k)
    const head = start === 0 ? 0 : CONTEXT_BLOCKS
    const tail = k === blocks.length ? 0 : CONTEXT_BLOCKS
    if (run.length - head - tail < FOLD_MIN) {
      shown(run)
      continue
    }
    shown(run.slice(0, head))
    out.push({ fold: run.slice(head, run.length - tail) })
    shown(run.slice(run.length - tail))
  }
  return out
}
