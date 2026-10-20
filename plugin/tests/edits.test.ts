// A card's versions (shell/shell.tsx noteEdits, runtime.ts readEdits): the kernel keeps every version, but the detail
// lists none by number. Only a change the analyst asked for, in a later turn, is an edit: the header says "edited", and
// h steps back through the card after each such change and as first made. A card made and saved again in one turn, a
// re-save that fixes what its save reported, and what a turn the analyst did not ask for saved are never listed.
// `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'
import { press, promptStub } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
const ROOT = '/data'
const ID = '01-orchard'
const FILE = `${ROOT}/thimble/objects/${ID}.json`
const EDITS = `${ROOT}/thimble/objects/.edits/${ID}.json`
const EVENTS = '/home/t/.thimble/lean/events/s-1.jsonl'
const region = (id: string, label: string) => ({ t: 'region', id, meta: { label }, kid: { t: 'text', runs: [{ s: label, tone: 'ink' }], wrap: false, w: 30 } })
const DRAWING = { kit: 1, w: 98, h: 24, mode: 'detail', root: { t: 'stack', kids: [region('row-1', 'Row 1'), region('row-2', 'Row 2')] }, cites: {}, examples: {}, regions: [{ id: 'row-1', meta: { label: 'Row 1' } }, { id: 'row-2', meta: { label: 'Row 2' } }], warnings: [], ms: 1 }
/** Version `v` of the card, its title saying which; `cites` with a problem is a citation the save said does not hold. */
const objectAt = (v: number, broken = false) => ({
  id: ID, version: v, title: `Trees per row (v${v})`, program: 'drawn here', data: {}, text: 'Row 2 has 3 trees.',
  lineage: { cites: broken ? [{ ref: 'q1#row=2@n', problem: 'no output row row=2' }] : [], problems: [] },
  history: Array.from({ length: v }, (_, i) => ({ v: i + 1, at: `t${i + 1}`, change: i ? 'changed' : 'made' })),
})

const ROW = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const reply = { component: 'AssistantMessage', surface: 'terminal', requestId: ROW, props: { text: 'Here.', isFirstOfReply: true }, viewport: { columns: 100, rows: 40, isFullscreen: true } } as never
const HINT = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 200, scroll: { offset: 0, bodyRows: 16 }, view: {} }, viewport: { columns: 200, rows: 48, isFullscreen: true } } as never
const PANE = { component: 'Pane', surface: 'terminal', requestId: 'object', props: { bodyColumns: 100, scroll: { bodyRows: 40, offset: 0 }, isFocused: true, placement: 'dock', title: 'Trees per row', view: {} } } as never
const edit = (key: string) => ({ origin: { kind: 'composer' }, key: { key }, text: '', cursor: 0, start: 0, end: 0, inputText: key.length === 1 ? key : '' }) as never

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function textOf(n: any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + textOf(n.children)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function world(on: any) {
  mock.env(on, { THIMBLE_HOME: '/home/t/.thimble' })
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 's-1' }))
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('config.list', () => ({ value: [] }))
  on('command.register', (_$: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('prompt.submit', (_$: unknown, e: { text: string }) => ({ text: e.text }))
  const files: Record<string, string> = {}
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files || e.path === `${ROOT}/thimble/objects` }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files[e.path] ?? promptStub(e.path) ?? '' }))
  on('fs.write', (_$: unknown, e: { path: string; content?: string; text?: string; data?: string }) => { files[e.path] = String(e.content ?? e.text ?? e.data ?? ''); return { value: undefined } })
  on('process.run', (_$: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
    if (e.argv[0] === 'tail') return { value: { exitCode: 0, stdout: (files[e.argv[3]!] ?? '').slice(Number(e.argv[2]!.slice(1)) - 1), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    const out = e.argv.some(a => a.endsWith('prep.mjs')) ? { drawing: DRAWING } : e.argv.includes('resolve') ? { ref: e.argv[2], chain: [], rows: [], count: 0, records: [], notes: [] } : e.argv.includes('coverage') ? { files: [] } : {}
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const opened: Any[] = []
  on('ui.open', (_$: unknown, e: Any) => { opened.push(e); return { value: { isPlaced: true } } })
  on('ui.panes', () => ({ value: opened.length ? [{ id: 'object', title: 'Trees per row', isShown: true, isFocused: true, isPlaced: true, plugin: 'thimble' }] : [] }))
  on('ui.focus', () => ({ value: {} }))
  on('prompt.edit', (_$: unknown, e: { text: string; start: number; end: number; inputText: string }) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  on('ui.render', { component: 'PromptHint' }, (_$: unknown, e: { props: { hint: string } }) => ({ type: 'Text', props: {}, children: [String(e.props.hint)] }) as never)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['Here.'] }) as never)
  // a Bash call that saves the card at version `v` as the kernel would: the card, the version before it kept for its
  // lineage, and a line in the change feed
  const queue: { v: number; broken?: boolean }[] = []
  on('tool.call', () => {
    const s = queue.shift() ?? { v: 1 }
    if (files[FILE]) files[`${ROOT}/thimble/objects/.versions/${ID}/v${s.v - 1}.json`] = files[FILE]
    files[FILE] = JSON.stringify(objectAt(s.v, s.broken))
    files[EVENTS] = (files[EVENTS] || '') + JSON.stringify({ t: Date.now() / 1000, kind: 'save', session: 's-1', root: ROOT, object: ID, version: s.v }) + '\n'
    return { result: `saved ${ID} v${s.v}: thimble/objects/${ID}.json\n` }
  })
  return { files, queue }
}

let turns = 0
/** One turn of main's that saves the card as `saves` say; `typed` is the prompt the analyst typed for it, else none
 *  (a background job's report starts the turn). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function turnSaving($: any, w: ReturnType<typeof world>, clock: { settle: () => Promise<void> }, saves: { v: number; broken?: boolean }[], typed: string | null) {
  w.queue.push(...saves)
  const turnId = `t${++turns}`
  if (typed) await $.prompt.submit({ text: typed, origin: { kind: 'composer' } } as never)
  await $.turn.start({ turnId, text: typed ?? '<task-notification>done</task-notification>' } as never)
  for (const _ of saves) await $.tool.call({ tool: 'Bash', command: 'thimble save orchard --from card.json' } as never)
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Here.' }] } } as never)
  await $.turn.complete({ turnId, answer: 'Here.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await clock.settle()
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function drawn($: any, clock: { settle: () => Promise<void> }, what: unknown): Promise<string> {
  for (let i = 0; i < 3; i++) { await $.ui.render(what); await clock.settle() }
  return textOf(await $.ui.render(what))
}
const edits = (w: ReturnType<typeof world>) => (w.files[EDITS] ? JSON.parse(w.files[EDITS]).edits : [])

test('a card made and saved again in one turn, a re-save after a citation that did not hold, and a turn the analyst did not ask for list no versions', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  // made in the turn the analyst asked for, and saved twice more before the reply was done
  await turnSaving($, w, clock, [{ v: 1 }, { v: 2 }, { v: 3, broken: true }], 'how many trees per row?')
  // the analyst's next turn: Claude fixes the citation the save said did not hold
  await turnSaving($, w, clock, [{ v: 4 }], 'thanks, and the oldest tree?')
  // a background job's report: Claude saves it again
  await turnSaving($, w, clock, [{ v: 5 }], null)
  expect(edits(w)).toEqual([])
  await drawn($, clock, reply)
  expect(await press($, clock, edit('1'))).toEqual({ text: '', cursor: 0 })
  const t = await drawn($, clock, PANE)
  expect(t).toContain('card:01-orchard')
  // (the title names its version for the test; the header names none)
  expect(t).not.toMatch(/\bv\d\b(?!\))|edited/)
  expect(textOf(await $.ui.render(HINT))).not.toMatch(/\bh (earlier|newest|versions)/)
})

test('a change the analyst asked for is an edit: the header says edited, and h steps back to the card as first made and comes back', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await turnSaving($, w, clock, [{ v: 1 }, { v: 2 }], 'how many trees per row?')
  // "split it by orchard": the change, saved twice (its own save fixed in the same turn); then a report saves it again
  await turnSaving($, w, clock, [{ v: 3, broken: true }, { v: 4 }], 'split it by orchard')
  await turnSaving($, w, clock, [{ v: 5 }], null)
  expect(edits(w)).toEqual([3])
  await drawn($, clock, reply)
  expect(await press($, clock, edit('1'))).toEqual({ text: '', cursor: 0 })
  let t = await drawn($, clock, PANE)
  expect(t).toContain('edited')
  expect(t).toContain('Trees per row (v5)')
  expect(t).not.toMatch(/\bv\d\b(?!\))/)
  expect(textOf(await $.ui.render(HINT))).toContain('h earlier version')
  // h: the card as first made, as its first turn left it
  await clock.advance(1000)
  expect(await press($, clock, edit('h'))).toEqual({ text: '', cursor: 0 })
  t = await drawn($, clock, PANE)
  expect(t).toContain('as first made')
  expect(t).toContain('Trees per row (v2)')
  expect(textOf(await $.ui.render(HINT))).toContain('h newest version')
  // h again: the card now
  await clock.advance(1000)
  expect(await press($, clock, edit('h'))).toEqual({ text: '', cursor: 0 })
  t = await drawn($, clock, PANE)
  expect(t).toContain('Trees per row (v5)')
  expect(t).toContain('edited')
})
