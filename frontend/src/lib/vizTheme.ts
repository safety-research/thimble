// The chart style, in one place: the --viz-* tokens (styles/tokens.css), read from the document when a chart is built
// (the fallbacks are the Warm paper's with the default accent). Every chart thimble draws takes them: the Vega-Lite
// theme here, matplotlib's defaults (backend/app/matplotlibrc, whose colors an inlined figure maps back to the tokens,
// lib/svg), the timeline and the diagram (styles/canvas.css), and the frames of custom cards and card types, which get
// them as CSS variables (lib/frame CHART_TOKENS).
//
// Colors by the job they do: one series takes --viz-1; nominal groups take --viz-1 to --viz-7 in order, and past seven
// fold into --viz-other (lib/chartDefaults); an amount (a quantitative or ordinal color) takes the sequential ramp
// --viz-seq-1 to -5, faint to strong; an amount either side of a midpoint takes the diverging --viz-div-1 to -5; one
// thing set against the rest takes --viz-highlight against --viz-other. The series and the ramps follow the accent
// (tokens.css). Rules and text marks (notes, values) are --viz-annotation, an ink. Axis and legend labels are mono,
// titles and text marks the body face, all at --viz-size; a chart's own title at --viz-size-title.
const FALLBACK: Record<string, string> = {
  '--viz-annotation': '#6b675f',
  '--viz-axis': 'rgba(27, 26, 24, 0.28)',
  '--viz-grid': 'rgba(27, 26, 24, 0.08)',
  '--viz-label': '#64625b',
  '--font-body': 'Hanken Grotesk, ui-sans-serif, system-ui, sans-serif',
  '--font-mono': 'Geist Mono, ui-monospace, SF Mono, Menlo, monospace',
  '--viz-font': 'Hanken Grotesk, ui-sans-serif, system-ui, sans-serif',
  '--viz-font-label': 'Geist Mono, ui-monospace, SF Mono, Menlo, monospace',
  '--viz-size': '11px',
  '--viz-size-title': '13px',
  '--viz-line': '1.5px',
  '--viz-ink-1': '#1b1a18',
  '--viz-ink-2': '#6b675f',
  '--viz-ink-3': '#a19d94',
  '--viz-ink-4': '#cfcbc2',
  '--viz-other': '#a19d94',
  '--viz-1': '#5e4bd6',
  '--viz-2': '#018d82',
  '--viz-3': '#e26101',
  '--viz-4': '#306602',
  '--viz-5': '#0471c8',
  '--viz-6': '#c8367b',
  '--viz-7': '#a08319',
  '--viz-seq-1': '#eeeffe',
  '--viz-seq-2': '#9d9cff',
  '--viz-seq-3': '#5e4bd6',
  '--viz-seq-4': '#4228aa',
  '--viz-seq-5': '#280f72',
  '--viz-div-1': '#923d03',
  '--viz-div-2': '#ffa479',
  '--viz-div-3': '#cfcbc2',
  '--viz-div-4': '#9d9cff',
  '--viz-div-5': '#4228aa',
  '--viz-highlight': '#5e4bd6',
  '--label-1': '#025ac3',
  '--label-2': '#d0750a',
  '--label-3': '#06572a',
  '--label-4': '#1392d4',
  '--label-5': '#7d6702',
  '--label-6': '#009c85',
  '--label-7': '#844500',
  '--label-8': '#013c77',
  '--label-9': '#2aa02b',
  '--label-10': '#025a7c',
  '--label-11': '#622b01',
  '--label-12': '#0389a0',
  '--label-none': '#a09c93',
}
export const LABEL_LIMIT = 240
/** the series, in order: series one is the accent's color family, the rest follow in the palette's fixed order (tokens.css) */
export const VIZ_SERIES = ['--viz-1', '--viz-2', '--viz-3', '--viz-4', '--viz-5', '--viz-6', '--viz-7']
/** the sequential ramp: the accent's family from faint (near the paper) to strong */
export const VIZ_SEQ = ['--viz-seq-1', '--viz-seq-2', '--viz-seq-3', '--viz-seq-4', '--viz-seq-5']
/** the diverging ramp, low to high: a family far from the accent's, a gray near the paper, the accent's family */
export const VIZ_DIV = ['--viz-div-1', '--viz-div-2', '--viz-div-3', '--viz-div-4', '--viz-div-5']
/** the ink ramp, darkest first: rules, text and the chrome, never a series */
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

/** A size token in px, `fallback` when it does not read as one. */
function px(name: string, fallback: number): number {
  const n = parseFloat(token(name))
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** A Vega-Lite config in the chart style, merged under a spec's own config by vega-embed. */
export function vegaConfig(): Record<string, unknown> {
  const label = token('--viz-label')
  const font = token('--viz-font')
  const mono = token('--viz-font-label')
  const size = px('--viz-size', 11)
  const axis = token('--viz-axis')
  const ink = token('--viz-ink-1')
  const note = token('--viz-annotation')
  const seq = VIZ_SEQ.map(token)
  return {
    font,
    background: 'transparent',
    // room at the right for the last x tick's label, which a fitted width would otherwise clip
    padding: { left: 5, top: 5, right: 16, bottom: 5 },
    view: { stroke: null },
    axis: { domainColor: axis, tickColor: axis, gridColor: token('--viz-grid'), labelColor: label, titleColor: label, labelFont: mono, labelFontSize: size, titleFont: font, titleFontSize: size, titleFontWeight: 500, labelLimit: LABEL_LIMIT, labelOverlap: 'greedy', labelSeparation: 6 },
    axisX: { grid: false },
    // numbers keep evenly spaced labels when some must go: 'greedy' drops them unevenly (0, 200 … 1,000, 1,400,
    // 1,800), so the scale looks uneven
    axisQuantitative: { labelOverlap: 'parity' },
    legend: { labelColor: label, titleColor: label, labelFont: mono, labelFontSize: size, titleFont: font, titleFontSize: size, titleFontWeight: 500, labelLimit: LABEL_LIMIT, symbolType: 'square' },
    // a facet's panels are named across, in the body face: a row's name over its panel at the left rather than turned
    // on end beside it, where it took the width and ran into the y title
    header: { labelColor: ink, labelFont: font, labelFontSize: size + 0.5, labelFontWeight: 500, titleColor: label, titleFont: font, titleFontSize: size, titleFontWeight: 500 },
    headerRow: { labelAngle: 0, labelOrient: 'top', labelAnchor: 'start', labelAlign: 'left', labelPadding: 4 },
    title: { color: ink, font, fontSize: px('--viz-size-title', 13), fontWeight: 500, anchor: 'start' },
    // nominal groups: the series in order; an ordered or quantitative scale climbs the accent's ramp from faint to
    // strong (an ordinal one from its second step, so its first group still shows on the paper); a scale with a
    // midpoint takes the diverging ramp. Each ramp is a scheme, so Vega samples as many colors as the scale needs
    range: { category: VIZ_SERIES.map(token), ordinal: { scheme: seq.slice(1) }, ramp: { scheme: seq }, heatmap: { scheme: seq }, diverging: { scheme: VIZ_DIV.map(token) } },
    // one series: the first series color, never ink
    mark: { color: token(VIZ_SERIES[0]) },
    line: { strokeWidth: px('--viz-line', 1.5) },
    point: { filled: true },
    rule: { color: note },
    // notes and values on the marks: the annotation ink in the body face, which a dark paper lightens with the text
    text: { color: note, font, fontSize: size },
    // the marks thimble.chart names by their job (backend kernel_thimble FAINT_STYLE and on): a box plot's values faint
    // behind its boxes, the boxes light enough to show them, its medians in ink; areas side by side overlapping lightly.
    // Each keeps its series or label color but the median
    style: {
      'thimble-faint': { opacity: 0.3 },
      'thimble-box': { opacity: 0.55 },
      'thimble-median': { color: ink, opacity: 1, thickness: 2 },
      'thimble-overlap': { opacity: 0.4 },
    },
  }
}
