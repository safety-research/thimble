// Claims (claims/): the observer's claims lens places each answer's claims by their words; a look that fails leaves a
// gap the pane names; w opens the pane, where a cluster chosen lists its claims and a claim picked takes the pane. A
// citation's card there says what its check found as the reply's card does. All data is made up.
// `claude plugin test plugin`.
import { expect } from 'claude-code/testing'

import { registerAnswers, resetAnswers } from '../core/answers'
import { registerTell } from '../core/tell'
import { registerTurn } from '../core/turn'
import { drainNow, registerObserver, resetObserver } from '../observer/observer'
import { setOptions } from '../settings/features.mjs'
import { cardOf, correctionsOf } from '../claims/graph.js'
import { claimsBar, claimsKey, drawClaimsPane, registerClaims } from '../claims/seam'
import { readStore } from '../claims/store.js'
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
  registerTell(on, {} as never)
  registerAnswers(on, {} as never)
  registerObserver(on, {} as never)
  registerClaims(on, {} as never)
  const state = new Map<string, { value: unknown; version: number }>()
  const files = new Map<string, string>()
  const opened: Any[] = []
  let now = 1000
  const $: Any = {
    env: { get: async (k: string) => ({ THIMBLE_HOME: '/made-up/.thimble', TMPDIR: '/made-up/tmp' } as Any)[k] },
    plugin: { root: '/made-up/plugin', name: 'thimble' },
    session: { id: async () => 's-claims', cwd: async () => '/made-up/data', root: async () => '/made-up/data', messages: async () => [] },
    command: { register: async () => undefined },
    prompt: { submit: async () => undefined },
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
    model: { fork: async () => replies.shift() ?? { isAnswered: false, reason: 'empty-reply' } },
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
  return { $, call, opened, state }
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

/** The first node with this key. */
const findKey = (node: Any, key: string): Any => {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) { for (const n of node) { const f = findKey(n, key); if (f) return f } return null }
  if (node.props?.key === key) return node
  return findKey(node.props?.children, key)
}

test('a look that fails leaves a gap the pane names; w opens the pane: the map on top, n at rest; a cluster chosen lists its claims, k j e; a claim picked takes the pane, its cluster on top, its cards; a dot picks its claim; w closes it', async () => {
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
  // the bar names w, which takes the key; c is cite's alone: the claims do not take it
  expect((await claimsBar(s.$, () => true, false)).map(x => x.key)).toEqual(['w'])
  expect(await claimsKey(s.$, 'c', 0)).toBe(null)
  const take = await claimsKey(s.$, 'w', 0)
  expect(take?.later).toBeDefined()
  // a narrow terminal: Claude Code places no pane for a key at the prompt there, so the notice names the bar's count,
  // a click on which opens it
  const placing = s.$.ui.open
  s.$.ui.open = async () => ({ isPlaced: false, reason: 'unasked below 144 columns (118 now)' })
  s.$.ui.panes = async () => []
  await take!.later!()
  await new Promise(r => setTimeout(r, 1))
  expect(String(((await s.$.state.get({ plugin: 'thimble', key: 'failLine' })).value as Any)?.text)).toContain('“w 3 claims”')
  s.$.ui.open = placing
  await take!.later!()
  expect(s.opened.at(-1)).toMatchObject({ id: 'thimble', title: 'Claims', focus: true })
  // w again while the side pane shows the claims closes it, as r and l close theirs; once more opens it
  const closed: Any[] = []
  s.$.ui.close = async (o: Any) => { closed.push(o) }
  s.$.ui.panes = async () => [{ id: 'thimble' }]
  const opens = s.opened.length
  await (await claimsKey(s.$, 'w', 0))!.later!()
  expect(closed).toEqual([{ id: 'thimble' }])
  expect(paneNow(s)).toBe(null)
  expect(s.opened.length).toBe(opens)
  s.$.ui.panes = async () => []
  await (await claimsKey(s.$, 'w', 0))!.later!()
  expect(s.opened.at(-1)).toMatchObject({ id: 'thimble', title: 'Claims', focus: true })
  expect(paneNow(s)).toMatchObject({ kind: 'claims' })
  const draw = (args: Any) => drawClaimsPane(s.$, { props: { bodyColumns: 100, scroll: { bodyRows: 36 } } }, args, els)
  const keysOf = (pane: Any) => buttons(pane).filter(b => b.hotkey).map(b => [b.hotkey, b.label])
  // the key row ends with w close, a click alone: no Button takes w, so a w typed while the pane holds the keyboard goes
  // to the prompt, where w closes the pane once its word window closed, and a question that starts with w stays whole
  const closeOf = (pane: Any) => {
    const last = buttons(findKey(pane, 'keys')).at(-1)
    expect([last.key, last.hotkey, last.label, textOf(last.children)]).toEqual(['key-w', undefined, 'close', 'w: close'])
    return last
  }
  const pane = await draw({})
  const t = textOf(pane)
  expect(t).toContain('Claims · 3')
  expect(t).not.toContain('clusters')
  expect(t).toContain('Turn 2 was not read:')
  // a few claims are drawn as a map too, nothing chosen, nothing under it; no caption, and no words about clicks
  const dots = buttons(pane).filter(b => /^g\d+:d:/.test(b.key))
  expect(new Set(dots.map(b => b.key.replace(/^g\d+:/, ''))).size).toBe(3)
  expect(t).not.toMatch(/click|─{10}/)
  // at rest: f (the answer whose look failed waits to be read), n, the first cluster, and w close; a plain Button
  // Claude Code draws as its key, then its words, dim; under the pointer its words brighten, never Claude Code's inverse
  expect(keysOf(pane)).toEqual([['f', 'extract claims of the newest answer'], ['n', 'first cluster']])
  expect([...buttons(pane).filter(b => b.hotkey), closeOf(pane)].map(b => b.hover?.inverse)).toEqual([false, false, false])
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
  closeOf(cluster)
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
  // every key in the one row above the input, the last of the pane's rows; the evidence line in the detail a click
  expect(keysOf(picked)).toEqual([['k', 'previous claim'], ['j', 'next claim'], ['e', 'show evidence']])
  closeOf(picked)
  expect((picked as Any).props.children.at(-1).props.key).toBe('keys')
  expect(buttons(picked).some(b => !b.hotkey && /:evidence$/.test(b.key) && b.label === 'show evidence (1 citation)')).toBe(true)
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
  expect(keysOf(shown)).toEqual([['k', 'previous claim'], ['j', 'next claim'], ['e', 'hide evidence']])
  closeOf(shown)
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
  closeOf(bare)
  // its cluster's name on top chooses the cluster, with the claim it came from current
  await buttons(bare).find(b => /^p\d+:g:k1$/.test(b.key)).onPress()
  expect(paneNow(s).args).toMatchObject({ group: 'k1', cur: 1 })
  // a press on a dot on the map picks its claim
  await buttons(cluster).find(b => /^g\d+:d:c3$/.test(b.key)).onPress()
  expect(paneNow(s).args).toMatchObject({ claim: 'c3' })
  // where a claim was said: the message with the claim's words, b back, and w close
  const said = await drawClaimsPane(s.$, { props: { bodyColumns: 100 } }, { claim: 'c1', source: 'c1', row: 't1-row-0' }, els)
  expect(textOf(said)).toContain("Where it was said  Claude's message")
  expect(buttons(said).filter(b => b.hotkey).map(b => b.hotkey)).toEqual(['b'])
  closeOf(said)
  await buttons(said).find(b => b.hotkey === 'b').onPress()
  expect(paneNow(s).args).toMatchObject({ claim: 'c1' })
  // a click on w close closes it
  await closeOf(await draw({ claim: 'c1' })).onPress()
  expect(closed.length).toBe(2)
  expect(paneNow(s)).toBe(null)
})

/** A long claim, as the lens writes one: a full sentence with its numbers and qualifiers, past 200 characters. */
const LONG = "Across the 1,204 interviews the survey team coded, respondents who named their job lab-tech work were twice as likely to report unpaid overtime as any other role, by the survey's definition, which counts every hour past the contract."
const flat = (node: Any) => textOf(node).replace(/\s+/g, ' ')

test('a long claim is kept whole: its cluster lists it whole when current, a preview cut after a word with … when not, and e opens it whole', async () => {
  setOptions({ claimsMode: 'auto' })
  const s = setup([reply([
    { claim: LONG, quote: 'twice as likely to report unpaid overtime', cluster: 'overtime' },
    { claim: 'Nurses reported the least unpaid overtime.', quote: 'Nurses reported the least unpaid overtime', cluster: 'overtime' },
  ])])
  await s.call('session.start', { cwd: '/made-up/data', isInteractive: true }, async () => ({}))
  await answered(s, { id: 't1', prompt: 'Who works unpaid overtime?', rows: [`Lab techs were twice as likely to report unpaid overtime. Nurses reported the least unpaid overtime.`] })
  s.$.ui.panes = async () => []
  await (await claimsKey(s.$, 'w', 0))!.later!()
  const draw = (args: Any) => drawClaimsPane(s.$, { props: { bodyColumns: 100, scroll: { bodyRows: 36 } } }, args, els)
  // the current claim of its cluster: whole, wrapped, its own full stop, not cut at 200 characters (`… which cou.`)
  const cluster = flat(await draw({ group: 'k1' }))
  expect(cluster).toContain(LONG.split(' ').slice(-8).join(' '))
  expect(cluster).not.toContain('which cou.')
  // not current: one line, cut after a whole word, then …
  const other = flat(await draw({ group: 'k1', cur: 1 }))
  expect(other).toMatch(/ 1\. Across the 1,204 interviews[^…]* lab-tech …▸ 2\. Nurses/)
  expect(other).not.toContain('past the contract.')
  // e opens it: the claim picked shows it whole
  expect(flat(await draw({ claim: 'c1' }))).toContain(LONG)
})

test("a citation whose check rewrote its sentence: its card in the pane says its status and nothing of what the sentence was; History still shows the sentence before and after", () => {
  const lines = (s: Any) => cardOf(s, 90).rows.map((r: Any[]) => r.map((x: Any) => x.s).join(''))
  const rewritten = { status: 'corrected', repair: true, shown: 'port 9000', was: 'The app runs on port 8000.', now: 'The app runs on port 9000.', rewritten: true, reason: 'the README says 9000' }
  const card = lines(rewritten)
  expect(card[0]).toContain('✓ repaired')
  expect(card.join('\n')).not.toContain('sentence rewritten')
  expect(card.join('\n')).not.toContain('port 8000')
  // a citation whose words alone the check corrected still says what they were
  expect(lines({ status: 'corrected', shown: '12 of 40', was: '15 of 40' })).toContain('was 15 of 40')
  expect(correctionsOf({ id: 'c1', turn: 2, sources: [rewritten] }, new Map())).toMatchObject([{ old: 'The app runs on port 8000.', now: 'The app runs on port 9000.' }])
})

test('a store of v 2 kept a long claim cut at 200 characters, in a word: read, it ends after its last whole word, then …', () => {
  const claim = (text: string) => ({ id: 'c1', text, by: 'claude', cluster: 'k1', turn: 1, said: [], sources: [] })
  const cut = LONG.slice(0, 200)
  expect(cut.endsWith('which cou')).toBe(true)
  const old = (v: Any, text: string) => readStore(JSON.stringify({ v, claims: [claim(text)], clusters: [{ id: 'k1', name: 'overtime' }] })).claims[0].text
  expect(old(2, cut)).toBe(`${LONG.slice(0, LONG.indexOf(' counts'))} …`)
  expect(old(undefined, cut)).toMatch(/definition, which …$/)
  // a whole sentence of 200 characters, a short claim, and any claim of a v 3 store stay as they are
  const whole = `${'x'.repeat(198)}.`.padStart(200, 'y')
  expect(old(2, whole)).toBe(whole)
  expect(old(2, 'Run 4 failed')).toBe('Run 4 failed')
  expect(old(3, cut)).toBe(cut)
  expect(readStore('{}').v).toBe(3)
})
