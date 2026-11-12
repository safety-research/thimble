// A reply's marks, as the server checks them (backend features/marks.py). A mark is a markdown link to `#` on the words
// of a claim, `[352](#)`, found with the terminal plugin's own module (plugin/marks/message.js), so the page, the
// terminal and the server read the same marks.
//
// A mark draws as a card's citation does (components/RefChip): the words in the text's own color, underlined in the
// citations' purple, their light purple tint on hover. Once its check settled it has one of two looks:
//   verified   the plain look; a corrected mark shows its corrected words and looks verified too
//   failed     the check could not confirm it (wrong, not confirmed, or no check could run): red words, underlined,
//              `×` after them and a soft red tint on hover, as the terminal draws it
// and a verified one whose source changed after its check is `stale`: amber words, underlined, `↻` after them, as the
// terminal draws it (plugin/marks/stale.ts); Repair checks it again.
// While its check runs (`checking`) it has the plain look and a spinner. Before any check said anything of it
// (`pending`: the reply still streams, or no check has begun on it) its underline is dotted: not checked, so it never
// reads as a checked mark. Its label says which in one word at its upper right (stateOf), as the terminal's card does.
import { marksIn, rewritesIn, withCorrections } from '../../../../plugin/marks/message.js'
import { checkStatus, staleOf } from '../../../../plugin/tray/tray.mjs'

/** A table the evidence shows (evidence.py table_of): the rows around the cited one, the cited cell `at` among them
 * (c = -1: the row's name), and how many rows are left out above and below. */
export interface EvidenceTable {
  corner: string
  cols: string[]
  rows: { label: string; values: string[] }[]
  at: { r: number; c: number }
  above?: number
  below?: number
  /** the other cited cells of words that hold several values (a range, a pair) */
  also?: { r: number; c: number }[]
}

/** One piece of evidence a mark's check found (backend: the terminal's engine/kernel/evidence.py). */
export interface Evidence {
  kind: 'computed' | 'quote' | 'code' | 'card'
  /** card: the card, its title, the place as a card's citation names it (`card:<id>#<col>/<row>`,
   * `card:<id>@out<i>#L<n>`) and the value there */
  card?: string
  title?: string
  ref?: string
  value?: string
  /** a card's cell, or printed output that is a table: the header and the rows around the cited one */
  table?: EvidenceTable
  /** computed: the code that ran, its real output, the spans of the output that show the words, and who ran it */
  code?: string
  output?: string
  highlight?: [number, number][]
  by?: string
  /** quote and code: the place, its lines around it, and the spans of each cited line that hold the words */
  file?: string
  line?: string | number
  lines?: { n: number; text: string; highlight?: [number, number] }[]
  places?: Evidence[]
  /** card: the places of words that hold several values; places of another card or output, and a quote's other places */
  refs?: string[]
  more?: Evidence[]
  /** card: a label's card as the label was when the cited words were written, or an earlier version of it (backend
   * label_versions): the version, when it was made (seconds since the epoch), what made it, and what changed after it
   * by the check */
  version?: number
  at?: number
  made?: string
  after?: string
}

/** A mark as the server keeps it: its place in the turn (its text `piece`, its order `k` among that text's marks), its
 * number in the check `n`, its words, and what the check found. */
export interface MarkItem {
  n: number
  piece: number
  k: number
  words: string
  sentence: string
  status: 'checking' | 'verified' | 'corrected' | 'failed' | 'unchecked'
  shown?: string
  was?: string
  reason?: string
  failedBy?: 'check' | 'evidence' | 'none'
  evidence?: Evidence | Evidence[]
  note?: string
  /** corrected: only `shown`, a part of the words, is cited; the rest stays in the text as Claude's own words */
  narrowed?: boolean
  /** corrected: the sentence the check wrote in place of the mark's own (each citation `[words]`) */
  rewrite?: string
  /** the check runs because the analyst pressed Repair */
  repair?: boolean
  /** what a verified or corrected mark rests on, as its check read it (the terminal's plugin/marks/store.ts Source):
   * `changed` or `gone` once that differs from the file now, which makes the mark stale */
  sources?: { file: string; path: string; line?: string; size: number; mtime: number; sha256: string; changed?: boolean; gone?: boolean }[]
  /** where the mark is kept, which Repair names: a reply's turn, or the card whose takeaway holds it */
  turn?: string
  card?: string
}

export type MarkLook = 'pending' | 'checking' | 'verified' | 'stale' | 'failed'

/** How a mark draws now: `pending` while its reply streams or no check has said anything yet; a corrected mark is
 * verified, one whose source changed after its check stale, and a mark the check found wrong, could not confirm or
 * could not check is failed. Pure. */
export function lookOf(item: MarkItem | undefined): MarkLook {
  if (!item) return 'pending'
  if (staleOf(item).length) return 'stale'
  if (item.status === 'corrected') return 'verified'
  if (item.status === 'failed' || item.status === 'unchecked') return 'failed'
  return item.status
}

/** A text as the analyst reads it once its check settled, as the terminal shows it (plugin/marks/message.js): each
 * sentence a check rewrote in place of Claude's, and each corrected citation's words in place of its own. A rewrite that
 * cannot stand in the text leaves Claude's sentence, whose words the check did not confirm: its mark draws failed. Pure. */
export function asChecked(text: string, checks: readonly (MarkItem | undefined)[]): { text: string; checks: (MarkItem | undefined)[] } {
  if (!checks.some((m) => m?.status === 'corrected')) return { text, checks: [...checks] }
  const { text: rewritten, placed } = rewritesIn(text, checks)
  const out = checks.map((m, k) =>
    m?.status === 'corrected' && m.rewrite && !placed.has(k) ? { ...m, status: 'failed' as const, failedBy: 'evidence' as const, shown: m.words, reason: m.reason || 'The check rewrote this sentence, but its new sentence does not fit the reply.' } : m,
  )
  return { text: withCorrections(rewritten, out), checks: out }
}

/** Whether Repair can check a mark again: it failed (or no check ran) or it is stale, no check of it runs, and its
 * place is known. */
export function canRepair(item: MarkItem | undefined): boolean {
  return !!item && (item.status === 'failed' || item.status === 'unchecked' || staleOf(item).length > 0) && !!(item.turn || item.card)
}

/** What a mark's label says of its state, at its upper right: the terminal's sign and word for it (plugin/tray/tray.mjs
 * checkStatus: ✓ verified, a corrected mark too, × failed, ↻ stale, `spin` checking), and before any check `not checked
 * yet`; `tone` names its color (good, bad, warn, dim). The one thing the label says of the check. Pure. */
export function stateOf(item: MarkItem | undefined, look: MarkLook): { sign: string; word: string; tone: string } {
  if (look === 'pending' || !item) return { sign: '', word: LOOK_WORD.pending, tone: 'dim' }
  const { sign, word, tone } = checkStatus(item)
  return { sign, word, tone }
}

/** Why a failed mark failed, in one line: the check's reason, else what kind of failure it was. Pure. */
export function failedWhy(item: MarkItem | undefined): string {
  const why = (item?.reason ?? '').replace(/\s+/g, ' ').trim()
  if (why) return why
  if (item?.status === 'unchecked') return 'No check could run.'
  return 'The check could not confirm this.'
}

/** The words a person reads for a look. */
export const LOOK_WORD: Record<MarkLook, string> = {
  pending: 'not checked yet',
  checking: 'checking',
  verified: 'verified',
  stale: 'stale',
  failed: 'not confirmed',
}

/** A citation in drawn text, for a closest() test: a ref's chip (components/RefChip) or a mark (Mark.tsx), which is how
 * a card's value is cited. A click on one opens its evidence, never the editor of the text it stands in. */
export const CITATION = '.refchip, .mark'

/** The href a mark is written with for the markdown parser: `#mark-<k>`, its order among the text's marks. */
export const MARK_HREF = /^#mark-(\d+)$/

/** `text` with each mark's `(#)` written as `(#mark-<k>)`, so the markdown parser keeps each mark's place. Pure. */
export function withMarkHrefs(text: string): string {
  const marks = marksIn(text)
  if (!marks.length) return text
  let out = ''
  let at = 0
  marks.forEach((m, k) => {
    out += `${text.slice(at, m.start)}[${m.words}](#mark-${k})`
    at = m.end
  })
  return out + text.slice(at)
}

/** A card's takeaway's marks as the check left them (backend notebook.takeaway_marks), by their order in the takeaway;
 * none while no check has started on the takeaway as it reads now (each draws pending). Pure. */
export function takeawayChecks(cell: { id?: string; takeaway?: string; takeaway_marks?: { text?: string; items?: MarkItem[] } }): (MarkItem | undefined)[] {
  const kept = cell.takeaway_marks
  if (!kept || kept.text !== cell.takeaway || !Array.isArray(kept.items)) return []
  const out: (MarkItem | undefined)[] = []
  for (const m of kept.items) if (typeof m?.k === 'number') out[m.k] = cell.id ? { ...m, card: cell.id } : m
  return out
}
