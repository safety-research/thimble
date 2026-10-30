// A sandboxed frame's picture of itself, for the picture a ⌘-click takes of the element around it (pointer/capture.ts
// capturePng). The page cannot read a frame's document, whose origin is its own, so html-to-image draws a frame as an
// empty box: a card whose body is a frame (a custom card, a scripted output) came out blank. A frame that carries the
// frame half (shotScript, in its head) and is marked `data-shot` gives its picture instead, as html-to-image draws the
// page: its document as an SVG image, its canvases as pictures of themselves, without its scripts, which a picture never
// runs. A picture loads nothing by URL, and the frame cannot read an image it loads by URL (its origin is its own), so
// the frame names each such image by the page's token and its number, and the page puts the image in, fetched as the
// frame fetched it (same origin, no cookie), before it draws the picture. The SVG image is as large as the frame in CSS
// pixels, since the page in it is laid out for the image's size (its vw and vh units, its width media queries); the
// page draws it at the screen's device pixels.
//   shot {id, token}      page to frame: the picture of what the frame shows
//   shot {id, svg, urls}  frame to page: the picture as an SVG image, or null when it could not be made, and the URL of
//                         each image it names `token` and its number

const SHOT = 'thimble:shot'
/** How long a frame has to give its picture, drawn: less than the picture's own limit (pointer/capture.ts
 * CAPTURE_WAIT_MS), so a frame that does not answer leaves its box empty, as before, and the rest of the picture is still
 * sent. */
export const FRAME_SHOT_MS = 2000

/** The frame half (module note). It reads nothing outside its own body, since shotScript writes its source into the
 * frame. */
export function frameShot(): void {
  const type = 'thimble:shot'
  addEventListener('message', (e) => {
    const d = e.data
    if (e.source !== parent || !d || d.type !== type) return
    const answer = (svg: string | null, urls: string[] = []) => {
      try {
        parent.postMessage({ type, id: d.id, svg, urls }, '*')
      } catch {
        // the page is gone
      }
    }
    try {
      const root = document.documentElement
      const w = root.clientWidth
      const h = innerHeight
      if (w < 1 || h < 1) return answer(null)
      const copy = root.cloneNode(true) as HTMLElement
      for (const s of Array.from(copy.querySelectorAll('script'))) s.remove()
      // an image loaded by URL is named by the page's token and its number, for the page to put in (module note)
      const urls: string[] = []
      const images = root.querySelectorAll('img')
      Array.from(copy.querySelectorAll('img')).forEach((img, i) => {
        const src = images[i]?.currentSrc
        if (!src || src.startsWith('data:') || typeof d.token !== 'string') return
        if (!urls.includes(src)) urls.push(src)
        img.removeAttribute('srcset')
        img.setAttribute('src', d.token + urls.indexOf(src))
      })
      for (const s of Array.from(copy.querySelectorAll('picture > source'))) s.remove()
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
      // as large as the frame, for the page's layout (module note)
      answer(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><foreignObject x="0" y="0" width="${w}" height="${h}">${xml}</foreignObject></svg>`, urls)
    } catch {
      answer(null)
    }
  })
}

/** The frame half as a script for the frame's head (module note). */
export const shotScript = (): string => `<script>(${frameShot.toString().replace(/<\/script/gi, '<\\/script')})()</script>`

/** The image at `url` as a data URL, fetched as the frame fetched it: from the page's own origin, without its cookie; ''
 * when it is not an image of the page's origin. */
async function inlined(url: string): Promise<string> {
  try {
    if (new URL(url, location.href).origin !== location.origin) return ''
    const blob = await (await fetch(url, { credentials: 'omit' })).blob()
    const type = blob.type.split(';')[0].trim()
    if (!/^image\/[\w.+-]+$/.test(type)) return ''
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return `data:${type};base64,${btoa(bin)}`
  } catch {
    return ''
  }
}

/** The frame's picture `svg` drawn as a PNG at `scale` device pixels per CSS pixel, with the images it names by `token`
 * put in (module note); null when it cannot be drawn. */
async function drawn(svg: string, token: string, urls: readonly string[], scale: number): Promise<string | null> {
  const images = await Promise.all(urls.map(inlined))
  const pic = new Image()
  pic.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace(new RegExp(`${token}(\\d+)`, 'g'), (_, n: string) => images[Number(n)] ?? ''))}`
  try {
    await pic.decode()
    const c = document.createElement('canvas')
    c.width = pic.naturalWidth * scale
    c.height = pic.naturalHeight * scale
    c.getContext('2d')!.drawImage(pic, 0, 0, c.width, c.height)
    return c.toDataURL('image/png')
  } catch {
    return null
  }
}

let asked = 0

/** The picture the frame gives of itself at `scale` (module note), drawn as a PNG, or null when it says it cannot, or it
 * is not drawn within `ms`. */
export function framePicture(frame: HTMLIFrameElement, scale: number, ms = FRAME_SHOT_MS): Promise<string | null> {
  const win = frame.contentWindow
  if (!win) return Promise.resolve(null)
  const id = ++asked
  const token = `thimble-shot-${id}-${Math.random().toString(36).slice(2)}-`
  return new Promise((resolve) => {
    const done = (png: string | null) => {
      window.removeEventListener('message', onMessage)
      window.clearTimeout(late)
      resolve(png)
    }
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: unknown; id?: unknown; svg?: unknown; urls?: unknown } | null
      if (e.source !== win || !d || d.type !== SHOT || d.id !== id) return
      window.removeEventListener('message', onMessage)
      if (typeof d.svg !== 'string') return done(null)
      void drawn(d.svg, token, Array.isArray(d.urls) ? d.urls.map(String) : [], Math.min(4, Math.max(1, scale))).then(done)
    }
    const late = window.setTimeout(() => done(null), ms)
    window.addEventListener('message', onMessage)
    win.postMessage({ type: SHOT, id, token }, '*')
  })
}
