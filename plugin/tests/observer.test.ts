// The observer's look (observer/observer.ts): after main's turn answers, one fork of the conversation reads the answer
// with the enabled lenses' sections, the message to read and the session's reads. All data is made up. `claude plugin
// test plugin`.
import { expect } from 'claude-code/testing'

import { registerAnswers, resetAnswers } from '../core/answers'
import { registerTurn } from '../core/turn'
import { drainNow, registerObserver, resetObserver } from '../observer/observer'
import { setOptions } from '../settings/features.mjs'
import { promptStub, tempRun } from './stubs'
import { test } from './kit'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function setup(replies: Any[]) {
  resetAnswers()
  resetObserver()
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
  const forks: string[] = []
  const ran: string[][] = []
  let now = 1000
  const $: Any = {
    env: { get: async (k: string) => ({ THIMBLE_HOME: '/made-up/.thimble', TMPDIR: '/made-up/tmp' } as Any)[k] },
    plugin: { root: '/made-up/plugin', name: 'thimble' },
    session: { id: async () => 's-observer', cwd: async () => '/made-up/data', root: async () => '/made-up/data', messages: async () => [] },
    fs: {
      read: async (p: string) => { const t = promptStub(p); if (t !== undefined) return t; if (files.has(p)) return files.get(p); throw new Error(`no file ${p}`) },
      write: async (p: string, text: string) => { files.set(p, text) },
      list: async () => [],
      exists: async () => false,
      stat: async () => ({ kind: 'missing', size: 0 }),
    },
    process: {
      run: async (argv: string[]) => {
        ran.push(argv)
        return tempRun(argv) ?? (argv.includes('coverage') ? { exitCode: 0, stdout: 'Claude read 3 of 7 files.', stderr: '' } : { exitCode: 0, stdout: '', stderr: '' })
      },
    },
    model: { fork: async (r: { prompt: string }) => { forks.push(r.prompt); return replies.shift() ?? { isAnswered: false, reason: 'empty-reply' } } },
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
    // the look's own waits pass at once; its queue is drained by the test (drainNow)
    clock: { now: async () => (now += 100), after: (ms: number, fn: () => void) => { if (ms >= 1000) setTimeout(fn, 1); return { cancel() {} } } },
  }
  const call = (event: string, e: Any, last: (e: Any) => Any = async (x: Any) => x) => {
    const chain = hooks[event] ?? []
    const at = (i: number): ((e: Any) => Promise<Any>) => async (x: Any) => (i < chain.length ? chain[i]($, x, at(i + 1)) : last(x))
    return at(0)(e)
  }
  /** A step of main's turn through the observer's streaming hook. */
  const step = async (turnId: string, index: number) => {
    const g = hooks['turn.step']![0]($, { turnId, index, model: 'claude-made-up' }, async function* () { return { toolUses: [] } })
    for await (const _ of g) { /* the step's pieces */ }
  }
  return { $, call, step, forks, files, ran }
}

const settle = () => new Promise(r => setTimeout(r, 5))

async function answered(s: ReturnType<typeof setup>, o: { id: string; prompt: string; rows: string[] }) {
  await s.call('session.start', { cwd: '/made-up/data', isInteractive: true }, async () => ({}))
  await s.call('prompt.submit', { text: o.prompt, origin: { kind: 'composer' } })
  await s.call('turn.start', { text: o.prompt, turnId: o.id })
  for (const [k, text] of o.rows.entries()) {
    if (k) await s.step(o.id, k)
    await s.call('session.append', { door: 'response', message: { type: 'assistant', content: [{ type: 'text', text }] } }, async () => ({ uuid: `${o.id}-row-${k}` }))
  }
  await s.call('turn.complete', { turnId: o.id, reason: 'answer', answer: o.rows.at(-1) }, async () => ({ text: '' }))
  await settle()
  await drainNow(s.$)
  await settle()
}

const READ = { isAnswered: true, text: '{"glosses": [{"term": "p95", "body": "b"}], "heads": null, "claims": []}', usage: { input_tokens: 10, output_tokens: 5 } }

test("an answer gets one look: a fork of the conversation with the lenses' sections, the message to read, the session's reads", async () => {
  setOptions({ claimsMode: 'auto' })
  const s = setup([READ])
  await answered(s, { id: 't1', prompt: 'How many test runs failed?', rows: ['Two runs failed, both on the p95 check.'] })
  expect(s.forks.length).toBe(1)
  const p = s.forks[0]!
  expect(p).toContain('OBSERVER\nPROMPT lens-explain\n\nPROMPT lens-heads\n\nPROMPT lens-claims')
  expect(p).toContain(`TURN Read this message of Claude's, above in the session: Claude's answer at the end of turn 1, which begins "Two runs failed, both on the p95 check." (1 line). It answers the analyst's message "How many test runs failed?".`)
  // every slot of the turn's template is filled
  expect(p).not.toContain('{{')
  expect(p).toContain('READ Claude read 3 of 7 files.')
  expect(p).toContain('REPLY {"glosses": [], "heads": null, "claims": []}')
  // the session's coverage, as the person's command of the session's own records
  expect(s.ran.some(a => a.includes('coverage'))).toBe(true)
  const log = JSON.parse(s.files.get('/made-up/.thimble/conversations/s-observer/observer.json')!).log
  expect(log.at(-1)).toMatchObject({ kind: 'look', turn: 1, fork: { lenses: { explain: 'lens-explain', heads: 'lens-heads', claims: 'lens-claims' } } })
})

test("the tour's sample answer gets no look (tour/tour.ts tourSample): Claude wrote it without reading the data, on purpose; a later answer does", async () => {
  setOptions({ claimsMode: 'auto' })
  const s = setup([READ])
  // the tour waits for its sample answer: the turn that ends now writes it
  await s.$.state.set({ plugin: 'thimble', key: 'tour' }, { at: 'answer', done: [], missed: [], startedAt: 0, k: 1, intro: 'tour-intro-1', sample: null, moved: null })
  await answered(s, { id: 't1', prompt: '/thimble:tour', rows: ['Customers placed [36 orders](#) in March 2026.'] })
  expect(s.forks.length).toBe(0)
  // the tour ended; its sample answer is kept by its row, and an answer of the person's own gets its look
  await s.$.state.set({ plugin: 'thimble', key: 'tour' }, null)
  await s.$.state.set({ plugin: 'thimble', key: 'tourSample' }, 't1-row-0')
  await answered(s, { id: 't2', prompt: 'How many test runs failed?', rows: ['Two runs failed, both on the p95 check.'] })
  expect(s.forks.length).toBe(1)
  expect(s.forks[0]).not.toContain('36 orders')
})

test("the tour's cite-step answer gets no look either (tour/tour.ts tourAnswer): a heads-up would cover its citations; the person's next answer does", async () => {
  setOptions({ claimsMode: 'auto' })
  const s = setup([READ])
  // the cite step waits: the turn that ends now is the answer it checks
  await s.$.state.set({ plugin: 'thimble', key: 'tour' }, { at: 'cite', done: ['answer', 'e', 'v', 's'], missed: [], startedAt: 0, k: 2, intro: 'tour-intro-1', sample: 't0-row-0', moved: null, cited: null })
  await answered(s, { id: 't1', prompt: 'Summarize your answer in two sentences, and cite each number.', rows: ['The shop refunded [4 orders](#).'] })
  expect(s.forks.length).toBe(0)
  // the tour ended and keeps the row it checked; an answer of the person's own gets its look
  await s.$.state.set({ plugin: 'thimble', key: 'tour' }, { at: 'end', done: ['answer', 'e', 'v', 's', 'cite'], missed: [], startedAt: 0, k: 2, intro: 'tour-intro-1', sample: 't0-row-0', moved: null, cited: 't1-row-0' })
  await answered(s, { id: 't2', prompt: 'How many test runs failed?', rows: ['Two runs failed, both on the p95 check.'] })
  expect(s.forks.length).toBe(1)
  expect(s.forks[0]).not.toContain('4 orders')
})
