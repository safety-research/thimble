// Claims (claims/): the observer's claims lens places each answer's claims by their words, with the citations near them,
// in the conversation's kept folder; c on the bar counts them and lights when a claim was corrected; a look that fails
// leaves a gap the pane names; c opens the pane, whose keys walk the claims; the folder's map is asked of main and comes
// in from the change feed. All data is made up. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { registerAnswers, resetAnswers } from '../core/answers'
import { registerTell } from '../core/tell'
import { registerTurn } from '../core/turn'
import { drainNow, registerObserver, resetObserver } from '../observer/observer'
import { setOptions } from '../settings/features.mjs'
import { claimsBar, claimsKey, drawClaimsPane, folderClaimsFromFeed, registerClaims } from '../claims/seam'
import { askFolder, claimsStore } from '../claims/term'
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
        if (String(argv.at(-2) ?? '').endsWith('/claims/estimate.mjs')) return { exitCode: 0, stdout: JSON.stringify({ offer: { what: '4 files', detail: '42 MB', minutes: 4 } }), stderr: '' }
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
  expect((await claimsBar(s.$, () => true, false)).map(x => x.words)).toEqual(['● 3 claims, 1 corrected'])
  // switched off, c is not on the bar and the key is typed
  expect(await claimsBar(s.$, k => k !== 'claims', false)).toEqual([])
})

test('a look that fails leaves a gap the pane names; c opens the pane, whose keys walk the claims', async () => {
  setOptions({})
  const s = setup([reply([{ claim: 'Run 4 failed on the p95 check.', quote: 'Run 4 failed on the p95 check', cluster: 'failures' }, { claim: 'Run 9 failed on a timeout.', quote: 'Run 9 failed on a timeout', cluster: 'failures' }])])
  await s.call('session.start', { cwd: '/made-up/data', isInteractive: true }, async () => ({}))
  await answered(s, { id: 't1', prompt: 'Which runs failed?', rows: ['Run 4 failed on the p95 check. Run 9 failed on a timeout.'] })
  await answered(s, { id: 't2', prompt: 'Why?', rows: ['Because of the cache.'] })
  const take = await claimsKey(s.$, 'c', 0)
  expect(take?.later).toBeDefined()
  await take!.later!()
  expect(s.opened.at(-1)).toMatchObject({ id: 'thimble', title: 'Claims', focus: true })
  const pane = await drawClaimsPane(s.$, { props: { bodyColumns: 100, scroll: { bodyRows: 30 } } }, {}, els)
  const t = textOf(pane)
  expect(t).toContain('Claims   2')
  expect(t).toContain('Turn 2 was not read:')
  const keys = buttons(pane).filter(b => b.hotkey).map(b => [b.hotkey, b.label])
  expect(keys).toEqual([['j', 'next claim'], ['k', 'previous'], ['e', 'evidence'], ['m', 'where it was said'], ['a', 'ask about it']])
  // j selects the other claim: the pane draws its box
  await buttons(pane).find(b => b.hotkey === 'j').onPress()
  const now = paneNow(s)
  expect(now).toMatchObject({ kind: 'claims', args: { claim: 'c1' } })
  const boxed = textOf(await drawClaimsPane(s.$, { props: { bodyColumns: 100, scroll: { bodyRows: 30 } } }, now.args, els))
  expect(boxed).toContain('Run 4 failed on the p95 check.')
  // m: where it was said, the message with the claim's words, and b back
  await buttons(await drawClaimsPane(s.$, { props: { bodyColumns: 100 } }, now.args, els)).find(b => b.hotkey === 'm').onPress()
  const src = paneNow(s)
  expect(src.args).toMatchObject({ source: 'c1', row: 't1-row-0' })
  const said = await drawClaimsPane(s.$, { props: { bodyColumns: 100 } }, src.args, els)
  expect(textOf(said)).toContain("Where it was said  Claude's message")
  expect(buttons(said).map(b => b.hotkey)).toContain('b')
})

test("the folder's map: asked of main with the guide as a file, then its claims come in from the change feed", async () => {
  setOptions({})
  const s = setup([])
  await s.call('session.start', { cwd: '/made-up/data', isInteractive: true }, async () => ({}))
  expect(await askFolder(s.$)).toBeUndefined()
  expect(s.submitted).toEqual(['map the claims of this folder (4 files, about 4 min)'])
  const guide = [...s.files.keys()].find(p => p.endsWith('/claims-folder.md'))!
  expect(s.files.get(guide)).toBe('PROMPT claims-folder')
  const told = JSON.parse(s.files.get(`${KEPT}/tell.json`)!)
  expect(told['claims-folder']).toContain(`First read ${guide} and follow it.`)
  expect(told['claims-folder']).toContain('thimble claims save --from ')
  expect((await claimsStore(s.$)).folderAsked).toBeDefined()
  // the save's feed line brings the map in
  s.files.set('/made-up/.thimble/folders/data/claims/folder.json', JSON.stringify({ data: { clusters: [{ id: 'tz', name: 'timezone detour' }], claims: [{ id: 'a', name: 'Agents blame a timezone bug', cluster: 'tz', evidence: [{ ref: 'runs/r1.jsonl#L12', quote: 'a timezone mismatch' }] }] }, holds: 1, total: 1 }))
  await folderClaimsFromFeed(s.$, { kind: 'folder_claims', path: '/made-up/.thimble/folders/data/claims/folder.json' })
  const store = await claimsStore(s.$)
  expect(store.claims.map((c: Any) => [c.text, c.by])).toEqual([['Agents blame a timezone bug', 'folder']])
  expect(store.folderAsked).toBeUndefined()
  expect(store.folder).toMatchObject({ claims: 1, clusters: 1 })
})
