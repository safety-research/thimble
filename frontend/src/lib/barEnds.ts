// A bar's round end, as the chart style draws it (lib/vizTheme vegaConfig `bar.cornerRadiusEnd`, --viz-bar-radius),
// mended where Vega-Lite 6.4.3 draws it wrong. barEnds runs on the Vega that Vega-Lite compiles, as vega-embed's
// `patch`: in every chart thimble draws (lib/vegaDraw drawChart) and in a custom card's frame, whose vegaEmbed it wraps
// (lib/frame chartScript), so a card's own Vega-Lite drawn with thimble.vegaConfig gets the same bars.
// - Vega-Lite draws a stacked bar with corners in a group per stack, clipped to the stack with the corners on the group,
//   so only the stack's end is round (vega-lite compile/mark/mark.ts getGroupsForStackedBarWithCornerRadius). The group
//   facets its rows by the stack's dimension field and keeps no other, so a bar drawn from x to x2 (a histogram's bins,
//   thimble.chart's bars over time) has its group read an x2 the facet dropped: the group has no width and the bar is
//   not drawn. The fields a group's position reads join its facet's groupby; x2 follows from x, so no stack splits.
// - Vega-Lite rounds a vertical bar's top and a horizontal bar's right whatever its sign, so a bar below zero was round
//   at zero and square at its value. A bar with Vega-Lite's end corners rounds the side its value is on, seen from its
//   baseline; a stack with values either side of zero rounds both ends.
// - Vega-Lite gives the theme's radius to the end corners of a bar whose spec sets `cornerRadius`; such a bar keeps its
//   own radius at every corner.
// barEnds reads nothing outside its own body, since chartScript writes its source into a frame.

/** The Vega `vg` with its bars' ends mended (above). Pure; a part it leaves alone comes back as the same object. */
export function barEnds(vg: Record<string, unknown>): Record<string, unknown> {
  type O = Record<string, any>
  const o = (v: unknown): O | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as O) : null)
  const TL = 'cornerRadiusTopLeft'
  const TR = 'cornerRadiusTopRight'
  const BL = 'cornerRadiusBottomLeft'
  const BR = 'cornerRadiusBottomRight'
  const TOP = [TL, TR]
  const BOTTOM = [BL, BR]
  const LEFT = [TL, BL]
  const RIGHT = [TR, BR]
  // the radius of a bar whose corners are just `ends`, each the same plain value (Vega-Lite's cornerRadiusEnd); else 0
  const endRadius = (u: O, ends: string[]): number => {
    let r = 0
    for (const k of [TL, TR, BL, BR]) {
      const e = o(u[k])
      if (!e) {
        if (ends.includes(k)) return 0
        continue
      }
      if (Object.keys(e).length !== 1 || typeof e.value !== 'number') return 0
      if (!ends.includes(k)) {
        if (e.value !== 0) return 0
      } else if (r && r !== e.value) return 0
      else r = e.value
    }
    return r > 0 ? r : 0
  }
  // a position as an expression of its pixel: a signal, or a field (a plain name) or a number through a scale; else ''
  const px = (v: unknown): string => {
    const e = o(v)
    if (!e) return ''
    const n = Object.keys(e).length
    if (n === 1 && typeof e.signal === 'string') return `(${e.signal})`
    if (n !== 2 || typeof e.scale !== 'string') return ''
    if (typeof e.field === 'string' && /^[^.[\]\\]+$/.test(e.field)) return `scale(${JSON.stringify(e.scale)},datum[${JSON.stringify(e.field)}])`
    return typeof e.value === 'number' ? `scale(${JSON.stringify(e.scale)},${e.value})` : ''
  }
  // the zero of the scale a stack group's position signal reads, as a pixel
  const zero = (signal: string): string => {
    const m = /scale\((['"])([^'"]+)\1/.exec(signal)
    return m ? `scale(${JSON.stringify(m[2])},0)` : ''
  }
  // the corners `ks` at radius `r` where the pixel expression `test` holds
  const corners = (ks: string[], test: string, r: number): O => Object.fromEntries(ks.map((k) => [k, { signal: `${test} ? ${r} : 0` }]))
  // the new corners of a bar's update `u`, or null to leave them. `stack`: the update is a stack group's, whose position
  // signals span the whole stack (top or left first), with the baseline at the scale's zero; else the bar's value is at
  // y (or x) and its baseline at y2 (or x2)
  const ends = (u: O, stack: boolean): O | null => {
    const vertical = endRadius(u, TOP)
    const horizontal = endRadius(u, RIGHT)
    const r = vertical || horizontal
    if (!r) return null
    const own = o(u.cornerRadius)
    if (own) {
      if (typeof own.value === 'number' && own.value > 0) return Object.fromEntries((vertical ? TOP : RIGHT).map((k) => [k, { value: own.value }]))
      // a radius of the spec's that is no plain number (a signal) is left to it
      if (own.value !== 0) return null
    }
    const [a, b] = vertical ? ['y', 'y2'] : ['x', 'x2']
    if (stack) {
      const lo = o(u[a])?.signal
      const hi = o(u[b])?.signal
      const z = typeof lo === 'string' && typeof hi === 'string' ? zero(lo) : ''
      if (!z) return null
      return { ...corners(vertical ? TOP : LEFT, `(${lo}) < ${z}`, r), ...corners(vertical ? BOTTOM : RIGHT, `(${hi}) > ${z}`, r) }
    }
    const value = px(u[a])
    const base = px(u[b])
    if (!value || !base) return null
    return { ...corners(vertical ? TOP : LEFT, `${value} < ${base}`, r), ...corners(vertical ? BOTTOM : RIGHT, `${value} > ${base}`, r) }
  }
  const mark = (m: unknown): unknown => {
    const g = o(m)
    if (!g) return m
    let out: O = g
    const u = o(o(g.encode)?.update)
    const facet = o(o(g.from)?.facet)
    const stack = g.type === 'group' && !!facet && typeof facet.name === 'string' && facet.name.startsWith('stack_group_')
    if (u && facet && stack) {
      const have: string[] = Array.isArray(facet.groupby) ? facet.groupby : typeof facet.groupby === 'string' ? [facet.groupby] : []
      const need: string[] = []
      for (const k of ['x', 'xc', 'x2', 'width', 'y', 'yc', 'y2', 'height']) {
        const e = o(u[k])
        for (const f of [e?.field, o(e?.offset)?.field]) if (typeof f === 'string' && !have.includes(f) && !need.includes(f)) need.push(f)
      }
      if (need.length) out = { ...out, from: { ...g.from, facet: { ...facet, groupby: [...have, ...need] } } }
    }
    const fixed = u && (stack || g.type === 'rect') ? ends(u, stack) : null
    if (fixed) out = { ...out, encode: { ...out.encode, update: { ...u, ...fixed } } }
    if (Array.isArray(out.marks)) {
      const marks = out.marks.map(mark)
      if (marks.some((c: unknown, i: number) => c !== out.marks[i])) out = { ...out, marks }
    }
    return out
  }
  return mark(vg) as Record<string, unknown>
}
