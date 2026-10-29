// A sandboxed frame's picture of itself, for the picture a ⌘-click takes of the element around it (pointer/capture.ts
// capturePng). The page cannot read a frame's document, whose origin is its own, so html-to-image draws a frame as an
// empty box: a card whose body is a frame (a custom card, a scripted output) came out blank. A frame that carries the
// frame half (shotScript, in its head) and is marked `data-shot` draws itself instead, as html-to-image draws the page:
// its document as an SVG image, its canvases as pictures of themselves, without its scripts, which a picture never runs.
//   shot {id, scale}   page to frame: draw what the frame shows, at `scale` device pixels per CSS pixel
//   shot {id, png}     frame to page: the picture as a PNG data URL, or null when it could not be drawn

const SHOT = 'thimble:shot'
/** How long a frame has to answer: less than the picture's own limit (pointer/capture.ts CAPTURE_WAIT_MS), so a frame
 * that does not answer leaves its box empty, as before, and the rest of the picture is still sent. */
export const FRAME_SHOT_MS = 2000

/** The frame half (module note). It reads nothing outside its own body, since shotScript writes its source into the
 * frame. */
export function frameShot(): void {
  const type = 'thimble:shot'
  addEventListener('message', (e) => {
    const d = e.data
    if (e.source !== parent || !d || d.type !== type) return
    const answer = (png: string | null) => {
      try {
        parent.postMessage({ type, id: d.id, png }, '*')
      } catch {
        // the page is gone
      }
    }
    try {
      const root = document.documentElement
      const w = root.clientWidth
      const h = innerHeight
      const k = Math.min(4, Math.max(1, Number(d.scale) || 1))
      if (w < 1 || h < 1) return answer(null)
      const copy = root.cloneNode(true) as HTMLElement
      for (const s of Array.from(copy.querySelectorAll('script'))) s.remove()
      // a canvas's drawing is not in its markup: it goes in as a picture of itself, as large as it shows
      const live = root.querySelectorAll('canvas')
      Array.from(copy.querySelectorAll('canvas')).forEach((c, i) => {
        const img = document.createElement('img')
        for (const a of Array.from(c.attributes)) img.setAttribute(a.name, a.value)
        try {
          img.setAttribute('src', live[i].toDataURL())
        } catch {
          // a canvas that cannot be read stays empty
        }
        img.style.boxSizing = 'border-box'
        img.style.width = `${live[i].offsetWidth}px`
        img.style.height = `${live[i].offsetHeight}px`
        c.replaceWith(img)
      })
      // a field shows what was typed in it, which its markup does not hold
      const fields = root.querySelectorAll('input, textarea, select')
      Array.from(copy.querySelectorAll('input, textarea, select')).forEach((f, i) => {
        const now = fields[i]
        if (f instanceof HTMLSelectElement && now instanceof HTMLSelectElement) Array.from(f.options).forEach((o, n) => o.toggleAttribute('selected', !!now.options[n]?.selected))
        else if (f instanceof HTMLTextAreaElement && now instanceof HTMLTextAreaElement) f.textContent = now.value
        else if (f instanceof HTMLInputElement && now instanceof HTMLInputElement) {
          if (now.type === 'checkbox' || now.type === 'radio') f.toggleAttribute('checked', now.checked)
          else f.setAttribute('value', now.value)
        }
      })
      // the part of the page the frame shows, when it has scrolled
      if (scrollX || scrollY) copy.style.transform = `translate(${-scrollX}px, ${-scrollY}px)`
      const xml = new XMLSerializer().serializeToString(copy)
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w * k}" height="${h * k}" viewBox="0 0 ${w} ${h}"><foreignObject x="0" y="0" width="${w}" height="${h}">${xml}</foreignObject></svg>`
      const pic = new Image()
      pic.onload = () => {
        try {
          const c = document.createElement('canvas')
          c.width = Math.round(w * k)
          c.height = Math.round(h * k)
          c.getContext('2d')!.drawImage(pic, 0, 0, c.width, c.height)
          answer(c.toDataURL('image/png'))
        } catch {
          answer(null)
        }
      }
      pic.onerror = () => answer(null)
      pic.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    } catch {
      answer(null)
    }
  })
}

/** The frame half as a script for the frame's head (module note). */
export const shotScript = (): string => `<script>(${frameShot.toString().replace(/<\/script/gi, '<\\/script')})()</script>`

let asked = 0

/** The picture the frame draws of itself at `scale` (module note), or null when it says it cannot, or does not answer
 * within `ms`. */
export function framePicture(frame: HTMLIFrameElement, scale: number, ms = FRAME_SHOT_MS): Promise<string | null> {
  const win = frame.contentWindow
  if (!win) return Promise.resolve(null)
  const id = ++asked
  return new Promise((resolve) => {
    const done = (png: string | null) => {
      window.removeEventListener('message', onMessage)
      window.clearTimeout(late)
      resolve(png)
    }
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: unknown; id?: unknown; png?: unknown } | null
      if (e.source !== win || !d || d.type !== SHOT || d.id !== id) return
      done(typeof d.png === 'string' && d.png.startsWith('data:image/png;base64,') ? d.png : null)
    }
    const late = window.setTimeout(() => done(null), ms)
    window.addEventListener('message', onMessage)
    win.postMessage({ type: SHOT, id, scale }, '*')
  })
}
