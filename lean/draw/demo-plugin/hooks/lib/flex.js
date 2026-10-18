// flex.js: how `beside` shares a width among its children, for both renderers (cells in the terminal, pixels in
// the browser). Each child says its smallest width (min), the width it would like (nat), how much of any spare width
// it takes (grow) and, when the program fixed it, its width (fixed).
//
// 1. Every child starts at its natural width (a fixed child at its fixed width).
// 2. When they don't fit, children that can shrink (nat > min, not fixed) give up width in proportion to how much
//    they can give, down to their min. Text shrinks by wrapping onto more lines.
// 3. When there is width to spare, children that grow share it in proportion to grow.
// With `cells` the widths are whole numbers that add up exactly; otherwise they are pixels.

/**
 * @param {{min: number, nat: number, grow: number, fixed?: number}[]} items
 * @param {number} avail the width to share, gaps included
 * @param {number} gap between neighbors
 * @param {boolean} cells whole-number widths
 * @returns {number[]} widths
 */
export function distribute(items, avail, gap, cells) {
  const n = items.length
  if (!n) return []
  const room = Math.max(0, avail - gap * (n - 1))
  const w = items.map(it => it.fixed != null ? it.fixed : Math.max(it.min, it.nat))
  let sum = w.reduce((a, b) => a + b, 0)
  if (sum > room) {
    // shrink, proportionally to what each shrinkable child can give
    let over = sum - room
    for (let pass = 0; pass < 4 && over > 0.01; pass++) {
      const give = items.map((it, i) => it.fixed != null ? 0 : Math.max(0, w[i] - it.min))
      const total = give.reduce((a, b) => a + b, 0)
      if (total <= 0) break
      const take = Math.min(over, total)
      items.forEach((it, i) => { w[i] -= give[i] * take / total })
      over -= take
    }
  } else if (sum < room) {
    const g = items.map(it => it.fixed != null ? 0 : Math.max(0, it.grow || 0))
    const total = g.reduce((a, b) => a + b, 0)
    if (total > 0) items.forEach((it, i) => { w[i] += (room - sum) * g[i] / total })
  }
  if (!cells) return w.map(x => Math.max(0, x))
  // whole cells: floor, then hand the remainder to the largest fractions, left first
  const fl = w.map(x => Math.max(0, Math.floor(x + 1e-9)))
  let rest = Math.round(Math.min(room, w.reduce((a, b) => a + b, 0)) - fl.reduce((a, b) => a + b, 0))
  const order = w.map((x, i) => [x - Math.floor(x + 1e-9), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1])
  for (let j = 0; rest > 0 && j < order.length; j++, rest--) fl[order[j][1]]++
  return fl
}
