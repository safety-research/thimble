// conversation.ts: a side thread's conversation and its input bar, as the side panel draws them under what it shows
// (detail.tsx). Written and spaced as Claude Code writes main's: a blank row before each question and before each
// block of an answer (its steps, its words, a card it saved), as thimble 0.9's panel drew a side thread:
//
//   ── main/Saves per day ─────────────       the thread's name on a dim rule, between what it is on and its turns
//
//   ❯ why so many links?   about Jun 18       each question after ❯ on the prompt's background, with its part
//
//   ● 2 steps · thimble rows "q1#…"           the steps the thread took, on one dim row
//
//   ● Links peaked that day: 2,994 of …       the answer after ●, its citations underlined presses (view.ts)
//
//     [a card it saved, drawn as under a reply]
//                                             a question at work: the bar says `⠋ answering: <thread>` (busy.ts)
//
//   ─────────────────────────────────         the input bar: Claude Code's prompt box, a rule above and below,
//   ❯ Ask about Jun 17…              ↵ ask    ❯ and the field between them
//   ─────────────────────────────────
//
// Each item says how many rows it takes, so the panel cuts the conversation from the top to the rows it has.
import { healedRecord, newRecord, textKey } from './message.js'
import { messageRows } from './view'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
export type Item = { el: Any; h: number }
export type CardRef = { id: string; v: number | null; root: string }
export type ConvOpts = {
  /** the thread as threadList gives it (or null: no question yet) */
  thread: Any | null
  /** its name, `main/<what it is on>` */
  name: string
  /** the columns the conversation has */
  w: number
  theme: 'dark' | 'light'
  key: string
  /** the clock now (ms), for how long a question has been at work */
  now: number
  /** a citation in an answer pressed: its ref and words */
  onCite: (ref: string, label: string) => unknown
  /** what the healing pass did to an answer's citations, or that one checks them now (shell.tsx healOfText) */
  heal?: (text: string) => { heal: Any | null; checking: boolean } | null
  /** a card the thread's agent saved, drawn as under a reply (null: not drawn, or the card the panel shows above) */
  card?: (ref: CardRef, key: string) => Item | null
}

const cut = (s: string, n: number) => ([...String(s)].length <= n ? String(s) : [...String(s)].slice(0, Math.max(1, n - 1)).join('') + '…')

/** Words wrapped at word boundaries into lines of at most `w` columns. */
function wrapWords(s: string, w: number): string[] {
  const out: string[] = []
  for (const para of String(s).split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const piece = [...word].length > w ? cut(word, w) : word
      if (!line) line = piece
      else if ([...line].length + 1 + [...piece].length <= w) line += ` ${piece}`
      else { out.push(line); line = piece }
    }
    out.push(line)
  }
  return out.length ? out : ['']
}

/** The conversation's rows, oldest first: nothing before its first question. */
export function conversation(els: Any, o: ConvOpts): Item[] {
  const { Box, Text } = els
  const turns: Any[] = o.thread?.turns || []
  if (!turns.length) return []
  const w = Math.max(20, o.w)
  const items: Item[] = []
  const row = (el: Any) => items.push({ el, h: 1 })
  // the thread's name on a rule, between what the panel shows and its turns
  const head = ` ${cut(o.name, w - 8)} `
  row(Text({ key: `${o.key}-head`, dimColor: true, wrap: 'truncate-end', children: `──${head}${'─'.repeat(Math.max(2, w - [...head].length - 2))}` }))
  const status = String(o.thread?.status || '')
  // a blank row between blocks, as Claude Code spaces main's messages
  const gap = (k: string) => row(Text({ key: k, children: ' ' }))
  turns.forEach((t: Any, i: number) => {
    const k = `${o.key}-t${i}`
    if (t.role === 'person') {
      gap(`${k}-gap`)
      // the question on the prompt's background, as Claude Code draws the person's prompt; its part after it, dim
      const about = t.about ? `about ${cut(String(t.about), 40)}` : ''
      const lines = wrapWords(String(t.text || ''), w - 2)
      const fits = about && [...lines[lines.length - 1]!].length + 3 + [...about].length <= w - 2
      lines.forEach((l, j) => row(Text({ key: `${k}-q${j}`, wrap: 'truncate-end', children: [
        Text({ backgroundColor: 'userMessageBackground', color: 'text', children: `${j ? '  ' : '❯ '}${l}` }),
        ...(fits && j === lines.length - 1 ? [Text({ dimColor: true, children: `   ${about}` })] : []),
      ] })))
      if (about && !fits) row(Text({ key: `${k}-about`, dimColor: true, wrap: 'truncate-end', children: `  ${about}` }))
      // a question still at work: the bar's one busy line says so (`⠋ answering: <thread>`, busy.ts)
      return
    }
    const calls: string[] = t.calls || []
    if (calls.length) {
      const words = `${calls.length} step${calls.length === 1 ? '' : 's'} · ${calls[calls.length - 1]}`
      gap(`${k}-steps-gap`)
      row(Text({ key: `${k}-steps`, wrap: 'truncate-end', dimColor: true, children: `● ${cut(words, w - 4)}` }))
    }
    if (t.text) {
      gap(`${k}-a-gap`)
      // its citations as the healing pass left them (o.heal: the host's, shell.tsx healOfText)
      const h = o.heal?.(String(t.text)) ?? null
      const made = newRecord({ row: `${o.key}-a${i}`, session: '', text: String(t.text), at: null })
      const rec = healedRecord(h?.heal ? { ...made, heal: { ...h.heal, key: textKey(String(t.text)) } } : made, { checking: !!h?.checking })
      const rows = messageRows(els, {
        rec, key: `${k}-a`, cols: w, first: true, theme: o.theme, focus: null, ink: 'text',
        onMark: (m: number) => { const x = rec.marks[m]; if (x?.ref) o.onCite(String(x.ref), String(x.label || x.ref)) },
      })
      rows.forEach((r: Any) => row(r))
    }
    for (const [j, c] of ((t.cards || []) as CardRef[]).entries()) {
      const drawn = o.card?.(c, `${k}-c${j}`)
      if (drawn) { gap(`${k}-c${j}-gap`); items.push(drawn) }
    }
  })
  if (status === 'failed') gap(`${o.key}-failed-gap`)
  if (status === 'failed') row(Text({ key: `${o.key}-failed`, color: 'error', wrap: 'truncate-end', children: `  ⎿ × ${cut(String(o.thread?.error || 'the thread stopped'), w - 6)} · ask again` }))
  return items
}

/** The last items that fit in `rows` (`by` rows up from the end: the wheel moved it), with a dim row on top saying how
 *  many rows are above them. */
export function fitItems(els: Any, items: Item[], rows: number, by = 0): { items: Item[]; above: number; by: number } {
  const total = items.reduce((n, x) => n + x.h, 0)
  if (total <= rows) return { items, above: 0, by: 0 }
  const room = Math.max(1, rows - 1)
  const maxBy = Math.max(0, total - room)
  const at = Math.max(0, Math.min(maxBy, by))
  // from the end, skip `at` rows, then take what fits in `room`
  let skip = at
  let end = items.length
  while (end > 0 && skip >= items[end - 1]!.h) { skip -= items[end - 1]!.h; end-- }
  const out: Item[] = []
  let used = 0
  let i = end - 1
  while (i >= 0 && used + items[i]!.h <= room) { out.unshift(items[i]!); used += items[i]!.h; i-- }
  const above = items.slice(0, i + 1).reduce((n, x) => n + x.h, 0)
  const { Text } = els
  return { items: [{ el: Text({ key: 'conv-above', dimColor: true, wrap: 'truncate-end', children: `  ↑ ${above} earlier row${above === 1 ? '' : 's'}` }), h: 1 }, ...out], above, by: at }
}

export type EntryOpts = {
  key: string
  w: number
  value: string
  placeholder: string
  autoFocus?: boolean
  onInput: (v: string) => unknown
  onSubmit: (v: string) => unknown
}

/** The input bar: Claude Code's prompt box in the panel, a blank row, a rule, `❯` and the field, a rule. 4 rows. */
export function entry(els: Any, o: EntryOpts): Any[] {
  const { Box, Text, Input } = els
  const rule = (k: string) => Text({ key: k, color: 'promptBorder', wrap: 'truncate-end', children: '─'.repeat(Math.max(4, o.w)) })
  return [
    Text({ key: 'entry-gap', children: ' ' }),
    rule('entry-top'),
    Box({ key: 'entry-row', flexDirection: 'row', children: [
      Box({ width: 2, flexShrink: 0, children: [Text({ color: 'text', children: '❯ ' })] }),
      Box({ flexGrow: 1, flexShrink: 1, children: [Input({
        key: o.key, placeholder: o.placeholder, value: o.value, submitLabel: 'ask',
        ...(o.autoFocus ? { autoFocus: true } : {}),
        onInput: (v: string) => o.onInput(v),
        onSubmit: (v: string) => o.onSubmit(v),
      })] }),
    ] }),
    rule('entry-bottom'),
  ]
}

/** The rows the input bar takes. */
export const ENTRY_ROWS = 4
