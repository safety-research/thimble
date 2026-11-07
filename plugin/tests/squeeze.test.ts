// Simplify and catch-up in the terminal (squeeze/): s at an empty prompt writes a simpler version of the answer below
// it in one press, at Length short and Background learning; s again opens the chips on it, ] asks one more call, Claude
// hears the version with the next prompt, and 0 removes it; a letter right after s undoes it; with two replies since
// the person's last prompt, b writes one catch-up of them below the newest, in place of a simpler version there; an
// arrow or tab in the chips changes nothing. All data is made up. `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

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
  on('prompt.fill', () => ({ isFilled: true }) as never)
  on('prompt.edit', (_$: unknown, e: Any) => ({ text: e.text, cursor: e.cursor }))
  on('prompt.change', (_$: unknown, e: Any) => ({ text: e.text, cursor: e.cursor }))
  // the observer's look finds nothing to add
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
  return { clock, asked, ask, turn, press, bar }
}

const LONG = 'The nightly build failed on [3 of 12](#) runs. The cache key changed when the lockfile moved, so every run fetched again, and the slow mirror timed out.'

const SHORT = 'The build failed on [3 of 12](#) runs: the cache key changed.'
const levelsOf = (props: Any) => Object.fromEntries(props.items.map((c: Any) => [c.id, c.level]))
const clientUnder = async ($: Any, row: string, text: string) => nodes(await $.ui.render(answer(row, text))).find(n => n.type === 'Client')

test('s writes a simpler version below the answer in one press, at Length short and Background learning; s again opens the chips on it, ] asks one more call, Claude hears it with the next prompt, and 0 removes it with no call', { options: { citations: 'auto cite' } }, async ($, on) => {
  const t = await setup($, on, [SHORT, 'The build failed on [3 of 12](#) runs, because the cache key changed when the lockfile moved, in more words.'])
  await t.turn('t1', LONG)
  expect(await t.bar()).toContain('s simplify')
  expect(await t.bar()).not.toContain('rewrite')
  expect(await t.press('s')).toEqual({ text: '', cursor: 0 })
  await t.clock.advance(5000)
  // one call, which names one message to make simpler, at Length short and Background learning
  expect(t.asked.length).toBe(1)
  const asked = String(t.asked[0].prompt)
  expect(asked).toContain('Write one simpler message of it')
  expect(asked).toContain('Length: short.')
  expect(asked).toContain('Background: learning.')
  expect(asked).toContain('The analyst asked: question t1')
  // the answer still shows as written, and the simpler version stands below it with its head line; no chips open
  const host = textOf(await $.ui.render(answer('row-t1', LONG)))
  expect(host.indexOf('the engine')).toBeLessThan(host.indexOf('simpler version of the answer above'))
  expect(host).toContain('the cache key changed.')
  expect(await clientUnder($, 'row-t1', LONG)).toBeUndefined()
  // s again opens the chips on it, with no call: they stand at the levels it arrived at
  await t.press('s')
  const { client, tree } = await chipsDrawn($, 'row-t1', LONG)
  expect(client?.props.module).toMatch(/chips\.tsx$/)
  expect(levelsOf(client?.props.props)).toEqual({ length: 0, familiarity: 1 })
  for (const k of ['1 Length', '[ shorter', '] longer', '2 Background', '+ your own', '0 revert', 's close']) expect(textOf(tree)).toContain(k)
  expect(t.asked.length).toBe(1)
  // ] makes it longer: one more call, written below the answer, never in place of it
  await t.press(']')
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(2)
  expect(String(t.asked[1].prompt)).toContain('Length: as written.')
  const longer = textOf(await $.ui.render(answer('row-t1', LONG)))
  expect(longer).toContain('because the cache key changed')
  expect(longer).toContain('simpler version of the answer above')
  // s closes the chips; the bar says simplify as before
  await t.press('s')
  expect(await clientUnder($, 'row-t1', LONG)).toBeUndefined()
  expect(await t.bar()).toContain('s simplify')
  const next = await t.ask('and now?')
  expect(String((next.context ?? []).join('\n'))).toContain('the analyst read a simpler version of it')
  // 0 in its chips removes it, with no call
  await t.press('s')
  await t.press('0')
  await t.clock.advance(1000)
  expect(t.asked.length).toBe(2)
  const back = textOf(await $.ui.render(answer('row-t1', LONG)))
  expect(back).not.toContain('simpler version of the answer above')
  expect(back).not.toContain('because the cache key changed')
  expect(await clientUnder($, 'row-t1', LONG)).toBeUndefined()
  // s once more writes a new one
  await t.press('s')
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(3)
  expect(textOf(await $.ui.render(answer('row-t1', LONG)))).toContain('simpler version of the answer above')
})

test('a letter right after s undoes it: the word goes into the box whole, and no simpler version is written', async ($, on) => {
  const t = await setup($, on, [SHORT])
  await t.turn('t1', LONG)
  expect(await $.prompt.edit(key('s'))).toEqual({ text: '', cursor: 0 })
  await t.clock.advance(100)
  expect(((await $.prompt.edit(key('o'))) as Any).text).toBe('so')
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(0)
  expect(textOf(await $.ui.render(answer('row-t1', LONG)))).not.toContain('simpler version')
})

test('with two replies since the last prompt, the bar names b apart from s; a simpler version of the newest does not count as a catch-up, and b writes one catch-up below the newest in its place, the replies still showing', async ($, on) => {
  const t = await setup($, on, ['The retry passed.', 'Both: the build failed, and the retry passed.'])
  await t.turn('t1', 'Earlier answer.')
  await t.turn('t2', 'The build failed on three runs.', { text: 'why did it fail?', by: 'composer' })
  await t.turn('t3', 'The retry passed on all runs.', { text: '<task-notification>done</task-notification>', by: 'task-notification' })
  expect(await t.bar()).toContain('s simplify · b catch up on 2 replies')
  // s writes a simpler version of the newest reply, and b still offers the catch-up
  await t.press('s')
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(1)
  expect(String(t.asked[0].prompt)).toContain('Write one simpler message of it')
  expect(textOf(await $.ui.render(answer('row-t3', 'The retry passed on all runs.')))).toContain('simpler version of the answer above')
  expect(await t.bar()).toContain('b catch up on 2 replies')
  // b writes the catch-up, in place of the simpler version
  await t.press('b')
  await t.clock.advance(5000)
  expect(String(t.asked[1].prompt)).toContain("Claude's messages since the analyst's last prompt")
  expect(String(t.asked[1].prompt)).toContain('The analyst asked: why did it fail?')
  // the covered reply draws as written; the newest draws its own words, then the catch-up below with its head line
  expect(textOf(await $.ui.render(answer('row-t2', 'The build failed on three runs.')))).toBe('the engine')
  const host = textOf(await $.ui.render(answer('row-t3', 'The retry passed on all runs.')))
  expect(host.indexOf('the engine')).toBeLessThan(host.indexOf('catch-up of the 2 replies above'))
  expect(host).toContain('Both: the build failed, and the retry passed.')
  expect(host).not.toContain('simpler version')
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
  // s on the catch-up opens the chips on it, with no call
  await t.press('s')
  expect(levelsOf((await clientUnder($, 'row-t3', 'The retry passed on all runs.'))?.props.props)).toEqual({ length: 0, familiarity: 2 })
  expect(t.asked.length).toBe(asked)
})

/** The chips' Client under a row, as the terminal would draw it: its props from the row, its elements as plain nodes. */
const ELS = Object.fromEntries(['Box', 'Text', 'Button'].map(k => [k, (props: Any) => ({ type: k, props })]))
const nodes = (n: Any): Any[] => (!n || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(nodes) : [n, ...nodes(n.props?.children), ...nodes(n.children)])
async function chipsDrawn($: Any, row: string, text: string) {
  const client = nodes(await $.ui.render(answer(row, text))).find(n => n.type === 'Client')
  const surface = { elements: ELS, columns: 100, onKey: () => undefined, post: () => undefined }
  return { client, tree: Chips(client?.props.props as never, surface as never) }
}

test("a key in the chips that Claude Code also takes at the prompt, an arrow or tab, changes nothing, and nothing in the chips names one; thimble's own keys act there as at the prompt", async ($, on) => {
  const t = await setup($, on, [SHORT, 'The nightly build failed on [3 of 12](#) runs, in more words.'])
  await t.turn('t1', LONG)
  // s writes the simpler version; s again opens the chips on it
  await t.press('s')
  await t.clock.advance(5000)
  await t.press('s')
  const props = async () => (await chipsDrawn($, 'row-t1', LONG)).client?.props.props
  const levels = async () => Object.fromEntries((await props()).items.map((c: Any) => [c.id, c.level]))
  const picked = async () => (await props()).items.find((c: Any) => c.picked)?.id
  // a click on the dot where Length stands gives the chips the keyboard
  const ui = await $.ui.mount(answer('row-t1', LONG))
  await ui.press({ key: 'lvl-length-0' })
  const was = await levels()
  // each arrow and tab: no level moves, no chip is picked, nothing is asked
  for (const k of [{ key: 'left' }, { key: 'right' }, { key: 'tab' }, { key: 'tab', shift: true }, { key: 'up' }, { key: 'down' }]) {
    await ui.key(k as never)
    await t.clock.advance(400)
    expect([k, await levels(), await picked()]).toEqual([k, was, 'length'])
  }
  await t.clock.advance(3000)
  expect(t.asked.length).toBe(1)
  // nothing in the chips names an arrow or tab, held or not
  const words = flat(textOf((await chipsDrawn($, 'row-t1', LONG)).tree))
  for (const k of ['←', '→', '↑', '↓', 'tab']) expect(words).not.toContain(k)
  expect(words).toContain('1 Length [ shorter ●○○○ ] longer')
  // thimble's own keys act in the chips as at the prompt: 2 picks Background, ] moves it a level, and the rewrite runs
  await ui.key({ key: '2' })
  await ui.key({ key: ']' })
  await ui.unmount()
  expect(await picked()).toBe('familiarity')
  expect((await levels()).familiarity).toBe(was.familiarity + 1)
  await t.clock.advance(3000)
  expect(t.asked.length).toBe(2)
  // the chips still hold the keyboard after those keys: esc is still named
  expect(flat(textOf((await chipsDrawn($, 'row-t1', LONG)).tree))).toContain('esc back to the prompt')
})
