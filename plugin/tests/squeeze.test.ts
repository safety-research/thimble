// Squeeze and catch-up in the terminal (squeeze/): s at an empty prompt opens the chips under the answer, ] asks one
// rewrite and the new text shows in place of Claude's words, Claude hears the version with the next prompt, 0 brings
// the original back with no call; with two replies since the person's last prompt, s opens the same chips under the
// newest, and they offer a catch-up as one more chip, which writes one catch-up of them, and 0 dismisses it; keys
// pressed in a row make one rewrite, and the latest one shows. All data is made up. `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

import { resetSqueeze } from '../squeeze/term'
import Chips from '../squeeze/chips.tsx'
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

async function setup($: Any, on: Any, replies: (string | Promise<string>)[]) {
  resetSqueeze()
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp', PATH: '/usr/bin' })
  const clock = mock.clock(on, { now: 0 })
  const files: Record<string, string> = {}
  const asked: Any[] = []
  on('session.id', () => ({ value: 's-squeeze' }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('session.messages', () => ({ value: [] }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files[e.path] ?? promptStub(e.path) ?? '' }))
  on('fs.write', (_$: unknown, e: { path: string; content: string }) => { files[e.path] = String(e.content); return { value: undefined } })
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files }))
  on('fs.stat', () => ({ value: { kind: 'missing', size: 0 } }))
  on('env.set', () => ({ value: {} }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.scroll', () => ({ value: undefined }))
  on('prompt.fill', () => ({ value: undefined }))
  on('model.fork', () => ({ value: { isAnswered: true, text: '{}' } }))
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
  return { clock, asked, ask, say, turn, press, bar }
}

const LONG = 'The nightly build failed on [3 of 12](#) runs. The cache key changed when the lockfile moved, so every run fetched again, and the slow mirror timed out.'

test('s opens the chips; ] writes a longer version in place, Claude hears it with the next prompt, and 0 brings the original back with no call', async ($, on) => {
  const t = await setup($, on, ['The build failed on [3 of 12](#) runs: the cache key changed with the lockfile, and the mirror timed out on each fresh fetch.'])
  await t.turn('t1', LONG)
  expect(await t.bar()).toContain('s squeeze')
  expect(await t.press('s')).toEqual({ text: '', cursor: 0 })
  const open = await t.bar()
  expect(open).toContain('[ ] shorter / longer')
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
  // the chips close with s; the bar says the levels set
  await t.press('s')
  expect(await t.bar()).toContain('● longer')
  const next = await t.ask('and now?')
  expect(String((next.context ?? []).join('\n'))).toContain('now reads, for the analyst, as:')
  // 0 brings the original back, with no call
  await t.press('s')
  await t.press('0')
  await t.clock.advance(1000)
  expect(t.asked.length).toBe(1)
  const back = textOf(await $.ui.render(answer('row-t1', LONG)))
  // (no check of the reply ran here, so its citation draws failed, ? after it)
  expect(back).toContain('The nightly build failed on 3 of 12 × runs')
  expect(back).not.toContain('fresh fetch')
})

test('with two replies since the last prompt, s opens the chips with a catch-up chip; picked, it writes one catch-up under the newest; 0 brings the replies back', async ($, on) => {
  const t = await setup($, on, ['Both: the build failed, and the retry passed.'])
  await t.turn('t1', 'Earlier answer.')
  await t.turn('t2', 'The build failed on three runs.', { text: 'why did it fail?', by: 'composer' })
  await t.turn('t3', 'The retry passed on all runs.', { text: '<task-notification>done</task-notification>', by: 'task-notification' })
  expect(await t.bar()).toContain('s squeeze or catch up')
  // s opens the chips under the newest reply, with no call; the catch-up is the chip after the three
  await t.press('s')
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(0)
  expect(await t.bar()).toContain('1–4 chip')
  const { client, tree } = await chipsDrawn($, 'row-t3', 'The retry passed on all runs.')
  expect(client?.props.props.catchup).toEqual({ n: 4, replies: 2 })
  expect(textOf(tree)).toContain('4 Catch up on 2 replies')
  await t.press('4')
  await t.clock.advance(5000)
  expect(String(t.asked[0].prompt)).toContain("Claude's messages since the analyst's last prompt")
  expect(String(t.asked[0].prompt)).toContain('The analyst asked: why did it fail?')
  // the covered reply draws nothing; the newest draws the catch-up with its head line
  expect(textOf(await $.ui.render(answer('row-t2', 'The build failed on three runs.')))).toBe('')
  const host = textOf(await $.ui.render(answer('row-t3', 'The retry passed on all runs.')))
  expect(host).toContain('catch-up of the 2 replies since your last message')
  expect(host).toContain('Both: the build failed, and the retry passed.')
  await t.press('0')
  expect(textOf(await $.ui.render(answer('row-t2', 'The build failed on three runs.')))).toBe('the engine')
  // a catch-up the person read counts: s opens the chips on the newest reply, with no catch-up chip
  expect(await t.bar()).not.toContain('catch up')
  await t.press('s')
  expect((await chipsDrawn($, 'row-t3', 'The retry passed on all runs.')).client?.props.props.catchup).toBe(null)
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

test('a citation opened over the open chips takes the keys: the bar names 0 once, 0 closes the tray and keeps the version, then the chips take 0 again', async ($, on) => {
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
  // the tray is open over the chips: the bar names its keys alone, each key once
  const open = await t.bar()
  expect(open).toContain('3 failed')
  expect(open.match(/0 (close|back|revert)/g)).toEqual(['0 close'])
  expect(open).not.toContain('shorter / longer')
  // 0 closes the tray; the longer version stays, and the chips hold the keys again
  await t.press('0')
  expect(await t.bar()).not.toContain('0 close')
  expect(textOf(await $.ui.render(answer('row-t1', text)))).toContain('slow package mirror')
  expect(await t.bar()).toContain('0 revert')
  await t.press('0')
  expect(textOf(await $.ui.render(answer('row-t1', text)))).not.toContain('slow package mirror')
})

// A catch-up words the replies' citations anew, and each reply numbers its citations from 1. Each citation of the
// catch-up stands for the reply's citation that states the same claim: a press on a reworded one acts on that citation
// (the tray stands on it), and citations of two replies light apart, each in its own hover group
test("a catch-up's reworded citations: a press acts on the reply's citation with the same claim, and two replies' citations light apart", async ($, on) => {
  const t = await setup($, on, ['Of all [12 nightly runs](#), [3 of them failed](#); the retry then passed on [the slow package mirror](#).'])
  await t.turn('t1', 'Earlier answer.')
  await t.turn('t2', 'Of the [12 runs](#), [3 failed](#).', { text: 'why did it fail?', by: 'composer' })
  await t.turn('t3', 'The retry passed on the [slow mirror](#).', { text: '<task-notification>done</task-notification>', by: 'task-notification' })
  await t.press('s')
  await t.press('4')
  await t.clock.advance(5000)
  const host = answer('row-t3', 'The retry passed on the [slow mirror](#).')
  const all = (n: Any): Any[] => (n == null || typeof n !== 'object' ? [] : [n, ...[n.props?.children, n.children].flat(Infinity).flatMap(all)])
  const cites = all(await $.ui.render(host)).filter(n => n.type === 'Button' && /^citation /.test(String(n.props.label)))
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
