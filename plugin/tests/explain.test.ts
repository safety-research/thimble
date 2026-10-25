// The explainers and heads-ups (explain/): after the observer's look, each stands on its words in the answer as a
// press, in 0.10's teal and orange; a term is explained once per conversation; each lens's switch hides what it gave;
// Claude reads each one shown, with the next prompt; words the analyst picks get an explainer on demand, and one that
// fails says why. All data is made up. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { partOf, registerAnswers, resetAnswers } from '../core/answers'
import { spansFor } from '../core/answerview'
import { resetEngaged } from '../core/engaged'
import { registerTell } from '../core/tell'
import { registerTurn } from '../core/turn'
import { resetTheme } from '../core/theme'
import { failLineNow } from '../bar/notice'
import { explainBar, explainKey, registerExplain, explainState, explaining, explainTerm, glossFor, pickedWords, resetExplain, sessionGlosses, type ExplainPart } from '../explain/seam'
import { trayNow } from '../tray/tray'
import { drawEvidence } from '../marks/evidence'
import { readText, withAsked } from '../marks/message.js'
import { rowMarks } from '../marks/store'
import { placeOf, whereBar, whereKey, whereWords } from '../marks/where'
import { drainNow, registerObserver, resetObserver } from '../observer/observer'
import { setOptions } from '../settings/features.mjs'
import { promptStub, tempRun } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function setup(replies: Any[], o: { theme?: string; complete?: Any; noFork?: boolean } = {}) {
  resetAnswers()
  resetObserver()
  resetExplain()
  resetEngaged()
  resetTheme()
  let theme = o.theme ?? 'dark'
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
    config: { list: async () => [{ key: 'theme', value: theme }] },
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
      // the look's fork takes the replies in turn; an explainer asked for is a fork too (o.complete answers it), or a side
      // call where there is no conversation to fork (o.noFork)
      fork: async (r: Any) => {
        if (!String(r?.prompt ?? '').startsWith('PROMPT explain-expand')) return replies.shift() ?? { isAnswered: false, reason: 'empty-reply' }
        if (o.noFork) return { isAnswered: false, reason: 'nothing-to-fork' }
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
  return { $, call, files, calls, state, setTheme: (v: string) => { theme = v } }
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

test('a term is explained once per conversation, and each switch hides what its lens gave', async () => {
  setOptions({})
  const s = setup([LOOK, reply({ glosses: [{ term: 'retry budget', body: 'again' }], heads: null })])
  await answered(s, { id: 't1', prompt: 'Why do uploads fail?', text: ANSWER })
  await answered(s, { id: 't2', prompt: 'And now?', text: 'The retry budget is five.' })
  expect(await partOf(s.$, 't2-row', 'explain')).toBe(null)
  setOptions({ explain: false })
  const spans = await spansFor(s.$, 't1-row', ANSWER, [])
  expect(spans.map(x => x.id)).toEqual(['h1'])
  setOptions({})
})

test("Claude reads, with the next prompt, every explainer and heads-up shown on its answer, and which ones the analyst opened; a switch that hides one keeps it from Claude too", async () => {
  setOptions({})
  const s = setup([LOOK])
  await answered(s, { id: 't1', prompt: 'Why do uploads fail?', text: ANSWER })
  // the analyst opens the heads-up
  const spans = await spansFor(s.$, 't1-row', ANSWER, [])
  s.$.ui.open = async () => ({ isPlaced: true })
  await spans.find(x => x.id === 'h1')!.onPress!()
  const told = (await s.call('prompt.submit', { text: 'And the other office?', origin: { kind: 'composer' } })).context.join('\n')
  expect(told).toContain('thimble showed the analyst these comments in your message that begins "Uploads fail after the retry budget')
  expect(told).toContain('- A heads-up on "30 seconds after a drop": Only one network [The log covers one office](logs/upload.log).')
  expect(told).toContain('- An explainer on "retry budget": How many times the client tries again. [upload.py allows five tries](client/upload.py#L3-4).')
  expect(told).toContain('- They opened the heads-up "Only one network" on "30 seconds after a drop"')
  expect(told).not.toContain('They opened the explainer')
  // told once: the prompt after carries none of it
  expect((await s.call('prompt.submit', { text: 'ok', origin: { kind: 'composer' } })).context ?? []).toEqual([])
  // with Heads-ups off, the heads-up is not shown, so not told
  setOptions({ details: false })
  const off = setup([LOOK])
  await answered(off, { id: 't1', prompt: 'Why do uploads fail?', text: ANSWER })
  const said = (await off.call('prompt.submit', { text: 'next', origin: { kind: 'composer' } })).context.join('\n')
  expect(said).toContain('An explainer on "retry budget"')
  expect(said).not.toContain('heads-up')
  setOptions({})
})

const els: Any = new Proxy({}, { get: (_t, type: string) => (props: Any) => ({ type, props }) })
const textOf = (n: Any): string => (n == null || n === false ? '' : typeof n === 'string' || typeof n === 'number' ? String(n) : Array.isArray(n) ? n.map(textOf).join('') : textOf(n.props?.children))
const buttonsOf = (n: Any, out: Any[] = []): Any[] => {
  if (!n || typeof n !== 'object') return out
  if (Array.isArray(n)) { n.forEach(x => buttonsOf(x, out)); return out }
  if (n.type === 'Button') out.push(n.props)
  buttonsOf(n.props?.children, out)
  return out
}

test('on demand: words the analyst picked get an explainer from the explain-expand call, kept on their answer as the look\'s are; asked again, the same one; the session lists it', async () => {
  setOptions({})
  const s = setup([LOOK], { complete: reply({ body: 'The thirty seconds the client waits before it gives up on an upload.', here: 'It shows in [upload.log](logs/upload.log#L2).' }) })
  await answered(s, { id: 't1', prompt: 'Why do uploads fail?', text: ANSWER })
  const got = await explainTerm(s.$, 't1-row', '30 seconds after a drop') as Any
  expect(got).toMatchObject({ row: 't1-row', term: '30 seconds after a drop', asked: true })
  // a fork of the conversation, so it reads the records main read, the prompt before the request
  expect(s.calls[0].prompt).toMatch(/^PROMPT explain-expand\n\nThe term: 30 seconds after a drop\n/)
  expect(s.calls[0].side).toBe(undefined)
  // no file is cited here: the request names no files at all, rather than saying none could be read
  expect(s.calls[0].prompt).not.toContain('files the answer cites')
  expect(s.calls[0].prompt).toContain("The analyst's question: Why do uploads fail?")
  const part = (await partOf<ExplainPart>(s.$, 't1-row', 'explain'))!
  expect(part.order).toEqual(['h1', 'g1', 'a1'])
  expect((await explainState(s.$)).glossed).toEqual(['retry budget', '30 seconds after a drop'])
  // the same words again: the one written, no second call; a term of the look's is found in another form
  expect(await explainTerm(s.$, 't1-row', '30 seconds after a drop')).toMatchObject({ id: 'a1' })
  expect(s.calls.length).toBe(1)
  const all = await sessionGlosses(s.$)
  expect(all.map(g => g.term).sort()).toEqual(['30 seconds after a drop', 'retry budget'])
  expect(glossFor(all, 'retry budgets')?.term).toBe('retry budget')
  // longer words that hold a term are not that term
  expect(glossFor(all, 'the retry budget runs out')).toBe(null)
  // a call that fails says why, and the words can be asked for again
  const failing = setup([LOOK], { complete: { isAnswered: false, reason: 'aborted' } })
  await answered(failing, { id: 't1', prompt: 'Why do uploads fail?', text: ANSWER })
  expect(String(await explainTerm(failing.$, 't1-row', 'the client'))).toContain('was not written')
  expect(explaining('the client')).toMatchObject({ pending: false })
  expect(explaining('the client').why).toContain('was not written')
  // after /clear there is no conversation to fork: one side call, with the prompt as its system
  const side = setup([LOOK], { noFork: true, complete: reply({ body: 'The program that sends the uploads.', here: '' }) })
  await answered(side, { id: 't1', prompt: 'Why do uploads fail?', text: ANSWER })
  expect(await explainTerm(side.$, 't1-row', 'the client')).toMatchObject({ term: 'the client', body: 'The program that sends the uploads.' })
  expect(side.calls[0]).toMatchObject({ side: true, system: [{ text: 'PROMPT explain-expand' }] })
})

test("a quote of a JSON line shows the line as the file holds it, the cited words highlighted in it; w explains the cited words in place", async () => {
  setOptions({})
  const s = setup([LOOK], { complete: reply({ body: 'A page anyone can bump to leave a number for the next copy.', here: '' }) })
  await answered(s, { id: 't1', prompt: 'Why do uploads fail?', text: ANSWER })
  const item = { n: 1, row: 't1-row', words: '41 of the 44', start: 57, end: 75, sentence: 'Uploads fail.', status: 'verified', shown: 'Paste it fast',
    evidence: { kind: 'quote', file: 'revisions.jsonl', line: '2', lines: [{ n: 1, text: '{"rev_id": 1}' }, { n: 2, text: 'Note to the next copy: round 1 asked for Brindle. Paste it fast.', highlight: [50, 63], decoded: true }, { n: 3, text: '{"rev_id": 3}' }] } }
  await s.$.state.set({ plugin: 'thimble', key: 'marksRow', id: 't1-row' }, 'k1')
  await s.$.state.set({ plugin: 'thimble', key: 'marks', id: 'k1' }, { key: 'k1', turnId: 't1', rows: ['t1-row'], startedAt: 0, settledAt: 1, items: [item] })
  const e = { props: { bodyColumns: 80 } }
  const pane = await drawEvidence(s.$, e, { row: 't1-row', n: 1 }, els)
  const t = textOf(pane)
  expect(t).toContain('revisions.jsonl:2')
  expect(t).toContain('{"rev_id": 3}')
  expect(t).toContain("the line's JSON text, decoded")
  // the quoted words are in the cited line, in the citations' look (bold)
  const bold: string[] = []
  const walk = (n: Any): void => { if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n === 'object') { if (n.type === 'Text' && n.props?.bold) bold.push(textOf(n)); walk(n.props?.children) } }
  walk(pane)
  expect(bold).toContain('Paste it fast')
  expect(buttonsOf(pane).filter(b => b.hotkey).map(b => [b.hotkey, b.label])).toEqual([['e', 'explain these words']])
  // w: the cited words' explainer, written now, shows in the pane
  buttonsOf(pane).find(b => b.hotkey === 'e').onPress()
  await settle()
  const ex = textOf(await drawEvidence(s.$, e, { row: 't1-row', n: 1 }, els))
  expect(ex).toContain('Paste it fast  explainer')
  expect(ex).toContain('A page anyone can bump to leave a number for the next copy.')
})

// ------------------------------------------------------------------------------------------------ e: the selection

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
  await answered(s, { id: 't1', prompt: 'Why do uploads fail?', text: ANSWER })
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

test('e with nothing selected says to select words with the mouse first, and how outside the fullscreen layout; nothing is written', async () => {
  setOptions({})
  const s = setup([LOOK], { complete: reply({ body: 'never', here: '' }) })
  await answered(s, { id: 't1', prompt: 'Why do uploads fail?', text: ANSWER })
  await pressE(s, undefined)
  expect(String((await failLineNow(s.$))?.text)).toBe('Select words in an answer with the mouse first, then press e to explain them.')
  expect((await failLineNow(s.$))?.kind).toBe('notice')
  await pressE(s, { text: ' " ' })
  expect(String((await failLineNow(s.$))?.text)).toContain('Select words in an answer with the mouse first')
  expect(s.calls.length).toBe(0)
  expect(await trayNow(s.$)).toBe(null)
})

test('a selection over several rows explains its words on the newest answer that holds them; words that are a heads-up open it, unwritten', async () => {
  setOptions({})
  const s = setup([LOOK, reply({ glosses: [], heads: null })], { complete: reply({ body: 'How many tries are left.', here: '' }) })
  await answered(s, { id: 't1', prompt: 'Why do uploads fail?', text: ANSWER })
  await answered(s, { id: 't2', prompt: 'And now?', text: 'Nothing changed since then.' })
  // no requestId: the selection spans rows; the words stand in t1's answer, not the newest
  await pressE(s, { text: 'retry budget runs out' })
  expect((await trayNow(s.$))!.stack[0]).toMatchObject({ row: 't1-row', kind: 'explain' })
  expect(s.calls.length).toBe(1)
  // the heads-up's own words: the tray opens on it, and no explainer is written
  await pressE(s, { text: '30 seconds after a drop', requestId: 't1-row' })
  expect((await trayNow(s.$))!.stack[0]).toMatchObject({ row: 't1-row', kind: 'heads', id: 'h1' })
  expect(s.calls.length).toBe(1)
})

test('the selected words are trimmed to one line, and a long selection is cut after a whole word, which the line says', async () => {
  expect(pickedWords('  "hit counter"\n')).toEqual({ words: 'hit counter', cut: false })
  expect(pickedWords('the\n  retry budget')).toEqual({ words: 'the retry budget', cut: false })
  const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
  const got = pickedWords(long)
  expect(got.cut).toBe(true)
  expect(got.words.length <= 120).toBe(true)
  expect(long.startsWith(`${got.words} `)).toBe(true)
  setOptions({})
  const s = setup([LOOK], { complete: { isAnswered: false, reason: 'aborted' } })
  await answered(s, { id: 't1', prompt: 'Why do uploads fail?', text: ANSWER })
  s.$.ui.selection = async () => ({ text: long, requestId: 't1-row' })
  await (await explainKey(s.$, 'e', 0))!.later!()
  expect(String((await failLineNow(s.$))?.text)).toContain('the explainer covers its first')
  await settle()
  // the call failed: the line says why, in red
  expect((await failLineNow(s.$))?.kind).toBe('failed')
})

test('selected words inside a mark open it; words over or across marks get one explainer whose mark covers the marks it overlaps', async () => {
  setOptions({})
  const s = setup([LOOK], { complete: reply({ body: 'When the client has used all its tries.', here: '' }) })
  await answered(s, { id: 't1', prompt: 'Why do uploads fail?', text: ANSWER })
  // inside the explainer of "retry budget": that one opens, nothing is written
  await pressE(s, { text: 'budget', requestId: 't1-row' })
  expect((await trayNow(s.$))!.stack[0]).toMatchObject({ row: 't1-row', kind: 'explain', id: 'g1' })
  expect(s.calls.length).toBe(0)
  // over it: one new explainer, whose mark covers the selection; the explainer under it no longer draws
  await pressE(s, { text: 'retry budget runs out', requestId: 't1-row' })
  expect(s.calls.length).toBe(1)
  const spans = await spansFor(s.$, 't1-row', ANSWER, [])
  expect(spans.map(x => [x.id, ANSWER.slice(x.start, x.end)])).toEqual([['a1', 'retry budget runs out'], ['h1', '30 seconds after a drop']])
  expect((await trayNow(s.$))!.stack[0]).toMatchObject({ row: 't1-row', kind: 'explain', id: 'a1' })
  // /explain follows the same rule: words inside the new mark open it
  await s.call('command.run', { command: 'explain', args: 'budget runs' }, async () => ({}))
  await settle()
  expect(s.calls.length).toBe(1)
  // and words over the heads-up and its neighbor get one explainer of their own, which the heads-up gives way to
  await s.call('command.run', { command: 'explain', args: 'came 30 seconds' }, async () => ({}))
  await settle()
  expect(s.calls.length).toBe(2)
  expect((await spansFor(s.$, 't1-row', ANSWER, [])).map(x => [x.id, ANSWER.slice(x.start, x.end)])).toEqual([['a1', 'retry budget runs out'], ['a2', 'came 30 seconds']])
})

// ------------------------------------------------------------------------------------------------ w: where from

test('with Citations manual, w makes the selected words a citation of their answer, drawn as a mark, and opens it in the tray; only then does the bar name w', async () => {
  setOptions({ citations: 'manual' })
  try {
    const s = setup([LOOK])
    const plain = 'Uploads fail after the retry budget runs out: **41 of the 44** failures came 30 seconds after a drop.'
    await answered(s, { id: 't1', prompt: 'Why do uploads fail?', text: plain })
    // the bar names w only while words are selected
    s.$.ui.selection = async () => undefined
    expect(await whereBar(s.$, k => k === 'where', false)).toEqual([])
    s.$.ui.selection = async () => ({ text: '41 of the 44 failures', requestId: 't1-row' })
    expect((await whereBar(s.$, k => k === 'where', false)).map(x => `${x.key} ${x.words}`)).toEqual(['w where from'])
    s.$.ui.open = async () => ({ isPlaced: true })
    const take = await whereKey(s.$, 'w', 0)
    await take!.later!()
    await settle()
    const item = (await rowMarks(s.$, 't1-row'))!.items[0]!
    expect(item).toMatchObject({ n: 1, row: 't1-row', words: '41 of the 44 failures', asked: true, sentence: expect.stringContaining('[41 of the 44 failures]') })
    expect((await trayNow(s.$))!.stack[0]).toMatchObject({ row: 't1-row', kind: 'citation', n: 1 })
    // the answer reads the words as a citation; squeeze and the claims read them as plain words
    expect(withAsked(plain, [item]).text).toContain('out: [41 of the 44 failures](#) came')
    expect(readText(plain, [item])).toBe(plain.replace('**41 of the 44** failures', '41 of the 44 failures'))
    // the same words again open the same citation; words that are not in the answer say so
    await whereWords(s.$, 't1-row', '41 of the 44')
    expect((await rowMarks(s.$, 't1-row'))!.items.length).toBe(1)
    expect(await whereWords(s.$, 't1-row', 'not in this answer')).toContain('is not in the answer as Claude wrote it')
    // nothing selected: a hint, and nothing is made
    s.$.ui.selection = async () => undefined
    await (await whereKey(s.$, 'w', 0))!.later!()
    expect(String((await failLineNow(s.$))?.text)).toBe('Select words in an answer with the mouse first, then press w to find where they come from.')
    // in any other mode, w is typed and the bar does not name it
    setOptions({ citations: 'auto cite' })
    expect(await whereKey(s.$, 'w', 0)).toBe(null)
  } finally {
    setOptions({})
  }
})

test('placeOf finds the words as the analyst read them in the text Claude wrote, across its emphasis, on one line', () => {
  expect(placeOf('A **bold claim** here.', 'bold claim here')).toEqual({ start: 2, end: 21 })
  expect(placeOf('A **bold claim** here.', 'bold claim')).toEqual({ start: 4, end: 14 })
  expect(placeOf('one  two three', 'one two')).toEqual({ start: 0, end: 8 })
  expect(placeOf('one\ntwo three', 'one two')).toBe(null)
  expect(placeOf('nothing', 'else')).toBe(null)
})
