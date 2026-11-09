// A check of citations that Claude Code refuses (marks/checker.ts): where auto mode's classifier gives no verdict on
// the checker's fork, the citations wait, not checked, and one line says what refused them and offers g, which lets
// thimble start its checks this session and starts the check again; once the OK is given, a check Claude Code still
// refuses says why, with no key. All data is made up. `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { WORD_MS } from '../hooks/keys'
import { AGAIN_DESCRIPTION, UNREVIEWED_LINE } from '../marks/checker'
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
/** The lines, as the person reads them. */
const NO_VERDICT = "Auto mode's classifier gave no verdict on thimble's check of citations, so Claude Code refused it."
/** Its line where no key could let the check start: what refused it, and the mode outside which thimble checks. */
const NO_VERDICT_OUTSIDE = `${NO_VERDICT} Outside auto mode, thimble can check them.`
const REPLY = 'Of the [40](#) nightly runs, [12 of 40](#) failed, most on the [p95 latency check](#); the [slow mirror](#) was down for [3 nights](#).'
const view = { columns: 100, rows: 40, isFullscreen: true }
const above = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 19 }, view: {} }, viewport: view } as never
const OPTIONS = { options: { citations: 'auto + verify', cards: false, labels: false, coverage: false }, timeoutMs: 30000 }
/** A key at the empty prompt, as Claude Code's composer sends it. */
const key = (k: string, text = '') => ({ origin: { kind: 'composer' }, key: { key: k }, text, cursor: text.length, start: text.length, end: text.length, inputText: k }) as never

/** A session whose spawns Claude Code answers with `answer`: a refusal's words, or a started fork. Answers the spawns
 *  asked for. */
async function session($: Any, on: Any, answer: (e: Any) => string | null): Promise<{ spawns: Any[]; clock: Any }> {
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
    const deny = answer(e)
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
  expect(lineOf(drawn)).toBe(NO_VERDICT_OUTSIDE)
  expect(pressesIn(drawn)).toEqual([])
  expect(JSON.stringify(drawn)).not.toContain('"color":"error"')
  // and g is typed as any letter
  expect(await $.prompt.edit(key('g'))).toMatchObject({ text: 'g' })
})
