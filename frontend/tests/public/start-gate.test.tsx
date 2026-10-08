// @vitest-environment jsdom
// The Start gate (src/chat/StartGate.tsx): the orientation's request, start_orientation's four switches, and the run's
// model and effort, which open at Settings' orientation row and apply to this run only; no fast mode, Ultracode or
// permission switcher, since the orientation runs as a subagent of main in main's mode. Start is a click to its own
// route with the switches, model and effort and no mode. Start is off, with a line under the field saying why, while
// thimble's hooks module is not in main's session or main is in plan mode, and no line shows while Start is on; a
// refused start fills the gate again.
// A stored ultracode reads as xhigh. While the product tour runs, main draws no gate, and the tour's own example of it
// (src/tour/examples.json) is the gate as it is drawn now, with no Ultracode and no fast mode either.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { AGENT_EFFORTS, agentEffort } from '../../src/chat/ModelLine.tsx'
import { DEFAULT_ON, NO_SESSION_LINE, PLAN_MODE_LINE, StartGate, noModuleLine, restoreOf, startBlocked, startBody, startGateOpen, startGateShown, startedChat } from '../../src/chat/StartGate.tsx'
import { UNFENCED_LINE } from '../../src/shell/UnfencedBanner.tsx'
import { invalidateSettings } from '../../src/lib/models.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const SETTINGS = { models: { orient: { model: 'claude-opus-5-5[1m]', effort: 'xhigh', fast: false }, dev: { model: 'claude-custom-9', effort: 'high', fast: false } } }
let sent: { url: string; body: unknown }[] = []

beforeEach(() => {
  sent = []
  invalidateSettings('mini')
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      sent.push({ url: String(url), body: JSON.parse(String(init.body)) })
      return new Response(JSON.stringify({ agentId: 'a1', request: 'r1' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify(SETTINGS), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const click = async (b: Element) => {
  await act(async () => (b as HTMLElement).click())
  await settle()
}
const startButton = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Start')!
const menuItems = () => [...document.querySelectorAll<HTMLButtonElement>('.menu-item')].map((b) => b.querySelector('.menu-item-label')?.textContent ?? b.textContent)

describe('the Start gate', () => {
  test("opens at Settings' model and effort, with Claude Code's levels, no fast mode, Ultracode or mode switcher, and no line under the field while Start is on", async () => {
    const el = await mount(<StartGate ws="mini" model="claude-opus-5-5[1m]" effort="xhigh" main={{ attached: { session: 's', cwd: '/c', since: '', permission_mode: 'auto' } }} />)
    await settle()
    expect(el.querySelector('button[aria-label="Model for the orientation"]')?.textContent).toBe('Opus 5.5')
    const effort = el.querySelector<HTMLButtonElement>('button[aria-label="Effort for the orientation"]')!
    expect(effort.textContent).toBe('xhigh')
    await click(effort)
    expect(menuItems()).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(el.querySelector('.fast-bolt')).toBeNull()
    await click(el.querySelector('.chat-gate-options-toggle')!)
    expect([...el.querySelectorAll('.chat-gate-row')].map((r) => r.getAttribute('data-pass'))).toEqual(['final', 'views', 'critique', 'report'])
    expect(el.querySelector('.chat-gate-perms, .seg')).toBeNull()
    expect(startButton(el).disabled).toBe(false)
    expect(el.querySelector('.chat-gate-mode')).toBeNull()
    expect(el.textContent).not.toMatch(/subagent|auto mode/)
  })

  test("Start posts the switches, the run's model and effort and no mode to its own route", async () => {
    const answers: unknown[] = []
    const el = await mount(<StartGate ws="mini" model="claude-opus-5-5[1m]" effort="xhigh" onAnswer={(a) => answers.push(a)} />)
    await settle()
    await click(el.querySelector('button[aria-label="Effort for the orientation"]')!)
    await click([...document.querySelectorAll('.menu-item')].find((b) => b.textContent?.includes('max'))!)
    await click(startButton(el))
    expect(sent).toEqual([{ url: '/api/ws/mini/start', body: { deck: true, views: true, critique: false, report: true, model: 'claude-opus-5-5[1m]', effort: 'max' } }])
    expect(answers).toEqual([{ agentId: 'a1', request: 'r1' }])
    for (const k of ['mode', 'fast', 'ultracode']) expect(Object.keys(sent[0].body as object)).not.toContain(k)
  })

  test('a model that runs with no effort shows no effort menu and sends none', async () => {
    const el = await mount(<StartGate ws="mini" model="claude-opus-5-5" effort="xhigh" />)
    await settle()
    await click(el.querySelector('button[aria-label="Model for the orientation"]')!)
    await click([...document.querySelectorAll('.menu-item')].find((b) => b.textContent?.includes('claude-haiku'))!)
    expect(el.querySelector('button[aria-label="Effort for the orientation"]')).toBeNull()
    await click(startButton(el))
    expect(sent[0].body).toEqual({ deck: true, views: true, critique: false, report: true, model: 'claude-haiku-4-5-20251001' })
  })

  test("without thimble's module Start is off and the line says why; in plan mode too", async () => {
    const off = await mount(<StartGate ws="mini" model="claude-opus-5-5" effort="high" main={{ module: false, module_why: 'THIMBLE_NO_MODULE is set' }} />)
    await settle()
    expect(startButton(off).disabled).toBe(true)
    const line = off.querySelector('.chat-gate-mode')!.textContent!
    expect(line).toContain("thimble's agents can't start in this session: Claude Code's hooks modules are off (THIMBLE_NO_MODULE is set)")
    expect(line).toContain('Unset THIMBLE_NO_MODULE, then run `thimble -c`.')
    await click(startButton(off))
    expect(sent).toEqual([])
    // plan mode turns Start off with its line (section 2, live check L21): thimble's module reports a shift+tab made
    // while main is idle within seconds, so the mode is no longer stale until main's next turn
    const plan = await mount(<StartGate ws="mini" model="claude-opus-5-5" effort="high" main={{ attached: { session: 's', cwd: '/c', since: '', permission_mode: 'plan' } }} />)
    expect(startButton(plan).disabled).toBe(true)
    expect(plan.querySelector('.chat-gate-mode')!.textContent).toBe(PLAN_MODE_LINE)
    expect(plan.querySelector('.chat-gate-mode')!.getAttribute('role')).toBe('alert')
  })

  test("in a session thimble did not start, Start is off with the plain-claude warning, not the modules-off line", async () => {
    // live check L15: a plain `claude` with /thimble has no module for that reason, and the modules-off line sent the
    // analyst to `thimble doctor` and `thimble -c`
    const main = { attached: { session: 's', cwd: '/c', since: '', permission_mode: 'auto' }, launched: false, fenced: false, module: false, module_why: "Claude Code did not load thimble's hooks module" }
    const el = await mount(<StartGate ws="mini" model="claude-opus-5-5" effort="high" main={main} />)
    await settle()
    expect(startButton(el).disabled).toBe(true)
    expect(el.querySelector('.chat-gate-mode')!.textContent).toBe(UNFENCED_LINE)
    expect(startBlocked(main)?.kind).toBe('not-launched')
    expect(startBlocked({ ...main, launched: true, fenced: true })?.kind).toBe('no-module')
  })

  test("with no session attached, as in a worked example's workspace, Start is off and the line says so plainly, not the modules-off line", async () => {
    // a worked example's workspace is read without a session: main's meta says attached null and module false, since
    // nothing runs the module, and the modules-off line gave the wrong reason in red
    const main = { attached: null, module: false, module_why: "Claude Code did not load thimble's hooks module" }
    const el = await mount(<StartGate ws="mini" model="claude-opus-5-5" effort="high" main={main} />)
    await settle()
    expect(startButton(el).disabled).toBe(true)
    const line = el.querySelector('.chat-gate-mode')!
    expect(line.textContent).toBe(NO_SESSION_LINE)
    expect(line.classList.contains('chat-gate-blocked')).toBe(false)
    expect(line.getAttribute('role')).toBeNull()
    expect(startBlocked(main)?.kind).toBe('no-session')
    // a meta that does not say leaves Start on, as before
    expect(startBlocked({ module: true })).toBeNull()
  })

  test('a refused start fills the gate with its request, switches, model and effort', async () => {
    const restore = restoreOf({ status: 'refused', query: 'the moderators', passes: ['final', 'report'], critique: true, model: 'claude-sonnet-5', effort: 'medium', refused: { kind: 'auto-mode', reason: 'no' } })!
    const el = await mount(<StartGate ws="mini" model="claude-opus-5-5" effort="xhigh" restore={restore} />)
    await settle()
    expect(el.querySelector<HTMLTextAreaElement>('.chat-gate-text textarea, textarea.chat-gate-text, .chat-gate-text')).not.toBeNull()
    expect(el.querySelector('textarea')!.value).toBe('the moderators')
    expect(el.querySelector('button[aria-label="Model for the orientation"]')?.textContent).toBe('Sonnet 5')
    expect(el.querySelector('button[aria-label="Effort for the orientation"]')?.textContent).toBe('medium')
    await click(startButton(el))
    expect(sent[0].body).toEqual({ deck: true, views: false, critique: true, report: true, model: 'claude-sonnet-5', effort: 'medium', text: 'the moderators' })
  })

  test('a stored ultracode, a mode of main only, reads as xhigh, with no fast mode, and Start sends xhigh', async () => {
    expect(agentEffort('ultracode')).toBe('xhigh')
    expect(agentEffort('max')).toBe('max')
    expect(agentEffort(undefined)).toBeNull()
    const el = await mount(<StartGate ws="mini" model="claude-opus-5-5[1m]" effort="ultracode" />)
    await settle()
    expect(el.querySelector('button[aria-label="Effort for the orientation"]')?.textContent).toBe('xhigh')
    expect(el.textContent).not.toMatch(/ultracode/i)
    expect(el.querySelector('.fast-bolt, [data-fast]')).toBeNull()
    await click(startButton(el))
    expect(sent[0].body).toEqual({ deck: true, views: true, critique: false, report: true, model: 'claude-opus-5-5[1m]', effort: 'xhigh' })
    // a start refused before 0.6.0 may name ultracode as its effort
    expect(restoreOf({ status: 'refused', query: '', passes: [], model: 'claude-opus-5-5[1m]', effort: 'ultracode' })?.effort).toBe('xhigh')
  })
})

describe("the tour's example of the gate", () => {
  const snap = (JSON.parse(readFileSync(path.resolve(__dirname, '../../src/tour/examples.json'), 'utf8')) as Record<string, string>).gate
  /** Each element of a tree as `tag.class class`, in document order: what the gate is drawn with, not its text. */
  const shape = (root: Element) => [root, ...root.querySelectorAll('*')].map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join(' ')}`)

  test('is the gate as StartGate draws it now, its options closed: the same elements with the same classes', async () => {
    const el = await mount(<StartGate ws="mini" model="claude-opus-5-5[1m]" effort="xhigh" onSkip={() => undefined} />)
    await settle()
    const own = el.querySelector('.chat-gate')!
    const box = document.createElement('div')
    box.innerHTML = snap
    expect(shape(box.firstElementChild!)).toEqual(shape(own))
  })

  test("offers no Ultracode and no fast mode: its effort is one of the agents' levels", () => {
    const box = document.createElement('div')
    box.innerHTML = snap
    expect(snap).not.toMatch(/ultracode|fast/i)
    expect(box.querySelector('.fast-bolt, .model-line-fast, [data-fast]')).toBeNull()
    const effort = box.querySelector('.model-line-effort')
    expect(AGENT_EFFORTS).toContain(effort?.textContent)
    expect(AGENT_EFFORTS).toContain(effort?.getAttribute('data-effort'))
  })
})

describe('its rules', () => {
  test('the gate opens before any orientation and again after a refused one', () => {
    expect(startGateOpen(null, 0)).toBe(true)
    expect(startGateOpen('running', 1)).toBe(false)
    expect(startGateOpen('refused', 1)).toBe(true)
    expect(startGateOpen('starting', 0)).toBe(false)
  })

  test("a started orientation's thread opens; a refused start opens none (live check L1)", () => {
    expect(startedChat({ agentId: 'a1', chat: 'c1', request: 'r' })).toBe('c1')
    expect(startedChat({ kind: 'hook', reason: 'An orientation is already running.' })).toBeNull()
    expect(startedChat({ program: 'ext' })).toBeNull()
    expect(startedChat(null)).toBeNull()
  })

  test("New orientation opens the gate in main though one ran, unless main is not shown or Start was pressed", () => {
    const base = { main: true, skipped: true, started: false, loading: false, error: null, orientation: 'done', orientChats: 1 }
    expect(startGateShown(base)).toBe(false)
    expect(startGateShown({ ...base, again: true })).toBe(true)
    expect(startGateShown({ ...base, again: true, started: true })).toBe(false)
    expect(startGateShown({ ...base, again: true, main: false })).toBe(false)
  })

  test('while the product tour runs main draws no gate, so its example is the only Start card and no other step shows one', () => {
    const open = { main: true, skipped: false, started: false, loading: false, error: null, orientation: null, orientChats: 0 }
    expect(startGateShown(open)).toBe(true)
    expect(startGateShown({ ...open, tour: true })).toBe(false)
    expect(startGateShown({ ...open, orientation: 'refused', orientChats: 1, tour: true })).toBe(false)
    expect(startGateShown({ ...open, again: true, tour: true })).toBe(false)
  })

  test("the body leaves out what is not known, and the modules-off line says what to change", () => {
    expect(startBody(DEFAULT_ON, '  ')).toEqual({ deck: true, views: true, critique: false, report: true })
    expect(startBlocked({ module: true })).toBeNull()
    expect(startBlocked({})).toBeNull()
    expect(noModuleLine('your organization\'s managed settings set disableAllHooks')).toContain("Ask whoever manages your Claude Code settings")
    // live check L29: the launcher's own --settings, or the analyst's settings files, are the analyst's to change
    expect(noModuleLine('your --settings set disableAllHooks')).toContain('Leave disableAllHooks out of the --settings you give `thimble`')
    expect(noModuleLine('your Claude Code settings set disableAllHooks')).toContain('Turn disableAllHooks off in your Claude Code settings')
    expect(noModuleLine('')).toContain("Claude Code did not load thimble's hooks module")
  })
})
