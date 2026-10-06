// The view pipeline (hooks/viewpipe.ts and its engine in register.tsx): a proposal read, the builder started with
// thimble's dev-view prompt adapted, the checks' report sent back to a new builder, the view opened when they pass, the
// reviewer given the drawn view, its problems fixed by a builder, a change the analyst asks for, the `↳ view` row under
// main's answer and the views pane.
// `claude plugin test mods/thimble-cc-mod`.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Mounted, TestBody } from 'claude-code/testing'

import { lineWidth } from '../hooks/draw'
import type { Line } from '../hooks/draw'
import { signalsJson } from '../hooks/signal'

import { BUILD_ATTEMPTS, LAST_ROUND, REVIEW_ROUNDS, afterBuild, afterReview, buildName, buildPrompt, buildStart, examplesText, fixedOf, handbackFrom, handbackReport, lastLook, parseFindings, parseProposal, reviewName, stateWords, stepOf, touchesProposals, viewReadyNote, viewsCount } from '../hooks/viewpipe'
import type { BuildStatus } from '../hooks/viewpipe'
import type { Proposal } from '../hooks/viewpipe'
import { MOD_AGENT } from '../hooks/threads'
import { TIMELINE } from './view-fixtures'

const PROPOSAL: Proposal = {
  slug: 'timeline',
  name: 'Timeline',
  why: 'Every source on one time axis, so the analyst sees what answered what.',
  claims: ['alerts/*.jsonl', 'chat/*.json'],
  unit: 'one event, keyed by its line; 198',
  overview: 'lanes per source over the days',
  zoom: 'a time window, an incident',
  filter: 'source, incident, service',
  details: 'the event whole, with the events that answer it',
  proposed_by: 'main',
  build: true,
  files: 39,
  ts: '2026-10-04T10:00:00Z',
}

// ------------------------------------------------------------------------------------------------ pure

test('a proposal is read with every field, and refused without its slug or name', () => {
  expect(parseProposal({ ...PROPOSAL, why: '  two\n words ' })?.why).toBe('two words')
  expect(parseProposal({ ...PROPOSAL, build: 'yes' })?.build).toBe(false)
  expect(parseProposal({ name: 'x' })).toBe(null)
  expect(parseProposal('nope')).toBe(null)
})

test('the builder\'s prompt carries the proposal, the contract, the examples and the check command', () => {
  const ex = examplesText('/mod/viewers', '/mod/tests/fixtures/views', { timeline: true, 'linked-sessions': false, repository: false }, { timeline: true, 'linked-sessions': false, repository: false })
  expect(ex).toContain('the spec the panel draws /mod/viewers/timeline/view.json')
  expect(ex).toContain('the spec the panel draws /mod/tests/fixtures/views/repository/view.json')
  expect(ex).toContain("The readers of `linked-sessions`, `repository` were written for thimble's browser page")
  const t = '{{name}} `{{slug}}` {{why}} {{claims}}\n{{spec}}\n{{draft}}{{spec_md}} {{check}} {{render}} {{examples}} {{corpus}} {{folder}} {{other}}'
  const p = buildPrompt(t, PROPOSAL, { corpus: '/c', folder: '/c/.thimble-cc-mod/views/timeline', specMd: '/mod/views/SPEC.md', examples: ex, check: 'python3 /mod/helper/viewpipe.py check timeline', render: 'node r', draft: false })
  expect(p).toContain('Timeline `timeline` Every source on one time axis')
  expect(p).toContain('alerts/*.jsonl, chat/*.json')
  expect(p).toContain('- Unit: one event, keyed by its line; 198\n- Overview: lanes per source over the days')
  expect(p).toContain('- Details: the event whole')
  expect(p).toContain('/mod/views/SPEC.md python3 /mod/helper/viewpipe.py check timeline node r')
  expect(p).toContain('{{other}}')
  expect(p).not.toContain('earlier build')
  expect(buildPrompt(t, PROPOSAL, { corpus: '', folder: '', specMd: '', examples: '', check: '', render: '', draft: true })).toContain('earlier build left it')
})

test('the reviewer\'s answer: the last JSON with a list of problems, in prose or a code fence; none is null', () => {
  expect(parseFindings('Looks fine.\n{"problems": []}')).toEqual([])
  expect(parseFindings('I checked it.\n```json\n{"problems": ["Events: times read 00:00", "  "]}\n```')).toEqual(['Events: times read 00:00'])
  expect(parseFindings('{"problems": ["a"]} then {"problems": ["b {x}"]}')).toEqual(['b {x}'])
  expect(parseFindings('no json here')).toBe(null)
})

test('names, states and steps as the row and the pane show them', () => {
  expect(MOD_AGENT.test(buildName('Timeline'))).toBe(true)
  expect(MOD_AGENT.test(reviewName('Timeline'))).toBe(true)
  // the note main reads when a build ends with the view ready: the command that opens it, and what the review left
  expect(viewReadyNote({ name: 'Timeline', slug: 'timeline' }, '.thimble-cc-mod')).toBe('thimble-cc-mod: view ready: Timeline (open with /thimble-view timeline), in .thimble-cc-mod/views/timeline/.')
  expect(viewReadyNote({ name: 'Timeline', slug: 'timeline' }, '.h', 2, 'Its review did not finish.')).toBe('thimble-cc-mod: view ready: Timeline (open with /thimble-view timeline), in .h/views/timeline/. Its review left 2 problems unfixed, listed in the views pane. Its review did not finish.')
  expect(stateWords(undefined, false)).toEqual({ mark: '○', words: 'proposed', state: 'proposed' })
  expect(stateWords(undefined, true).state).toBe('built')
  const s = { for: 't', state: 'building' as const, attempt: 2, round: 0, step: 'writing reader.py', at: 0 }
  expect(stateWords(s, false).words).toBe('building · attempt 2 · writing reader.py')
  expect(stateWords({ ...s, state: 'built', fixed: ['a', 'b'] }, true)).toEqual({ mark: '●', words: 'built · reviewed, 2 fixed', state: 'built' })
  // problems the review left: not a check mark
  expect(stateWords({ ...s, state: 'built', fixed: ['a', 'b'], left: ['c'] }, true)).toEqual({ mark: '!', words: 'built · 1 problem left, 2 fixed', state: 'built' })
  expect(viewsCount([])).toBe('no view proposed in this folder yet')
  expect(viewsCount(['built'])).toBe('1 view built')
  expect(viewsCount(['built', 'proposed', 'built'])).toBe('3 views: 2 built, 1 proposed')
  expect(stateWords({ ...s, state: 'failed', error: 'build_index failed' }, false)).toEqual({ mark: '×', words: 'failed: build_index failed', state: 'failed' })
  expect(stepOf('Write', { file_path: '/c/.thimble-cc-mod/views/t/reader.py' })).toBe('writing reader.py')
  expect(stepOf('Bash', { command: 'python3 /m/helper/viewpipe.py check t' })).toBe('running the checks')
  expect(stepOf('Bash', { command: 'head -3 events.jsonl' })).toBe('reading the files')
  expect(touchesProposals('Bash', { command: 'python3 /m/helper/viewpipe.py propose --build --name X' })).toBe(true)
  expect(touchesProposals('Write', { file_path: '/c/.thimble-cc-mod/views/x/proposal.json' })).toBe(true)
  expect(touchesProposals('Bash', { command: 'python3 x.py' })).toBe(false)
})

test('a build\'s steps, as thimble runs them: checks sent back, a review after each pass, fixes put back when they never pass', () => {
  const at = (s: BuildStatus, p: Partial<BuildStatus>): BuildStatus => ({ ...s, ...p }) as BuildStatus
  let s = at({ at: 0 } as BuildStatus, buildStart(undefined, 't1', {}))
  expect(s).toMatchObject({ for: 't1', state: 'building', attempt: 1, round: 0, fixed: [], left: [] })
  // checks fail: a new builder with their report, attempt 2
  let step = afterBuild(s, false, ['problem: x'], 'answer')
  expect(step).toMatchObject({ next: 'gates', open: false })
  s = at(at(s, step.patch), buildStart(s, 't1', { gates: ['problem: x'] }))
  expect(s).toMatchObject({ state: 'building', attempt: 2, round: 0 })
  // they pass: the view opens and the review starts
  step = afterBuild(s, true, ['checks passed'], 'answer')
  expect(step).toMatchObject({ next: 'review', open: true })
  s = at(s, step.patch)
  // the review's problems: a builder fixes them, round 1
  const r1 = afterReview(s, ['a', 'b'], 'answer')
  expect(r1.next).toBe('revise')
  s = at(s, buildStart(s, 't1', { review: ['a', 'b'] }))
  expect(s).toMatchObject({ state: 'revising', attempt: 1, round: 1, asked: ['a', 'b'] })
  // the fix passes: counted as fixed, reviewed again without opening the view again
  step = afterBuild(s, true, ['checks passed'], 'answer')
  expect(step).toMatchObject({ next: 'review', open: false, patch: { fixed: ['a', 'b'], asked: [] } })
  s = at(s, step.patch)
  // round 2's fix never passes the checks: the view as reviewed is put back, its problems left
  s = at(s, buildStart(s, 't1', { review: ['c'] }))
  for (let i = 1; i < BUILD_ATTEMPTS; i++) {
    expect(afterBuild(s, false, ['problem: y'], 'answer').next).toBe('gates')
    s = at(s, buildStart(s, 't1', { gates: ['problem: y'] }))
  }
  expect(s).toMatchObject({ round: 2, attempt: BUILD_ATTEMPTS, state: 'revising' })
  step = afterBuild(s, false, ['problem: y'], 'answer')
  expect(step).toMatchObject({ next: 'restore', patch: { state: 'built', left: ['c'] } })
  // the last open review's problems go to one more builder, whose fixes a review checks problem by problem
  expect(afterReview(at(s, { round: REVIEW_ROUNDS }), ['d', 'e'], 'answer').next).toBe('revise')
  let last = at(at(s, { round: REVIEW_ROUNDS, attempt: 1, fixed: ['a', 'b'] }), buildStart(at(s, { round: REVIEW_ROUNDS }), 't1', { review: ['d', 'e'] }))
  expect(last).toMatchObject({ round: LAST_ROUND, state: 'revising', asked: ['d', 'e'] })
  step = afterBuild(last, true, ['checks passed'], 'answer')
  // its problems stay asked, not counted fixed, until that review says which are fixed
  expect(step).toEqual({ next: 'review', patch: { checks: ['checks passed'] }, open: false })
  last = at(last, step.patch)
  expect(stateWords({ ...last, state: 'reviewing' }, true).words).toBe('built · checking the last fixes')
  expect(lastLook(last)).toContain('1. d\n2. e')
  expect(lastLook(at(last, { round: REVIEW_ROUNDS }))).toBe('')
  expect(afterReview(last, ['e'], 'answer')).toEqual({ next: 'done', patch: { state: 'built', step: '', left: ['e'], fixed: ['a', 'b', 'd'], asked: [] } })
  expect(afterReview(last, [], 'answer').patch).toMatchObject({ left: [], fixed: ['a', 'b', 'd', 'e'] })
  // no answer from it leaves what it was to check
  expect(afterReview(last, null, 'answer').patch).toMatchObject({ left: ['d', 'e'], error: 'the review gave no list of problems' })
  // none, or no answer, ends an open review too
  expect(afterReview(s, [], 'answer').patch.state).toBe('built')
  expect(afterReview(s, null, 'answer').patch.error).toBe('the review gave no list of problems')
  // a first build whose attempts run out fails with the first problem
  const first = at({ at: 0 } as BuildStatus, { ...buildStart(undefined, 't2', {}), attempt: BUILD_ATTEMPTS })
  expect(afterBuild(first, false, ['index: 3 files', 'problem: build_index failed: KeyError', 'checks failed'], 'answer')).toMatchObject({ next: 'failed', patch: { state: 'failed', error: 'build_index failed: KeyError' } })
})

// ------------------------------------------------------------------------------------------------ the engine

const CWD = '/corpus/ops'
const DIR = `${CWD}/.thimble-cc-mod/views/timeline`
type M = Mounted<'terminal'>
type El = { type: string; props: Record<string, unknown>; children?: unknown[] }
// an element's text, a Button's label included
const textOf = (x: unknown): string => {
  if (typeof x === 'string') return x
  const el = x as El
  const label = typeof el.props?.label === 'string' ? `${el.props.label} ` : ''
  return label + (el.children ?? []).map(textOf).join('')
}
const PANE = { plugin: 'thimble-cc-mod', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 200, rows: 55 }, props: { bodyColumns: 96, scroll: { bodyRows: 46 } } } as const

type World = { files: Map<string, string>; spawned: { prompt: string; description: string; type: string }[]; runs: string[][]; opened: string[]; notes: string[]; checks: { exitCode: number; stdout: string }[]; agents: { id: string; status: string; spawnedBy: string }[]; tools: string[]; context: string[]; logs: string[] }

function world(on: On): World {
  const w: World = { files: new Map([[`${DIR}/proposal.json`, JSON.stringify(PROPOSAL)]]), spawned: [], runs: [], opened: [], notes: [], checks: [], agents: [], tools: [], context: [], logs: [] }
  mock.env(on, {})
  on('env.set', () => ({ value: undefined }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.messages', () => ({ value: [] }) as never)
  on('session.append', ($, e) => {
    w.notes.push(JSON.stringify(e.message))
    return { uuid: 'n1' } as never
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('fs.read', ($, e) => {
    if (e.path.endsWith('/prompt/chat.md')) return { value: '# thimble-cc-mod\n' }
    if (e.path.endsWith('/prompt/view-build.md')) return { value: 'BUILD {{name}} {{slug}} {{check}}\n{{spec}}\n{{spec_md}}{{draft}}' }
    if (e.path.endsWith('/prompt/view-gates.md')) return { value: 'GATES {{check}}\n{{report}}' }
    if (e.path.endsWith('/prompt/view-revise.md')) return { value: 'REVISE {{drawings}}\n{{findings}}' }
    if (e.path.endsWith('/prompt/view-review.md')) return { value: 'REVIEW {{name}}\n{{checks}}\n{{drawings}}\n{{last}}' }
    if (e.path.endsWith('/prompt/view-change.md')) return { value: 'CHANGE {{request}} {{check}}' }
    const t = w.files.get(e.path)
    if (t === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: t }
  })
  on('fs.stat', ($, e) => {
    if (!w.files.has(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: 1, mtimeMs: w.files.get(e.path)!.length, isLink: false } }
  })
  on('fs.list', ($, e) => ({ value: e.path.endsWith('/.thimble-cc-mod/views') ? [{ name: 'timeline', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] : [] }) as never)
  on('fs.exists', ($, e) => ({ value: w.files.has(e.path) }))
  on('fs.write', ($, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    const argv = e.argv.map(String)
    w.runs.push(argv)
    if (argv[1]?.endsWith('/helper/viewpipe.py')) {
      const c = w.checks.shift() ?? { exitCode: 1, stdout: 'problem: no check queued' }
      if (c.exitCode === 0) {
        w.files.set(`${DIR}/view.json`, JSON.stringify(TIMELINE.spec))
        w.files.set(`${DIR}/rows.json`, JSON.stringify(TIMELINE.data))
      }
      return { value: { ...c, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (argv[1]?.endsWith('/tools/render_view.mjs')) return { value: { exitCode: 0, stdout: `=== Events\nTimeline  60 events (${argv.includes('--all') ? 'all' : 'narrow'})\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 0, stdout: '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('agent.spawn', ($, e) => {
    w.spawned.push({ prompt: e.prompt, description: e.description, type: e.subagentType ?? (e as { subagent_type?: string }).subagent_type ?? '' })
    return { model: 'm', agentId: `agent-${w.spawned.length}` }
  })
  on('agent.list', () => ({ value: w.agents }) as never)
  on('tool.call', ($, e) => {
    w.tools.push(String(e.tool))
    return { result: { content: [{ type: 'text', text: 'ok' }] }, text: 'ok' } as never
  })
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.panes', () => ({ value: [] }) as never)
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.focus', () => ({}) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.log', ($, e) => {
    w.logs.push(e.text)
    return { value: undefined } as never
  })
  on('prompt.read', () => ({ value: { text: '' } }) as never)
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', ($, e) => {
    w.context.push(...(e.context ?? []))
    return { text: e.text } as never
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: ['(the engine row)'] })
  })
  return w
}

type Engine = Parameters<TestBody>[0]

/** The notes the mod left main that wait for its next prompt. */
function waiting(w: World): string[] {
  const raw = w.files.get(`${CWD}/.thimble-cc-mod/notes.json`)
  return raw ? (JSON.parse(raw) as { notes: string[] }).notes : []
}

/** The views pane's list as its Client draws it, one line per view (its glyph, its name, its status at R). */
async function listLines(pane: M): Promise<Line[]> {
  const c = (await pane.find({ type: 'Client', key: 'm:views-list' })) as unknown as { props: { props: { lines: Line[] } } } | undefined
  return c?.props.props.lines ?? []
}
const plain = (lines: Line[]) => lines.map(l => l.map(x => x.s).join('').trimEnd()).join('\n')

/** The views pane's list, opened by /thimble-views. */
async function listed($: Engine): Promise<string> {
  await $.command.run({ command: 'thimble-views', args: '' } as never)
  const pane = (await $.ui.mount(PANE as never)) as unknown as M
  const t = plain(await listLines(pane))
  await pane.unmount()
  return t
}

/** The `↳` rows main's chat row `requestId` carries under it (the turn's duration here), as the terminal reads them. */
const TURN = (requestId: string) => ({ plugin: 'thimble-cc-mod', component: 'TurnDuration', requestId, surface: 'terminal', viewport: { columns: 120, rows: 40 }, props: { word: 'Baked', durationMs: 3000 } })
async function rowUnder($: Engine, requestId: string): Promise<string> {
  const ui = (await $.ui.mount(TURN(requestId) as never)) as unknown as M
  const root = (await ui.drawn()) as unknown as El
  await ui.unmount()
  const find = (n: unknown): El | undefined => ((n as El)?.props?.key === `signals:${requestId}` ? (n as El) : ((n as El)?.children ?? []).map(find).find(Boolean))
  const line = (r: El) => ((r.children ?? []) as El[]).map(c => (c.type === 'Button' ? String(c.props.label) : textOf(c))).join('')
  const box = find(root)
  return box ? ((box.children ?? []) as El[]).map(line).join('\n') : ''
}

/** A row of main's answer stored, which the `↳` rows stand under. */
async function mainRow($: Engine, uuid: string): Promise<void> {
  await $.session.append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'An answer of main.' }] }, door: 'response', origin: { kind: 'model', model: 'm' }, uuid } as never).catch(() => undefined)
}

const status = (w: World) => JSON.parse(w.files.get(`${DIR}/status.json`) ?? '{}') as { for?: string; state: string; attempt: number; round: number; error?: string }

// The test kit gives no subagent an id (only Claude Code starts one), so a build here goes as far as its builder's
// start: a fork of main asked for first, the general-purpose fallback after it (named so), then the build marked
// failed. What follows a builder's end is the pure test above, the tests of a builder or reviewer taken up after a
// reload below, and the live run.
test('a proposal asked to be built starts its builder at once, named for the view and given the proposal', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on, { now: 1_790_000_000_000 })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await clock.advance(10)
  expect(w.spawned.map(s => [s.description, s.type])).toEqual([['view · building Timeline', 'fork'], ['view · building Timeline · general-purpose, fork refused', 'general-purpose']])
  expect(w.spawned[1]!.prompt).toBe(w.spawned[0]!.prompt) // the builder's prompt stands alone
  const p = w.spawned[0]!.prompt
  expect(p).toContain('BUILD Timeline timeline python3 ')
  expect(p).toContain('/helper/viewpipe.py check timeline')
  expect(p).toContain('- Overview: lanes per source over the days')
  expect(p).toContain('/views/SPEC.md')
  expect(status(w)).toMatchObject({ state: 'failed', attempt: 1, round: 0, error: 'could not start a subagent: no id' })
  expect(await listed($)).toMatch(/^❯ × Timeline/)
  // read again later, the same proposal is not built again
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_2', command: 'cat .thimble-cc-mod/views/timeline/proposal.json' } as never)
  await clock.advance(10)
  expect(w.spawned.length).toBe(2)
})

test('a proposal without --build waits; the views pane shows its description and builds it', async ($, on) => {
  const w = world(on)
  w.files.set(`${DIR}/proposal.json`, JSON.stringify({ ...PROPOSAL, build: false }))
  const clock = mock.clock(on, { now: 1_790_000_000_000 })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await clock.advance(10)
  expect(w.spawned.length).toBe(0)
  const r = await $.command.run({ command: 'thimble-views', args: 'timeline' } as never)
  expect((r as { text?: string }).text).toBe('1 view proposed')
  expect(w.opened).toEqual(['thimble'])
  const pane = (await $.ui.mount(PANE as never)) as unknown as M
  // its glyph says proposed, and no word repeats it
  expect(plain(await listLines(pane))).toMatch(/^❯ ○ Timeline$/)
  const text = textOf(await pane.drawn())
  // under the second rule: why it was proposed, as prose, then `build`; none of the proposal's other fields
  for (const s of ['Every source on one time axis', 'build']) expect(text).toContain(s)
  for (const s of ['overview', 'lanes per source over the days', 'alerts/*.jsonl', 'ask for a change']) expect(text).not.toContain(s)
  await pane.press({ key: 'vbuild' })
  await pane.unmount()
  await clock.advance(10)
  expect(w.spawned[0]!.description).toBe('view · building Timeline')
  expect(status(w).for).toBe(PROPOSAL.ts)
})

test('a build main asks for in its turn starts once the turn ends, so the builder does not hold the turn open; its `↳ view` row stands under the answer', async ($, on) => {
  const w = world(on)
  w.files.delete(`${DIR}/proposal.json`)
  on('turn.start', ($, e) => ({ turnId: e.turnId }) as never)
  const clock = mock.clock(on, { now: 1_790_000_000_000 })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ turnId: 't1', text: 'make me a view of the events' } as never)
  w.files.set(`${DIR}/proposal.json`, JSON.stringify(PROPOSAL))
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_1', command: 'python3 /m/helper/viewpipe.py propose --build --name Timeline' } as never)
  await mainRow($, 'm1')
  await clock.advance(10)
  expect(w.spawned.length).toBe(0)
  // no row while the turn runs
  expect(await rowUnder($, 'm1')).toBe('')
  await $.turn.complete({ turnId: 't1', answer: 'Building the Timeline view.', durationMs: 5, reason: 'answer' } as never)
  await clock.advance(10)
  expect(w.spawned[0]?.description).toBe('view · building Timeline')
  // the kit starts no subagent, so the build failed: its row says so
  expect(await rowUnder($, 'm1')).toBe('↳ view · Timeline · failed')
})

test('main\'s proposal through the helper is read at once and starts its build', async ($, on) => {
  const w = world(on)
  w.files.delete(`${DIR}/proposal.json`)
  const clock = mock.clock(on, { now: 1_790_000_000_000 })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  expect(await listed($)).not.toContain('Timeline')
  w.files.set(`${DIR}/proposal.json`, JSON.stringify(PROPOSAL))
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_1', command: 'python3 /m/helper/viewpipe.py propose --build --name Timeline' } as never)
  await clock.advance(10)
  expect(w.spawned[0]?.description).toBe('view · building Timeline')
})

test('a built view opens in the panel from its `↳ view` row and from the views pane', async ($, on) => {
  const w = world(on)
  w.files.set(`${DIR}/proposal.json`, JSON.stringify({ ...PROPOSAL, build: false }))
  w.files.set(`${DIR}/view.json`, JSON.stringify(TIMELINE.spec))
  w.files.set(`${DIR}/rows.json`, JSON.stringify(TIMELINE.data))
  w.files.set(`${DIR}/status.json`, JSON.stringify({ for: PROPOSAL.ts, state: 'built', attempt: 1, round: 1, fixed: ['x'], at: 0 }))
  // an earlier session left its row under main's answer d1
  w.files.set(`${CWD}/.thimble-cc-mod/signals.json`, signalsJson({ session: 'session-0', last: 'd1', seen: {}, rows: {}, views: { d1: ['timeline'] } }))
  const clock = mock.clock(on, { now: 1_790_000_000_000 })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await clock.advance(10)
  expect(await rowUnder($, 'd1')).toBe('↳ view · Timeline · built')
  const ui = (await $.ui.mount(TURN('d1') as never)) as unknown as M
  await ui.press({ key: 'view-signal:d1:timeline' })
  await ui.unmount()
  expect(w.opened).toEqual(['thimble'])
  let pane = (await $.ui.mount(PANE as never)) as unknown as M
  expect(textOf(await pane.drawn({ in: 'm:view:timeline' }))).toMatch(/Timeline/)
  await pane.unmount()
  // the views pane: the row's glyph says built, and `open` opens it
  expect(await listed($)).toMatch(/^❯ ● Timeline/)
  pane = (await $.ui.mount(PANE as never)) as unknown as M
  await pane.press({ key: 'vopen' })
  await pane.unmount()
  pane = (await $.ui.mount(PANE as never)) as unknown as M
  expect(await pane.find({ type: 'Client', key: 'm:view:timeline' })).toBeDefined()
  await pane.unmount()
})

// A builder or reviewer whose agent still runs is taken up again when the hooks reload (its status names it), and one
// that reports through SubagentHandback has its report taken as its answer, never delivered to main.
test('after a reload: the builder\'s end runs the checks and opens the view; the reviewer\'s handed-back report ends the build', async ($, on) => {
  const w = world(on)
  w.files.set(`${DIR}/status.json`, JSON.stringify({ for: PROPOSAL.ts, state: 'building', attempt: 1, round: 0, agent: 'agent-b', at: 0 }))
  w.agents.push({ id: 'agent-b', status: 'running', spawnedBy: 'thimble-cc-mod' })
  const clock = mock.clock(on, { now: 1_790_000_000_000 })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await clock.advance(10)
  expect(w.spawned.length).toBe(0)
  expect(await listed($)).toMatch(/◌ Timeline/)
  w.opened.length = 0
  w.checks.push({ exitCode: 0, stdout: 'index: 39 files in 0.4 s\nunread: 1 line the reader could not parse, such as agents.log#L38: x\nchecks passed' })
  await $.turn.complete({ turnId: 'b1', agentId: 'agent-b', answer: 'built', durationMs: 5, reason: 'answer' } as never)
  await clock.advance(1100)
  expect(w.runs.some(r => r[1]?.endsWith('/helper/viewpipe.py') && r[2] === 'check' && r[3] === 'timeline')).toBe(true)
  expect(w.opened).toContain('thimble')
  // main is told, out of sight, that the view is built but not ready: a note that waits for main's next prompt
  expect(waiting(w)).toHaveLength(1)
  expect(waiting(w)[0]).toContain('not ready')
  // the reviewer: given the drawings and the checks' notes (the kit gives it no id, so the build ends here)
  const review = w.spawned.find(x => x.description === 'view · reviewing Timeline')
  expect(review?.prompt).toContain('unread: 1 line')
  expect(review?.prompt).toContain('Timeline  60 events (all)')
  expect(w.files.get(`${DIR}/render.txt`)).toContain('66 columns wide')
  expect(status(w)).toMatchObject({ state: 'built', error: 'the review could not start: no id' })
})

const HANDBACK = [
  'Another Claude session sent a message:',
  '<agent-message from="agent-r">',
  '[Subagent hand-back] The text below is the final report of a subagent this session delegated to. The report follows:',
  '  {"problems": [',
  '  "Events, as it opens: no incident shows"]}',
  '</agent-message>',
].join('\n')

test('the problems a last review no longer names count as fixed, matched by their words, never more than it left out', () => {
  const asked = ['Pages, as it opens: the notes cells are cut at 96 columns.', 'The labels column counts named labels only.', 'Revisions: body bytes shows the length in characters.']
  // named again in other punctuation, or cut short, it is the same problem
  expect(fixedOf(asked, ['pages as it opens the notes cells are cut at 96 columns'])).toEqual(asked.slice(1))
  expect(fixedOf(asked, [])).toEqual(asked)
  // a problem it names in other words still counts against the fixed
  expect(fixedOf(asked, ['Something new.', 'Another.'])).toHaveLength(1)
})

test('a hand-back\'s sender and report are read from its envelope', () => {
  expect(handbackFrom({ kind: 'peer' }, HANDBACK)).toBe('agent-r')
  expect(handbackFrom({ kind: 'peer', from: 'x1' } as never, HANDBACK)).toBe('x1')
  expect(handbackFrom({ kind: 'task-notification' }, HANDBACK)).toBe(undefined)
  expect(parseFindings(handbackReport(HANDBACK))).toEqual(['Events, as it opens: no incident shows'])
})

// A fork reviewer's answer is its last message; main gets no notice, and when the review passes the view, one note
// main reads and the analyst does not see.
test('a reviewer that finds nothing ends the build: the view is ready, and main is told in a note it reads, not a prompt', async ($, on) => {
  const w = world(on)
  w.files.set(`${DIR}/view.json`, JSON.stringify(TIMELINE.spec))
  w.files.set(`${DIR}/rows.json`, JSON.stringify(TIMELINE.data))
  w.files.set(`${DIR}/status.json`, JSON.stringify({ for: PROPOSAL.ts, state: 'reviewing', attempt: 1, round: 1, agent: 'agent-r', at: 0 }))
  w.agents.push({ id: 'agent-r', status: 'running', spawnedBy: 'thimble-cc-mod' })
  const clock = mock.clock(on, { now: 1_790_000_000_000 })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.turn.complete({ turnId: 'r1', agentId: 'agent-r', answer: 'Nothing to fix.\n{"problems": []}', durationMs: 5, reason: 'answer' } as never)
  await clock.advance(1100)
  await clock.advance(10)
  expect(status(w)).toMatchObject({ state: 'built' })
  expect(w.spawned.length).toBe(0)
  // a note that waits for main's next prompt and goes with it, and no prompt to main
  expect(waiting(w)).toHaveLength(1)
  expect(w.context).toEqual([])
  await $.prompt.submit({ text: 'and now?', origin: { kind: 'composer' } } as never)
  expect(w.context.filter(c => c.includes('Timeline'))).toHaveLength(1)
  expect(waiting(w)).toEqual([])
})

// A general-purpose fallback hands its report back to main as a delivery that reaches only prompt.submit: the mod takes
// it there as the reviewer's answer and drops the prompt, so main gets no turn (Claude Code shows the drop as one line).
test('a fallback reviewer\'s hand-back is its answer and never a turn of main\'s: its problems go to a builder', async ($, on) => {
  const w = world(on)
  w.files.set(`${DIR}/view.json`, JSON.stringify(TIMELINE.spec))
  w.files.set(`${DIR}/rows.json`, JSON.stringify(TIMELINE.data))
  w.files.set(`${DIR}/status.json`, JSON.stringify({ for: PROPOSAL.ts, state: 'reviewing', attempt: 1, round: 0, agent: 'agent-r', at: 0 }))
  w.agents.push({ id: 'agent-r', status: 'running', spawnedBy: 'thimble-cc-mod' })
  const clock = mock.clock(on, { now: 1_790_000_000_000 })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  // the subagent's end comes first; its report reaches the session just after
  await $.turn.complete({ turnId: 'r1', agentId: 'agent-r', answer: '', durationMs: 5, reason: 'answer' } as never)
  const got = (await $.prompt.submit({ text: HANDBACK, origin: { kind: 'peer', from: 'agent-r' } } as never)) as { drop?: string }
  expect(got.drop).toBe('thimble-cc-mod: view · reviewing Timeline · reported')
  // another session's message passes
  expect(((await $.prompt.submit({ text: 'hello', origin: { kind: 'peer', from: 'someone-else' } } as never)) as { drop?: string }).drop).toBe(undefined)
  await clock.advance(1100)
  // the view as reviewed kept by the helper, and a builder (a fork) asked to fix the problem
  expect(w.runs.some(x => x[1]?.endsWith('/helper/viewpipe.py') && x[2] === 'keep' && x[3] === 'timeline')).toBe(true)
  const fix = w.spawned.find(x => x.description === 'view · building Timeline')
  expect(fix?.type).toBe('fork')
  expect(fix?.prompt).toContain('REVISE /corpus/ops/.thimble-cc-mod/views/timeline/render.txt\n1. Events, as it opens: no incident shows')
  // nothing was said beside a prompt to main, and no note: the view is not ready
  expect(w.context.join('\n')).not.toContain('Timeline')
  expect(waiting(w)).toEqual([])
})

test('the last revision\'s fixes go to a review that checks those problems alone; what it still finds is left, the rest fixed', async ($, on) => {
  const w = world(on)
  w.files.set(`${DIR}/status.json`, JSON.stringify({ for: PROPOSAL.ts, state: 'revising', attempt: 1, round: LAST_ROUND, asked: ['Pages: the notes are cut', 'Pages: labels counts named labels only'], fixed: ['a'], agent: 'agent-b', at: 0 }))
  w.agents.push({ id: 'agent-b', status: 'running', spawnedBy: 'thimble-cc-mod' })
  const clock = mock.clock(on, { now: 1_790_000_000_000 })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  w.checks.push({ exitCode: 0, stdout: 'checks passed' })
  await $.turn.complete({ turnId: 'b1', agentId: 'agent-b', answer: 'fixed both', durationMs: 5, reason: 'answer' } as never)
  await clock.advance(1100)
  const review = w.spawned.find(x => x.description === 'view · reviewing Timeline')
  expect(review?.prompt).toContain('## This review checks the last fixes')
  expect(review?.prompt).toContain('1. Pages: the notes are cut\n2. Pages: labels counts named labels only')
  expect(review?.prompt).toContain('Name nothing else')
})

test('the review of the last fixes ends the build: the problems it names are left, the others fixed, and main is told', async ($, on) => {
  const w = world(on)
  w.files.set(`${DIR}/view.json`, JSON.stringify(TIMELINE.spec))
  w.files.set(`${DIR}/rows.json`, JSON.stringify(TIMELINE.data))
  w.files.set(`${DIR}/status.json`, JSON.stringify({ for: PROPOSAL.ts, state: 'reviewing', attempt: 1, round: LAST_ROUND, asked: ['Pages: the notes are cut', 'Pages: labels counts named labels only'], fixed: ['a'], agent: 'agent-r', at: 0 }))
  w.agents.push({ id: 'agent-r', status: 'running', spawnedBy: 'thimble-cc-mod' })
  const clock = mock.clock(on, { now: 1_790_000_000_000 })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.turn.complete({ turnId: 'r1', agentId: 'agent-r', answer: '{"problems": ["Pages: labels counts named labels only"]}', durationMs: 5, reason: 'answer' } as never)
  await clock.advance(1100)
  expect(JSON.parse(w.files.get(`${DIR}/status.json`)!)).toMatchObject({ state: 'built', left: ['Pages: labels counts named labels only'], fixed: ['a', 'Pages: the notes are cut'], asked: [] })
  // no builder follows it
  expect(w.spawned).toEqual([])
  expect(waiting(w)[0]).toContain('Its review left 1 problem unfixed')
})

test('"ask for a change" on a built view starts a builder given the analyst\'s words; there is no "build again" or "review again"', async ($, on) => {
  const w = world(on)
  w.files.set(`${DIR}/proposal.json`, JSON.stringify({ ...PROPOSAL, build: false }))
  w.files.set(`${DIR}/view.json`, JSON.stringify(TIMELINE.spec))
  w.files.set(`${DIR}/rows.json`, JSON.stringify(TIMELINE.data))
  w.files.set(`${DIR}/status.json`, JSON.stringify({ for: PROPOSAL.ts, state: 'built', attempt: 1, round: 2, left: ['x'], at: 0 }))
  const clock = mock.clock(on, { now: 1_790_000_000_000 })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.command.run({ command: 'thimble-views', args: 'timeline' } as never)
  const pane = (await $.ui.mount(PANE as never)) as unknown as M
  const text = textOf(await pane.drawn())
  for (const x of ['open', 'ask for a change']) expect(text).toContain(x)
  for (const x of ['build again', 'review again', 'left', 'fixed']) expect(text).not.toContain(x)
  // the field's label is a dim word before it; the Input has no placeholder
  expect(((await pane.find({ key: 'vchange-timeline' })) as { props: Record<string, unknown> } | undefined)?.props.placeholder).toBeUndefined()
  await pane.input({ key: 'vchange-timeline', text: 'put the incidents on a lane of their own' })
  await pane.unmount()
  await clock.advance(10)
  expect(w.spawned[0]).toMatchObject({ description: 'view · building Timeline', type: 'fork' })
  expect(w.spawned[0]!.prompt).toContain('BUILD Timeline timeline')
  expect(w.spawned[0]!.prompt).toContain('CHANGE put the incidents on a lane of their own python3 ')
})

// tool.call does not reach a fork's tools: a subagent's Bash output is saved and noted from its rows instead, so its
// numbers cite its own commands
test("a subagent's Bash output is saved like main's, and the subagent is told how to cite its lines", async ($, on) => {
  const w = world(on)
  w.files.set(`${DIR}/status.json`, JSON.stringify({ for: PROPOSAL.ts, state: 'reviewing', attempt: 1, round: 1, agent: 'agent-r', at: 0 }))
  w.agents.push({ id: 'agent-r', status: 'running', spawnedBy: 'thimble-cc-mod' })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const row = (uuid: string, door: string, agentId: string, content: unknown[], type = 'user') =>
    $.session.append({ message: { type, role: type, content }, door, origin: { kind: 'model', model: 'm' }, uuid, agentId } as never).catch(() => undefined)
  await row('a1', 'response', 'agent-r', [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'wc -l labels.jsonl' } }], 'assistant')
  await row('a2', 'tool-result', 'agent-r', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '3104 labels.jsonl' }])
  const saved = [...w.files.entries()].filter(([k]) => k.startsWith(`${CWD}/.thimble-cc-mod/calls/`))
  expect(saved).toHaveLength(1)
  const call = JSON.parse(saved[0]![1]) as { id: string; command: string; output: string }
  expect(call).toMatchObject({ command: 'wc -l labels.jsonl', output: '3104 labels.jsonl' })
  // the row as kept: the output, then the note
  const kept = JSON.parse(w.notes.at(-1)!) as { content: { content: { text: string }[] }[] }
  expect(kept.content[0]!.content.map(b => b.text)).toEqual(['3104 labels.jsonl', `thimble-cc-mod: this output is call:${call.id}. To cite a line of it, write [[<value>|call:${call.id}#L<n>]], counting the output's lines from 1.`])
  // another subagent's rows are left as they are
  await row('b1', 'response', 'agent-x', [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'ls' } }], 'assistant')
  await row('b2', 'tool-result', 'agent-x', [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'a\nb' }])
  expect([...w.files.keys()].filter(k => k.startsWith(`${CWD}/.thimble-cc-mod/calls/`))).toHaveLength(1)
})

test('the views pane in a narrow panel: each row fits, its name cut before its status at R', async ($, on) => {
  const w = world(on)
  w.files.set(`${DIR}/proposal.json`, JSON.stringify({ ...PROPOSAL, name: 'Wiki Pages with a name long enough to be cut in a narrow panel', build: false }))
  w.files.set(`${DIR}/view.json`, JSON.stringify(TIMELINE.spec))
  w.files.set(`${DIR}/rows.json`, JSON.stringify(TIMELINE.data))
  w.files.set(`${DIR}/status.json`, JSON.stringify({ for: PROPOSAL.ts, state: 'built', attempt: 1, round: 2, left: ['a'], fixed: ['b'], at: 0 }))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.command.run({ command: 'thimble-views', args: 'timeline' } as never)
  for (const bodyColumns of [48, 96]) {
    const pane = (await $.ui.mount({ ...PANE, props: { bodyColumns, scroll: { bodyRows: 46 } } } as never)) as unknown as M
    const lines = await listLines(pane)
    await pane.unmount()
    // the rows take the type area and its margin
    for (const l of lines) expect(lineWidth(l)).toBeLessThanOrEqual(Math.max(40, bodyColumns) + 2)
    const row = plain(lines)
    expect(row).toMatch(/^❯ ! Wiki Pages/)
    expect(row).toMatch(/1 problem left, 1 fixed$/)
  }
})

test('a view built with problems left says so: no check mark; its status in the views pane says how many', async ($, on) => {
  const w = world(on)
  const left = Array.from({ length: 8 }, (_, i) => `problem ${i + 1}`)
  const fixed = Array.from({ length: 13 }, (_, i) => `fixed ${i + 1}`)
  w.files.set(`${DIR}/proposal.json`, JSON.stringify({ ...PROPOSAL, build: false }))
  w.files.set(`${DIR}/view.json`, JSON.stringify(TIMELINE.spec))
  w.files.set(`${DIR}/rows.json`, JSON.stringify(TIMELINE.data))
  w.files.set(`${DIR}/status.json`, JSON.stringify({ for: PROPOSAL.ts, state: 'built', attempt: 1, round: 2, fixed, left, at: 0 }))
  const clock = mock.clock(on, { now: 1_790_000_000_000 })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await clock.advance(10)
  const r = await $.command.run({ command: 'thimble-views', args: 'timeline' } as never)
  expect((r as { text?: string }).text).toBe('1 view built')
  const pane = (await $.ui.mount(PANE as never)) as unknown as M
  const row = plain(await listLines(pane))
  // its glyph says it works with problems left
  expect(row).toMatch(/^❯ ! Timeline +8 problems left, 13 fixed$/)
  // the pane lists no problem and no fix (views/SPEC.md, "The views pane")
  const text = textOf(await pane.drawn())
  expect(text).not.toContain('problem 1')
  expect(text).not.toContain('fixed 1')
  await pane.unmount()
})
