// The label rows under a card and under an answer, and the ask before a large label run (labels/use.ts): the labels a
// turn's `thimble label` commands ran show under the card drawn after them, in the colors the card gives their values
// (a plain dim dot where it gives none), and under the answer only those no card of it shows, in the label's own
// colors; a large label run's ask waits above the bar and in the bar, its key acts once the word window closed, the
// choice runs as the person and Claude hears it with the next prompt; a feed line read again never brings an answered
// ask back. All data is made up. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { colorOf } from '../labels/pane'
import { labelAskBand, labelAskBar, labelAskFromFeed, labelAskKey, labelAskNow, labelRowEl, labelsUnderAnswer, labelsUnderCard, resetLabelUse } from '../labels/use'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const el = (type: string) => (props: Any) => ({ type, props })
const ELS = { Box: el('Box'), Text: el('Text'), Button: el('Button') }
function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children)
}
function all(n: Any, out: Any[] = []): Any[] {
  if (!n || typeof n !== 'object') return out
  if (Array.isArray(n)) { n.forEach(x => all(x, out)); return out }
  out.push(n)
  all(n.props?.children, out)
  return out
}
/** Each value's press under a row: the dot's color (or dim) and its value. */
function dots(row: Any): { value: string; color?: string; dim?: boolean }[] {
  return all(row).filter(k => k.type === 'Button' && /that are/.test(k.props.label)).map(b => ({
    value: b.props.label.replace(/^.* that are /, ''),
    ...(b.props.children[0].props.color ? { color: b.props.children[0].props.color } : {}),
    ...(b.props.children[0].props.dimColor ? { dim: true } : {}),
  }))
}

/** An engine that keeps versioned state in memory; `ran` holds each `thimble` command, `kernel` answers it. */
function engine(kernel: (args: string[]) => { code?: number; out: unknown } = () => ({ out: [] })) {
  resetLabelUse()
  const state = new Map<string, { value: unknown; version: number }>()
  const later: (() => unknown)[] = []
  const ran: string[][] = []
  const $: Any = {
    env: { get: async (k: string) => ({ THIMBLE_HOME: '/made-up/.thimble', THIMBLE_ROOT: '/made-up/data', TMPDIR: '/made-up/tmp' } as Any)[k] },
    plugin: { root: '/made-up/plugin', name: 'thimble' },
    session: { id: async () => 's-labeluse', cwd: async () => '/made-up/data', messages: async () => [] },
    fs: { read: async () => { throw new Error('no file') }, write: async () => undefined, exists: async () => false, list: async () => [] },
    process: {
      run: async (argv: string[]) => {
        const args = argv.slice(1)
        ran.push(args)
        const r = kernel(args)
        return { exitCode: r.code ?? 0, stdout: typeof r.out === 'string' ? r.out : JSON.stringify(r.out), stderr: '' }
      },
    },
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
    clock: { now: async () => 1000, after: (_ms: number, fn: () => unknown) => { later.push(fn); return { cancel() {} } } },
    ui: { invalidate: () => undefined },
  }
  /** Run what waits on the clock, and let its reads come back. */
  const flush = async () => {
    while (later.length) await later.shift()!()
    for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0))
  }
  const set = (key: string, value: unknown, id?: string) => $.state.set({ plugin: 'thimble', key, ...(id ? { id } : {}) }, value)
  return { $, ran, flush, set, state }
}

test('under a card, a value has the color the card gives it, or a plain dim dot; under an answer, the label\'s own colors', () => {
  const label = { name: 'outcome', values: ['won', 'lost', 'tied'] }
  const open = () => undefined
  const card = labelRowEl(ELS, [{ ...label, tones: { won: '#e384b2' } }], { key: 'k', onOpen: open })
  expect(dots(card)).toEqual([{ value: 'won', color: '#e384b2' }, { value: 'lost', dim: true }, { value: 'tied', dim: true }])
  const answer = labelRowEl(ELS, [label], { key: 'k', onOpen: open })
  expect(dots(answer).map(d => d.color)).toEqual(label.values.map(v => colorOf(label.values, v)))
})

test('a regex label\'s row is one line: how it was made and over how many records, never the pattern', () => {
  const row = labelRowEl(ELS, [{ name: 'coord', kind: 'regex', values: ['yes', 'no'], records: 13403 }], { key: 'k', onOpen: () => undefined })
  expect(textOf(row)).toBe('label coord · regex · 13,403 records  ● yes  ● no')
})

test('a card shows the labels its turn ran before it; the answer only those no card of it shows; a press opens the label', async () => {
  const LIST = [
    { name: 'spam', kind: 'prompt', values: ['yes', 'no'], records: 420 },
    { name: 'tone', kind: 'code', values: ['calm', 'angry'], records: 6 },
  ]
  const w = engine(args => (args[0] === 'label' && args[1] === '--json' ? { out: LIST } : { out: {} }))
  const card = 'c00000000000a1'
  await w.set('answerTurns', ['t1'])
  await w.set('answerTurn', {
    turnId: 't1', n: 1, prompt: { text: 'Which messages are spam?', by: 'composer', row: 'p1' }, rows: ['r1', 'r2'], answer: 'r2', reason: 'answer',
    startedAt: 1, endedAt: 2, seq: 3,
    labels: [{ name: 'spam', args: [], toolUseId: 'b1', seq: 1, ok: true }, { name: 'tone', args: [], toolUseId: 'b2', seq: 3, ok: true }],
    cards: [{ id: card, toolUseId: 'k1', seq: 2 }],
  }, 't1')
  await w.set('answerRowTurn', 't1', 'r1')
  await w.set('answerRowTurn', 't1', 'r2')
  await w.set('card', { id: card, version: 1, title: 'Spam by agent', calls: {} }, card)
  // the card names `yes` in a color of its own in its legend, and `no` in none
  await w.set('cardTree', { gen: 1, width: 60, seq: 1, tree: { t: 'Box', c: [{ t: 'Text', p: { color: '#b2c24f' }, c: ['■'] }, { t: 'Text', c: [' yes  no'] }] } }, card)
  // the labels are read after the drawing that asked, which draws again
  expect(await labelsUnderCard(w.$, ELS, card, 80)).toEqual([])
  await w.flush()
  const under = await labelsUnderCard(w.$, ELS, card, 80)
  expect(textOf(under)).toBe('label spam · read by Claude · 420 records  ● yes  ● no')
  expect(dots(under)).toEqual([{ value: 'yes', color: '#b2c24f' }, { value: 'no', dim: true }])
  const answer = await labelsUnderAnswer(w.$, ELS, 'r2', 80)
  expect(textOf(answer)).toBe('label tone · code · 6 records  ● calm  ● angry')
  // a row that is not the turn's answer gets none
  expect(await labelsUnderAnswer(w.$, ELS, 'r1', 80)).toEqual([])
  // the read ran once, as the person's (`thimble label --json`)
  expect(w.ran.filter(a => a.join(' ') === 'label --json').length).toBe(1)
})

test('a large label run asks above the bar and in the bar; its key acts after the word window and runs as the person; Claude hears the choice', async () => {
  const w = engine(args => (args.includes('--answer') ? { out: { name: 'spam', choice: 'sample', reads: 300, of: 420, waiting: 300 } } : { out: {} }))
  const ev = { kind: 'label_ask', name: 'spam', root: '/made-up/data', ask: 'a1', units: 420, sample: 300, text: 'Read 420 records of chat.jsonl with Claude', meta: '9 model calls', t: 1 }
  await labelAskFromFeed(w.$, ev)
  const band = await labelAskBand(w.$, ELS, 100)
  expect(textOf(band)).toBe('label spam  Read 420 records of chat.jsonl with Claude?1 run all2 run on a sample of 3000 cancel9 model calls')
  expect((await labelAskBar(w.$, () => true, false)).map(x => `${x.key} ${x.words}${x.focus ? ' (focus)' : ''}`)).toEqual(['1 run all (focus)', '2 run on a sample of 300 (focus)', '0 cancel (focus)'])
  // other keys are not the ask's
  expect(await labelAskKey(w.$, '3', 0)).toBe(null)
  const take = await labelAskKey(w.$, '2', 0)
  // the choices leave the screen at once; a letter after the key brings them back and nothing runs
  await take!.now!()
  expect(await labelAskNow(w.$)).toBe(null)
  await take!.undo!()
  expect((await labelAskNow(w.$))?.ask).toBe('a1')
  // the key alone: once the window closed, the choice runs as the person
  await take!.now!()
  await take!.later!()
  expect(w.ran.find(a => a.includes('--answer'))).toEqual(['label', 'spam', '--answer', 'sample', '--ask', 'a1'])
  const told = (w.state.get(JSON.stringify({ plugin: 'thimble', key: 'tell' }))?.value ?? {}) as Record<string, string>
  expect(told['label-ask:/made-up/data|spam']).toContain('random sample of 300 of the label spam\'s 420 records')
  // the feed's line read again (after Claude's command ended) never brings the answered ask back
  await labelAskFromFeed(w.$, ev)
  expect(await labelAskNow(w.$)).toBe(null)
  // Claude runs the label again after the sample: a new ask, for the rest, with no sample
  await labelAskFromFeed(w.$, { ...ev, ask: 'a2', units: 120, sample: 0, rest: true, text: 'Read the other 120 records of chat.jsonl with Claude' })
  expect((await labelAskBar(w.$, () => true, false)).map(x => `${x.key} ${x.words}`)).toEqual(['1 run the rest', '0 cancel'])
  expect(await labelAskKey(w.$, '2', 0)).toBe(null)
})

test('a choice the kernel refuses shows the failure line and tells Claude nothing', async () => {
  const w = engine(args => (args.includes('--answer') ? { code: 1, out: 'thimble label: the label changed since it asked' } : { out: {} }))
  await labelAskFromFeed(w.$, { kind: 'label_ask', name: 'spam', root: '/made-up/data', ask: 'a1', units: 420, sample: 300, t: 1 })
  const take = await labelAskKey(w.$, '1', 0)
  await take!.now!()
  await take!.later!()
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0))
  const fail = w.state.get(JSON.stringify({ plugin: 'thimble', key: 'failLine' }))?.value as Any
  const line = fail ?? [...w.state.values()].map(v => v.value as Any).find(v => v && typeof v === 'object' && v.kind === 'failed')
  expect(line?.text).toBe('× The label spam did not start: the label changed since it asked. Ask Claude to run it again.')
  expect(w.state.get(JSON.stringify({ plugin: 'thimble', key: 'tell' }))).toBe(undefined)
})
