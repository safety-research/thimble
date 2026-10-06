// The harness (hooks/harness.tsx): the coverage count fed from every agent's tool results, the check when main or an
// orientation stops, the orientation's start and its section of what it read, and the label tool's runs, with a fake
// engine context. `claude plugin test mods/thimble-cc-mod`.
import { expect, test } from 'claude-code/testing'

import type { ChatAgent, ChatCoverage, ChatLabel, ChatReport, ChatReportNav } from '../types'
import { checkNote, coverageAfterTurn, coverageAppend, coverageCommand, coverageLine, critiqueOf, fillPrompt, globOf, jsonObjects, labelCommand, orientTool, orientToolLine, judgedProblem, judgedStatus, kindOf, labelAnswer, labelPrompt, labelTool, labelToolLine, labelVerdict, orientCommand, orientEnded, parseLabels, rangeWords, runLabel, share, specOf } from '../hooks/harness'
import type { CoverageSummary, HarnessCtx } from '../hooks/harness'

const CWD = '/corpus/wiki'

function summary(over: Partial<CoverageSummary> = {}): CoverageSummary {
  return {
    line: 'read 1 of 3 files · 0.2% of records · 1 only counted by code · 1 never opened',
    totals: { files: 3, read: 1, scanned: 1, untouched: 1, records: 5000, records_seen: 10, bytes: 1e6, bytes_seen: 2000 },
    kinds: [
      { kind: 'events.jsonl', files: 1, read: 1, scanned: 0, untouched: 0, records: 3000, records_seen: 10 },
      { kind: 'labels.jsonl', files: 1, read: 0, scanned: 1, untouched: 0, records: 1500, records_seen: 0 },
      { kind: 'pages.jsonl', files: 1, read: 0, scanned: 0, untouched: 1, records: 500, records_seen: 0 },
    ],
    files: [
      { file: 'events.jsonl', size: 600000, records: 3000, seen: 10, state: 'read', ranges: [[1, 5], [1500, 1504]], agents: ['main'] },
      { file: 'labels.jsonl', size: 300000, records: 1500, seen: 0, state: 'scanned', ranges: [], agents: ['main'] },
      { file: 'pages.jsonl', size: 100000, records: 500, seen: 0, state: 'untouched', ranges: [], agents: [] },
    ],
    ...over,
  }
}

type Fake = {
  ctx: HarnessCtx
  files: Map<string, string>
  runs: { argv: string[]; stdin?: string; boxed?: true }[]
  coverage: ChatCoverage | null
  labels: Map<string, ChatLabel>
  reports: Map<string, ChatReport>
  agents: Map<string, ChatAgent>
  spawned: { prompt: string; desc: string }[]
  notes: string[]
  logs: string[]
  parents: Record<string, string>
  opened: string[]
  asked: string[]
  changed: string[]
  started?: Promise<void>
  answer: (argv: string[], stdin?: string) => { exitCode: number; stdout: string; stderr: string }
  model: (prompt: string) => string
  nav: ChatReportNav | null
  submitted: string[]
  labelOpened: string[]
}

function fake(): Fake {
  const f = { files: new Map(), runs: [], coverage: null, labels: new Map(), reports: new Map(), agents: new Map(), spawned: [], notes: [], logs: [], parents: {}, opened: [], asked: [], changed: [], nav: null, submitted: [], labelOpened: [] } as unknown as Fake
  f.answer = argv => {
    if (String(argv[1]).endsWith('coverage.py') && argv[2] === 'summary') return { exitCode: 0, stdout: JSON.stringify(summary()), stderr: '' }
    if (String(argv[1]).endsWith('coverage.py') && argv[2] === 'record') return { exitCode: 0, stdout: JSON.stringify({ written: 1, line: 'read 1 of 3 files · 0.2% of records', totals: summary().totals }), stderr: '' }
    return { exitCode: 1, stdout: '', stderr: 'no answer' }
  }
  f.files.set('/mod/prompt/orient.md', 'Orient. Request: {{brief}}\nCorpus:\n{{listing}}\nWrite {{file}}; scripts {{slug}}-*.py; coverage: python3 {{helper}}/coverage.py')
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
    mtime: async () => 0,
    list: async dir => [...f.files.keys()].filter(p => p.startsWith(`${dir}/`)).map(p => p.slice(dir.length + 1)),
    run: async (argv, init) => {
      f.runs.push({ argv, ...(init?.stdin ? { stdin: String(init.stdin) } : {}) })
      return f.answer(argv, init?.stdin ? String(init.stdin) : undefined)
    },
    boxed: async (argv, init) => {
      f.runs.push({ argv, boxed: true, ...(init?.stdin ? { stdin: String(init.stdin) } : {}) })
      return f.answer(argv, init?.stdin ? String(init.stdin) : undefined)
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
    loadCard: async () => null,
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
    checkCites: async () => 0,
    afterTurn: fn => (f.started = fn()),
    remember: () => undefined,
    verifyOf: async () => undefined,
    setVerify: async () => undefined,
    runVerify: async () => undefined,
    openRef: async () => undefined,
    session: async () => 'sess-1',
    sleep: async () => undefined,
    complete: async req => {
      f.asked.push(req.prompt)
      return { isAnswered: true, text: f.model(req.prompt), usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
    },
    labelModel: async () => 'claude-opus-5-5',
    coverage: async () => f.coverage,
    setCoverage: async c => {
      f.coverage = c
    },
    label: async slug => f.labels.get(slug),
    setLabel: async l => {
      f.labels.set(l.slug, l)
    },
    labelOpen: async () => '',
    setLabelOpen: async () => undefined,
    submit: async t => {
      f.submitted.push(t)
    },
    labelOpened: async () => f.labelOpened,
    setLabelOpened: async open => {
      f.labelOpened = open
    },
    openHarness: async view => {
      f.opened.push(view)
    },
    openCard: async id => {
      f.opened.push(`card:${id}`)
    },
    cardsChanged: async ids => {
      f.changed.push(...ids)
    },
    thread: async () => undefined,
    toast: () => undefined,
    log: t => {
      f.logs.push(t)
    },
    children: async ids => {
      const out = new Set(ids)
      for (let grew = true; grew; ) {
        grew = false
        for (const [id, parent] of Object.entries(f.parents)) if (out.has(parent) && !out.has(id)) grew = Boolean(out.add(id))
      }
      return [...out]
    },
  }
  return f
}

const settle = async () => {
  for (let i = 0; i < 400; i++) await Promise.resolve()
}

test('coverage: each tracked tool result of main and of a subagent goes to the count, paired with its call; the line is kept', async () => {
  const f = fake()
  coverageAppend(f.ctx, undefined, 'response', [{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'head -5 events.jsonl' } }, { type: 'tool_use', id: 'tu2', name: 'Glob', input: { pattern: '*' } }])
  coverageAppend(f.ctx, 'agent-7', 'response', [{ type: 'tool_use', id: 'tu3', name: 'Read', input: { file_path: `${CWD}/pages.jsonl` } }])
  coverageAppend(f.ctx, undefined, 'tool-result', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'line 1' }, { type: 'tool_result', tool_use_id: 'tu2', content: 'events.jsonl' }])
  coverageAppend(f.ctx, 'agent-7', 'tool-result', [{ type: 'tool_result', tool_use_id: 'tu3', content: [{ type: 'text', text: '     1→{}' }] }])
  await settle()
  const sent = f.runs.filter(r => r.argv[2] === 'record').flatMap(r => (JSON.parse(r.stdin ?? '{}') as { events: { agent: string; tool: string; session: string }[] }).events)
  expect(sent.map(e => [e.agent, e.tool, e.session])).toEqual([['main', 'Bash', 'sess-1'], ['agent-7', 'Read', 'sess-1']])
  expect(f.coverage).toMatchObject({ line: 'read 1 of 3 files · 0.2% of records', files: 3, untouched: 1, recordsSeen: 10 })
})

test('the coverage check: an answer that speaks for the whole corpus while a kind of file was never opened; one text for the analyst and main', async () => {
  const general = `## Most edits are link fixes\n\nAll nine agents edit pages [[12|card:abc#n/x]]. ${'More words. '.repeat(40)}`
  const why = critiqueOf(summary(), general)
  expect(why).toBe(
    'Coverage check: this session has read 1 of 3 files · 0.2% of records · 1 only counted by code · 1 never opened. No call opened this kind of file: pages.jsonl (500 records). Code counted over this kind of file, but no call showed any of its records: labels.jsonl (1,500 records). The answer speaks for the corpus as a whole but rests only on the files read.',
  )
  expect(critiqueOf(summary(), 'There are 3 files.')).toBeNull()
  // every kind has records read: no check
  const read = summary({ kinds: summary().kinds.map(k => ({ ...k, untouched: 0, scanned: 0, read: k.files, records_seen: 5 })) })
  expect(critiqueOf(read, general)).toBeNull()
  expect(kindOf('runs/12/a1b2c3d4e5/events.jsonl')).toBe('runs/#/*/events.jsonl')
  // after main's turn: the check each time an answer calls for it (main takes no turn of its own to answer it); off by
  // the command
  const f = fake()
  expect(await coverageAfterTurn(f.ctx, general)).toBe(why)
  expect(await coverageAfterTurn(f.ctx, general)).toBe(why)
  expect(await coverageAfterTurn(f.ctx, 'short')).toBeNull()
  expect((await coverageCommand(f.ctx, 'check off')).text).toBe('the coverage check after an answer is off')
  expect(await coverageAfterTurn(f.ctx, general)).toBeNull()
  await coverageCommand(f.ctx, 'check on')
  // main reads the analyst's words, and where to look
  expect(checkNote(why!, '/mod/helper')).toBe(`thimble-cc-mod: the analyst read this coverage check under your last answer: "${why}" \`python3 /mod/helper/coverage.py\` lists what was read of each file.`)
})

test("the coverage line, as thimble's orientation words it: files viewed by glob, the share of files and of lines", () => {
  expect(share(0, 10)).toBe('0%')
  expect(share(1, 1000)).toBe('<1%')
  expect(share(999, 1000)).toBe('99%')
  expect(share(10, 10)).toBe('100%')
  expect(globOf('runs/run-12/log.jsonl')).toBe('runs/run-*/*.jsonl')
  expect(globOf('runs/run-12/log.jsonl', true)).toBe('runs/**')
  expect(globOf('notes.md')).toBe('*.md')
  expect(globOf('Makefile')).toBe('*')
  // only events.jsonl had lines shown; labels.jsonl was only counted over, which views nothing
  expect(coverageLine(summary())).toBe('Coverage: viewed only events.jsonl · 33% of files · <1% of lines')
  const file = (f: string, records: number, seen: number) => ({ file: f, size: 100, records, seen, state: (seen ? 'read' : 'untouched') as 'read' | 'untouched', ranges: [], agents: [] })
  const runs = summary({ files: [file('runs/1/log.jsonl', 100, 50), file('runs/2/log.jsonl', 100, 10), file('runs/3/log.jsonl', 100, 5), file('runs/4/log.jsonl', 100, 0), file('board.jsonl', 300, 30), file('notes.md', 10, 0)] })
  expect(coverageLine(runs)).toBe('Coverage: viewed only board.jsonl, runs/*/*.jsonl (3 of 4 files) · 67% of files · 13% of lines')
  const two = summary({ files: [file('runs/1/log.jsonl', 100, 50), file('runs/2/log.jsonl', 100, 0), file('runs/3/log.jsonl', 100, 0)] })
  expect(coverageLine(two)).toBe('Coverage: viewed only runs/1/log.jsonl · 33% of files · 17% of lines')
  expect(coverageLine(summary({ files: [file('a.jsonl', 10, 10), file('b.jsonl', 10, 1)] }))).toBe('Coverage: viewed every file · 100% of files · 55% of lines')
  expect(coverageLine(summary({ files: [file('a.jsonl', 10, 0)] }))).toBe('Coverage: viewed no file · 0% of files · 0% of lines')
})

test('the orientation: a report writer with the corpus listed; it hears nothing of the count while it works; its end, the coverage line of its own reads', async () => {
  const f = fake()
  const said = await orientCommand(f.ctx, 'who edits the most report=off')
  await f.started
  expect(said.text).toBe('orienting · brief "who edits the most" · deck on · views on · critique off · report off')
  expect(f.reports.get('orientation')).toMatchObject({ form: 'document', title: 'Orientation: who edits the most', state: 'writing', agentId: 'agent-1', orientBy: ['agent-1'] })
  expect(f.opened).toEqual(['report'])
  expect(f.spawned[0]!.desc).toBe('report · orientation · who edits the most')
  expect(f.spawned[0]!.prompt).toContain('Request: who edits the most')
  expect(f.spawned[0]!.prompt).toContain('- pages.jsonl: 500 records (lines), 100,000 bytes')
  expect(f.spawned[0]!.prompt).toContain('# thimble-cc-mod guidance')
  expect(f.agents.get('agent-1')).toMatchObject({ kind: 'report', report: 'orientation' })
  // it ends with files unopened: no second round; the coverage line of its reads and its subagents' ends the document,
  // shows in main's chat, and goes to main with the next prompt
  f.parents = { 'agent-5': 'agent-1', 'agent-6': 'agent-5', 'agent-7': 'main' }
  f.files.set(`${CWD}/.thimble-cc-mod/reports/orientation.md`, '# The wiki has nine editors\n\nText.\n')
  expect(await orientEnded(f.ctx, 'agent-9', 'answer')).toBe(false)
  expect(await orientEnded(f.ctx, 'agent-1', 'answer')).toBe(false)
  expect(f.spawned.length).toBe(1)
  const summed = f.runs.filter(r => r.argv[2] === 'summary').at(-1)!.argv
  expect(summed.filter((_, i) => summed[i - 1] === '--agent')).toEqual(['agent-1', 'agent-5', 'agent-6'])
  const line = 'Coverage: viewed only events.jsonl · 33% of files · <1% of lines'
  expect(f.files.get(`${CWD}/.thimble-cc-mod/reports/orientation.md`)).toBe(`# The wiki has nine editors\n\nText.\n\n${line}\n`)
  expect(f.logs).toEqual([`the orientation ended · ${line}`])
  expect(f.notes.at(-1)).toBe(`thimble-cc-mod: the orientation ended; the analyst read this line in the chat and at the end of its document .thimble-cc-mod/reports/orientation.md: "${line}"`)
  expect(rangeWords([[1, 5], [88, 88], [1203, 1250]])).toBe('1-5, 88, 1203-1250')
})

test('the orientation\'s switches: its prompt\'s parts, the critique round, then the report\'s writer; one at a time; main\'s tool takes the same', async () => {
  const f = fake()
  // every file read
  const full = summary({ line: 'read 3 of 3 files', totals: { ...summary().totals, read: 3, scanned: 0, untouched: 0 }, kinds: summary().kinds.map(k => ({ ...k, read: k.files, untouched: 0, scanned: 0, records_seen: 5 })), files: summary().files.map(x => ({ ...x, state: 'read' as const, seen: 5, ranges: [[1, 5]] })) })
  f.answer = argv => (String(argv[1]).endsWith('coverage.py') && argv[2] === 'summary' ? { exitCode: 0, stdout: JSON.stringify(full), stderr: '' } : { exitCode: 1, stdout: '', stderr: 'no answer' })
  f.files.set('/mod/prompt/orient.md', 'Orient {{brief}}.{{#deck}} DECK of {{slug}}{{/deck}}{{^deck}} NO CARDS{{/deck}}{{#views}} VIEWS{{/views}}{{#critique}} CRITIQUE{{/critique}}{{#report}} REPORT{{#deck}} citing cards{{/deck}}{{/report}}')
  f.files.set('/mod/prompt/orient-critique.md', 'Review {{file}}{{#deck}} and its cards{{/deck}}{{^deck}}, no cards{{/deck}}.')
  const said = await orientCommand(f.ctx, 'brief="the moderators" --no-deck views=off --critique')
  await f.started
  expect(said.text).toBe('orienting · brief "the moderators" · deck off · views off · critique on · report on')
  expect(f.spawned[0]!.prompt).toContain('Orient the moderators. NO CARDS CRITIQUE REPORT')
  expect(f.reports.get('orientation')).toMatchObject({ orient: { deck: false, views: false, critique: true, report: true } })
  // one at a time
  expect((await orientCommand(f.ctx, '')).text).toContain('an orientation is already running')
  expect(await orientTool(f.ctx, { brief: 'x' })).toMatchObject({ deny: expect.stringContaining('already running') })
  // the first round ends with the document written: a reviewer checks and revises it
  f.files.set(`${CWD}/.thimble-cc-mod/reports/orientation.md`, '# The moderators revert most vandalism\n\nText.\n')
  expect(await orientEnded(f.ctx, 'agent-1', 'answer')).toBe(true)
  expect(f.spawned[1]!.desc).toBe('report · orientation · critique and revision')
  expect(f.spawned[1]!.prompt).toContain('Review .thimble-cc-mod/reports/orientation.md, no cards.')
  expect(f.reports.get('orientation')).toMatchObject({ agentId: 'agent-2', partial: 'a reviewer checks the document against the records' })
  // the critique ends: the coverage line of the first round's reads (never the critique's) ends the document, and the
  // writer starts on a report that retells the document
  expect(await orientEnded(f.ctx, 'agent-2', 'answer')).toBe(false)
  await f.started
  const summed = f.runs.filter(r => r.argv[2] === 'summary').at(-1)!.argv
  expect(summed.filter((_, i) => summed[i - 1] === '--agent')).toEqual(['agent-1'])
  expect(f.files.get(`${CWD}/.thimble-cc-mod/reports/orientation.md`)).toContain('\n\nCoverage: viewed every file · 100% of files · <1% of lines\n')
  const written = [...f.reports.values()].find(r => r.slug !== 'orientation')!
  expect(written).toMatchObject({ form: 'document', title: 'The moderators', source: '.thimble-cc-mod/reports/orientation.md', state: 'writing' })
  expect(f.spawned[2]!.desc).toBe('report · writing The moderators')
  expect(written.file.split('/').at(-1)).toBe('the-moderators-document.md')
  expect(f.spawned.length).toBe(3)
  // main's tool: the same options under the same names, thimble's names read too; a subagent cannot start one
  const tool = await orientTool(f.ctx, { brief: 'edits', generate_report: false, critique: false })
  expect('result' in tool && tool.result).toContain('started the orientation (brief "edits" · deck on · views on · critique off · report off)')
  await f.started
  expect(f.spawned[3]!.prompt).toContain('Orient edits. DECK of orientation-2 VIEWS')
  expect(f.spawned[3]!.prompt).not.toContain('CRITIQUE')
  expect(await orientTool(f.ctx, { agentId: 'a1' })).toMatchObject({ deny: expect.stringContaining('only the main conversation') })
  expect(await orientTool(f.ctx, { deck: 'maybe' })).toMatchObject({ deny: 'thimble-cc-mod orient: deck is true or false' })
  expect(orientToolLine({ brief: 'edits', views: false })).toBe('  orient · brief "edits" · deck on · views off · critique off · report on')
  // the orientation ends early (stopped): no critique, no report
  expect(await orientEnded(f.ctx, 'agent-4', 'stopped')).toBe(false)
  expect(f.spawned.length).toBe(4)
  expect(fillPrompt('a{{#x}} X{{#y}} Y{{/y}}{{/x}}{{^x}} notX{{/x}} {{v}}', { x: true, y: false }, { v: 'V' })).toBe('a X V')
})

test('/thimble-label: list, open, a label defined and run in the panel with the tool\'s arguments, and refusals', async () => {
  const f = fake()
  f.answer = argv => {
    if (String(argv[1]).endsWith('labels.py') && argv[2] === 'run') return { exitCode: 0, stdout: JSON.stringify({ slug: 'deletes-text', name: 'deletes text', kind: 'regex', values: ['delete', 'keep'], counts: { delete: 3, keep: 27 }, labeled: 30, total: 900, trial: true, examples: [], errors: [], cards: ['ee11ff'], card_output: '', card_error: '', script: '' }), stderr: '' }
    return { exitCode: 1, stdout: '', stderr: 'no answer' }
  }
  const said = await labelCommand(f.ctx, 'deletes text regex="removed|deleted" files=revisions.jsonl field=comment values=delete,keep trial=30')
  expect(said.text).toBe('label "deletes text" · regex · "removed|deleted" · revisions.jsonl · field comment · values delete, keep · trial of 30 records')
  expect(f.opened).toEqual(['label'])
  await settle()
  const run = f.runs.find(r => r.argv[2] === 'run')!
  expect(run.argv.slice(2, 6)).toEqual(['run', 'deletes-text', '--limit', '30'])
  // a run labels by the label's own code and writes and runs its card's script: in the scripts' sandbox
  expect(run.boxed).toBe(true)
  expect(JSON.parse(f.files.get(`${CWD}/.thimble-cc-mod/labels/deletes-text/spec.json`)!)).toMatchObject({ name: 'deletes text', kind: 'regex', definition: 'removed|deleted', values: ['delete', 'keep'], paths: ['revisions.jsonl'], field: 'comment' })
  expect(f.notes.at(-1)).toContain('the analyst defined the label "deletes text" (regex: "removed|deleted" over revisions.jsonl) with /thimble-label and ran it on a sample of 30 records: delete 3, keep 27. Its cards: [[card:ee11ff]].')
  // a label of this folder named with --all runs again as defined
  const again = await labelCommand(f.ctx, '"deletes text" --all')
  expect(again.text).toBe('label "deletes text" · regex · "removed|deleted" · revisions.jsonl · field comment · values delete, keep · every record')
  await settle()
  expect(f.runs.filter(r => r.argv[2] === 'run').at(-1)!.argv.slice(2)).toEqual(['run', 'deletes-text', '--cwd', CWD])
  expect(f.notes.at(-1)).toContain('ran the label "deletes text" again with /thimble-label')
  // refusals: an unknown option with the valid list, a new label without its parts, a bad kind
  expect((await labelCommand(f.ctx, 'x colour=red')).text).toMatch(/^unknown option colour=red\. \/thimble-label takes a name, kind/)
  expect((await labelCommand(f.ctx, 'brand new')).text).toContain('no label "brand new" in this folder; a new one needs kind, definition and paths')
  expect((await labelCommand(f.ctx, 'y kind=fuzzy')).text).toBe('kind=fuzzy: kind is prompt, regex or code')
  expect((await labelCommand(f.ctx, 'z kind=prompt files=a.jsonl')).text).toContain('give the definition')
  // the tool reads the command's spellings
  f.answer = argv => (argv[2] === 'run' ? { exitCode: 0, stdout: JSON.stringify({ error: 'stop here' }), stderr: '' } : { exitCode: 1, stdout: '', stderr: '' })
  const viaTool = await labelTool(f.ctx, { name: 'w', kind: 'regex', definition: 'a', files: 'x.jsonl, y.jsonl', trial: 10, within: 'deletes text=delete' })
  expect('deny' in viaTool && viaTool.deny).toContain('stop here')
  expect(JSON.parse(f.files.get(`${CWD}/.thimble-cc-mod/labels/w/spec.json`)!)).toMatchObject({ paths: ['x.jsonl', 'y.jsonl'], within: { label: 'deletes text', value: 'delete' } })
  expect(f.runs.at(-1)!.argv.slice(2, 6)).toEqual(['run', 'w', '--limit', '10'])
})

test('a label\'s spec: the tool\'s input checked, values defaulted', () => {
  expect(specOf({ name: 'refund', kind: 'prompt', definition: 'asks for money back', paths: ['t.jsonl'] })).toEqual({ name: 'refund', kind: 'prompt', definition: 'asks for money back', values: ['yes', 'no'], paths: ['t.jsonl'], field: '' })
  expect(specOf({ name: 'refund', kind: 'llm', definition: 'x', paths: ['t.jsonl'] })).toBe('kind is prompt, regex or code')
  expect(specOf({ name: 'refund', kind: 'regex', definition: 'x', paths: [], values: ['a'] })).toBe('give the globs of the files whose records it labels in paths')
  expect(specOf({ name: 'r', kind: 'regex', definition: 'x', paths: 't.jsonl', within: { label: 'other' } })).toMatchObject({ paths: ['t.jsonl'], within: { label: 'other' } })
})

test('a prompt label\'s model call: thimble\'s prompt, the analyst\'s examples, numbered items; its answer read leniently', () => {
  const spec = { name: 'asks for a refund', kind: 'prompt' as const, definition: 'The customer asks for money back.', values: ['refund', 'other'], paths: ['t.jsonl'], field: 'body' }
  const p = labelPrompt(spec, [{ ref: 't.jsonl#L1', text: 'money back please' }, { ref: 't.jsonl#L2', text: 'where is it' }], [{ ref: 't.jsonl#L9', text: 'refund me', value: 'refund' }])
  expect(p).toContain('The category is named "asks for a refund". One item is one record of t.jsonl (its field body)')
  expect(p).toContain('The allowed values are "refund", "other".')
  expect(p).toContain('### example 1 [t.jsonl#L9]\nrefund me\nThe analyst gave it the value refund.')
  expect(p).toContain('### item 2 [t.jsonl#L2]\nwhere is it')
  const got = parseLabels('{"i": 1, "label": "Refund", "confidence": 0.9, "rationale": "says money back"}\nnoise\n{"i": 2, "label": "other"}\n{"i": 7, "label": "other"}', spec.values, 2)
  expect([...got.entries()]).toEqual([[1, { value: 'refund', confidence: 0.9, rationale: 'says money back' }], [2, { value: 'other', confidence: 0.5, rationale: '' }]])
  expect(parseLabels('[{"i": 1, "label": "maybe"}]', spec.values, 1).size).toBe(0)
  // an object spread over lines, in a fence, with brackets and braces in its strings
  const spread = parseLabels('```json\n[\n  {\n    "i": 1,\n    "label": "refund",\n    "rationale": "links [x] and {y}"\n  }\n]\n```', spec.values, 1)
  expect(spread.get(1)).toEqual({ value: 'refund', confidence: 0.5, rationale: 'links [x] and {y}' })
  expect(jsonObjects('a {"s": "}"} b {"t": {"u": 1}}')).toEqual(['{"s": "}"}', '{"t": {"u": 1}}'])
})

test('a prompt label runs: a trial\'s records judged in batches, the rows handed to the helper; apply to all reads only the rest', async () => {
  const f = fake()
  const units = Array.from({ length: 25 }, (_, i) => ({ ref: `t.jsonl#L${i + 1}`, text: i % 5 === 0 ? 'I want my money back' : 'where is my order' }))
  let finished: { rows: Record<string, { value: string }>; total: number; trial: boolean } | null = null
  f.answer = argv => {
    if (argv[2] === 'units') {
      const limit = argv.includes('--limit') ? Number(argv[argv.indexOf('--limit') + 1]) : 0
      const picked = limit ? units.filter((_, i) => i % 5 === 0) : units
      return { exitCode: 0, stdout: JSON.stringify({ total: 25, trial: Boolean(limit), examples: [], units: picked.map((u, i) => (i === 0 && !limit ? { ...u, set: 'refund' } : u)) }), stderr: '' }
    }
    if (argv[2] === 'finish') {
      finished = JSON.parse(f.files.get(`${CWD}/.thimble-cc-mod/labels/asks-for-a-refund/rows.prompt.json`)!)
      const rows = finished!.rows
      f.files.set(`${CWD}/.thimble-cc-mod/labels/asks-for-a-refund/rows.json`, JSON.stringify({ rows }))
      const counts = { refund: Object.values(rows).filter(r => r.value === 'refund').length, other: Object.values(rows).filter(r => r.value === 'other').length }
      return { exitCode: 0, stdout: JSON.stringify({ slug: 'asks-for-a-refund', name: 'asks for a refund', kind: 'prompt', values: ['refund', 'other'], counts, labeled: Object.keys(rows).length, total: 25, trial: finished!.trial, examples: [{ value: 'refund', ref: 't.jsonl#L1', text: 'I want my money back', rationale: 'money back', confidence: 0.9, analyst: false }], errors: [], cards: ['aa11bb', 'cc22dd'], card_output: 'thimble-cc-mod card aa11bb (bar, 2 rows)\nembed it on a line of its own: [[card:aa11bb]]', card_error: '', script: '.thimble-cc-mod/scripts/label-asks-for-a-refund.py' }), stderr: '' }
    }
    return { exitCode: 1, stdout: '', stderr: 'unexpected' }
  }
  f.model = prompt => {
    const items = [...prompt.matchAll(/### item (\d+) \[[^\]]+\]\n(.*)/g)]
    return items.map(m => JSON.stringify({ i: Number(m[1]), label: /money/.test(m[2]!) ? 'refund' : 'other', confidence: 0.8, rationale: 'r' })).join('\n')
  }
  const res = await labelTool(f.ctx, { name: 'asks for a refund', kind: 'prompt', definition: 'The customer asks for money back.', values: ['refund', 'other'], paths: ['t.jsonl'], field: 'body', limit: 5 })
  expect('result' in res && res.result).toContain('a trial on 5 of 25 records')
  expect('result' in res && res.result).toContain('[[card:aa11bb]]')
  expect(f.asked.length).toBe(1)
  expect(finished!.trial).toBe(true)
  expect(f.labels.get('asks-for-a-refund')).toMatchObject({ state: 'ready', trial: true, counts: { refund: 5, other: 0 }, cards: ['aa11bb', 'cc22dd'] })
  expect(f.opened).toEqual(['label'])
  // paging the records runs no code; finishing writes and runs the label card's script, in the scripts' sandbox
  expect(f.runs.filter(r => r.argv[2] === 'units').every(r => !r.boxed)).toBe(true)
  expect(f.runs.find(r => r.argv[2] === 'finish')?.boxed).toBe(true)
  // apply to all, the definition unchanged: the trial's rows kept, only the other 20 asked, the analyst's value kept
  f.asked = []
  const all = await runLabel(f.ctx, specOf({ name: 'asks for a refund', kind: 'prompt', definition: 'The customer asks for money back.', values: ['refund', 'other'], paths: ['t.jsonl'], field: 'body' }) as never, 0)
  expect('error' in all && all.error).toBeFalsy()
  expect(f.asked.join('\n').match(/### item/g)?.length).toBe(20)
  expect(Object.keys(finished!.rows).length).toBe(25)
  // the analyst's value, with why the model gave the one it kept before
  expect(finished!.rows['t.jsonl#L1']).toMatchObject({ value: 'refund', rationale: 'r' })
  expect(f.changed).toEqual(['aa11bb', 'cc22dd', 'aa11bb', 'cc22dd'])
  expect(labelToolLine({ name: 'asks for a refund', kind: 'prompt' }, f.labels.get('asks-for-a-refund'))).toBe('  label · "asks for a refund" · prompt · refund 5 · other 20')
})

test('a batch the model answers empty is asked again in halves, down to one record', async () => {
  const f = fake()
  const units = Array.from({ length: 10 }, (_, i) => ({ ref: `t.jsonl#L${i + 1}`, text: i === 3 ? 'HARD' : 'easy' }))
  let rows: Record<string, { value: string }> = {}
  f.answer = argv => {
    if (argv[2] === 'units') return { exitCode: 0, stdout: JSON.stringify({ total: 10, picked: 10, pages: 1, examples: [], units }), stderr: '' }
    const kept = JSON.parse(f.files.get(`${CWD}/.thimble-cc-mod/labels/h/rows.prompt.json`)!) as { rows: typeof rows; errors: string[]; status: string }
    rows = kept.rows
    return { exitCode: 0, stdout: JSON.stringify({ slug: 'h', name: 'h', kind: 'prompt', values: ['yes', 'no'], counts: {}, labeled: Object.keys(rows).length, total: 10, trial: false, examples: [], errors: kept.errors, status: kept.status, cards: [], card_output: '', card_error: '', script: '' }), stderr: '' }
  }
  f.ctx.complete = async req => {
    f.asked.push(req.prompt)
    const items = [...req.prompt.matchAll(/### item (\d+) \[[^\]]+\]\n(.*)/g)]
    if (items.some(m => m[2] === 'HARD') && items.length > 1) return { isAnswered: false, reason: 'empty-reply', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
    return { isAnswered: true, text: items.map(m => JSON.stringify({ i: Number(m[1]), label: 'yes' })).join('\n'), usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
  }
  const res = await labelTool(f.ctx, { name: 'h', kind: 'prompt', definition: 'd', paths: ['t.jsonl'], values: ['yes', 'no'] })
  expect('result' in res).toBe(true)
  expect(Object.keys(rows).length).toBe(10)
  expect(f.asked.length).toBe(1 + 2 + 2 + 2)
  // the splits are what the run recovered from: one dim status line, no problem
  expect(f.labels.get('h')).toMatchObject({ errors: [], status: '3 empty replies split and asked again' })
  // a record the model still leaves empty alone is read once by the fallback model, which its row names
  f.ctx.complete = async req => {
    f.asked.push(`${req.model}:${req.prompt}`)
    if (req.model === 'claude-opus-5-5') return { isAnswered: false, reason: 'empty-reply', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
    return { isAnswered: true, text: '{"i": 1, "label": "no", "rationale": "short"}', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
  }
  const one = await labelTool(f.ctx, { name: 'h', kind: 'prompt', definition: 'other', paths: ['t.jsonl'], values: ['yes', 'no'], limit: 1 })
  expect('result' in one && one.result).toContain('The model calls: 9 empty replies split and asked again · 10 records claude-opus-5-5 gave no value read by claude-opus-4-8.')
  expect(f.labels.get('h')!.errors).toEqual([])
  expect(Object.values(rows).some(r => (r as { rationale?: string }).rationale?.includes('(read by claude-opus-4-8: claude-opus-5-5 gave no value)'))).toBe(true)
})

test('a label the helper refuses, and a prompt label over too many records, say why', async () => {
  const f = fake()
  f.answer = argv => (argv[2] === 'run' ? { exitCode: 0, stdout: JSON.stringify({ error: 'the regex does not compile: missing )' }), stderr: '' } : { exitCode: 0, stdout: JSON.stringify({ total: 9000, units: Array.from({ length: 9000 }, (_, i) => ({ ref: `x#L${i + 1}`, text: 'x' })), examples: [] }), stderr: '' })
  expect('deny' in (await labelTool(f.ctx, { name: 'nothing saved' })) && (await labelTool(f.ctx, { name: 'nothing saved' }) as { deny: string }).deny).toContain('no label "nothing saved" in this folder')
  // a name alone runs the saved label again, as it was defined
  f.files.set(`${CWD}/.thimble-cc-mod/labels/b/spec.json`, JSON.stringify({ name: 'b', kind: 'regex', definition: '(', values: ['yes', 'no'], paths: ['x'], field: '' }))
  const again = await labelTool(f.ctx, { name: 'b' })
  expect('deny' in again && again.deny).toContain('does not compile')
  expect(f.runs.at(-1)!.argv.slice(2, 4)).toEqual(['run', 'b'])
  const bad = await labelTool(f.ctx, { name: 'b', kind: 'regex', definition: '(', paths: ['x'] })
  expect('deny' in bad && bad.deny).toContain('does not compile')
  const big = await labelTool(f.ctx, { name: 'c', kind: 'prompt', definition: 'd', paths: ['x'] })
  expect('deny' in big && big.deny).toContain('9,000 records is more than a prompt label reads in one run')
  expect(f.asked.length).toBe(0)
  expect(labelAnswer({ name: 'r', kind: 'regex', definition: 'x', values: ['yes', 'no'], paths: ['x'], field: '' }, { slug: 'r', name: 'r', kind: 'regex', values: ['yes', 'no'], counts: { yes: 2, no: 3 }, labeled: 5, total: 5, trial: false, examples: [], errors: [], cards: [], card_output: '', card_error: '', script: '' })).toContain('all 5 records; the regex matched each record. Counts: yes 2, no 3.')
})

test('a label run\'s failures fold: what was recovered in one status line, the records left without a value in one problem line', async () => {
  expect(judgedStatus({ retried: 4, split: 13, reasked: 2, fellBack: 1, lost: 0, why: [], first: '' }, 'claude-opus-5-5')).toBe(
    '13 empty replies split and asked again · 4 calls retried after an overload · 2 records a reply left out asked again · 1 record claude-opus-5-5 gave no value read by claude-opus-4-8',
  )
  expect(judgedProblem({ retried: 0, split: 0, reasked: 0, fellBack: 0, lost: 0, why: [], first: '' })).toBe('')
  const f = fake()
  const units = Array.from({ length: 60 }, (_, i) => ({ ref: `t.jsonl#L${i + 1}`, text: 'x' }))
  let kept: { errors: string[]; status: string } = { errors: [], status: '' }
  f.answer = argv => {
    if (argv[2] === 'units') return { exitCode: 0, stdout: JSON.stringify({ total: 60, picked: 60, pages: 1, examples: [], units }), stderr: '' }
    kept = JSON.parse(f.files.get(`${CWD}/.thimble-cc-mod/labels/f/rows.prompt.json`)!) as typeof kept
    return { exitCode: 0, stdout: JSON.stringify({ slug: 'f', name: 'f', kind: 'prompt', values: ['yes', 'no'], counts: {}, labeled: 0, total: 60, trial: false, examples: [], errors: kept.errors, status: kept.status, cards: [], card_output: '', card_error: '', script: '' }), stderr: '' }
  }
  // six batches: every call overloaded, retried four times, then given up
  f.ctx.complete = async req => {
    f.asked.push(req.prompt)
    return { isAnswered: false, reason: 'api-error', error: 'overloaded', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } as never
  }
  await labelTool(f.ctx, { name: 'f', kind: 'prompt', definition: 'd', paths: ['t.jsonl'], values: ['yes', 'no'] })
  expect(kept.errors).toEqual(['60 records have no value (a model call failed: api-error overloaded), such as t.jsonl#L1'])
  expect(kept.status).toBe('24 calls retried after an overload')
  expect(f.labels.get('f')).toMatchObject({ errors: kept.errors, status: kept.status })
})

test('a verdict from the label card or the panel: kept by the helper, the label and its card made again, main told', async () => {
  const f = fake()
  const ex = (ref: string, value: string, analyst = false, was = '') => ({ value, ref, text: 'w', rationale: 'r', confidence: 1, analyst, was })
  f.labels.set('refund', { slug: 'refund', name: 'asks for a refund', kind: 'regex', definition: 'x', values: ['refund', 'other'], paths: ['t.jsonl'], field: '', state: 'ready', trial: false, limit: 0, total: 40, labeled: 40, counts: { refund: 10, other: 30 }, examples: [ex('t.jsonl#L4', 'refund'), ex('t.jsonl#L1', 'other')], cards: ['c1'], errors: [], created: 0 })
  f.answer = argv => {
    const [, , op, , ref, value] = argv
    if (op !== 'verdict') return { exitCode: 1, stdout: '', stderr: 'unexpected' }
    const flip = ref === 't.jsonl#L1' && value === 'refund'
    return { exitCode: 0, stdout: JSON.stringify({ counts: flip ? { refund: 11, other: 29 } : { refund: 10, other: 30 }, labeled: 40, cards: ['c1'], examples: [ex('t.jsonl#L4', 'refund', ref === 't.jsonl#L4', 'refund'), ex('t.jsonl#L1', flip ? 'refund' : 'other', flip, 'other')] }), stderr: '' }
  }
  await labelVerdict(f.ctx, 'refund', 't.jsonl#L1', 'refund')
  expect(f.runs.at(-1)!.argv.slice(2, 6)).toEqual(['verdict', 'refund', 't.jsonl#L1', 'refund'])
  expect(f.labels.get('refund')).toMatchObject({ counts: { refund: 11, other: 29 } })
  expect(f.labels.get('refund')!.examples[1]).toMatchObject({ value: 'refund', analyst: true, was: 'other' })
  expect(f.changed).toEqual(['c1'])
  expect(f.notes.at(-1)).toBe('thimble-cc-mod: the analyst set t.jsonl#L1 to "refund" in the label "asks for a refund" (it was "other"); its counts are now refund 11, other 29.')
  await labelVerdict(f.ctx, 'refund', 't.jsonl#L4', 'refund')
  expect(f.notes.at(-1)).toBe('thimble-cc-mod: the analyst agreed that t.jsonl#L4 is "refund" in the label "asks for a refund".')
})
