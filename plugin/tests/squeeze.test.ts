// Squeeze and catch-up in the terminal (squeeze/): s at an empty prompt opens the chips under the answer, ] asks one
// rewrite and the new text shows in place of Claude's words, Claude hears the version with the next prompt, 0 brings
// the original back with no call; with two replies since the person's last prompt, s opens the same chips under the
// newest, and they offer a catch-up as one more chip, which writes one catch-up of them, drawn last under the newest
// message it covers, which keeps its look at every chip level, and 0 dismisses it. All data is made up. `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

import { citeScope } from '../marks/view'
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

test('with two replies since the last prompt, the chips squeeze the newest reply alone; a press on the catch-up chip catches up', async ($, on) => {
  const t = await setup($, on, ['The retry passed on [all 12](#) runs after the fix.', 'Both: the build failed, and the retry passed.'])
  await t.turn('t1', 'Earlier answer.')
  await t.turn('t2', 'The build failed on three runs.', { text: 'why did it fail?', by: 'composer' })
  await t.turn('t3', 'The retry passed on all runs.', { text: '<task-notification>done</task-notification>', by: 'task-notification' })
  await t.press('s')
  await t.press(']')
  await t.clock.advance(5000)
  // one rewrite of the newest reply, not a catch-up (its citation draws, so the version shows here); the reply before
  // it draws as it was
  expect(t.asked.length).toBe(1)
  expect(String(t.asked[0].prompt)).not.toContain("Claude's messages since the analyst's last prompt")
  expect(textOf(await $.ui.render(answer('row-t3', 'The retry passed on all runs.')))).toContain('runs after the fix')
  expect(textOf(await $.ui.render(answer('row-t2', 'The build failed on three runs.')))).toBe('the engine')
  // the catch-up chip still stands in the row; a press on it writes the catch-up
  const { tree, posts } = await chipsDrawn($, 'row-t3', 'The retry passed on all runs.')
  const btn = nodes(tree).find(n => n.type === 'Button' && n.props.label === 'catch up on 2 replies')
  btn.props.onPress()
  const ui = await $.ui.mount(answer('row-t3', 'The retry passed on all runs.')) as Any
  await ui.post(posts.at(-1), { element: 'sqchips-row-t3' })
  await ui.unmount()
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(2)
  expect(String(t.asked[1].prompt)).toContain("Claude's messages since the analyst's last prompt")
  expect(textOf(await $.ui.render(answer('row-t3', 'The retry passed on all runs.')))).toContain('catch-up of the 2 replies since your last message')
  expect(textOf(await $.ui.render(answer('row-t2', 'The build failed on three runs.')))).toBe('')
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

test('s close leads the bar while the chips are open, the chips row ends with it, and s, ↵ or a press on it closes them', async ($, on) => {
  const t = await setup($, on, [])
  // what the chips' Client posts reaches the hooks as Claude Code hands it on; closed, the bar offers s squeeze again
  const post = async (data: Any) => { const ui = await $.ui.mount(answer('row-t1', LONG)) as Any; await ui.post(data, { element: 'sqchips-row-t1' }); await ui.unmount() }
  const closed = async () => expect(await t.bar()).toMatch(/thimble {2}v card · s squeeze/)
  await t.turn('t1', LONG)
  await t.press('s')
  expect(await t.bar()).toMatch(/thimble {2}s close · \[ \] shorter \/ longer · 1–3 chip · \+ your own/)
  // the chips row ends with `s close`, its key drawn as the bar's keys
  const { client, tree, posts } = await chipsDrawn($, 'row-t1', LONG)
  expect(client?.props.module).toContain('chips.tsx')
  const row = tree.props.children
  const btn = nodes(row[row.length - 1]).find(n => n.type === 'Button')
  expect(btn.props.label).toBe('s close')
  expect(btn.props.children[0].props).toEqual({ color: 'suggestion', bold: true, children: 's' })
  expect(btn.props.children[1].props).toEqual({ dimColor: true, children: ' close' })
  // a press on it closes the chips
  btn.props.onPress()
  expect(posts.at(-1).events.at(-1)).toMatchObject({ press: 'close' })
  await post(posts.at(-1))
  await closed()
  // while words are typed after +, s is a letter: the row names no close
  await t.press('s')
  const typing = await chipsDrawn($, 'row-t1', LONG, { plus: 'for my man' })
  expect(nodes(typing.tree).some(n => n.props?.label === 's close')).toBe(false)
  // with the keyboard in the chips: s close still leads the bar, the rest stays short, and s closes them
  await post({ client: 'k', events: [{ n: 1, key: 'tab' }] })
  const held = await t.bar()
  expect(held).toMatch(/thimble {2}s close · tab next chip · ← → facts \/ interpretation · \+ your own · esc back to the prompt/)
  expect(held).not.toContain('↵ done')
  await post({ client: 'k', events: [{ n: 2, key: 's' }] })
  await closed()
  // ↵ in the chips closes them too
  await t.press('s')
  await post({ client: 'k2', events: [{ n: 1, key: 'tab' }, { n: 2, key: 'return' }] })
  await closed()
})

const HEAD = 'thimble  catch-up of the 2 replies since your last message'
const RULE = '▎'

test("after one reply to the newest prompt s is plain squeeze, whoever's turns came before; a catch-up comes with the second reply", async ($, on) => {
  const t = await setup($, on, [])
  await t.turn('t1', 'Earlier answer.')
  await t.turn('t2', 'The background job ended.', { text: '<task-notification>one</task-notification>', by: 'task-notification' })
  // a prompt typed over the running turn waits while a task's report arrives; then the typed prompt's turn starts
  await t.ask('why did it fail?')
  await t.ask('<task-notification>two</task-notification>', 'task-notification')
  await $.turn.start({ text: 'why did it fail?', turnId: 't3' } as never)
  await t.say('row-t3', 'The build failed on three runs.')
  await $.turn.complete({ turnId: 't3', reason: 'answer', answer: 'The build failed on three runs.', durationMs: 10, isAborted: false } as never)
  await t.clock.advance(100)
  expect(await t.bar()).toContain('s squeeze')
  expect(await t.bar()).not.toContain('catch up')
  await t.turn('t4', 'The second job ended.', null)
  expect(await t.bar()).toContain('s squeeze or catch up')
})

test('the catch-up draws last, under the newest message it covers, and the replies it covers draw nothing while it shows', async ($, on) => {
  const t = await setup($, on, ['Both: the build failed, and the retry passed.'])
  await t.turn('t1', 'Earlier answer.')
  await t.turn('t2', 'The build failed on three runs.', { text: 'why did it fail?', by: 'composer' })
  await t.turn('t3', 'Looking at the retry.', { text: '<task-notification>done</task-notification>', by: 'task-notification' })
  // a text row of the newest turn kept after its answer: the newest message the catch-up covers
  await t.say('row-t3-last', 'The retry passed on all runs.')
  await t.press('s')
  await t.press('4')
  await t.clock.advance(5000)
  const at = (row: string, text: string) => $.ui.render(answer(row, text)).then(textOf)
  expect(await at('row-t2', 'The build failed on three runs.')).toBe('')
  expect(await at('row-t3', 'Looking at the retry.')).toBe('')
  const last = await at('row-t3-last', 'The retry passed on all runs.')
  expect(last).toContain(HEAD)
  expect(last).not.toContain('in their place')
  expect(last).toContain('Both: the build failed, and the retry passed.')
  // the chips stand under it, not under the reply that keeps it
  const chips = (row: string, text: string) => $.ui.render(answer(row, text)).then((n: Any) => JSON.stringify(n).includes('sqchips-row-t3#cu'))
  expect(await chips('row-t3-last', 'The retry passed on all runs.')).toBe(true)
  expect(await chips('row-t3', 'Looking at the retry.')).toBe(false)
  // 0: the replies again, each in its place
  await t.press('0')
  expect(await at('row-t3', 'Looking at the retry.')).toBe('the engine')
  expect(await at('row-t3-last', 'The retry passed on all runs.')).toBe('the engine')
})

test('a catch-up keeps its look at every chip: Length, Interpretation, Background and the person\'s own, while each is written and after', async ($, on) => {
  const gates: ((v: string) => void)[] = []
  const later = () => new Promise<string>(r => { gates.push(r) })
  const t = await setup($, on, ['Both: the build failed, and the retry passed.', later(), later(), later(), later()])
  await t.turn('t1', 'Earlier answer.')
  await t.turn('t2', 'The build failed on three runs.', { text: 'why did it fail?', by: 'composer' })
  await t.turn('t3', 'The retry passed on all runs.', { text: '<task-notification>done</task-notification>', by: 'task-notification' })
  await t.press('s')
  await t.press('4')
  await t.clock.advance(5000)
  const host = () => $.ui.render(answer('row-t3', 'The retry passed on all runs.')).then(textOf)
  const framed = async (words: string) => {
    const now = await host()
    expect(now).toContain(HEAD)
    expect(now).toContain(RULE)
    expect(now).toContain(words)
    expect(await $.ui.render(answer('row-t2', 'The build failed on three runs.')).then(textOf)).toBe('')
  }
  await framed('Both: the build failed')
  const change = async (keys: string[], reply: string, words = reply) => {
    for (const k of keys) await t.press(k)
    // while it is written: the catch-up as it was, dim, in its frame
    await framed('')
    gates.shift()!(reply)
    await t.clock.advance(20)
    await framed('')
    await t.clock.advance(5000)
    await framed(words)
  }
  await change([']'], '## Longer\n\n- the build failed on [3 of 12](#) runs\n- the retry passed on all runs', 'the retry passed on all runs')
  await change(['2', ']'], 'Read together, the failures came from the cache key.')
  await change(['3', ']'], 'For an expert: the lockfile moved, so the cache key changed.')
  await t.ask('/squeeze for my manager', 'composer')
  await $.command.run({ command: 'squeeze', args: 'for my manager' } as never).catch(() => undefined)
  await change(['4', ']'], 'For your manager: the build is fixed.')
  expect(t.asked.length).toBe(5)
})

test('a squeezed version that words its citations anew: each citation its own hover group, and a press on one opens the tray on its own', async ($, on) => {
  const text = 'Of the [12 runs](#), [3 failed](#) on the [slow mirror](#).'
  const t = await setup($, on, ['Of all [12 nightly runs](#), exactly [3 of them failed](#), each on the [slow package mirror](#).'])
  await t.turn('t1', text)
  await t.press('s')
  await t.press(']')
  await t.clock.advance(5000)
  const all = (n: Any): Any[] => (n == null || typeof n !== 'object' ? [] : [n, ...[n.props?.children, n.children].flat(Infinity).flatMap(all)])
  const cites = all(await $.ui.render(answer('row-t1', text))).filter(n => n.type === 'Button' && /^citation /.test(String(n.props.label)))
  // (no check ran here, so each is failed, its × a press of its own in its group)
  const labels = [...new Set(cites.map(b => String(b.props.label)))]
  expect(labels).toEqual(['citation 1: 12 nightly runs', 'citation 2: 3 of them failed', 'citation 3: slow package mirror'])
  // three hover groups, as the reply's own citations have (one shared group before, all of them lit at once)
  const scopes = labels.map(l => [...new Set(cites.filter(b => b.props.label === l).map(b => b.hover.scope))])
  expect(scopes).toEqual([1, 2, 3].map(n => [citeScope(`mk-row-t1:${n}`)]))
  await t.press('s')
  const ui = await $.ui.mount(answer('row-t1', text))
  await ui.press({ key: cites.find(b => b.props.label === labels[1])!.props.key })
  await ui.unmount()
  // the tray stands on the second citation, as a press on it in Claude's own words does
  const band = await t.bar()
  expect(band).toContain('3 failed')
  expect(band).not.toContain('12 runs')
})
