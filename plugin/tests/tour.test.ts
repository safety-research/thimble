// The feature tour (tour/tour.ts, skills/tour/SKILL.md): /thimble:tour or Claude's Skill call starts it. thimble
// places its intro, and the sample answer draws the step row at its end; thimble draws both itself and sends Claude no
// prompt. The steps: e, v, s, then cite. Each step done redraws the row in place. A tour started again keeps the
// earlier tour's rows. A step done early, a step whose feature is off and the selection step where no click reaches
// thimble are left out; v that drew no card lets the tour go on. Step e names its words in bold, and while it waits
// they shimmer in the sample answer, a band that moves at each tick of its own and stops with the step. Until the cite
// step's key, the sample answer draws its cited words as plain words and its check is held; c starts the check, and
// once every citation has its result the step is done, with what the check did, and the view goes to the step row. A
// tour that ends first leaves its sample answer's citations to be checked when opened. After the sample answer, the
// replies to the person's own prompts answer nothing, so s acts on the sample answer, and the step row is placed under
// the reply; a fork's end moves nothing. After an install inside Claude Code, the person's /reload-plugins runs
// /thimble:tour once in that session, soon after the install only. All data is made up. `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { remindAfterAnswer } from '../bar/hints'
import { failLineNow } from '../bar/notice'
import { noteViewport } from '../cards/draw'
import { answersNothing } from '../core/answers'
import { setOptions } from '../settings/features.mjs'
import { accent } from '../core/theme'
import { endCheck, noteRow, resumeChecks, startCheck } from '../marks/checker'
import { rowMarks } from '../marks/store'
import { checkedWords, DONE_MS, E_WORDS, NEXT_MS, placeIntro, SHIMMER_MS, shimmerSpans, stepRowEl, tourChecked, tourDid, tourHolds, tourKey, tourMissed, tourNow, tourRuns, tourSpans, tourStart, turnTour, type TourState } from '../tour/tour'
import { test } from './kit'
import { promptStub, tempRun } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** A made-up engine with what the tour reads: the session's state, the environment, the clock, and the rows it places. */
function fake() {
  const state = new Map<string, unknown>()
  const placed: string[] = []
  // the waits asked for, which the test runs itself
  const timers: { ms: number; fn: () => void }[] = []
  const $: Any = {
    state: {
      get: async (k: Any) => ({ value: state.get(JSON.stringify(k)), version: 0 }),
      set: async (k: Any, v: unknown) => { state.set(JSON.stringify(k), v); return { isSet: true, version: 1 } },
    },
    env: { get: async () => undefined },
    clock: { now: async () => 0, after: (ms: number, fn: () => void) => { timers.push({ ms, fn }); return { cancel() {} } } },
    config: { list: async () => [] },
    ui: { invalidate: () => undefined, place: async (a: Any) => { placed.push(a.id); return { isPlaced: true, requestId: a.id } } },
  }
  /** The waits asked for so far run, each once; the waits they ask for wait. */
  const tick = async () => {
    for (const t of timers.splice(0)) t.fn()
    await new Promise(r => setTimeout(r, 5))
  }
  return { $, placed, timers, tick }
}

/** The steps the tour waited for, in order, as each step is done. */
async function walk($: Any, steps: Any[]): Promise<string[]> {
  const at: string[] = []
  for (const s of steps) {
    await tourDid($, s)
    at.push((await tourNow($))?.at ?? 'end')
  }
  return at
}

test('each step done moves the tour to the next step that is on and not done; the intro is placed once per start', async () => {
  setOptions({})
  noteViewport({ isFullscreen: true })
  const { $, placed } = fake()
  await tourDid($, 'v')
  expect(await tourRuns($)).toBe(false)
  await tourStart($)
  await placeIntro($)
  // the command and the skill both start it: one start, one intro
  await tourStart($)
  await placeIntro($)
  expect(placed).toEqual(['tour-intro-1'])
  expect(await walk($, ['answer', 'e', 'e', 'v', 's', 'cite'])).toEqual(['e', 'v', 'v', 's', 'cite', 'end'])
  expect(await tourRuns($)).toBe(false)
  // a step done early is left out when its turn comes
  const b = fake()
  await tourStart(b.$)
  expect(await walk(b.$, ['answer', 's', 'v', 'e'])).toEqual(['e', 'e', 'e', 'cite'])
  // v that drew no card goes on, only while v waits
  await tourMissed(b.$, 'v')
  expect((await tourNow(b.$))?.at).toBe('cite')
  expect(await walk(b.$, ['cite'])).toEqual(['end'])
  // while v waits, v that drew no card goes on
  const c = fake()
  await tourStart(c.$)
  expect(await walk(c.$, ['answer', 'e'])).toEqual(['e', 'v'])
  await tourMissed(c.$, 'v')
  expect((await tourNow(c.$))?.at).toBe('s')
  expect((await tourNow(c.$))?.missed).toEqual(['v'])
})

test('where no click reaches thimble the selection step is left out; a feature that is off is left out', async () => {
  setOptions({})
  noteViewport({ isFullscreen: false })
  const { $ } = fake()
  await tourStart($)
  expect(await walk($, ['answer'])).toEqual(['v'])
  noteViewport({ isFullscreen: true })
  setOptions({ squeezeAnswers: false })
  const b = fake()
  await tourStart(b.$)
  expect(await walk(b.$, ['answer', 'e', 'v', 'cite'])).toEqual(['e', 'v', 'cite', 'end'])
  setOptions({ cards: 'off' })
  const c = fake()
  await tourStart(c.$)
  expect(await walk(c.$, ['answer', 'e', 's'])).toEqual(['e', 's', 'cite'])
  // the cite step introduces Claude's citations: with Citations manual or off, Claude cites nothing, and it is left out
  for (const citations of ['manual', 'off']) {
    setOptions({ citations })
    const d = fake()
    await tourStart(d.$)
    expect(await walk(d.$, ['answer', 'e', 'v', 's'])).toEqual(['e', 'v', 's', 'end'])
  }
  setOptions({})
})

test("while e waits its words shimmer in the sample answer: a band moves across them at each tick, and the tick stops once e is done or the tour ends", async () => {
  setOptions({})
  noteViewport({ isFullscreen: true })
  const { $, timers, tick } = fake()
  const text = 'Customers placed [36 orders](#). Most were loose-leaf tins, worth [$52](#). The shop refunded [7 orders](#).'
  const words = (s: Any[]) => s.map(x => text.slice(x.start, x.end)).join('')
  const band = (s: Any[]) => s.filter(x => x.look.color !== accent()).map(x => text.slice(x.start, x.end))
  await tourStart($)
  // the sample answer is not written yet: nothing shimmers, and no tick runs
  expect(await tourSpans($, 'row-sample', text)).toEqual([])
  expect(timers).toEqual([])
  await $.state.set({ plugin: 'thimble', key: 'tourSample' }, 'row-sample')
  await tourDid($, 'answer')
  expect((await tourNow($))?.at).toBe('e')
  // the words, whole, in runs of thimble's color; no other row's words
  const first = await tourSpans($, 'row-sample', text)
  expect(words(first)).toBe(E_WORDS)
  expect(first.every(x => !x.onPress && !x.look.backgroundColor && !x.look.underline)).toBe(true)
  expect(await tourSpans($, 'row-other', text)).toEqual([])
  // its tick, about 9 a second: one wait at a time, however often the answer draws
  expect(timers.map(t => t.ms)).toEqual([SHIMMER_MS])
  await tourSpans($, 'row-sample', text)
  expect(timers.length).toBe(1)
  // the band moves from one tick to the next
  const seen: string[] = []
  for (let i = 0; i < 16; i++) {
    await tick()
    seen.push(band(await tourSpans($, 'row-sample', text)).join('|'))
  }
  expect(new Set(seen).size).toBeGreaterThan(4)
  expect(seen.some(b => b.length > 0)).toBe(true)
  // e done: the shimmer goes, and the tick asks for no more waits
  await tourDid($, 'e')
  await tick()
  expect(timers).toEqual([])
  expect(await tourSpans($, 'row-sample', text)).toEqual([])
  // a tour that ends (a /clear) while e waits stops it too
  const b = fake()
  await tourStart(b.$)
  await b.$.state.set({ plugin: 'thimble', key: 'tourSample' }, 'row-sample')
  await tourDid(b.$, 'answer')
  expect((await tourSpans(b.$, 'row-sample', text)).length).toBeGreaterThan(0)
  await b.tick()
  expect(b.timers.length).toBe(1)
  await turnTour(b.$)
  await b.tick()
  expect(b.timers).toEqual([])
  expect(await tourSpans(b.$, 'row-sample', text)).toEqual([])
})

test('the shimmer is the words in thimble\'s color with a brighter band that enters before them, crosses them and leaves after them, then comes again', () => {
  const at = (f: number) => shimmerSpans(10, 19, f, '#e6d9ff').map(x => [x.start, x.end, x.look.color])
  // before it enters: the words whole, in thimble's color
  expect(at(0)).toEqual([[10, 29, accent()]])
  // entering, crossing, leaving
  expect(at(1)).toEqual([[10, 11, '#e6d9ff'], [11, 29, accent()]])
  expect(at(10)).toEqual([[10, 16, accent()], [16, 20, '#e6d9ff'], [20, 29, accent()]])
  expect(at(22)).toEqual([[10, 28, accent()], [28, 29, '#e6d9ff']])
  expect(at(23)).toEqual([[10, 29, accent()]])
  // a sweep, then a pause, then the next sweep
  expect(at(31 + 10)).toEqual(at(10))
  for (let f = 0; f < 31; f++) expect(at(f).map(r => (r[1] as number) - (r[0] as number)).reduce((a, b) => a + b, 0)).toBe(19)
})

test('until the cite step starts, the sample answer holds its citations: while it is written, then by its row; the hold ends with the step or the tour', async () => {
  setOptions({})
  noteViewport({ isFullscreen: true })
  const { $ } = fake()
  const turn = (id: string, startedAt: number, endedAt: number | null, rows: string[]) => Promise.all([
    $.state.set({ plugin: 'thimble', key: 'answerTurn', id }, { turnId: id, n: 1, prompt: { text: '', by: 'composer', row: null }, rows, answer: null, reason: null, startedAt, endedAt, labels: [], cards: [], seq: 0 }),
    ...rows.map(r => $.state.set({ plugin: 'thimble', key: 'answerRowTurn', id: r }, id)),
  ])
  expect(await tourHolds($, 'row-sample')).toBe(false)
  // an earlier answer, whose turn ended before the tour started, is not held
  await turn('t0', -10, -5, ['row-before'])
  await tourStart($)
  await turn('t1', 0, null, ['row-sample'])
  expect(await tourHolds($, 'row-before')).toBe(false)
  // the turn that writes the sample answer, and a row not kept yet
  expect(await tourHolds($, 'row-sample')).toBe(true)
  expect(await tourHolds($, 'row-streaming')).toBe(true)
  // once written, the sample answer alone
  await $.state.set({ plugin: 'thimble', key: 'tour' }, { ...(await tourNow($)), at: 'e', done: ['answer'], sample: 'row-sample' })
  expect(await tourHolds($, 'row-sample')).toBe(true)
  expect(await tourHolds($, 'row-streaming')).toBe(false)
  await walk($, ['e', 'v', 's'])
  expect((await tourNow($))?.at).toBe('cite')
  expect(await tourHolds($, 'row-sample')).toBe(true)
  // c started the check: held no more
  await $.state.set({ plugin: 'thimble', key: 'tour' }, { ...(await tourNow($)), checkAt: 5 })
  expect(await tourHolds($, 'row-sample')).toBe(false)
  // a tour that ends first holds nothing: its citations draw, and wait to be opened
  await $.state.set({ plugin: 'thimble', key: 'tour' }, { ...(await tourNow($)), checkAt: null })
  expect(await tourHolds($, 'row-sample')).toBe(true)
  await turnTour($)
  expect(await tourHolds($, 'row-sample')).toBe(false)
  // with Citations manual the tour has no cite step, and holds nothing
  setOptions({ citations: 'manual' })
  await tourStart($)
  expect(await tourHolds($, 'row-streaming')).toBe(false)
  setOptions({})
})

test('the cite step is done once each citation of the sample answer has its result, none waiting or checked; DONE_MS later the view goes to the step row', async () => {
  setOptions({})
  noteViewport({ isFullscreen: true })
  const { $, timers, tick } = fake()
  const scrolls: Any[] = []
  $.ui.scroll = async (a: Any) => { scrolls.push(a); return {} }
  const item = (n: number, status: string) => ({ n, row: 'row-sample', words: `${n}`, start: 0, end: 1, sentence: '', status, shown: `${n}` })
  const reply = async (statuses: string[], more: Any[] = []) => {
    await $.state.set({ plugin: 'thimble', key: 'marks', id: 'row-sample' }, { key: 'row-sample', turnId: 't1', rows: ['row-sample'], startedAt: 0, settledAt: null, items: [...statuses.map((s, i) => item(i + 1, s)), ...more] })
    await $.state.set({ plugin: 'thimble', key: 'marksRow', id: 'row-sample' }, 'row-sample')
  }
  await tourStart($)
  await $.state.set({ plugin: 'thimble', key: 'tourSample' }, 'row-sample')
  await $.state.set({ plugin: 'thimble', key: 'tour' }, { ...(await tourNow($)), sample: 'row-sample' })
  await walk($, ['answer', 'e', 'v', 's'])
  await reply(['deferred', 'deferred', 'deferred'])
  // before c, a check that ends (another answer's) is not the step
  await tourChecked($)
  expect((await tourNow($))?.at).toBe('cite')
  await $.state.set({ plugin: 'thimble', key: 'tour' }, { ...(await tourNow($)), checkAt: 5 })
  // one still checked, or one still waiting: not yet
  await reply(['verified', 'checking', 'corrected'])
  await tourChecked($)
  await reply(['verified', 'deferred', 'corrected'])
  await tourChecked($)
  expect((await tourNow($))?.at).toBe('cite')
  // each has its result. A narrowing changes no value, and words the person cited are none of Claude's numbers: the
  // count leaves both out
  await reply(['verified', 'failed', 'corrected'], [{ ...item(4, 'corrected'), narrowed: true }, { ...item(5, 'verified'), asked: true }])
  await tourChecked($)
  expect(await tourRuns($)).toBe(false)
  const t = parsed(await $.state.get({ plugin: 'thimble', key: 'tour' }))
  expect(t.done).toContain('cite')
  expect(t.checked).toEqual({ n: 4, corrected: 1, failed: 1 })
  expect(scrolls).toEqual([])
  expect(timers.map(x => x.ms)).toEqual([DONE_MS])
  await tick()
  expect(scrolls).toEqual([{ to: { key: `tour-row-${t.startedAt}-under` }, block: 'nearest' }])
})

/** A made-up engine for a check's run: versioned state, the checker's text, forks that start, and a validator that
 *  corrects the refunds to the 4 the data holds and verifies the other citations. */
function checking() {
  const state = new Map<string, { value: unknown; version: number }>()
  const spawned: Any[] = []
  const timers: { ms: number; fn: () => void }[] = []
  let now = 1000
  const validated = (req: Any) => ({ parsed: true, results: req.marks.map((m: Any) => (m.words === '7 orders'
    ? { n: m.n, status: 'corrected', shown: '4 orders', was: m.words, reason: 'The file lists 4 refunded orders.' }
    : { n: m.n, status: 'verified', shown: m.words, reason: 'counted' })) })
  const $: Any = {
    env: { get: async (k: string) => ({ THIMBLE_HOME: '/made-up/.thimble', TMPDIR: '/made-up/tmp' } as Any)[k] },
    plugin: { root: '/made-up/plugin', name: 'thimble' },
    session: { cwd: async () => '/made-up/data', id: async () => 's-tour', messages: async () => [] },
    fs: {
      read: async (p: string) => { if (p.endsWith('/prompts/checker.md')) return 'CHECK\n{{MARKS}}'; throw new Error(`no file ${p}`) },
      write: async () => undefined,
      list: async () => [],
      exists: async () => false,
      stat: async (p: string) => { throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${p}'`), { code: 'ENOENT' }) },
    },
    process: {
      run: async (argv: string[], o?: { stdin?: string }) => tempRun(argv)
        ?? (argv.includes('validate') && o?.stdin && JSON.parse(o.stdin).marks ? { exitCode: 0, stdout: JSON.stringify(validated(JSON.parse(o.stdin))), stderr: '' } : { exitCode: 0, stdout: '', stderr: '' }),
    },
    agent: { spawn: async (a: Any) => { spawned.push(a); return { model: 'claude-made-up', agentId: `agent-${spawned.length}` } }, list: async () => [] },
    state: {
      get: async (k: Any) => state.get(JSON.stringify(k)) ?? { value: undefined, version: 0 },
      set: async (k: Any, value: unknown, o?: { ifVersion?: number }) => {
        const cur = state.get(JSON.stringify(k))
        if (o?.ifVersion !== undefined && o.ifVersion !== (cur?.version ?? 0)) return { isSet: false, version: cur?.version ?? 0 }
        const version = (cur?.version ?? 0) + 1
        state.set(JSON.stringify(k), { value, version })
        return { isSet: true, version }
      },
    },
    clock: { now: async () => (now += 100), after: (ms: number, fn: () => void) => { timers.push({ ms, fn }); return { cancel() {} } }, every: () => ({ cancel() {} }), sleep: async () => undefined },
    config: { list: async () => [] },
    ui: { invalidate: () => undefined, place: async (a: Any) => ({ isPlaced: true, requestId: a.id }), scroll: async () => ({}) },
  }
  return { $, spawned, timers }
}

test("the sample answer's check is held until c: then each citation is checked at once, the wrong number lands corrected, and the cite step is done with what the check did", async () => {
  setOptions({ citations: 'auto cite + verify', cards: 'off', explain: 'off', squeezeAnswers: false })
  noteViewport({ isFullscreen: true })
  try {
    const { $, spawned } = checking()
    const text = 'Customers placed [36 orders](#) in March 2026. Most were loose-leaf tins, worth [$52](#). The shop refunded [7 orders](#).'
    const statuses = async () => ((await rowMarks($, 'row-sample'))?.items ?? []).map(m => `${m.shown}:${m.status}`)
    await tourStart($)
    // the turn that writes the sample answer ends: its check is held, its citations wait
    await noteRow($, 'row-sample', text)
    await startCheck($, { turnId: 't1', reason: 'answer' }, row => tourHolds($, row))
    expect(spawned).toEqual([])
    expect(await statuses()).toEqual(['36 orders:deferred', '$52:deferred', '7 orders:deferred'])
    // the tour goes on to its cite step (Explainers, Cards and Simplify off)
    await $.state.set({ plugin: 'thimble', key: 'tourSample' }, 'row-sample')
    await $.state.set({ plugin: 'thimble', key: 'tour' }, { ...(await tourNow($)), sample: 'row-sample' })
    await tourDid($, 'answer')
    expect((await tourNow($))?.at).toBe('cite')
    // a key other than c, or c with no tour on its cite step, is not taken
    expect(await tourKey($, 'x', 0)).toBeNull()
    // c: the check of every citation that waits, in one fork, and the citations held no more
    const take = (await tourKey($, 'c', 0))!
    await take.now!()
    await new Promise(r => setTimeout(r, 5))
    expect(spawned.map(a => a.description)).toEqual(['checking citations (c)'])
    expect(String(spawned[0].prompt)).toContain('[7 orders]')
    expect(await tourHolds($, 'row-sample')).toBe(false)
    expect(await statuses()).toEqual(['36 orders:checking', '$52:checking', '7 orders:checking'])
    // nothing waits now: c types
    expect(await tourKey($, 'c', 0)).toBeNull()
    // the check ends: each citation has its result, and the step is done with what the check did
    await endCheck($, { agentId: 'agent-1', reason: 'answer', answer: '```json\n[]\n```' })
    await tourChecked($)
    expect(await statuses()).toEqual(['36 orders:verified', '$52:verified', '4 orders:corrected'])
    expect(await tourRuns($)).toBe(false)
    const t = parsed(await $.state.get({ plugin: 'thimble', key: 'tour' }))
    expect(t.done).toEqual(['answer', 'cite'])
    expect(t.checked).toMatchObject({ n: 3, corrected: 1, failed: 0, fix: { was: '7 orders', now: '4 orders' } })
    expect(checkedWords(t.checked)).toBe('thimble checked 3 numbers and corrected 1: 7 orders → 4 orders.')
  } finally {
    setOptions({})
  }
})

test('the plugin reloads while the cite step\'s check runs, and its fork is gone: each citation gives up, which is its result, and the step is done', async () => {
  setOptions({ citations: 'auto cite + verify', cards: 'off', explain: 'off', squeezeAnswers: false })
  noteViewport({ isFullscreen: true })
  try {
    const { $ } = checking()
    await tourStart($)
    await noteRow($, 'row-sample', 'Customers placed [36 orders](#) in March 2026. The shop refunded [7 orders](#).')
    await startCheck($, { turnId: 't1', reason: 'answer' }, row => tourHolds($, row))
    await $.state.set({ plugin: 'thimble', key: 'tourSample' }, 'row-sample')
    await $.state.set({ plugin: 'thimble', key: 'tour' }, { ...(await tourNow($)), sample: 'row-sample' })
    await tourDid($, 'answer')
    await (await tourKey($, 'c', 0))!.now!()
    await new Promise(r => setTimeout(r, 5))
    expect((await tourNow($))?.at).toBe('cite')
    // at session start (marks/register.ts) the fork is gone (agent.list names none): its citations give up
    await resumeChecks($)
    await tourChecked($)
    expect(((await rowMarks($, 'row-sample'))?.items ?? []).map(m => m.status)).toEqual(['failed', 'failed'])
    expect(await tourRuns($)).toBe(false)
    expect(parsed(await $.state.get({ plugin: 'thimble', key: 'tour' })).checked).toEqual({ n: 2, corrected: 0, failed: 2 })
  } finally {
    setOptions({})
  }
})

/** The tour as the state holds it. */
const parsed = (r: Any): Any => r.value

/** Elements as plain objects, for reading what the step row draws. */
const els: Any = new Proxy({}, { get: (_t, type: string) => (props: Any) => ({ type, props }) })
const nodes = (n: Any, out: Any[] = []): Any[] => {
  if (!n || typeof n !== 'object') return out
  if (Array.isArray(n)) { n.forEach(x => nodes(x, out)); return out }
  out.push(n)
  nodes(n.props?.children, out)
  return out
}

test('the step row counts the steps it shows, names the words of e in bold and its keys in color, introduces citations last, and counts what the check did', () => {
  setOptions({})
  const at = (step: Any, done: Any[], o: Partial<TourState> = {}): TourState => ({ at: step, done, missed: [], startedAt: 0, k: 1, intro: null, sample: 'row-sample', moved: null, ...o })
  const row = (t: TourState, clicks = true) => stepRowEl(els, t, clicks, 100)
  // e waits: its words bold, in the default color; its key in thimble's color; the line itself not bold
  const e = row(at('e', ['answer']))
  expect(textOf(e)).toContain('thimble tour · 1 of 4')
  expect(textOf(e)).toContain('› Highlight loose-leaf tins in the answer above, then press e.')
  const bold = nodes(e).find(n => n.type === 'Text' && n.props?.children === 'loose-leaf tins')
  expect(bold?.props).toMatchObject({ bold: true })
  expect(bold?.props?.color).toBeUndefined()
  expect(nodes(e).find(n => n.type === 'Text' && n.props?.children === 'e')?.props).toMatchObject({ bold: true })
  expect(nodes(e).find(n => n.props?.key === 'a-e')?.props?.bold).toBeUndefined()
  // v waits: 2 of 4; without clicks there is no e, so 1 of 3
  expect(textOf(row(at('v', ['answer', 'e'])))).toContain('thimble tour · 2 of 4')
  expect(textOf(row(at('v', ['answer']), false))).toContain('thimble tour · 1 of 3')
  // s, then cite last: it introduces citations and names c, with clicks and without
  expect(textOf(row(at('s', ['answer', 'e', 'v'])))).toContain('› Press s for a shorter, plainer version of the tea shop answer.')
  const cite = textOf(row(at('cite', ['answer', 'e', 'v', 's'])))
  expect(cite).toContain('thimble tour · 4 of 4')
  expect(cite).toContain('✓ s wrote a simpler version.')
  expect(cite).toContain('› Last, citations: Claude marks each number it states, and thimble checks it against the data. Press c to watch thimble check the tea shop answer.')
  expect(textOf(row(at('cite', ['answer', 'v', 's']), false))).toContain('Press c to watch thimble check the tea shop answer.')
  expect(nodes(row(at('cite', ['answer', 'e', 'v', 's']))).find(n => n.type === 'Text' && n.props?.children === 'c')?.props).toMatchObject({ bold: true })
  // while its check runs
  expect(textOf(row(at('cite', ['answer', 'e', 'v', 's'], { checkAt: 5 })))).toContain('› thimble is checking each number of the tea shop answer against the data.')
  // done: what the check did, then the end
  const end = textOf(row(at('end', ['answer', 'e', 'v', 's', 'cite'], { checkAt: 5, checked: { n: 6, corrected: 1, failed: 0 } })))
  expect(end).toContain('thimble tour · done')
  expect(end).toContain('✓ thimble checked 6 numbers and corrected 1.')
  expect(end.indexOf('The tour is over.')).toBeGreaterThan(end.indexOf('corrected 1.'))
  expect(end).not.toContain('side thread')
  // v that drew no card
  const missed = textOf(row(at('s', ['answer', 'e', 'v'], { missed: ['v'] })))
  expect(missed).toContain('thimble tour · 3 of 4')
  expect(missed).toContain('✓ v drew no card this time.')
})

test('what the check did, in words', () => {
  expect(checkedWords({ n: 6, corrected: 1, failed: 0 })).toBe('thimble checked 6 numbers and corrected 1.')
  expect(checkedWords({ n: 6, corrected: 1, failed: 0, fix: { was: '7 orders', now: '4 orders' } })).toBe('thimble checked 6 numbers and corrected 1: 7 orders → 4 orders.')
  expect(checkedWords({ n: 6, corrected: 1, failed: 2 })).toBe('thimble checked 6 numbers, corrected 1 and could not confirm 2.')
  expect(checkedWords({ n: 6, corrected: 0, failed: 1 })).toBe('thimble checked 6 numbers and could not confirm 1.')
  expect(checkedWords({ n: 6, corrected: 0, failed: 0 })).toBe('thimble checked 6 numbers and found each right.')
  expect(checkedWords({ n: 1, corrected: 0, failed: 0 })).toBe('thimble checked 1 number and found it right.')
})

test('no reminder shows while the tour runs; answers are held after the sample answer; a /clear ends the tour', async () => {
  setOptions({ explain: 'on demand' })
  const { $ } = fake()
  $.clock.after = () => ({ cancel() {} })
  await tourStart($)
  await remindAfterAnswer($)
  expect(await failLineNow($)).toBeNull()
  expect(await answersNothing($, 't-mine')).toBe(false)
  await tourDid($, 'answer')
  expect(await answersNothing($, 't-mine')).toBe(true)
  await turnTour($)
  expect(await tourRuns($)).toBe(false)
  expect(await answersNothing($, 't-mine')).toBe(false)
  await remindAfterAnswer($)
  expect((await failLineNow($))?.text).toContain('press e')
  setOptions({})
})

const NO_FILES = (on: Any, files: Record<string, string> = {}) => {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp', PATH: '/usr/bin' })
  on('session.id', () => ({ value: 's-tour' }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('session.messages', () => ({ value: [] }))
  on('fs.read', (_$: unknown, e: { path: string }) => (e.path in files ? { value: files[e.path] } : { value: promptStub(e.path) ?? '' }))
  on('fs.write', (_$: unknown, e: { path: string; text: string }) => { files[e.path] = e.text; return { value: undefined } })
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', () => ({ value: { kind: 'missing', size: 0 } }))
  on('env.set', () => ({ value: {} }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.scroll', () => ({ value: undefined }))
  on('prompt.change', (_$: unknown, e: Any) => ({ text: e.text, cursor: e.cursor }))
  on('model.fork', () => ({ value: { isAnswered: true, text: '{}' } }))
  on('ui.panes', () => ({ value: [] }) as never)
  on('config.list', () => ({ value: [] }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  on('turn.start', (_$: unknown, e: Any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: unknown, e: Any) => ({ text: e.answer }))
  // Claude Code's own drawing of a row: its words
  on('ui.render', (_$: unknown, e: Any) => ({ type: 'Text', props: {}, children: [String(e.props?.text ?? 'the engine')] }) as never)
}

const SAMPLE = 'Customers placed [36 orders](#) in March 2026. The shop refunded [7 orders](#). Most of the refunded orders arrived on time, so late delivery does not explain the refunds.'

function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + textOf(n.children)
}

/** A session where the tour runs through the whole hooks module: the prompts that reach Claude, the rows placed,
 *  Simplify's calls, the forks asked for, and a turn of main's. A key thimble does not take is typed into the box, as
 *  Claude Code types it. (This kit's spawns name no agent, so a check's run is tested on a made-up engine.) */
async function session($: Any, on: Any, files: Record<string, string> = {}) {
  NO_FILES(on, files)
  const clock = mock.clock(on, { now: 0 })
  const got: { text: string; by: string }[] = []
  const placed: string[] = []
  const ran: Any[] = []
  const asked: Any[] = []
  const spawns: Any[] = []
  on('agent.spawn', (_$: unknown, e: Any) => { spawns.push(e); return { model: 'claude-made-up', agentId: `agent-${spawns.length}` } as never })
  on('agent.list', () => ({ value: [] }))
  on('process.run', (_$: unknown, e: { argv: string[] }) => ({ value: { ...(tempRun(e.argv) ?? { exitCode: 0, stdout: '', stderr: '' }), isStdoutTruncated: false, isStderrTruncated: false } }))
  on('prompt.submit', (_$: unknown, e: Any) => { got.push({ text: String(e.text), by: String(e.origin?.kind ?? '') }); return { text: e.text } })
  on('prompt.edit', (_$: unknown, e: Any) => ({ text: `${e.text.slice(0, e.start)}${e.inputText ?? ''}${e.text.slice(e.end)}`, cursor: e.start + String(e.inputText ?? '').length }) as never)
  on('prompt.fill', () => ({ isFilled: true }) as never)
  on('ui.place', (_$: unknown, e: Any) => { placed.push(e.id); return { value: { isPlaced: true, requestId: `r-${e.id}` } } })
  on('command.run', (_$: unknown, e: Any) => { ran.push(e); return {} as never })
  on('model.complete', async (_$: unknown, e: Any) => { asked.push(e); return { value: { isAnswered: true, text: '<text>\nThe shop refunded a few orders.\n</text>', usage: {} } } })
  on('tool.call', (_$: unknown, e: Any) => ({ result: `ran ${e.tool}` }))
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  const turn = async (id: string, text: string, answer: string, during?: () => Promise<unknown>) => {
    await $.turn.start({ text, turnId: id } as never)
    if (during) await during()
    await $.session.append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: answer }] }, door: 'response', origin: { kind: 'model', model: 'claude-made-up' }, uuid: `row-${id}` } as never)
    await $.turn.complete({ turnId: id, reason: 'answer', answer, durationMs: 10, isAborted: false } as never)
    await clock.advance(100)
  }
  const row = async (id: string) => textOf(await $.ui.render({ plugin: 'thimble', component: 'Placed', surface: 'terminal', requestId: `r-${id}`, viewport: { columns: 100, rows: 60, isFullscreen: true }, props: { id, plugin: 'thimble' } } as never))
  const answer = async (id: string, text: string) => textOf(await $.ui.render({ plugin: 'thimble', component: 'AssistantMessage', surface: 'terminal', requestId: id, viewport: { columns: 100, rows: 60, isFullscreen: true }, props: { text, isFirstOfReply: true } } as never))
  const ask = (text: string) => $.prompt.submit({ text, origin: { kind: 'composer' } } as never)
  const press = async (k: string) => { const r = await $.prompt.edit({ origin: { kind: 'composer' }, key: { key: k }, text: '', cursor: 0, start: 0, end: 0, inputText: k } as never); await clock.advance(400); return r }
  return { clock, got, placed, ran, asked, spawns, turn, row, answer, ask, press }
}

test("in a session: thimble draws the intro and the step row under the sample answer, sends Claude nothing, places the row under a reply, s simplifies the sample answer, and a second tour keeps the first one's rows", { options: { cards: 'off', explain: 'off', citations: 'off' } }, async ($, on) => {
  noteViewport({ isFullscreen: true })
  const t = await session($, on)
  const tour = () => $.prompt.submit({ text: '/thimble:tour', command: { name: 'thimble:tour', args: '' }, origin: { kind: 'composer' } } as never)
  await tour()
  expect(t.placed).toEqual(['tour-intro-1'])
  expect(await t.row('tour-intro-1')).toContain('One number in it is wrong on purpose.')
  await t.turn('t1', '<command-name>/thimble:tour</command-name>', SAMPLE)
  // Cards, Explainers and Citations are off: the one step is s. The sample answer draws the row at its end
  expect(t.placed).toEqual(['tour-intro-1'])
  const first = await t.answer('row-t1', SAMPLE)
  expect(first.indexOf('thimble tour · 1 of 1')).toBeGreaterThan(first.indexOf('late delivery'))
  expect(first).toContain('Press s for a shorter, plainer version of the tea shop answer.')
  // a fork's turn ends (a side thread's answer, say): it is no turn of main's, and the row stays under the sample answer
  await $.turn.complete({ turnId: 'f1', agentId: 'agent-made-up', reason: 'answer', answer: 'A side answer.', durationMs: 10, isAborted: false } as never)
  expect(t.placed).toEqual(['tour-intro-1'])
  expect(await t.answer('row-t1', SAMPLE)).toContain('thimble tour · 1 of 1')
  // the person's own question: Claude answers it, and the row is placed under the reply instead
  await t.ask('What does s do?')
  await t.turn('t2', 'What does s do?', 'It writes a simpler version of the answer.')
  expect(t.placed).toEqual(['tour-intro-1', 'tour-step-2'])
  expect(await t.answer('row-t1', SAMPLE)).not.toContain('thimble tour')
  expect(await t.answer('row-t2', 'It writes a simpler version of the answer.')).not.toContain('thimble tour')
  // the reply is no answer: s simplifies the sample answer
  await t.press('s')
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(1)
  expect(String(t.asked[0].prompt)).toContain('late delivery does not explain the refunds')
  expect(String(t.asked[0].prompt)).not.toContain('It writes a simpler version')
  const end = await t.row('tour-step-2')
  expect(end).toContain('thimble tour · done')
  expect(end).toContain('✓ s wrote a simpler version.')
  expect(end).toContain('Type /thimble:tour to take the tour again.')
  // the tour sends Claude no prompt of its own
  expect(t.got.filter(p => p.by === 'plugin')).toEqual([])
  // the tour again: a new intro, and the first tour's rows still draw it
  await t.clock.advance(20_000)
  await tour()
  expect(t.placed).toEqual(['tour-intro-1', 'tour-step-2', 'tour-intro-3'])
  expect(await t.row('tour-intro-1')).toContain('One number in it is wrong on purpose.')
  expect(await t.row('tour-step-2')).toContain('thimble tour · done')
})

test("in a session: Claude's Skill call starts the tour, and the turn that called it holds the sample answer", { options: { cards: 'off', explain: 'off', citations: 'off', squeezeAnswers: false } }, async ($, on) => {
  noteViewport({ isFullscreen: true })
  const t = await session($, on)
  await t.ask('Yes, show me the tour.')
  await t.turn('t1', 'Yes, show me the tour.', SAMPLE, () => $.tool.call({ tool: 'Skill', skill: 'thimble:tour', tool_use_id: 'toolu_made_up_1' } as never))
  // with every step's feature off, the sample answer goes on to the end
  expect(t.placed).toEqual(['tour-intro-1'])
  expect(await t.answer('row-t1', SAMPLE)).toContain('The tour is over.')
})

/** Whether an answer's drawing shows citations: their presses, which open them. */
function citesIn(drawn: Any): number {
  const all = (n: Any, out: Any[] = []): Any[] => {
    if (!n || typeof n !== 'object') return out
    if (Array.isArray(n)) { n.forEach(x => all(x, out)); return out }
    out.push(n)
    all(n.props?.children, out)
    all(n.children, out)
    return out
  }
  return new Set(all(drawn).filter(n => n.type === 'Button' && /^citation \d/.test(String(n.props?.label ?? ''))).map(n => n.props.label)).size
}
const CITE_ONLY = { options: { cards: 'off', explain: 'off', squeezeAnswers: false, citations: 'auto cite + verify' } }
const drawnAnswer = ($: Any, id: string, text: string) => $.ui.render({ plugin: 'thimble', component: 'AssistantMessage', surface: 'terminal', requestId: id, viewport: { columns: 100, rows: 60, isFullscreen: true }, props: { text, isFirstOfReply: true } } as never)

test('in a session: the sample answer shows no citation and its check waits until the cite step; c asks for the check of every citation, and the citations show', CITE_ONLY, async ($, on) => {
  noteViewport({ isFullscreen: true })
  const t = await session($, on)
  await $.prompt.submit({ text: '/thimble:tour', command: { name: 'thimble:tour', args: '' }, origin: { kind: 'composer' } } as never)
  await t.turn('t1', '<command-name>/thimble:tour</command-name>', SAMPLE)
  // Citations checks each answer, but not this one yet: no check, and its cited words are plain words
  expect(t.spawns).toEqual([])
  const before = await drawnAnswer($, 'row-t1', SAMPLE)
  expect(citesIn(before)).toBe(0)
  expect(textOf(before)).toContain('The shop refunded 7 orders.')
  expect(textOf(before)).not.toContain('](#)')
  // the one step on: cite, last, which introduces citations and names c
  expect(textOf(before)).toContain('thimble tour · 1 of 1')
  expect(textOf(before)).toContain('Last, citations: Claude marks each number it states, and thimble checks it against the data. Press c to watch thimble check the tea shop answer.')
  // c: the check of every citation is asked for, once the key's word window has passed, and the citations show
  expect(await t.press('c')).toEqual({ text: '', cursor: 0 })
  expect(t.spawns.map(e => e.description)).toEqual(['checking citations (c)'])
  const checking = await drawnAnswer($, 'row-t1', SAMPLE)
  expect(citesIn(checking)).toBe(2)
  expect(textOf(checking)).toContain('thimble is checking each number of the tea shop answer against the data.')
})

test('in a session: before the cite step, c on words selected in the sample answer cites nothing: it is typed, and no check starts', { options: { cards: 'off', squeezeAnswers: false, citations: 'auto cite + verify' } }, async ($, on) => {
  noteViewport({ isFullscreen: true })
  on('ui.selection', () => ({ value: { text: '7 orders', requestId: 'row-t1' } }) as never)
  const t = await session($, on)
  await $.prompt.submit({ text: '/thimble:tour', command: { name: 'thimble:tour', args: '' }, origin: { kind: 'composer' } } as never)
  await t.turn('t1', '<command-name>/thimble:tour</command-name>', SAMPLE)
  expect(textOf(await drawnAnswer($, 'row-t1', SAMPLE))).toContain('Highlight loose-leaf tins in the answer above, then press e.')
  expect(await t.press('c')).toEqual({ text: 'c', cursor: 1 })
  await t.clock.advance(1000)
  expect(t.spawns).toEqual([])
  expect(citesIn(await drawnAnswer($, 'row-t1', SAMPLE))).toBe(0)
})

test('in a session: a click on the cite step\'s line does what c does', CITE_ONLY, async ($, on) => {
  noteViewport({ isFullscreen: true })
  const t = await session($, on)
  await $.prompt.submit({ text: '/thimble:tour', command: { name: 'thimble:tour', args: '' }, origin: { kind: 'composer' } } as never)
  await t.turn('t1', '<command-name>/thimble:tour</command-name>', SAMPLE)
  const ui = await $.ui.mount({ plugin: 'thimble', component: 'AssistantMessage', surface: 'terminal', requestId: 'row-t1', viewport: { columns: 100, rows: 60, isFullscreen: true }, props: { text: SAMPLE, isFirstOfReply: true } } as never)
  await ui.press({ key: 'tour-check' })
  await ui.unmount()
  await t.clock.advance(100)
  expect(t.spawns.map(e => e.description)).toEqual(['checking citations (c)'])
  expect(textOf(await t.answer('row-t1', SAMPLE))).toContain('thimble is checking each number of the tea shop answer against the data.')
})

test('in a session: c then a letter is a word, and the check is not asked for; a tour started again before its cite step leaves the earlier sample answer with its citations, which open and are checked', CITE_ONLY, async ($, on) => {
  noteViewport({ isFullscreen: true })
  const t = await session($, on)
  const tour = () => $.prompt.submit({ text: '/thimble:tour', command: { name: 'thimble:tour', args: '' }, origin: { kind: 'composer' } } as never)
  await tour()
  await t.turn('t1', '<command-name>/thimble:tour</command-name>', SAMPLE)
  // c, then a letter: the person types a word
  await $.prompt.edit({ origin: { kind: 'composer' }, key: { key: 'c' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'c' } as never)
  expect(await $.prompt.edit({ origin: { kind: 'composer' }, key: { key: 'a' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'a' } as never)).toEqual({ text: 'ca', cursor: 2 })
  await t.clock.advance(1000)
  expect(t.spawns).toEqual([])
  expect(citesIn(await drawnAnswer($, 'row-t1', SAMPLE))).toBe(0)
  expect(textOf(await drawnAnswer($, 'row-t1', SAMPLE))).toContain('Press c to watch thimble check the tea shop answer.')
  // the tour again: the first sample answer is held no more, its citations wait to be checked when opened
  await t.clock.advance(20_000)
  await tour()
  expect(citesIn(await drawnAnswer($, 'row-t1', SAMPLE))).toBe(2)
  const spawned = t.spawns.length
  expect(await t.press(']')).toEqual({ text: '', cursor: 0 })
  expect(t.spawns.slice(spawned).map(e => e.description)).toEqual(['checking a citation'])
})

test("the person's /reload-plugins soon after an install in this session runs /thimble:tour once; a later one, or another session's, does not", async ($, on) => {
  const file = '/made-up/.thimble/tour-next'
  const files: Record<string, string> = { [file]: 's-tour 0\n' }
  const t = await session($, on, files)
  // thimble loads at the reload
  await t.clock.advance(1000)
  expect(t.ran.map(e => e.command)).toEqual(['thimble:tour'])
  expect(files[file]).toBe('')
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  await t.clock.advance(1000)
  expect(t.ran.length).toBe(1)
  // thimble was loaded already: it hears the reload end
  files[file] = 's-tour 2'
  await $.command.run({ command: 'reload-plugins', args: '' } as never)
  await t.clock.advance(1000)
  expect(t.ran.map(e => e.command)).toEqual(['thimble:tour', 'reload-plugins', 'thimble:tour'])
  // a file from long ago (a session resumed later) starts nothing, and is emptied
  await t.clock.advance(NEXT_MS)
  files[file] = 's-tour 1'
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  await t.clock.advance(1000)
  expect(files[file]).toBe('')
  files[file] = `s-another ${Math.floor((NEXT_MS + 4000) / 1000)}`
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  await t.clock.advance(1000)
  expect(t.ran.length).toBe(3)
})
