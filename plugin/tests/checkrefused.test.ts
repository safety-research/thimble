// A check of citations that cannot start (marks/checker.ts): Claude Code refuses the checker's fork, as its auto mode
// does where its classifier judges only the calls of the model's own replies and so gives no verdict for a call a
// hook makes. The citations then wait, not checked (a dim ? after each), with no × on any, and one line says why: in
// a mode that refuses checks, the mode and the key that changes it, once a session for the replies' own checks; for
// any other refusal, its first sentence whole. The failure line wraps a long text at word edges, no row wider than
// the line. All data is made up. `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { barRows } from '../bar/bar'
import { failNotice, reasonOf } from '../bar/notice'
import { textWidth } from '../core/text.js'
import { cannotStart, refusingMode } from '../marks/checker'
import { promptStub, tempRun } from './stubs'
import { test } from './kit'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + (n.type === 'Markdown' ? String(n.props.text) : '') + textOf(n.children)
}
function all(n: Any, out: Any[] = []): Any[] {
  if (!n || typeof n !== 'object') return out
  if (Array.isArray(n)) { n.forEach(x => all(x, out)); return out }
  out.push(n)
  all(n.props?.children, out)
  all(n.children, out)
  return out
}

/** Claude Code's refusal of a fork a hook spawned, in auto mode where its classifier judges only the model's calls. */
const AUTO = "The server-side auto mode classifier gave no verdict for Agent: the request that produced this action did not ask for one. Issue the action again once, as-is; if it is denied again, continue with other tasks that don't require it and tell the user that auto mode could not evaluate it. "
/** A refusal for another cause: a made-up plugin's hook. */
const HOOK = 'Subagent spawn denied by a plugin: lab-sync holds every new agent while it copies the workspace to the shared drive of the team. Try again in a minute.'

const REPLY = 'Of the [40](#) nightly runs, [12 of 40](#) failed, most on the [p95 latency check](#); the [slow mirror](#) was down for [3 nights](#).'
const view = { columns: 100, rows: 40, isFullscreen: true }
const above = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 19 }, view: {} }, viewport: view } as never
const answer = (row: string) => ({ plugin: 'thimble', component: 'AssistantMessage', surface: 'terminal', requestId: row, viewport: view, props: { text: REPLY, isFirstOfReply: true } }) as never
const OPTIONS = { options: { citations: 'auto cite + verify', cards: false, labels: false, coverage: false }, timeoutMs: 30000 }

/** A session whose spawns Claude Code refuses with `deny`; answers the spawns asked for. */
async function session($: Any, on: Any, deny: string): Promise<{ spawns: Any[]; clock: Any }> {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp', PATH: '/usr/bin' })
  const clock = mock.clock(on, { now: 0 })
  const spawns: Any[] = []
  on('session.id', () => ({ value: 's-refused' }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('session.messages', () => ({ value: [] }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: promptStub(e.path) ?? '' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', () => ({ value: { kind: 'missing', size: 0 } }))
  on('env.set', () => ({ value: {} }))
  on('config.list', () => ({ value: [] }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.scroll', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }) as never)
  on('model.fork', () => ({ value: { isAnswered: true, text: '{}' } }))
  on('process.run', (_$: unknown, e: { argv: string[] }) => ({ value: { exitCode: 0, stdout: '', stderr: '', ...(tempRun(e.argv) ?? {}), isStdoutTruncated: false, isStderrTruncated: false } }))
  on('agent.spawn', (_$: unknown, e: Any) => { spawns.push(e); return { deny } as never })
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  on('prompt.submit', (_$: unknown, e: Any) => ({ text: e.text }))
  on('turn.start', (_$: unknown, e: Any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: unknown, e: Any) => ({ text: e.answer }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the engine'] }) as never)
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true } as never)
  return { spawns, clock }
}

/** One question of the person's and main's reply to it, REPLY, in row `row`. */
async function reply($: Any, clock: Any, turnId: string, row: string): Promise<void> {
  await $.prompt.submit({ text: 'how many failed?', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'how many failed?', turnId } as never)
  await $.session.append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: REPLY }] }, door: 'response', origin: { kind: 'model', model: 'claude-made-up' }, uuid: row } as never)
  await $.turn.complete({ turnId, reason: 'answer', answer: REPLY, durationMs: 10, isAborted: false } as never)
  await clock.advance(100)
}

/** The sign drawn right after citation n's words, and the look of its text. */
function signAfter(drawn: Any, n: number): { sign: string; props: Any } {
  const runs = all(drawn).filter(x => x.type === 'Button' && String(x.props?.label).startsWith(`citation ${n}:`))
  const last = runs[runs.length - 1]
  const text = textOf(last)
  return /^ [?*×]$/.test(text) ? { sign: text.trim(), props: all(last).find(x => x.type === 'Text')?.props } : { sign: '', props: null }
}

test("auto mode refuses the check: one notice names the mode and the key that changes it, and the citations wait, not checked, none failed; the next reply's refusal says nothing again, and opening a citation says it again", OPTIONS, async ($, on) => {
  const { spawns, clock } = await session($, on, AUTO)
  await reply($, clock, 't1', 'row-a1')
  const band = textOf(await $.ui.render(above))
  expect(band).toContain("Claude Code's auto mode does not let thimble start a check of citations, so they are not checked. Press shift+tab to switch modes, then open a citation to check it.")
  // not Claude Code's words for the model, cut, nor a failure in red
  expect(band).not.toContain('the request that')
  expect(band).not.toContain('×')
  expect(JSON.stringify(await $.ui.render(above))).not.toContain('"color":"error"')
  // every citation waits, with a dim ? after it; none is drawn failed
  const drawn = await $.ui.render(answer('row-a1'))
  for (const n of [1, 2, 3, 4, 5]) {
    const s = signAfter(drawn, n)
    expect(s.sign).toBe('?')
    expect(s.props).toMatchObject({ dimColor: true })
  }
  expect(textOf(drawn)).not.toContain('×')
  // one spawn asked for: what refused it refuses the other shares too
  expect(spawns.length).toBe(1)

  // the next reply: its check is refused too, its citations wait, and the line is not said again
  await reply($, clock, 't2', 'row-a2')
  expect(spawns.length).toBe(2)
  expect(textOf(await $.ui.render(above))).not.toContain('auto mode')
  expect(signAfter(await $.ui.render(answer('row-a2')), 1).sign).toBe('?')

  // opening a citation asks for its check: refused, the line answers the press
  const ui = await $.ui.mount(answer('row-a2'))
  const cite = all(await $.ui.render(answer('row-a2'))).find(x => x.type === 'Button' && String(x.props?.label).startsWith('citation 2:'))
  await ui.press({ key: cite.props.key })
  await ui.unmount()
  expect(spawns.length).toBe(3)
  expect(textOf(await $.ui.render(above))).toContain("Claude Code's auto mode does not let thimble start a check of citations")
  expect(signAfter(await $.ui.render(answer('row-a2')), 2).sign).toBe('?')
  // its tray says not checked beside the dim ? the reply draws after it
  const tray = await $.ui.render(above)
  expect(textOf(tray)).toContain('? not checked  ')
  expect(all(tray).find(x => x.type === 'Text' && textOf(x) === '?')?.props).toMatchObject({ dimColor: true })
})

test('a check refused for another cause: one failure line with the refusal\'s first sentence whole, and the citations wait, not checked', OPTIONS, async ($, on) => {
  const { spawns, clock } = await session($, on, HOOK)
  await reply($, clock, 't1', 'row-a1')
  const band = textOf(await $.ui.render(above))
  expect(band).toContain('× The check of the citations could not start (Subagent spawn denied by a plugin: lab-sync holds every new agent while it copies the workspace to the shared drive of the team), so they are not checked. Open one to check it.')
  expect(band).not.toContain('Try again in a minute')
  const drawn = await $.ui.render(answer('row-a1'))
  expect(signAfter(drawn, 1).sign).toBe('?')
  expect(textOf(drawn)).not.toContain('×')
  expect(spawns.length).toBe(1)
})

test('a refusal names the permission mode that refused it; its reason is quoted by its first sentence, cut at a word only when that sentence is too long', () => {
  expect(refusingMode(AUTO)).toBe('auto mode')
  expect(refusingMode("Permission to use Agent has been denied because Claude Code is running in don't ask mode. Try something else.")).toBe("don't ask mode")
  expect(refusingMode(HOOK)).toBeNull()
  expect(cannotStart(AUTO).notice).toBe(true)
  expect(cannotStart(HOOK).notice).toBe(false)
  expect(reasonOf(AUTO)).toBe('The server-side auto mode classifier gave no verdict for Agent: the request that produced this action did not ask for one')
  expect(reasonOf(new Error('ENOENT: no such file or directory, open /made-up/a.txt'))).toBe('ENOENT: no such file or directory, open /made-up/a.txt')
  const long = `The made-up runner ${'stopped again and '.repeat(12)}gave up.`
  const cut = reasonOf(long, 60)
  expect(textWidth(cut)).toBeLessThanOrEqual(60)
  expect(cut.endsWith('…')).toBe(true)
  expect(long.startsWith(cut.slice(0, -1))).toBe(true)
})

const ELS = { Box: (p: Any) => ({ type: 'Box', props: p }), Text: (p: Any) => ({ type: 'Text', props: p }), Button: (p: Any) => ({ type: 'Button', props: p }) }
function stateOnly(state: Record<string, unknown>): Any {
  const key = (k: Any) => [k.key, k.id].filter(Boolean).join(':')
  return {
    state: { get: async (k: Any) => ({ value: state[key(k)] }), set: async (k: Any, v: unknown) => { state[key(k)] = v } },
    clock: { now: async () => 0, after: () => ({ cancel() {} }) },
  }
}

test('a long failure line with a key to press wraps at word edges: no row is wider than the line, no row ends on a space, and its words read whole', async () => {
  const text = 'The check of the citations could not start (The server-side auto mode classifier gave no verdict for Agent: the request that), so they are not checked. Press x on one in the tray to check it. See /made-up/a-very-long-folder-name-that-runs-on/and-on/and-on/past-the-whole-width-of-the-line/report.txt'
  for (const width of [100, 92, 88, 61, 40]) {
    const state: Record<string, unknown> = {}
    const $ = stateOnly(state)
    failNotice($, text)
    await new Promise(r => setTimeout(r, 1))
    const line = (await barRows($, ELS, width, { on: () => true }))[0]
    const rows = all(line).filter(x => x.type === 'Box' && String(x.props?.key).startsWith('fail-row-'))
    expect(rows.length).toBeGreaterThan(1)
    const said: string[] = []
    for (const row of rows) {
      const words = textOf(row)
      expect(textWidth(words)).toBeLessThanOrEqual(width)
      expect(words).not.toMatch(/\s$/)
      expect(words.trim()).not.toBe('')
      said.push(words)
    }
    // each word of the line stands whole in a row, none run together with the next; a word wider than a row is cut
    // where each row ends, and its pieces give it back
    const tokens = said.flatMap(r => r.split(' '))
    for (const w of `× ${text}`.split(' ')) {
      if (textWidth(w) <= width) expect(tokens).toContain(w)
      else expect(said.join('')).toContain(w)
    }
  }
})
