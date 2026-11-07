// Simplify and catch-up in the terminal (squeeze/): s at an empty prompt writes a simpler version of the answer below
// it in one press, at Length short and Background learning, with a row of choices at its end; 2 asks one more call,
// Claude hears the version with the next prompt, and 0 removes it; a letter right after s undoes it; with two replies
// since the person's last prompt, b writes one catch-up of them below the newest, in place of a simpler version there,
// and b undone puts that simpler version back; a key hook of s or b does not wait for their writes, so a slow write does
// not close the word window; a catch-up read and removed still counts as read after s; s while main's turn runs
// simplifies its answer when it ends; an answer rewritten in place in an earlier release shows its original again when
// s simplifies it; a choice at its end leaves the row, a letter right after a choice undoes it, and a click on a choice
// does what its key does; a simpler version kept before very short was added keeps its levels. All data is made up.
// `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { resetSqueeze } from '../squeeze/term'
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
  // the conversation's id: a test that moves to another conversation (a /resume) sets it
  const conversation = { id: 's-squeeze' }
  on('session.id', () => ({ value: conversation.id }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('session.messages', () => ({ value: [] }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files[e.path] ?? promptStub(e.path) ?? '' }))
  // a write that takes time on the clock, once, for a test that times the key hooks: in Claude Code, the next key's
  // hook runs only after this key's hook returns
  const slow = { writeMs: 0 }
  on('fs.write', async (_$: unknown, e: { path: string; text: string }) => {
    if (slow.writeMs) { const ms = slow.writeMs; slow.writeMs = 0; await clock.advance(ms) }
    files[e.path] = String(e.text)
    return { value: undefined }
  })
  // a folder's files, so a session started again reads back the turns its conversation kept (core/answers.ts)
  on('fs.list', (_$: unknown, e: { path: string }) => ({ value: Object.keys(files).filter(f => f.startsWith(`${e.path}/`) && !f.slice(e.path.length + 1).includes('/')).map(f => ({ name: f.slice(e.path.length + 1), kind: 'file' })) }))
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
  // the drawing beneath thimble's: the words it was handed to draw, kept for a test to read
  const beneath: string[] = []
  on('ui.render', (_$: unknown, e: Any) => { beneath.push(String(e?.props?.text ?? '')); return { type: 'Text', props: {}, children: ['the engine'] } as never })
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
  return { clock, asked, ask, turn, press, bar, files, conversation, beneath, slow }
}

const LONG = 'The nightly build failed on [3 of 12](#) runs. The cache key changed when the lockfile moved, so every run fetched again, and the slow mirror timed out.'

const SHORT = 'The build failed on [3 of 12](#) runs: the cache key changed.'
const ROW = '1 shorter · 2 longer · 3 explain more · 4 assume more · + your own · 0 remove'

test('s writes a simpler version below the answer in one press, at Length short and Background learning, with its row of choices; 2 asks one more call, Claude hears it with the next prompt, s brings it into view, and 0 removes it with no call', { options: { citations: 'auto cite' } }, async ($, on) => {
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
  // the answer still shows as written, and the simpler version stands below it with its head line, its row last
  const host = textOf(await $.ui.render(answer('row-t1', LONG)))
  expect(host.indexOf('the engine')).toBeLessThan(host.indexOf('simpler version of the answer above'))
  expect(host).toContain('the cache key changed.')
  expect(host).toContain(ROW)
  expect(host.indexOf('the cache key changed.')).toBeLessThan(host.indexOf(ROW))
  // the row names its keys, so the bar no longer names s
  expect(await t.bar()).not.toContain('s simplify')
  // 2 makes it longer at once: one more call, written below the answer, never in place of it; the row says so meanwhile
  expect(await t.press('2')).toEqual({ text: '', cursor: 0 })
  expect(textOf(await $.ui.render(answer('row-t1', LONG)))).toContain('making it longer…')
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(2)
  expect(String(t.asked[1].prompt)).toContain('Length: as written.')
  const longer = textOf(await $.ui.render(answer('row-t1', LONG)))
  expect(longer).toContain('because the cache key changed')
  expect(longer).toContain('simpler version of the answer above')
  expect(longer).toContain(ROW)
  // s with the block standing brings it into view, with no call and nothing typed
  expect(await t.press('s')).toEqual({ text: '', cursor: 0 })
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(2)
  const next = await t.ask('and now?')
  expect(String((next.context ?? []).join('\n'))).toContain('the analyst read a simpler version of it')
  // after the prompt, the newest answer is still this one (no reply yet in this test): 0 removes it, with no call
  await t.press('0')
  await t.clock.advance(1000)
  expect(t.asked.length).toBe(2)
  const back = textOf(await $.ui.render(answer('row-t1', LONG)))
  expect(back).not.toContain('simpler version of the answer above')
  expect(back).not.toContain('because the cache key changed')
  expect(back).not.toContain(ROW)
  // with no block, 1 asks nothing (it types as usual), and the bar names s again
  await t.press('1')
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(2)
  expect(await t.bar()).toContain('s simplify')
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

test('a letter right after s undoes it while the writes of s still run: the key hook does not wait for them', async ($, on) => {
  const t = await setup($, on, [SHORT])
  await t.turn('t1', LONG)
  // the first write of s takes 400 ms, longer than the word window
  t.slow.writeMs = 400
  expect(await $.prompt.edit(key('s'))).toEqual({ text: '', cursor: 0 })
  await t.clock.advance(100)
  expect(((await $.prompt.edit(key('h'))) as Any).text).toBe('sh')
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
  // the catch-up has the same row of choices; nothing is hidden, so no key brings the replies back
  expect(host).toContain(ROW)
  expect(await t.bar()).not.toContain('show the replies')
  expect(String((await t.ask('and?')).context ?? '')).toContain('Below those messages')
  // a catch-up the person read counts: the bar no longer offers one, and b does nothing
  expect(await t.bar()).not.toContain('catch up')
  const asked = t.asked.length
  await t.press('b')
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(asked)
  // s on the catch-up brings it into view, with no call
  expect(await t.press('s')).toEqual({ text: '', cursor: 0 })
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(asked)
})

test('b undone by the letter after it, while the writes of b still run, puts back the simpler version it replaced', async ($, on) => {
  const t = await setup($, on, ['Simpler.'])
  await t.turn('t1', 'Earlier answer.')
  await t.turn('t2', 'The build failed on three runs.', { text: 'why did it fail?', by: 'composer' })
  await t.turn('t3', 'The retry passed on all runs.', { text: '<task-notification>done</task-notification>', by: 'task-notification' })
  await t.press('s')
  await t.clock.advance(5000)
  expect(textOf(await $.ui.render(answer('row-t3', 'The retry passed on all runs.')))).toContain('Simpler.')
  // `by` typed at the empty prompt: b writes a catch-up, and y undoes it, though the first write of b takes 400 ms,
  // longer than the word window
  t.slow.writeMs = 400
  expect(await $.prompt.edit(key('b'))).toEqual({ text: '', cursor: 0 })
  await t.clock.advance(100)
  expect(((await $.prompt.edit(key('y'))) as Any).text).toBe('by')
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(1)
  const host = textOf(await $.ui.render(answer('row-t3', 'The retry passed on all runs.')))
  expect(host).toContain('simpler version of the answer above')
  expect(host).toContain('Simpler.')
  expect(await t.bar()).toContain('b catch up on 2 replies')
})

test('a catch-up read and then removed still counts as read after s writes a simpler version on the same reply', async ($, on) => {
  const t = await setup($, on, ['Both: the build failed, and the retry passed.', 'Simpler.'])
  await t.turn('t1', 'Earlier answer.')
  await t.turn('t2', 'The build failed on three runs.', { text: 'why did it fail?', by: 'composer' })
  await t.turn('t3', 'The retry passed on all runs.', { text: '<task-notification>done</task-notification>', by: 'task-notification' })
  await t.press('b')
  await t.clock.advance(5000)
  // 0 removes the catch-up
  await t.press('0')
  expect(await t.bar()).not.toContain('catch up')
  // s now writes a simpler version of the newest reply; b is still not offered for the replies already read
  await t.press('s')
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(2)
  expect(String(t.asked[1].prompt)).toContain('Write one simpler message of it')
  expect(textOf(await $.ui.render(answer('row-t3', 'The retry passed on all runs.')))).toContain('simpler version of the answer above')
  expect(await t.bar()).not.toContain('catch up')
})

test('s pressed while main\'s turn runs waits for its answer, then writes the simpler version of that answer', async ($, on) => {
  const t = await setup($, on, ['Simpler second.'])
  await t.turn('t1', 'First answer.')
  await t.ask('and the second?')
  await $.turn.start({ text: 'and the second?', turnId: 't2' } as never)
  await t.press('s')
  // s waits: it is lit on the bar, and nothing is asked yet
  expect(await t.bar()).toContain('s simplify')
  expect(t.asked.length).toBe(0)
  await $.session.append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Second answer.' }] }, door: 'response', origin: { kind: 'model', model: 'claude-made-up' }, uuid: 'row-t2' } as never)
  await $.turn.complete({ turnId: 't2', reason: 'answer', answer: 'Second answer.', durationMs: 10, isAborted: false } as never)
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(1)
  expect(String(t.asked[0].prompt)).toContain('Second answer.')
  expect(String(t.asked[0].prompt)).not.toContain('First answer.')
  const host = textOf(await $.ui.render(answer('row-t2', 'Second answer.')))
  expect(host).toContain('simpler version of the answer above')
  expect(host).toContain('Simpler second.')
})

test('an answer s rewrote in place in an earlier release still draws its version; s shows its original again, with no call, and writes the simpler version below it', async ($, on) => {
  const t = await setup($, on, [SHORT])
  await t.turn('t1', LONG)
  // a conversation of an earlier release kept the answer with a version that s wrote in place; the session moves to it
  const kept = JSON.parse(t.files['/made-up/.thimble/conversations/s-squeeze/answers/t1.json']!)
  for (const m of kept.msgs) if (m.row === 'row-t1') m.parts = { ...(m.parts ?? {}), squeeze: { own: { shown: 'Old version written in place.', squeeze: { at: { length: 0 }, scale: 5, versions: {} } } } }
  t.files['/made-up/.thimble/conversations/s-old/answers/t1.json'] = JSON.stringify(kept)
  t.conversation.id = 's-old'
  await t.ask('the earlier conversation')
  // the answer draws the old version in place of what Claude wrote
  await $.ui.render(answer('row-t1', LONG))
  expect(t.beneath.at(-1)).toBe('Old version written in place.')
  // s: the answer shows as Claude wrote it again, with no call for that, and one call writes the simpler version below
  await t.press('s')
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(1)
  t.beneath.length = 0
  const host = textOf(await $.ui.render(answer('row-t1', LONG)))
  expect(t.beneath).not.toContain('Old version written in place.')
  expect(host).not.toContain('Old version written in place.')
  expect(host).toContain('simpler version of the answer above')
  expect(host).toContain('the cache key changed.')
})

test('a choice at its end leaves the row and its key types; a letter right after a choice undoes it; a click on a choice does what its key does', async ($, on) => {
  const t = await setup($, on, [SHORT, 'Build failed: cache key.', 'The build failed because a key changed.'])
  await t.turn('t1', LONG)
  await t.press('s')
  await t.clock.advance(5000)
  // 1 from short: very short, one or two sentences
  await t.press('1')
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(2)
  expect(String(t.asked[1].prompt)).toContain('Length: very short. One or two sentences')
  const shortest = textOf(await $.ui.render(answer('row-t1', LONG)))
  expect(shortest).toContain('Build failed: cache key.')
  // Length goes no further: shorter leaves the row, and 1 types as usual
  expect(shortest).toContain('2 longer · 3 explain more · 4 assume more · + your own · 0 remove')
  expect(shortest).not.toContain('shorter')
  await t.press('1')
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(2)
  // `2x` typed at the empty prompt: 2 asks for longer, and x right after undoes it; the very short version stays
  expect(await $.prompt.edit(key('2'))).toEqual({ text: '', cursor: 0 })
  await t.clock.advance(100)
  expect(((await $.prompt.edit(key('x'))) as Any).text).toBe('2x')
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(2)
  expect(textOf(await $.ui.render(answer('row-t1', LONG)))).toContain('Build failed: cache key.')
  // a click on 3 explain more does what 3 does
  const ui = await $.ui.mount(answer('row-t1', LONG))
  await ui.press({ key: 'c3' })
  await ui.unmount()
  await t.clock.advance(5000)
  expect(t.asked.length).toBe(3)
  expect(String(t.asked[2].prompt)).toContain('Background: novice.')
  expect(textOf(await $.ui.render(answer('row-t1', LONG)))).toContain('The build failed because a key changed.')
})

test('a simpler version kept before very short was added keeps its levels: its version at short comes back at short, with no call', async ($, on) => {
  const t = await setup($, on, [])
  await t.turn('t1', LONG)
  // a conversation of an earlier release kept a simpler version at short (Length 0 then) and one at as written (1)
  const kept = JSON.parse(t.files['/made-up/.thimble/conversations/s-squeeze/answers/t1.json']!)
  const simple = { text: LONG, at: '2026-01-01T00:00:00.000Z', shown: 'Old short.', squeeze: { at: { length: 0, familiarity: 1 }, scale: 5, versions: { 'length=0&familiarity=1': 'Old short.', 'familiarity=1': 'Old as written.' } }, catchup: { host: 'row-t1', rows: ['row-t1'], replies: 1, question: 'question t1', prompt: null, kind: 'simplify' } }
  for (const m of kept.msgs) if (m.row === 'row-t1') m.parts = { ...(m.parts ?? {}), squeeze: { simple } }
  t.files['/made-up/.thimble/conversations/s-old/answers/t1.json'] = JSON.stringify(kept)
  t.conversation.id = 's-old'
  await t.ask('the earlier conversation')
  // it shows at short: shorter (now very short) is offered
  const host = textOf(await $.ui.render(answer('row-t1', LONG)))
  expect(host).toContain('Old short.')
  expect(host).toContain(ROW)
  // 2 longer: the version kept at as written, with no call; 1 shorter: the one kept at short, with no call
  await t.press('2')
  await t.clock.advance(5000)
  expect(textOf(await $.ui.render(answer('row-t1', LONG)))).toContain('Old as written.')
  await t.press('1')
  await t.clock.advance(5000)
  expect(textOf(await $.ui.render(answer('row-t1', LONG)))).toContain('Old short.')
  expect(t.asked.length).toBe(0)
})
