// Squeeze and catch-up in the terminal (squeeze/): s at an empty prompt opens the chips under the answer, ] asks one
// rewrite and the new text shows in place of Claude's words, Claude hears the version with the next prompt, 0 brings
// the original back with no call; with two replies since the person's last prompt, b writes one catch-up of them below
// the newest; an arrow or tab in the chips changes nothing. All data is made up. `claude plugin test plugin`.
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

/** The chips' Client under a row, as the terminal would draw it: its props from the row, its elements as plain nodes. */
const ELS = Object.fromEntries(['Box', 'Text', 'Button'].map(k => [k, (props: Any) => ({ type: k, props })]))
const nodes = (n: Any): Any[] => (!n || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(nodes) : [n, ...nodes(n.props?.children), ...nodes(n.children)])
async function chipsDrawn($: Any, row: string, text: string) {
  const client = nodes(await $.ui.render(answer(row, text))).find(n => n.type === 'Client')
  const surface = { elements: ELS, columns: 100, onKey: () => undefined, post: () => undefined }
  return { client, tree: Chips(client?.props.props as never, surface as never) }
}

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
