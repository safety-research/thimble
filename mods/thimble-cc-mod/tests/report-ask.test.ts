// What the analyst asks of a report: its type from the registry, a side thread on any passage told where it stands,
// "verify" on a section (subagents, each chip's state, the tallies), highlights (a subagent's passages drawn as marks
// with a legend, each opening its evidence), and the interactive story stepped through. `claude plugin test`.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Mounted, TestBody } from 'claude-code/testing'

import type { ChatAgent, ChatReport, ChatReportNav, ChatVerify } from '../types'
import { claimsIn } from '../hooks/cite'
import type { CardData } from '../hooks/draw'
import { askPieces, cid } from '../hooks/lib'
import { DEFAULT_TYPE, TYPES, docSegments, guessType, highlightLabel, parseMarks, parseVerdicts, passageKey, reportPassages, reportSections, sectionOfHeading, settleType, splitTitle, typeOf, verifyPrompt } from '../hooks/report'
import { TOOL_DESCRIPTION, TOOL_SCHEMA, parseReportArgs, reportAgentDone, startHighlight, verifySection } from '../hooks/reports'
import type { ReportCtx } from '../hooks/reports'
import { SERIES } from '../hooks/paint'
import { pinCalls, withoutTaskLine } from '../hooks/threads'

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

const DOC = [
  '# dse holds the edits',
  '',
  'dse holds [[13403|card:abc123#revisions/dse]] of the revisions.',
  '',
  '## The data',
  '',
  'Four wikis [[pages.jsonl#L1]].',
  '',
  '- probier has [[1013|card:abc123#revisions/probier]].',
  '- A plain item without a citation.',
  '- Another plain item.',
  '',
  '> [!NOTE] Counts start in June [[revisions.jsonl#L1]].',
  '',
  '## One wiki',
  '',
  '[[card:abc123]]',
  '',
  '<details><summary>How it was counted</summary>',
  '',
  'By a script [[card:abc123]].',
  '',
  '</details>',
  '',
  '## What is open',
  '',
  'Much.',
].join('\n')

const STORY = [
  '# One wiki holds the edits',
  '',
  'dse holds most revisions [[13403|card:abc123#revisions/dse]].',
  '',
  '## Almost every revision is on dse',
  '',
  '![Revisions per wiki](card:abc123 "dse")',
  '',
  '- dse has [[13403|card:abc123#revisions/dse]]',
  '',
  '## probier is second',
  '',
  '![Revisions per wiki](card:abc123 "probier")',
  '',
  '- probier has [[1013|card:abc123#revisions/probier]]',
  '',
  '## Limitations',
  '',
  'Card: none',
  '',
  'The data is one month.',
].join('\n')

const settle = async () => {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

// ------------------------------------------------------------------------------------------------ the registry

test('report types: one registry; a document unless the analyst names another; a story only on request', () => {
  expect(new Set(TYPES.map(t => t.id)).size).toBe(TYPES.length)
  expect(DEFAULT_TYPE).toBe('document')
  expect(typeOf('nonsense').id).toBe('document')
  expect(typeOf('story')).toMatchObject({ name: 'interactive story', renderer: 'story', onRequest: true })
  expect(typeOf('casefile').renderer).toBe('document')
  expect(guessType('write it up')).toBe('document')
  // there is no video: a request for one is a document
  expect(TYPES.some(t => t.id === 'video')).toBe(false)
  expect(guessType('make me a video explaining what is going on in this dataset')).toBe('document')
  expect(guessType('tell it as an interactive graphic piece')).toBe('story')
  expect(guessType('a deck for Monday')).toBe('slides')
  // main asked for a story the analyst did not name: a document
  expect(settleType('story', 'write up what happened')).toBe('document')
  expect(settleType('story', 'tell it as an interactive story')).toBe('story')
  expect(settleType('video', 'a short video of it')).toBe('document')
  expect(settleType('casefile', 'one section per agent')).toBe('casefile')
  expect(settleType(undefined, 'slides for the team')).toBe('slides')
  expect(parseReportArgs('case file one per agent')).toEqual({ form: 'casefile', request: 'one per agent' })
  expect(parseReportArgs('story what happened')).toEqual({ form: 'story', request: 'what happened' })
  expect(parseReportArgs('what happened in the wiki')).toEqual({ form: 'document', request: 'what happened in the wiki' })
  // main's tool is described from the registry, and the type may be left out
  for (const t of TYPES) expect(TOOL_DESCRIPTION).toContain(`${t.id}, ${t.blurb}`)
  expect(TOOL_DESCRIPTION).toContain('Write a document unless the analyst names another type; story only when they ask for one.')
  expect(TOOL_DESCRIPTION).not.toMatch(/video/)
  expect(TOOL_SCHEMA.required).toEqual(['request'])
})

// ------------------------------------------------------------------------------------------------ sections and passages

test('a document\'s sections: the opening, each ## with its toggles; their claims are the ones the panel draws', () => {
  const secs = reportSections(DOC, 'document', 'doc')
  expect(secs.map(s => s.heading)).toEqual(['', 'The data', 'One wiki', 'What is open'])
  const claims = (k: number) => secs[k]!.parts.flatMap(p => claimsIn(p.text, p.answer)).map(cl => cl.c.raw)
  expect(claims(1)).toEqual(['[[pages.jsonl#L1]]', '[[1013|card:abc123#revisions/probier]]', '[[revisions.jsonl#L1]]'])
  expect(claims(2)).toEqual(['[[card:abc123]]'])
  // the keys the panel's chips carry: each segment drawn with the report's answer
  const drawn = new Set(docSegments(splitTitle(DOC).body).flatMap(s => claimsIn(s.kind === 'md' ? s.text : s.body, 'report:doc')).map(cl => cl.key))
  const ours = new Set(secs.flatMap(s => s.parts.flatMap(p => claimsIn(p.text, p.answer))).map(cl => cl.key))
  expect([...ours].sort()).toEqual([...drawn].sort())
  expect(sectionOfHeading(secs, '## The data')?.key).toBe(secs[1]!.key)
  expect(sectionOfHeading(secs, '### 0:12 · One wiki')?.heading).toBe('One wiki')
  // a story's beats and a deck's slides are sections too
  expect(reportSections(STORY, 'story', 'st').map(s => s.heading)).toEqual(['One wiki holds the edits', 'Almost every revision is on dse', 'probier is second', 'Limitations'])
})

test('passages: each paragraph, list item, callout and figure, numbered; headings are not; keys match drawReply\'s words', () => {
  const ps = reportPassages(DOC, 'document', 'doc')
  expect(ps.map(p => p.id)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9'])
  expect(ps.map(p => p.section)).toEqual(['', 'The data', 'The data', 'The data', 'The data', 'The data', 'One wiki', 'One wiki', 'What is open'])
  expect(ps[2]!.text).toBe('- probier has [[1013|card:abc123#revisions/probier]].')
  expect(ps[3]!.text).toBe('- A plain item without a citation.')
  expect(ps[5]!.text).toContain('> note  ')
  expect(ps[6]).toMatchObject({ card: 'abc123', key: 'card:abc123' })
  expect(passageKey('- probier has [[1013|card:abc123#revisions/probier]].')).toBe('probier has 1013.')
  expect(passageKey('> **ⓘ Note.** Counts')).toBe('ⓘ note. counts')
  expect(askPieces('Intro:\n- a\n  more of a\n- b\n\nAfter.')).toEqual([
    { text: 'Intro:', join: false },
    { text: '- a\n  more of a', join: true },
    { text: '- b', join: true },
    { text: 'After.', join: false },
  ])
})

test('a highlighter\'s answer: the passages it names that exist, each once, with the place and why; the label', () => {
  const ps = reportPassages(DOC, 'document', 'doc')
  const marks = parseMarks(['I checked the records.', '{"p": "P3", "ref": "[[revisions.jsonl#L5]]", "why": "the probier rows"}', '{"p": "P3", "ref": "x", "why": "again"}', '{"p": "P99", "ref": "x", "why": "none"}', '```', '{"p": "6", "ref": "1013|card:abc123#revisions/probier", "why": "the count"}', '```'].join('\n'), ps)
  expect(marks).toEqual([
    { key: ps[2]!.key, text: '- probier has 1013.', ref: 'revisions.jsonl#L5', why: 'the probier rows' },
    { key: ps[5]!.key, text: expect.stringContaining('Counts start in June') as unknown as string, ref: 'card:abc123#revisions/probier', why: 'the count' },
  ])
  expect(parseMarks('none of them', ps)).toEqual([])
  expect(highlightLabel('Highlight where the agents coordinate.')).toBe('where the agents coordinate')
  expect(highlightLabel('show me the deletions')).toBe('the deletions')
})

test('a verifier\'s prompt: a value recomputed by a script, a citation without one judged; its verdicts read', () => {
  const p = verifyPrompt({ title: 'T', file: 'r.md', heading: 'The data', items: [
    { key: 'k1', raw: '[[1013|card:abc123#revisions/probier]]', display: '1013', sentence: 'probier has 1013.', script: '.thimble-cc-mod/verify/v-k1.py' },
    { key: 'k2', raw: '[[pages.jsonl#L1]]', display: null, sentence: 'Four wikis.', script: '.thimble-cc-mod/verify/v-k2.py' },
  ] })
  expect(p).toContain('verify the section "The data" of the report "T" (r.md)')
  expect(p).toContain('write a standalone script at .thimble-cc-mod/verify/v-k1.py that recomputes 1013')
  expect(p).toContain('2. [[pages.jsonl#L1]] in "Four wikis."\n   Its support: read the cited place')
  const v = parseVerdicts('done\n{"n": 1, "supported": true, "why": "1013 rows"}\n{"n": 2, "supported": false, "why": "line 1 is about one wiki"}\n{"n": 3, "why": "no verdict"}')
  expect([...v.entries()]).toEqual([[1, { supported: true, why: '1013 rows' }], [2, { supported: false, why: 'line 1 is about one wiki' }]])
})

// ------------------------------------------------------------------------------------------------ with a fake engine

type Fake = { ctx: ReportCtx; files: Map<string, string>; spawned: { prompt: string; desc: string }[]; notes: string[]; reports: Map<string, ChatReport>; agents: Map<string, ChatAgent>; verify: Map<string, ChatVerify>; ran: string[]; started: Promise<void>[]; nav: ChatReportNav | null }

function fake(): Fake {
  const f: Fake = { files: new Map(), spawned: [], notes: [], reports: new Map(), agents: new Map(), verify: new Map(), ran: [], started: [], nav: null } as unknown as Fake
  f.files.set(`${CWD}/.thimble-cc-mod/reports/doc.md`, DOC)
  f.reports.set('doc', { slug: 'doc', form: 'document', title: 'dse holds the edits', request: '', file: '.thimble-cc-mod/reports/doc.md', state: 'ready', tools: 0, partial: '', problems: [], created: 1 })
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
    run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
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
    loadCard: async () => BAR,
    openPane: async () => undefined,
    closePanel: async () => undefined,
    spawn: async (prompt, desc) => {
      f.spawned.push({ prompt, desc })
      return { agentId: `agent-${f.spawned.length}`, engine: 'fork' }
    },
    noteMain: async text => {
      f.notes.push(text)
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
    checkCites: async () => 0,
    afterTurn: async fn => {
      f.started.push(fn())
    },
    remember: () => undefined,
    verifyOf: async key => f.verify.get(key),
    setVerify: async (key, v) => {
      f.verify.set(key, v)
    },
    runVerify: async key => {
      f.ran.push(key)
      f.verify.set(key, { ...f.verify.get(key)!, state: 'verified', result: '1013' })
    },
    openRef: async () => undefined,
  }
  return f
}

test('"verify" on a section: a subagent given its citations; its end judges each, runs each value\'s script, says what is missing', async () => {
  const f = fake()
  expect(await verifySection(f.ctx, 'doc', 's1')).toBe(3)
  expect(f.spawned.map(s => s.desc)).toEqual(['verification · checking "The data"'])
  const keys = f.agents.get('agent-1')!.claims!
  expect(f.agents.get('agent-1')).toMatchObject({ kind: 'report-verify', report: 'doc' })
  expect(keys.map(k => f.verify.get(k)?.kind ?? 'value')).toEqual(['support', 'value', 'support'])
  expect(keys.map(k => f.verify.get(k)?.state)).toEqual(['asked', 'asked', 'asked'])
  const script = f.verify.get(keys[1]!)!.script
  expect(script).toBe(`.thimble-cc-mod/verify/v-${keys[1]}.py`)
  // a second press while they run sends nothing again
  expect(await verifySection(f.ctx, 'doc', 's1')).toBe(0)
  f.files.set(`${CWD}/${script}`, 'print("RESULT: 1013")')
  await reportAgentDone(f.ctx, f.agents.get('agent-1')!, 'answer', '{"n": 1, "supported": true, "why": "line 1 names the wikis"}\n{"n": 2, "supported": true, "why": "1013"}')
  await settle()
  expect(f.verify.get(keys[0]!)).toMatchObject({ state: 'verified', why: 'line 1 names the wikis' })
  expect(f.ran).toEqual([keys[1]])
  expect(f.verify.get(keys[2]!)).toMatchObject({ state: 'missing', stderr: 'the subagent gave no verdict on it' })
  // main is told, out of sight, of the citation judged from its place (the value's script tells it its own result)
  expect(f.notes).toEqual(['thimble-cc-mod: a verifier judged 1 citation of the report "dse holds the edits" from their places: 1 supported, 0 not; each shows ✓ or × in the panel.'])
  // "verify all": the opening and the section with the toggle; the failed one again, the verified ones not
  expect(await verifySection(f.ctx, 'doc')).toBe(3)
  expect(f.spawned.map(s => s.desc).slice(1)).toEqual(['verification · checking "dse holds the edits"', 'verification · checking "The data"', 'verification · checking "One wiki"'])
})

test('"highlight": a set at once in the legend, a subagent given the passages; its end marks them; main\'s tool waits for its turn', async () => {
  const f = fake()
  const h = await startHighlight(f.ctx, 'doc', 'highlight where the counts come from')
  expect(h).toMatchObject({ label: 'where the counts come from', state: 'working', color: SERIES[0] })
  expect(f.reports.get('doc')!.highlights).toHaveLength(1)
  expect(f.spawned[0]!.desc).toBe('report · highlighting where the counts come from')
  expect(f.spawned[0]!.prompt).toContain('P3 [The data]: - probier has [[1013|card:abc123#revisions/probier]].')
  expect(f.agents.get('agent-1')).toMatchObject({ kind: 'report-highlight', report: 'doc', highlight: h!.id })
  await reportAgentDone(f.ctx, f.agents.get('agent-1')!, 'answer', '{"p": "P3", "ref": "revisions.jsonl#L5", "why": "the probier rows"}')
  expect(f.reports.get('doc')!.highlights![0]).toMatchObject({ state: 'ready', marks: [{ ref: 'revisions.jsonl#L5', why: 'the probier rows', text: '- probier has 1013.' }] })
  expect(f.notes).toEqual(['thimble-cc-mod: the report "dse holds the edits" now highlights where the counts come from: 1 passage, marked in the panel.'])
  // a second set takes the next colour; from main's tool its subagent starts once main's turn is over
  const h2 = await startHighlight(f.ctx, 'doc', 'the callouts', true)
  expect(h2!.color).toBe(SERIES[1])
  expect(f.started).toHaveLength(1)
  await f.started[0]
  expect(f.spawned).toHaveLength(2)
  await reportAgentDone(f.ctx, f.agents.get('agent-2')!, 'stopped', '')
  expect(f.reports.get('doc')!.highlights![1]).toMatchObject({ state: 'error', why: 'the subagent ended: stopped' })
  expect(f.notes).toHaveLength(1) // a stopped highlighter tells main nothing
})

// ------------------------------------------------------------------------------------------------ in the panel

type M = Mounted<'terminal'>
const json = async (ui: M) => JSON.stringify(await ui.drawn())
const PANE = { plugin: 'thimble-cc-mod', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 200, rows: 55 }, props: { bodyColumns: 96, scroll: { bodyRows: 46 } } } as const

const clocks = new WeakMap<On, ReturnType<typeof mock.clock>>()
type World = { files: Map<string, string>; opened: string[]; spawned: { description: string; prompt: string }[]; messages: Map<string, unknown[]> }

function world(on: On, files: Record<string, string>): World {
  const w: World = { files: new Map(Object.entries(files)), opened: [], spawned: [], messages: new Map() }
  if (!clocks.has(on)) clocks.set(on, mock.clock(on, { now: 1_790_000_000_000 }))
  w.files.set(`${CWD}/.thimble-cc-mod/cards/abc123.json`, JSON.stringify(BAR))
  mock.env(on, {})
  on('env.set', () => ({ value: undefined }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  // a subagent's rows, as the engine keeps them
  on('session.messages', ($, e) => ({ value: w.messages.get((e as { agentId?: string }).agentId ?? '') ?? [] }) as never)
  on('session.append', () => ({}) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('tool.register', ($, e) => ({ value: { tool: `mcp__thimble-cc-mod__${e.name}` } }) as never)
  on('fs.read', ($, e) => {
    if (e.path.endsWith('/prompt/chat.md')) return { value: '# thimble-cc-mod\n' }
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
  // the resolver finds every place
  on('process.run', ($, e) => {
    const req = JSON.parse(e.init?.stdin ?? '{"items":[]}') as { items: { id: string; ref: string }[] }
    const out = req.items.map(it => ({ id: it.id, ref: it.ref, kind: 'file', status: 'ok', why: 'resolves', window: [{ n: 1, text: 'the cited line', hit: true }], file: it.ref.split('#')[0] }))
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('agent.spawn', ($, e) => {
    w.spawned.push({ description: e.description, prompt: e.prompt })
    return { model: 'm', agentId: `agent-${w.spawned.length}` }
  })
  on('agent.list', () => ({ value: [] }) as never)
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.focus', () => ({}) as never)
  on('ui.scroll', () => ({}) as never)
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

const record = (slug: string, form: string, title: string, more: Partial<ChatReport> = {}): string => JSON.stringify({ slug, form, title, request: '', file: `.thimble-cc-mod/reports/${slug}.md`, state: 'ready', tools: 0, partial: '', problems: [], created: 1, ...more })

/** A click on a link drawn by a lines Client (hooks/homeview.tsx), as the Client posts it. */
let linkSeq = 0
async function linkClick(pane: M, key: string, i = 0): Promise<void> {
  const c = (await pane.find({ type: 'Client', key })) as unknown as { props: { props: { stamp: string } } }
  await pane.post({ type: 'home', horigin: 'test-link', hacts: [{ seq: ++linkSeq, i, s: c.props.props.stamp }] } as never, { in: key })
}

async function openReport($: Parameters<TestBody>[0], slug: string): Promise<M> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.command.run({ command: 'thimble-reports', args: '' } as never)
  const list = (await $.ui.mount(PANE as never)) as unknown as M
  await list.press({ key: `report-open:${slug}` })
  await list.unmount()
  return (await $.ui.mount(PANE as never)) as unknown as M
}

test('a document: "verify" beside a heading asks for a verifier of its citations; each chip and the tallies show the outcome', async ($, on) => {
  const w = world(on, { [`${CWD}/.thimble-cc-mod/reports/doc.md`]: DOC, [`${CWD}/.thimble-cc-mod/reports/doc.json`]: record('doc', 'document', 'dse holds the edits') })
  const pane = await openReport($, 'doc')
  // the report has no row of counts under its title: its title, then the rule
  expect(await json(pane)).not.toContain('5 citations')
  // a callout: its kind as a dim label, its text after it, drawn as a paragraph rather than a quote
  expect(await pane.find({ type: 'Text', text: 'note' })).toBeDefined()
  const note = (await pane.findAll({ type: 'Client' })).map(c => (c as unknown as { props: { props?: { block?: { quote: boolean; runs: { text: string }[] } } } }).props.props?.block).find(b => b?.runs[0]?.text.startsWith('Counts start'))
  expect(note?.quote).toBe(false)
  expect(note?.runs[0]?.text).toBe('Counts start in June ')
  expect(await pane.find({ key: 'verify:s1' })).toBeDefined()
  // a section without citations has nothing to verify
  expect(await pane.find({ key: 'verify:s3' })).toBeUndefined()
  await pane.press({ key: 'verify:s1' })
  await settle()
  // the kit starts no subagent (a hook's spawn gets no id), so the mod tries a fork, then a general-purpose one
  expect(w.spawned[0]!.description).toBe('verification · checking "The data"')
  expect(w.spawned[0]!.prompt).toContain('2. [[1013|card:abc123#revisions/probier]] in "probier has [[1013|card:abc123#revisions/probier]]."')
  expect(w.spawned[0]!.prompt).toMatch(/write a standalone script at \.thimble-cc-mod\/verify\/v-\w+\.py that recomputes 1013/)
  const drawn = await json(pane)
  // the three citations failed to start: red × on each chip, "3 failed" beside the heading and in the contents and the head
  expect(drawn).toContain('3 failed')
  expect((drawn.match(/"mark":"×"/g) ?? []).length).toBe(3)
  expect(await pane.find({ key: 'verify:s1' })).toBeDefined()
  expect(await pane.find({ key: 'verify-all' })).toBeDefined()
  await pane.unmount()
})

test('a document: a highlight set\'s marks beside their passages with their reasons, a legend, and each mark opens its evidence', async ($, on) => {
  const marks = [{ key: passageKey('- probier has [[1013|card:abc123#revisions/probier]].'), text: 'probier has 1013.', ref: 'revisions.jsonl#L5', why: 'the probier rows' }, { key: 'card:abc123', text: '(the figure)', ref: 'card:abc123#revisions/dse', why: 'the bar of dse' }]
  const highlights = [{ id: 'h1', request: 'highlight the counts', label: 'the counts', color: '#1d7fc0', state: 'ready', marks }, { id: 'h2', request: 'the deletions', label: 'the deletions', color: '#b77300', state: 'working', marks: [] }]
  const w = world(on, { [`${CWD}/.thimble-cc-mod/reports/doc.md`]: DOC, [`${CWD}/.thimble-cc-mod/reports/doc.json`]: record('doc', 'document', 'dse holds the edits', { highlights } as never) })
  const pane = await openReport($, 'doc')
  const drawn = await json(pane)
  // the legend: each set's ● in its hue, its name, its count dim
  expect(drawn).toContain('"label":"the counts"')
  // a set still working when its session ended says so
  expect(drawn).toContain('the deletions · the session ended before it finished')
  expect(await pane.find({ type: 'Client', key: 'mark:h1:0' })).toBeDefined()
  expect(await pane.find({ type: 'Client', key: 'mark:h1:1' })).toBeDefined()
  expect(drawn).toContain('the probier rows')
  // a marked passage: a ● in the set's hue at the left of its first row
  expect(drawn).toContain('"color":"#1d7fc0"')
  await pane.press({ key: 'hl-go:h1' })
  // a mark's `↗` is a link: a click on it opens the evidence
  await linkClick(pane, 'mark:h1:0')
  await pane.unmount()
  const cite = (await $.ui.mount(PANE as never)) as unknown as M
  expect(await json(cite)).toContain('revisions.jsonl line 5')
  await cite.unmount()
  expect(w.opened.length).toBeGreaterThan(2)
})

test('the report has no highlight field: main\'s tool asks a subagent for marks; a side thread on a list item is told the report and its section', async ($, on) => {
  const w = world(on, { [`${CWD}/.thimble-cc-mod/reports/doc.md`]: DOC, [`${CWD}/.thimble-cc-mod/reports/doc.json`]: record('doc', 'document', 'dse holds the edits') })
  const pane = await openReport($, 'doc')
  expect(await pane.find({ key: 'highlight' })).toBeUndefined()
  await $.tool.call({ tool: 'mcp__thimble-cc-mod__report_highlight', request: 'where the counts come from' } as never)
  await settle()
  expect(w.spawned[0]!.description).toBe('report · highlighting where the counts come from')
  expect(w.spawned[0]!.prompt).toContain('P4 [The data]: - A plain item without a citation.')
  expect(await json(pane)).toContain('where the counts come from · could not start a subagent')
  // the plain list item's own "?"
  await pane.press({ key: 'ask-md:r0-5-0' })
  await pane.unmount()
  const thread = (await $.ui.mount(PANE as never)) as unknown as M
  await thread.input({ key: (await thread.find({ type: 'Input' }))?.key ?? '', text: 'what does this rest on?' })
  await thread.unmount()
  // the fork first (the kit starts none, so the general-purpose fallback after it, named so)
  const asked = w.spawned.at(-2)!
  expect(asked.description).toBe('side thread · what does this rest on?')
  expect(w.spawned.at(-1)!.description).toBe('side thread · what does this rest on? · general-purpose, fork refused')
  expect(asked.prompt).toContain('A plain item without a citation.')
  expect(asked.prompt).not.toContain('Another plain item.')
  expect(asked.prompt).toContain('In the report "dse holds the edits", section "The data" (.thimble-cc-mod/reports/doc.md); read the report for what surrounds it.')
  // it begins with the answer (a fork's guideline is to restate its task first), and it may cite its own Bash outputs
  expect(asked.prompt).toContain('Begin with the answer itself, not a line restating the task')
  expect(asked.prompt).toContain('[[value|call:none#L<n>]] when it gives none')
})

test('no field or list in a report\'s panels says how to use it', async ($, on) => {
  world(on, { [`${CWD}/.thimble-cc-mod/reports/doc.md`]: DOC, [`${CWD}/.thimble-cc-mod/reports/doc.json`]: record('doc', 'document', 'dse holds the edits') })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.command.run({ command: 'thimble-reports', args: '' } as never)
  const list = (await $.ui.mount(PANE as never)) as unknown as M
  expect(await json(list)).not.toMatch(/a press/)
  await list.press({ key: 'report-open:doc' })
  await list.unmount()
  const pane = (await $.ui.mount(PANE as never)) as unknown as M
  // the report has no field; a field's label is a dim word before it, lower case and with no colon (views/SPEC.md,
  // rule 27), not the Input's own label or placeholder
  expect(await pane.find({ type: 'Input' })).toBeUndefined()
  await pane.press({ key: 'ask-md:r0-5-0' })
  await pane.unmount()
  const thread = (await $.ui.mount(PANE as never)) as unknown as M
  const ask = (await thread.find({ type: 'Input' })) as { props: Record<string, unknown> } | undefined
  expect(ask).toBeDefined()
  expect(ask?.props.label).toBeUndefined()
  expect(ask?.props.placeholder).toBeUndefined()
  expect(await thread.find({ type: 'Text', text: /^ask {2}$/ })).toBeDefined()
  expect(await json(thread)).not.toMatch(/\(Enter/)
  await thread.unmount()
})

// ------------------------------------------------------------------------------------------------ a thread's answer

// A side thread's fork given no call id after a Bash output cites it as call:none; and a fork's guideline is to open
// with a line restating its task.
const OUT = 'revisions 14591\ndistinct ip16, all revisions 191\ndistinct ip16, named-label revisions 191\ndistinct ip16, no-label revisions 114\nmissing ip16 0'
const TOLD = 'Task: count the distinct `ip16` ranges in the revisions.\n\nThere are [[191|call:none#L2]] distinct ranges across all [[14591|call:none#L1]] revisions. Revisions saved with no label use [[114|call:none#L4]] of them.'

test('a thread\'s answer: the line restating its task is dropped; a call:none citation points at the output that holds it', () => {
  expect(withoutTaskLine(TOLD)).toMatch(/^There are \[\[191/)
  expect(withoutTaskLine('**Scope:** the ranges.\nThere are 191.')).toBe('There are 191.')
  expect(withoutTaskLine('There are 191 ranges.\nTask: none.')).toBe('There are 191 ranges.\nTask: none.')
  const calls = [{ id: 'old1', output: 'nothing here\n191 is on line two' }, { id: 'c1', output: OUT }]
  const none = () => false
  // the latest output whose cited lines hold the value
  expect(pinCalls(TOLD, calls, none)).toContain('[[191|call:c1#L2]] distinct ranges across all [[14591|call:c1#L1]] revisions')
  expect(pinCalls(TOLD, calls, none)).toContain('[[114|call:c1#L4]]')
  // a miscounted line: the one line of an output that holds it; a value on two lines of it, or on none, stays as written
  expect(pinCalls('[[114|call:none#L9]]', calls, none)).toBe('[[114|call:c1#L4]]')
  expect(pinCalls('[[191|call:none#L9]]', calls, none)).toBe('[[191|call:none#L9]]')
  expect(pinCalls('[[777|call:none#L2]]', calls, none)).toBe('[[777|call:none#L2]]')
  // a saved output's citation is left alone, and so is any other place
  expect(pinCalls('[[191|call:abc#L3]] [[13403|card:abc123#revisions/dse]]', calls, id => id === 'abc')).toBe('[[191|call:abc#L3]] [[13403|card:abc123#revisions/dse]]')
  expect(pinCalls(TOLD, [], none)).toBe(TOLD)
})

test('a side thread answers: its answer is saved without the task line, each call:none citation on its saved output', async ($, on) => {
  const w = world(on, {})
  w.messages.set('agent-1', [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'toolu_ip16', tool: 'Bash', input: { command: 'python3 count.py' }, text: OUT }] }])
  // the kit starts no subagent, so the thread and its running subagent are read as askThread leaves them
  const thread = { id: 't1', label: 'the passage "A revision is one saved version"', ref: '', context: '', agentId: 'agent-1', engine: 'fork', file: '.thimble-cc-mod/threads/t1.md', turns: [{ q: 'How many distinct ip16 ranges are there?', a: '', state: 'running', tools: 1, partial: '' }] }
  const seeded: Record<string, unknown> = { 'threads/t1': thread, 'agents/agent-1': { kind: 'thread', label: 'side thread · How many', thread: 't1' } }
  on('state.get', ($, e, next) => {
    const k = `${(e as { key: string }).key}/${(e as { id?: string }).id ?? ''}`
    return k in seeded ? ({ value: { value: seeded[k], version: 1 } } as never) : next(e)
  })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.turn.complete({ turnId: 's1', agentId: 'agent-1', answer: TOLD, durationMs: 5, reason: 'answer' } as never)
  await settle()
  const id = cid('toolu_ip16')
  // the output saved where a citation of it resolves, as main's are
  expect(JSON.parse(w.files.get(`${CWD}/.thimble-cc-mod/calls/${id}.json`) ?? '{}')).toMatchObject({ id, command: 'python3 count.py', output: OUT })
  const t = JSON.parse(w.files.get(`${CWD}/.thimble-cc-mod/threads/t1.json`) ?? '{}') as { turns: { a: string; state: string }[] }
  expect(t.turns[0]).toMatchObject({ state: 'done', a: `There are [[191|call:${id}#L2]] distinct ranges across all [[14591|call:${id}#L1]] revisions. Revisions saved with no label use [[114|call:${id}#L4]] of them.` })
})

test('an interactive story: the opening lists the beats; each beat steps in beside its figure, which stays and moves its step; or one page', async ($, on) => {
  world(on, { [`${CWD}/.thimble-cc-mod/reports/st.md`]: STORY, [`${CWD}/.thimble-cc-mod/reports/st.json`]: record('st', 'story', 'One wiki holds the edits') })
  const pane = await openReport($, 'st')
  const label = async () => ((await pane.find({ type: 'Client', key: 'story-keys' })) as unknown as { props: { props: { label: string } } } | undefined)?.props.props.label
  expect(await label()).toBe('opening')
  expect(await json(pane)).toContain('"Beats"')
  await pane.press({ key: 'story-beat:1' })
  expect(await label()).toBe('beat 2 / 3')
  expect(await json(pane)).toContain('the same figure, now at probier')
  await pane.press({ key: 'story-prev' })
  expect(await label()).toBe('beat 1 / 3')
  expect(await json(pane)).toContain('Almost every revision is on dse')
  expect(await json(pane)).not.toContain('probier is second')
  await pane.key({ key: 'right', in: 'story-keys' })
  expect(await label()).toBe('beat 2 / 3')
  await pane.press({ key: 'story-page' })
  const page = await json(pane)
  expect(page).toContain('Almost every revision is on dse')
  expect(page).toContain('probier is second')
  expect(page).toContain('Limitations')
  expect(await pane.find({ key: 'retell-story' })).toBeUndefined()
  expect(await pane.find({ key: 'retell-slides' })).toBeDefined()
  expect(await pane.find({ key: 'retell-video' })).toBeUndefined()
  await pane.unmount()
})
