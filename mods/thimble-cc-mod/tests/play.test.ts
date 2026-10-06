// The player: an answer played as an animated report in the panel. The storyboard (scenes, captions, the value each
// caption cites), its timing and keys, and the play view as the panel draws it. `claude plugin test mods/thimble-cc-mod`.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Mounted, TestBody } from 'claude-code/testing'

import { animFrame, cropFrame, focusItem } from '../hooks/anim'
import { cardLayout } from '../hooks/draw'
import type { CardData, Line } from '../hooks/draw'
import { inlineRuns } from '../hooks/lib'
import { COLORS } from '../hooks/paint'
import { START, applyOp, frameAt, headParts, keyOp, progress, sentences, storyboard, tick, tilePlace, timing } from '../hooks/play'
import type { PlayCap } from '../hooks/play'
import { captionFlows } from '../hooks/player'

const CWD = '/corpus/wiki'
const LINE: CardData = {
  id: 'ln0001',
  kind: 'line',
  question: 'How many saves a day?',
  x: 'day',
  y: 'saves',
  note: '',
  source: { script: '.thimble-cc-mod/scripts/saves.py', index: 0 },
  series: [{ name: 'saves', points: [['2026-06-17', 120], ['2026-06-18', 6543], ['2026-06-19', 300]] }],
}
const BAR: CardData = {
  id: 'abc123',
  kind: 'bar',
  question: 'Which wikis have the most revisions?',
  x: 'wiki',
  y: 'revisions',
  note: '',
  source: { script: '.thimble-cc-mod/scripts/by.py', index: 0 },
  rows: [
    { label: 'dse', value: 13403, group: '' },
    { label: 'probier', value: 1013, group: '' },
  ],
  total: 14416,
}
const EXAMPLE: CardData = {
  id: 'ex0001',
  kind: 'example',
  question: 'How does a revert read?',
  x: '',
  y: '',
  note: '',
  source: { script: '.thimble-cc-mod/scripts/ex.py', index: 0 },
  examples: [{ ref: 'revisions.jsonl#L88', quote: 'rv spam', note: 'a revert' }],
}
// a table taller than a scene at a 120-column terminal: pairs of long label names, in two blocks; the row a caption
// cites at the bottom
const PAIRS: CardData = {
  id: 'pa1rs0',
  kind: 'table',
  question: 'Which label pairs write to the most of the same pages?',
  x: '',
  y: '',
  note: '',
  source: { script: '.thimble-cc-mod/scripts/pairs.py', index: 0 },
  columns: ['pair', 'shared', 'minutes', 'within'],
  rows: [
    ['OpenAIResearchSec2028 + OurMassFinal', 9, 20.6, 2], ['MapHelper + ResearchHelper', 9, 63.1, 1], ['MapHelper + OpenAIResearchSec2028', 8, 20, 3],
    ['MassUpdater + OurMassFinal', 8, 25, 1], ['AgentSECCountyLinker99172 + OAIHelperSec', 8, 30.4, 5], ['AgentSECCountyLinker99172 + MapHelper', 8, 51.2, 4],
    ['AgentTester + MapHelper', 8, 202.9, 5], ['LanguageWatcherNov12 + OpenAIResearchFeb17', 7, 4.7, 2], ['AgentOpenResearch + LanguageWatcherNov12', 7, 4.8, 1],
    ['AgentOpenResearch + OpenAIHelperJun01X', 7, 5.7, 2], ['OpenAIResearchSec2028 + ResearchHelper', 7, 27.6, 3],
    ['AgentSECCountyLinker99172 + OpenAIResearchSec2028', 7, 27.6, 1], ['AgentSECCountyLinker99172 + AgentTester', 7, 56.2, 2],
    ['OpenAIMay31Maids + OpenAIWatcherOct30', 7, 62.6, 1], ['OpenAIResearcherBotXYZ', 7, 163.8, 1],
  ],
}
const CARDS: Record<string, CardData> = { ln0001: LINE, abc123: BAR, ex0001: EXAMPLE, pa1rs0: PAIRS }

const REPORT = [
  'Saves jumped once, on one day.',
  '',
  '## Saves spiked on 18 June',
  '',
  '[[card:ln0001]]',
  '',
  'Saves peaked at [[6543|card:ln0001#saves/2026-06-18]] on 18 June. The day before had [[120|card:ln0001#saves/2026-06-17]].',
  '',
  '## Most of it was one wiki',
  '',
  'One wiki holds most revisions.',
  '',
  '[[card:abc123]]',
  '',
  'dse has [[13403|card:abc123#revisions/dse]] of [[14416|card:abc123#revisions/all]] revisions.',
  '',
  'A revert reads like this one.',
  '',
  '[[card:ex0001]]',
  '',
  '- The comment says [["rv spam"|revisions.jsonl#L88]].',
  '',
  '## So what',
  '',
  'Check the bot first: it made [[412|events.jsonl#L3]] edits in [[2|events.jsonl#L4]] hours.',
].join('\n')

const opts = { card: (id: string) => CARDS[id], focusOf: (c: CardData, ref: string) => (c.examples ?? []).some(x => x.ref === ref) }

// ------------------------------------------------------------------------------------------------ the storyboard

test('a report-shaped answer: a title scene, a scene per card under its heading, a scene for a section without cards', () => {
  const s = storyboard(REPORT, opts)
  expect(s.map(x => `${x.kind}:${x.card ?? ''}`)).toEqual(['title:', 'card:ln0001', 'card:abc123', 'card:ex0001', 'text:'])
  // an answer that opens with a paragraph is titled by its opening line; the rest of the text before the first heading
  // types under the title; the title lists what comes
  expect(s[0]!.heading).toBe('Saves jumped once, on one day.')
  expect(s[0]!.captions.map(c => c.text)).toEqual([])
  const titled = storyboard(`# Why did saves spike?\n\n${REPORT}`, opts)
  expect(titled.map(x => x.kind)).toEqual(['title', 'card', 'card', 'card', 'text'])
  expect(titled[0]!.heading).toBe('Why did saves spike?')
  expect(titled[0]!.captions.map(c => c.text)).toEqual(['Saves jumped once, on one day.'])
  expect(s[0]!.contents).toEqual(['Saves spiked on 18 June', 'Most of it was one wiki', 'So what'])
  expect(s[1]!.heading).toBe('Saves spiked on 18 June')
  expect(s[1]!.captions.map(c => c.text)).toEqual(['Saves peaked at [[6543|card:ln0001#saves/2026-06-18]] on 18 June.', 'The day before had [[120|card:ln0001#saves/2026-06-17]].'])
  // a lead-in goes to the card after it; the paragraph citing a card goes to that card; a takeaway to the card before
  expect(s[2]!.captions.map(c => c.text)).toEqual(['One wiki holds most revisions.', 'dse has [[13403|card:abc123#revisions/dse]] of [[14416|card:abc123#revisions/all]] revisions.'])
  expect(s[3]!.captions.map(c => c.text)).toEqual(['A revert reads like this one.', 'The comment says [["rv spam"|revisions.jsonl#L88]].'])
  expect(s[4]!.heading).toBe('So what')
  expect(s[4]!.numbers?.map(n => n.display)).toEqual(['412', '2'])
})

test('each caption names the value it cites on its card, or a record the card shows, or a tile', () => {
  const s = storyboard(REPORT, opts)
  expect(s[1]!.captions.map(c => c.focus)).toEqual(['card:ln0001#saves/2026-06-18', 'card:ln0001#saves/2026-06-17'])
  expect(s[2]!.captions.map(c => c.focus)).toEqual(['', 'card:abc123#revisions/dse'])
  expect(s[3]!.captions.map(c => c.focus)).toEqual(['', 'revisions.jsonl#L88'])
  expect(s[4]!.captions.map(c => c.focus)).toEqual(['events.jsonl#L3'])
  // a citation of another card's value lights nothing on this one
  const other = storyboard('[[card:abc123]]\n\nLike the [[6543|card:ln0001#saves/2026-06-18]] peak, dse leads.', opts)
  expect(other[1]!.captions[0]!.focus).toBe('')
})

test('a card-shaped answer: the title is its card\'s question, the takeaway types under the card', () => {
  const s = storyboard('[[card:abc123]]\n\ndse has [[13403|card:abc123#revisions/dse]] revisions. That is most of [[14416|card:abc123#revisions/all]].', opts)
  expect(s.map(x => x.kind)).toEqual(['title', 'card'])
  expect(s[0]!.heading).toBe('Which wikis have the most revisions?')
  expect(s[0]!.captions).toEqual([])
  expect(s[1]!.captions.map(c => c.focus)).toEqual(['card:abc123#revisions/dse', 'card:abc123#revisions/all'])
})

test('an answer without cards: a scene per paragraph, numbered, its cited values as tiles', () => {
  const s = storyboard('The bot made [[412|events.jsonl#L3]] edits.\n\nPeople made [[90|events.jsonl#L9]], mostly reverts.', opts)
  expect(s.map(x => `${x.kind}:${x.n ?? ''}`)).toEqual(['title:', 'text:1', 'text:2'])
  expect(s[0]!.heading).toBe('The bot made 412 edits.')
  expect(s[2]!.numbers?.map(n => n.ref)).toEqual(['events.jsonl#L9'])
  expect(s[2]!.captions[0]!.focus).toBe('events.jsonl#L9')
  // tiles are numbers, then quotes; link words are no value
  const tiles = storyboard('As [[in this edit|r.jsonl#L2]], it says [["rv"|r.jsonl#L3]] [[12|r.jsonl#L4]] times.', opts)[1]!.numbers
  expect(tiles?.map(n => n.display)).toEqual(['12', '"rv"'])
})

test('a tile names what its value is: a card\'s column and row, a card by its question, an output\'s line, a file\'s place', () => {
  const cards = (id: string) => CARDS[id]
  expect(tilePlace('card:abc123#revisions/all', cards)).toBe('revisions · all')
  // without the card, the column is the fragment's first part
  expect(tilePlace('card:b7d1c0#labels/All 107 groups')).toBe('labels · All 107 groups')
  // a column whose name holds a slash, known from the card
  const slashed = { ...BAR, id: 'sl0001', kind: 'table', columns: ['edits/day', 'wiki'] }
  expect(tilePlace('card:sl0001#edits/day/dse', id => (id === 'sl0001' ? slashed : undefined))).toBe('edits/day · dse')
  expect(tilePlace('card:abc123', cards)).toBe('Which wikis have the most revisions?')
  expect(tilePlace('call:x1y2#L4')).toBe('output · line 4')
  expect(tilePlace('events.jsonl#L3')).toBe('events:3')
  for (const ref of ['card:abc123#revisions/all', 'card:b7d1c0#labels/All 107 groups', 'call:x1y2#L4']) expect(tilePlace(ref, cards)).not.toMatch(/card |x1y2|abc123|b7d1c0/)
})

test('a card\'s top line keeps its question whole when the lit value\'s label is long; the label is cut first', () => {
  const q = 'What do the labels write to each other on relay pages?'
  const tip = '▸ revisions.jsonl#L5955: StateSequenceResearcher opens dse/DataUSAStateSequenceCollab2027 for other agents'
  const h = headParts(q, tip, 91)
  expect(h.q).toBe(q)
  expect(h.tip.startsWith('▸ revisions.jsonl#L5955')).toBe(true)
  expect(h.q.length + h.tip.length + 2).toBeLessThanOrEqual(91)
  // a short label stays whole; a question longer than the line gives way down to two thirds of it
  expect(headParts(q, '▸ dse: 13403', 91)).toEqual({ q, tip: '▸ dse: 13403' })
  expect(headParts(q.repeat(3), tip, 90).tip.length).toBe(30)
  expect(headParts(q, '', 20).q.length).toBe(20)
})

// two paragraphs of several sentences under a card, as a report-shaped answer has them
const PARAS = [
  '## Almost every agent wrote on only one wiki',
  '',
  '[[card:abc123]]',
  '',
  'Only [[13|card:abc123#revisions/dse]] of the [[14416|card:abc123#revisions/all]] labels wrote on more than one wiki. The two busiest wrote only on dse. One of them made most of it.',
  '',
  'The chart shows two groups. The bot is one of them.',
  '',
  '- First item. It has two sentences.',
  '- Second item.',
].join('\n')

test('each caption knows the paragraph it is from, and whether that paragraph is a list item', () => {
  const s = storyboard(PARAS, opts)
  expect(s[1]!.captions.map(c => [c.para, Boolean(c.item)])).toEqual([[0, false], [0, false], [0, false], [1, false], [1, false], [2, true], [2, true], [3, true]])
  expect(storyboard(REPORT, opts).every(sc => sc.captions.every(c => typeof c.para === 'number'))).toBe(true)
})

const plain = (l: Line) => l.map(x => x.s).join('').trimEnd()
const capsOf = (texts: string[]): PlayCap[] => texts.map(text => ({ block: { prefix: '', heading: 0, quote: false, runs: inlineRuns(text) }, chips: [], ids: [], raws: [], focus: null }))

test('the player runs a paragraph\'s sentences on and sets paragraphs a blank row apart, list items without one', () => {
  const scene = storyboard(PARAS, opts)[1]!
  const caps = capsOf(scene.captions.map(c => c.text))
  const all = scene.captions.map(() => 1)
  const flows = captionFlows(caps, scene.captions, all, caps.length - 1, 80)
  expect(flows.map(f => f.gap)).toEqual([false, true, true, false])
  // the first paragraph's three sentences flow as one paragraph, not one line each
  expect(flows[0]!.lines.map(plain)).toEqual([
    'Only 13 of the 14416 labels wrote on more than one wiki. The two busiest wrote',
    'only on dse. One of them made most of it.',
  ])
  expect(flows[1]!.lines.map(plain)).toEqual(['The chart shows two groups. The bot is one of them.'])
  expect(flows[2]!.lines.map(plain)).toEqual(['- First item. It has two sentences.'])
  expect(flows[3]!.lines.map(plain)).toEqual(['- Second item.'])
  // the caption on screen is at full strength, the sentences around it dimmed; a citation keeps its colour
  const mid = captionFlows(caps, scene.captions, all, 1, 80)[0]!.lines
  const lit = mid.flatMap(l => l.filter(x => !x.d && x.s.trim()).map(x => x.s)).join('')
  expect(lit).toContain('Thetwobusiestwrote')
  expect(lit).toContain('onlyondse.')
  expect(lit).not.toContain('Oneofthem')
  expect(lit).not.toContain('wroteonmorethan')
})

test('a caption typing in continues its paragraph\'s line; captions not yet typed are not drawn', () => {
  const scene = storyboard(PARAS, opts)[1]!
  const caps = capsOf(scene.captions.map(c => c.text))
  const typed = scene.captions.map((_, i) => (i === 0 ? 1 : i === 1 ? 0.5 : 0))
  const flows = captionFlows(caps, scene.captions, typed, 1, 80)
  expect(flows).toHaveLength(1)
  const lines = flows[0]!.lines.map(plain)
  expect(lines).toHaveLength(1)
  // typed to where it has got: no cursor glyph after it
  expect(lines[0]).toMatch(/^Only 13 of the 14416 labels wrote on more than one wiki\. The two b/)
  expect(lines[0]).not.toMatch(/[▌▍]/)
  expect(lines[0]).not.toContain('only on dse')
})

test('sentences are cut where the reply\'s claims are, never inside a citation or code', () => {
  expect(sentences('It rose to [[3.5|a.md#L1]]. Then `x. y` fell! Done')).toEqual(['It rose to [[3.5|a.md#L1]].', 'Then `x. y` fell!', 'Done'])
})

// ------------------------------------------------------------------------------------------------ timing and keys

test('a scene animates for 2 s, then types its captions, each lit in turn; 5 to 8 s in all', () => {
  const [, scene] = storyboard(REPORT, opts)
  const tm = timing(scene!)
  expect(tm.anim).toBe(2000)
  expect(tm.total).toBeGreaterThanOrEqual(5000)
  expect(tm.total).toBeLessThanOrEqual(8200)
  expect(frameAt(scene!, 1000, tm)).toEqual({ t: 0.5, typed: [0, 0], current: -1 })
  const mid = frameAt(scene!, tm.ends[0]! + 10, tm)
  expect(mid.t).toBe(1)
  expect(mid.typed[0]).toBe(1)
  expect(mid.current).toBe(1)
})

test('keys: space pauses and resumes, arrows step scenes, r restarts, q closes; the clock stops at the end', () => {
  const tms = storyboard(REPORT, opts).map(s => timing(s))
  expect(['space', 'left', 'right', 'r', 'q', 'p', 'b', 'n', 'x'].map(keyOp)).toEqual(['pause', 'back', 'next', 'restart', 'close', 'pause', 'back', 'next', null])
  const paused = applyOp(START, 'pause', tms)
  expect(paused.paused).toBe(true)
  expect(tick(paused, 80, tms)).toBe(paused)
  // a step while paused shows the next scene whole
  const two = applyOp(paused, 'next', tms)
  expect(two).toEqual({ scene: 1, ms: tms[1]!.ends.at(-1)!, paused: true, done: false })
  expect(applyOp(applyOp(two, 'pause', tms), 'back', tms)).toEqual({ scene: 0, ms: 0, paused: false, done: false })
  // the clock runs a scene to its end, then the next
  let st = { ...START }
  for (let ms = 0; ms < tms[0]!.total; ms += 80) st = tick(st, 80, tms)
  expect(st.scene).toBe(1)
  const end = { scene: tms.length - 1, ms: tms.at(-1)!.total - 10, paused: false, done: false }
  const done = tick(end, 80, tms)
  expect(done.done).toBe(true)
  expect(progress(done, tms).at).toBe(progress(done, tms).total)
  // space at the end plays again
  expect(applyOp(done, 'pause', tms)).toEqual(START)
  expect(applyOp(two, 'restart', tms)).toEqual(START)
})

// ------------------------------------------------------------------------------------------------ the play view

type M = Mounted<'terminal'>
type El = { type: string; props: Record<string, unknown>; children?: unknown[] }
const textOf = (x: unknown): string => (typeof x === 'string' ? x : ((x as El).children ?? []).map(textOf).join(''))
async function screen(ui: M, key: string): Promise<string> {
  const root = (await ui.drawn({ in: key })) as unknown as El
  return ((root.children ?? []) as El[]).map(c => textOf(c).trimEnd()).join('\n')
}
const PANE = { plugin: 'thimble-cc-mod', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 200, rows: 55 }, props: { bodyColumns: 96, scroll: { bodyRows: 46 } } } as const

function world(on: On): { opened: string[]; closed: string[] } {
  const w = { opened: [] as string[], closed: [] as string[] }
  const files = new Map(Object.values(CARDS).map(c => [`${CWD}/.thimble-cc-mod/cards/${c.id}.json`, JSON.stringify(c)]))
  mock.env(on, {})
  on('env.set', () => ({ value: undefined }) as never)
  mock.clock(on, { now: 1_790_000_000_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.messages', () => ({ value: [] }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('fs.read', ($, e) => {
    if (e.path.endsWith('/prompt/chat.md')) return { value: '# thimble-cc-mod\n' }
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.stat', ($, e) => {
    if (!files.has(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    const req = JSON.parse(e.init?.stdin ?? '{"items":[]}') as { items: { id: string; ref: string }[] }
    const out = req.items.map(it => ({ id: it.id, ref: it.ref, kind: 'file', status: 'ok', why: 'resolves', window: [] }))
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', ($, e) => {
    w.closed.push(e.id)
    return { value: undefined } as never
  })
  on('ui.focus', () => ({}) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('prompt.read', () => ({ value: { text: '' } }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: ['(the engine row)'] })
  })
  return w
}

async function answer($: Parameters<TestBody>[0], text: string): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ text: 'Why did saves spike?', turnId: 't1' } as never)
  // the kit stores no row (nothing beneath answers session.append): the mod has taken the row's text by then
  await $.session.append({ door: 'response', uuid: 'row1', origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] } } as never).catch(() => undefined)
  await $.turn.complete({ turnId: 't1', answer: text, durationMs: 5, reason: 'answer' } as never)
}

test('"▶ play" under an answer opens the play view; the player animates, types captions and lights the cited value', async ($, on) => {
  const w = world(on)
  await answer($, REPORT)
  const msg = (await $.ui.mount({ plugin: 'thimble-cc-mod', component: 'AssistantMessage', requestId: 'row1', surface: 'terminal', viewport: { columns: 140, rows: 55 }, props: { text: REPORT, isFirstOfReply: true } } as never)) as unknown as M
  expect(await msg.find({ key: 'ask-answer:row1' })).toBeDefined()
  await msg.press({ key: 'play:row1' })
  await msg.unmount()
  expect(w.opened).toEqual(['thimble'])
  const pane = (await $.ui.mount(PANE as never)) as unknown as M
  const player = (await pane.find({ type: 'Client', key: 'play:1' })) as { props: { module: string; props: { scenes: { kind: string }[]; head: string } } } | undefined
  expect(player?.props.module).toMatch(/player\.tsx$/)
  expect(player?.props.props.scenes.map(s => s.kind)).toEqual(['title', 'card', 'card', 'card', 'text'])
  expect(player?.props.props.head).toBe('Why did saves spike?')
  const IN = { in: 'play:1' }
  expect(await screen(pane, 'play:1')).toMatch(/^1 of 5 /)
  // the title types in, then the scenes to come are listed
  await pane.advance(1600)
  expect(await screen(pane, 'play:1')).toMatch(/^Saves jumped once, on one day\./m)
  expect(await screen(pane, 'play:1')).toMatch(/ 3  So what/)
  // its controls on its title row name what each does; nothing says how to use it
  expect(await screen(pane, 'play:1')).toMatch(/pause {2}back {2}next {2}restart$/m)
  expect(await screen(pane, 'play:1')).not.toMatch(/click the player|←\/→/)
  // → steps to the first card; its first caption, once typed, lights 6543 on 18 June with its label
  await pane.key({ key: 'right', ...IN })
  expect(await screen(pane, 'play:1')).toMatch(/^2 of 5 /)
  expect(await screen(pane, 'play:1')).toMatch(/How many saves a day\?/)
  expect(await screen(pane, 'play:1')).not.toMatch(/2026-06-18 {2}saves 6,543/)
  await pane.advance(2400)
  expect(await screen(pane, 'play:1')).toMatch(/2026-06-18 {2}saves 6,543/)
  expect(await screen(pane, 'play:1')).toMatch(/Saves peaked at/)
  // the next caption lights the value it cites
  await pane.advance(900)
  expect(await screen(pane, 'play:1')).toMatch(/2026-06-17 {2}saves 120/)
  // the panel's buttons reach the player: next, then the clock runs on by itself
  await pane.press({ key: 'play-next' })
  expect(await screen(pane, 'play:1')).toMatch(/^3 of 5 /)
  await pane.advance(9000)
  expect(await screen(pane, 'play:1')).toMatch(/^4 of 5 /)
  // space pauses: the clock no longer moves it, and its control offers "▶ play"
  await pane.key({ key: ' ', ...IN })
  expect(await screen(pane, 'play:1')).toMatch(/^4 of 5 .*▶ play {2}back/)
  await pane.advance(20000)
  expect(await screen(pane, 'play:1')).toMatch(/^4 of 5 .*▶ play {2}back/)
  // a click on "▶ play" on its title row plays on
  const row = (await screen(pane, 'play:1')).split('\n')[0]!
  await pane.pointer({ type: 'down', x: row.indexOf('▶ play') + 1, y: 0, button: 'left', ...IN })
  expect(await screen(pane, 'play:1')).toMatch(/^4 of 5 .*pause {2}back/)
  // r restarts, q closes the panel
  await pane.key({ key: 'r', ...IN })
  expect(await screen(pane, 'play:1')).toMatch(/^1 of 5 .*pause/)
  await pane.key({ key: 'q', ...IN })
  expect(w.closed).toEqual(['thimble'])
  await pane.unmount()
})

test('the play view shows a paragraph as a paragraph and a blank row between paragraphs, at 120 columns too', async ($, on) => {
  world(on)
  await answer($, PARAS)
  await $.command.run({ command: 'thimble-play', args: '' } as never)
  for (const bodyColumns of [96, 49]) {
    const pane = (await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns } } as never)) as unknown as M
    const IN = { in: 'play:1' }
    await pane.key({ key: 'right', ...IN })
    await pane.advance(6500)
    const rows = (await screen(pane, 'play:1')).split('\n')
    const first = rows.findIndex(r => r.startsWith('Only 13 of'))
    const second = rows.findIndex(r => r.startsWith('The chart shows'))
    expect(first).toBeGreaterThan(0)
    // the paragraph's next sentence follows on its line, not on a line of its own
    expect(rows.some(r => r.startsWith('The two busiest'))).toBe(false)
    expect(rows.slice(first, second).join(' ')).toMatch(/more than one wiki\. The two busiest wrote only on dse\. One of them made most of it\./)
    expect(rows[second - 1]).toBe('')
    expect(rows[second - 2]).not.toBe('')
    await pane.unmount()
  }
})

test('a played scene without a card: each value it cites is a tile named by what it is, as wide as its name needs', async ($, on) => {
  world(on)
  await answer($, '## One wiki\n\n[[card:abc123]]\n\ndse has [[13403|card:abc123#revisions/dse]] revisions.\n\n## All of them\n\nThe four wikis hold [[14416|card:abc123#revisions/all]] revisions, [[412|events.jsonl#L3]] by the bot.')
  await $.command.run({ command: 'thimble-play', args: '' } as never)
  const pane = (await $.ui.mount(PANE as never)) as unknown as M
  const IN = { in: 'play:1' }
  await pane.key({ key: 'right', ...IN })
  await pane.key({ key: 'right', ...IN })
  await pane.advance(3000)
  const shown = await screen(pane, 'play:1')
  expect(shown).toMatch(/^3 of 3 /)
  expect(shown).toContain('14416')
  expect(shown).toContain('revisions · all')
  expect(shown).toContain('events:3')
  expect(shown).not.toContain('card all')
  await pane.unmount()
})

test('/thimble-play plays the last answer; a caption\'s citation opens its place in the panel, as anywhere', async ($, on) => {
  const w = world(on)
  await answer($, '[[card:abc123]]\n\ndse has [[13403|card:abc123#revisions/dse]] of [[14416|card:abc123#revisions/all]] revisions.')
  const r = await $.command.run({ command: 'thimble-play', args: '' } as never)
  expect((r as { text?: string }).text).toBe('playing the last answer in the panel')
  expect(w.opened[0]).toBe('thimble')
  const pane = (await $.ui.mount(PANE as never)) as unknown as M
  // its controls are the player's own, on its title row; the panel's keys (p, b, n, r, q) in a Box no row tall
  expect((await pane.find({ key: 'play-pause' }) as El | undefined)?.props.hotkey).toBe('p')
  expect(await pane.find({ key: 'close' })).toBeDefined()
  const IN = { in: 'play:1' }
  await pane.key({ key: 'right', ...IN })
  await pane.advance(5000)
  expect(await screen(pane, 'play:1')).toMatch(/dse {2}13,403 revisions/)
  // the caption's row: each Text of the player one row, a card's box its border and its rows
  const root = (await pane.drawn(IN)) as unknown as El
  let y = 0
  let line = -1
  for (const ch of (root.children ?? []) as El[]) {
    if (ch.type === 'Text' && /^dse has /.test(textOf(ch))) line = y
    if (line >= 0) break
    y += ch.type === 'Text' ? 1 : ch.props.borderStyle ? 2 + (ch.children ?? []).length : (ch.children ?? []).length || 4
  }
  expect(line).toBeGreaterThan(0)
  await pane.pointer({ type: 'down', x: 'dse has '.length + 1, y: line, button: 'left', ...IN })
  await pane.unmount()
  const cite = (await $.ui.mount(PANE as never)) as unknown as M
  expect(await cite.find({ type: 'Text', text: /13403/ })).toBeDefined()
  expect(await cite.find({ key: 'verify' })).toBeDefined()
  await cite.unmount()
})

// ------------------------------------------------------------------------------------------------ round 3: a card taller than its scene

test('a card taller than its scene is cropped a line at a time: its header kept, the lit row in view, what is left out said', () => {
  const focus = { series: 'minutes', row: 'OpenAIResearcherBotXYZ' }
  const full = animFrame(PAIRS, 43, 1, focus)
  const k = focusItem(PAIRS, cardLayout(PAIRS, 43, -1).items, focus)
  const plain = (ls: typeof full.lines) => ls.map(l => l.map(s => s.s).join(''))
  const all = plain(full.lines)
  expect(all.length).toBeGreaterThan(40)
  const lines = cropFrame(PAIRS, full, 43, 20, k)
  const text = plain(lines)
  expect(lines.length).toBeLessThanOrEqual(20)
  expect(text.slice(0, 1)).toEqual(all.slice(0, 1)) // the column names, with no rule under them
  // every line is the card's own, whole, or says what is left out
  for (const t of text) expect(all.includes(t) || /^… \d+ (more rows|rows above)$/.test(t)).toBe(true)
  expect(text.some(t => /^OpenAIResearcherBotXYZ +7 +163\.8$/.test(t))).toBe(true)
  expect(lines.some(l => l.some(s => s.s.includes('163.8') && s.bg === COLORS.selected))).toBe(true)
  // the run starts with a row, not its second line
  const above = text.findIndex(t => / rows above$/.test(t))
  expect(above).toBe(1)
  expect(text[above + 1]).not.toMatch(/^\+ /)
  // with no lit value it is the top of the card; with room, the whole card
  const top = plain(cropFrame(PAIRS, full, 43, 20))
  expect(top.slice(0, -1)).toEqual(all.slice(0, top.length - 1))
  expect(all[top.length - 1]).not.toMatch(/^\+ /) // its last row whole
  expect(top.at(-1)).toMatch(/^… \d+ more rows$/)
  expect(cropFrame(PAIRS, full, 43, 200, k)).toEqual(full.lines)
  // a value in a later block keeps that block's header over its rows
  const within = { series: 'within', row: 'AgentOpenResearch + OpenAIHelperJun01X' }
  const later = animFrame(PAIRS, 43, 1, within)
  const kw = focusItem(PAIRS, cardLayout(PAIRS, 43, -1).items, within)
  const shown = plain(cropFrame(PAIRS, later, 43, 20, kw))
  expect(shown[0]).toMatch(/^… \d+ lines above$/)
  expect(shown[1]).toMatch(/^pair +within$/)
  expect(shown.some(t => /^AgentOpenResearch +2$/.test(t))).toBe(true)
  expect(shown.some(t => /shared|minutes/.test(t))).toBe(false)
})

test('at a 120-column terminal a played card taller than the panel is cropped around the lit value; nothing is squeezed out', async ($, on) => {
  world(on)
  const heading = 'The pairs that share the most pages share only 7 to 9 pages'
  await answer($, `## ${heading}\n\n[[card:pa1rs0]]\n\nThe last pair writes [[163.8|card:pa1rs0#minutes/OpenAIResearcherBotXYZ]] minutes apart.`)
  await $.command.run({ command: 'thimble-play', args: '' } as never)
  const pane = (await $.ui.mount({ ...PANE, viewport: { columns: 120, rows: 50 }, props: { bodyColumns: 48, scroll: { bodyRows: 46 } } } as never)) as unknown as M
  const IN = { in: 'play:1' }
  await pane.key({ key: 'right', ...IN })
  await pane.advance(5000)
  const shown = await screen(pane, 'play:1')
  expect(shown).toMatch(/^2 of 2 /)
  expect(shown).toMatch(/OpenAIResea/)
  // the player's rows fit its height, so the layout squeezes none of them out
  const root = (await pane.drawn(IN)) as unknown as El
  const kids = (root.children ?? []) as El[]
  const rows = kids.reduce((n, ch) => n + (ch.type === 'Text' ? 1 : ch.props.borderStyle ? 2 + (ch.children ?? []).length : (ch.children ?? []).length || 4), 0)
  expect(rows).toBeLessThanOrEqual(root.props.height as number)
  // the card between its rules: a Box of its rows
  const card = kids.find(ch => ch.type === 'Box' && (ch.children ?? []).length > 3)!
  expect(card.props.flexShrink).toBe(0)
  // the heading whole, the table's header, the lit row and its value, what is left out said
  expect(kids.filter(ch => ch.type === 'Text').map(textOf).join(' ').replace(/\s+/g, ' ')).toContain(heading)
  const lines = ((card.children ?? []) as El[]).map(textOf)
  expect(lines.some(l => /^pair +shared +minutes/.test(l))).toBe(true)
  expect(lines.some(l => /^OpenAIResearcherBotXYZ +7 +163\.8/.test(l))).toBe(true)
  expect(lines.some(l => /^… \d+ (more rows|more lines|rows above)$/.test(l))).toBe(true)
  await pane.unmount()
})

test('a played card taller than the panel leaves room for its scene\'s caption paragraph typed whole', async ($, on) => {
  world(on)
  const first = 'The last pair writes [[163.8|card:pa1rs0#minutes/OpenAIResearcherBotXYZ]] minutes apart, the farthest of any pair in the table.'
  const second = 'It shares only [[7|card:pa1rs0#shared/OpenAIResearcherBotXYZ]] pages, fewer than the nine the top pairs share.'
  const third = 'Its pages written within the hour number [[1|card:pa1rs0#within/OpenAIResearcherBotXYZ]], one of the fewest in the table.'
  const fourth = 'The top pair, by contrast, writes [[20.6|card:pa1rs0#minutes/OpenAIResearchSec2028 + OurMassFinal]] minutes apart on the pages they share.'
  const fifth = 'Two helpers write [[63.1|card:pa1rs0#minutes/MapHelper + ResearchHelper]] minutes apart, three times as far, the fewest of the pairs listed.'
  await answer($, `## The pairs that share the most pages\n\n[[card:pa1rs0]]\n\n${first} ${second} ${third} ${fourth} ${fifth}`)
  await $.command.run({ command: 'thimble-play', args: '' } as never)
  const pane = (await $.ui.mount({ ...PANE, viewport: { columns: 120, rows: 50 }, props: { bodyColumns: 48, scroll: { bodyRows: 46 } } } as never)) as unknown as M
  const IN = { in: 'play:1' }
  await pane.key({ key: 'right', ...IN })
  await pane.advance(20000)
  const root = (await pane.drawn(IN)) as unknown as El
  const kids = (root.children ?? []) as El[]
  const rows = kids.reduce((n, ch) => n + (ch.type === 'Text' ? 1 : ch.props.borderStyle ? 2 + (ch.children ?? []).length : 4), 0)
  expect(rows).toBeLessThanOrEqual(root.props.height as number)
  // the paragraph from its first words to its last, under the cropped card
  const shown = (await screen(pane, 'play:1')).replace(/\s+/g, ' ')
  expect(shown).toContain('The last pair writes')
  expect(shown).toContain('the fewest of the pairs listed.')
  await pane.unmount()
})
