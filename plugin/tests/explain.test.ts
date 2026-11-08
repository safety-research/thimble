// The explainers and heads-ups (explain/): after the observer's look, each stands on its words in the answer as a
// press, in the theme's teal and orange; e explains the words selected in an answer, and with Citations manual, c makes
// them a citation. While the tour waits for its selection step, the explainer shown is that step done. Until the tour's
// cite step, an explainer's links are words and c cites nothing. After a tour, a link to its orders.csv opens the
// plugin's copy of the file.
// All data is made up. `claude plugin test plugin`.
import { expect } from 'claude-code/testing'

import { partOf, registerAnswers, resetAnswers } from '../core/answers'
import { spansFor } from '../core/answerview'
import { resetEngaged } from '../core/engaged'
import { registerTell } from '../core/tell'
import { registerTurn } from '../core/turn'
import { resetTheme } from '../core/theme'
import { failLineNow } from '../bar/notice'
import { explainBar, explainKey, registerExplain, explainState, resetExplain, type ExplainPart } from '../explain/seam'
import { placeLines } from '../explain/expand'
import { trayKey, trayNow } from '../tray/tray'
import { readText, withAsked } from '../marks/message.js'
import { rowMarks } from '../marks/store'
import { citeBar, citeKey, citeWords } from '../marks/cite'
import { drainNow, registerObserver, resetObserver } from '../observer/observer'
import { setOptions } from '../settings/features.mjs'
import { noteViewport } from '../cards/draw'
import { tourDid, tourHoldsCites, tourNow, tourStart } from '../tour/tour'
import { promptStub, tempRun } from './stubs'
import { test } from './kit'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function setup(replies: Any[], o: { complete?: Any } = {}) {
  resetAnswers()
  resetObserver()
  resetExplain()
  resetEngaged()
  resetTheme()
  const hooks: Record<string, Any[]> = {}
  const on: Any = (event: string, a: Any, b?: Any) => {
    ;(hooks[event] ??= []).push(typeof a === 'function' ? a : b)
    return { catch: () => undefined }
  }
  registerTurn(on, {} as never)
  registerTell(on, {} as never)
  registerAnswers(on, {} as never)
  registerObserver(on, {} as never)
  registerExplain(on, {} as never)
  const state = new Map<string, { value: unknown; version: number }>()
  const files = new Map<string, string>()
  const calls: Any[] = []
  let now = 1000
  const $: Any = {
    env: { get: async (k: string) => ({ THIMBLE_HOME: '/made-up/.thimble', TMPDIR: '/made-up/tmp', THIMBLE_START: '/made-up/data' } as Any)[k] },
    plugin: { root: '/made-up/plugin', name: 'thimble' },
    session: { id: async () => 's-explain', cwd: async () => '/made-up/data', root: async () => '/made-up/data', messages: async () => [] },
    config: { list: async () => [{ key: 'theme', value: 'dark' }] },
    ui: { invalidate: () => undefined },
    fs: {
      read: async (p: string) => { const t = promptStub(p); if (t !== undefined) return t; if (files.has(p)) return files.get(p); throw new Error(`no file ${p}`) },
      write: async (p: string, text: string) => { files.set(p, text) },
      list: async () => [],
      exists: async () => false,
      stat: async () => ({ kind: 'missing', size: 0 }),
    },
    process: { run: async (argv: string[]) => tempRun(argv) ?? { exitCode: 0, stdout: 'Claude read 3 of 7 files.', stderr: '' } },
    model: {
      // the look's fork takes the replies in turn; an explainer asked for is a fork too (o.complete answers it)
      fork: async (r: Any) => {
        if (!/^PROMPT explain-expand/.test(String(r?.prompt ?? ''))) return replies.shift() ?? { isAnswered: false, reason: 'empty-reply' }
        calls.push(r)
        return o.complete ?? { isAnswered: false, reason: 'empty-reply' }
      },
      complete: async (r: Any) => { calls.push({ ...r, side: true }); return o.complete ?? { isAnswered: false, reason: 'empty-reply' } },
    },
    state: {
      get: async (k: Any) => state.get(JSON.stringify(k)) ?? { value: undefined, version: 0 },
      set: async (k: Any, value: unknown, x?: { ifVersion?: number }) => {
        const cur = state.get(JSON.stringify(k))
        if (x?.ifVersion !== undefined && x.ifVersion !== (cur?.version ?? 0)) return { isSet: false, version: cur?.version ?? 0 }
        const version = (cur?.version ?? 0) + 1
        state.set(JSON.stringify(k), { value, version })
        return { isSet: true, version }
      },
    },
    clock: { now: async () => (now += 100), after: (ms: number, fn: () => void) => { if (ms >= 1000) setTimeout(fn, 1); return { cancel() {} } } },
  }
  const call = (event: string, e: Any, last: (e: Any) => Any = async (x: Any) => x) => {
    const chain = hooks[event] ?? []
    const at = (i: number): ((e: Any) => Promise<Any>) => async (x: Any) => (i < chain.length ? chain[i]($, x, at(i + 1)) : last(x))
    return at(0)(e)
  }
  return { $, call, files, calls }
}

const settle = () => new Promise(r => setTimeout(r, 5))

async function answered(s: ReturnType<typeof setup>, o: { id: string; prompt: string; text: string }) {
  await s.call('session.start', { cwd: '/made-up/data', isInteractive: true }, async () => ({}))
  await s.call('prompt.submit', { text: o.prompt, origin: { kind: 'composer' } })
  await s.call('turn.start', { text: o.prompt, turnId: o.id })
  await s.call('session.append', { door: 'response', message: { type: 'assistant', content: [{ type: 'text', text: o.text }] } }, async () => ({ uuid: `${o.id}-row` }))
  await s.call('turn.complete', { turnId: o.id, reason: 'answer', answer: o.text }, async () => ({ text: '' }))
  await settle()
  await drainNow(s.$)
  await settle()
}

const reply = (d: Any) => ({ isAnswered: true, text: JSON.stringify(d), usage: { input_tokens: 10, output_tokens: 5 } })
const ANSWER = 'Uploads fail after the retry budget runs out: [41 of the 44](#) failures came 30 seconds after a drop.'
const LOOK = reply({
  glosses: [{ term: 'retry budget', body: 'How many times the client tries again.', here: '[upload.py allows five tries](client/upload.py#L3-4).' }, { term: 'not in the answer', body: 'x' }],
  heads: { term: '30 seconds after a drop', title: 'Only one network', bullets: ['[The log covers one office](logs/upload.log).'] },
})

test("after a look, the answer's explainer and heads-up stand on their words in the theme's teal and orange, and the digest knows them", async () => {
  setOptions({})
  const s = setup([LOOK])
  await answered(s, { id: 't1', prompt: 'Why do uploads fail?', text: ANSWER })
  const part = await partOf<ExplainPart>(s.$, 't1-row', 'explain')
  expect(part!.order).toEqual(['h1', 'g1'])
  expect(part!.items.g1).toMatchObject({ term: 'retry budget', body: 'How many times the client tries again.' })
  expect(part!.items.h1).toMatchObject({ kind: 'heads', title: 'Only one network' })
  const spans = await spansFor(s.$, 't1-row', ANSWER, [{ start: 57, end: 75, words: '41 of the 44' }])
  expect(spans.map(x => ANSWER.slice(x.start, x.end))).toEqual(['retry budget', '30 seconds after a drop'])
  // a highlight: a fill behind the words, teal for an explainer, orange for a heads-up, the words in the theme's text color
  expect(spans[0]!.look).toEqual({ backgroundColor: '#1e4d47', hoverBg: '#2b7068' })
  expect(spans[1]!.look).toEqual({ backgroundColor: '#5c3a17', hoverBg: '#80521f' })
  expect(spans[1]!.focus).toEqual({ bold: true, backgroundColor: '#80521f' })
  expect(spans[0]!.label).toBe('explain retry budget')
  expect(await explainState(s.$)).toEqual({ glossed: ['retry budget'], headsGiven: ['Only one network'] })
  expect(JSON.parse(s.files.get('/made-up/.thimble/conversations/s-explain/explain.json')!)).toEqual({ glossed: ['retry budget'], headsGiven: ['Only one network'] })
})

/** e at an empty prompt with this selection (Claude Code's $.ui.selection), its explainer written and the tray open. */
async function pressE(s: ReturnType<typeof setup>, selection: Any) {
  s.$.ui.selection = async () => selection
  s.$.ui.open = async () => ({ isPlaced: true })
  const take = await explainKey(s.$, 'e', 0)
  expect(take?.later).toBeDefined()
  await take!.later!()
  await settle()
}

test('e explains the words selected in an answer, on the row the selection lies in, and opens them in the tray; the bar names it', async () => {
  setOptions({})
  const s = setup([LOOK], { complete: reply({ body: 'The client gives up on an upload.', here: '' }) })
  // no answer yet: e is typed, and the bar names no key
  expect(await explainKey(s.$, 'e', 0)).toBe(null)
  await answered(s, { id: 't1', prompt: 'Why do uploads fail?', text: `${ANSWER} Then the client gives up.` })
  // the bar names e only while words are selected
  s.$.ui.selection = async () => undefined
  expect(await explainBar(s.$, () => true, false)).toEqual([])
  s.$.ui.selection = async () => ({ text: '  “the client”\n', requestId: 't1-row' })
  expect((await explainBar(s.$, () => true, false)).map(x => `${x.key} ${x.words}`)).toEqual(['e explain'])
  await pressE(s, { text: '  “the client”\n', requestId: 't1-row' })
  expect(s.calls[0].prompt).toContain('The term: the client')
  const part = (await partOf<ExplainPart>(s.$, 't1-row', 'explain'))!
  const id = part.order.find(x => part.items[x]!.term === 'the client')!
  expect((await trayNow(s.$))!.stack[0]).toMatchObject({ row: 't1-row', kind: 'explain', id })
  // no line says it is being written (the bar's busy line does), and the bar no longer names e for these words
  expect(await failLineNow(s.$)).toBe(null)
  expect(await explainBar(s.$, () => true, false)).toEqual([])
  s.$.ui.selection = async () => ({ text: 'uploads', requestId: 't1-row' })
  expect((await explainBar(s.$, () => true, false)).map(x => x.key)).toEqual(['e'])
  // with Explainers off, e is typed and the bar does not name it
  setOptions({ explain: false })
  expect(await explainKey(s.$, 'e', 0)).toBe(null)
  expect(await explainBar(s.$, k => k !== 'explain', false)).toEqual([])
  setOptions({})
})

test('the tour (tour/tour.ts): while its selection step waits, the explainer of the selected words shown is that step done', async () => {
  setOptions({})
  noteViewport({ isFullscreen: true })
  const s = setup([LOOK], { complete: reply({ body: 'The client gives up on an upload.', here: '' }) })
  s.$.ui.place = async () => ({ isPlaced: true, requestId: 'r-made-up' })
  await answered(s, { id: 't1', prompt: 'Why do uploads fail?', text: `${ANSWER} Then the client gives up.` })
  await tourStart(s.$)
  await tourDid(s.$, 'answer')
  expect((await tourNow(s.$))?.at).toBe('e')
  await pressE(s, { text: 'the client', requestId: 't1-row' })
  await settle()
  expect((await tourNow(s.$))?.done).toEqual(['answer', 'e'])
  expect((await tourNow(s.$))?.at).toBe('v')
})

test("the tour holds citations back until its cite step: an explainer's link opens nothing and c cites nothing, then both act", async () => {
  // the default Citations: with manual, the tour leaves out its cite step
  setOptions({})
  try {
    noteViewport({ isFullscreen: true })
    const s = setup([LOOK], { complete: reply({ body: 'The client gives up on an upload.', here: '[upload.py allows five tries](client/upload.py#L3-4).' }) })
    s.$.ui.place = async () => ({ isPlaced: true, requestId: 'r-made-up' })
    await answered(s, { id: 't1', prompt: 'Why do uploads fail?', text: `${ANSWER} Then the client gives up.` })
    await tourStart(s.$)
    await tourDid(s.$, 'answer')
    expect(await tourHoldsCites(s.$)).toBe(true)
    await pressE(s, { text: 'the client', requestId: 't1-row' })
    expect((await tourNow(s.$))?.at).toBe('v')
    expect(await trayKey(s.$, '2', 0)).toBe(null)
    s.$.ui.selection = async () => ({ text: '41 of the 44', requestId: 't1-row' })
    expect(await citeBar(s.$, k => k === 'cite', false)).toEqual([])
    expect(await citeKey(s.$, 'c', 0)).toBe(null)
    await tourDid(s.$, 'v')
    await tourDid(s.$, 's')
    expect((await tourNow(s.$))?.at).toBe('cite')
    expect(await tourHoldsCites(s.$)).toBe(false)
    expect(await trayKey(s.$, '2', 0)).not.toBe(null)
    expect((await citeBar(s.$, k => k === 'cite', false)).map(x => x.key)).toEqual(['c'])
  } finally {
    setOptions({})
  }
})

test("after a tour, a link to the tour's orders.csv opens its lines from the plugin's tour/sample; the person's own file comes first", async () => {
  setOptions({})
  const s = setup([LOOK])
  s.$.ui.place = async () => ({ isPlaced: true, requestId: 'r-made-up' })
  const run = s.$.process.run
  s.$.process.run = async (argv: string[]) => (argv[0] === 'sed' ? { exitCode: 2, stdout: '', stderr: 'No such file' } : run(argv))
  s.files.set('/made-up/plugin/tour/sample/orders.csv', 'order,day,item,refunded\n1,2026-03-02,loose-leaf tins,no\n2,2026-03-03,teapot,yes\n')
  // no tour in this session: orders.csv is not in the person's folder
  expect(await placeLines(s.$, 'orders.csv', 2, 2)).toBe('orders.csv could not be read here.')
  await tourStart(s.$)
  expect(await placeLines(s.$, 'orders.csv', 2, 3)).toEqual([{ n: 2, text: '1,2026-03-02,loose-leaf tins,no' }, { n: 3, text: '2,2026-03-03,teapot,yes' }])
  s.files.set('/made-up/data/orders.csv', 'id\nmine\n')
  expect(await placeLines(s.$, 'orders.csv', 2, 2)).toEqual([{ n: 2, text: 'mine' }])
})

test('with Citations manual, c makes the selected words a citation of their answer, drawn as a mark, and opens it in the tray; with no words waiting, c is typed again', async () => {
  setOptions({ citations: 'manual' })
  try {
    const s = setup([LOOK])
    const plain = 'Uploads fail after the retry budget runs out: **41 of the 44** failures came 30 seconds after a drop.'
    await answered(s, { id: 't1', prompt: 'Why do uploads fail?', text: plain })
    // with nothing selected, c is not cite's (it is typed) and the bar does not name it
    s.$.ui.selection = async () => undefined
    expect(await citeBar(s.$, k => k === 'cite', false)).toEqual([])
    expect(await citeKey(s.$, 'c', 0)).toBe(null)
    s.$.ui.selection = async () => ({ text: '41 of the 44 failures', requestId: 't1-row' })
    expect((await citeBar(s.$, k => k === 'cite', false)).map(x => `${x.key} ${x.words}`)).toEqual(['c cite'])
    s.$.ui.open = async () => ({ isPlaced: true })
    const take = await citeKey(s.$, 'c', 0)
    await take!.later!()
    await settle()
    const item = (await rowMarks(s.$, 't1-row'))!.items[0]!
    expect(item).toMatchObject({ n: 1, row: 't1-row', words: '41 of the 44 failures', asked: true, sentence: expect.stringContaining('[41 of the 44 failures]') })
    expect((await trayNow(s.$))!.stack[0]).toMatchObject({ row: 't1-row', kind: 'citation', n: 1 })
    // the answer reads the words as a citation; squeeze and the claims read them as plain words
    expect(withAsked(plain, [item]).text).toContain('out: [41 of the 44 failures](#) came')
    expect(readText(plain, [item])).toBe(plain.replace('**41 of the 44** failures', '41 of the 44 failures'))
    // once cited, the same selection no longer waits: c is typed and the bar does not name it until words are
    // selected anew
    expect(await citeKey(s.$, 'c', 0)).toBe(null)
    expect(await citeBar(s.$, k => k === 'cite', false)).toEqual([])
    s.$.ui.selection = async () => ({ text: '41 of the 44', requestId: 't1-row' })
    expect(await citeKey(s.$, 'c', 0)).not.toBe(null)
    // the same words again open the same citation; words that are not in the answer say so
    await citeWords(s.$, 't1-row', '41 of the 44')
    expect((await rowMarks(s.$, 't1-row'))!.items.length).toBe(1)
    expect(await citeWords(s.$, 't1-row', 'not in this answer')).toContain("isn't in the answer")
    // with Citations off, c is typed even with words selected
    setOptions({ citations: 'off' })
    expect(await citeKey(s.$, 'c', 0)).toBe(null)
    expect(await citeBar(s.$, k => k === 'cite', false)).toEqual([])
  } finally {
    setOptions({})
  }
})
