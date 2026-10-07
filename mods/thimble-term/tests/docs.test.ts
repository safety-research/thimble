// Documents as thimble-term draws them: a report's contents a click
// away, a passage's thread told the document and its section, the writer's state while it writes, the retell controls,
// the documents list's keys, a story stepped beat by beat with its figure lit at the beat's step.
// `claude plugin test mods/thimble-term`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { CWD, DOC, WS, shown, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine

const PANE = { plugin: 'thimble-term', component: 'Pane', requestId: 'thimble-term', surface: 'terminal', viewport: { columns: 120, rows: 40 }, props: { title: 'thimble', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { bodyRows: 36 }, view: {} } } as never

const LONG = {
  ...DOC,
  sections: [
    ...DOC.sections,
    { id: 's3', heading: 'What it leaves open', paragraphs: [{ id: 'p3', sentences: [{ id: 'x4', text: 'One week only.' }] }], figures: [] },
  ],
}

async function start($: E, w: World): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

/** Home, then a click on the row that shows `text`; the panel drawn again. */
async function fromHome($: E, w: World, text: string): Promise<M> {
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  let pane = (await $.ui.mount(PANE)) as unknown as M
  const rows = ((await pane.drawn({ in: 'm:home' })) as { children?: unknown[] }).children ?? []
  await pane.pointer({ type: 'down', x: 4, y: rows.findIndex(r => shown(r).includes(text)), button: 'left', in: 'm:home' } as never)
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  return pane
}

test("a report of three sections or more lists them under `Contents`; a click on one draws the report from there", async ($, on) => {
  const w = world(on)
  w.docs.report = LONG
  await start($, w)
  let pane = await fromHome($, w, DOC.title)
  let text = shown(await pane.drawn())
  expect(text).toContain('Contents')
  expect(shown(await pane.drawn({ in: 'doc-toc' }))).toContain('3  What it leaves open')
  expect(text).toContain('1-9 for a section')
  await pane.pointer({ type: 'down', x: 3, y: 2, button: 'left', in: 'doc-toc' } as never)
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  text = shown(await pane.drawn())
  expect(text).toContain('## What it leaves open')
  expect(text).not.toContain('## The data')
  await pane.unmount()
})

test("a passage's \"?\" in a document asks a thread told the document, its section and the passage", async ($, on) => {
  const w = world(on)
  await start($, w)
  const pane = await fromHome($, w, DOC.title)
  const ask = ((await pane.findAll({ type: 'Button' })) as { key?: string }[]).find(b => /^ask-d1-/.test(String(b.key)) && !/-0$/.test(String(b.key)))!
  await pane.press({ key: ask.key! })
  await w.clock.settle()
  await pane.unmount()
  const asked = (await $.ui.mount(PANE)) as unknown as M
  await asked.input({ key: 'ask-new', text: 'Which week?' })
  await w.clock.settle()
  expect(w.acts.find(a => a.kind === 'thread')!.payload).toMatchObject({ anchor: 'report:report#s2', anchor_text: `"${DOC.title}" › The main claim: One week of June holds most saves.`, element: 'report:report#s2' })
  await asked.unmount()
})

test("while the writer writes: `◌ writing · N tool calls · <its latest words>`, and the request until anything is written", async ($, on) => {
  const w = world(on)
  w.states.docs = { ...w.states.docs, slides: { exists: false, renderer: 'slides', name: 'Slides', status: 'generating' } as never }
  w.states.agents = { ...w.states.agents, rows: [...w.states.agents.rows, { name: 'thimble:writer', label: 'writer: slides', state: 'running', kind: 'subagent', chat: 'w1', role: 'writer' }] }
  w.chats.w1 = { meta: { id: 'w1', kind: 'agent', title: 'slides' }, events: [{ type: 'user', text: 'Slides on the relay, five at most.' }, { type: 'tool_use', id: 'a', name: 'Read', input: {} }, { type: 'tool_use', id: 'b', name: 'Read', input: {} }, { type: 'text', delta: 'Drafting the second slide' }] }
  w.docs.slides = { error: 'not written yet' }
  await start($, w)
  const pane = await fromHome($, w, 'Slides')
  const text = shown(await pane.drawn())
  expect(text).toContain('◌ writing · 2 tool calls · Drafting the second slide')
  expect(text).toContain('the request: Slides on the relay, five at most.')
  await pane.unmount()
})

test('`as slides` (s) and `as a story` (y) ask main to write the document again in that form', async ($, on) => {
  const w = world(on)
  await start($, w)
  const pane = await fromHome($, w, DOC.title)
  await pane.press({ key: 'hk-slides' })
  await w.clock.settle()
  expect(w.commands.at(-1)).toBe(`/thimble:write slides Retell the document "${DOC.title}" as slides.`)
  await pane.press({ key: 'doc-as-story' })
  await w.clock.settle()
  expect(w.commands.at(-1)).toBe(`/thimble:write story Retell the document "${DOC.title}" as a story.`)
  await pane.unmount()
})

test('the documents list: `❯` on the chosen row, 1-9 open the first nine', async ($, on) => {
  const w = world(on)
  await start($, w)
  let pane = await fromHome($, w, 'Documents (1)')
  expect(shown(await pane.drawn({ in: 'm:docs-list' }))).toContain('❯ ● Agents used the dse wiki as a relay')
  expect((await pane.find({ type: 'Button', key: 'doc-open-0' }))?.props).toMatchObject({ hotkey: '1' })
  await pane.press({ key: 'doc-open-0' })
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  expect(w.panes.at(-1)!.title).toBe(DOC.title)
  await pane.unmount()
})

test("a story steps one beat at a time, its figure lit at the beat's step; `read as a page` shows it whole", async ($, on) => {
  const w = world(on)
  const story = {
    id: 'story',
    title: 'The relay as a story',
    type: 'story',
    renderer: 'story',
    sections: [
      { id: 'b1', heading: 'One wiki held most pages', paragraphs: [{ id: 'q1', sentences: [{ id: 'z1', text: 'dse held most of them.' }] }], figures: [{ id: 'g1', cell: 'card:b0bar000', caption: 'Revisions per wiki.', role: 'main', highlight: ['dse'] }] },
      { id: 'b2', heading: 'Then it stopped', paragraphs: [{ id: 'q2', sentences: [{ id: 'z2', text: 'Nothing after June.' }] }], figures: [] },
    ],
  }
  w.docs.story = story
  w.states.docs = { ...w.states.docs, story: { exists: true, title: story.title, renderer: 'story', name: 'Story' } } as never
  w.states.home = { ...w.states.home, docs: { ...w.states.home.docs, story: { exists: true, title: story.title } } as never }
  await start($, w)
  let pane = await fromHome($, w, story.title)
  await w.clock.settle()
  await pane.redraw()
  let text = shown(await pane.drawn())
  expect(text).toContain('One wiki held most pages')
  expect(text).not.toContain('Then it stopped')
  const card = (await pane.findAll({ type: 'Client' })).find(c => String((c as { key?: string }).key).includes('b0bar000')) as { props?: { props?: { focus?: unknown } } } | undefined
  expect(card?.props?.props?.focus).toEqual({ row: 'dse', event: 'dse', node: 'dse' })
  await pane.press({ key: 'hk-page' })
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  text = shown(await pane.drawn())
  expect(text).toContain('One wiki held most pages')
  expect(text).toContain('Then it stopped')
  await pane.unmount()
  void WS
})

// a report as the writer stored it in the live run: an opening section with no heading whose sentences are bullets
const OPENING = {
  ...DOC,
  sections: [
    { id: 's0', heading: '', paragraphs: [{ id: 'p0', sentences: [{ id: 'b1', text: 'summary: [[4579|card:ff73e071#pages/TOTAL]] pages in all', bullet: '-' }, { id: 'b2', text: 'plot: revisions per wiki, dse far above the others', bullet: '-' }] }], figures: [] },
    ...LONG.sections,
  ],
}

test("a report's bullets stay a list, one item a row; an opening section with no heading is not in `Contents` and starts with its words", async ($, on) => {
  const w = world(on)
  w.docs.report = OPENING
  await start($, w)
  const pane = await fromHome($, w, DOC.title)
  const toc = shown(await pane.drawn({ in: 'doc-toc' }))
  // the three headed sections, numbered from 1; no row for the opening one
  expect(toc).toBe('1  The data2  The main claim3  What it leaves open')
  const tree = JSON.stringify(await pane.drawn())
  // each bullet its own block: the one with a citation a list item's paragraph, the other a Markdown list item
  expect(tree).toContain('"text":"- plot: revisions per wiki, dse far above the others"')
  expect(tree).toMatch(/"prefix":"- "[^]*"text":"summary: "/)
  expect(tree).not.toContain('pages in all plot:')
  // no empty heading line before the opening words
  expect(tree).not.toContain('"text":"## "')
  await pane.unmount()
})
