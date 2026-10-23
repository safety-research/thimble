// A reply's marks, as the server checks them (backend features/marks.py). A mark is a markdown link to `#` on the words
// of a claim, `[352](#)`, found with the terminal plugin's own module (plugin/marks/message.js), so the page, the
// terminal and the server read the same marks.
//
// A mark draws as a card's citation does (components/RefChip): the words in the text's color over a thin accent
// underline. Once its check settled it has one of two looks:
//   verified   the plain look; a corrected mark shows its corrected words and looks verified too
//   failed     the check could not confirm it (wrong, not confirmed, or no check could run): a dashed underline in red
//              and `×` after the words, as the terminal draws it
// While the reply streams (`pending`) and while its check runs (`checking`) it has the plain look.
import { marksIn } from '../../../../plugin/marks/message.js'

/** A table the evidence shows (evidence.py table_of): the rows around the cited one, the cited cell `at` among them
 * (c = -1: the row's name), and how many rows are left out above and below. */
export interface EvidenceTable {
  corner: string
  cols: string[]
  rows: { label: string; values: string[] }[]
  at: { r: number; c: number }
  above?: number
  below?: number
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
  failedBy?: 'check' | 'evidence'
  evidence?: Evidence | Evidence[]
  note?: string
}

export type MarkLook = 'pending' | 'checking' | 'verified' | 'failed'

/** How a mark draws now: `pending` while its reply streams or no check has said anything yet; a corrected mark is
 * verified, and a mark the check found wrong, could not confirm or could not check is failed. Pure. */
export function lookOf(item: MarkItem | undefined): MarkLook {
  if (!item) return 'pending'
  if (item.status === 'corrected') return 'verified'
  if (item.status === 'failed' || item.status === 'unchecked') return 'failed'
  return item.status
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
  failed: 'not confirmed',
}

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
export function takeawayChecks(cell: { takeaway?: string; takeaway_marks?: { text?: string; items?: MarkItem[] } }): (MarkItem | undefined)[] {
  const kept = cell.takeaway_marks
  if (!kept || kept.text !== cell.takeaway || !Array.isArray(kept.items)) return []
  const out: (MarkItem | undefined)[] = []
  for (const m of kept.items) if (typeof m?.k === 'number') out[m.k] = m
  return out
}

/** The counts a reply's footer says once its check settled: how many marks failed. Pure. */
export function footerCounts(items: readonly MarkItem[]): { look: MarkLook; n: number }[] {
  const n = items.filter((m) => lookOf(m) === 'failed').length
  return n ? [{ look: 'failed', n }] : []
}
