// The panel as thimble-term draws it: the threads panel (roots per
// place, what a thread is about, stop, its keys, a question that waits), a new thread's passage, the trail of a thread
// asked from a thread, the pane's titles, a draft in the prompt, home (views, documents, threads, files, coverage) and
// the views pane. `claude plugin test mods/thimble-term`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { labelHue } from '../hooks/home'
import { CWD, WS, shown, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine

const MESSAGE = (requestId: string, text: string) =>
  ({ plugin: 'thimble-term', component: 'AssistantMessage', requestId, surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: true } }) as never
const PANE = { plugin: 'thimble-term', component: 'Pane', requestId: 'thimble-term', surface: 'terminal', viewport: { columns: 120, rows: 40 }, props: { title: 'thimble', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { bodyRows: 36 }, view: {} } } as never

async function start($: E, w: World): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

async function home($: E, w: World): Promise<M> {
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  return (await $.ui.mount(PANE)) as unknown as M
}

/** A click on the home panel's row that shows `text`; the panel drawn again. */
async function homeClick($: E, w: World, pane: M, text: string, x = 4): Promise<M> {
  const rows = ((await pane.drawn({ in: 'm:home' })) as { children?: unknown[] }).children ?? []
  const y = rows.findIndex(r => shown(r).includes(text))
  expect(y).toBeGreaterThan(0)
  await pane.pointer({ type: 'down', x, y, button: 'left', in: 'm:home' } as never)
  await w.clock.settle()
  await pane.unmount()
  return (await $.ui.mount(PANE)) as unknown as M
}

test("a thread that answers: what it is about, dim, before its first question; `stop` (s) ends it; Enter or a give the field the keys; a question asked meanwhile waits", async ($, on) => {
  const w = world(on)
  w.chats.t2 = { meta: { ...w.states.threads[2] }, events: [{ type: 'user', text: 'which pages were deleted?' }, { type: 'tool_use', id: 'u1', name: 'Bash', input: {} }] }
  await start($, w)
  let pane = await home($, w)
  pane = await homeClick($, w, pane, '"which pages were deleted?"')
  const text = shown(await pane.drawn())
  expect(text).toContain('about "the deletions"')
  expect(text).toContain('◌ 1 tool call')
  expect(text).toContain('stop')
  expect(text).toContain('↑↓ to choose · Enter or a to ask · s to stop · b to go back · x to close')
  await pane.press({ key: 'hk-stop' })
  await w.clock.settle()
  expect(w.acts).toContainEqual({ kind: 'stop', payload: { agent: 't2' } })
  // a gives the ask field the keys
  await pane.press({ key: 'hk-ask' })
  await w.clock.settle()
  const field = ((await pane.findAll({ type: 'Input' })) as { key?: string }[]).find(i => String(i.key).startsWith('ask-'))!
  await pane.input({ key: field.key!, text: 'And in June?' })
  await w.clock.settle()
  expect(w.toasts).toContain('thimble: the side thread is still answering: your question waits until it ends')
  await pane.unmount()
})

test('the threads tree has a root per place: main, and a document a thread was asked from; digits open the first nine', async ($, on) => {
  const w = world(on)
  Object.assign(w.states.threads[2]!, { anchor_element: 'report:report#s2' })
  await start($, w)
  let pane = await home($, w)
  pane = await homeClick($, w, pane, 'Threads (2)')
  const tree = shown(await pane.drawn({ in: 'm:threads-tree' }))
  expect(tree).toContain('main')
  expect(tree).toContain('report "Agents used the dse wiki as a relay"')
  expect(tree.indexOf('main')).toBeLessThan(tree.indexOf('report "'))
  await pane.press({ key: 'hk-t0' })
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  // the thread's step is named by its first question, not thimble's slug of it
  expect(shown(await pane.drawn())).toContain('"why is events.jsonl so much bigger?"')
  await pane.unmount()
})

test('a new thread shows the first sentence of its passage, dim; one asked from a thread in the panel hangs under it', async ($, on) => {
  const w = world(on)
  await start($, w)
  let pane = await home($, w)
  pane = await homeClick($, w, pane, '"why is events.jsonl bigger?"')
  // the "?" beside the thread's answer, from inside the panel
  const ask = ((await pane.findAll({ type: 'Button' })) as { key?: string }[]).find(b => /^ask-t1-/.test(String(b.key)))!
  await pane.press({ key: ask.key! })
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.drawn())).toContain('New thread')
  await pane.input({ key: 'ask-new', text: 'Why one per event?' })
  await w.clock.settle()
  expect(w.acts.find(a => a.kind === 'thread')!.payload).toMatchObject({ parent: 't1', message: 'Why one per event?' })
  await pane.unmount()
})

test("a new thread's passage longer than its subtitle: its first sentence, dim, on one row", async ($, on) => {
  const w = world(on)
  await start($, w)
  const ui = (await $.ui.mount(MESSAGE('m1', 'Most saves came in June, when the agents were busiest on the dse wiki and its board. Few came later.'))) as unknown as M
  await ui.press({ key: 'ask-1-0' })
  await ui.unmount()
  await w.clock.settle()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  const words = (await pane.find({ type: 'Text', text: /^Most saves came in June, when the agents were busiest on the dse wiki and its board\.$/ })) as { props?: Record<string, unknown> } | undefined
  expect(words?.props).toMatchObject({ dimColor: true, wrap: 'truncate-end' })
  await pane.unmount()
})

test('a thread asked from a thread, opened from main, stands under it on the path', async ($, on) => {
  const w = world(on)
  w.states.threads.push({ id: 't3', kind: 'thread', role: 'thread', title: 'and the rest?', anchor: null, anchor_text: 'one per event', parent: 't1', created_at: '2026-10-06T10:05:00+00:00', running: false, answers: 1, seen: 0 } as never)
  w.chats.t3 = { meta: w.states.threads.at(-1), events: [{ type: 'user', text: 'and the rest?' }, { type: 'text', delta: 'Saves.' }, { type: 'done', result: 'Saves.' }] }
  await start($, w)
  await $.turn.start({ text: 'Go on.', turnId: 't1' } as never)
  await $.session.append({ door: 'response', origin: { kind: 'model', model: 'm' }, uuid: 'r1', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Asked.' }] } } as never).catch(() => undefined)
  await $.turn.complete({ turnId: 't1', answer: 'Asked.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  Object.assign(w.states.threads.at(-1)!, { answers: 2 })
  w.chats.t3 = { meta: w.states.threads.at(-1), events: [{ type: 'user', text: 'and the rest?' }, { type: 'done', result: 'Saves.' }, { type: 'user', text: 'more?' }, { type: 'done', result: 'No.' }] }
  w.stamps.set(`${WS}/chats`, 9)
  await w.clock.advance(1100)
  const ui = (await $.ui.mount(MESSAGE('r1', 'Asked.'))) as unknown as M
  await ui.press({ key: 'signal-open-t3' })
  await ui.unmount()
  await w.clock.settle()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  const way = shown(await pane.drawn({ in: 'way' } as never).catch(async () => (await pane.find({ key: 'way' })) as unknown))
  expect(way).toContain('"why is events.jsonl bigger?"')
  expect(way).toContain('"and the rest?"')
  await pane.unmount()
})

test("the pane's title says what the panel shows; a draft in the prompt keeps the keys, and a toast says so", async ($, on) => {
  const w = world(on)
  await start($, w)
  w.draft = 'half a question'
  const ui = (await $.ui.mount(MESSAGE('m1', 'The README says [4,579](README.md#L3) pages.'))) as unknown as M
  await ui.pointer({ type: 'down', x: 18, y: 0, button: 'left', in: 'para-1' } as never)
  await ui.pointer({ type: 'up', x: 18, y: 0, button: 'left', in: 'para-1' } as never)
  await ui.unmount()
  await w.clock.settle()
  expect(w.panes.at(-1)).toMatchObject({ id: 'thimble-term', title: 'Citation' })
  expect(w.toasts).toContain('the prompt holds a draft, so it keeps the keys: click the panel to use its keys')
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  expect(w.panes.at(-1)!.title).toBe('Home')
})

test("home: views by state, the glyph alone saying it; documents under that word; a thread's subject and an earlier session's; files' kind then size; the coverage line", async ($, on) => {
  const w = world(on)
  w.states.home = { ...w.states.home, views: [{ slug: 'edit-bursts', name: 'Edit Bursts', status: 'proposed', ts: '2026-10-07T01:00:00Z', files: ['revisions.jsonl'] }, { slug: 'board', name: 'Board', status: 'built', ts: '2026-10-07T02:00:00Z', files: ['board.jsonl'] }], coverage: 'Coverage: 2 of 3 files opened; data/ never.' } as never
  w.states.threads[1]!.created_at = '2020-01-01T00:00:00+00:00'
  // a thread about a citation, titled by its words (as openAsk asks for it)
  w.states.threads.push({ id: 't3', kind: 'thread', role: 'thread', title: '4579', anchor: 'card:ff73e071#pages/TOTAL', anchor_text: 'The export holds 4579 pages and 14592 revisions.', parent: 'main', created_at: '2026-10-06T10:05:00+00:00', running: false, answers: 1, seen: 0, question: 'Is 4579 every page?' } as never)
  await start($, w)
  const pane = await home($, w)
  const lines = (((await pane.drawn({ in: 'm:home' })) as { children?: unknown[] }).children ?? []).map(r => shown(r))
  const at = (s: string) => lines.find(l => l.includes(s)) ?? ''
  expect(at('Board')).toMatch(/● Board +board\.jsonl$/)
  expect(at('Edit Bursts')).toMatch(/○ Edit Bursts +revisions\.jsonl$/)
  expect(at('Edit Bursts')).not.toContain('proposed')
  expect(lines.indexOf(at('Board'))).toBeLessThan(lines.indexOf(at('Edit Bursts')))
  expect(lines.some(l => l.includes('Documents (1)'))).toBe(true)
  // a thread's subject at R by its citation's words, or a card's question cut at a word
  expect(at('"Is 4579 every page?"')).toMatch(/"Is 4579 every page\?" +about 4579 {2}new$/)
  expect(at('"why is events.jsonl bigger?"')).toMatch(/"why is events\.jsonl bigger\?" +about What does the export hold per… · earlier session {2}new$/)
  // a thread asked about a passage has no subject at R: its sentence would cut the question beside it
  expect(at('"which pages were deleted?"')).not.toContain('about')
  expect(at('Files (3)')).toMatch(/type {9}size$/)
  expect(at('README.md')).toMatch(/markdown {5}2 KB$/)
  // a folder's count after its name, dim, as the file browser shows it; only its size under `size`; a folder named as
  // the file browser names it: its path, the corpus's own files under the corpus folder's name
  expect(at('wiki/')).toMatch(/▾ wiki\/ {2}2 +52\.0 MB$/)
  expect(lines.find(l => /▸ data\//.test(l))).toMatch(/^\s*▸ data\/ {2}1 +2\.1 MB$/)
  expect(lines.some(l => l.includes('wiki/data/'))).toBe(false)
  expect(lines.some(l => l.includes('Coverage: 2 of 3 files opened; data/ never.'))).toBe(true)
  // a label's ● in the label's color, as the label panel draws it beside its name
  const homeTree = JSON.stringify(await pane.drawn({ in: 'm:home' }))
  expect(homeTree).toContain(`{"type":"Text","props":{"color":"${labelHue(['proxy-link', 'none'])}"},"children":["●"]},{"type":"Text","children":[" links through a fetch proxy`)
  await pane.unmount()
})

test('after a resume, a thread asked earlier in the same conversation is not an earlier session\'s', async ($, on) => {
  const w = world(on)
  w.states.threads[1]!.created_at = '2020-01-01T00:00:00+00:00'
  // the conversation began before the thread: Claude Code's session figures count from its first launch
  w.startedAt = Date.parse('2019-12-31T00:00:00Z')
  await start($, w)
  const pane = await home($, w)
  const lines = (((await pane.drawn({ in: 'm:home' })) as { children?: unknown[] }).children ?? []).map(r => shown(r))
  expect(lines.find(l => l.includes('"why is events.jsonl bigger?"'))).not.toContain('earlier session')
  await pane.unmount()
})

test("home's open folder of 21 files shows all 21; of 25, 20 and `… 5 more`, which shows the folder whole in the file browser", async ($, on) => {
  const w = world(on)
  w.states.files = Array.from({ length: 25 }, (_, i) => ({ path: `logs/run-${i + 1}.txt`, kind: 'text', size_bytes: 100 }))
  await start($, w)
  let pane = await home($, w)
  const rows = (((await pane.drawn({ in: 'm:home' })) as { children?: unknown[] }).children ?? []).map(r => shown(r))
  expect(rows.filter(r => /run-\d+\.txt/.test(r)).length).toBe(20)
  expect(rows.some(r => r.includes('… 5 more'))).toBe(true)
  pane = await homeClick($, w, pane, '… 5 more', 8)
  const tree = shown(await pane.drawn({ in: 'm:files-tree' }))
  expect(tree).toContain('run-25.txt')
  expect(tree).not.toContain('more')
  await pane.unmount()
  w.states.files = Array.from({ length: 21 }, (_, i) => ({ path: `logs/run-${i + 1}.txt`, kind: 'text', size_bytes: 100 }))
})

test('the views pane: each view by its glyph and name, its files at R, `new` once built; ↑↓ choose, a click opens its line', async ($, on) => {
  const w = world(on)
  w.states.home = { ...w.states.home, views: [{ slug: 'board', name: 'Board', status: 'building', ts: '2026-10-07T02:00:00Z', files: ['board.jsonl'] }] } as never
  await start($, w)
  w.states.home = { ...w.states.home, views: [{ slug: 'board', name: 'Board', status: 'built', ts: '2026-10-07T02:00:00Z', files: ['board.jsonl'] }, { slug: 'x', name: 'Broken', status: 'failed', ts: '2026-10-07T01:00:00Z', files: [] }] } as never
  w.stamps.set(`${WS}/views/proposals.json`, 3)
  await w.clock.advance(1100)
  let pane = await home($, w)
  pane = await homeClick($, w, pane, 'Views (2)')
  const text = shown(await pane.drawn())
  expect(text).toContain('2 views · 1 built')
  const list = (((await pane.drawn({ in: 'm:views-list' })) as { children?: unknown[] }).children ?? []).map(r => shown(r))
  expect(list[0]).toMatch(/● Board +board\.jsonl {2}new$/)
  expect(list[1]).toMatch(/× Broken$/)
  expect(text).toContain('↑↓ to choose · Enter to open · b to go back · x to close')
  await pane.press({ key: 'view-open-0' })
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.drawn())).toContain('Board')
  expect(w.panes.at(-1)!.title).toBe('Board')
  await pane.unmount()
})

test("a thread about a citation names its subject by the citation's words in the ask view, the thread and home; the ask fields say what they take", async ($, on) => {
  const w = world(on)
  await start($, w)
  const text = 'The export holds [[4579|card:ff73e071#pages/TOTAL]] pages.'
  let ui = (await $.ui.mount(MESSAGE('m1', text))) as unknown as M
  await w.clock.advance(300)
  await ui.unmount()
  ui = (await $.ui.mount(MESSAGE('m1', text))) as unknown as M
  await ui.pointer({ type: 'down', x: 18, y: 0, button: 'left', in: 'para-1' } as never)
  await ui.pointer({ type: 'up', x: 18, y: 0, button: 'left', in: 'para-1' } as never)
  await ui.unmount()
  await w.clock.settle()
  let pane = (await $.ui.mount(PANE)) as unknown as M
  await pane.press({ key: 'cite-ask' })
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  let drawn = shown(await pane.drawn())
  expect(drawn).toContain('about 4579')
  // the field alone, its placeholder saying what it takes; `ask` is only Enter's word
  expect((await pane.find({ type: 'Input', key: 'ask-new' }))?.props).toMatchObject({ placeholder: 'type your question', submitLabel: 'ask' })
  expect(drawn).not.toMatch(/(^|[^a-z])ask {2}/)
  await pane.input({ key: 'ask-new', text: 'Is 4579 every page?' })
  await w.clock.settle()
  expect(w.acts.find(a => a.kind === 'thread')!.payload).toMatchObject({ anchor: 'card:ff73e071#pages/TOTAL', title: '4579', message: 'Is 4579 every page?' })
  await pane.unmount()
  // the thread as thimble lists it: titled by the words, its anchor's sentence kept for the fork
  w.states.threads.push({ id: 't9', kind: 'thread', role: 'thread', title: '4579', anchor: 'card:ff73e071#pages/TOTAL', anchor_text: 'The export holds 4579 pages.', parent: 'main', created_at: '2026-10-06T10:05:00+00:00', running: false, answers: 1, seen: 1, question: 'Is 4579 every page?' } as never)
  w.chats.t9 = { meta: w.states.threads.at(-1), events: [{ type: 'user', text: 'Is 4579 every page?' }, { type: 'text', delta: 'Yes.', reply: true }] }
  w.stamps.set(`${WS}/chats`, 11)
  await w.clock.advance(1100)
  pane = await home($, w)
  pane = await homeClick($, w, pane, '"Is 4579 every page?"')
  drawn = shown(await pane.drawn())
  expect(drawn).toContain('about 4579')
  expect(drawn).not.toContain('about The export holds')
  // the next question's field: a blank row under the answer, a placeholder
  const row = (await pane.find({ type: 'Box', key: 'ask-row' })) as { props?: Record<string, unknown> } | undefined
  expect(row?.props).toMatchObject({ marginTop: 1 })
  const field = ((await pane.findAll({ type: 'Input' })) as { key?: string; props?: Record<string, unknown> }[]).find(i => String(i.key).startsWith('ask-'))
  expect(field?.props).toMatchObject({ placeholder: 'ask a follow-up question' })
  await pane.unmount()
})

test("a thread's answer is its first reply, in paragraphs, without the fork's working words after it; the cards the thread made stand under it in their frames", async ($, on) => {
  const w = world(on)
  const t2 = w.states.threads.find(t => t.id === 't2')! as Record<string, unknown>
  Object.assign(t2, { running: false, answers: 1, seen: 1 })
  w.chats.t2 = {
    meta: { ...t2 },
    events: [
      { type: 'user', text: 'which pages were deleted?' },
      { type: 'tool_use', id: 'u1', name: 'Bash', input: {} },
      { type: 'text', delta: 'Two test pages, both on 4 June.', reply: true, by: 'terminal' },
      { type: 'tool_use', id: 'u2', name: 'Bash', input: {} },
      { type: 'text', delta: 'Making the card.', reply: true, by: 'terminal' },
      { type: 'tool_use', id: 'u3', name: 'mcp__plugin_thimble_thimble__add_card', input: {} },
      { type: 'tool_result', id: 'u3', summary: '$ add_card', cell_id: 'a0frame0' },
    ],
  }
  await start($, w)
  let pane = await home($, w)
  pane = await homeClick($, w, pane, '"which pages were deleted?"')
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  const text = shown(await pane.drawn())
  expect(text).toContain('Two test pages, both on 4 June.')
  expect(text).not.toContain('Making the card.')
  // the thread's card, under its answer, in its frame (its body a card Client)
  const json = JSON.stringify(await pane.drawn())
  expect(json).toMatch(/"key":"thread-card-1-0"[^]*"borderStyle":"round"[^]*"module":"hooks\/card\.tsx"[^]*How many records does each file hold\?/)
  await pane.unmount()
})

test("home names a side thread's group of cards by the thread's first question, never its slug title", async ($, on) => {
  const w = world(on)
  w.states.cards.groups.push({ id: 'g9', title: 'main/agent-chat:2', role: 'analyst', ts: '2026-10-06T11:00:00+00:00', chat: 't1' } as never)
  w.cells.a0frame0!.notebook = 'g9'
  Object.assign(w.states.threads[1]!, { question: 'Is the 3,898 deletions figure supported anywhere in the event log?' })
  await start($, w)
  const pane = await home($, w)
  const text = shown(await pane.drawn({ in: 'm:home' }))
  expect(text).toContain('in the thread "Is the 3,898 deletions figure supported anywhere in the…"')
  expect(text).not.toContain('main/agent-chat:2')
  await pane.unmount()
})

test("home opened after a card was made while another panel showed draws that card at once, not the list as home last read it", async ($, on) => {
  const w = world(on)
  await start($, w)
  let pane = await home($, w)
  expect(shown(await pane.drawn({ in: 'm:home' }))).toContain('Cards (13)')
  await pane.unmount()
  // the threads panel shows; a thread's fork makes a card meanwhile
  await $.command.run({ command: 'thimble:thimble', args: 'threads' } as never)
  await w.clock.settle()
  w.cells.n9new000 = { id: 'n9new000', notebook: 'g1', kind: 'note', title: 'A card a thread made', takeaway: '', labels: [], created_by: 'chat:t1', payload: { text: 'x' } }
  const mark = w.calls.length
  w.stamps.set(`${WS}/notebooks`, 9)
  await w.clock.advance(1100)
  // home's list of cards is read again then, though home does not show: home opened next draws from it at once
  expect(w.calls.slice(mark).filter(c => c[2] === 'cards' && c.includes(new Date(0).toISOString())).length).toBe(1)
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.drawn({ in: 'm:home' }))).toContain('Cards (14)')
  await pane.unmount()
})

test('the key hints come in one order on every panel: choosing, Enter, Space, the panel\'s own keys, back, close', async ($, on) => {
  const w = world(on)
  await start($, w)
  let pane = await home($, w)
  expect(JSON.stringify(await pane.drawn())).toContain('↑↓ to choose · Enter to open · Space to fold · x to close')
  await pane.unmount()
  await $.command.run({ command: 'thimble:thimble', args: 'files' } as never)
  await w.clock.settle()
  pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.drawn())).toContain('↑↓ to choose · Enter to open · Space to fold · b to go back · x to close')
  await pane.unmount()
})
