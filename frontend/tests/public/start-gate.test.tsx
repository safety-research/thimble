// @vitest-environment jsdom
// The Start gate (src/chat/StartGate.tsx): the orientation's request, start_orientation's four switches, and the run's
// model and effort, which open at Settings' orientation row and apply to this run only; no fast mode, Ultracode or
// permission switcher, since the orientation runs as a subagent of main in main's mode, which one line names. Start is
// a click to its own route with the switches, model and effort and no mode. Start is off, with the line saying why,
// while thimble's hooks module is not in main's session or main is in plan mode; a refused start fills the gate again.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DEFAULT_ON, PLAN_MODE_LINE, StartGate, modeLine, noModuleLine, restoreOf, startBlocked, startBody, startGateOpen } from '../../src/chat/StartGate.tsx'
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
  test("opens at Settings' model and effort, with Claude Code's levels and no fast mode, Ultracode or mode switcher", async () => {
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
    expect(el.querySelector('.chat-gate-mode')?.textContent).toBe('Runs as a subagent of your Claude Code session, in auto mode.')
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

  test("without thimble's module, or in plan mode, Start is off and the line says why", async () => {
    const off = await mount(<StartGate ws="mini" model="claude-opus-5-5" effort="high" main={{ module: false, module_why: 'THIMBLE_NO_MODULE is set' }} />)
    await settle()
    expect(startButton(off).disabled).toBe(true)
    const line = off.querySelector('.chat-gate-mode')!.textContent!
    expect(line).toContain("thimble's agents can't start in this session: Claude Code's hooks modules are off (THIMBLE_NO_MODULE is set)")
    expect(line).toContain('Unset THIMBLE_NO_MODULE, then run `thimble -c`.')
    await click(startButton(off))
    expect(sent).toEqual([])
    const plan = await mount(<StartGate ws="mini" model="claude-opus-5-5" effort="high" main={{ attached: { session: 's', cwd: '/c', since: '', permission_mode: 'plan' } }} />)
    expect(startButton(plan).disabled).toBe(true)
    expect(plan.querySelector('.chat-gate-mode')!.textContent).toBe(PLAN_MODE_LINE)
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
})

describe('its rules', () => {
  test('the gate opens before any orientation and again after a refused one', () => {
    expect(startGateOpen(null, 0)).toBe(true)
    expect(startGateOpen('running', 1)).toBe(false)
    expect(startGateOpen('refused', 1)).toBe(true)
    expect(startGateOpen('starting', 0)).toBe(false)
  })

  test("the body leaves out what is not known, and the mode line names Claude Code's modes", () => {
    expect(startBody(DEFAULT_ON, '  ')).toEqual({ deck: true, views: true, critique: false, report: true })
    expect(modeLine('default')).toBe('Runs as a subagent of your Claude Code session, in default mode.')
    expect(modeLine(undefined)).toBe('Runs as a subagent of your Claude Code session, in its permission mode.')
    expect(startBlocked({ module: true })).toBeNull()
    expect(startBlocked({})).toBeNull()
    expect(noModuleLine('your organization\'s managed settings set disableAllHooks')).toContain("Ask whoever manages your Claude Code settings")
    expect(noModuleLine('')).toContain("Claude Code did not load thimble's hooks module")
  })
})
