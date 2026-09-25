// Chart theming from the design tokens, read from the document when a chart is built (fallbacks are the light tokens'
// values). Single and ordered series take the ink ramp; nominal groups of more than two take Okabe–Ito hues (tokens.css),
// distinct under common colour-vision deficiencies, and every series is named in the legend. Axis and legend labels are
// mono at 11 px. The accent is never a series.
const FALLBACK: Record<string, string> = {
  '--viz-annotation': '#5135ff',
  '--viz-axis': 'rgba(27, 26, 24, 0.28)',
  '--viz-grid': 'rgba(27, 26, 24, 0.08)',
  '--viz-label': '#64625b',
  '--font-body': 'Hanken Grotesk, ui-sans-serif, system-ui, sans-serif',
  '--font-mono': 'Geist Mono, ui-monospace, SF Mono, Menlo, monospace',
  '--viz-ink-1': '#1b1a18',
  '--viz-ink-2': '#6b675f',
  '--viz-ink-3': '#a19d94',
  '--viz-ink-4': '#cfcbc2',
  '--viz-1': '#0072b2',
  '--viz-2': '#e69f00',
  '--viz-3': '#009e73',
  '--viz-4': '#d62728',
  '--viz-5': '#cc79a7',
  '--viz-6': '#8c65e8',
  '--viz-7': '#8a6d3b',
  '--viz-8': '#1b1a18',
  '--viz-9': '#a19d94',
  '--label-1': '#0072b2',
  '--label-2': '#e69f00',
  '--label-3': '#009e73',
  '--label-4': '#cc79a7',
  '--label-5': '#d55e00',
  '--label-6': '#56b4e9',
  '--label-7': '#8a6d3b',
  '--label-8': '#6a5acd',
  '--label-9': '#aa3377',
  '--label-10': '#999933',
  '--label-11': '#6a3d9a',
  '--label-12': '#d62728',
  '--label-none': '#a09c93',
}
export const LABEL_LIMIT = 240
/** the nominal palette (tokens.css): Okabe–Ito with its vermillion and sky blue replaced by a red and a violet, five,
 * then two more when a chart needs them */
export const VIZ_SERIES = ['--viz-1', '--viz-2', '--viz-3', '--viz-4', '--viz-5', '--viz-6', '--viz-7']
/** the ink ramp, darkest first */
export const VIZ_INK = ['--viz-ink-1', '--viz-ink-2', '--viz-ink-3', '--viz-ink-4']
/** the inks a value no label defines takes, in turn, in a chart of a label's classes (lib/chartDefaults labelColours):
 * the ink ramp without its third step, which is the near twin of the label grey, --label-none */
export const VIZ_NEUTRAL = ['--viz-ink-1', '--viz-ink-2', '--viz-ink-4']

export function unquote(v: string): string {
  const m = /^(['"])(.*)\1$/.exec(v)
  return m && !m[2].includes(m[1]) ? m[2] : v
}

export function token(name: string): string {
  if (typeof document === 'undefined') return FALLBACK[name] ?? ''
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return unquote(v) || (FALLBACK[name] ?? '')
}

/** Two nominal groups take ink, not colour: the darkest step and a lighter one (Outputs.inkSmallNominal). */
export const inkPair = (): string[] => [token('--viz-ink-1'), token('--viz-ink-3')]

/** A Vega-Lite config in the system's chart chrome, merged under a spec's own config by vega-embed. */
export function vegaConfig(): Record<string, unknown> {
  const label = token('--viz-label')
  const font = token('--font-body')
  const mono = token('--font-mono')
  const axis = token('--viz-axis')
  const ink = VIZ_INK.map(token)
  return {
    font,
    background: 'transparent',
    // room at the right for the last x tick's label, which a fitted width would otherwise clip
    padding: { left: 5, top: 5, right: 16, bottom: 5 },
    view: { stroke: null },
    axis: { domainColor: axis, tickColor: axis, gridColor: token('--viz-grid'), labelColor: label, titleColor: label, labelFont: mono, labelFontSize: 11, titleFont: font, titleFontSize: 11, titleFontWeight: 500, labelLimit: LABEL_LIMIT, labelOverlap: 'greedy', labelSeparation: 6 },
    axisX: { grid: false },
    // numbers keep evenly spaced labels when some must go: 'greedy' drops them unevenly (0, 200 … 1,000, 1,400,
    // 1,800), so the scale looks uneven
    axisQuantitative: { labelOverlap: 'parity' },
    legend: { labelColor: label, titleColor: label, labelFont: mono, labelFontSize: 11, titleFont: font, titleFontSize: 11, titleFontWeight: 500, labelLimit: LABEL_LIMIT, symbolType: 'square' },
    // a facet's panels are named across, in the body face: a row's name over its panel at the left rather than turned
    // on end beside it, where it took the width and ran into the y title
    header: { labelColor: ink[0], labelFont: font, labelFontSize: 11.5, labelFontWeight: 500, titleColor: label, titleFont: font, titleFontSize: 11, titleFontWeight: 500 },
    headerRow: { labelAngle: 0, labelOrient: 'top', labelAnchor: 'start', labelAlign: 'left', labelPadding: 4 },
    title: { color: ink[0], font, fontSize: 13, fontWeight: 500, anchor: 'start' },
    // nominal groups: Okabe–Ito; an ordered scale climbs the ink ramp from light to dark, so the top is the darkest
    range: { category: VIZ_SERIES.map(token), ordinal: [...ink].reverse(), ramp: [ink[3], ink[0]] },
    mark: { color: ink[0] },
    line: { strokeWidth: 1.5, stroke: ink[0] },
    bar: { fill: ink[2] },
    point: { filled: true, fill: ink[0] },
    area: { fill: ink[3], line: { stroke: ink[0] } },
    rule: { color: ink[0] },
  }
}
