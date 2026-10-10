// The canvas's chart drawing for a view's page: vite build writes this module as one script, dist/kit/chart.js
// (vite.config.ts kitScript), which backend views.frame_document puts in every view page for the view kit's
// thimble.chart (backend/app/viewer_chart.js). A view's chart is so drawn by the code that draws the canvas's charts
// (lib/vegaDraw drawChart: lib/chartDefaults, the chart style of lib/vizTheme read from the page's own tokens, the
// fitting to the box), never by a copy of it. It draws with the vega and vega-embed builds the page names in its libs.
import type { LabelClassColour } from './chartDefaults'
import { drawChart, refitChart, type DrawnChart, type VegaModule } from './vegaDraw'

/** What viewer_chart.js finds as window.__thimbleCharts. */
export interface KitCharts {
  /** draw a Vega-Lite spec in `el` as the canvas draws a chart (lib/vegaDraw drawChart), with these labels' colours, a
   * composite fitted to `fitWidth` */
  draw: (
    el: HTMLElement,
    spec: Record<string, unknown>,
    opts: { fitWidth?: number; labels?: readonly (readonly LabelClassColour[])[]; alive?: () => boolean; replace?: () => void; drawn?: (chart: DrawnChart) => void },
  ) => Promise<DrawnChart | null>
  /** a chart that takes its box's width read again after a resize; false when nothing changed or it cannot refit */
  refit: (chart: DrawnChart, el: HTMLElement) => boolean
}

declare global {
  interface Window {
    __thimbleCharts?: KitCharts
    vegaEmbed?: VegaModule['default'] & { vega?: VegaModule['vega'] }
    vega?: VegaModule['vega']
  }
}

/** vega-embed and its vega as the page's libs give them, the globals vega-embed's and vega's builds set. */
function vegaOfPage(): Promise<VegaModule> {
  const embed = window.vegaEmbed
  const vega = window.vega ?? embed?.vega
  if (typeof embed !== 'function' || !vega) return Promise.reject(new Error('thimble.chart draws with vega-embed: name "vega-embed" in view.json\'s libs'))
  return Promise.resolve({ default: embed, vega })
}

window.__thimbleCharts = {
  draw: (el, spec, opts) => drawChart(el, spec, vegaOfPage, opts),
  refit: (chart, el) => refitChart(chart.view, el, chart.container),
}
