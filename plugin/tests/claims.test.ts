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
import { claimsStore, openClaims } from '../claims/term'
import { failLineNow } from '../bar/notice'
import { promptStub, tempRun } from './stubs'
import { treeRows } from '../core/trail.mjs'

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
  setOptions({ claimsMode: 'auto' })
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
  // the session's first claims: the count says `new` until the pane is first opened
  expect((await claimsBar(s.$, () => true, false)).map(x => [x.key, x.words])).toEqual([['c', '2 claims · new']])
  // the next look reads every claim so far
  await answered(s, { id: 't2', prompt: 'Are you sure?', rows: ['The edits were not biased: one editor tilted them.'] })
  expect(s.forks[1]).toContain('PROMPT lens-claims')
  expect((await claimsBar(s.$, () => true, false)).map(x => [x.words, x.color])).toEqual([['3 claims · new', 'merged']])
  // opened once, the count no longer says new
  await openClaims(s.$)
  expect((await claimsBar(s.$, () => true, false)).map(x => x.words)).toEqual(['3 claims'])
  // switched off, c is not on the bar and the key is typed
  expect(await claimsBar(s.$, k => k !== 'claims', false)).toEqual([])
})

/** The first node with this key. */
const findKey = (node: Any, key: string): Any => {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) { for (const n of node) { const f = findKey(n, key); if (f) return f } return null }
  if (node.props?.key === key) return node
  return findKey(node.props?.children, key)
}

test('a look that fails leaves a gap the pane names; c opens the pane: the map on top, n at rest; a cluster chosen lists its claims, k j e; a claim picked takes the pane, its cluster on top, its cards; a dot picks its claim', async () => {
  setOptions({ claimsMode: 'auto' })
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
  const draw = (args: Any) => drawClaimsPane(s.$, { props: { bodyColumns: 100, scroll: { bodyRows: 36 } } }, args, els)
  const keysOf = (pane: Any) => buttons(pane).filter(b => b.hotkey).map(b => [b.hotkey, b.label])
  const pane = await draw({})
  const t = textOf(pane)
  expect(t).toContain('Claims · 3 claims')
  expect(t).not.toContain('clusters')
  expect(t).toContain('Turn 2 was not read:')
  // a few claims are drawn as a map too, nothing chosen, nothing under it; no caption, and no words about clicks
  const dots = buttons(pane).filter(b => /^g\d+:d:/.test(b.key))
  expect(new Set(dots.map(b => b.key.replace(/^g\d+:/, ''))).size).toBe(3)
  expect(t).not.toMatch(/click|─{10}/)
  // at rest: f (the answer whose look failed waits to be read) and n, the first cluster; a plain Button Claude Code
  // draws as its key, then its words, dim; under the pointer its words brighten, never Claude Code's inverse
  expect(keysOf(pane)).toEqual([['f', 'extract claims of the newest answer'], ['n', 'first cluster']])
  expect(buttons(pane).filter(b => b.hotkey).map(b => b.hover?.inverse)).toEqual([false, false])
  await buttons(pane).find(b => b.hotkey === 'n').onPress()
  expect(paneNow(s).args).toMatchObject({ group: 'k1' })
  // a press on a cluster's name on the map chooses it
  await buttons(pane).find(b => /^g\d+:g:k2$/.test(b.key)).onPress()
  expect(paneNow(s).args).toMatchObject({ group: 'k2' })
  // a cluster chosen: its name bold in its color, its claims one line each, numbered, the first current
  const cluster = await draw({ group: 'k1' })
  const ct = textOf(cluster)
  expect(ct).toContain('failures · 2 claims')
  expect(ct).toContain('▸ 1. Run 4 failed on the p95 check.')
  expect(ct).toContain('  2. Run 9 failed on a timeout.')
  expect(JSON.stringify(cluster)).toMatch(/"color":"#[0-9a-f]{6}","bold":true,"children":"failures"/)
  // its current claim's dot on the map is inverse in the cluster's color, the same ●
  expect(JSON.stringify(cluster)).toMatch(/"color":"#[0-9a-f]{6}","bold":true,"inverse":true,"children":"●"/)
  // k j move the current claim (the ends hold), e opens it, p n the other clusters; each move keeps the keyboard
  expect(keysOf(cluster)).toEqual([['k', 'previous claim'], ['j', 'next claim'], ['e', 'open claim'], ['p', 'previous cluster'], ['n', 'next cluster']])
  await buttons(cluster).find(b => b.hotkey === 'j').onPress()
  expect(paneNow(s).args).toMatchObject({ group: 'k1', cur: 1 })
  expect(s.opened.at(-1)).toMatchObject({ id: 'thimble', focus: true })
  await buttons(cluster).find(b => b.hotkey === 'k').onPress()
  expect(paneNow(s).args).toMatchObject({ group: 'k1', cur: 0 })
  const second = await draw({ group: 'k1', cur: 1 })
  expect(textOf(second)).toContain('▸ 2. Run 9 failed on a timeout.')
  await buttons(second).find(b => b.hotkey === 'e').onPress()
  expect(paneNow(s).args).toMatchObject({ claim: 'c2' })
  await buttons(cluster).find(b => b.hotkey === 'n').onPress()
  expect(paneNow(s).args).toMatchObject({ group: 'k2' })
  // a press on a claim of the list picks it
  await buttons(cluster).find(b => /^p\d+:n:c1$/.test(b.key)).onPress()
  expect(paneNow(s).args).toMatchObject({ claim: 'c1' })
  // a claim picked: the map gone, its cluster on top, the claim bold (its reply's sentence only says it again, so no
  // description), and its evidence hidden: one line that e (or a press) shows it on
  const picked = await draw({ claim: 'c1' })
  const pt = textOf(picked)
  expect(buttons(picked).some(b => /:d:/.test(b.key))).toBe(false)
  expect(pt).toContain('failures · 1 of 2')
  expect(pt).toContain('Run 4 failed on the p95 check.')
  expect(pt).not.toContain('╭─')
  expect(pt).not.toContain('Run 9 failed on a timeout')
  expect(keysOf(picked)).toEqual([['e', 'show evidence (1 citation)'], ['k', 'previous claim'], ['j', 'next claim']])
  await buttons(picked).find(b => b.hotkey === 'e').onPress()
  expect(paneNow(s).args).toMatchObject({ claim: 'c1', open: true, cite: 0 })
  // its citation as the tray's card in a frame; its reply has no check in the store: it did not run, so the citation
  // is failed; the card is one press that opens it as a press on it in the reply does
  const shown = await draw({ claim: 'c1', open: true })
  const st = textOf(shown)
  expect(st).toMatch(/│ p95 check +× failed │/)
  expect(st).toContain('The check did not run.')
  expect(buttons(shown).some(b => /^p\d+:ev:0$/.test(b.key) && textOf(b.children).includes('p95 check'))).toBe(true)
  // one citation: k j still the claims; e hides it, back to the claim
  expect(keysOf(shown)).toEqual([['e', 'hide evidence'], ['k', 'previous claim'], ['j', 'next claim']])
  await buttons(shown).find(b => b.hotkey === 'e').onPress()
  expect(paneNow(s).args.open).toBeUndefined()
  await buttons(picked).find(b => b.hotkey === 'j').onPress()
  expect(paneNow(s).args).toMatchObject({ claim: 'c2' })
  await buttons(picked).find(b => b.hotkey === 'k').onPress()
  expect(paneNow(s).args).toMatchObject({ claim: 'c1' })
  // a press on the claim keeps it picked, so a question below asks about it
  const was = paneNow(s).args
  await buttons(picked).find(b => /^p\d+:c:c1$/.test(b.key)).onPress()
  expect(paneNow(s).args).toEqual(was)
  // a claim with no citation: one dim line, no card, no e
  const bare = await draw({ claim: 'c2' })
  expect(textOf(bare)).toContain('No citation: the reply cites no record for it.')
  expect(textOf(bare)).not.toContain('╭')
  expect(keysOf(bare)).toEqual([['k', 'previous claim'], ['j', 'next claim']])
  // its cluster's name on top chooses the cluster, with the claim it came from current
  await buttons(bare).find(b => /^p\d+:g:k1$/.test(b.key)).onPress()
  expect(paneNow(s).args).toMatchObject({ group: 'k1', cur: 1 })
  // a press on a dot on the map picks its claim
  await buttons(cluster).find(b => /^g\d+:d:c3$/.test(b.key)).onPress()
  expect(paneNow(s).args).toMatchObject({ claim: 'c3' })
  // where a claim was said: the message with the claim's words, and b back
  const said = await drawClaimsPane(s.$, { props: { bodyColumns: 100 } }, { claim: 'c1', source: 'c1', row: 't1-row-0' }, els)
  expect(textOf(said)).toContain("Where it was said  Claude's message")
  expect(buttons(said).filter(b => b.hotkey).map(b => b.hotkey)).toEqual(['b'])
  await buttons(said).find(b => b.hotkey === 'b').onPress()
  expect(paneNow(s).args).toMatchObject({ claim: 'c1' })
})

test('a claim with several citations: e shows them; k j make the next one current; a line of one makes it current; d u scroll a tall detail', async () => {
  setOptions({ claimsMode: 'auto' })
  const s = setup([reply([{ claim: 'Runs 4, 5 and 6 failed.', quote: 'Run 4 failed. Run 5 failed. Run 6 failed', cluster: 'failures', because: 'Each run log ends at a failed check.' }])])
  await s.call('session.start', { cwd: '/made-up/data', isInteractive: true }, async () => ({}))
  const text = '[Run 4 failed](#). [Run 5 failed](#). [Run 6 failed](#). [Run 7 passed](#).'
  await answered(s, { id: 't1', prompt: 'Which runs failed?', rows: [text] })
  const draw = (args: Any, H = 40) => drawClaimsPane(s.$, { props: { bodyColumns: 60, scroll: { bodyRows: H } } }, args, els)
  const keysOf = (pane: Any) => buttons(pane).filter(b => b.hotkey).map(b => [b.hotkey, b.label])
  const store = await claimsStore(s.$)
  const n = store.claims[0].sources.length
  expect(n).toBeGreaterThan(1)
  const pane = await draw({ claim: 'c1' })
  expect(textOf(pane)).toContain('Each run log ends at a failed check.')
  expect(textOf(pane)).toContain(`show evidence (${n} citations)`)
  // its evidence shown: k j the citation before or after the current one
  const open = await draw({ claim: 'c1', open: true })
  expect(keysOf(open).slice(0, 3)).toEqual([['e', 'hide evidence'], ['k', 'previous citation'], ['j', 'next citation']])
  await buttons(open).find(b => b.hotkey === 'j').onPress()
  expect(paneNow(s).args).toMatchObject({ claim: 'c1', open: true, cite: 1 })
  // a short pane: one frame, the current citation whole and the others one line each, a press that makes it current
  const short = await draw({ claim: 'c1', open: true, cite: 1 }, 18)
  const lines = buttons(short).filter(b => /:at:\d+$/.test(b.key))
  expect(lines.length).toBe(n - 1)
  await lines[0].onPress()
  expect(paneNow(s).args).toMatchObject({ claim: 'c1', open: true, cite: 0 })
  expect(treeRows(short, 60)).toBeLessThanOrEqual(18)
  expect(textOf(short)).toContain('├')
  // a detail that fits: no d u; one taller than its room: d u scroll it, the cluster staying on top
  expect(keysOf(pane).map(k => k[0])).not.toContain('d')
  s.$.ui.invalidate = () => undefined
  const tight = await draw({ claim: 'c1', open: true, cite: 0 }, 12)
  expect(keysOf(tight).filter(k => k[0] === 'd' || k[0] === 'u')).toEqual([['d', 'scroll down'], ['u', 'scroll up']])
  const before = textOf(tight)
  expect(before).toMatch(/↓ \d+ more lines?/)
  await buttons(tight).find(b => b.hotkey === 'd').onPress()
  const after = textOf(await draw({ claim: 'c1', open: true, cite: 0 }, 12))
  expect(after).toMatch(/↑ \d+ more lines?/)
  expect(after.trimStart().startsWith('failures')).toBe(true)
  await buttons(tight).find(b => b.hotkey === 'u').onPress()
  expect(textOf(await draw({ claim: 'c1', open: true, cite: 0 }, 12))).toBe(before)
})

test("a narrow pane whose keys wrap: the map and the claim's detail keep to the rows the pane gives, keys included", async () => {
  setOptions({ claimsMode: 'auto' })
  const many = Array.from({ length: 10 }, (_, i) => ({ claim: `Run ${i + 1} failed on a long and slow p95 check of the nightly batch.`, quote: `Run ${i + 1} failed`, cluster: i < 5 ? 'failures' : 'slow runs' }))
  const s = setup([reply(many)])
  await s.call('session.start', { cwd: '/made-up/data', isInteractive: true }, async () => ({}))
  await answered(s, { id: 't1', prompt: 'Which runs failed?', rows: [many.map(c => `${c.quote} on a long and slow p95 check of the nightly batch.`).join(' ')] })
  // every height: a detail that fills its room would otherwise lose its last rows under the pane's edge
  for (const W of [48, 70]) {
    for (let H = 24; H <= 44; H++) {
      const claim = await drawClaimsPane(s.$, { props: { bodyColumns: W, scroll: { bodyRows: H } } }, { claim: 'c2' }, els)
      expect(textOf(claim)).toContain('No citation')
      expect(`${W}x${H}: ${treeRows(claim, W)}`).toBe(`${W}x${H}: ${Math.min(H, treeRows(claim, W))}`)
      // a cluster chosen: its five keys, more than one row of a narrow pane
      const pane = await drawClaimsPane(s.$, { props: { bodyColumns: W, scroll: { bodyRows: H } } }, { group: 'k1' }, els)
      expect(`${W}x${H}: ${treeRows(pane, W)}`).toBe(`${W}x${H}: ${Math.min(H, treeRows(pane, W))}`)
      // the keys come in rows no wider than the pane as Claude Code draws them, each key with its `k: `
      const drawnWidth = (row: Any) => (row.props.children as Any[]).reduce((n: number, c: Any) => n + (c.type === 'Button' ? c.props.hotkey.length + 2 : 0) + [...textOf(c)].length, 0)
      const rows = (findKey(pane, 'keys').props.children as Any[])
      for (const r of rows) expect(drawnWidth(r)).toBeLessThanOrEqual(W)
      if (W < 50) expect(rows.length).toBeGreaterThan(1)
    }
  }
})

test("a picked claim's sentences of the reply read as the reply does: a figure the check corrected stands corrected", async () => {
  setOptions({ claimsMode: 'auto' })
  const s = setup([reply([
    { claim: 'The admin deleted pages for four weeks.', quote: 'The admin then spent four weeks', cluster: 'cleanup' },
    { claim: 'The admin deleted 5,217 pages.', quote: 'deleted 5,217 pages', cluster: 'cleanup' },
  ])])
  await s.call('session.start', { cwd: '/made-up/data', isInteractive: true }, async () => ({}))
  const text = 'The admin then spent four weeks cleaning up and [deleted 5,217 pages](#), each marked deleted.'
  await answered(s, { id: 't1', prompt: 'What did the admin do?', rows: [text] })
  const row = 't1-row-0'
  const at = text.indexOf('[deleted')
  await s.$.state.set({ plugin: 'thimble', key: 'marksRow', id: row }, 'reply-1')
  await s.$.state.set({ plugin: 'thimble', key: 'marks', id: 'reply-1' }, { key: 'reply-1', turnId: 't1', rows: [row], startedAt: 0, settledAt: 1, items: [
    { n: 1, row, words: 'deleted 5,217 pages', start: at, end: at + 22, sentence: text, status: 'corrected', shown: 'deleted 5,144 pages', was: 'deleted 5,217 pages' },
  ] })
  const draw = (args: Any) => drawClaimsPane(s.$, { props: { bodyColumns: 100, scroll: { bodyRows: 40 } } }, args, els)
  const other = textOf(await draw({ claim: 'c1' }))
  expect(other).toContain('The admin then spent four weeks cleaning up and deleted 5,144 pages, each marked deleted.')
  // a claim whose own words the check changed is found in the words Claude wrote
  expect(textOf(await draw({ claim: 'c2' }))).toContain('The admin then spent four weeks')
})

test('c in a terminal too narrow for the pane says to type /claims; once /claims opens the pane, that line goes', async () => {
  setOptions({ claimsMode: 'auto' })
  const s = setup([reply([{ claim: 'Run 4 failed.', quote: 'Run 4 failed', cluster: 'failures' }])])
  await s.call('session.start', { cwd: '/made-up/data', isInteractive: true }, async () => ({}))
  await answered(s, { id: 't1', prompt: 'Which runs failed?', rows: ['[Run 4 failed](#).'] })
  const line = async () => ((await failLineNow(s.$)) as Any)?.text ?? ''
  s.$.ui.open = async (o: Any) => { s.opened.push(o); return { isPlaced: false } }
  await (await claimsKey(s.$, 'c', 0))!.later!()
  await settle()
  expect(await line()).toContain('type /claims')
  // a command's pane is placed at any width
  s.$.ui.open = async (o: Any) => { s.opened.push(o); return { isPlaced: true } }
  await s.call('command.run', { command: 'claims' }, async () => ({}))
  await settle()
  expect(s.opened.at(-1)).toMatchObject({ id: 'thimble', title: 'Claims' })
  expect(await line()).toBe('')
})

test("x on a failed citation in the pane checks it again in the background, started in the claims' ui.press hook", async () => {
  setOptions({ claimsMode: 'auto' })
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
  expect(t).toMatch(/│ p95 check +× failed │/)
  expect(t).toContain('No file names a p95 check.')
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


test('claims on demand: no look reads them after a reply; c shows the pane with f, which finds the claims of the answers not read, alone', async () => {
  // the explainers and heads-ups off, so a look after a reply would be the claims' alone
  setOptions({ explain: false, details: false })
  const replies = [reply([{ claim: 'Run 4 failed on the p95 check.', quote: 'Run 4 failed on the p95 check', cluster: 'failures', because: 'Its log ends at the [p95 check](#).' }])]
  const s = setup(replies)
  await s.call('session.start', { cwd: '/made-up/data', isInteractive: true }, async () => ({}))
  await answered(s, { id: 't1', prompt: 'Which runs failed?', rows: ['Run 4 failed on the [p95 check](#).'] })
  // the reply's look did not run: none of its lenses is on after each reply
  expect(s.forks).toEqual([])
  expect((await claimsStore(s.$)).claims).toEqual([])
  // the bar names the pane, with no count, once an answer waits
  expect((await claimsBar(s.$, () => true, false)).map(x => [x.key, x.words])).toEqual([['c', 'claims']])
  const draw = (args: Any) => drawClaimsPane(s.$, { props: { bodyColumns: 100, scroll: { bodyRows: 30 } } }, args, els)
  const empty = await draw({})
  expect(textOf(empty)).toContain('Claims · no claims yet')
  expect(textOf(empty)).not.toContain('to save tokens')
  const f = buttons(empty).find(b => b.hotkey === 'f')
  expect([f?.key, f?.label]).toEqual(['claims-find', 'extract claims'])
  // f: a look of the claims lens alone over that answer; the claims come in, and f is offered no more
  const r = await s.call('ui.press', { plugin: 'thimble', element: 'claims-find', component: 'Pane', requestId: 'thimble', surface: 'terminal' }, async () => ({ element: 'none' }))
  expect(r).toEqual({ element: 'claims-find' })
  expect(textOf(await draw({}))).toContain('Finding the claims of 1 answer…')
  await settle()
  await drainNow(s.$)
  await settle()
  expect(s.forks.length).toBe(1)
  expect(s.forks[0]).toContain('PROMPT lens-claims')
  expect(s.forks[0]).not.toContain('PROMPT lens-explain')
  const store = await claimsStore(s.$)
  expect(store.claims.map((c: Any) => [c.id, c.because])).toEqual([['c1', 'Its log ends at the [p95 check](#).']])
  expect(store.read).toEqual(['t1-row-0'])
  const found = await draw({})
  expect(buttons(found).some(b => b.hotkey === 'f')).toBe(false)
  expect(textOf(found)).not.toContain('Finding')
  expect((await claimsBar(s.$, () => true, false)).map(x => x.words)).toEqual(['1 claim · new'])
  // a newer answer waits: f offers it alone
  await answered(s, { id: 't2', prompt: 'Why?', rows: ['The cache was cold.'] })
  expect(s.forks.length).toBe(1)
  expect(buttons(await draw({})).find(b => b.hotkey === 'f')?.label).toBe('extract claims of the newest answer')
  // the claim's description under it (the lens's `because`), plain, then its citation's card
  const picked = await draw({ claim: 'c1', open: true })
  expect(textOf(picked)).toContain('Its log ends at the p95 check.')
  expect(buttons(picked).some(b => /:ev:0$/.test(b.key) && textOf(b.children).includes('p95 check'))).toBe(true)
  // Claims found auto: the look after each reply reads them again
  setOptions({ explain: false, details: false, claimsMode: 'auto' })
  replies.push(reply([]))
  await answered(s, { id: 't3', prompt: 'And run 5?', rows: ['Run 5 passed.'] })
  expect(s.forks.length).toBe(2)
  expect(s.forks[1]).toContain('PROMPT lens-claims')
  setOptions({})
})
