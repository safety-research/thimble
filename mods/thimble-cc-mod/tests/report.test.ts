// Reports: each form read from its markdown, the writer's pipeline (with a fake engine context), and the report views as
// the panel draws them. `claude plugin test mods/thimble-cc-mod`.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Mounted, TestBody } from 'claude-code/testing'

import type { ChatAgent, ChatReport, ChatReportNav } from '../types'
import type { CardData } from '../hooks/draw'
import { TYPES, buttonRows, captionFocus, cardRows, docSegments, figureOf, fitCard, formProblems, headingKey, normalizeDoc, slidesOf, slugOf, splitTitle, stepFocus, storyOf, textRows, tocOf, wrapRows } from '../hooks/report'
import { guessForm, openAsReport, parseReportArgs, reportAppend, reportComplete, startReport } from '../hooks/reports'
import type { ReportCtx } from '../hooks/reports'
import { turns } from '../hooks/turns'

const CWD = '/corpus/wiki'
const BAR: CardData = {
  id: 'abc123',
  kind: 'bar',
  question: 'Which wikis have the most revisions?',
  x: 'wiki',
  y: 'revisions',
  note: '',
  source: { script: '.thimble-cc-mod/scripts/by.py', index: 0 },
  rows: [
    { label: 'dse', value: 13403, group: '' },
    { label: 'probier', value: 1013, group: '' },
  ],
  total: 14416,
}
const LINE: CardData = {
  id: 'ln0001',
  kind: 'line',
  question: 'How many saves a day?',
  x: 'day',
  y: 'saves',
  note: '',
  source: { script: '.thimble-cc-mod/scripts/saves.py', index: 0 },
  series: [{ name: 'saves', points: [['2026-06-17', 120], ['2026-06-18', 6543], ['2026-06-19', 300]] }],
}
// a table of fifteen label pairs whose names wrap in a narrow panel
const PAIRS: CardData = {
  id: 'tb0015',
  kind: 'table',
  question: 'Which label pairs write to the most of the same pages?',
  x: '',
  y: '',
  note: '',
  source: { script: '.thimble-cc-mod/scripts/pairs.py', index: 0 },
  columns: ['pair', 'shared pages', 'median minutes apart'],
  rows: Array.from({ length: 15 }, (_, i) => [`AgentSECCountyLinker${99172 + i} + OpenAIResearchSec${2028 + i}`, 9 - Math.floor(i / 3), 20.6 + i]),
}
const CARDS: Record<string, CardData> = { abc123: BAR, ln0001: LINE, tb0015: PAIRS }
const opts = { card: (id: string) => CARDS[id] }
// work a test started and did not await (a film rendering in the background) runs on
const settle = async () => {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

// a document a writer wrote
const DOC = ['# One wiki holds the edits', '', 'Four wikis were edited by agents.', '', '## Almost every revision is on one wiki', '', '![Revisions per wiki](card:abc123)', '', 'dse holds [[13403|card:abc123#revisions/dse]] of [[14416|card:abc123#revisions/all]] revisions.'].join('\n')

// ------------------------------------------------------------------------------------------------ forms

test('a figure line: its card, caption and step; a plain embed has neither', () => {
  expect(figureOf('![The spike is week 11](card:b2c3d4 "week 11")')).toEqual({ id: 'b2c3d4', caption: 'The spike is week 11', step: 'week 11' })
  expect(figureOf('[[card:abc123]]')).toEqual({ id: 'abc123', caption: '', step: '' })
  expect(figureOf('see [[card:abc123]] here')).toBeNull()
  expect(slugOf('What happened in the wiki?', new Set(['what-happened-in-the-wiki']))).toBe('what-happened-in-the-wiki-2')
  expect(splitTitle('\n# Title\n\nBody')).toEqual({ title: 'Title', body: 'Body' })
})

test('a document: callouts as labelled quotes, figures with captions, toggles apart, contents from its headings', () => {
  const doc = [
    '## The data is 4 wikis',
    'Text [[3|a.md#L1]].',
    '> [!WARNING] Counts start in June.',
    '![Revisions per wiki](card:abc123)',
    '<details><summary>How it was counted</summary>',
    '',
    'By a script.',
    '',
    '</details>',
    '## dse holds most [[13403|card:abc123#revisions/dse]] revisions',
    '### A detail',
  ].join('\n')
  // a callout's kind as a word, no icon
  expect(normalizeDoc('> [!NOTE] Look.')).toBe('> note  Look.')
  const segs = docSegments(doc)
  expect(segs.map(s => s.kind)).toEqual(['md', 'toggle', 'md'])
  expect(segs[0]!.kind === 'md' && segs[0]!.text).toContain('> warning  Counts start in June.')
  expect(segs[0]!.kind === 'md' && segs[0]!.text).toContain('[[card:abc123]]\n*Revisions per wiki*')
  expect(segs[1]).toEqual({ kind: 'toggle', key: 'toggle-1', summary: 'How it was counted', body: 'By a script.' })
  const toc = tocOf(segs)
  expect(toc.map(t => `${t.level} ${t.text} ${t.segment}`)).toEqual(['2 The data is 4 wikis 0', '2 dse holds most 13403 revisions 2', '3 A detail 2'])
  // each heading's row key, as the reply drawing keys it: Markdown, or a heading with citations
  const seg2 = segs[2]!.kind === 'md' ? segs[2]!.text : ''
  expect(headingKey(seg2, 'r2-', toc[1]!.line)).toBe('r2-parabox-1')
  expect(headingKey(seg2, 'r2-', toc[2]!.line)).toBe('r2-md-2-0')
  expect(headingKey(segs[0]!.kind === 'md' ? segs[0]!.text : '', 'r0-', toc[0]!.line)).toBe('r0-md-1-0')
})

test('slides: a title slide, then one per section with its cards, layout and notes', () => {
  const deck = slidesOf(['# Refunds', '', 'One charger.', '', '## Two thirds name one charger', '', '![x](card:abc123)', '![y](card:ln0001)', '', '- [[290|card:abc123#revisions/dse]] of them.', '', 'Layout: two cards', '', 'Notes. Batch 17.', '', '## Part two'].join('\n'))
  expect(deck.title).toBe('Refunds')
  expect(deck.slides.map(s => `${s.kind}:${s.heading}:${s.layout}`)).toEqual(['title:Refunds:title', 'slide:Two thirds name one charger:two cards', 'title:Part two:bullets'])
  expect(deck.slides[1]!.cards.map(c => c.id)).toEqual(['abc123', 'ln0001'])
  expect(deck.slides[1]!.notes).toBe('Batch 17.')
  expect(deck.slides[1]!.body).toBe('- [[290|card:abc123#revisions/dse]] of them.')
})

test('a story: beats with one figure each, a step lit on the card, where the figure stands', () => {
  const st = storyOf(['# T', '', 'The answer.', '', '## Saves spiked', '', '![x](card:ln0001 "2026-06-18")', '', '- big', '', '## Limitations', '', 'Card: none', '', 'Unknown.'].join('\n'))
  expect(st.lead).toBe('The answer.')
  expect(st.beats.map(b => `${b.heading}:${b.figure?.step ?? ''}:${b.place}`)).toEqual(['Saves spiked:2026-06-18:right', 'Limitations::none'])
  expect(stepFocus(LINE, '2026-06-18')).toEqual({ row: '2026-06-18' })
  expect(stepFocus(BAR, 'probier')).toEqual({ row: 'probier' })
  expect(stepFocus(BAR, 'callout: 212')).toBeUndefined()
  expect(captionFocus(BAR, 'card:abc123#revisions/dse')).toEqual({ row: 'dse' })
  expect(captionFocus(LINE, 'step:2026-06-19')).toEqual({ row: '2026-06-19' })
})

test('what a form lacks', () => {
  expect(formProblems('no title', 'document')).toEqual(['it has no "# " title'])
  expect(formProblems(DOC, 'document')).toEqual([])
  expect(formProblems('# Deck\n\nopening', 'slides')).toEqual(['the deck has no "## " slide'])
  expect(guessForm('a deck for Monday')).toBe('slides')
  expect(guessForm('write it up')).toBe('document')
  // there is no video: a request for one is a document
  expect(TYPES.some(t => t.id === 'video')).toBe(false)
  expect(guessForm('make me a video explaining what is going on in this dataset')).toBe('document')
  expect(parseReportArgs('slides what happened')).toEqual({ form: 'slides', request: 'what happened' })
  expect(parseReportArgs('make me a video of it')).toEqual({ form: 'document', request: 'make me a video of it' })
})

// ------------------------------------------------------------------------------------------------ the writer, with a fake engine

type Fake = { started?: Promise<void>; ctx: ReportCtx; files: Map<string, string>; spawned: { prompt: string; desc: string }[]; notes: string[]; runs: string[][]; reports: Map<string, ChatReport>; agents: Map<string, ChatAgent>; nav: ChatReportNav | null; opened: string[] }

function fake(python = false): Fake {
  const f: Fake = { files: new Map(), spawned: [], notes: [], runs: [], reports: new Map(), agents: new Map(), nav: null, opened: [] } as unknown as Fake
  const prompts: Record<string, string> = {
    'writer.md': 'You write a {{form}}, "{{title}}": "{{request}}". Write it to {{file}}. {{source}}{{form_guide}} Run python3 {{helper}}/report.py check {{file}} --contract {{contract}}.',
    'document.md': 'The document is a page.',
  }
  for (const [k, v] of Object.entries(prompts)) f.files.set(`/mod/prompt/reports/${k}`, v)
  f.ctx = {
    home: '.thimble-cc-mod',
    panel: 'thimble',
    margin: 4,
    now: async () => 1_790_000_000_000,
    read: async p => {
      const t = f.files.get(p)
      if (t === undefined) throw new Error(`ENOENT ${p}`)
      return t
    },
    write: async (p, t) => {
      f.files.set(p, t)
    },
    mtime: async p => {
      if (!f.files.has(p)) throw new Error(`ENOENT ${p}`)
      return f.files.get(p)!.length
    },
    list: async dir => [...f.files.keys()].filter(p => p.startsWith(`${dir}/`)).map(p => p.slice(dir.length + 1)),
    run: async argv => {
      f.runs.push(argv)
      void python
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    report: async slug => f.reports.get(slug),
    setReport: async r => {
      f.reports.set(r.slug, r)
    },
    agent: async id => f.agents.get(id),
    setAgent: async (id, a) => {
      f.agents.set(id, a)
    },
    nav: async () => f.nav,
    setNav: async n => {
      f.nav = n
    },
    els: () => {
      throw new Error('no drawing here')
    },
    scroll: async () => undefined,
    where: async () => ({ cwd: CWD, root: '/mod' }),
    guide: async () => '# thimble-cc-mod guidance',
    drawReply: async () => [],
    cardEl: async () => {
      throw new Error('no drawing here')
    },
    loadCard: async id => CARDS[id] ?? null,
    openPane: async view => {
      f.opened.push(view)
    },
    closePanel: async () => undefined,
    spawn: async (prompt, desc) => {
      f.spawned.push({ prompt, desc })
      return { agentId: `agent-${f.spawned.length}`, engine: 'fork' }
    },
    noteMain: async t => {
      f.notes.push(t)
    },
    link: () => {
      throw new Error('no drawing here')
    },
    framed: () => {
      throw new Error('no drawing here')
    },
    code: () => {
      throw new Error('no drawing here')
    },
    thread: async () => undefined,
    checkCites: async text => (text.includes('|nowhere.md') ? 1 : 0),
    afterTurn: fn => (f.started = fn()),
    remember: () => undefined,
    verifyOf: async () => undefined,
    setVerify: async () => undefined,
    runVerify: async () => undefined,
    openRef: async () => undefined,
  }
  return f
}

test('a writer starts from a prompt: its record, the panel, a subagent named for it with the form\'s guidance', async () => {
  const f = fake()
  const r = await startReport(f.ctx, { form: 'document', title: 'What happened in the wiki', request: 'write up what happened in this dataset' })
  expect(r).toMatchObject({ slug: 'what-happened-in-the-wiki', form: 'document', state: 'writing', file: '.thimble-cc-mod/reports/what-happened-in-the-wiki.md' })
  await f.started
  expect(f.reports.get(r.slug)?.agentId).toBe('agent-1')
  expect(f.spawned[0]!.desc).toBe('report · writing What happened in the wiki')
  expect(f.spawned[0]!.prompt).toBe('You write a document, "What happened in the wiki": "write up what happened in this dataset". Write it to .thimble-cc-mod/reports/what-happened-in-the-wiki.md. The document is a page. Run python3 /mod/helper/report.py check .thimble-cc-mod/reports/what-happened-in-the-wiki.md --contract document.')
  expect(f.agents.get('agent-1')).toEqual({ kind: 'report', label: 'report · writing What happened in the wiki', report: 'what-happened-in-the-wiki' })
  expect(f.opened).toEqual(['report'])
  expect(f.nav).toEqual({ slug: 'what-happened-in-the-wiki', slide: 0, notes: false, open: [] })
  expect(JSON.parse(f.files.get(`${CWD}/.thimble-cc-mod/reports/what-happened-in-the-wiki.json`)!).state).toBe('writing')
  // its progress: tool calls counted, its latest words kept
  await reportAppend(f.ctx, 'agent-1', 'response', [{ type: 'text', text: 'Reading the files.' }, { type: 'tool_use' }])
  expect(f.reports.get(r.slug)).toMatchObject({ tools: 1, partial: 'Reading the files.' })
  // the fork's opening line restating its task is not its latest words
  await reportAppend(f.ctx, 'agent-1', 'response', [{ type: 'text', text: `Task: write the document "What happened in the wiki" to ${r.file}.` }, { type: 'tool_use' }])
  expect(f.reports.get(r.slug)).toMatchObject({ tools: 2, partial: 'Reading the files.' })
  await reportAppend(f.ctx, 'agent-1', 'response', [{ type: 'text', text: '**Task:** write the document.\n\nCounting the saves per day.' }])
  expect(f.reports.get(r.slug)).toMatchObject({ tools: 2, partial: 'Counting the saves per day.' })
})

test('the writer ends: its file checked, main told, the report shown', async () => {
  const f = fake()
  const r = await startReport(f.ctx, { form: 'document', title: 'Wiki', request: 'write it up' })
  await f.started
  f.files.set(`${CWD}/${r.file}`, DOC)
  await reportComplete(f.ctx, f.agents.get('agent-1')!, 'answer', 'Wrote the document, one section and one card.')
  expect(f.reports.get('wiki')).toMatchObject({ state: 'ready', title: 'One wiki holds the edits', problems: [] })
  expect(f.notes[0]).toBe('thimble-cc-mod: its writer finished the document "One wiki holds the edits", saved as .thimble-cc-mod/reports/wiki.md; the analyst reads it in the panel.')
  expect(f.opened.at(-1)).toBe('report')
})

test('a writer that wrote nothing, and a red citation: each said in the record', async () => {
  const f = fake()
  await startReport(f.ctx, { form: 'document', title: 'Doc', request: 'write it up' })
  await f.started
  await reportComplete(f.ctx, f.agents.get('agent-1')!, 'answer', 'I could not.')
  expect(f.reports.get('doc')).toMatchObject({ state: 'error', why: 'the writer ended without writing .thimble-cc-mod/reports/doc.md: I could not.' })
  await startReport(f.ctx, { form: 'document', title: 'Red', request: 'write it up' })
  await f.started
  f.files.set(`${CWD}/.thimble-cc-mod/reports/red.md`, `${DOC}\n\nAnd [[7|nowhere.md#L1]] more.`)
  await reportComplete(f.ctx, f.agents.get('agent-2')!, 'answer', '')
  expect(f.reports.get('red')?.problems).toEqual(['1 citation do not resolve or do not show their value'])
})

test('"open as report": the answer as a document, titled by the question, at once', async () => {
  const f = fake()
  await openAsReport(f.ctx, 'dse holds most revisions [[13403|card:abc123#revisions/dse]].', 'Which wiki is biggest?')
  expect(f.files.get(`${CWD}/.thimble-cc-mod/reports/which-wiki-is-biggest.md`)).toBe('# Which wiki is biggest?\n\ndse holds most revisions [[13403|card:abc123#revisions/dse]].\n')
  expect(f.reports.get('which-wiki-is-biggest')).toMatchObject({ form: 'document', state: 'ready' })
  expect(f.opened).toEqual(['report'])
  expect(f.spawned).toEqual([])
})

// ------------------------------------------------------------------------------------------------ the views, through the engine

type M = Mounted<'terminal'>
// what a drawing says, Markdown and the Clients' props included
const shows = async (ui: M, re: RegExp) => re.test(JSON.stringify(await ui.drawn()))
// the element holding the one keyed `key`: a footer's row of buttons
type Node = { key?: string; props?: { key?: string; children?: unknown }; children?: unknown }
function rowOf(tree: unknown, key: string): Node | undefined {
  const kids = (n: Node): Node[] => [n.children, n.props?.children].flatMap(x => (Array.isArray(x) ? x : x ? [x] : [])).filter(x => x && typeof x === 'object') as Node[]
  const walk = (n: Node): Node | undefined => (kids(n).some(c => c.key === key || c.props?.key === key) ? n : kids(n).map(walk).find(Boolean))
  return walk(tree as Node)
}
const PANE = { plugin: 'thimble-cc-mod', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 200, rows: 55 }, props: { bodyColumns: 96, scroll: { bodyRows: 46 } } } as const

function world(on: On, files: Record<string, string>): { files: Map<string, string>; opened: string[]; spawned: string[] } {
  const w = { files: new Map(Object.entries(files)), opened: [] as string[], spawned: [] as string[] }
  for (const c of Object.values(CARDS)) w.files.set(`${CWD}/.thimble-cc-mod/cards/${c.id}.json`, JSON.stringify(c))
  mock.env(on, {})
  on('env.set', () => ({ value: undefined }) as never)
  mock.clock(on, { now: 1_790_000_000_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.messages', () => ({ value: [] }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('tool.register', ($, e) => ({ value: { tool: `mcp__thimble-cc-mod__${e.name}` } }) as never)
  on('fs.read', ($, e) => {
    if (e.path.endsWith('/prompt/chat.md')) return { value: '# thimble-cc-mod\n' }
    if (e.path.includes('/prompt/reports/')) return { value: 'Write {{file}}. {{form_guide}}' }
    const text = w.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.stat', ($, e) => {
    if (!w.files.has(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: 1, mtimeMs: w.files.get(e.path)!.length, isLink: false } }
  })
  on('fs.exists', ($, e) => ({ value: w.files.has(e.path) }))
  on('fs.list', ($, e) => ({ value: [...w.files.keys()].filter(p => p.startsWith(`${e.path}/`)).map(p => ({ name: p.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })) }))
  on('fs.write', ($, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    const req = JSON.parse(e.init?.stdin ?? '{"items":[]}') as { items: { id: string; ref: string }[] }
    const out = req.items.map(it => ({ id: it.id, ref: it.ref, kind: 'file', status: 'ok', why: 'resolves', window: [] }))
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('agent.spawn', ($, e) => {
    w.spawned.push(e.description)
    return { model: 'm', agentId: 'agent-1' }
  })
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.focus', () => ({}) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('prompt.read', () => ({ value: { text: '' } }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: ['(the engine row)'] })
  })
  return w
}

const record = (slug: string, form: string, title: string): string => JSON.stringify({ slug, form, title, request: '', file: `.thimble-cc-mod/reports/${slug}.md`, state: 'ready', tools: 0, partial: '', problems: [], created: 1 })

async function openReport($: Parameters<TestBody>[0], slug: string): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.command.run({ command: 'thimble-reports', args: '' } as never)
  const list = (await $.ui.mount(PANE as never)) as unknown as M
  await list.press({ key: `report-open:${slug}` })
  await list.unmount()
}

test('the panel draws one drawing at a time: the next starts once the one before has settled, or once its limit fires', async () => {
  const t = turns()
  const order: string[] = []
  const never = () => ({ cancel: () => undefined })
  let finishA = () => {}
  const a = t.run(async () => {
    order.push('a starts')
    await new Promise<void>(r => (finishA = r))
    order.push('a settles')
    return 'A'
  }, never)
  const b = t.run(async () => {
    order.push('b starts')
    return 'B'
  }, never)
  await settle()
  expect(order).toEqual(['a starts'])
  finishA()
  expect([await a, await b]).toEqual(['A', 'B'])
  expect(order).toEqual(['a starts', 'a settles', 'b starts'])
  // a drawing that fails frees the turn; one that never settles holds the next only until its limit fires
  await expect(t.run(() => Promise.reject(new Error('no')), never)).rejects.toThrow('no')
  expect(await t.run(async () => 'C', never)).toBe('C')
  void t.run(() => new Promise<string>(() => undefined), never)
  let fire = () => {}
  let cancelled = 0
  const d = t.run(async () => 'D', f => ((fire = f), { cancel: () => void cancelled++ }))
  await settle()
  fire()
  expect(await d).toBe('D')
  expect(cancelled).toBe(1)
})

test('the reports list: each press opens its report, however often the list is opened again', async ($, on) => {
  world(on, {
    [`${CWD}/.thimble-cc-mod/reports/a.md`]: '# Report A\n\nText.',
    [`${CWD}/.thimble-cc-mod/reports/a.json`]: record('a', 'document', 'Report A'),
    [`${CWD}/.thimble-cc-mod/reports/b.md`]: '# Report B\n\nText.',
    [`${CWD}/.thimble-cc-mod/reports/b.json`]: record('b', 'document', 'Report B'),
  })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  for (const slug of ['a', 'b', 'a', 'b']) {
    await $.command.run({ command: 'thimble-reports', args: '' } as never)
    const list = (await $.ui.mount(PANE as never)) as unknown as M
    expect(await shows(list, /Reports/)).toBe(true)
    await list.press({ key: `report-open:${slug}` })
    expect(await shows(list, new RegExp(`Report ${slug.toUpperCase()}`))).toBe(true)
    expect(await list.find({ key: `report-open:${slug}` })).toBeUndefined()
    await list.unmount()
  }
})

test('a document in the panel: its title, contents that scroll to each heading, a toggle that opens, cards drawn', async ($, on) => {
  const doc = ['# dse holds the edits', '', 'Intro [[13403|card:abc123#revisions/dse]].', '', '## The data', '', 'Four wikis.', '', '## One wiki', '', '[[card:abc123]]', '', '<details><summary>How it was counted</summary>', '', 'By a script.', '', '</details>', '', '## What is open', '', 'Much.'].join('\n')
  world(on, { [`${CWD}/.thimble-cc-mod/reports/doc.md`]: doc, [`${CWD}/.thimble-cc-mod/reports/doc.json`]: record('doc', 'document', 'dse holds the edits') })
  await openReport($, 'doc')
  const pane = (await $.ui.mount(PANE as never)) as unknown as M
  expect(await shows(pane, /"dse holds the edits"/)).toBe(true)
  expect(await pane.find({ key: 'toc:0' })).toBeDefined()
  expect(await pane.find({ key: 'toc:2' })).toBeDefined()
  expect(JSON.stringify(await pane.drawn())).toContain('"module":"hooks/card.tsx"')
  expect(await shows(pane, /By a script/)).toBe(false)
  await pane.press({ key: 'toc:1' })
  await pane.press({ key: 'toggle:toggle-1' })
  expect(await shows(pane, /By a script/)).toBe(true)
  expect(await pane.find({ key: 'retell-slides' })).toBeDefined()
  expect(await pane.find({ key: 'retell-video' })).toBeUndefined()
  // a side thread about a paragraph of the report, and back to the report
  await pane.press({ key: 'ask-para:r0-1' })
  await pane.unmount()
  const thread = (await $.ui.mount(PANE as never)) as unknown as M
  expect(await shows(thread, /about the passage /)).toBe(true)
  await thread.press({ key: 'nav-back' })
  await thread.unmount()
  const again = (await $.ui.mount(PANE as never)) as unknown as M
  expect(await shows(again, /"dse holds the edits"/)).toBe(true)
  await again.unmount()
})

test('a slide\'s rows: text wrapped as the panel wraps it, buttons wrapped whole, a card cut to its first rows to fit', () => {
  expect(wrapRows('one two three', 20)).toBe(1)
  expect(wrapRows('one two three', 9)).toBe(2)
  expect(wrapRows('AgentSECCountyLinker99172', 10)).toBe(3)
  expect(textRows('- a [[13|card:abc123#revisions/dse]] b\n- c\n\nA paragraph.', 40)).toBe(4)
  expect(buttonRows(['‹ back', 'next ›', 'notes'], 80)).toBe(1)
  expect(buttonRows(['‹ back', 'next ›', 'notes'], 24)).toBe(2)
  // the fifteen pairs at 49 columns take far more rows than at 96; cut to fit 20 rows, with a line for the rest
  const tall = cardRows(PAIRS, 49)
  expect(tall).toBeGreaterThan(30)
  const fit = fitCard(PAIRS, 49, 20)
  expect(fit.more).toBeGreaterThan(0)
  expect(fit.unit).toBe('rows')
  expect(cardRows(fit.card, 49) + 1).toBeLessThanOrEqual(20)
  expect((fit.card.rows ?? []).length + fit.more).toBe(15)
  expect(fit.card.rows?.[0]).toEqual(PAIRS.rows?.[0])
  // a card that fits, or one that cannot be cut, stays whole; at least three rows are kept
  expect(fitCard(PAIRS, 96, 60)).toEqual({ card: PAIRS, more: 0, unit: '' })
  expect(fitCard(LINE, 49, 5).more).toBe(0)
  expect((fitCard(PAIRS, 49, 4).card.rows ?? []).length).toBe(3)
})

test('a slide taller than the panel shows its card\'s first rows and how many more, so the page row and its buttons stay in the panel', async ($, on) => {
  const deck = ['# Pairs', '', 'Few pairs share many pages.', '', '## The pairs that share the most pages share only 7 to 9 pages', '', '![pairs](card:tb0015)', '', '- The top pair shares [[9|card:tb0015#shared pages/AgentSECCountyLinker99172 + OpenAIResearchSec2028]] pages.', '- Most pairs share 7.', '', 'Notes. Counted per page.', '', '## Part two', '', '- more'].join('\n')
  const w = world(on, { [`${CWD}/.thimble-cc-mod/reports/deck.md`]: deck, [`${CWD}/.thimble-cc-mod/reports/deck.json`]: record('deck', 'slides', 'Pairs') })
  await openReport($, 'deck')
  // a terminal 120 columns wide: the panel is 49 columns by 44 rows
  const narrow = { ...PANE, viewport: { columns: 70, rows: 46 }, props: { ...PANE.props, bodyColumns: 49, scroll: { bodyRows: 44 } } }
  const pane = (await $.ui.mount(narrow as never)) as unknown as M
  await pane.press({ key: 'slide-next' })
  type CardEl = { props: { props: { card: CardData; cols: number } } }
  const shown = ((await pane.find({ type: 'Client', key: 'slide-card:1:0' })) as unknown as CardEl).props.props
  const kept = (shown.card.rows ?? []).length
  expect(kept).toBeLessThan(15)
  expect(kept).toBeGreaterThanOrEqual(3)
  expect(await shows(pane, new RegExp(`… ${15 - kept} more rows`))).toBe(true)
  // the slide as drawn: its heading, card, bullets and buttons within the panel's rows, under the report's head
  const head = 1 + 1 + 1 // the path, the title, the rule
  const slide = wrapRows('The pairs that share the most pages share only 7 to 9 pages', 48) + 1 + cardRows(shown.card, shown.cols) + 1 + 1 + textRows('- The top pair shares [[9|card:tb0015#x]] pages.\n- Most pairs share 7.', 44) + 2 + 1
  expect(head + slide + 1 + 2).toBeLessThanOrEqual(44)
  // its line opens the card whole in the citation panel
  await pane.press({ key: 'slide-more:1:0' })
  await pane.unmount()
  expect(w.opened.length).toBeGreaterThan(1)
  const cite = (await $.ui.mount(narrow as never)) as unknown as M
  expect(await shows(cite, /card \\"Which label pairs write/)).toBe(true)
  expect(await cite.find({ key: 'nav-back' })).toBeDefined()
  await cite.press({ key: 'nav-back' })
  await cite.unmount()
  // where the panel is tall enough, the card is whole
  const wide = (await $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { bodyRows: 70 } } } as never)) as unknown as M
  expect((((await wide.find({ type: 'Client', key: 'slide-card:1:0' })) as unknown as CardEl).props.props.card.rows ?? []).length).toBe(15)
  expect(await wide.find({ key: 'slide-more:1:0' })).toBeUndefined()
  await wide.unmount()
})

test('slides in the panel: one at a time, the page row and b/n turn them, notes on request', async ($, on) => {
  const deck = ['# Refunds', '', 'One charger.', '', '## Two thirds name one charger', '', '![x](card:abc123)', '', '- [[13403|card:abc123#revisions/dse]] of them.', '', 'Notes. Batch 17.', '', '## Part two', '', '- more'].join('\n')
  world(on, { [`${CWD}/.thimble-cc-mod/reports/deck.md`]: deck, [`${CWD}/.thimble-cc-mod/reports/deck.json`]: record('deck', 'slides', 'Refunds') })
  await openReport($, 'deck')
  const pane = (await $.ui.mount(PANE as never)) as unknown as M
  const keys = async () => ((await pane.find({ type: 'Client', key: 'slide-keys' })) as unknown as { props: { props: { label: string } } } | undefined)?.props.props.label
  expect(await keys()).toBe('1 / 3')
  await pane.press({ key: 'slide-next' })
  expect(await keys()).toBe('2 / 3')
  expect(await shows(pane, /Two thirds name one charger/)).toBe(true)
  expect(await pane.find({ type: 'Client', key: 'slide-card:1:0' })).toBeDefined()
  expect(await shows(pane, /Batch 17/)).toBe(false)
  expect(rowOf(await pane.drawn(), 'slide-next')?.props).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap' })
  await pane.press({ key: 'slide-notes' })
  expect(await shows(pane, /Batch 17/)).toBe(true)
  // → on the page row turns too
  await pane.key({ key: 'right', in: 'slide-keys' })
  expect(await keys()).toBe('3 / 3')
  await pane.press({ key: 'slide-prev' })
  expect(await keys()).toBe('2 / 3')
  await pane.unmount()
})

test('main\'s report tool starts a writer and tells main not to write it; a writer\'s own call is refused', async ($, on) => {
  const w = world(on, {})
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const r = (await $.tool.call({ tool: 'mcp__thimble-cc-mod__report', form: 'slides', title: 'What happened', request: 'make me a deck of what is going on in this dataset' } as never)) as { result?: unknown; deny?: string }
  expect(w.spawned[0]).toBe('report · writing What happened')
  expect(String(r.result ?? r.deny)).toMatch(/started its writer on the slides "What happened"|could not start its writer/)
  expect(JSON.parse(w.files.get(`${CWD}/.thimble-cc-mod/reports/what-happened.json`)!).form).toBe('slides')
  const pane = (await $.ui.mount(PANE as never)) as unknown as M
  expect(await shows(pane, /"What happened"/)).toBe(true)
  await pane.unmount()
  // main's chat shows the call as one dim line, and its result not at all
  const use = (await $.ui.mount({ plugin: 'thimble-cc-mod', component: 'ToolUse', requestId: 'tu1', surface: 'terminal', viewport: { columns: 140, rows: 55 }, props: { tool: 'mcp__thimble-cc-mod__report', input: { form: 'slides', title: 'What happened' }, isRunning: false, isErrored: false, isInterrupted: false } } as never)) as unknown as M
  expect(await shows(use, / {2}report · slides \\"What happened\\"/)).toBe(true)
  await use.unmount()
  const res = (await $.ui.mount({ plugin: 'thimble-cc-mod', component: 'ToolResult', requestId: 'tu1', surface: 'terminal', viewport: { columns: 140, rows: 55 }, props: { tool: 'mcp__thimble-cc-mod__report', output: 'started', isErrored: false } } as never)) as unknown as M
  expect(await shows(res, /started/)).toBe(false)
  await res.unmount()
})
