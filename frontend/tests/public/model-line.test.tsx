// @vitest-environment jsdom
// The model line at a composer's foot (src/chat/ModelLine.tsx), main's, the Start card's and a role's (RoleChip): the
// model is text with its tip on hover where it cannot change here, a menu of the models on offer where it can, each
// model once; the effort menu lists the efforts alone; fast mode is a bolt beside the effort, which switches where the
// session can and otherwise shows its state with the reason in its tip. The Start card shows the orientation role's
// values and saves a pick to it, so it and the settings popover agree. The server is a stand-in fetch.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { FAST_TIP, MODEL_TIP, ModelLine, ORIENT_MODEL_TIP } from '../../src/chat/ModelLine.tsx'
import { RoleChip } from '../../src/chat/RoleChip.tsx'
import { StartGate } from '../../src/chat/StartGate.tsx'
import { baseModel, invalidateSettings, modelChoices, modelLabel, sameModel } from '../../src/lib/models.ts'
import type { ModelConf } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const puts: unknown[] = []
let served: Record<string, ModelConf> = {}

beforeEach(() => {
  puts.length = 0
  served = { orient: { model: 'claude-opus-5-5[1m]', effort: 'xhigh', fast: true }, dev: { model: 'claude-sonnet-5', effort: 'high', fast: false } }
  invalidateSettings('mini')
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body ?? '{}')) as { models: Record<string, Partial<ModelConf>> }
      puts.push(body)
      for (const [role, conf] of Object.entries(body.models ?? {})) served = { ...served, [role]: { ...served[role], ...conf } }
    }
    if (String(url).endsWith('/api/ws/mini/settings')) return json({ models: served })
    return json({})
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const menuLabels = () => Array.from(document.querySelectorAll('.popover .menu-item .menu-item-label')).map((e) => e.textContent)
const bolt = (root: ParentNode = document) => root.querySelector<HTMLButtonElement>('.fast-bolt')!

describe('models are named once', () => {
  test('a tag is left out of the name and the menus', () => {
    expect(baseModel('claude-opus-5-5[1m]')).toBe('claude-opus-5-5')
    expect(modelLabel('claude-opus-5-5[1m]')).toBe('Opus 5.5')
    expect(sameModel('claude-opus-5-5[1m]', 'claude-opus-5-5')).toBe(true)
    expect(sameModel('', '')).toBe(false)
    const choices = modelChoices({ models: { orient: { model: 'claude-opus-5-5[1m]', effort: 'xhigh', fast: true } } }, 'claude-opus-5-5')
    expect(choices.filter((m) => baseModel(m) === 'claude-opus-5-5')).toEqual(['claude-opus-5-5'])
    expect(choices.some((m) => m.includes('['))).toBe(false)
  })
})

describe("main's line", () => {
  test('the model is text whose tip shows on hover only; the menu lists the efforts alone', async () => {
    vi.useFakeTimers()
    const picked: string[] = []
    await mount(<ModelLine model="claude-opus-5-5" modelTip={MODEL_TIP} effort="medium" onEffort={(e) => picked.push(e)} fast={false} fastTip={FAST_TIP} label="main" />)
    const name = document.querySelector<HTMLElement>('.model-line-model')!
    expect(name.tagName).toBe('SPAN')
    expect(name.textContent).toBe('Opus 5.5')
    expect(document.querySelector('.tip')).toBeNull()
    // React hears a pointer's entering and leaving from pointerover and pointerout
    await act(async () => {
      name.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, relatedTarget: document.body }))
      vi.advanceTimersByTime(400)
    })
    expect(document.querySelector('.tip')?.textContent).toBe(MODEL_TIP)
    await act(async () => name.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body })))
    expect(document.querySelector('.tip')).toBeNull()
    vi.useRealTimers()
    await act(async () => document.querySelector<HTMLButtonElement>('.model-line-effort')!.click())
    expect(menuLabels()).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    await act(async () => document.querySelector<HTMLButtonElement>('.popover .menu-item[data-item="max"]')!.click())
    expect(picked).toEqual(['max'])
  })

  test('the bolt switches fast mode where the session can, else shows its state with where it changes', async () => {
    const turned: boolean[] = []
    const on = await mount(<ModelLine model="claude-opus-5-5" effort="high" onEffort={() => {}} fast onFast={(v) => turned.push(v)} fastTip={FAST_TIP} label="main" />)
    expect(bolt(on).getAttribute('aria-pressed')).toBe('true')
    expect(bolt(on).getAttribute('aria-disabled')).toBeNull()
    await act(async () => bolt(on).click())
    expect(turned).toEqual([false])
    const off = await mount(<ModelLine model="claude-opus-5-5" effort="high" onEffort={() => {}} fast={false} fastTip={FAST_TIP} label="main" />)
    expect(bolt(off).getAttribute('aria-pressed')).toBe('false')
    expect(bolt(off).getAttribute('aria-disabled')).toBe('true')
    expect(bolt(off).getAttribute('aria-label')).toBe('Fast mode for main')
    const sonnet = await mount(<ModelLine model="claude-sonnet-5" effort="high" onEffort={() => {}} fast={false} onFast={(v) => turned.push(v)} label="main" />)
    expect(bolt(sonnet).getAttribute('aria-disabled'), 'a model without fast mode').toBe('true')
    await act(async () => bolt(sonnet).click())
    expect(turned).toEqual([false])
  })
})

describe("a role's line", () => {
  test('the model is a menu of each model once, a pick saves only what changed', async () => {
    await mount(<RoleChip ws="mini" role="orient" label="the orientation" />)
    await settle()
    expect(document.querySelector('.model-line-part')!.textContent).toBe('Opus 5.5')
    await act(async () => document.querySelector<HTMLButtonElement>('.model-line-part')!.click())
    const labels = menuLabels()
    expect(labels.filter((l) => l === 'Opus 5.5')).toHaveLength(1)
    expect(labels).not.toContain('low')
    await act(async () => document.querySelector<HTMLButtonElement>('.popover .menu-item.checked')!.click())
    await settle()
    expect(puts, 'the model it runs already: nothing to save').toEqual([])
    await act(async () => document.querySelector<HTMLButtonElement>('.model-line-effort')!.click())
    expect(menuLabels()).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    await act(async () => document.querySelector<HTMLButtonElement>('.popover .menu-item[data-item="max"]')!.click())
    await settle()
    expect(puts).toEqual([{ models: { orient: { effort: 'max' } } }])
    await act(async () => bolt().click())
    await settle()
    expect(puts[1]).toEqual({ models: { orient: { fast: false } } })
  })
})

describe('the Start card', () => {
  test("shows the orientation role's model, effort and fast mode, and saves a pick to the role", async () => {
    const saved: string[] = []
    await mount(<StartGate ws="mini" model="claude-opus-5-5[1m]" defaultEffort="xhigh" fast onEffort={(e) => saved.push(e)} onFast={() => {}} />)
    const line = document.querySelector<HTMLElement>('.chat-gate-meta .model-line')!
    expect(line.querySelector('.model-line-model')!.textContent).toBe('Opus 5.5')
    expect(line.querySelector('.model-line-effort')!.textContent).toBe('xhigh')
    expect(bolt(line).getAttribute('aria-pressed')).toBe('true')
    expect(ORIENT_MODEL_TIP).toMatch(/Settings/)
    await act(async () => line.querySelector<HTMLButtonElement>('.model-line-effort')!.click())
    expect(menuLabels()).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    await act(async () => document.querySelector<HTMLButtonElement>('.popover .menu-item[data-item="ultracode"]')!.click())
    expect(saved).toEqual(['ultracode'])
    expect(line.querySelector('.model-line-effort')!.textContent).toBe('ultracode')
  })
})
