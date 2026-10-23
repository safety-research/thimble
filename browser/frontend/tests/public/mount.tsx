// Mounting a component under jsdom for a test: React's act() flushes the render and its effects before the test reads
// the DOM. A test file that uses this names the jsdom environment in its first line.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

/** `node` rendered into a fresh element of the document; the element. */
export async function mount(node: ReactNode): Promise<HTMLElement> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  roots.push(root)
  await act(async () => root.render(node))
  return el
}

/** Every mounted tree unmounted and removed, for an afterEach. */
export function unmountAll(): void {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ''
}

/** Let pending promises and effects settle inside act(). */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}
