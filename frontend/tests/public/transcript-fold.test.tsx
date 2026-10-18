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
import { FoldContext, foldKey, useFold } from '../../src/files/fold.ts'
import transcript, { foldParts, HIDDEN_RUN_NOTE } from '../../src/files/views/transcript.tsx'
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
})

describe('the rows Filter by hides', () => {
  const replies = (from: number, n: number) => Array.from({ length: n }, (_, i) => msg(from + i, 'assistant', [{ type: 'text', text: `step ${i + 1}` }]))
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
})
