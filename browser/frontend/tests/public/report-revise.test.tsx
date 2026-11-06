// @vitest-environment jsdom
// The Report bar's primary action (src/report/WriteAction.tsx): Write on a document not written yet asks at once;
// Revise on a written one asks first, and only Revise in its sheet starts the writer.
import { act } from 'react'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
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

test('Write on a document not written yet asks for it on one click; Revise on a written one asks first', async () => {
  const onWrite = vi.fn()
  const write = await mount(<WriteAction name="report" written={false} busy={false} onWrite={onWrite} />)
  await click(write.querySelector<HTMLButtonElement>('button.btn-primary')!)
  expect(onWrite).toHaveBeenCalledTimes(1)
  expect(document.querySelector('.wu-revise')).toBeNull()
  unmountAll()

  const el = await mount(<WriteAction name="report" written busy={false} history onWrite={onWrite} />)
  const revise = el.querySelector<HTMLButtonElement>('button.btn-primary')!
  expect(revise.textContent).toBe('Revise')
  await click(revise)
  expect(onWrite).toHaveBeenCalledTimes(1)
  await click(sheetButton('Cancel'))
  expect(document.querySelector('.wu-revise')).toBeNull()
  expect(onWrite).toHaveBeenCalledTimes(1)
  await click(revise)
  await click(sheetButton('Revise'))
  expect(onWrite).toHaveBeenCalledTimes(2)
  expect(document.querySelector('.wu-revise')).toBeNull()
})
