// The entry box: Claude Code's own prompt box, drawn in the panel wherever the analyst asks a side thread a question
// (SPEC.md, section 6, rule 27; Matt, 2026-10-16: the person types a follow-up directly, in a box like Claude Code's).
// A rule above and a rule below in the prompt box's border color, from the margin's edge across the type area, and
// between them `❯` in the margin and Claude Code's Input on the type area: one row tall, taller as its text wraps, a
// longer text scrolling within it. Enter asks; Shift+Enter breaks the line; Esc gives the keys back to the prompt. It
// replaces the `ask about it` controls (a citation, a card, a check's comment) and the side thread's one-row `ask`
// field, and while it holds the keys the panel draws no key-hint row (panel.tsx endHints), as Claude Code's prompt box
// has none.
import type { RenderElement } from 'claude-code'

import { MARGIN_W, marginKey } from './chrome'
import type { Ctx } from './ctx'
import { width } from './lib'
import { COLORS } from './paint'
import type { PaneEvent } from './panel'

/** The rows the field takes at the least: one, as Claude Code's prompt box shows at rest (the owner, 10-16 21:55). */
export const ENTRY_ROWS = 1
/** The rows it grows to at the most; a longer text scrolls within the field. */
export const ENTRY_MAX = 10
/** What Enter does in it, the word Claude Code's Input draws beside a field while it has the keys. */
export const ENTRY_SUBMIT = 'ask'

/** The keys of the panel's entry boxes: a new thread's (`ask-new`), a thread's follow-up (`ask-<thread>`), one about a
 *  citation, a card or a comment (`ask-cite-…`, `ask-card-…`, `ask-check-…`, `ask-cm-…`), a citation's in a
 *  thread (`follow-<thread>`), and the labels list's new label (`make-label`). */
export const ENTRY_KEY = /^(?:ask-|follow-|make-)/

// what each entry box holds, by its key, as its changes come in: the rows it takes are drawn from it
const drafts = new Map<string, string>()

/** The rows `text` takes in an entry box of a type area `cols` wide: each of its lines wrapped at a word to the field's
 *  width (the type area less the room Claude Code keeps beside the field for Enter's word, `submit`), at least
 *  ENTRY_ROWS and at most ENTRY_MAX. */
export function entryRows(text: string, cols: number, submit = ENTRY_SUBMIT): number {
  const room = Math.max(8, cols - width(`⏎ ${submit}`) - 2)
  let rows = 0
  for (const line of text.split('\n')) {
    let used = 0
    let n = 1
    for (const word of line.split(' ')) {
      const w = width(word)
      const need = used ? used + 1 + w : w
      if (need <= room) used = need
      else {
        // a word wider than the field breaks where the row ends
        n += used ? 1 : 0
        n += Math.max(0, Math.ceil(w / room) - 1)
        used = w % room || room
      }
    }
    rows += n
  }
  return Math.max(ENTRY_ROWS, Math.min(ENTRY_MAX, rows))
}

/** The rows an entry box takes in the panel: its rules (the top one only with `top`) and its field. */
export function entryHeight(key: string, cols: number, top = true, submit = ENTRY_SUBMIT): number {
  // the blank row above the box, its rules and its field
  return 1 + (top ? 1 : 0) + entryRows(drafts.get(key) ?? '', cols, submit) + 1
}

export type EntryOpts = {
  /** the Input's key, as panel.tsx fieldKey noted it drawn */
  key: string
  /** dim in the empty field: what it asks about (`ask about this citation`, `ask a follow-up question`) */
  placeholder: string
  /** the type area's width */
  cols: number
  /** the box takes the keys as its view opens (a new thread's) */
  autoFocus?: boolean
  /** its rule above; false where a rule of the panel's stands right above it already */
  top?: boolean
  /** Enter's word beside the field while it has the keys: `ask` unless given (the labels list's `make it`) */
  submit?: string
  /** Enter with a question in the box: its words, trimmed and not empty */
  onSubmit: (q: string) => void
}

/** An entry box (the module's opening comment): a margin-keyed row of the panel, so its rules start at the margin's
 *  edge and `❯` stands in the margin, where the thread's questions show theirs. Each change of its text is kept, and
 *  the panel is drawn again when the rows it takes change. */
export function entryEl(cx: Ctx, e: PaneEvent, o: EntryOpts): RenderElement {
  const { Box, Text, Input } = cx.els(e)
  const rule = (k: string) => (
    <Box key={k} flexDirection="row">
      <Text color={COLORS.entry}>{'─'.repeat(Math.max(1, o.cols + MARGIN_W))}</Text>
    </Box>
  )
  const submit = o.submit ?? ENTRY_SUBMIT
  const rows = entryRows(drafts.get(o.key) ?? '', o.cols, submit)
  return (
    <Box key={marginKey(`entry-${o.key}`)} flexDirection="column">
      {/* one blank row between what stands above and the box, as above Claude Code's own prompt */}
      <Text key={`entry-gap-${o.key}`}> </Text>
      {o.top === false ? null : rule(`entry-top-${o.key}`)}
      <Box key={`entry-row-${o.key}`} flexDirection="row">
        <Box width={MARGIN_W} flexShrink={0}>
          <Text>❯ </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Input
            key={o.key}
            rows={rows}
            placeholder={o.placeholder}
            submitLabel={submit}
            {...(o.autoFocus ? { autoFocus: true as const } : {})}
            onInput={v => {
              const before = entryRows(drafts.get(o.key) ?? '', o.cols, submit)
              drafts.set(o.key, v)
              if (entryRows(v, o.cols, submit) !== before) void cx.bumpPanel()
            }}
            onSubmit={v => {
              const had = entryRows(drafts.get(o.key) ?? '', o.cols, submit)
              drafts.delete(o.key)
              if (had !== ENTRY_ROWS) void cx.bumpPanel()
              const q = v.trim()
              if (q) o.onSubmit(q)
            }}
          />
        </Box>
      </Box>
      {rule(`entry-bottom-${o.key}`)}
    </Box>
  )
}
