// thimble's switches (settings/: features.mjs, term.ts; panes/settings.js): each feature is a field of the plugin's
// userConfig, so Claude Code lists it in /config and hands it to register(on, options). A lens turned off has no
// section in the observer's prompt and no key in its reply, and what reads it hides (c and the claims count, v lit);
// the observer turned off looks at nothing. /thimble-settings, or a click on `thimble` at the bar's left, opens the
// settings panel in the side panel, where ↵ or a click turns a switch on or off through Claude Code.
// `claude plugin test plugin`. The model's calls and the Node children are answered here.
import { expect, mock, test } from 'claude-code/testing'

import { SWITCHES } from '../settings/features.mjs'
import { promptStub } from './stubs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Json = Record<string, unknown>
const ROOT = '/data'
const ROW = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const USAGE = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 }
const NOW = Date.parse('2026-10-18T09:00:00Z')
const HINT = { plugin: 'thimble', component: 'AbovePrompt', surface: 'terminal', requestId: 'above', props: { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 200, scroll: { offset: 0, bodyRows: 16 }, view: {} }, viewport: { columns: 200, rows: 48, isFullscreen: true } } as never
const PANE = { plugin: 'thimble', component: 'Pane', surface: 'terminal', requestId: 'object', props: { bodyColumns: 92, placement: 'dock', scroll: { bodyRows: 44, offset: 0 }, isFocused: true, title: 'thimble settings', view: {} }, viewport: { columns: 100, rows: 50, isFullscreen: true } } as never

function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + textOf(n.children)
}
function buttons(n: Any, out: Any[] = []): Any[] {
  if (n == null || typeof n !== 'object') return out
  if (Array.isArray(n)) { n.forEach(x => buttons(x, out)); return out }
  if (n.type === 'Button') out.push(n)
  buttons(n.props?.children, out)
  buttons(n.children, out)
  return out
}

/** The session around the switches: Claude Code's /config rows of the plugin's fields (as `values` holds them), the
 *  model's pass, a turn's tool call, and the side panel. */
function world(on: Any, values: Record<string, boolean> = {}) {
  mock.env(on, { THIMBLE_HOME: '/home/t/.thimble' })
  mock.store(on)
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 's-1' }))
  on('session.messages', () => ({ value: [] }))
  const files: Record<string, string> = {}
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files || e.path.endsWith('.md') }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files[e.path] ?? promptStub(e.path) ?? '' }))
  on('fs.write', (_$: unknown, e: { path: string; content?: string }) => { files[e.path] = String(e.content ?? ''); return { value: undefined } })
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    let out = '{}'
    if (e.argv.some(a => a.endsWith('objects.mjs'))) out = '[]'
    else if (e.argv.includes('coverage')) out = e.argv.includes('--json') ? JSON.stringify({ total: { seen_share: 0.12 }, files: [] }) : 'Coverage of this session · 4 source files'
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const forks: string[] = []
  const pass = (prompt: string) => {
    forks.push(prompt)
    return { value: { isAnswered: true, text: JSON.stringify({ notes: [{ note: 'Say the 6,543 counts reverts.' }], verbs: { v: { note: 'saves by day', proposals: ['saves by day'] } }, glosses: [], claims: [] }), usage: USAGE } }
  }
  on('model.fork', (_$: unknown, e: { prompt: string }) => pass(e.prompt))
  on('model.complete', (_$: unknown, e: { prompt: string; system?: string }) => pass(`${e.system ?? ''}\n${e.prompt}`))
  const submitted: { text: string; context: readonly string[] }[] = []
  on('prompt.submit', (_$: unknown, e: { text: string; context?: readonly string[] }) => { submitted.push({ text: e.text, context: e.context ?? [] }); return { text: e.text } })
  on('prompt.edit', (_$: unknown, e: { text: string; start: number; end: number; inputText: string }) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the reply'] }) as never)
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: unknown, e: { answer?: string }) => ({ text: e.answer ?? '' }))
  on('turn.step', async function* (_$: unknown, e: Any) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ id: 'u1', name: 'Bash', input: {} }] } })
  on('command.register', (_$: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  // Claude Code's rows of the plugin's fields: their value, and a change kept as the menu's would be
  const config = { ...Object.fromEntries(SWITCHES.map(s => [s.key, s.default])), ...values }
  const sets: { key: string; value: unknown }[] = []
  on('config.list', () => ({ value: [
    { key: 'theme', label: 'Theme', kind: 'choice', value: 'dark', provider: { plugin: 'engine', tier: 'core' }, isLocked: false },
    ...SWITCHES.map(s => ({ key: `thimble.${s.key}`, label: s.title, kind: 'boolean', value: config[s.key], provider: { plugin: 'thimble', tier: 'user' }, isLocked: false })),
  ] }))
  on('config.set', (_$: unknown, e: { key: string; value: boolean }) => { sets.push({ key: e.key, value: e.value }); config[e.key.replace(/^thimble\./, '')] = e.value; return { value: e.value } })
  const opened: Json[] = []
  on('ui.open', (_$: unknown, e: Json) => { opened.push(e); return { value: { isPlaced: true } } })
  on('ui.focus', () => ({ value: {} }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.scroll', () => ({ value: {} }))
  const toasts: string[] = []
  on('ui.toast', (_$: unknown, e: unknown) => { toasts.push(typeof e === 'string' ? e : String((e as { text?: string })?.text ?? JSON.stringify(e))); return { value: undefined } })
  const clock = mock.clock(on, { now: NOW })
  return { files, forks, submitted, sets, opened, toasts, clock, config }
}

/** A turn of main's that ran a tool and answered. */
async function turn($: Any, w: Any, id: string, prompt: string, answer: string) {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  await $.prompt.submit({ text: prompt, origin: { kind: 'composer' } } as never)
  await $.turn.start({ turnId: id, text: prompt } as never)
  const s = $.turn.step({ turnId: id, index: 0, model: 'claude-opus-5-5', messageCount: 3 })
  for (let r = await s.next(); !r.done; r = await s.next()) { /* no chunks */ }
  await $.session.append({ door: 'response', uuid: ROW, origin: { kind: 'model', model: 'm' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: answer }] } } as never)
  await $.turn.complete({ turnId: id, answer, durationMs: 5, reason: 'answer', isAborted: false } as never)
  await w.clock.advance(100)
  await w.clock.settle()
}

test('a lens turned off has no section in the prompt and no key in the reply, and what reads it hides: no c, no claims count, no v lit', { options: { claims: false, visualize: false, details: false } }, async ($, on) => {
  const w = world(on, { claims: false, visualize: false, details: false })
  await turn($, w, 't1', 'when did they edit most?', 'June 18 had the most saves.')
  expect(w.forks.length).toBe(1)
  const p = w.forks[0]!
  expect(p).toContain('LENS notes')
  expect(p).not.toContain('LENS claims')
  expect(p).not.toContain('LENS actions')
  // important details off: no heads-up section, and no heads-up in the reply
  expect(p).not.toContain('LENS heads')
  expect(p).toContain('REPLY {"notes": [], "verbs": {}, "glosses": []}')
  expect(p).toContain('| v visualize, s squeeze |')
  const bar = textOf(await $.ui.render(HINT))
  expect(bar).toContain('thimble  v visualize · s squeeze')
  expect(bar).not.toContain('claims')
  expect(bar).not.toContain('●')
})

test('the observer turned off looks at nothing and gives Claude no notes', { options: { observer: false } }, async ($, on) => {
  const w = world(on, { observer: false })
  await turn($, w, 't1', 'when did they edit most?', 'June 18 had the most saves.')
  await w.clock.advance(3000)
  await w.clock.settle()
  expect(w.forks.length).toBe(0)
  await $.prompt.submit({ text: 'next', origin: { kind: 'composer' } } as never)
  expect(w.submitted.at(-1)!.context.join('\n')).not.toContain('6,543')
})

test('the bar\'s counts hide with their switches: coverage, and the labels', { options: { coverage: false } }, async ($, on) => {
  const w = world(on, { coverage: false })
  await turn($, w, 't1', 'when did they edit most?', 'June 18 had the most saves.')
  expect(textOf(await $.ui.render(HINT))).not.toContain('seen')
})

test('/thimble-settings opens the settings panel: each switch with whether it is on, what it does and what it costs; a press turns one off through Claude Code', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  expect(await $.command.run({ command: 'thimble-settings', args: '' } as never)).toEqual({})
  await w.clock.settle()
  expect(w.opened.some(x => x.id === 'object' && x.title === 'thimble settings')).toBe(true)
  const ui = await $.ui.mount(PANE)
  await w.clock.settle()
  const t = textOf(await ui.drawn())
  for (const s of SWITCHES) expect(t).toContain(s.title)
  expect(t).toContain('● on')
  expect(t).toContain('Observer')
  expect(t).toContain('The bar')
  // a press on the Claims row turns it off, through Claude Code's own change of the setting
  const row = buttons(await ui.drawn()).find((b: Any) => String(b.props.key).endsWith('|s-claims'))
  expect(row).toBeDefined()
  await ui.press({ key: row.props.key })
  await w.clock.settle()
  expect(w.sets).toEqual([{ key: 'thimble.claims', value: false }])
  await ui.unmount()
})

test('a click on thimble at the bar\'s left opens the settings panel', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  const ui = await $.ui.mount(HINT)
  await w.clock.settle()
  const label = buttons(await ui.drawn()).find((b: Any) => b.props.label === 'thimble settings')
  expect(label).toBeDefined()
  await ui.press({ key: label.props.key })
  await w.clock.settle()
  expect(w.opened.some(x => x.id === 'object' && x.title === 'thimble settings')).toBe(true)
  await ui.unmount()
})
