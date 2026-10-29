// The height a card's body draws at its width, which the card harness (render.tsx) gives the server with each picture,
// so a card whose body draws taller than the canvas shows at rest (DataViz CARD_BODY_MAX) is told to its author
// (backend card_size).

/** The body of `card` (an article.canvas-card) as laid out, px, with each custom card's page whole (its frame's
 * `data-height`, DataViz CustomFrame) in place of the part shown before Show all; 0 for a card with no body. */
export function bodyHeight(card: HTMLElement): number {
  const body = card.querySelector<HTMLElement>('.bcell-body')
  if (!body) return 0
  let h = body.getBoundingClientRect().height
  for (const f of Array.from(body.querySelectorAll<HTMLElement>('[data-height]'))) {
    const whole = Number(f.dataset.height)
    const shown = f.querySelector('iframe')?.getBoundingClientRect().height ?? 0
    if (Number.isFinite(whole) && whole > shown) h += whole - shown
  }
  return Math.round(h)
}
