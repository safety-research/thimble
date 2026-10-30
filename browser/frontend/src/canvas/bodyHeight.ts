// The size a card's body draws at its width, which the card harness (render.tsx) gives the server with each picture,
// so a card whose body draws taller than the canvas shows at rest (DataViz CARD_BODY_MAX), or whose content lays out
// wider than its room, waits for the card check before the analyst sees it (backend card_fit, card_size).

/** The body of `card` (an article.canvas-card) as laid out, px, whole: each custom card's page whole (its frame's
 * `data-height`, DataViz CustomFrame) in place of the part shown before Show all, with what its own scroll boxes hold
 * past their height (bodyInner), and each table's rows past the ones it shows first, at the height of the rows it shows:
 * the rows hidden behind Show all (components/Outputs, its `tbody tr` hidden) and the rows pandas left out of a
 * DataFrame's html (leftOut); 0 for a card with no body. */
export function bodyHeight(card: HTMLElement): number {
  const body = card.querySelector<HTMLElement>('.bcell-body')
  if (!body) return 0
  let h = body.getBoundingClientRect().height + bodyInner(card)
  for (const f of Array.from(body.querySelectorAll<HTMLElement>('[data-height]'))) {
    const whole = Number(f.dataset.height)
    const shown = f.querySelector('iframe')?.getBoundingClientRect().height ?? 0
    if (Number.isFinite(whole) && whole > shown) h += whole - shown
  }
  for (const table of Array.from(body.querySelectorAll<HTMLElement>('.outputs-html'))) {
    const rows = Array.from(table.querySelectorAll<HTMLTableRowElement>('tbody tr'))
    const shown = rows.filter((r) => !r.hidden)
    const past = rows.length - shown.length + leftOut(table, rows)
    if (!shown.length || !past) continue
    h += past * (shown.reduce((sum, r) => sum + r.getBoundingClientRect().height, 0) / shown.length)
  }
  return Math.round(h)
}

// the line pandas puts under a DataFrame's html when it shows only its first and last rows, with a row of `...` between
const PANDAS_ROWS = /^([\d,]+) rows × \d+ columns$/

/** The rows pandas left out of the html of a DataFrame in `table` (components/Outputs' html), whose `rows` show its first
 * and last rows and a row of `...` between them, with `N rows × M columns` under them; 0 when it left none out. */
function leftOut(table: HTMLElement, rows: HTMLTableRowElement[]): number {
  const line = Array.from(table.querySelectorAll('p'), (p) => PANDAS_ROWS.exec((p.textContent ?? '').trim())).find(Boolean)
  if (!line) return 0
  const records = rows.filter((r) => !Array.from(r.cells).every((c) => (c.textContent ?? '').trim() === '...'))
  return Math.max(0, Number(line[1].replace(/,/g, '')) - records.length)
}

/** What the custom pages of `card`'s body hold in scroll boxes of their own past those boxes' height, px (their frames'
 * `data-inner-height`, DataViz CustomFrame); 0 when none does. */
export function bodyInner(card: HTMLElement): number {
  const body = card.querySelector<HTMLElement>('.bcell-body')
  if (!body) return 0
  return Math.round(Array.from(body.querySelectorAll<HTMLElement>('[data-inner-height]')).reduce((sum, f) => sum + (Number(f.dataset.innerHeight) || 0), 0))
}

/** The widest content of `card`'s body that lays out wider than its room, as {width, frame} in px: a custom card's page
 * wider than its frame (its frame's `data-page-width` and `data-frame-width`, DataViz CustomFrame) or a table wider than
 * the card (components/Outputs, which scrolls it sideways); null when everything fits its room. */
export function bodyWidth(card: HTMLElement): { width: number; frame: number } | null {
  const body = card.querySelector<HTMLElement>('.bcell-body')
  if (!body) return null
  const sizes = [
    ...Array.from(body.querySelectorAll<HTMLElement>('[data-page-width]'), (f) => ({ width: Number(f.dataset.pageWidth), frame: Number(f.dataset.frameWidth) })),
    ...Array.from(body.querySelectorAll<HTMLElement>('.outputs-html'), (t) => ({ width: t.scrollWidth, frame: t.clientWidth })),
  ].filter((s) => Number.isFinite(s.width) && Number.isFinite(s.frame) && s.frame > 0 && s.width > s.frame + 1)
  if (!sizes.length) return null
  const widest = sizes.reduce((a, b) => (b.width / b.frame > a.width / a.frame ? b : a))
  return { width: Math.round(widest.width), frame: Math.round(widest.frame) }
}
