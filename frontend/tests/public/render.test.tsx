// @vitest-environment jsdom
// The chat drawn by its real components under jsdom (src/chat/Rows.tsx, src/chat/Holds.tsx). A session's records
// render as rows: the analyst's message, the reply's markdown with its citations as chips, a tool-call card with the
// card it made, and a stopped turn; Claude Code's API error as its card, with Retry, and a view build's wait after one.
// What holds a session besides its permission requests (an alert, the rules "don't ask again" added) shows above the
// composer. A chip names a thing in words in the sans and anything code-like in mono; a chip that names a document, a
// canvas group or a label is drawn as that thing on its surface. Rendering logs no React error.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act } from 'react'
import { restartedNow } from '../../src/chat/AgentCard.tsx'
import { Holds, RESTARTED_LINE } from '../../src/chat/Holds.tsx'
import { apiRetry, foldRecords, withApiErrors } from '../../src/chat/model.ts'
import { ThreadChip, ThreadsContext } from '../../src/chat/Notes.tsx'
import { MAIN_RETRY_NOTE, Rows } from '../../src/chat/Rows.tsx'
import { cardsText, DocChip, GroupChip, LabelChip, withDocName } from '../../src/chat/SurfaceChips.tsx'
import { Chip } from '../../src/components/Chip.tsx'
import { RefChip } from '../../src/components/RefChip.tsx'
import type { ChatRecord } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const P = 'mcp__plugin_thimble_thimble__'
let errors: string[] = []

beforeEach(() => {
  errors = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args.map(String).join(' ')))
  // a chip may look up its card's name; nothing answers
  vi.stubGlobal('fetch', async () => new Response('{"detail":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } }))
})
afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const LOG = [
  { type: 'user', ts: '2026-08-30T14:00:00Z', text: 'How many agents reviewed a PR? See [[agents/agent-01.jsonl#L3]].', by: 'terminal' },
  { type: 'text', delta: 'There are **three**, listed below:\n\n- agent-01\n- agent-02\n\nIn all [[3|card:abcd1234#agents/total]] agents.' },
  { type: 'tool_use', ts: '2026-08-30T14:00:01Z', id: 't1', name: `${P}add_card`, input: { kind: 'table', question: 'Reviews per agent', code: 'df' } },
  { type: 'tool_result', ts: '2026-08-30T14:00:04Z', id: 't1', summary: 'card:abcd1234\n3 rows', cell_id: 'abcd1234' },
  { type: 'done', ts: '2026-08-30T14:00:05Z', session_id: 'sess' },
  { type: 'error', ts: '2026-08-30T14:00:06Z', message: 'stopped', kind: 'interrupted', detail: 'the analyst stopped it' },
] as unknown as ChatRecord[]

async function rows(records: ChatRecord[] | ReturnType<typeof foldRecords>): Promise<HTMLElement> {
  const folded = records.length && 'kind' in records[0] ? (records as ReturnType<typeof foldRecords>) : foldRecords(records as ChatRecord[])
  const el = await mount(
    <ThreadsContext.Provider value={{ labels: new Map() }}>
      <Rows rows={folded} ws="w" streaming={false} />
    </ThreadsContext.Provider>,
  )
  await settle()
  return el
}

describe('chat rows', () => {
  test("a folded run in the orientation's thread names its tools with their counts and none of what it made; open, each line shows what it made", async () => {
    const log = [0, 1, 2, 3, 4].flatMap((i) => [
      { type: 'tool_use', id: `c${i}`, name: i < 3 ? `${P}add_card` : 'Bash', input: i < 3 ? { kind: 'note', question: `Question ${i}` } : { command: `wc -l part-${i}.jsonl` } },
      { type: 'tool_result', id: `c${i}`, summary: i < 3 ? `card:0000000${i}` : '12', ...(i < 3 ? { cell_id: `0000000${i}` } : {}) },
    ]) as unknown as ChatRecord[]
    const el = await mount(
      <ThreadsContext.Provider value={{ labels: new Map() }}>
        <Rows rows={foldRecords(log)} ws="w" calls="or1" />
      </ThreadsContext.Provider>,
    )
    await settle()
    const head = el.querySelector('.chat-callrun-head')!
    expect(head.querySelector('.chat-callrun-tools')?.textContent).toBe('add_card3·Bash2')
    expect([...head.querySelectorAll('.chat-callrun-name')].map((n) => n.textContent)).toEqual(['add_card', 'Bash'])
    expect(head.querySelectorAll('.refchip, .chip:not(.chat-callrun-chip)').length).toBe(0)
    expect(head.querySelector('.chat-callrun-failed')).toBeNull()
    await act(async () => head.querySelector<HTMLButtonElement>('.chat-callrun-chip')!.click())
    expect(el.querySelectorAll('.chat-callrun-lines .chat-call').length).toBe(5)
    expect(el.querySelectorAll('.chat-callrun-lines .refchip').length).toBe(3)
    expect(errors).toEqual([])
  })

  test('a run with failed calls says how many, and that opens those calls alone, each on its error', async () => {
    const log = [
      { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'wc -l runs/*.jsonl' } },
      { type: 'tool_result', id: 'a', summary: '40 total' },
      { type: 'tool_use', id: 'b', name: 'Read', input: { file_path: '/data/toy/missing.jsonl', limit: 20 } },
      { type: 'tool_result', id: 'b', summary: 'File does not exist.', is_error: true },
      { type: 'tool_use', id: 'c', name: 'Grep', input: { pattern: 'refund(' } },
      { type: 'tool_result', id: 'c', summary: 'regex parse error: unclosed group', is_error: true },
    ] as unknown as ChatRecord[]
    const el = await rows(log)
    const failed = el.querySelector<HTMLButtonElement>('.chat-callrun-failed')!
    expect(failed.querySelector('.chat-callrun-failed-text')?.textContent).toBe('2 failed')
    expect(failed.getAttribute('aria-expanded')).toBe('false')
    await act(async () => failed.click())
    expect(failed.getAttribute('aria-expanded')).toBe('true')
    const lines = [...el.querySelectorAll('.chat-callrun-lines .chat-call')]
    expect(lines.map((l) => l.getAttribute('data-tool'))).toEqual(['Read', 'Grep'])
    expect(lines.map((l) => l.querySelector('.chat-tool-result-error')?.textContent)).toEqual(['File does not exist.', 'regex parse error: unclosed group'])
    // the error first, the input it was given under it
    const body = lines[0].querySelector('.chat-call-body')!
    expect([...body.children].map((c) => c.className.split(' ')[0])).toEqual(['chat-tool-label', 'chat-tool-result', 'chat-tool-fields'])
    // the chip opens every call instead
    await act(async () => el.querySelector<HTMLButtonElement>('.chat-callrun-chip')!.click())
    expect(el.querySelectorAll('.chat-callrun-lines .chat-call').length).toBe(3)
    expect(failed.getAttribute('aria-expanded')).toBe('false')
    expect(errors).toEqual([])
  })

  test("Claude Code's API error in main is an error card: what happened, that nothing retries it, and Retry, which sends the analyst's message again", async () => {
    const error = 'API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary.'
    const log = [
      { type: 'user', text: 'Which agent stalled?', by: 'browser' },
      { type: 'text', delta: error, by: 'terminal' },
      { type: 'done' },
    ] as unknown as ChatRecord[]
    const failed = apiRetry(log)
    const sent: string[] = []
    const el = await mount(
      <ThreadsContext.Provider value={{ labels: new Map() }}>
        <Rows rows={withApiErrors(foldRecords(log))} ws="w" chat="main" retry={{ index: failed!.index, onRetry: async () => void sent.push(failed!.text), note: MAIN_RETRY_NOTE }} />
      </ThreadsContext.Provider>,
    )
    await settle()
    const card = el.querySelector('.chat-api-error .chat-apierr')
    expect(card?.getAttribute('role')).toBe('alert')
    expect(card?.getAttribute('data-failure')).toBe('overloaded')
    expect(card?.querySelector('.chat-apierr-what')?.textContent).toBe("Anthropic's API is overloaded (529)")
    expect(card?.querySelector('.chat-apierr-retrying')?.textContent).toBe(MAIN_RETRY_NOTE)
    expect(el.querySelector('.chat-text')).toBeNull()
    // the error's own words, one click away
    expect(card?.querySelector('.chat-apierr-detail')).toBeNull()
    await act(async () => card!.querySelector<HTMLButtonElement>('.chat-apierr-more')!.click())
    expect(card?.querySelector('.chat-apierr-detail')?.textContent).toBe(error)
    const retry = card?.querySelector<HTMLButtonElement>('.chat-apierr-retry')
    expect(retry?.textContent).toBe('Retry')
    await act(async () => retry!.click())
    expect(sent).toEqual(['Which agent stalled?'])
    expect(errors).toEqual([])
  })

  test("a view build's wait after an API error is that error's card, saying when thimble retries; an error no one can retry has no button", async () => {
    const log = [
      { type: 'text', delta: 'API Error: Server error mid-response. The response above may be incomplete.' },
      { type: 'text', delta: "\n· Anthropic's API had a server error, so the build waits 30 s and goes on\n" },
      { type: 'text', delta: '\n· the session writes the view\n' },
      { type: 'text', delta: "\n· Anthropic's API was overloaded, so the build waits 2 min and goes on\n" },
    ] as unknown as ChatRecord[]
    const el = await rows(withApiErrors(foldRecords(log)) as never)
    const cards = [...el.querySelectorAll('.chat-apierr')]
    expect(cards.map((c) => c.querySelector('.chat-apierr-what')?.textContent)).toEqual(["Anthropic's API had a server error", "Anthropic's API is overloaded"])
    expect(cards.map((c) => c.querySelector('.chat-apierr-retrying')?.textContent)).toEqual(['thimble retries the build after 30 s.', 'thimble retries the build after 2 min.'])
    expect(cards.map((c) => c.getAttribute('role'))).toEqual(['status', 'status'])
    expect(el.querySelectorAll('.chat-apierr-retry').length).toBe(0)
    expect([...el.querySelectorAll('.chat-stage')].map((n) => n.textContent)).toEqual(['the session writes the view'])
  })

  test("the analyst's message, markdown with a value chip, a tool-call card with the card it made, and a stopped turn", async () => {
    const el = await rows(LOG)
    const user = el.querySelector('.chat-user .chat-message')
    expect(user?.textContent).toMatch(/How many agents reviewed a PR\?/)
    expect(user?.getAttribute('data-by')).toBe('terminal')
    expect(el.querySelector('.chat-user .refchip')?.getAttribute('data-ref')).toBe('agents/agent-01.jsonl#L3')
    expect(el.querySelector('.chat-text strong')?.textContent).toBe('three')
    expect(el.querySelectorAll('.chat-text li')).toHaveLength(2)
    const value = el.querySelector('.chat-text .refchip-value')
    expect(value?.textContent).toBe('3')
    expect(value?.getAttribute('data-ref')).toBe('card:abcd1234#agents/total')
    const tool = el.querySelector('.chat-tool.toolcard[data-tool="add_card"]')
    expect(tool).not.toBeNull()
    expect(tool?.querySelector('.toolcard-chips .refchip[data-ref="card:abcd1234"]')).not.toBeNull()
    expect(el.querySelector('.chat-stopped')).not.toBeNull()
    expect(errors).toEqual([])
  })

  test('a card made and then edited in one run of calls is one chip, with no duplicate React keys', async () => {
    const log = [
      { type: 'tool_use', id: 'r1', name: `${P}add_card`, input: { kind: 'table', question: 'Which PRs waited?' } },
      { type: 'tool_result', id: 'r1', summary: '$ add_card kind="table"', cell_id: '8fbcdc54' },
      { type: 'tool_use', id: 'r2', name: `${P}edit_card`, input: { card: 'card:8fbcdc54', code: 'df' } },
      { type: 'tool_result', id: 'r2', summary: '$ edit_card card="card:8fbcdc54"', cell_id: '8fbcdc54' },
      { type: 'done', ts: '2026-08-30T14:00:09Z', session_id: 'sess' },
    ] as unknown as ChatRecord[]
    const el = await rows(log)
    const refs = Array.from(el.querySelectorAll('.chat-tool.toolcard .toolcard-chips .refchip')).map((c) => c.getAttribute('data-ref'))
    expect(refs).toEqual(['card:8fbcdc54'])
    expect(errors).toEqual([])
  })
})

describe("a chip's face", () => {
  test('a name in words (a label, a canvas group, a thread, a document) is in the sans; an id, a file line or a call in mono', async () => {
    const face = (el: Element | null) => (el?.classList.contains('chip-sans') ? 'sans' : 'mono')
    const el = await mount(
      <ThreadsContext.Provider value={{ labels: new Map([['or1', 'orient']]) }}>
        <Chip kind="label" icon="label">refund asked</Chip>
        <ThreadChip id="or1" />
        <RefChip ref="concept:c1" workspace="w" />
        <RefChip ref="card:abcd1234" workspace="w" />
        <RefChip ref="agents/agent-01.jsonl#L3" workspace="w" />
        <RefChip ref="call:or1/3" workspace="w" />
      </ThreadsContext.Provider>,
    )
    const chips = [...el.querySelectorAll('.chip')]
    expect(chips.map(face)).toEqual(['sans', 'sans', 'sans', 'mono', 'mono', 'mono'])
    // the sans chip is the body face at the view tab's size
    const css = readFileSync(path.resolve(__dirname, '../../src/styles/components.css'), 'utf8')
    expect(/\n\.chip-sans \{[^}]*font: 400 var\(--text-ui-sm\) \/ 1 var\(--font-body\);/.test(css)).toBe(true)
  })

  test('a document and a canvas group are a view\'s chip with their glyph, the group with its count\'s unit, a label its row in the Labels pane', async () => {
    const el = await mount(
      <>
        <DocChip ws="w" slug="slides" onClick={() => undefined} />
        <DocChip ws="w" slug="report">edited a passage</DocChip>
        <DocChip ws="w" slug="report">the report, generation 1</DocChip>
        <GroupChip name="Orientation" count={4} onClick={() => undefined} />
        <LabelChip ws="w" name="refund asked" />
      </>,
    )
    const [slides, note, generated] = [...el.querySelectorAll('.doc-chip')]
    const group = el.querySelector('.group-chip')!
    const [label] = [...el.querySelectorAll('.surface-chip')]
    expect(slides.tagName).toBe('BUTTON')
    expect(slides.textContent).toBe('Slides')
    expect(note.tagName).toBe('SPAN')
    expect(note.textContent).toBe('edited a passage')
    expect(generated.textContent).toBe('the Report, generation 1')
    expect(withDocName('the slides, generation 2', 'Slides')).toBe('the Slides, generation 2')
    expect(withDocName('reported in the reports', 'Report')).toBe('reported in the reports')
    // a document's chip is the view tab's accent chip, with the document glyph in place of the view's
    for (const doc of [slides, note]) {
      expect(doc.classList.contains('view-tab')).toBe(true)
      expect(doc.classList.contains('surface-chip')).toBe(false)
      expect(doc.querySelector('.view-tab-ico.icon-report')).not.toBeNull()
    }
    expect(group.classList.contains('view-tab')).toBe(true)
    expect(group.querySelector('.view-tab-ico.icon-group')).not.toBeNull()
    expect(group.textContent).toBe('Orientation · 4 cards')
    expect(cardsText(1)).toBe('1 card')
    // a label the page has not read yet is a label over files, off, in the colour of none
    expect(label.querySelector('.label-chip-box')).not.toBeNull()
    expect(label.classList.contains('on')).toBe(false)
    expect((label as HTMLElement).style.getPropertyValue('--c')).toBe('var(--label-none)')
    expect(el.querySelectorAll('.chip').length).toBe(0)
    // each is the body face at the view tab's measure
    const css = readFileSync(path.resolve(__dirname, '../../src/styles/chat.css'), 'utf8')
    expect(/\n\.surface-chip \{[^}]*height: 22px;[^}]*font: 400 var\(--text-ui-sm\) \/ 1 var\(--font-body\);/.test(css)).toBe(true)
    expect(/\n\.doc-chip \{/.test(css)).toBe(false)
  })

  test('a multi-class label\'s chip is the label glyph in its own ink; a single-class label keeps its square', async () => {
    const concepts = [
      { id: 'k1', name: 'kind of save', unit: 'record', labels: ['rescue', 'stall', 'none'], shown: true },
      { id: 'k2', name: 'disguise', unit: 'record', labels: ['yes', 'no'], shown: false },
    ]
    vi.stubGlobal('fetch', async (url: string) =>
      String(url).endsWith('/concepts') ? new Response(JSON.stringify(concepts), { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('{"detail":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } }),
    )
    const el = await mount(
      <>
        <LabelChip ws="wmulti" name="kind of save" />
        <LabelChip ws="wmulti" name="disguise" />
      </>,
    )
    await settle()
    const [multi, single] = [...el.querySelectorAll('.label-chip')] as HTMLElement[]
    expect(multi.querySelector('.label-chip-tag.icon-label')).not.toBeNull()
    expect(multi.querySelector('.label-chip-box')).toBeNull()
    expect(multi.style.getPropertyValue('--c')).toBe('var(--label-multi)')
    expect(single.querySelector('.label-chip-box')).not.toBeNull()
    expect(single.querySelector('.label-chip-tag')).toBeNull()
  })
})

describe('what holds a session', () => {
  // its permission requests wait on the permission card above the composer (tests/public/permission-card.test.tsx)
  test('the rules "don\'t ask again" added are listed, with or without an alert', async () => {
    const el = await mount(<Holds rules={[{ text: 'Bash(make *)' }, { text: 'all edits' }]} />)
    expect(el.querySelector('.chat-hold-rules')?.textContent).toBe('Not asked again in this session: Bash(make *), all edits')
  })

  test('an alert that only the terminal can answer is announced, and nothing shows when nothing holds the session', async () => {
    const text = 'Claude Code is waiting in your terminal: choose there how to go on.'
    const el = await mount(<Holds alert={{ kind: 'dialog', text } as never} />)
    expect(el.querySelector('.chat-hold[role="alert"]')?.textContent).toBe(text)
    const none = await mount(<Holds alert={null} />)
    expect(none.querySelector('.chat-holds')).toBeNull()
  })
})

describe('a run resumed after a server restart', () => {
  // the next server resumes a run the server's stop or death cut short, and the card of that run says so while it runs
  test('the card of the run that resumed says so while it runs, and no other card does', async () => {
    const meta = { restarted: { run: 0, ts: '2026-09-25T18:46:14Z' }, run: 0 }
    expect(restartedNow(meta, undefined, true)).toBe(true)
    expect(restartedNow(meta, 0, true)).toBe(true)
    expect(restartedNow(meta, 0, false)).toBe(false)
    expect(restartedNow({ restarted: { run: 2 }, run: 2 }, 1, true)).toBe(false)
    expect(restartedNow({ restarted: { run: 2 }, run: 2 }, 2, true)).toBe(true)
    expect(restartedNow({ restarted: null, run: 3 }, undefined, true)).toBe(false)
    expect(restartedNow(null, undefined, true)).toBe(false)
    const el = await mount(<Holds restarted />)
    expect(el.querySelector('.chat-hold-restarted')?.textContent).toBe(RESTARTED_LINE)
  })
})
