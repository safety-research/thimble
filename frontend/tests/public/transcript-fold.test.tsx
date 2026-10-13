// @vitest-environment jsdom
// Folding the records of Files' Transcript mode (src/files/fold.ts, views/common.tsx RecordCard, views/transcript.tsx):
// a long line counts as the lines it wraps to; a tool call, a tool result, a system record and a message of more than
// a few lines start folded to one line, the head and the start of the words or the call, while a short reply shows; a
// click on the line opens the record and a click on its head folds it again, the chevron at the head's start turned; a
// long block shows Show more under its cut text and Show less in the same place once open; a ref's record shows open
// until it is
// folded under the ref; the find's match inside a folded record opens it; Collapse all and Expand all fold and open
// every record, and the choice and the records set one by one are kept per file. Records Filter by hides have no row,
// and a long run of them says how many it hides, merged with a run of hidden system records.
import { act, useState } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { FilterContext, type FilterVerdict } from '../../src/files/useFilterBy.ts'
import { UNFOLD_EVENT } from '../../src/files/find.ts'
import { FoldContext, foldedBy, foldKey, OWN_MAX, readFold, useFold, withOwn, type FoldKept } from '../../src/files/fold.ts'
import { foldsByDefault, lineCount, oneLine, WRAP_CHARS } from '../../src/files/views/common.tsx'
import transcript, { foldParts, hiddenRuns, HIDDEN_RUN_NOTE } from '../../src/files/views/transcript.tsx'
import type { SourcePage, SourceRecord } from '../../src/lib/types.ts'
import { mount, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  localStorage.clear()
})

const View = transcript.component
const STREAM = { format: 'stream' as const, score: 1 }
const msg = (line: number, type: 'assistant' | 'user', content: any[], ts = `2026-10-01T12:${String(line).padStart(2, '0')}:00Z`): SourceRecord => {
  const record = { type, session_id: 's1', timestamp: ts, message: { role: type, content } }
  const blocks = content.map((c) =>
    c.type === 'text' ? { kind: 'text' as const, text: c.text } : c.type === 'tool_use' ? { kind: 'tool_use' as const, text: `${c.name}\n${JSON.stringify(c.input, null, 2)}` } : { kind: 'tool_result' as const, text: c.content },
  )
  return { line, record, blocks, meta: {} }
}
const LONG = 'one\ntwo\nthree\nfour\nfive'
const WALL = 'cat > shim.h <<EOF\n' + '#define X 1 /* shim */\n'.repeat(300) + 'EOF'
const RECORDS: SourceRecord[] = [
  msg(1, 'user', [{ type: 'text', text: LONG }]),
  msg(2, 'assistant', [{ type: 'text', text: 'Looking now.' }]),
  msg(3, 'assistant', [{ type: 'tool_use', name: 'Bash', input: { command: WALL } }]),
  msg(4, 'user', [{ type: 'tool_result', content: 'wrote shim.h' }]),
  { line: 5, record: { type: 'system', subtype: 'thinking_tokens', session_id: 's1' }, blocks: [{ kind: 'raw', text: '{"type":"system"}' }], meta: {} },
]
const pageOf = (records: SourceRecord[]): SourcePage => ({ path: 'run.jsonl', kind: 'text', total_lines: records.length, start: 1, records })
const card = (el: HTMLElement, line: number) => el.querySelector<HTMLElement>(`.reader-card[data-line="${line}"]`)
const isFolded = (el: HTMLElement, line: number) => card(el, line)?.classList.contains('is-folded') ?? null
const click = async (node: Element) => act(async () => void node.dispatchEvent(new MouseEvent('click', { bubbles: true })))

describe('how long a record reads, and how it folds', () => {
  test('a line counts as the lines it wraps to, so one long line is many', () => {
    expect(lineCount('a\nb\nc')).toBe(3)
    expect(lineCount('x'.repeat(WRAP_CHARS * 5))).toBe(5)
    expect(lineCount(`short\n${'y'.repeat(WRAP_CHARS * 2 + 1)}`)).toBe(4)
    // counting stops past the cap
    expect(lineCount('a\n'.repeat(10_000), 3)).toBeLessThanOrEqual(5)
  })
  test('a tool call, a tool result and a record of more than three lines start folded; a short one does not', () => {
    expect(foldsByDefault([{ kind: 'tool_use', text: 'Bash\n{}' }])).toBe(true)
    expect(foldsByDefault([{ kind: 'tool_result', text: 'ok' }])).toBe(true)
    expect(foldsByDefault([{ kind: 'text', text: LONG }])).toBe(true)
    expect(foldsByDefault([{ kind: 'text', text: 'x'.repeat(WRAP_CHARS * 4) }])).toBe(true)
    expect(foldsByDefault([{ kind: 'text', text: 'one\ntwo\nthree' }])).toBe(false)
  })
  test('a text on one line keeps its words, each run of white space one space', () => {
    expect(oneLine('  a\n\n b\tc  ')).toBe('a b c')
    expect(oneLine('z'.repeat(1000)).length).toBe(400)
  })
  test("a folded line holds the words, each tool call's name and what it acts on, and the start of each result", () => {
    expect(foldParts([{ kind: 'text', text: 'Running it.\nnow' }, { kind: 'tool_use', text: `Bash\n${JSON.stringify({ command: 'ls -la\nwc -l', description: 'list' }, null, 2)}` }])).toEqual([
      { kind: 'text', text: 'Running it. now' },
      { kind: 'tool', tool: 'Bash', text: 'ls -la' },
    ])
    expect(foldParts([{ kind: 'tool_result', text: 'a\n\x1b[31mb\x1b[0m\n' }])).toEqual([{ kind: 'result', text: 'a b' }])
    expect(foldParts([{ kind: 'tool_result', text: '' }])).toEqual([{ kind: 'result', text: '(empty)' }])
    // thinking only when there is nothing else
    expect(foldParts([{ kind: 'thinking', text: 'hmm' }, { kind: 'text', text: 'yes' }])).toEqual([{ kind: 'text', text: 'yes' }])
    expect(foldParts([{ kind: 'thinking', text: 'hmm' }])).toEqual([{ kind: 'other', text: 'thinking: hmm' }])
  })
})

describe('what the reader keeps of the fold', () => {
  test('the choice gives each record its state, and a record set one by one is kept only while it differs', () => {
    expect([foldedBy('auto', true), foldedBy('auto', false), foldedBy('fold', false), foldedBy('open', true)]).toEqual([true, false, true, false])
    const kept = { all: 'auto' as const, own: {} }
    expect(withOwn(kept, 4, false, true).own).toEqual({ 4: false })
    expect(withOwn(withOwn(kept, 4, false, true), 4, true, true).own).toEqual({})
    expect(withOwn({ all: 'fold', own: {} }, 9, true, false).own).toEqual({})
  })
  test('past OWN_MAX records set one by one, those furthest from the last set go first', () => {
    let k: FoldKept = { all: 'open', own: {} }
    for (let i = 1; i <= OWN_MAX + 5; i++) k = withOwn(k, i, true, false)
    expect(Object.keys(k.own)).toHaveLength(OWN_MAX)
    expect(k.own[OWN_MAX + 5]).toBe(true)
    expect(k.own[1]).toBeUndefined()
  })
  test('what is kept is read back, anything else read as the default', () => {
    localStorage.setItem(foldKey('w', 'a.jsonl'), JSON.stringify({ all: 'fold', own: { 3: false, x: true, 4: 'no' } }))
    expect(readFold('w', 'a.jsonl')).toEqual({ all: 'fold', own: { 3: false } })
    localStorage.setItem(foldKey('w', 'b.jsonl'), '{"all":"sideways"}')
    expect(readFold('w', 'b.jsonl')).toEqual({ all: 'auto', own: {} })
  })
})

describe('a stream transcript folds its records', () => {
  test('a long prompt, a tool call, its result and a system record fold to one line; a short reply shows', async () => {
    const el = await mount(<View workspace="w" path="run.jsonl" kind="text" page={pageOf(RECORDS)} loadMore={() => undefined} transcript={STREAM} />)
    expect([1, 2, 3, 4].map((l) => isFolded(el, l))).toEqual([true, false, true, true])
    const line = card(el, 3)!.querySelector('.reader-fold-line')!
    expect(line.querySelector('.reader-record-head')?.textContent).toBe('assistant · 2026-10-01 12:03')
    expect(line.querySelector('.reader-fold-text')?.textContent).toBe('Bash cat > shim.h <<EOF')
    expect(card(el, 1)!.querySelector('.reader-fold-text')?.textContent).toBe('one two three four five')
    // the folded record keeps its blocks in the page, hidden, for the find
    const body = card(el, 3)!.querySelector<HTMLElement>('.reader-record-body')!
    expect(body.hidden).toBe(true)
    expect(body.querySelector('.reader-tool_use')?.textContent).toContain('#define X 1')
    // the system record folds too, once the system records show
    await click(el.querySelector('.reader-syschip')!)
    expect(isFolded(el, 5)).toBe(true)
    expect(card(el, 5)!.querySelector('.reader-fold-text')?.textContent).toBe('system · thinking_tokens')
  })
  test('a click on the line opens a record and a click on its head folds it, its chevron turned; an opened call holding a whole file is clipped with Show more, and Show less in the same place clips it again', async () => {
    const el = await mount(<View workspace="w" path="run.jsonl" kind="text" page={pageOf(RECORDS)} loadMore={() => undefined} transcript={STREAM} />)
    const caret = () => card(el, 3)!.querySelector('.reader-fold-caret')!
    expect([caret().closest('button')!.getAttribute('aria-expanded'), caret().classList.contains('icon-chevron-right')]).toEqual(['false', true])
    await click(card(el, 3)!.querySelector('.reader-fold-line')!)
    expect(isFolded(el, 3)).toBe(false)
    expect([caret().closest('button')!.classList.contains('reader-fold-head'), caret().closest('button')!.getAttribute('aria-expanded'), caret().classList.contains('icon-chevron-down')]).toEqual([true, 'true', true])
    const block = () => card(el, 3)!.querySelector('.reader-tool_use')!
    const more = () => card(el, 3)!.querySelector<HTMLElement>('.reader-more')!
    const place = () => [more().textContent, more().getAttribute('aria-expanded'), more().parentElement === block().parentElement, block().parentElement?.classList.contains('reader-collapsed')]
    expect(place()).toEqual(['Show more', 'false', true, true])
    await click(more())
    expect(place()).toEqual(['Show less', 'true', true, false])
    expect(card(el, 3)!.textContent).not.toContain('Collapse')
    await click(more())
    expect(place()).toEqual(['Show more', 'false', true, true])
    await click(card(el, 3)!.querySelector('.reader-fold-head')!)
    expect(isFolded(el, 3)).toBe(true)
  })
  test("a ref's record shows open, and folds when the analyst folds it under the ref", async () => {
    Element.prototype.scrollIntoView = () => undefined
    try {
      const el = await mount(<View workspace="w" path="run.jsonl" kind="text" page={pageOf(RECORDS)} targetRef="run.jsonl#L3" loadMore={() => undefined} transcript={STREAM} />)
      expect(isFolded(el, 3)).toBe(false)
      await click(card(el, 3)!.querySelector('.reader-fold-head')!)
      expect(isFolded(el, 3)).toBe(true)
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView
    }
  })
  test("the find's match inside a folded record opens it", async () => {
    const el = await mount(<View workspace="w" path="run.jsonl" kind="text" page={pageOf(RECORDS)} loadMore={() => undefined} transcript={STREAM} />)
    const text = card(el, 4)!.querySelector('.reader-tool_result')!
    await act(async () => void text.closest('.reader-collapsed')!.dispatchEvent(new Event(UNFOLD_EVENT)))
    expect(isFolded(el, 4)).toBe(false)
  })
})

/** The view under the reader's fold, with Collapse all and Expand all as the top row has them. */
function Folding({ records, path = 'run.jsonl' }: { records: SourceRecord[]; path?: string }) {
  const fold = useFold('w', path)
  return (
    <FoldContext.Provider value={fold}>
      <button type="button" className="all" onClick={() => fold.setAll(fold.all === 'fold' ? 'open' : 'fold')}>
        {fold.all === 'fold' ? 'Expand all' : 'Collapse all'}
      </button>
      <View workspace="w" path={path} kind="text" page={pageOf(records)} loadMore={() => undefined} transcript={STREAM} />
    </FoldContext.Provider>
  )
}

describe('Collapse all and Expand all', () => {
  test('fold and open every record, and the choice and a record opened since are kept for the file', async () => {
    const el = await mount(<Folding records={RECORDS} />)
    const all = () => el.querySelector('.all')!
    await click(all())
    expect([1, 2, 3, 4].map((l) => isFolded(el, l))).toEqual([true, true, true, true])
    expect(all().textContent).toBe('Expand all')
    await click(card(el, 2)!.querySelector('.reader-fold-line')!)
    expect(JSON.parse(localStorage.getItem(foldKey('w', 'run.jsonl'))!)).toEqual({ all: 'fold', own: { 2: false } })
    unmountAll()
    const again = await mount(<Folding records={RECORDS} />)
    expect([1, 2, 3, 4].map((l) => isFolded(again, l))).toEqual([true, false, true, true])
    await click(again.querySelector('.all')!)
    expect([1, 2, 3, 4].map((l) => isFolded(again, l))).toEqual([false, false, false, false])
    expect(again.querySelector('.all')!.textContent).toBe('Collapse all')
  })
  test('another file keeps its own', async () => {
    localStorage.setItem(foldKey('w', 'other.jsonl'), JSON.stringify({ all: 'open', own: {} }))
    const el = await mount(<Folding records={RECORDS} path="other.jsonl" />)
    expect(isFolded(el, 3)).toBe(false)
  })
})

describe('the rows Filter by hides', () => {
  const replies = (from: number, n: number) => Array.from({ length: n }, (_, i) => msg(from + i, 'assistant', [{ type: 'text', text: `step ${i + 1}` }]))
  const sys = (line: number): SourceRecord => ({ line, record: { type: 'system', subtype: 'api_retry', session_id: 's1' }, blocks: [{ kind: 'raw', text: '{}' }], meta: {} })
  function Filtered({ records, hides, targetRef }: { records: SourceRecord[]; hides: (line: number) => boolean; targetRef?: string }) {
    const [shown, setShown] = useState(false)
    const verdict: FilterVerdict | null = shown ? null : { hides, show: () => setShown(true) }
    return (
      <FilterContext.Provider value={verdict}>
        <View workspace="w" path="run.jsonl" kind="text" page={pageOf(records)} targetRef={targetRef} loadMore={() => undefined} transcript={STREAM} />
      </FilterContext.Provider>
    )
  }
  test('have no row; a long run says how many it hides, and Show brings them back', async () => {
    const records = [msg(1, 'user', [{ type: 'text', text: 'go' }]), ...replies(2, HIDDEN_RUN_NOTE + 5), msg(HIDDEN_RUN_NOTE + 7, 'user', [{ type: 'text', text: 'done?' }])]
    const el = await mount(<Filtered records={records} hides={(l) => l >= 2 && l <= HIDDEN_RUN_NOTE + 6} />)
    expect(card(el, 1)).not.toBeNull()
    expect(card(el, 2)).toBeNull()
    expect(card(el, HIDDEN_RUN_NOTE + 7)).not.toBeNull()
    expect([...el.querySelectorAll('.reader-hidden-run > span')].map((s) => s.textContent)).toEqual([`${HIDDEN_RUN_NOTE + 5} records filtered out`])
    await click(el.querySelector('.reader-hidden-run button')!)
    expect(card(el, 2)).not.toBeNull()
    expect(el.querySelector('.reader-hidden-run')).toBeNull()
  })
  test('a short run hides quietly, and a ref into it shows its row', async () => {
    Element.prototype.scrollIntoView = () => undefined
    try {
      const records = [msg(1, 'user', [{ type: 'text', text: 'go' }]), ...replies(2, 3), msg(5, 'user', [{ type: 'text', text: 'ok' }])]
      const el = await mount(<Filtered records={records} hides={(l) => l >= 2 && l <= 4} targetRef="run.jsonl#L3" />)
      expect(el.querySelector('.reader-hidden-run')).toBeNull()
      expect([card(el, 2), card(el, 3), card(el, 4)].map((c) => c != null)).toEqual([false, true, false])
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView
    }
  })
  test('a run of hidden system records and filtered replies is one run, said in one line', async () => {
    const records = [msg(1, 'user', [{ type: 'text', text: 'go' }]), ...Array.from({ length: HIDDEN_RUN_NOTE }, (_, i) => sys(2 + i)), ...replies(HIDDEN_RUN_NOTE + 2, 3), msg(HIDDEN_RUN_NOTE + 5, 'user', [{ type: 'text', text: 'ok' }])]
    const el = await mount(<Filtered records={records} hides={(l) => l >= HIDDEN_RUN_NOTE + 2 && l < HIDDEN_RUN_NOTE + 5} />)
    expect([...el.querySelectorAll('.reader-hidden-run > span')].map((s) => s.textContent)).toEqual([`${HIDDEN_RUN_NOTE} system records hidden, 3 filtered out`])
  })
  test('the runs: HIDDEN_RUN_NOTE rows or more, or any when no row shows', () => {
    const many = Array<'filtered'>(HIDDEN_RUN_NOTE).fill('filtered')
    expect([...hiddenRuns(['shown', ...many, 'shown', 'system', 'shown'])]).toEqual([[1, { system: 0, filtered: HIDDEN_RUN_NOTE }]])
    expect([...hiddenRuns(['system', 'filtered', 'system'])]).toEqual([[0, { system: 2, filtered: 1 }]])
    expect([...hiddenRuns(['shown', 'filtered'])]).toEqual([])
  })
})
