// @vitest-environment jsdom
// The Report bar's primary action (src/report/WriteAction.tsx): Write on a document not written yet asks at once;
// Revise on a written one asks first, and only Revise in its sheet starts the writer. While a writer runs, Stop beside
// Writing stops it with the call Stop in the writer's thread makes.
import { act } from 'react'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { WriteAction } from '../../src/report/WriteAction.tsx'
import { mount, unmountAll } from './mount.tsx'

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
})
