// The explainers and heads-ups (explain/): after the observer's look, each stands on its words in the answer as a
// press, in 0.10's teal and orange; a term is explained once per conversation; each lens's switch hides what it gave;
// Longer writes an explainer again from the answer and the lines it links to, the short one kept, and one that fails
// says why. All data is made up. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { partOf, registerAnswers, resetAnswers } from '../core/answers'
import { spansFor } from '../core/answerview'
import { resetEngaged } from '../core/engaged'
import { registerTurn } from '../core/turn'
import { resetTheme } from '../core/theme'
import { explainState, expandExplainer, resetExplain, type ExplainPart } from '../explain/seam'
import { drainNow, registerObserver, resetObserver } from '../observer/observer'
import { setOptions } from '../settings/features.mjs'
import { promptStub, tempRun } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function setup(replies: Any[], o: { theme?: string; complete?: Any } = {}) {
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
  registerAnswers(on, {} as never)
  registerObserver(on, {} as never)
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
      fork: async () => replies.shift() ?? { isAnswered: false, reason: 'empty-reply' },
      complete: async (r: Any) => { calls.push(r); return o.complete ?? { isAnswered: false, reason: 'empty-reply' } },
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
  heads: { term: '30 seconds after a drop', title: 'Only one network', bullets: ['[The log covers one office](logs/upload.log).'], todo: 'Check the other office.' },
})

test("after a look, the answer's explainer and heads-up stand on their words in the theme's teal and orange, and the digest knows them", async () => {
  setOptions({})
  const s = setup([LOOK])
  await answered(s, { id: 't1', prompt: 'Why do uploads fail?', text: ANSWER })
  const part = await partOf<ExplainPart>(s.$, 't1-row', 'explain')
  expect(part!.order).toEqual(['h1', 'g1'])
  expect(part!.items.g1).toMatchObject({ term: 'retry budget', body: 'How many times the client tries again.' })
  expect(part!.items.h1).toMatchObject({ kind: 'heads', title: 'Only one network', todo: 'Check the other office.' })
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

test('Longer writes the explainer again from the answer and the lines it links to, and keeps the short one; one that fails says why and how to try again', async () => {
  setOptions({})
  const s = setup([LOOK], { complete: reply({ body: 'The client sends a failed upload again up to five times.', here: '[five tries](client/upload.py#L3-4)' }) })
  s.files.set('/made-up/data/client/upload.py', 'import os\n\nTRIES = 5\nWAIT = 1\n')
  await answered(s, { id: 't1', prompt: 'Why do uploads fail?', text: ANSWER })
  expect(await expandExplainer(s.$, { row: 't1-row', kind: 'explain', id: 'g1' })).toBe(null)
  const sent = s.calls[0]
  expect(sent.system[0].text).toBe('PROMPT explain-expand')
  expect(sent.prompt).toContain('The term: retry budget')
  expect(sent.prompt).toContain("The analyst's question: Why do uploads fail?")
  expect(sent.prompt).toContain('--- client/upload.py (lines 1–5 of 5)')
  expect(sent.prompt).toContain('    3  TRIES = 5')
  const g = (await partOf<ExplainPart>(s.$, 't1-row', 'explain'))!.items.g1!
  expect(g).toMatchObject({ body: 'The client sends a failed upload again up to five times.', expanded: true, short: { body: 'How many times the client tries again.' } })
  expect(await expandExplainer(s.$, { row: 't1-row', kind: 'heads', id: 'h1' })).toBe('A heads-up is not written at more length.')
  // a Longer that fails says why and how to try again; the explainer stays as it was
  const failing = setup([LOOK], { complete: { isAnswered: false, reason: 'aborted' } })
  await answered(failing, { id: 't1', prompt: 'Why do uploads fail?', text: ANSWER })
  const why = await expandExplainer(failing.$, { row: 't1-row', kind: 'explain', id: 'g1' })
  expect(why).toContain('was not written: the call was stopped')
  expect(why).toContain('Press e on it to try again.')
  expect((await partOf<ExplainPart>(failing.$, 't1-row', 'explain'))!.items.g1!.expanded).toBe(undefined)
})

