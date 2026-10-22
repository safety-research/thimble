// Claims (claims/): the observer's claims lens places each answer's claims by their words, with the citations near them,
// in the conversation's kept folder; c on the bar counts them and lights when a claim was corrected; a look that fails
// leaves a gap the pane names; c opens the pane, where a click selects a cluster, then a claim. All data is made up. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { registerAnswers, resetAnswers } from '../core/answers'
import { registerTell } from '../core/tell'
import { registerTurn } from '../core/turn'
import { drainNow, registerObserver, resetObserver } from '../observer/observer'
import { setOptions } from '../settings/features.mjs'
import { claimsBar, claimsKey, drawClaimsPane, registerClaims } from '../claims/seam'
import { claimsStore } from '../claims/term'
import { promptStub, tempRun } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const KEPT = '/made-up/.thimble/conversations/s-claims'

function setup(replies: Any[]) {
  resetAnswers()
  resetObserver()
  const hooks: Record<string, Any[]> = {}
  const on: Any = (event: string, a: Any, b?: Any) => {
    ;(hooks[event] ??= []).push(typeof a === 'function' ? a : b)
    return { catch: () => undefined }
  }
  registerTurn(on, {} as never)
  registerTell(on, {} as never)
  registerAnswers(on, {} as never)
  registerObserver(on, {} as never)
  registerClaims(on, {} as never)
  const state = new Map<string, { value: unknown; version: number }>()
  const files = new Map<string, string>()
  const forks: string[] = []
  const submitted: string[] = []
  const opened: Any[] = []
  const commands: string[] = []
  let now = 1000
  const $: Any = {
    env: { get: async (k: string) => ({ THIMBLE_HOME: '/made-up/.thimble', TMPDIR: '/made-up/tmp' } as Any)[k] },
    plugin: { root: '/made-up/plugin', name: 'thimble' },
    session: { id: async () => 's-claims', cwd: async () => '/made-up/data', root: async () => '/made-up/data', messages: async () => [] },
    command: { register: async (c: Any) => { commands.push(c.name) } },
    prompt: { submit: async (p: { text: string }) => { submitted.push(p.text) } },
    ui: { open: async (o: Any) => { opened.push(o); return { isPlaced: true } }, close: async () => undefined },
    fs: {
      read: async (p: string) => { const t = promptStub(p); if (t !== undefined) return t; if (files.has(p)) return files.get(p); throw new Error(`no file ${p}`) },
      write: async (p: string, text: string) => { files.set(p, text) },
      list: async () => [],
      exists: async (p: string) => files.has(p),
      stat: async () => ({ kind: 'missing', size: 0 }),
    },
    process: {
      run: async (argv: string[]) => {
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
    clock: { now: async () => (now += 100), after: (ms: number, fn: () => void) => { setTimeout(fn, ms >= 1000 ? 1 : 0); return { cancel() {} } } },
  }
  const call = (event: string, e: Any, last: (e: Any) => Any = async (x: Any) => x) => {
    const chain = hooks[event] ?? []
    const at = (i: number): ((e: Any) => Promise<Any>) => async (x: Any) => (i < chain.length ? chain[i]($, x, at(i + 1)) : last(x))
    return at(0)(e)
  }
  return { $, call, forks, files, submitted, opened, commands, state }
}

/** What the side pane shows now (core/pane.ts). */
const paneNow = (s: ReturnType<typeof setup>): Any => s.state.get(JSON.stringify({ plugin: 'thimble', key: 'pane' }))?.value ?? null

const settle = () => new Promise(r => setTimeout(r, 5))

async function answered(s: ReturnType<typeof setup>, o: { id: string; prompt: string; rows: string[] }) {
  await s.call('prompt.submit', { text: o.prompt, origin: { kind: 'composer' } })
  await s.call('turn.start', { text: o.prompt, turnId: o.id })
  for (const [k, text] of o.rows.entries()) {
    await s.call('session.append', { door: 'response', message: { type: 'assistant', content: [{ type: 'text', text }] } }, async () => ({ uuid: `${o.id}-row-${k}` }))
  }
  await s.call('turn.complete', { turnId: o.id, reason: 'answer', answer: o.rows.at(-1) }, async () => ({ text: '' }))
  await settle()
  await drainNow(s.$)
  await settle()
}

const reply = (claims: unknown[]) => ({ isAnswered: true, text: JSON.stringify({ glosses: [], heads: null, claims }), usage: { input_tokens: 10, output_tokens: 5 } })

/** Elements as plain objects, for reading what the pane draws. */
const els: Any = new Proxy({}, { get: (_t, type: string) => (props: Any) => ({ type, props }) })
const buttons = (node: Any, out: Any[] = []): Any[] => {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach(n => buttons(n, out)); return out }
  if (node.type === 'Button') out.push(node.props)
  buttons(node.props?.children, out)
  return out
}
const textOf = (node: Any): string => {
  if (node == null || node === false) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  const kids = textOf(node.props?.children)
  return node.type === 'Box' && node.props?.flexDirection === 'column' ? `${kids}\n` : kids
}

test("an answer's claims come in with the citations near their words; c counts them, and lights when a later answer corrects one", async () => {
  setOptions({})
  const s = setup([
    reply([{ claim: 'Alice made 212 of the edits.', quote: 'Alice made 212 edits', cluster: 'who tilted it' }, { claim: 'The edits after June 18 were biased.', quote: 'the edits after June 18 biased', by: 'analyst', cluster: 'who tilted it' }]),
    reply([{ claim: 'The edits after June 18 were not biased; one editor tilted them.', quote: 'The edits were not biased', revises: 'c2' }]),
  ])
  await s.call('session.start', { cwd: '/made-up/data', isInteractive: true }, async () => ({}))
  expect(s.commands).toContain('claims')
  await answered(s, { id: 't1', prompt: 'Were the edits after June 18 biased?', rows: ['Alice made [212 edits](#) after June 18.'] })
  const store = await claimsStore(s.$)
  expect(store.claims.map((c: Any) => [c.id, c.by, c.sources.map((x: Any) => [x.row, x.at, x.label])])).toEqual([
    ['c1', 'claude', [['t1-row-0', 11, '212 edits']]],
    ['c2', 'person', []],
  ])
  expect(JSON.parse(s.files.get(`${KEPT}/claims.json`)!).claims.length).toBe(2)
  expect((await claimsBar(s.$, () => true, false)).map(x => [x.key, x.words])).toEqual([['c', '2 claims']])
  // the next look reads every claim so far
  await answered(s, { id: 't2', prompt: 'Are you sure?', rows: ['The edits were not biased: one editor tilted them.'] })
  expect(s.forks[1]).toContain('PROMPT lens-claims')
  expect((await claimsBar(s.$, () => true, false)).map(x => [x.words, x.color])).toEqual([['3 claims', 'suggestion']])
  // switched off, c is not on the bar and the key is typed
  expect(await claimsBar(s.$, k => k !== 'claims', false)).toEqual([])
})

test('a look that fails leaves a gap the pane names; c opens the pane, where a press on a name selects a cluster and a press on a dot its claim', async () => {
  setOptions({})
  const s = setup([reply([
    { claim: 'Run 4 failed on the p95 check.', quote: 'Run 4 failed on the p95 check', cluster: 'failures' },
    { claim: 'Run 9 failed on a timeout.', quote: 'Run 9 failed on a timeout', cluster: 'failures' },
    { claim: 'The cache was cold.', quote: 'The cache was cold', cluster: 'causes' },
  ])])
  await s.call('session.start', { cwd: '/made-up/data', isInteractive: true }, async () => ({}))
  await answered(s, { id: 't1', prompt: 'Which runs failed?', rows: ['Run 4 failed on the p95 check. Run 9 failed on a timeout. The cache was cold.'] })
  await answered(s, { id: 't2', prompt: 'Why?', rows: ['Because of the cache.'] })
  const take = await claimsKey(s.$, 'c', 0)
  expect(take?.later).toBeDefined()
  await take!.later!()
  expect(s.opened.at(-1)).toMatchObject({ id: 'thimble', title: 'Claims', focus: true })
  const draw = (args: Any) => drawClaimsPane(s.$, { props: { bodyColumns: 100, scroll: { bodyRows: 30 } } }, args, els)
  const keysOf = (pane: Any) => buttons(pane).filter(b => b.hotkey).map(b => [b.hotkey, b.label])
  const pane = await draw({})
  const t = textOf(pane)
  expect(t).toContain('Claims · 3 claims · 2 clusters')
  expect(t).toContain('Turn 2 was not read:')
  // at rest the panel shows the newest claim's cluster: its name and its claims, no checks
  expect(t).toContain('● causes · 1 claim')
  expect(t).toContain('  – The cache was cold.')
  expect(t).not.toContain('It cites nothing.')
  // the keys, each once: a plain Button Claude Code draws as its key, then its words, dim; the words never hold the key,
  // which drew it twice
  expect(keysOf(pane)).toEqual([['n', 'next'], ['p', 'previous']])
  expect(buttons(pane).filter(b => b.hotkey).map(b => textOf(b.children))).toEqual(['next', 'previous'])
  expect(t).toContain('next · previous')
  // at rest n lights the cluster the panel shows
  await buttons(pane).find(b => b.hotkey === 'n').onPress()
  expect(paneNow(s).args).toMatchObject({ group: 'k2' })
  // a press on a cluster's name selects the cluster: its name and both its claims
  const name = buttons(pane).find(b => /^g\d+:g:k1$/.test(b.key))
  expect(name).toBeDefined()
  await name.onPress()
  const failures = paneNow(s).args
  expect(failures).toMatchObject({ group: 'k1' })
  const cluster = await draw(failures)
  expect(textOf(cluster)).toContain('● failures · 2 claims')
  expect(textOf(cluster)).toContain('  – Run 4 failed on the p95 check.')
  expect(textOf(cluster)).toContain('  – Run 9 failed on a timeout.')
  // a press on a dot selects its claim, of any cluster: the cluster's list stays, the claim ▸ with its chips under it,
  // and e opens its evidence
  const dots = buttons(pane).filter(b => /^g\d+:d:/.test(b.key))
  expect([...new Set(dots.map(b => b.key.replace(/^g\d+:/, '')))].sort()).toEqual(['d:c1', 'd:c2', 'd:c3'])
  await dots.find(b => b.key.endsWith(':d:c1')).onPress()
  const one = paneNow(s).args
  expect(one).toMatchObject({ claim: 'c1' })
  const picked = await draw(one)
  const pt = textOf(picked)
  expect(pt).toContain('● failures · 2 claims')
  expect(pt).toContain('  ▸ Run 4 failed on the p95 check.    cites nothing  turn 1  – Run 9 failed on a timeout.')
  expect(pt).not.toContain('It cites nothing.')
  expect(keysOf(picked)).toEqual([['n', 'next'], ['p', 'previous'], ['e', 'evidence']])
  // the claim is bold; its dot again selects its cluster
  expect(JSON.stringify(picked)).toContain('"bold":true,"children":"Run 4 failed on the p95 check."')
  await buttons(picked).find(b => /^g\d+:d:c1$/.test(b.key)).onPress()
  expect(paneNow(s).args).toMatchObject({ group: 'k1' })
  // a claim in the panel of a cluster selects it
  await buttons(cluster).find(b => /^p\d+:n:c2$/.test(b.key)).onPress()
  expect(paneNow(s).args).toMatchObject({ claim: 'c2' })
  // the cluster's name above the claim selects the cluster again; n the next cluster, the whole of it
  await buttons(picked).find(b => /^p\d+:g:k1$/.test(b.key)).onPress()
  expect(paneNow(s).args).toMatchObject({ group: 'k1' })
  await buttons(picked).find(b => b.hotkey === 'n').onPress()
  expect(paneNow(s).args).toMatchObject({ group: 'k2' })
  expect(paneNow(s).args.claim).toBeUndefined()
  // a dot of another cluster selects its claim
  await buttons(picked).find(b => /^g\d+:d:c3$/.test(b.key)).onPress()
  expect(paneNow(s).args).toMatchObject({ claim: 'c3' })
  // e: its evidence under it, and e again closes it; where it was said opens the message with the claim's words, and b
  // back to the evidence
  await buttons(picked).find(b => b.hotkey === 'e').onPress()
  expect(paneNow(s).args).toMatchObject({ claim: 'c1', open: true, cite: 0 })
  const open = await draw(paneNow(s).args)
  expect(textOf(open)).toContain('    cites nothing  turn 1     It cites nothing.    said in turn 1: "Run 4 failed on the p95 check"')
  expect(keysOf(open)).toEqual([['n', 'next'], ['p', 'previous'], ['e', 'close']])
  await buttons(open).find(b => b.hotkey === 'e').onPress()
  expect(paneNow(s).args.open).toBeUndefined()
  await buttons(open).find(b => /^p\d+:src$/.test(b.key)).onPress()
  const src = paneNow(s)
  expect(src.args).toMatchObject({ source: 'c1', row: 't1-row-0' })
  const said = await drawClaimsPane(s.$, { props: { bodyColumns: 100 } }, src.args, els)
  expect(textOf(said)).toContain("Where it was said  Claude's message")
  expect(buttons(said).filter(b => b.hotkey).map(b => b.hotkey)).toEqual(['b'])
  await buttons(said).find(b => b.hotkey === 'b').onPress()
  expect(paneNow(s).args).toMatchObject({ claim: 'c1', open: true })
})

test('a corrected claim says corrected under it; e opens its history: what it said before and why it changed, as the claims look gave it', async () => {
  setOptions({})
  const s = setup([
    reply([{ claim: 'The deletions began June 23.', quote: 'The deletions began June 23', cluster: 'cleanup' }]),
    reply([{ claim: 'The deletions came from June 23 to July 14, after the edits stopped.', quote: 'The deletions came from June 23 to July 14', revises: 'c1', why: '444 of the deletions came before June 23' }]),
  ])
  await s.call('session.start', { cwd: '/made-up/data', isInteractive: true }, async () => ({}))
  await answered(s, { id: 't1', prompt: 'When did the deletions start?', rows: ['The deletions began June 23.'] })
  await answered(s, { id: 't2', prompt: 'Sure?', rows: ['The deletions came from June 23 to July 14, after the edits stopped.'] })
  expect((await claimsStore(s.$)).claims.find((c: Any) => c.id === 'c2')?.why).toBe('444 of the deletions came before June 23')
  const draw = (args: Any) => drawClaimsPane(s.$, { props: { bodyColumns: 100, scroll: { bodyRows: 30 } } }, args, els)
  const shut = await draw({ claim: 'c2' })
  expect(textOf(shut)).toContain('    cites nothing  corrected  turn 2')
  expect(textOf(shut)).not.toContain('History')
  expect(buttons(shut).filter(b => b.hotkey).map(b => b.hotkey)).toEqual(['e'])
  await buttons(shut).find(b => b.hotkey === 'e').onPress()
  const pane = await draw(paneNow(s).args)
  const t = textOf(pane)
  expect(t).toContain('    History    turn 1  "The deletions began June 23."    why it changed: 444 of the deletions came before June 23.')
  // a press on the earlier words selects the earlier claim
  await buttons(pane).find(b => /^p\d+:was-c1$/.test(b.key)).onPress()
  expect(paneNow(s).args).toMatchObject({ claim: 'c1' })
})
