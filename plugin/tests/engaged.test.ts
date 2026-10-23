// What the person engaged with reaches main with their next prompt (core/engaged.ts through core/tell.ts tellLine): the
// lines gather under one head, each thing once, and go with the next prompt as thimble's report; the next line starts
// the text again. All data is made up. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { resetEngaged, tellAsked, tellOpened } from '../core/engaged'
import { registerTell } from '../core/tell'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function setup() {
  resetEngaged()
  const hooks: Record<string, Any> = {}
  const on: Any = (event: string, a: Any, b?: Any) => { hooks[event] = typeof a === 'function' ? a : b; return { catch: () => undefined } }
  registerTell(on, {} as never)
  const state = new Map<string, { value: unknown; version: number }>()
  const $: Any = {
    env: { get: async (k: string) => ({ THIMBLE_HOME: '/made-up/.thimble' } as Any)[k] },
    session: { id: async () => 's-engaged' },
    fs: { write: async () => undefined, read: async () => { throw new Error('none') } },
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
  }
  const prompt = async (text: string) => (await hooks['prompt.submit']($, { text, origin: { kind: 'composer' } }, async (e: Any) => e)) as { context?: string[] }
  return { $, prompt }
}

test('the marks the person opened and the questions they asked go with their next prompt, each once, under one head', async () => {
  const s = setup()
  await tellOpened(s.$, { kind: 'explain', row: 'r1', term: 'p95' }, 'Two runs failed on the p95 check.')
  await tellOpened(s.$, { kind: 'explain', row: 'r1', term: 'p95' }, 'Two runs failed on the p95 check.')
  await tellAsked(s.$, { text: 'Which runs were slow?', about: 'the card "Runs"' })
  const r = await s.prompt('So what now?')
  expect(r.context!.length).toBe(1)
  const told = r.context![0]!
  expect(told).toContain("thimble's report")
  expect(told).toContain('What the analyst did on screen since your last reply.')
  expect(told.split('opened the explainer of "p95"').length).toBe(2)
  expect(told).toContain('- They asked a side thread about the card "Runs", which a side agent answers there: "Which runs were slow?"')
  // sent once; the next line starts under the head again, and what was told is not told again
  expect((await s.prompt('And then?')).context).toBe(undefined)
  await tellOpened(s.$, { kind: 'explain', row: 'r1', term: 'p95' })
  await tellOpened(s.$, { kind: 'citation', row: 'r2', n: 1, words: '12 of 40', status: 'verified' })
  const next = (await s.prompt('Last one')).context![0]!
  expect(next).not.toContain('p95')
  expect(next).toContain('none of it asks anything of you.\n- They opened the citation "12 of 40"; the check verified it as written.')
})
