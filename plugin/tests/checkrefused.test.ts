// A check of citations that cannot start (marks/checker.ts). In auto mode, Claude Code 2.1.307 lets a plugin's own
// call run without its classifier, unless the person's settings give the classifier rules of their own; then the
// classifier must judge the checker's fork, and the classifier that runs on Anthropic's server judges only the calls in
// Claude's own replies, so Claude Code refuses the fork with the words below, each time. In don't ask mode it refuses
// each call no rule allows. The citations then wait, not checked (a dim ? after each), with no × on any, and one line
// says what refused them: for those two, that auto mode's classifier gave no verdict, or the mode by its name, and g,
// which lets thimble start its checks this session and starts the check again, at each check they stop until the person
// gives that OK; where Claude Code takes no plugin's allow (auto mode in a remote Cowork session), and after the OK, no
// key and nothing that could not work; a classifier that could not answer for now, or that judged the check, as such;
// any other refusal by its first sentence whole. g is no other line's key: a fix's line beside it keeps y. The failure
// line wraps a long text at word edges, no row wider than the line. All data is made up. `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { barRows } from '../bar/bar'
import { failLineNow, failNotice, reasonOf } from '../bar/notice'
import { SPIN } from '../bar/busy'
import { textWidth } from '../core/text.js'
import { fixKey } from '../fix/line'
import { setFixLine } from '../fix/fixes'
import { ownKeys, WORD_MS } from '../hooks/keys'
import { AGAIN_DESCRIPTION, ALLOW_KEY, cannotStart, checkKey, noteRow, refusalOf, refusingMode, startCheck, UNREVIEWED_LINE } from '../marks/checker'
import { setOptions } from '../settings/features.mjs'
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
/** The keys the band offers as presses, by their labels. */
const pressesIn = (band: Any): string[] => all(band).filter(x => x.type === 'Button' && String(x.props?.label).startsWith('press ')).map(x => x.props.label)

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
/** Its refusal in don't ask mode, of a call no rule allows. */
const DONT_ASK = "Permission to use Agent has been denied because Claude Code is running in don't ask mode. IMPORTANT: You *may* attempt to accomplish this action using other tools that might naturally be used to accomplish this goal, e.g. using head instead of cat. "
/** A refusal for another cause: a made-up plugin's hook. */
const HOOK = 'Subagent spawn denied by a plugin: lab-sync holds every new agent while it copies the workspace to the shared drive of the team. Try again in a minute.'

/** The lines, as the person reads them. */
const NO_VERDICT = "Auto mode's classifier gave no verdict on thimble's check of citations, so Claude Code refused it."
const DONT_ASK_LINE = "Claude Code's don't ask mode refused thimble's check of citations. Press g to allow thimble's checks this session."

const REPLY = 'Of the [40](#) nightly runs, [12 of 40](#) failed, most on the [p95 latency check](#); the [slow mirror](#) was down for [3 nights](#).'
const view = { columns: 100, rows: 40, isFullscreen: true }
const above = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 19 }, view: {} }, viewport: view } as never
const answer = (row: string) => ({ plugin: 'thimble', component: 'AssistantMessage', surface: 'terminal', requestId: row, viewport: view, props: { text: REPLY, isFirstOfReply: true } }) as never
const OPTIONS = { options: { citations: 'auto cite + verify', cards: false, labels: false, coverage: false }, timeoutMs: 30000 }
/** A key at the empty prompt, as Claude Code's composer sends it. */
const key = (k: string, text = '') => ({ origin: { kind: 'composer' }, key: { key: k }, text, cursor: text.length, start: text.length, end: text.length, inputText: k }) as never

/** A session whose spawns Claude Code answers with `answer`: a refusal's words, or a started fork. Answers the spawns
 *  asked for. `env`: more of the process's variables. */
async function session($: Any, on: Any, answer: string | ((e: Any) => string | null), env: Record<string, string> = {}): Promise<{ spawns: Any[]; clock: Any }> {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp', PATH: '/usr/bin', ...env })
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
  // Claude Code types the key into the box, as the edit says
  on('prompt.edit', (_$: unknown, e: Any) => ({ text: `${e.text.slice(0, e.start)}${e.inputText ?? ''}${e.text.slice(e.end)}`, cursor: e.start + String(e.inputText ?? '').length }) as never)
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

/** Citation n of `row` opened, as a click on it opens it: its check is asked for. */
async function openCitation($: Any, row: string, n: number): Promise<void> {
  const ui = await $.ui.mount(answer(row))
  const cite = all(await $.ui.render(answer(row))).find(x => x.type === 'Button' && String(x.props?.label).startsWith(`citation ${n}:`))
  await ui.press({ key: cite.props.key })
  await ui.unmount()
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

test("auto mode's classifier gave no verdict on the check: one notice says so and offers g, and the citations wait, not checked, none failed; each later reply's refusal says it again until the person gives the OK, and so does opening a citation", OPTIONS, async ($, on) => {
  const { spawns, clock } = await session($, on, AUTO)
  await reply($, clock, 't1', 'row-a1')
  const drawnBand = await $.ui.render(above)
  const band = textOf(drawnBand)
  expect(lineOf(drawnBand)).toBe(UNREVIEWED_LINE)
  expect(UNREVIEWED_LINE).toBe(`${NO_VERDICT} Press g to allow thimble's checks this session.`)
  // g is a press where it acts, the one key the line names; no mode to switch, no word of auto mode at large
  expect(pressesIn(drawnBand)).toEqual(['press g'])
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

  // the next reply: its check is refused too, its citations wait, and the line comes back with its key: the person's
  // OK is what lets the checks run
  await reply($, clock, 't2', 'row-a2')
  expect(spawns.length).toBe(2)
  expect(lineOf(await $.ui.render(above))).toBe(UNREVIEWED_LINE)
  expect(signAfter(await $.ui.render(answer('row-a2')), 1).sign).toBe('?')

  // opening a citation asks for its check: refused, the line answers the press
  await $.prompt.submit({ text: 'and the mirror?', origin: { kind: 'composer' } } as never)
  expect(lineOf(await $.ui.render(above))).toBe('')
  await openCitation($, 'row-a2', 2)
  expect(spawns.length).toBe(3)
  expect(lineOf(await $.ui.render(above))).toBe(UNREVIEWED_LINE)
  expect(signAfter(await $.ui.render(answer('row-a2')), 2).sign).toBe('?')
})

test("g while that line shows: thimble asks Claude Code again for the check it is about, every share at once; Claude's own call worded as a check stays Claude Code's to decide; and with the OK given, a check Claude Code still refuses says why, with no key and nothing that could not work", OPTIONS, async ($, on) => {
  // Claude Code refuses the reply's check, and starts the check g asks for again, as it starts a call a plugin's
  // tool.check answered with allow (checkallow.test.ts; this kit's spawns name no agent, so the checks' run is there too)
  const { spawns, clock } = await session($, on, e => (e.description === AGAIN_DESCRIPTION ? null : AUTO))
  await reply($, clock, 't1', 'row-a1')
  expect(lineOf(await $.ui.render(above))).toBe(UNREVIEWED_LINE)
  expect(await $.prompt.edit(key('g'))).toMatchObject({ text: '' })
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
  // allow) says what refused it, a notice with no key, and not `Open one to check it`, which would be refused the same way
  await reply($, clock, 't2', 'row-a2')
  const drawn = await $.ui.render(above)
  expect(lineOf(drawn)).toBe(NO_VERDICT)
  expect(pressesIn(drawn)).toEqual([])
  expect(JSON.stringify(drawn)).not.toContain('"color":"error"')
  // and g is typed as any letter
  expect(await $.prompt.edit(key('g'))).toMatchObject({ text: 'g' })
})

test('g that starts a word is typed: nothing starts, thimble has no OK, and the line stays until the prompt is sent', OPTIONS, async ($, on) => {
  const { spawns, clock } = await session($, on, e => (e.description === AGAIN_DESCRIPTION ? null : AUTO))
  await reply($, clock, 't1', 'row-a1')
  expect(await $.prompt.edit(key('g'))).toMatchObject({ text: '' })
  await clock.advance(WORD_MS / 3)
  // a letter within the word window: g was the first letter of a word
  expect(await $.prompt.edit(key('o'))).toMatchObject({ text: 'go' })
  await clock.advance(WORD_MS * 2)
  // the spawn g asked for waited out the window and was refused there, before Claude Code started it
  expect(spawns.length).toBe(1)
  expect(signAfter(await $.ui.render(answer('row-a1')), 1).sign).toBe('?')
  expect(lineOf(await $.ui.render(above))).toBe(UNREVIEWED_LINE)
  // with no OK, opening a citation offers g again
  await openCitation($, 'row-a1', 3)
  expect(spawns.length).toBe(2)
  expect(lineOf(await $.ui.render(above))).toBe(UNREVIEWED_LINE)
})

test("don't ask mode refuses the check: a notice names the mode and offers g, the citations wait, not checked, none failed; opening one says it again; g starts the check again", OPTIONS, async ($, on) => {
  const { spawns, clock } = await session($, on, e => (e.description === AGAIN_DESCRIPTION ? null : DONT_ASK))
  await reply($, clock, 't1', 'row-a1')
  const drawn = await $.ui.render(above)
  expect(lineOf(drawn)).toBe(DONT_ASK_LINE)
  expect(pressesIn(drawn)).toEqual(['press g'])
  // a notice: the person's mode at work, not thimble's failure; not Claude Code's words for the model
  expect(textOf(drawn)).not.toContain('×')
  expect(JSON.stringify(drawn)).not.toContain('"color":"error"')
  expect(textOf(drawn)).not.toContain('IMPORTANT')
  expect(signAfter(await $.ui.render(answer('row-a1')), 1).sign).toBe('?')
  // opening a citation: refused the same way, and the same line with its key, never `Open it again to try again`
  await $.prompt.submit({ text: 'and the mirror?', origin: { kind: 'composer' } } as never)
  await openCitation($, 'row-a1', 4)
  expect(spawns.length).toBe(2)
  expect(lineOf(await $.ui.render(above))).toBe(DONT_ASK_LINE)
  // g: the check that line is about (the opened citation's) is asked for again (its run, where Claude Code starts it,
  // is checkallow.test.ts's: this kit's spawns name no agent)
  expect(await $.prompt.edit(key('g'))).toMatchObject({ text: '' })
  await clock.advance(WORD_MS + 50)
  await clock.advance(100)
  expect(spawns.length).toBe(3)
  expect(spawns[2]).toMatchObject({ subagent_type: 'fork', description: AGAIN_DESCRIPTION })
  expect(String(spawns[2].prompt)).toContain('The analyst opened citation 4 to read its evidence.')
})

test("in a remote Cowork session, where Claude Code takes no plugin's allow on a subagent in auto mode: the line says what refused the check, with no key and nothing that could not work, and g is typed", OPTIONS, async ($, on) => {
  const { spawns, clock } = await session($, on, AUTO, { CLAUDE_CODE_ENTRYPOINT: 'remote_cowork' })
  await reply($, clock, 't1', 'row-a1')
  const drawn = await $.ui.render(above)
  expect(lineOf(drawn)).toBe(NO_VERDICT)
  expect(pressesIn(drawn)).toEqual([])
  expect(textOf(drawn)).not.toContain('Open')
  expect(await $.prompt.edit(key('g'))).toMatchObject({ text: 'g' })
  await clock.advance(WORD_MS * 2)
  expect(spawns.length).toBe(1)
  expect(signAfter(await $.ui.render(answer('row-a1')), 1).sign).toBe('?')
})

test('a check refused for another cause: one failure line with the refusal\'s first sentence whole, and the citations wait, not checked', OPTIONS, async ($, on) => {
  const { spawns, clock } = await session($, on, HOOK)
  await reply($, clock, 't1', 'row-a1')
  const band = lineOf(await $.ui.render(above))
  expect(band).toBe('× The check of the citations could not start (Subagent spawn denied by a plugin: lab-sync holds every new agent while it copies the workspace to the shared drive of the team), so they are not checked. Open one to check it.')
  expect(band).not.toContain('Try again in a minute')
  expect(band).not.toContain('Press g')
  const drawn = await $.ui.render(answer('row-a1'))
  expect(signAfter(drawn, 1).sign).toBe('?')
  expect(textOf(drawn)).not.toContain('×')
  expect(spawns.length).toBe(1)
})

test("Claude Code's refusals, as thimble reads them: the permission mode a refusal names; no verdict on such a call, a classifier that could not answer for now, one that judged the check, don't ask mode; any other by its first sentence, cut at a word only when that sentence is too long", () => {
  expect(refusingMode(AUTO)).toBe('auto mode')
  expect(refusingMode(DONT_ASK)).toBe("don't ask mode")
  expect(refusingMode("Permission to use Agent has been denied because Claude Code is running in don't ask mode. Try something else.")).toBe("don't ask mode")
  expect(refusingMode(HOOK)).toBeNull()
  for (const said of [AUTO, HARD]) {
    expect(refusalOf(said).kind).toBe('unreviewed')
    expect(cannotStart(said)).toEqual({ kind: 'unreviewed', notice: true, offers: true, text: UNREVIEWED_LINE })
    // once the person gave the OK, or where Claude Code takes no plugin's allow, the same refusal offers no key
    expect(cannotStart(said, { allowed: true })).toEqual({ kind: 'unreviewed', notice: true, text: NO_VERDICT })
    expect(cannotStart(said, { cowork: true })).toEqual({ kind: 'unreviewed', notice: true, text: NO_VERDICT })
  }
  expect(refusalOf(DONT_ASK)).toMatchObject({ kind: 'mode', mode: "don't ask mode" })
  expect(cannotStart(DONT_ASK)).toEqual({ kind: 'mode', notice: true, offers: true, text: DONT_ASK_LINE })
  // Claude Code takes a plugin's allow in don't ask mode, in a remote Cowork session too
  expect(cannotStart(DONT_ASK, { cowork: true })).toEqual({ kind: 'mode', notice: true, offers: true, text: DONT_ASK_LINE })
  expect(cannotStart(DONT_ASK, { allowed: true })).toEqual({ kind: 'mode', notice: true, text: "Claude Code's don't ask mode refused thimble's check of citations." })
  expect(cannotStart(BUSY)).toEqual({ kind: 'unavailable', notice: true, text: "Auto mode's classifier was unavailable for thimble's check of citations (rate-limited), so Claude Code refused it. Open a citation to check it." })
  expect(cannotStart(WAIT)).toEqual({ kind: 'unavailable', notice: true, text: "Auto mode's classifier was unavailable for thimble's check of citations (overloaded), so Claude Code refused it. Open a citation to check it." })
  expect(cannotStart(JUDGED)).toEqual({ kind: 'judged', notice: true, text: "Auto mode's classifier refused thimble's check of citations (The fork reads the made-up vault's keys), so they are not checked." })
  expect(cannotStart(HOOK)).toMatchObject({ kind: 'other', notice: false })
  expect(cannotStart(HOOK).offers).toBeUndefined()
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

/** An engine with versioned state, the checker's text, and forks Claude Code refuses with `deny`. */
function plainEngine(deny: string) {
  const state = new Map<string, { value: unknown; version: number }>()
  let spawned = 0
  const $: Any = {
    env: { get: async (k: string) => ({ THIMBLE_HOME: '/made-up/.thimble', TMPDIR: '/made-up/tmp' } as Any)[k] },
    plugin: { root: '/made-up/plugin', name: 'thimble' },
    session: { cwd: async () => '/made-up/data', id: async () => 's-both', messages: async () => [] },
    fs: {
      read: async (p: string) => { if (p.endsWith('/prompts/checker.md')) return 'CHECK\n{{MARKS}}'; throw new Error(`no file ${p}`) },
      write: async () => undefined,
      list: async () => [],
      exists: async () => false,
    },
    process: { run: async (argv: string[]) => tempRun(argv) ?? { exitCode: 0, stdout: '', stderr: '' } },
    agent: { spawn: async () => { spawned++; return { deny } }, list: async () => [] },
    state: {
      get: async (k: Any) => state.get(JSON.stringify(k)) ?? { value: undefined, version: 0 },
      set: async (k: Any, value: unknown, o?: { ifVersion?: number }) => {
        const cur = state.get(JSON.stringify(k))
        if (o?.ifVersion !== undefined && o.ifVersion !== (cur?.version ?? 0)) return { isSet: false, version: cur?.version ?? 0 }
        const version = (cur?.version ?? 0) + 1
        state.set(JSON.stringify(k), { value, version })
        return { isSet: true, version }
      },
    },
    clock: { now: async () => 1000, after: () => ({ cancel() {} }), every: () => ({ cancel() {} }), sleep: async () => undefined },
    ui: { invalidate: () => undefined, toast: () => undefined },
  }
  const read = async (k: string) => (await $.state.get({ plugin: 'thimble', key: k })).value
  return { $, read, spawned: () => spawned }
}

test("a fix's line and the line that offers g at once: each key is offered once, y goes to the fix and g to the checks, and a card never gets g", async () => {
  setOptions({ citations: 'auto cite + verify' })
  try {
    const { $, read, spawned } = plainEngine(AUTO)
    // a reply's check, refused where auto mode's classifier gives no verdict: the line that offers g
    await noteRow($, 'row-1', REPLY)
    await startCheck($, { turnId: 't-1', reason: 'answer' })
    expect(spawned()).toBe(1)
    expect((await failLineNow($))?.text).toBe(UNREVIEWED_LINE)
    // and a fix that waits for the person's y
    await $.state.set({ plugin: 'thimble', key: 'fixes' }, { fixes: [{ id: 1, title: 'Bar says read', words: ['make the bar say read'], rounds: 1, made_in: 'terminal', created: 1761200000, state: 'ready', work: null, commit: 'c0ffee1', files: [{ path: 'plugin/bar/bar.tsx', add: 1, del: 1 }], tests: 'passed', summary: 'The bar says read.', error: null }], on: true, live: '/made-up/.thimble/fixes/live', version: '0.10.6', count_on: 0, pointed: true, gen: 1 })
    await setFixLine($, { id: 1, kind: 'ready' })
    const band = await barRows($, ELS, 110, { on: () => true })
    expect(lineOf(band)).toBe(UNREVIEWED_LINE)
    expect(band.map(textOf).join('\n')).toContain('y use it now · d what changed · n later')
    // the band's presses, each by its key: g once, on the check's line, and the fix's keys on its own; none twice
    const keys = all(band).filter(x => x.type === 'Button').map(x => String(x.props?.label)).map(l => (l.startsWith('press ') ? l.slice(6) : l.split(' ')[0]))
    expect(keys).toEqual(expect.arrayContaining([ALLOW_KEY, 'y', 'd', 'n']))
    expect(keys.length).toBe(new Set(keys).size)
    // y is the fix's, never the checks'; g the checks', never the fix's
    expect(await checkKey($, 'y', 0)).toBeNull()
    expect(await fixKey($, 'y')).not.toBeNull()
    expect(await fixKey($, ALLOW_KEY)).toBeNull()
    const g = await checkKey($, ALLOW_KEY, 0)
    expect(g).not.toBeNull()
    await g!.now()
    await g!.later()
    expect(await read('checksAllowed')).toBe(true)
    // the fix still waits for its y
    expect(await read('fixLine')).toEqual({ id: 1, kind: 'ready' })
    // g is thimble's own: no card gets it, so none offers it beside the line
    expect(ownKeys()).toContain(ALLOW_KEY)
  } finally {
    setOptions({})
  }
})

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
