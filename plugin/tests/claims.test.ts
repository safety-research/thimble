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
  expect((await claimsBar(s.$, () => true, false)).map(x => [x.words, x.color])).toEqual([['3 claims', 'merged']])
  // switched off, c is not on the bar and the key is typed
  expect(await claimsBar(s.$, k => k !== 'claims', false)).toEqual([])
})

test('a look that fails leaves a gap the pane names; c opens the pane, a short session as a list where a press on a name selects a cluster and a press on a claim picks it; the map comes with ten claims, a press on a dot its claim', async () => {
  setOptions({})
  const more = Array.from({ length: 7 }, (_, i) => ({ claim: `Run ${i + 11} passed.`, quote: `Run ${i + 11} passed`, cluster: 'passes' }))
  const replies = [reply([
    { claim: 'Run 4 failed on the p95 check.', quote: 'Run 4 failed on the p95 check', cluster: 'failures' },
    { claim: 'Run 9 failed on a timeout.', quote: 'Run 9 failed on a timeout', cluster: 'failures' },
    { claim: 'The cache was cold.', quote: 'The cache was cold', cluster: 'causes' },
  ])]
  const s = setup(replies)
  await s.call('session.start', { cwd: '/made-up/data', isInteractive: true }, async () => ({}))
  await answered(s, { id: 't1', prompt: 'Which runs failed?', rows: ['Run 4 failed on the [p95 check](#). Run 9 failed on a timeout. The cache was cold.'] })
  await answered(s, { id: 't2', prompt: 'Why?', rows: ['Because of the cache.'] })
  const take = await claimsKey(s.$, 'c', 0)
  expect(take?.later).toBeDefined()
  // a narrow terminal: Claude Code places no pane for a key at the prompt there, so the notice names the bar's count,
  // a click on which opens it
  const placing = s.$.ui.open
  s.$.ui.open = async () => ({ isPlaced: false, reason: 'unasked below 144 columns (118 now)' })
  s.$.ui.panes = async () => []
  await take!.later!()
  await new Promise(r => setTimeout(r, 1))
  expect(String(((await s.$.state.get({ plugin: 'thimble', key: 'failLine' })).value as Any)?.text)).toContain('“c 3 claims”')
  s.$.ui.open = placing
  await take!.later!()
  expect(s.opened.at(-1)).toMatchObject({ id: 'thimble', title: 'Claims', focus: true })
  const draw = (args: Any) => drawClaimsPane(s.$, { props: { bodyColumns: 100, scroll: { bodyRows: 30 } } }, args, els)
  const keysOf = (pane: Any) => buttons(pane).filter(b => b.hotkey).map(b => [b.hotkey, b.label])
  const pane = await draw({})
  const t = textOf(pane)
  expect(t).toContain('Claims · 3 claims · 2 clusters')
  expect(t).toContain('Turn 2 was not read:')
  // three claims are too few for a map: every cluster is listed, its name then its claims, nothing chosen
  expect(t).toContain('● failures · 2 claims  – Run 4 failed on the p95 check.  – Run 9 failed on a timeout. ● causes · 1 claim  – The cache was cold.')
  expect(buttons(pane).some(b => /:d:/.test(b.key))).toBe(false)
  // the keys, each once, k j then p n: a plain Button Claude Code draws as its key, then its words, dim; the words
  // never hold the key, which drew it twice. At rest too every key of the pane is held, so none is typed into the prompt
  expect(keysOf(pane)).toEqual([['k', 'previous claim'], ['j', 'next claim'], ['p', 'previous'], ['n', 'next']])
  expect(buttons(pane).filter(b => b.hotkey).map(b => textOf(b.children))).toEqual(['previous claim', 'next claim', 'previous', 'next'])
  // under the pointer a key's words brighten, never Claude Code's inverse of a plain Button
  expect(buttons(pane).filter(b => b.hotkey).map(b => b.hover?.inverse)).toEqual([false, false, false, false])
  expect(t).toContain('previous · next')
  // at rest n chooses the first cluster in reading order (the list's top), p the last; j the first claim, k the last
  await buttons(pane).find(b => b.hotkey === 'n').onPress()
  expect(paneNow(s).args).toMatchObject({ group: 'k1' })
  await buttons(pane).find(b => b.hotkey === 'p').onPress()
  expect(paneNow(s).args).toMatchObject({ group: 'k2' })
  await buttons(pane).find(b => b.hotkey === 'j').onPress()
  expect(paneNow(s).args).toMatchObject({ claim: 'c1' })
  await buttons(pane).find(b => b.hotkey === 'k').onPress()
  expect(paneNow(s).args).toMatchObject({ claim: 'c3' })
  // a press on a cluster's name chooses the cluster: its name bold in its color
  const name = buttons(pane).find(b => /^p\d+:g:k1$/.test(b.key))
  expect(name).toBeDefined()
  await name.onPress()
  const failures = paneNow(s).args
  expect(failures).toMatchObject({ group: 'k1' })
  const cluster = await draw(failures)
  expect(textOf(cluster)).toContain('● failures · 2 claims')
  expect(textOf(cluster)).toContain('  – Run 4 failed on the p95 check.')
  expect(textOf(cluster)).toContain('  – Run 9 failed on a timeout.')
  // a cluster chosen: k j pick its claims (none picked yet: j the first, k the last), so every key of the pane stays
  // in it; each move keeps the keyboard in the pane, a click's too
  expect(keysOf(cluster)).toEqual([['k', 'previous claim'], ['j', 'next claim'], ['p', 'previous'], ['n', 'next']])
  await buttons(cluster).find(b => b.hotkey === 'j').onPress()
  expect(paneNow(s).args).toMatchObject({ claim: 'c1' })
  expect(s.opened.at(-1)).toMatchObject({ id: 'thimble', focus: true })
  await buttons(cluster).find(b => b.hotkey === 'k').onPress()
  expect(paneNow(s).args).toMatchObject({ claim: 'c2' })
  expect(JSON.stringify(cluster)).toMatch(/"color":"#[0-9a-f]{6}","bold":true,"children":"failures"/)
  // a press on a claim picks it, of any cluster: the list stays, the claim ▸ with its chips under it, and e opens its
  // evidence
  await buttons(pane).find(b => /^p\d+:n:c1$/.test(b.key)).onPress()
  const one = paneNow(s).args
  expect(one).toMatchObject({ claim: 'c1' })
  const picked = await draw(one)
  const pt = textOf(picked)
  expect(pt).toContain('● failures · 2 claims')
  expect(pt).toContain('  ▸ Run 4 failed on the p95 check.    × 1 citation failed  turn 1  – Run 9 failed on a timeout.')
  expect(pt).toContain('– The cache was cold.')
  expect(keysOf(picked)).toEqual([['k', 'previous claim'], ['j', 'next claim'], ['p', 'previous'], ['n', 'next'], ['e', 'evidence']])
  await buttons(picked).find(b => b.hotkey === 'j').onPress()
  expect(paneNow(s).args).toMatchObject({ claim: 'c2' })
  // the claim is bold in its cluster's color; a press on it again chooses its cluster
  expect(JSON.stringify(picked)).toMatch(/"color":"#[0-9a-f]{6}","bold":true,"children":"Run 4 failed on the p95 check\."/)
  await buttons(picked).find(b => /^p\d+:c:c1$/.test(b.key) && textOf(b.children).includes('Run 4')).onPress()
  expect(paneNow(s).args).toMatchObject({ group: 'k1' })
  // a claim in the list of a cluster picks it
  await buttons(cluster).find(b => /^p\d+:n:c2$/.test(b.key)).onPress()
  expect(paneNow(s).args).toMatchObject({ claim: 'c2' })
  expect(s.opened.at(-1)).toMatchObject({ id: 'thimble', focus: true })
  // the cluster's name above the claim chooses the cluster again; n the next cluster, the whole of it
  await buttons(picked).find(b => /^p\d+:g:k1$/.test(b.key) && textOf(b.children).includes('failures')).onPress()
  expect(paneNow(s).args).toMatchObject({ group: 'k1' })
  await buttons(picked).find(b => b.hotkey === 'n').onPress()
  expect(paneNow(s).args).toMatchObject({ group: 'k2' })
  expect(paneNow(s).args.claim).toBeUndefined()
  // a claim of another cluster picks it
  await buttons(picked).find(b => /^p\d+:n:c3$/.test(b.key)).onPress()
  expect(paneNow(s).args).toMatchObject({ claim: 'c3' })
  // e: the claim and its evidence, as the citation's card draws it, the list gone; e again closes it
  await buttons(picked).find(b => b.hotkey === 'e').onPress()
  expect(paneNow(s).args).toMatchObject({ claim: 'c1', open: true, cite: 0 })
  const open = await draw(paneNow(s).args)
  // its reply has no check in the store: it did not run, so the citation is failed
  expect(textOf(open)).toContain('p95 check   × failed · cite')
  expect(textOf(open)).toContain('The check did not run.')
  expect(textOf(open)).toContain('‹ 1 of 1 ›')
  expect(textOf(open)).not.toContain('Run 9 failed')
  expect(textOf(open)).not.toContain('The cache was cold')
  expect(textOf(open)).not.toContain('said in')
  // one citation: k j walk the cluster's claims, and p n its clusters, as with the evidence closed
  expect(keysOf(open)).toEqual([['k', 'previous claim'], ['j', 'next claim'], ['p', 'previous'], ['n', 'next'], ['e', 'close']])
  // a claim with no citations: e is held, and says so; its press changes nothing
  const bare = await draw({ claim: 'c2' })
  expect(textOf(bare)).toContain('    no citations  turn 1')
  expect(keysOf(bare)).toEqual([['k', 'previous claim'], ['j', 'next claim'], ['p', 'previous'], ['n', 'next'], ['e', 'no citations']])
  const before = paneNow(s).args
  await buttons(bare).find(b => b.hotkey === 'e').onPress()
  expect(paneNow(s).args).toEqual(before)
  await buttons(open).find(b => b.hotkey === 'e').onPress()
  expect(paneNow(s).args.open).toBeUndefined()
  // where a claim was said: the message with the claim's words, and b back
  const said = await drawClaimsPane(s.$, { props: { bodyColumns: 100 } }, { claim: 'c1', open: true, source: 'c1', row: 't1-row-0' }, els)
  expect(textOf(said)).toContain("Where it was said  Claude's message")
  expect(buttons(said).filter(b => b.hotkey).map(b => b.hotkey)).toEqual(['b'])
  await buttons(said).find(b => b.hotkey === 'b').onPress()
  expect(paneNow(s).args).toMatchObject({ claim: 'c1', open: true })
  // ten claims: the map, at rest nothing under it; a press on a dot picks its claim, its dot again its cluster
  replies.push(reply(more))
  await answered(s, { id: 't3', prompt: 'And the rest?', rows: [more.map(c => c.claim).join(' ')] })
  const map = await draw({})
  expect(textOf(map)).toContain('Claims · 10 claims · 3 clusters')
  expect(textOf(map)).not.toContain('– The cache was cold.')
  const dots = buttons(map).filter(b => /^g\d+:d:/.test(b.key))
  expect(new Set(dots.map(b => b.key.replace(/^g\d+:/, ''))).size).toBe(10)
  await dots.find(b => b.key.endsWith(':d:c1')).onPress()
  expect(paneNow(s).args).toMatchObject({ claim: 'c1' })
  const onMap = await draw(paneNow(s).args)
  expect(textOf(onMap)).toContain('  ▸ Run 4 failed on the p95 check.    × 1 citation failed  turn 1  – Run 9 failed on a timeout.')
  await buttons(onMap).find(b => /^g\d+:d:c1$/.test(b.key)).onPress()
  expect(paneNow(s).args).toMatchObject({ group: 'k1' })
  await buttons(onMap).find(b => /^g\d+:d:c3$/.test(b.key)).onPress()
  expect(paneNow(s).args).toMatchObject({ claim: 'c3' })
})

test("x on a failed citation in the pane checks it again in the background, started in the claims' ui.press hook", async () => {
  setOptions({})
  const s = setup([reply([{ claim: 'Run 4 failed on the p95 check.', quote: 'Run 4 failed on the p95 check', cluster: 'failures' }])])
  const spawns: Any[] = []
  s.$.agent = { spawn: async (o: Any) => { spawns.push(o); return { agentId: 'agent-made-up-1' } } }
  s.$.ui.busy = async () => undefined
  await s.call('session.start', { cwd: '/made-up/data', isInteractive: true }, async () => ({}))
  await answered(s, { id: 't1', prompt: 'Which runs failed?', rows: ['Run 4 failed on the [p95 check](#).'] })
  // the check could not confirm the citation
  const row = 't1-row-0'
  const item = { n: 1, row, words: 'p95 check', start: 22, end: 31, sentence: 'Run 4 failed on the p95 check.', status: 'failed', failedBy: 'check', shown: 'p95 check', reason: 'No file names a p95 check.' }
  await s.$.state.set({ plugin: 'thimble', key: 'marks', id: row }, { key: row, turnId: 't1', rows: [row], startedAt: 0, settledAt: 1, items: [item] })
  await s.$.state.set({ plugin: 'thimble', key: 'marksRow', id: row }, row)
  const args = { claim: 'c1', open: true, cite: 0 }
  await s.$.state.set({ plugin: 'thimble', key: 'pane' }, { kind: 'claims', args })
  const pane = await drawClaimsPane(s.$, { props: { bodyColumns: 100, scroll: { bodyRows: 30 } } }, args, els)
  const t = textOf(pane)
  expect(t).toContain('× 1 citation failed')
  expect(t).toContain('p95 check   × failed · cite')
  expect(t).toContain('‹ 1 of 1 ›')
  expect(t).not.toMatch(/\?|wrong/)
  const x = buttons(pane).find(b => b.hotkey === 'x')
  expect([x?.key, x?.label]).toEqual(['claims-repair', 'repair'])
  // the press: a fork with the repair's request, and the citation checking again
  const r = await s.call('ui.press', { plugin: 'thimble', element: 'claims-repair', component: 'Pane', requestId: 'thimble', surface: 'terminal' }, async () => ({ element: 'none' }))
  expect(r).toEqual({ element: 'claims-repair' })
  expect(spawns.length).toBe(1)
  expect(spawns[0].description).toBe('checking a citation again (x)')
  expect(spawns[0].prompt).toContain('The analyst pressed x to repair citation 1.')
  const now = (s.state.get(JSON.stringify({ plugin: 'thimble', key: 'marks', id: row }))?.value as Any).items[0]
  expect([now.status, now.repair]).toEqual(['checking', true])
  // while it checks again, x stays and says so: a second x is not typed into the prompt
  const again = await drawClaimsPane(s.$, { props: { bodyColumns: 100, scroll: { bodyRows: 30 } } }, args, els)
  expect(buttons(again).filter(b => b.hotkey === 'x').map(b => [b.key, b.label])).toEqual([['key-x', 'checking again']])
})

