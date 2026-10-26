// Squeeze and catch-up in the terminal (squeeze/): s at an empty prompt opens the chips under the answer, ] asks one
// rewrite and the new text shows in place of Claude's words, Claude hears the version with the next prompt, 0 brings
// the original back with no call; with two replies since the person's last prompt, b writes one catch-up of them below
// the newest, while the replies still show, with their explainers on its words and their cards moved into it; keys
// pressed in a row make one rewrite, and the latest one shows. All data is made up. `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

import { cardWidth } from '../cards/draw'
import { resetSqueeze } from '../squeeze/term'
import Chips from '../squeeze/chips.tsx'
import Rule from '../squeeze/rule.tsx'
import { promptStub, tempRun } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + (n.type === 'Markdown' ? String(n.props.text) : '') + textOf(n.children)
}

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
  on('prompt.fill', () => ({ isFilled: true }) as never)
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
  return { clock, asked, forks, ask, say, turn, press, bar, files }
}

const LONG = 'The nightly build failed on [3 of 12](#) runs. The cache key changed when the lockfile moved, so every run fetched again, and the slow mirror timed out.'

test('s opens the chips; ] writes a longer version in place, Claude hears it with the next prompt, and 0 brings the original back with no call', { options: { citations: 'auto cite' } }, async ($, on) => {
  const t = await setup($, on, ['The build failed on [3 of 12](#) runs: the cache key changed with the lockfile, and the mirror timed out on each fresh fetch.'])
  await t.turn('t1', LONG)
  expect(await t.bar()).toContain('s squeeze')
  expect(await t.press('s')).toEqual({ text: '', cursor: 0 })
  const open = await t.bar()
  expect(open).toContain('[ shorter · ] longer')
  // leaving comes first: `s close` is the bar's first item while the chips are open
  expect(open).toContain('thimble  s close · ')
  expect(open).not.toContain('s done')
  expect(open).toContain('+ your own')
  const under = textOf(await $.ui.render(answer('row-t1', LONG)))
  expect(under).toContain(LONG.slice(0, 20))
  await t.press(']')
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(1)
  expect(String(t.asked[0].prompt)).toContain('Length: longer')
  const shown = textOf(await $.ui.render(answer('row-t1', LONG)))
  expect(shown).toContain('on each fresh fetch')
  // the chips close with s; the bar says squeeze as before, not the levels set
  await t.press('s')
  expect(await t.bar()).toContain('s squeeze')
  expect(await t.bar()).not.toContain('longer')
  const next = await t.ask('and now?')
  expect(String((next.context ?? []).join('\n'))).toContain('now reads, for the analyst, as:')
  // 0 brings the original back, with no call
  await t.press('s')
  await t.press('0')
  await t.clock.advance(1000)
  expect(t.asked.length).toBe(1)
  const back = textOf(await $.ui.render(answer('row-t1', LONG)))
  // (citations are checked when opened, by default, so its citation draws as written)
  expect(back).toContain('The nightly build failed on 3 of 12 runs')
  expect(back).not.toContain('fresh fetch')
})

test('with two replies since the last prompt, the bar names b apart from s; b writes one catch-up below the newest, the replies still show, and the chips stay closed', async ($, on) => {
  const t = await setup($, on, ['Both: the build failed, and the retry passed.'])
  await t.turn('t1', 'Earlier answer.')
  await t.turn('t2', 'The build failed on three runs.', { text: 'why did it fail?', by: 'composer' })
  await t.turn('t3', 'The retry passed on all runs.', { text: '<task-notification>done</task-notification>', by: 'task-notification' })
  expect(await t.bar()).toContain('s squeeze · b catch up on 2 replies')
  // s opens the chips under the newest reply, with no call and no catch-up among them
  await t.press('s')
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(0)
  expect(await t.bar()).toContain('1–3 chip')
  expect(textOf((await chipsDrawn($, 'row-t3', 'The retry passed on all runs.')).tree)).not.toContain('atch up')
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
  // the tray is open over the chips: its keys in its header, and the bar names none of the chips' keys, each key once
  const open = await t.bar()
  expect(open).toContain('3 failed')
  expect(open.match(/0 (close|back|revert)/g)).toEqual(['0 close'])
  expect(open).not.toContain('] longer')
  // 0 closes the tray; the longer version stays, and the chips hold the keys again
  await t.press('0')
  expect(await t.bar()).not.toContain('0 close')
  expect(textOf(await $.ui.render(answer('row-t1', text)))).toContain('slow package mirror')
  expect(await t.bar()).toContain('0 revert')
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
  // its rule is a Client given the catch-up's whole height, which draws one ▎ per row of it, in a box that cuts it at
  // the catch-up's last row
  const rule = nodes(host).find(n => n.type === 'Client' && String(n.props.module).endsWith('/rule.tsx'))
  expect(rule?.props.height).toBe('100%')
  expect(nodes(host).find(n => n.props?.key === 'cu-rule')?.props.overflow).toBe('hidden')
  const lines = (rows: number) => textOf(Rule({ color: 'purple' }, { elements: { Text: (p: Any) => ({ type: 'Text', props: p }) }, rows } as never)).split('\n')
  expect(lines(7)).toEqual(Array(7).fill('▎'))
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
  expect(at0.client.props.props.items.map((c: Any) => c.ends)).toEqual([['shorter', 'longer'], ['facts', 'expert reading'], ['new', 'expert']])
  expect(textOf(at0.tree)).toContain('1 Length shorter ○●○○ longer · as written')
  expect(textOf(at0.tree)).toContain('2 Interpretation facts ○●○ expert reading')
  // a press on an end sets that level
  expect(nodes(at0.tree).some(n => n.type === 'Button' && n.props.label === 'Background: new')).toBe(true)
  // each of the bar's keys is a press: [ and ] each one way, and 1–3 picks the next chip
  const bar = nodes(await $.ui.render(above)).filter(n => n.type === 'Button').map(n => String(n.props.label))
  expect(bar).toEqual(expect.arrayContaining(['s close', '[ shorter', '] longer', '1–3 chip', '+ your own']))
  const pressBar = async (k: string) => { const ui = await $.ui.mount(above); await ui.press({ key: k }); await ui.unmount() }
  await pressBar('bar-sq-pick')
  expect(await t.bar()).toContain('[ facts · ] interpretation')
  await t.press('3')
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

test('+ in the chips types a chip, and a key at the prompt (esc gave it the keys) or esc esc clearing it lets the words go', async ($, on) => {
  const t = await setup($, on, [])
  await t.turn('t1', LONG)
  await t.press('s')
  const ui = await $.ui.mount(answer('row-t1', LONG))
  await ui.press({ key: 'add' })
  await ui.unmount()
  const typing = await chipsDrawn($, 'row-t1', LONG)
  expect(typing.client.props.props.plus).toBe('')
  expect(textOf(typing.tree)).toContain('+ ▏')
  expect(await t.bar()).toContain('+ ▏ ↵ adds it · tab lets it go')
  await $.prompt.edit({ origin: { kind: 'composer' }, text: 'h', cursor: 1, start: 0, end: 0, inputText: 'h', key: { key: 'h' } } as never)
  expect((await chipsDrawn($, 'row-t1', LONG)).client.props.props.plus).toBe(null)
  // + at the prompt: /squeeze in the box, and the bar asks what for; esc esc clears the box, and the bar lets it go
  await t.press('+')
  expect(await t.bar()).toContain('squeeze for…')
  await $.prompt.change({ text: '', cursor: 0, origin: { kind: 'clear' } } as never)
  expect(await t.bar()).not.toContain('squeeze for')
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
