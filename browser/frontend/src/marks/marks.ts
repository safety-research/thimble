// A reply's marks, as the server checks them (backend features/marks.py) and the terminal draws them
// (plugin/marks/view.ts). A mark is a markdown link to `#` on the words of a claim, `[352](#)`, found with the terminal
// plugin's own module (plugin/marks/message.js), so the page, the terminal and the server read the same marks.
//
// A mark's look by its status:
//   pending      the turn still runs, or its check has not started: violet, underlined
//   checking     violet, underlined, and a spinner right after it
//   verified     violet, underlined
//   corrected    the corrected words in place of the marked ones, in the warning color, underlined
//   failed       wrong as the check read the data: red, with ` ×` after it
//   unconfirmed  failed because the check's evidence did not hold: the warning color, with ` ?` after it
//   unchecked    underlined in the text's color: no check could run
import { marksIn } from '../../../../plugin/marks/message.js'

/** One piece of evidence a mark's check found (backend: the terminal's engine/kernel/evidence.py). */
export interface Evidence {
  kind: 'computed' | 'quote' | 'code'
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

export type MarkLook = 'pending' | 'checking' | 'verified' | 'corrected' | 'failed' | 'unconfirmed' | 'unchecked'

/** How a mark draws now: `pending` while its reply streams or no check has said anything yet. Pure. */
export function lookOf(item: MarkItem | undefined): MarkLook {
  if (!item) return 'pending'
  if (item.status === 'failed') return item.failedBy === 'evidence' ? 'unconfirmed' : 'failed'
  return item.status
}

/** The words a person reads for a look, in the evidence view. */
export const LOOK_WORD: Record<MarkLook, string> = {
  pending: 'not checked yet',
  checking: 'checking',
  verified: 'verified',
  corrected: 'corrected',
  failed: 'wrong',
  unconfirmed: 'not confirmed',
  unchecked: 'not checked',
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

/** The counts a reply's footer says once its check settled: corrected, wrong, not confirmed, not checked. Pure. */
export function footerCounts(items: readonly MarkItem[]): { look: MarkLook; n: number }[] {
  const order: MarkLook[] = ['corrected', 'failed', 'unconfirmed', 'unchecked']
  return order.map((look) => ({ look, n: items.filter((m) => lookOf(m) === look).length })).filter((c) => c.n > 0)
}
