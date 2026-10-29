// A check of citations that cannot start (marks/checker.ts). In auto mode, Claude Code 2.1.307 lets a plugin's own
// call run without its classifier, unless the person's settings give the classifier rules of their own; then the
// classifier must judge the checker's fork, and the classifier that runs on Anthropic's server judges only the calls in
// Claude's own replies, so Claude Code refuses the fork with the words below, each time. The citations then wait, not
// checked (a dim ? after each), with no × on any, and one line says what refused them: for that refusal, that auto
// mode's classifier gave no verdict, and y, which lets thimble start its checks this session and starts the check
// again; a classifier that could not answer for now, or that judged the check, as such; any other refusal by its first
// sentence whole. The failure line wraps a long text at word edges, no row wider than the line. All data is made up.
// `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { barRows } from '../bar/bar'
import { failNotice, reasonOf } from '../bar/notice'
import { SPIN } from '../bar/busy'
import { textWidth } from '../core/text.js'
import { WORD_MS } from '../hooks/keys'
import { AGAIN_DESCRIPTION, cannotStart, refusalOf, UNREVIEWED_LINE } from '../marks/checker'
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
/** The failure line above the bar as the person reads it: its rows, in order, as one text ('' with none). */
function lineOf(band: Any): string {
  const line = all(band).find(x => x.props?.key === 'fail-line')
  if (!line) return ''
  const rows = all(line).filter(x => x.type === 'Box' && String(x.props?.key).startsWith('fail-row-'))
  return rows.length ? rows.map(textOf).join(' ') : textOf(line)
}

/** Claude Code 2.1.307's refusal of a fork a plugin's hook spawned, in auto mode where the classifier must judge it and
 *  runs on Anthropic's server, which judges only the calls in Claude's own replies (its own toast: `fork denied by auto
 *  mode · Classifier unavailable`). */
const AUTO = "The server-side auto mode classifier gave no verdict for Agent: the request that produced this action did not ask for one. Issue the action again once, as-is; if it is denied again, continue with other tasks that don't require it and tell the user that auto mode could not evaluate it. Note: reading files, searching code, and other read-only operations do not require the classifier and can still be used."
/** Its other words for a classifier that gave no verdict, and will give none on such a call. */
const HARD = "The server-side auto mode classifier gave no verdict (this request is not covered), so auto mode cannot determine the safety of Agent. This is a hard failure, not a transient one: the check cannot or does not judge this request, so retrying this action will get the same answer. Don't retry it. Continue with other tasks that don't require it; if it is essential, stop and tell the user that auto mode could not evaluate it. Note: reading files, searching code, and other read-only operations do not require the classifier and can still be used."
/** Its words for a classifier that could not answer for now. */
const BUSY = "claude-made-up-classifier is temporarily unavailable (rate-limited), so auto mode cannot determine the safety of Agent right now. Wait a moment and then try this action again. If it keeps failing, continue with other tasks that don't require this action and come back to it later. Note: reading files, searching code, and other read-only operations do not require the classifier and can still be used."
const WAIT = "The API told auto mode's safety classifier (claude-made-up-classifier) to wait 30 seconds from now (overloaded), so auto mode cannot determine the safety of Agent until then. This is not a judgment that the action is unsafe, so don't rework the action to get around it. "
/** Its words for a classifier that judged the call and refused it. */
const JUDGED = "Permission for this action was denied by the Claude Code auto mode classifier. Reason: The fork reads the made-up vault's keys. If you have other tasks that don't depend on this action, continue working on those. "
/** A refusal for another cause: a made-up plugin's hook. */
const HOOK = 'Subagent spawn denied by a plugin: lab-sync holds every new agent while it copies the workspace to the shared drive of the team. Try again in a minute.'

const REPLY = 'Of the [40](#) nightly runs, [12 of 40](#) failed, most on the [p95 latency check](#); the [slow mirror](#) was down for [3 nights](#).'
const view = { columns: 100, rows: 40, isFullscreen: true }
const above = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 19 }, view: {} }, viewport: view } as never
const answer = (row: string) => ({ plugin: 'thimble', component: 'AssistantMessage', surface: 'terminal', requestId: row, viewport: view, props: { text: REPLY, isFirstOfReply: true } }) as never
const OPTIONS = { options: { citations: 'auto cite + verify', cards: false, labels: false, coverage: false }, timeoutMs: 30000 }
/** A key at the empty prompt, as Claude Code's composer sends it. */
const key = (k: string, text = '') => ({ origin: { kind: 'composer' }, key: { key: k }, text, cursor: text.length, start: text.length, end: text.length, inputText: k }) as never

/** A session whose spawns Claude Code answers with `answer`: a refusal's words, or a started fork. Answers the spawns
 *  asked for. */
async function session($: Any, on: Any, answer: string | ((e: Any) => string | null)): Promise<{ spawns: Any[]; clock: Any }> {
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
  on('agent.spawn', (_$: unknown, e: Any) => {
    spawns.push(e)
    const deny = typeof answer === 'string' ? answer : answer(e)
    return (deny ? { deny } : { model: 'claude-made-up', agentId: `agent-check-${spawns.length}` }) as never
  })
  on('agent.list', () => ({ value: spawns.map((_e, i) => ({ id: `agent-check-${i + 1}`, status: 'running', description: 'x', type: 'fork' })) }))
  on('tool.check', () => ({ decision: 'ask' }) as never)
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  on('prompt.submit', (_$: unknown, e: Any) => ({ text: e.text }))
  on('prompt.edit', (_$: unknown, e: Any) => ({ text: e.text, cursor: e.cursor }) as never)
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

/** The sign drawn right after citation n's words, and the look of its text: ?, *, ×, or the turning glyph of a check
 *  that runs (`spin`). */
function signAfter(drawn: Any, n: number): { sign: string; props: Any } {
  const runs = all(drawn).filter(x => x.type === 'Button' && String(x.props?.label).startsWith(`citation ${n}:`))
  const last = runs[runs.length - 1]
  const text = textOf(last)
  if (/^ [?*×]$/.test(text)) return { sign: text.trim(), props: all(last).find(x => x.type === 'Text')?.props }
  return { sign: [...SPIN].some(g => text === ` ${g}`) ? 'spin' : '', props: null }
}

test("auto mode's classifier gave no verdict on the check: one notice says so and offers y, and the citations wait, not checked, none failed; the next reply's refusal says nothing again, and opening a citation says it again", OPTIONS, async ($, on) => {
  const { spawns, clock } = await session($, on, AUTO)
  await reply($, clock, 't1', 'row-a1')
  const drawnBand = await $.ui.render(above)
  const band = textOf(drawnBand)
  expect(lineOf(drawnBand)).toBe(UNREVIEWED_LINE)
  expect(UNREVIEWED_LINE).toBe("Auto mode's classifier gave no verdict on thimble's check of citations, so Claude Code refused it. Press y to allow thimble's checks this session.")
  // y is a press where it acts, the one key the line names; no mode to switch, no word of auto mode at large
  const presses = all(drawnBand).filter(x => x.type === 'Button' && String(x.props?.label).startsWith('press '))
  expect(presses.map(x => x.props.label)).toEqual(['press y'])
  expect(band).not.toContain('shift+tab')
  expect(band).not.toContain('does not let')
  // not Claude Code's words for the model, cut, nor a failure in red
  expect(band).not.toContain('the request that')
  expect(band).not.toContain('×')
  expect(JSON.stringify(drawnBand)).not.toContain('"color":"error"')
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
  expect(lineOf(await $.ui.render(above))).toBe(UNREVIEWED_LINE)
  expect(signAfter(await $.ui.render(answer('row-a2')), 2).sign).toBe('?')
})

test("y while that line shows: thimble asks Claude Code again for the check it is about, every share at once; Claude's own call worded as a check stays Claude Code's to decide; and with the OK given, a later refusal is said as any other, with no y", OPTIONS, async ($, on) => {
  // Claude Code refuses the reply's check, and starts the check y asks for again, as it starts a call a plugin's
  // tool.check answered with allow (checkallow.test.ts; this kit's spawns name no agent, so the checks' run is there too)
  const { spawns, clock } = await session($, on, e => (e.description === AGAIN_DESCRIPTION ? null : AUTO))
  await reply($, clock, 't1', 'row-a1')
  expect(lineOf(await $.ui.render(above))).toBe(UNREVIEWED_LINE)
  expect(await $.prompt.edit(key('y'))).toMatchObject({ text: '' })
  // the spawns wait out the key's word window
  expect(spawns.length).toBe(1)
  await clock.advance(WORD_MS + 50)
  await clock.advance(100)
  // the reply's five citations again, in their two shares, both asked for at once
  expect(spawns.length).toBe(3)
  for (const sp of spawns.slice(1)) expect(sp).toMatchObject({ subagent_type: 'fork', description: AGAIN_DESCRIPTION, prompt: 'PROMPT checker' })
  // the OK is thimble's own checks': Claude's own call of a subagent, worded as a check, stays Claude Code's to decide
  expect((await $.tool.check({ tool: 'Agent', input: { description: 'checking citations', prompt: 'Check these.', subagent_type: 'fork' } } as never)).decision).toBe('ask')
  // with the OK given, a check Claude Code still refuses (here a later reply's, as where Claude Code takes no plugin's
  // allow) is said by Claude Code's own first sentence, with no y: thimble's OK cannot answer it
  await reply($, clock, 't2', 'row-a2')
  const band = lineOf(await $.ui.render(above))
  expect(band).toBe('× The check of the citations could not start (The server-side auto mode classifier gave no verdict for Agent: the request that produced this action did not ask for one), so they are not checked. Open one to check it.')
  expect(band).not.toContain('Press y')
})

test('y that starts a word is typed: nothing starts, thimble has no OK, and the line stays until the prompt is sent', OPTIONS, async ($, on) => {
  const { spawns, clock } = await session($, on, e => (e.description === AGAIN_DESCRIPTION ? null : AUTO))
  await reply($, clock, 't1', 'row-a1')
  expect(await $.prompt.edit(key('y'))).toMatchObject({ text: '' })
  await clock.advance(WORD_MS / 3)
  // a letter within the word window: y was the first letter of a word
  expect(await $.prompt.edit(key('e'))).toMatchObject({ text: 'ye' })
  await clock.advance(WORD_MS * 2)
  // the spawn y asked for waited out the window and was refused there, before Claude Code started it
  expect(spawns.length).toBe(1)
  expect(signAfter(await $.ui.render(answer('row-a1')), 1).sign).toBe('?')
  expect(lineOf(await $.ui.render(above))).toBe(UNREVIEWED_LINE)
  // with no OK, opening a citation offers y again
  const ui = await $.ui.mount(answer('row-a1'))
  const cite = all(await $.ui.render(answer('row-a1'))).find(x => x.type === 'Button' && String(x.props?.label).startsWith('citation 3:'))
  await ui.press({ key: cite.props.key })
  await ui.unmount()
  expect(spawns.length).toBe(2)
  expect(lineOf(await $.ui.render(above))).toBe(UNREVIEWED_LINE)
})

test('a check refused for another cause: one failure line with the refusal\'s first sentence whole, and the citations wait, not checked', OPTIONS, async ($, on) => {
  const { spawns, clock } = await session($, on, HOOK)
  await reply($, clock, 't1', 'row-a1')
  const band = lineOf(await $.ui.render(above))
  expect(band).toBe('× The check of the citations could not start (Subagent spawn denied by a plugin: lab-sync holds every new agent while it copies the workspace to the shared drive of the team), so they are not checked. Open one to check it.')
  expect(band).not.toContain('Try again in a minute')
  expect(band).not.toContain('Press y')
  const drawn = await $.ui.render(answer('row-a1'))
  expect(signAfter(drawn, 1).sign).toBe('?')
  expect(textOf(drawn)).not.toContain('×')
  expect(spawns.length).toBe(1)
})

test("Claude Code's refusals in auto mode, as thimble reads them: no verdict on such a call, a classifier that could not answer for now, one that judged the check; any other by its first sentence, cut at a word only when that sentence is too long", () => {
  for (const said of [AUTO, HARD]) {
    expect(refusalOf(said).kind).toBe('unreviewed')
    expect(cannotStart(said)).toEqual({ kind: 'unreviewed', notice: true, text: UNREVIEWED_LINE })
    // once the person gave the OK, the same refusal offers no y: it is said as any other
    expect(cannotStart(said, true).kind).toBe('other')
    expect(cannotStart(said, true).text).not.toContain('Press y')
  }
  expect(cannotStart(BUSY)).toEqual({ kind: 'unavailable', notice: true, text: "Auto mode's classifier was unavailable for thimble's check of citations (rate-limited), so Claude Code refused it. Open a citation to check it." })
  expect(cannotStart(WAIT)).toEqual({ kind: 'unavailable', notice: true, text: "Auto mode's classifier was unavailable for thimble's check of citations (overloaded), so Claude Code refused it. Open a citation to check it." })
  expect(cannotStart(JUDGED)).toEqual({ kind: 'judged', notice: true, text: "Auto mode's classifier refused thimble's check of citations (The fork reads the made-up vault's keys), so they are not checked." })
  expect(cannotStart(HOOK)).toMatchObject({ kind: 'other', notice: false })
  expect(cannotStart("Permission to use Agent has been denied because Claude Code is running in don't ask mode. IMPORTANT: You *may* attempt to accomplish this action using other tools.").text).toBe("The check of the citations could not start (Permission to use Agent has been denied because Claude Code is running in don't ask mode), so they are not checked. Open one to check it.")
  expect(cannotStart(undefined).text).toContain('(no reason given)')
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
