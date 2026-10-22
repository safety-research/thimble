// @vitest-environment jsdom
// The Report bar's primary action (src/report/WriteAction.tsx): Write on a document not written yet asks at once;
// Revise on a written one asks first, and only Revise in its sheet starts the writer. While a writer runs, Stop beside
// Writing stops it with the call Stop in the writer's thread makes.
import { act } from 'react'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { api } from '../../src/lib/api'
import { bus } from '../../src/lib/bus'
import { StopWriter, WriteAction } from '../../src/report/WriteAction.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

beforeAll(() => {
  // the sheet places itself as it resizes; jsdom has no ResizeObserver
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
})

const sheetButton = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('.wu-revise button')].find((b) => b.textContent?.trim() === text)
const click = async (b: HTMLElement | undefined) => {
  expect(b).toBeTruthy()
  await act(async () => b!.click())
}

describe("the Report bar's Write and Revise", () => {
  test('Write on a document not written yet asks for it on one click', async () => {
    const onWrite = vi.fn()
    const el = await mount(<WriteAction name="report" written={false} busy={false} onWrite={onWrite} />)
    await click(el.querySelector<HTMLButtonElement>('button.btn-primary')!)
    expect(onWrite).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.wu-revise')).toBeNull()
  })

  test('Revise asks first: Cancel starts nothing, Revise in the sheet starts the writer', async () => {
    const onWrite = vi.fn()
    const el = await mount(<WriteAction name="report" written busy={false} history onWrite={onWrite} />)
    const revise = el.querySelector<HTMLButtonElement>('button.btn-primary')!
    expect(revise.textContent).toBe('Revise')
    await click(revise)
    expect(onWrite).not.toHaveBeenCalled()
    expect(document.querySelector('.wu-revise')?.textContent).toContain('Revise the report?')
    await click(sheetButton('Cancel'))
    expect(document.querySelector('.wu-revise')).toBeNull()
    expect(onWrite).not.toHaveBeenCalled()
    await click(revise)
    await click(sheetButton('Revise'))
    expect(onWrite).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.wu-revise')).toBeNull()
  })

  test('while a writer works the button reads Writing and opens nothing', async () => {
    const onWrite = vi.fn()
    const el = await mount(<WriteAction name="report" written busy onWrite={onWrite} />)
    const b = el.querySelector<HTMLButtonElement>('button.btn-primary')!
    expect(b.textContent).toBe('Writing')
    expect(b.disabled).toBe(true)
    expect(document.querySelector('.wu-revise')).toBeNull()
  })
})

describe("Stop beside Writing", () => {
  test("interrupts the writer's chat, as Stop in its thread does, and stays busy while it ends", async () => {
    const interrupt = vi.spyOn(api, 'interrupt').mockResolvedValue({ stopped: true })
    const el = await mount(<StopWriter ws="w-stop" chat="writer-1" />)
    const b = el.querySelector<HTMLButtonElement>('button.wu-stop')!
    expect(b.textContent).toBe('Stop')
    await act(async () => b.click())
    await settle()
    expect(interrupt).toHaveBeenCalledWith('w-stop', 'writer-1')
    expect(b.disabled).toBe(true)
  })

  test('a Stop that failed says why and can be pressed again', async () => {
    vi.spyOn(api, 'interrupt').mockRejectedValue(new Error('the server is gone'))
    const toasts: string[] = []
    const off = bus.on('toast', (t) => void toasts.push(t.text))
    const el = await mount(<StopWriter ws="w-stop" chat="writer-1" />)
    const b = el.querySelector<HTMLButtonElement>('button.wu-stop')!
    await act(async () => b.click())
    await settle()
    off()
    expect(toasts.join(' ')).toContain('the server is gone')
    expect(b.disabled).toBe(false)
  })
})
