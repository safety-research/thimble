// Squeeze and catch-up in the terminal (squeeze/): s at an empty prompt opens the chips under the answer, ] asks one
// rewrite and the new text shows in place of Claude's words, Claude hears the version with the next prompt, 0 brings
// the original back with no call; with two replies since the person's last prompt, b writes one catch-up of them below
// the newest, while the replies still show, with their explainers on its words and their cards moved into it; keys
// pressed in a row make one rewrite, and the latest one shows. All data is made up. `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { cardWidth } from '../cards/draw'
import { layoutLines } from '../cards/layout.js'
import { accent } from '../core/theme'
import { textWidth } from '../core/text.js'
import { treeRows } from '../core/trail.mjs'
import { resetSqueeze } from '../squeeze/term'
import Chips from '../squeeze/chips.tsx'
import { test } from './kit'
import { promptStub, tempRun } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + (n.type === 'Markdown' ? String(n.props.text) : '') + textOf(n.children)
}

/** Words as read, the spaces that keep the chips' columns as one. */
const flat = (s: string) => s.replace(/\s+/g, ' ')

const VIEW = { columns: 100, rows: 40, isFullscreen: true }
const answer = (requestId: string, text: string) => ({ plugin: 'thimble', component: 'AssistantMessage', surface: 'terminal', requestId, viewport: VIEW, props: { text, isFirstOfReply: true } }) as never
const above = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {} }, viewport: VIEW } as never
const key = (k: string) => ({ origin: { kind: 'composer' }, key: { key: k }, text: '', cursor: 0, start: 0, end: 0, inputText: k }) as never

/** What the observer's look answers (its explainers, heads-up and claims), '{}' unless a test sets it. */
let lookReply = '{}'

/** `kept`: files of the conversation's folder before the session starts, by their path in it (`marks/row-t1.json`). */
async function setup($: Any, on: Any, replies: (string | Promise<string>)[], kept: Record<string, string> = {}) {
  resetSqueeze()
  lookReply = '{}'
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp', PATH: '/usr/bin' })
  const clock = mock.clock(on, { now: 0 })
  const files: Record<string, string> = {}
  const asked: Any[] = []
  on('session.id', () => ({ value: 's-squeeze' }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('session.messages', () => ({ value: [] }))
  const keptOf = (path: string) => Object.keys(kept).find(k => path.endsWith(`/${k}`))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files[e.path] ?? (keptOf(e.path) ? kept[keptOf(e.path)!] : undefined) ?? promptStub(e.path) ?? '' }))
  on('fs.write', (_$: unknown, e: { path: string; content: string }) => { files[e.path] = String(e.content); return { value: undefined } })
  on('fs.list', (_$: unknown, e: { path: string }) => ({ value: Object.keys(kept).filter(k => String(e.path).endsWith(`/${k.split('/')[0]}`)).map(k => ({ name: k.split('/')[1], kind: k.split('/').length > 2 ? 'dir' : 'file' })) }))
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files }))
  on('fs.stat', () => ({ value: { kind: 'missing', size: 0 } }))
  on('env.set', () => ({ value: {} }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.scroll', () => ({ value: undefined }))
  const fills: Any[] = []
  on('prompt.fill', (_$: unknown, e: Any) => { fills.push(e); return { isFilled: true } as never })
  on('prompt.edit', (_$: unknown, e: Any) => ({ text: e.text, cursor: e.cursor }))
  on('prompt.change', (_$: unknown, e: Any) => ({ text: e.text, cursor: e.cursor }))
  const forks: Any[] = []
  on('model.fork', (_$: unknown, e: Any) => { forks.push(e); return { value: { isAnswered: true, text: lookReply } } })
  on('model.complete', async (_$: unknown, e: Any) => { asked.push(e); return { value: { isAnswered: true, text: `<text>\n${(await replies.shift()) ?? 'Short.'}\n</text>`, usage: {} } } })
  on('process.run', (_$: unknown, e: { argv: string[] }) => ({ value: { ...(tempRun(e.argv) ?? { exitCode: 0, stdout: '', stderr: '' }), isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  on('prompt.submit', (_$: unknown, e: Any) => ({ text: e.text, ...(e.context ? { context: e.context } : {}) }))
  on('turn.start', (_$: unknown, e: Any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: unknown, e: Any) => ({ text: e.answer }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the engine'] }) as never)
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  const ask = (text: string, by = 'composer') => $.prompt.submit({ text, origin: { kind: by } } as never) as Promise<Any>
  const say = (uuid: string, text: string) => $.session.append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }, door: 'response', origin: { kind: 'model', model: 'claude-made-up' }, uuid } as never)
  const turn = async (id: string, text: string, prompt: { text: string; by: string } | null = { text: `question ${id}`, by: 'composer' }) => {
    if (prompt) await ask(prompt.text, prompt.by)
    await $.turn.start({ text: prompt?.text ?? '', turnId: id } as never)
    await say(`row-${id}`, text)
    await $.turn.complete({ turnId: id, reason: 'answer', answer: text, durationMs: 10, isAborted: false } as never)
    await clock.advance(100)
  }
  const press = async (k: string) => { const r = await $.prompt.edit(key(k)); await clock.advance(400); return r }
  const bar = async () => textOf(await $.ui.render(above))
  return { clock, asked, forks, ask, say, turn, press, bar, files, fills }
}

const LONG = 'The nightly build failed on [3 of 12](#) runs. The cache key changed when the lockfile moved, so every run fetched again, and the slow mirror timed out.'

test('s opens the chips; ] writes a longer version in place, Claude hears it with the next prompt, and 0 brings the original back with no call', { options: { citations: 'auto cite' } }, async ($, on) => {
  const t = await setup($, on, ['The build failed on [3 of 12](#) runs: the cache key changed with the lockfile, and the mirror timed out on each fresh fetch.'])
  await t.turn('t1', LONG)
  expect(await t.bar()).toContain('s rewrite')
  expect(await t.press('s')).toEqual({ text: '', cursor: 0 })
  // the chips name their keys, each where it acts, and the bar none of them: each key shows once
  const chips = textOf((await chipsDrawn($, 'row-t1', LONG)).tree)
  for (const k of ['1 Length', '[ shorter', '] longer', '2 Background', '+ your own', 's close']) expect(chips).toContain(k)
  const open = await t.bar()
  for (const k of ['s close', 'shorter', 'longer', 'chip', 'your own', 's done']) expect(open).not.toContain(k)
  const under = textOf(await $.ui.render(answer('row-t1', LONG)))
  expect(under).toContain(LONG.slice(0, 20))
  await t.press(']')
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(1)
  expect(String(t.asked[0].prompt)).toContain('Length: longer')
  const shown = textOf(await $.ui.render(answer('row-t1', LONG)))
  expect(shown).toContain('on each fresh fetch')
  // the chips close with s; the bar says rewrite as before, not the levels set
  await t.press('s')
  expect(await t.bar()).toContain('s rewrite')
  expect(await t.bar()).not.toContain('longer')
  const next = await t.ask('and now?')
  expect(String((next.context ?? []).join('\n'))).toContain('now reads, for the analyst, as:')
  // 0 brings the original back, with no call
  await t.press('s')
  await t.press('0')
  await t.clock.advance(1000)
  expect(t.asked.length).toBe(1)
  const back = textOf(await $.ui.render(answer('row-t1', LONG)))
  // (citations are checked when opened, by default, so its citation draws as written, with ? after it: not checked yet)
  expect(back).toContain('The nightly build failed on 3 of 12 ? runs')
  expect(back).not.toContain('fresh fetch')
})

test('with two replies since the last prompt, the bar names b apart from s; b writes one catch-up below the newest, the replies still show, and the chips stay closed', async ($, on) => {
  const t = await setup($, on, ['Both: the build failed, and the retry passed.'])
  await t.turn('t1', 'Earlier answer.')
  await t.turn('t2', 'The build failed on three runs.', { text: 'why did it fail?', by: 'composer' })
  await t.turn('t3', 'The retry passed on all runs.', { text: '<task-notification>done</task-notification>', by: 'task-notification' })
  expect(await t.bar()).toContain('s rewrite · b catch up on 2 replies')
  // s opens the chips under the newest reply, with no call and no catch-up among them
  await t.press('s')
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(0)
  const under = textOf((await chipsDrawn($, 'row-t3', 'The retry passed on all runs.')).tree)
  expect(under).toContain('2 Background')
  expect(under).not.toContain('atch up')
  expect(await t.bar()).not.toContain('chip')
  await t.press('s')
  // b writes the catch-up
  await t.press('b')
  await t.clock.advance(5000)
  expect(String(t.asked[0].prompt)).toContain("Claude's messages since the analyst's last prompt")
  expect(String(t.asked[0].prompt)).toContain('The analyst asked: why did it fail?')
  // the covered reply draws as written; the newest draws its own words, then the catch-up below with its head line
  expect(textOf(await $.ui.render(answer('row-t2', 'The build failed on three runs.')))).toBe('the engine')
  const host = textOf(await $.ui.render(answer('row-t3', 'The retry passed on all runs.')))
  expect(host.indexOf('the engine')).toBeLessThan(host.indexOf('catch-up of the 2 replies above'))
  expect(host).toContain('Both: the build failed, and the retry passed.')
  // the squeeze chips stay closed under a catch-up, and nothing is hidden, so no key brings the replies back
  expect(host).not.toContain('1–')
  expect(await t.bar()).not.toContain('chip')
  expect(await t.bar()).not.toContain('show the replies')
  expect(String((await t.ask('and?')).context ?? '')).toContain('Below those messages')
  // a catch-up the person read counts: the bar no longer offers one, and b does nothing
  expect(await t.bar()).not.toContain('catch up')
  const asked = t.asked.length
  await t.press('b')
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(asked)
})

test('keys pressed in a row make one rewrite, at the last level, 1 s after the last press; the chips show each level at once', async ($, on) => {
  const t = await setup($, on, ['The build failed on [3 of 12](#) runs.', 'The build failed on [3 of 12](#) runs: the much longer version.'])
  await t.turn('t1', LONG)
  await t.press('s')
  await t.press('[')
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(1)
  // ] ] ] quickly: short, as written, longer, much longer
  for (const k of [']', ']', ']']) { await $.prompt.edit(key(k)); await t.clock.advance(200) }
  const { client } = await chipsDrawn($, 'row-t1', LONG)
  expect(client?.props.props.items.find((c: Any) => c.id === 'length').level).toBe(3)
  await t.clock.advance(700)
  expect(t.asked.length).toBe(1)
  await t.clock.advance(200)
  expect(t.asked.length).toBe(2)
  expect(String(t.asked[1].prompt)).toContain('Length: much longer')
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(2)
  expect(textOf(await $.ui.render(answer('row-t1', LONG)))).toContain('the much longer version.')
})

test("with the chips open, a bar narrower than its items lays them on more rows, each whole on one row and none wider than the bar, the line that says a chip goes no further too; the chips' keys stand in the chips", async ($, on) => {
  const t = await setup($, on, [])
  await t.turn('t1', LONG)
  await t.press('s')
  // the second chip, Background, down to its first level and a step past it
  for (const k of ['2', '[', '[', '[']) await t.press(k)
  const band = await $.ui.render({ ...(above as Any), props: { ...(above as Any).props, bodyColumns: 60 } } as never)
  const kids = (n: Any): Any[] => { const c = n?.children ?? n?.props?.children; return Array.isArray(c) ? c : c == null ? [] : [c] }
  const rows = kids(band).filter(n => /^bar/.test(String(n.props?.key))).map(textOf)
  expect(rows.length).toBeGreaterThan(1)
  for (const r of rows) expect(textWidth(r)).toBeLessThanOrEqual(60)
  expect(rows.some(r => r.includes('Background goes no further than novice'))).toBe(true)
  // the keys that move the picked chip are on its ends, in the chips
  const chips = flat(textOf((await chipsDrawn($, 'row-t1', LONG)).tree))
  for (const item of ['2 Background [ novice ●○○○ ] expert', '+ your own', '0 revert', 's close']) expect(chips).toContain(item)
  for (const item of ['s close', '[ ', '] ', '+ your own', '0 revert']) expect(rows.some(r => r.includes(item))).toBe(false)
})

test('a key pressed while a rewrite runs: the running one is not shown, the latest one is', async ($, on) => {
  const gates: ((v: string) => void)[] = []
  const t = await setup($, on, [new Promise<string>(r => { gates.push(r) }), 'The build failed on [3 of 12](#) runs: the much longer version.'])
  await t.turn('t1', LONG)
  await t.press('s')
  await t.press(']')
  await t.clock.advance(1500)
  expect(t.asked.length).toBe(1)
  await t.press(']')
  gates.shift()!('The build failed on [3 of 12](#) runs: the longer version, now old.')
  await t.clock.advance(100)
  expect(textOf(await $.ui.render(answer('row-t1', LONG)))).not.toContain('now old')
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(2)
  expect(String(t.asked[1].prompt)).toContain('Length: much longer')
  const shown = textOf(await $.ui.render(answer('row-t1', LONG)))
  expect(shown).toContain('the much longer version.')
  expect(shown).not.toContain('now old')
})

test('s opens the chips; a level picked starts the rewrite about 1 s later; a level changed while it rewrites stops it, and it starts over at the new level about 1 s after the change', async ($, on) => {
  const gates: ((v: string) => void)[] = []
  const t = await setup($, on, [new Promise<string>(r => { gates.push(r) }), 'The build failed on [3 of 12](#) runs: the much longer version.'])
  await t.turn('t1', LONG)
  await t.press('s')
  expect(textOf((await chipsDrawn($, 'row-t1', LONG)).tree)).toContain('] longer')
  // ] picked: no call for about a second, then one, which the bar's busy step names
  await $.prompt.edit(key(']'))
  await t.clock.advance(900)
  expect(t.asked.length).toBe(0)
  await t.clock.advance(500)
  expect(t.asked.length).toBe(1)
  expect(String(t.asked[0].prompt)).toContain('Length: longer')
  expect(await t.bar()).toContain('rewriting')
  // ] again while it rewrites: that rewrite stops at once, so nothing rewrites while the new level waits its second
  await $.prompt.edit(key(']'))
  await t.clock.advance(400)
  expect(await t.bar()).not.toContain('rewriting')
  expect(t.asked.length).toBe(1)
  // then it starts over, at the new level
  await t.clock.advance(700)
  expect(t.asked.length).toBe(2)
  expect(String(t.asked[1].prompt)).toContain('Length: much longer')
  // the stopped one's words, had they come, are not shown; the new level's are
  gates.shift()!('The build failed on [3 of 12](#) runs: the longer version, now old.')
  await t.clock.advance(5000)
  const shown = textOf(await $.ui.render(answer('row-t1', LONG)))
  expect(shown).toContain('the much longer version.')
  expect(shown).not.toContain('now old')
  expect(t.asked.length).toBe(2)
})

/** The chips' Client under a row, as the terminal would draw it: its props from the row, its elements as plain nodes. */
const ELS = Object.fromEntries(['Box', 'Text', 'Button'].map(k => [k, (props: Any) => ({ type: k, props })]))
const nodes = (n: Any): Any[] => (!n || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(nodes) : [n, ...nodes(n.props?.children), ...nodes(n.children)])
async function chipsDrawn($: Any, row: string, text: string, override: Any = {}) {
  const client = nodes(await $.ui.render(answer(row, text))).find(n => n.type === 'Client')
  const posts: Any[] = []
  const surface = { elements: ELS, columns: 100, onKey: () => undefined, post: (d: Any) => posts.push(d) }
  return { client, tree: Chips({ ...client?.props.props, ...override } as never, surface as never), posts }
}

test('a citation opened over the open chips takes the keys: the bar names 0 once, 0 closes the tray and keeps the version, then the chips take 0 again', { options: { citations: 'auto cite' } }, async ($, on) => {
  const text = 'Of the [12 runs](#), [3 failed](#) on the [slow mirror](#).'
  const t = await setup($, on, ['Of all [12 nightly runs](#), exactly [3 of them failed](#), each on the [slow package mirror](#).'])
  await t.turn('t1', text)
  await t.press('s')
  await t.press(']')
  await t.clock.advance(5000)
  const all = (n: Any): Any[] => (n == null || typeof n !== 'object' ? [] : [n, ...[n.props?.children, n.children].flat(Infinity).flatMap(all)])
  const cite = all(await $.ui.render(answer('row-t1', text))).find(n => n.type === 'Button' && /^citation 2/.test(String(n.props.label)))
  const ui = await $.ui.mount(answer('row-t1', text))
  await ui.press({ key: cite.props.key })
  await ui.unmount()
  // the tray is open over the chips: its keys in its header, and the chips name none of theirs, each key once
  const open = await t.bar()
  expect(open).toContain('3 failed')
  expect(open.match(/0 (close|back|revert)/g)).toEqual(['0 close'])
  const over = textOf((await chipsDrawn($, 'row-t1', text)).tree)
  expect(over).toContain('revert')
  for (const k of ['0 revert', '] longer', '1 Length', 's close']) expect(over).not.toContain(k)
  // 0 closes the tray; the longer version stays, and the chips hold the keys again
  await t.press('0')
  expect(await t.bar()).not.toContain('0 close')
  expect(textOf(await $.ui.render(answer('row-t1', text)))).toContain('slow package mirror')
  expect(textOf((await chipsDrawn($, 'row-t1', text)).tree)).toContain('0 revert')
  expect(await t.bar()).not.toContain('revert')
  await t.press('0')
  expect(textOf(await $.ui.render(answer('row-t1', text)))).not.toContain('slow package mirror')
})

// The catch-up stands for its replies: their explainers stand on its words where it says their terms, and a card it
// places moves down into it, while the reply keeps a line that points to it
test("a catch-up shows its replies' explainers on its words, and a card it places moves into it from its reply", async ($, on) => {
  const card = 'c1234abcd5'
  const meta = { id: card, version: 1, title: 'Runs', toolUseId: 'toolu_made_up', agentId: null, anchorRow: null, keys: [], read: '', columns: [], file: '', gen: 1, error: null, calls: { toolu_made_up: { version: 1 } }, at: 0 }
  const t = await setup($, on, [`Both: the slow mirror failed the build, and the retry passed.\n\n[Runs](card:${card})`], { [`cards/${card}/meta.json`]: JSON.stringify(meta) })
  await t.turn('t1', 'Earlier answer.')
  // the look after the first reply explains a term of it
  lookReply = '{"glosses": [{"term": "slow mirror", "body": "A package mirror that answers slowly."}], "heads": null, "claims": []}'
  const two = `The build failed on the slow mirror.\n\n[Runs](card:${card})`
  await t.turn('t2', two, { text: 'why did it fail?', by: 'composer' })
  await t.clock.advance(1000)
  lookReply = '{}'
  await t.turn('t3', 'The retry passed.', { text: '<task-notification>done</task-notification>', by: 'task-notification' })
  await t.press('b')
  await t.clock.advance(5000)
  const host = await $.ui.render(answer('row-t3', 'The retry passed.'))
  expect(textOf(host)).toContain('catch-up of the 2 replies above')
  // the reply's explainer stands on the catch-up's words too
  expect(nodes(host).some(n => n.type === 'Button' && String(n.props.label).startsWith('explain slow mirror'))).toBe(true)
  // the card moved down into the catch-up: its reply points to it; in the catch-up it fits beside the rule, 2 columns
  // narrower than on a line of an answer's text, which is 2 narrower than under an answer, so its frame keeps the 2
  // columns at the right free
  expect(textOf(await $.ui.render(answer('row-t2', two)))).toContain('“Runs” is in the catch-up below')
  expect(nodes(host).find(n => n.type === 'Client' && String(n.props.module).endsWith('/client.tsx'))?.props.width).toBe(cardWidth(VIEW.columns - 4))
  // its rule is drawn row by row, nothing placed absolutely (a box placed so kept a stale height after the width
  // changed and drew past the catch-up): beside each row of its text, one ▎ per row the row takes, its gap too
  const cu = nodes(host).find(n => n.props?.key === 'cu-row-t3')
  expect(cu).toBeDefined()
  expect(nodes(cu).some(n => n.props?.position === 'absolute')).toBe(false)
  const ruled = nodes(cu).filter(n => n.type === 'Box' && n.props?.flexDirection === 'row' && String(n.props?.key ?? '').startsWith('cu-row-t3-b'))
  expect(ruled.length).toBeGreaterThan(0)
  for (const r of ruled) {
    const [gutter, body] = [r.props?.children, r.children].find(Array.isArray) as Any[]
    const w = Number(body.props.width)
    expect(textOf(gutter).split('\n').every((l: string) => l === '▎')).toBe(true)
    expect(textOf(gutter).split('\n').length).toBe(Math.max(1, treeRows(body, w)))
  }
})

// The catch-up is read for explainers and heads-ups as an answer is: the look reads its words as what the analyst
// reads, and a term only it says gets an explainer on its words, kept on the newest reply it covers
test('a catch-up is read for explainers as any answer is: a term only it says gets one, on its words', async ($, on) => {
  const t = await setup($, on, ['Both: lockfile drift broke the build, and the retry passed.'])
  await t.turn('t1', 'Earlier answer.')
  await t.turn('t2', 'The build failed on three runs.', { text: 'why did it fail?', by: 'composer' })
  await t.turn('t3', 'The retry passed.', { text: '<task-notification>done</task-notification>', by: 'task-notification' })
  await t.clock.advance(1000)
  lookReply = '{"glosses": [{"term": "lockfile drift", "body": "The lockfile no longer matches what the project asks for."}, {"term": "three runs", "body": "Words only a reply says."}], "heads": null, "claims": []}'
  const before = t.forks.length
  await t.press('b')
  await t.clock.advance(5000)
  const read = t.forks.slice(before).map(f => String(f.prompt))
  expect(read.some(p => p.includes('A catch-up thimble wrote') && p.includes('lockfile drift broke the build'))).toBe(true)
  const host = await $.ui.render(answer('row-t3', 'The retry passed.'))
  expect(nodes(host).some(n => n.type === 'Button' && String(n.props.label).startsWith('explain lockfile drift'))).toBe(true)
  // the look read the catch-up's words alone: words only a reply says get no explainer from it
  expect(nodes(await $.ui.render(answer('row-t2', 'The build failed on three runs.'))).some(n => n.type === 'Button' && String(n.props.label).startsWith('explain three runs'))).toBe(false)
})

// A catch-up words the replies' citations anew, and each reply numbers its citations from 1. Each citation of the
// catch-up stands for the reply's citation that states the same claim: a press on a reworded one acts on that citation
// (the tray stands on it), and citations of two replies light apart, each in its own hover group
test("a catch-up's reworded citations: a press acts on the reply's citation with the same claim, and two replies' citations light apart", { options: { citations: 'auto cite' } }, async ($, on) => {
  const t = await setup($, on, ['Of all [12 nightly runs](#), [3 of them failed](#); the retry then passed on [the slow package mirror](#).'])
  await t.turn('t1', 'Earlier answer.')
  await t.turn('t2', 'Of the [12 runs](#), [3 failed](#).', { text: 'why did it fail?', by: 'composer' })
  await t.turn('t3', 'The retry passed on the [slow mirror](#).', { text: '<task-notification>done</task-notification>', by: 'task-notification' })
  await t.press('b')
  await t.clock.advance(5000)
  const host = answer('row-t3', 'The retry passed on the [slow mirror](#).')
  const all = (n: Any): Any[] => (n == null || typeof n !== 'object' ? [] : [n, ...[n.props?.children, n.children].flat(Infinity).flatMap(all)])
  // the catch-up's citations (the reply above it keeps its own)
  const cu = all(await $.ui.render(host)).find(n => n.props?.key === 'cu-row-t3')
  const cites = all(cu).filter(n => n.type === 'Button' && /^citation /.test(String(n.props.label)))
  const labels = [...new Set(cites.map(b => String(b.props.label)))]
  expect(labels.length).toBe(3)
  // three hover groups: the mirror (the second reply's citation 1) does not light with the 12 runs (the first's 1)
  const scopes = labels.map(l => [...new Set(cites.filter(b => b.props.label === l).map(b => b.hover.scope))])
  expect(scopes.every(s => s.length === 1)).toBe(true)
  expect(new Set(scopes.flat()).size).toBe(3)
  // a press on the reworded mirror: the tray stands on the second reply's citation
  await t.press('s')
  const ui = await $.ui.mount(host)
  await ui.press({ key: cites.find(b => /package mirror/.test(b.props.label))!.props.key })
  await ui.unmount()
  const band = await t.bar()
  expect(band).toContain('slow mirror')
  expect(band).not.toContain('12 runs')
})

// A person opened an explainer of an older reply and the chips then opened under it: s squeezes the newest reply alone
test('s opens the chips under the newest reply, after a mark of an older one was opened or { picked an older one', { options: { citations: 'auto cite' } }, async ($, on) => {
  const t = await setup($, on, [])
  await t.turn('t1', LONG)
  await t.turn('t2', 'The retry passed on the [slow mirror](#).')
  // a citation of the first reply opened (the tray picks its answer for the marks' keys), then closed
  const cite = nodes(await $.ui.render(answer('row-t1', LONG))).find(n => n.type === 'Button' && /^citation 1/.test(String(n.props.label)))
  const ui = await $.ui.mount(answer('row-t1', LONG))
  await ui.press({ key: cite.props.key })
  await ui.unmount()
  expect(await t.bar()).toContain('3 of 12')
  await t.press('0')
  await t.press('s')
  expect((await chipsDrawn($, 'row-t2', 'The retry passed on the [slow mirror](#).')).client).toBeTruthy()
  expect((await chipsDrawn($, 'row-t1', LONG)).client).toBeFalsy()
  await t.press('s')
  // { picks the older answer for the marks' keys: s still opens the chips under the newest
  await t.press('{')
  await t.press('s')
  expect((await chipsDrawn($, 'row-t1', LONG)).client).toBeFalsy()
  expect((await chipsDrawn($, 'row-t2', 'The retry passed on the [slow mirror](#).')).client).toBeTruthy()
  await t.press('s')
  await t.turn('t3', 'Done.')
  await t.press('s')
  expect((await chipsDrawn($, 'row-t3', 'Done.')).client).toBeTruthy()
})

test('s pressed twice quickly opens the chips once and types nothing, as two keys or as one edit of both', async ($, on) => {
  const t = await setup($, on, [])
  await t.turn('t1', LONG)
  expect(await $.prompt.edit(key('s'))).toEqual({ text: '', cursor: 0 })
  await t.clock.advance(120)
  expect(await $.prompt.edit(key('s'))).toEqual({ text: '', cursor: 0 })
  await t.clock.advance(400)
  expect((await chipsDrawn($, 'row-t1', LONG)).client).toBeTruthy()
  await t.press('s')
  expect((await chipsDrawn($, 'row-t1', LONG)).client).toBeFalsy()
  // both in one edit (a burst)
  const burst = { origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'ss' } as never
  expect(await $.prompt.edit(burst)).toEqual({ text: '', cursor: 0 })
  await t.clock.advance(400)
  expect((await chipsDrawn($, 'row-t1', LONG)).client).toBeTruthy()
  // a word that starts with s is still typed whole
  await t.press('s')
  await $.prompt.edit(key('s'))
  await t.clock.advance(50)
  expect(await $.prompt.edit(key('o'))).toEqual({ text: 'so', cursor: 2 })
})

test('each chip names its ends; while a rewrite is on its way the text dims and the chips add no line, and a version seen before comes back with no call', async ($, on) => {
  const gates: ((v: string) => void)[] = []
  const t = await setup($, on, [new Promise<string>(r => { gates.push(r) })])
  await t.turn('t1', LONG)
  await t.press('s')
  const at0 = await chipsDrawn($, 'row-t1', LONG)
  expect(at0.client.props.props.items.map((c: Any) => c.ends)).toEqual([['shorter', 'longer'], ['novice', 'expert']])
  // the picked chip's ends name the keys that move it, [ and ]
  expect(flat(textOf(at0.tree))).toContain('1 Length [ shorter ○●○○ ] longer · as written')
  expect(flat(textOf(at0.tree))).toContain('2 Background novice ○○●○ expert')
  expect(textOf(at0.tree)).not.toContain('Interpretation')
  // each key the chips name is a press there: a chip's digit and name pick it, its ends move it, + adds one, s closes
  const presses = nodes(at0.tree).filter(n => n.type === 'Button').map(n => String(n.props.key))
  expect(presses).toEqual(expect.arrayContaining(['chip-length', 'chip-familiarity', 'step-length-down', 'step-length-up', 'add', 'close']))
  // a press on Background's name picks it: its ends name [ and ] now
  const pick = await $.ui.mount(answer('row-t1', LONG))
  await pick.press({ key: 'chip-familiarity' })
  await pick.unmount()
  expect(flat(textOf((await chipsDrawn($, 'row-t1', LONG)).tree))).toContain('2 Background [ novice ○○●○ ] expert')
  await t.press('2')
  await t.press('[')
  await t.press('[')
  await t.clock.advance(3200)
  expect(t.asked.length).toBe(1)
  const busy = await chipsDrawn($, 'row-t1', LONG)
  expect(textOf(busy.tree)).not.toContain('rewriting')
  expect(nodes(await $.ui.render(answer('row-t1', LONG))).some(n => n.props?.dimColor && textOf(n).includes('nightly build'))).toBe(true)
  gates.shift()!('The nightly build failed on [3 of 12](#) runs, in plain words.')
  await t.clock.advance(5000)
  expect(textOf(await $.ui.render(answer('row-t1', LONG)))).toContain('in plain words.')
  // back to the original and to that version again: no call
  await t.press('0')
  await t.press('[')
  await t.press('[')
  await t.clock.advance(3000)
  expect(t.asked.length).toBe(1)
  expect(textOf(await $.ui.render(answer('row-t1', LONG)))).toContain('in plain words.')
})

test('a press on a chip\'s end moves it one level toward that end, as [ and ] do, and no further than the end; a press on a dot sets that level', async ($, on) => {
  const t = await setup($, on, [])
  await t.turn('t1', LONG)
  await t.press('s')
  const level = async (id: string) => (await chipsDrawn($, 'row-t1', LONG)).client.props.props.items.find((c: Any) => c.id === id).level
  const ui = await $.ui.mount(answer('row-t1', LONG))
  // Length stands at as written: longer, then much longer, one level a press
  await ui.press({ key: 'step-length-up' })
  expect(await level('length')).toBe(2)
  await ui.press({ key: 'step-length-up' })
  expect(await level('length')).toBe(3)
  // at its end it stays, and the bar says it goes no further
  await ui.press({ key: 'step-length-up' })
  expect(await level('length')).toBe(3)
  expect(await t.bar()).toContain('goes no further')
  // Background stands at working: its novice end moves it to learning, and picks it
  await ui.press({ key: 'step-familiarity-down' })
  expect(await level('familiarity')).toBe(1)
  expect((await chipsDrawn($, 'row-t1', LONG)).client.props.props.items.find((c: Any) => c.picked).id).toBe('familiarity')
  // a dot sets its level at once
  await ui.press({ key: 'lvl-length-0' })
  expect(await level('length')).toBe(0)
  await ui.unmount()
})

test('on a catch-up a press on Length\'s longer end goes from short past as written (the replies themselves) to longer', async ($, on) => {
  const t = await setup($, on, ['Both: the build failed, and the retry passed.'])
  const newest = 'The retry passed on all runs.'
  await t.turn('t1', 'Earlier answer.')
  await t.turn('t2', 'The build failed on three runs.', { text: 'why did it fail?', by: 'composer' })
  await t.turn('t3', newest, { text: '<task-notification>done</task-notification>', by: 'task-notification' })
  // the chips open on the catch-up of the newest reply and the reply before
  await t.press('b')
  await t.clock.advance(5000)
  await t.press('s')
  // a catch-up arrives at Length short; as written is the replies themselves, so its longer end goes past it to longer
  const length = async () => (await chipsDrawn($, 'row-t3', newest)).client.props.props.items.find((c: Any) => c.id === 'length').level
  expect(await length()).toBe(0)
  const ui = await $.ui.mount(answer('row-t3', newest))
  await ui.press({ key: 'step-length-up' })
  expect(await length()).toBe(2)
  // and its shorter end goes back past it to short
  await ui.press({ key: 'step-length-down' })
  expect(await length()).toBe(0)
  await ui.unmount()
})

test('while a click holds the keys in the chips, ↵ keeps them open, and s closes them', async ($, on) => {
  const t = await setup($, on, [])
  await t.turn('t1', LONG)
  await t.press('s')
  const chips = async () => (await chipsDrawn($, 'row-t1', LONG)).client?.props.props
  const picked = async () => (await chips()).items.find((c: Any) => c.picked)?.id
  const ui = await $.ui.mount(answer('row-t1', LONG))
  // a click on the dot where Background stands picks it
  await ui.press({ key: 'lvl-familiarity-2' })
  expect(await picked()).toBe('familiarity')
  // ↵ keeps them open
  await ui.key({ key: 'return' })
  expect(await chips()).toBeDefined()
  await ui.key({ key: 's' })
  expect(await chips()).toBeUndefined()
  await ui.unmount()
})

test('each key shows once, where it acts: the open chips name theirs and the bar none of them; once a click gave the chips the keyboard, they name the same keys and esc, and the bar names no key at its left', async ($, on) => {
  const t = await setup($, on, ['The nightly build failed on [3 of 12](#) runs, in more words.'])
  await t.turn('t1', LONG)
  await t.press('s')
  const chips = async () => flat(textOf((await chipsDrawn($, 'row-t1', LONG)).tree))
  const left = async () => textOf(nodes(await $.ui.render(above)).find(n => n.props?.key === 'bar-left'))
  // at the prompt: a digit before each chip, [ and ] on the picked chip's ends, + your own and s close in the chips
  expect(await chips()).toContain('1 Length [ shorter ○●○○ ] longer · as written')
  expect(await chips()).toContain('2 Background novice ○○●○ expert')
  expect(await chips()).toContain('+ your own')
  expect(await chips()).toContain('s close')
  // 0 revert once there is a version to take back
  expect(await chips()).not.toContain('revert')
  await t.press(']')
  expect(await chips()).toContain('0 revert')
  await t.clock.advance(3000)
  // the bar names none of the chips' keys
  for (const k of ['s close', '[ ', '] ', '1–', 'chip', 'your own', 'revert']) expect(await t.bar()).not.toContain(k)
  // a click on a dot of Background, then a key in the chips: the chips hold the keyboard, and name the keys that act
  // there, the same as at the prompt, and esc; every key goes to the chips, so the bar's left names no key
  const ui = await $.ui.mount(answer('row-t1', LONG))
  await ui.press({ key: 'lvl-familiarity-2' })
  await ui.key({ key: 'return' })
  await ui.unmount()
  const held = await chips()
  for (const k of ['2 Background [ novice ○○●○ ] expert', 'esc back to the prompt', 's close']) expect(held).toContain(k)
  expect(await left()).toBe('thimble')
  // a press on esc back to the prompt: the keys are the prompt's again
  const esc = await $.ui.mount(answer('row-t1', LONG))
  await esc.press({ key: 'esc' })
  await esc.unmount()
  expect(await chips()).toContain('2 Background [ novice ○○●○ ] expert')
  expect(await chips()).not.toContain('esc back to the prompt')
  await t.clock.advance(5000)
})

test("a key in the chips that Claude Code also takes at the prompt, an arrow or tab, changes nothing, and nothing in the chips names one; thimble's own keys act there as at the prompt", async ($, on) => {
  const t = await setup($, on, ['The nightly build failed on [3 of 12](#) runs, in more words.'])
  await t.turn('t1', LONG)
  await t.press('s')
  const props = async () => (await chipsDrawn($, 'row-t1', LONG)).client?.props.props
  const levels = async () => Object.fromEntries((await props()).items.map((c: Any) => [c.id, c.level]))
  const picked = async () => (await props()).items.find((c: Any) => c.picked)?.id
  // a click on the dot where Length stands gives the chips the keyboard
  const ui = await $.ui.mount(answer('row-t1', LONG))
  await ui.press({ key: 'lvl-length-1' })
  const was = await levels()
  // each arrow and tab: no level moves, no chip is picked, nothing is asked
  for (const k of [{ key: 'left' }, { key: 'right' }, { key: 'tab' }, { key: 'tab', shift: true }, { key: 'up' }, { key: 'down' }]) {
    await ui.key(k as never)
    await t.clock.advance(400)
    expect([k, await levels(), await picked()]).toEqual([k, was, 'length'])
  }
  await t.clock.advance(3000)
  expect(t.asked.length).toBe(0)
  // nothing in the chips names an arrow or tab, held or not
  const words = flat(textOf((await chipsDrawn($, 'row-t1', LONG)).tree))
  for (const k of ['←', '→', '↑', '↓', 'tab']) expect(words).not.toContain(k)
  expect(words).toContain('1 Length [ shorter ○●○○ ] longer')
  // thimble's own keys act in the chips as at the prompt: 2 picks Background, ] moves it a level, and the rewrite runs
  await ui.key({ key: '2' })
  await ui.key({ key: ']' })
  await ui.unmount()
  expect(await picked()).toBe('familiarity')
  expect((await levels()).familiarity).toBe(was.familiarity + 1)
  await t.clock.advance(3000)
  expect(t.asked.length).toBe(1)
  // the chips still hold the keyboard after those keys: esc is still named
  expect(flat(textOf((await chipsDrawn($, 'row-t1', LONG)).tree))).toContain('esc back to the prompt')
})

/** Where each press of a drawing stands as the terminal lays it out at `width` (the card runner's layout, as Claude Code
 *  lays out the same tree): each press's address and the cells it takes (`x,y` from the top left: each press laid out
 *  with its words marked), and the drawing's rows. */
function placesOf(tree: Any, width: number): { at: Map<string, string[]>; rows: number } {
  const MARK = '¤'
  const conv = (n: Any, mark: string | null, inMark = false): Any => {
    if (n == null || n === false) return null
    if (typeof n === 'string' || typeof n === 'number') return inMark ? MARK.repeat([...String(n)].length) : String(n)
    if (Array.isArray(n)) return n.map(x => conv(x, mark, inMark)).filter((x: Any) => x != null)
    const marked = inMark || (n.type === 'Button' && String(n.props?.key) === mark)
    const kids = conv([n.props?.children].flat(), mark, marked)
    const { children: _c, key: _k, onPress: _o, label: _l, plain: _p, hover: _h, ...p } = n.props ?? {}
    return n.type === 'Button' ? { t: 'Box', p: { flexDirection: 'row', flexShrink: 0, alignSelf: 'flex-start' }, c: kids } : { t: n.type, p, c: kids }
  }
  const presses = nodes(tree).filter(n => n.type === 'Button').map(n => String(n.props.key))
  const plain = layoutLines(conv(tree, null), width).lines
  const at = new Map<string, string[]>()
  for (const id of presses) {
    const lines = layoutLines(conv(tree, id), width).lines
    const cells: string[] = []
    lines.forEach((l, y) => [...l].forEach((ch, x) => { if (ch === MARK && [...(plain[y] ?? '')][x] !== MARK) cells.push(`${x},${y}`) }))
    at.set(id, cells)
  }
  return { at, rows: plain.length }
}

test("the chips' parts keep their places while they are open, so a click lands where it was aimed: a level, its words, a rewrite on its way, a version to take back, the keyboard given to them, another chip picked, a tray over them; close is named once", { options: { citations: 'auto cite' } }, async ($, on) => {
  const gates: ((v: string) => void)[] = []
  const t = await setup($, on, [new Promise<string>(r => { gates.push(r) }), new Promise<string>(r => { gates.push(r) })])
  await t.turn('t1', LONG)
  await t.press('s')
  const shots: { what: string; at: Map<string, string[]>; rows: number }[] = []
  const shot = async (what: string) => {
    const { client, tree } = await chipsDrawn($, 'row-t1', LONG)
    shots.push({ what, ...placesOf(tree, Number(client.props.props.width)) })
    // close is named once: in the chips, and not on the bar
    expect([...shots.at(-1)!.at.keys()].filter(k => k === 'close')).toEqual(['close'])
    expect(await t.bar()).not.toContain('s close')
  }
  await shot('opened')
  await $.prompt.edit(key(']'))
  await shot('a level picked, its words longer')
  await t.clock.advance(1500)
  expect(await t.bar()).toContain('rewriting')
  await shot('rewriting')
  await $.prompt.edit(key(']'))
  // the call it stopped answers late; its words are not shown
  gates.shift()!('The build failed on [3 of 12](#) runs: the longer version, now old.')
  await t.clock.advance(300)
  await shot('a level further, its words longer still')
  const ui = await $.ui.mount(answer('row-t1', LONG))
  await ui.press({ key: 'lvl-length-3' })
  await ui.key({ key: 'return' })
  await shot('the keyboard given to the chips')
  await ui.key({ key: '2' })
  await shot('Background picked')
  await ui.key({ key: '0' })
  await t.clock.advance(300)
  await shot('the original again, nothing to take back')
  await ui.key({ key: '1' })
  await ui.key({ key: ']' })
  await ui.unmount()
  await t.clock.advance(1500)
  for (const g of gates) g('The build failed on [3 of 12](#) runs: the longer version.')
  await t.clock.advance(5000)
  expect(textOf(await $.ui.render(answer('row-t1', LONG)))).toContain('the longer version.')
  await shot('a version written')
  // a citation opened over the chips: the tray holds the keys, and the chips name none of theirs
  const cite = nodes(await $.ui.render(answer('row-t1', LONG))).find(n => n.type === 'Button' && /^citation 1/.test(String(n.props.label)))
  const reply = await $.ui.mount(answer('row-t1', LONG))
  await reply.press({ key: cite.props.key })
  await reply.unmount()
  expect(await t.bar()).toContain('0 close')
  await shot('a tray over the chips')
  // every part stands where it stood in the drawing before: the same cells (a level's words, which end their row, where
  // they start), and the chips take the same rows
  for (let i = 1; i < shots.length; i++) {
    const [a, b] = [shots[i - 1]!, shots[i]!]
    expect([b.what, b.rows]).toEqual([b.what, a.rows])
    for (const [id, cells] of b.at) {
      const was = a.at.get(id)
      if (!was) continue
      expect([b.what, id, id.startsWith('word-') ? cells[0] : cells.join(' ')]).toEqual([b.what, id, id.startsWith('word-') ? was[0] : was.join(' ')])
    }
  }
})

test('closing the chips keeps the version the answer shows and starts nothing: a level asked for and still waiting, or a rewrite running, stops, by s or a press on close', async ($, on) => {
  const gates: ((v: string) => void)[] = []
  const t = await setup($, on, [new Promise<string>(r => { gates.push(r) }), 'The build failed on [3 of 12](#) runs: the much longer version.'])
  await t.turn('t1', LONG)
  const shown = async () => textOf(await $.ui.render(answer('row-t1', LONG)))
  const dim = async () => nodes(await $.ui.render(answer('row-t1', LONG))).some(n => n.props?.dimColor && textOf(n).includes('nightly build'))
  // ] asked for a longer version, then s within its wait (after the word window of ]): no call, the answer as written
  // and not dim
  await t.press('s')
  await $.prompt.edit(key(']'))
  await t.clock.advance(400)
  expect(await dim()).toBe(true)
  await t.press('s')
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(0)
  expect(await dim()).toBe(false)
  expect(await shown()).toContain('The nightly build failed on')
  expect(await t.bar()).not.toContain('rewriting')
  // opened again: the chips stand where the answer does, as written
  await t.press('s')
  expect((await chipsDrawn($, 'row-t1', LONG)).client.props.props.items.find((c: Any) => c.id === 'length').level).toBe(1)
  // ] again, its rewrite running, then a press on close: the call stops, and its words, had they come, are not shown
  await $.prompt.edit(key(']'))
  await t.clock.advance(1500)
  expect(t.asked.length).toBe(1)
  expect(await t.bar()).toContain('rewriting')
  const ui = await $.ui.mount(answer('row-t1', LONG))
  await ui.press({ key: 'close' })
  await ui.unmount()
  expect(await t.bar()).not.toContain('rewriting')
  gates.shift()!('The build failed on [3 of 12](#) runs: the longer version, too late.')
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(1)
  expect(await shown()).not.toContain('too late')
  expect(await shown()).toContain('The nightly build failed on')
  expect(await dim()).toBe(false)
  // s that starts a word (a letter right after it) opens the chips again, and the level asked for is asked again
  await t.press('s')
  await $.prompt.edit(key(']'))
  await t.clock.advance(400)
  await $.prompt.edit(key('s'))
  await $.prompt.edit({ ...(key('o') as Any), text: 's', cursor: 1, start: 1, end: 1 } as never)
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(2)
  expect(String(t.asked[1].prompt)).toContain('Length: longer')
  expect(await shown()).toContain('the much longer version.')
})

test("a click that slid a cell on the chips leaves a piece of what they draw selected in the answer's row, a chip's digit, its dots, its level words or +: no c cite or e explain, once s closed them too; words of the answer selected after count", { options: { citations: 'manual' } }, async ($, on) => {
  let selected: Any
  on('ui.selection', () => ({ value: selected }))
  const t = await setup($, on, [])
  await t.turn('t1', LONG)
  const counts = (band: string) => {
    expect(band.includes('c cite')).toBe(band.includes('e explain'))
    return band.includes('c cite')
  }
  for (const piece of ['1 ', '2 ', '●○', '○●', '○○', '· a', '+']) {
    selected = undefined
    await t.bar()
    await t.press('s')
    // the chips under the answer draw it: `1 Length shorter ○●○○ longer · as written`, `2 Background novice ○○●○
    // expert`, `+`, `s close`
    expect(textOf((await chipsDrawn($, 'row-t1', LONG)).tree)).toContain(piece)
    // the click left it selected, in the answer's row; the chips hold the keys
    selected = { text: piece, requestId: 'row-t1' }
    expect(counts(await t.bar())).toBe(false)
    // s closes them, and the selection stands
    await t.press('s')
    expect((await chipsDrawn($, 'row-t1', LONG)).client).toBeUndefined()
    expect(counts(await t.bar())).toBe(false)
  }
  // words of the answer, selected once the chips closed
  selected = undefined
  await t.bar()
  selected = { text: 'cache key', requestId: 'row-t1' }
  expect(counts(await t.bar())).toBe(true)
})

test('the rewrite starts from the corrected citations: the request holds the corrected value alone, and names no correction', async ($, on) => {
  // a resumed session: the check corrected the reply's citation
  const at = LONG.indexOf('[3 of 12](#)')
  const t = await setup($, on, ['The build failed on [4 of 12](#) runs.'], {
    'marks/row-t1.json': JSON.stringify({ key: 'row-t1', turnId: 't1', rows: ['row-t1'], startedAt: 0, settledAt: 1, items: [
      { n: 1, row: 'row-t1', words: '3 of 12', start: at, end: at + 12, sentence: 'The nightly build failed on [3 of 12] runs.', status: 'corrected', shown: '4 of 12', was: '3 of 12' },
    ] }),
    'answers/t1.json': JSON.stringify({ v: 1, turn: { turnId: 't1', n: 1, prompt: { text: 'why did it fail?', by: 'composer', row: 'row-q1' }, rows: ['row-t1'], answer: 'row-t1', reason: 'answer', startedAt: 0, endedAt: 1, labels: [], cards: [], seq: 0 }, msgs: [{ row: 'row-t1', turnId: 't1', text: LONG, at: 1 }] }),
  })
  expect(textOf(await $.ui.render(answer('row-t1', LONG)))).toContain('4 of 12 runs')
  await t.press('s')
  await t.press('[')
  await t.clock.advance(3000)
  const prompt = JSON.stringify(t.asked[0].prompt)
  expect(prompt).toContain('[4 of 12](#)')
  expect(prompt).not.toContain('3 of 12')
  expect(prompt).not.toContain('Corrections in the original')
})

test('a click on + your own does what + does at the prompt: the prompt box takes the words, and nothing names ↵ or tab; + typed while the chips hold the keyboard types a chip in them, and a key at the prompt (esc gave it the keys) or esc esc clearing it lets the words go', async ($, on) => {
  const t = await setup($, on, [])
  await t.turn('t1', LONG)
  await t.press('s')
  const ui = await $.ui.mount(answer('row-t1', LONG))
  await ui.press({ key: 'add' })
  // the box takes /rewrite, which the person's words follow, and the bar asks what for; the chips name no ↵ or tab
  expect(t.fills.map((f: Any) => f.text)).toEqual(['/rewrite '])
  expect(await t.bar()).toContain('rewrite for…')
  const asked = await chipsDrawn($, 'row-t1', LONG)
  expect(asked.client.props.props.plus).toBe(null)
  for (const k of ['↵', 'tab']) expect(textOf(asked.tree)).not.toContain(k)
  // + typed in the chips, where a key reached them: the words are typed in the chips
  await ui.key({ key: '+' })
  await ui.unmount()
  const typing = await chipsDrawn($, 'row-t1', LONG)
  expect(typing.client.props.props.plus).toBe('')
  // the chips say what ↵ and tab do there; the bar does not
  expect(textOf(typing.tree)).toContain('+ ▏ ↵ adds it · tab lets it go')
  expect(await t.bar()).not.toContain('adds it')
  await $.prompt.edit({ origin: { kind: 'composer' }, text: 'h', cursor: 1, start: 0, end: 0, inputText: 'h', key: { key: 'h' } } as never)
  expect((await chipsDrawn($, 'row-t1', LONG)).client.props.props.plus).toBe(null)
  // + at the prompt: /rewrite in the box, and the bar asks what for; esc esc clears the box, and the bar lets it go
  await t.press('+')
  expect(await t.bar()).toContain('rewrite for…')
  await $.prompt.change({ text: '', cursor: 0, origin: { kind: 'clear' } } as never)
  expect(await t.bar()).not.toContain('rewrite for')
})

test('the chips draw in one color: the frame, the keys, the picked chip, its dot and its level words in thimble\'s purple, no amber', async () => {
  const surface = { elements: ELS, columns: 100, onKey: () => undefined, post: () => undefined }
  const items = [
    { id: 'length', n: 1, name: 'Length', levels: ['shorter', 'as written', 'longer'], level: 1, level0: 1, word: 'as written', picked: true },
    { id: 'reader', n: 2, name: 'Background', levels: ['new', 'expert'], level: 0, level0: 0, word: 'new', picked: false },
  ]
  const tree = Chips({ items, plus: 'for a manager', width: 90, color: 'merged' } as never, surface as never)
  const all = nodes(tree)
  expect(all.some(n => n.props?.color === 'warning')).toBe(false)
  expect(tree.props.borderColor).toBe('merged')
  const texts = all.filter(n => n.type === 'Text')
  for (const words of ['1 ', 'Length ', '●', ' · as written', '+ for a manager▏']) expect(texts.find(n => n.props.children === words)?.props.color).toBe('merged')
})

// s works from an open tray: the chips take the keys, and the tray gives way (it held them over the chips)
test('s with the tray open closes it and opens the chips with their keys; over open chips s gives the keys back to them; s that starts a word leaves the tray as it was', { options: { citations: 'auto cite' } }, async ($, on) => {
  const text = 'Of the [12 runs](#), [3 failed](#) on the [slow mirror](#).'
  const t = await setup($, on, [])
  await t.turn('t1', text)
  const cite = nodes(await $.ui.render(answer('row-t1', text))).find(n => n.type === 'Button' && /^citation 2/.test(String(n.props.label)))
  const openCite = async () => { const ui = await $.ui.mount(answer('row-t1', text)); await ui.press({ key: cite.props.key }); await ui.unmount() }
  await openCite()
  expect(await t.bar()).toContain('0 close')
  // s: the tray closes, and the chips open under the answer, their keys in them
  await t.press('s')
  const drawn = async () => textOf((await chipsDrawn($, 'row-t1', text)).tree)
  expect(await t.bar()).not.toContain('0 close')
  expect(await drawn()).toContain('s close')
  expect(await drawn()).toContain('] longer')
  // a citation opened over the open chips takes the keys, which the chips no longer name; s gives them back to the
  // chips, which stay open
  await openCite()
  expect(await drawn()).not.toContain('] longer')
  await t.press('s')
  expect(await t.bar()).not.toContain('0 close')
  expect(await drawn()).toContain('] longer')
  // s typed as the first letter of a word: the word goes into the box, the tray stands open, the chips stay closed
  await t.press('s')
  await openCite()
  await $.prompt.edit(key('s'))
  await t.clock.advance(50)
  expect(await $.prompt.edit(key('o'))).toEqual({ text: 'so', cursor: 2 })
  await t.clock.advance(400)
  const word = await t.bar()
  expect(word).toContain('0 close')
  expect(word).not.toContain('s close')
})

test('s while an answer is being written waits for it, `s rewrite` lit on the bar while it waits (a press ends the wait, as s again does), and the chips open on that answer, never on the one before', async ($, on) => {
  const t = await setup($, on, [])
  await t.turn('t1', LONG)
  // the item's words: dim at rest, in thimble's color while s waits
  const item = async () => {
    const press = nodes(await $.ui.render(above)).find(n => n.type === 'Button' && n.props?.key === 'bar-squeeze')
    return { text: textOf(press), words: nodes(press).find(n => n.type === 'Text' && textOf(n) === ' rewrite')?.props }
  }
  // the next turn runs: its answer is being written
  await t.ask('and the retries?')
  await $.turn.start({ text: 'and the retries?', turnId: 't2' } as never)
  expect(await item()).toMatchObject({ text: 's rewrite', words: { dimColor: true } })
  await t.press('s')
  expect((await chipsDrawn($, 'row-t1', LONG)).client).toBeFalsy()
  // waiting: the same key and words, lit; no words say so
  let waits = await item()
  expect(waits.text).toBe('s rewrite')
  expect(waits.words?.color).toBe(accent())
  expect(waits.words?.dimColor).toBeUndefined()
  expect(await t.bar()).not.toContain('when the answer finishes')
  // a press on it ends the wait, as s again does; s waits again
  const ui = await $.ui.mount(above)
  await ui.press({ key: 'bar-squeeze' })
  await ui.unmount()
  expect((await item()).words).toMatchObject({ dimColor: true })
  await t.press('s')
  waits = await item()
  expect(waits.words?.color).toBe(accent())
  // the answer finishes: the chips open on it
  const two = 'The retries passed on the second try.'
  await t.say('row-t2', two)
  await $.turn.complete({ turnId: 't2', reason: 'answer', answer: two, durationMs: 10, isAborted: false } as never)
  expect((await chipsDrawn($, 'row-t2', two)).client).toBeTruthy()
  expect((await chipsDrawn($, 'row-t1', LONG)).client).toBeFalsy()
  expect(textOf((await chipsDrawn($, 'row-t2', two)).tree)).toContain('s close')
})
