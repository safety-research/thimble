// The page of harness-parity.test.ts: the card harness's page (src/render.tsx, which installs window.__thimbleRender)
// and, beside it, a card mounted the way the canvas mounts it (CellCard inside the board's stage, at rest), so the test
// can draw one card both ways at the same place and compare them.
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import '../../../src/render'
import { ChipContext } from '../../../src/chat/markdown'
import { CARD_PAD_X, CellCard } from '../../../src/canvas/Cell'
import { CanvasContext, type CanvasCtx } from '../../../src/canvas/context'
import { registerCells } from '../../../src/lib/cellName'
import type { Cell } from '../../../src/lib/types'

declare global {
  interface Window {
    __parity: { mountCanvas: typeof mountCanvas; unmountCanvas: typeof unmountCanvas; pixels: typeof pixels; padX: number }
  }
}

let root: Root | null = null
let host: HTMLDivElement | null = null
const noop = () => undefined

/** The card as the board draws it at rest, at (16, 16) where the harness draws its own; returns its box once it
 * settled. The harness's stage is hidden meanwhile. */
async function mountCanvas(card: Cell, width: number, names: { id: string; title: string }[]) {
  unmountCanvas()
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('.render-stage'))) el.style.visibility = 'hidden'
  registerCells(names)
  history.replaceState(null, '', `?ws=canvas-${Date.now()}`)
  host = document.createElement('div')
  host.className = 'board-stage'
  host.style.cssText = 'position:absolute;left:0;top:0;overflow:visible;display:block;flex:none;min-width:100%;height:4000px'
  document.body.appendChild(host)
  const ctx: CanvasCtx = { ws: 'canvas', filters: null, keep: null, concepts: new Map(), threadOf: () => ({ chatId: null, name: '', writable: false }), unread: new Set(), refresh: noop, openThread: noop }
  root = createRoot(host)
  flushSync(() =>
    root!.render(
      <CanvasContext.Provider value={ctx}>
        <ChipContext.Provider value={{ workspace: 'canvas', broken: new Set(), anchor: true }}>
          <CellCard cell={card} x={16} y={16} w={width} h={null} selected={false} alone={false} collapsed={false} deck={false} dragging={false} detailOpen={false} editing={null} z={1} register={noop} onPress={noop} onFocusMode={noop} onResizeStart={noop} onAction={noop} onEdit={noop} />
        </ChipContext.Provider>
      </CanvasContext.Provider>,
    ),
  )
  const article = host.querySelector<HTMLElement>('article.canvas-card')!
  await window.__thimbleRender.settled(article)
  const r = article.getBoundingClientRect()
  return { box: { x: r.left, y: r.top, width: r.width, height: r.height } }
}

function unmountCanvas() {
  root?.unmount()
  host?.remove()
  root = null
  host = null
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('.render-stage'))) el.style.visibility = ''
}

/** The share of pixels that differ between two PNGs of the same size (a channel apart by more than `tol`), or -1 when
 * their sizes differ. */
async function pixels(a64: string, b64: string, tol = 24): Promise<number> {
  const load = async (b: string) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b}`)).blob())
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    const g = c.getContext('2d')!
    g.drawImage(bmp, 0, 0)
    return g.getImageData(0, 0, bmp.width, bmp.height)
  }
  const [a, b] = await Promise.all([load(a64), load(b64)])
  if (a.width !== b.width || a.height !== b.height) return -1
  let off = 0
  for (let i = 0; i < a.data.length; i += 4) {
    if (Math.abs(a.data[i] - b.data[i]) > tol || Math.abs(a.data[i + 1] - b.data[i + 1]) > tol || Math.abs(a.data[i + 2] - b.data[i + 2]) > tol) off++
  }
  return off / (a.width * a.height)
}

window.__parity = { mountCanvas, unmountCanvas, pixels, padX: CARD_PAD_X }
