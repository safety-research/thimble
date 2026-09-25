// What a card draws from what its code emitted (src/components/Outputs.tsx, src/lib/dataFrame.ts,
// src/canvas/FrameTable.tsx, src/lib/chartDefaults.ts, src/lib/media.ts). Each bundle shows one representation, the
// picture before its text; a card shows its chart, else its table, else its error, else its shell output; the frame a
// table card ends in is drawn as thimble's table with its numbers in the backend's formats; the chart defaults never
// change the spec they were given; a chart of a label's classes draws them in the label's colours; and the formats the
// backend writes are the ones drawn here.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { DRAWING_MIMES, ERROR_MIME, inkSmallNominal, onPaper, pickMime, primaryArtifact } from '../../src/components/Outputs.tsx'
import { tableModel } from '../../src/canvas/FrameTable.tsx'
import { chartDefaults } from '../../src/lib/chartDefaults.ts'
import { asFrame, cellText, FRAME_MIME, formatter, type Frame } from '../../src/lib/dataFrame.ts'
import { mediaOf, mediaUrl, seconds } from '../../src/lib/media.ts'
import type { MimeBundle } from '../../src/lib/types.ts'

const BACKEND = path.resolve(__dirname, '../../../backend/app')
const py = (file: string) => readFileSync(path.join(BACKEND, file), 'utf8')
const bundle = (b: object) => b as MimeBundle

/** A frame as backend/app/frames.py stores one. */
const frame = (columns: string[], types: Record<string, string>, rows: unknown[][], extra: Record<string, any> = {}) => ({
  columns,
  types,
  index: null,
  label: null,
  rows,
  total: rows.length,
  ...extra,
  view: { columns: columns.filter((c) => c !== extra.label), formats: {}, more: 0, ...(extra.view ?? {}) },
})

describe('which representation a bundle shows', () => {
  test('an error first, then a drawing, a frame, a picture or a chart before html, markdown, json and plain text', () => {
    expect(pickMime(bundle({ [ERROR_MIME]: { ename: 'E' }, 'text/plain': 'x' }))).toBe(ERROR_MIME)
    expect(pickMime(bundle({ 'application/vnd.thimble.diagram+json': {}, 'text/plain': 'x' }))).toBe('application/vnd.thimble.diagram+json')
    expect(pickMime(bundle({ [FRAME_MIME]: {}, 'text/html': '<table></table>', 'text/plain': 'x' }))).toBe(FRAME_MIME)
    for (const mime of ['image/svg+xml', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']) expect(pickMime(bundle({ [mime]: 'AAAA', 'text/plain': '<Figure>' })), mime).toBe(mime)
    expect(pickMime(bundle({ 'application/vnd.vegalite.v5+json': {}, 'text/html': '<div></div>' }))).toBe('application/vnd.vegalite.v5+json')
    expect(pickMime(bundle({ 'text/html': '<b>x</b>', 'text/markdown': '**x**', 'text/plain': 'x' }))).toBe('text/html')
    expect(pickMime(bundle({ 'text/markdown': '**x**', 'text/plain': 'x' }))).toBe('text/markdown')
    expect(pickMime(bundle({ 'application/x-unknown': 1 }))).toBeNull()
  })

  test("a card's artifact: its chart, else its table, else its error, else its last shell stream, else what it displayed", () => {
    const stream = (text: string) => ({ 'text/plain': text, _stream: 'stdout' })
    expect(primaryArtifact([stream('a'), { 'image/png': 'AAAA' }, { 'text/html': '<table></table>' }] as MimeBundle[])?.kind).toBe('chart')
    expect(primaryArtifact([stream('rows 3'), { [FRAME_MIME]: frame(['a'], {}, [['x']]), 'text/plain': 'a' }] as MimeBundle[])?.kind).toBe('table')
    expect(primaryArtifact([{ 'text/html': '<p>x</p><table><tr><td>1</td></tr></table>' }] as MimeBundle[])?.kind).toBe('table')
    expect(primaryArtifact([stream('a'), { [ERROR_MIME]: { ename: 'ValueError' } }] as MimeBundle[])?.kind).toBe('error')
    const shell = primaryArtifact([stream('first'), stream('last')] as MimeBundle[])
    expect([shell?.kind, (shell?.bundle as { 'text/plain': string })['text/plain']]).toEqual(['shell', 'last'])
    expect(primaryArtifact([{ 'text/plain': 'x' }] as MimeBundle[])?.kind).toBe('other')
    expect(primaryArtifact([])).toBeNull()
    expect(primaryArtifact(undefined)).toBeNull()
  })

  test('the formats the backend writes are the ones the page draws', () => {
    expect(py('frames.py')).toContain(`FRAME_MIME = "${FRAME_MIME}"`)
    const kernel = py('kernel_thimble.py')
    for (const [mime, kind] of Object.entries(DRAWING_MIMES)) expect(kernel).toContain(`${kind.toUpperCase()}_MIME = "${mime}"`)
    expect(py('refs.py')).toContain(`"${ERROR_MIME}"`)
  })
})

describe("a table card's frame", () => {
  test('a stored frame is read tolerantly, and its numbers are written in the formats the backend chose', () => {
    const f = asFrame(frame(['a', 'n'], { a: 'nominal', n: 'quantitative' }, [['x', 1234.5]], { view: { formats: { n: ',.1~f' } } }))
    expect(f?.view.formats.n).toBe(',.1~f')
    expect(asFrame({ columns: 'no' })).toBeNull()
    expect(asFrame(null)).toBeNull()
    expect(cellText(6521, ',d')).toBe('6,521')
    expect(cellText(0.0777777778, ',.3~f')).toBe('0.078')
    expect(cellText(-2, ',d')).toBe('−2')
    expect(cellText(2024, 'd')).toBe('2024')
    expect(cellText(null)).toBe('')
    expect(cellText('text')).toBe('text')
    expect(cellText(3.5)).toBe('3.5')
    expect(formatter('not a format %%%')).toBeNull()
  })

  test("the columns after the row names, numbers in their formats, prose marked, and how many rows are left out", () => {
    const f = frame(['agent', 'reviews', 'share', 'note'], { agent: 'nominal', reviews: 'quantitative', share: 'quantitative', note: 'nominal' }, [['agent-04', 3120, 0.668, 'reviewed most of the backlog in the first hour of the run'], ['agent-09', 601, 0.787, 'idle']], {
      label: 'agent',
      index: 'agent',
      total: 5,
      view: { formats: { reviews: ',d', share: ',.3~f' }, more: 3 },
    })
    const t = tableModel(asFrame(f) as Frame)
    expect(t.corner).toBe('agent')
    expect(t.cols.map((c) => [c.key, c.num, c.prose])).toEqual([['reviews', true, false], ['share', true, false], ['note', false, true]])
    expect(t.rows.map((r) => r.label)).toEqual(['agent-04', 'agent-09'])
    expect(t.rows[0].cells.map((c) => c.text)).toEqual(['3,120', '0.668', 'reviewed most of the backlog in the first hour of the run'])
    expect(t.more).toBe(3)
  })

  test('a row a ref names by its raw value shows its formatted number; rows named by position hide the label', () => {
    const steps = tableModel(asFrame(frame(['step', 'loss'], { step: 'quantitative', loss: 'quantitative' }, [[5500, 0.25]], { label: 'step', view: { formats: { step: ',d', loss: ',.2~f' } } })) as Frame)
    expect([steps.rows[0].name, steps.rows[0].label]).toEqual(['5500', '5,500'])
    const bare = tableModel(asFrame(frame(['n'], { n: 'quantitative' }, [[1], [2]])) as Frame)
    expect(bare.labelHidden).toBe(true)
    expect(bare.rows.map((r) => r.label)).toEqual(['0', '1'])
  })

  test('scrolled sideways, the row names keep their header on top of the headers that pass under it', () => {
    // the last z-index each stylesheet gives a selector, the table's own sheet after the one for every table
    const css = ['outputs.css', 'canvas.css']
      .map((f) => readFileSync(path.resolve(__dirname, '../../src/styles', f), 'utf8'))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    const decl = (selector: string, prop: string) => {
      const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => m[1].split(',').some((s) => s.trim() === selector))
      const vs = rules.map((m) => new RegExp(`(?:^|;|\\s)${prop}:\\s*([^;]+)`).exec(m[2])).filter(Boolean)
      return vs.length ? vs.at(-1)![1].trim() : ''
    }
    const z = (selector: string) => Number(decl(selector, 'z-index') || 0)
    expect(z('.frame-table thead th:first-child')).toBeGreaterThan(z('.frame-table thead th'))
    expect(z('.frame-table thead th')).toBeGreaterThan(z('.outputs-html tbody th'))
    // and the headers held in place are on the card's paper, which a transparent card header is not
    expect(decl('.frame-table .frame-table-box table thead th', 'background')).toBe('var(--surface-card)')
  })
})

describe('chart defaults', () => {
  const VL = 'https://vega.github.io/schema/vega-lite/v5.json'
  const rows = Array.from({ length: 10 }, (_, i) => [{ week: 1, n: i + 1, agent: `agent-${i}` }, { week: 2, n: 2 * (i + 1), agent: `agent-${i}` }]).flat()

  test('the spec they are given is left as it was, and every row is still drawn', () => {
    const spec = { $schema: VL, data: { name: 'd1' }, mark: 'line', encoding: { x: { field: 'week', type: 'ordinal' }, y: { field: 'n', type: 'quantitative' }, color: { field: 'agent', type: 'nominal' } }, datasets: { d1: rows } }
    const before = JSON.stringify(spec)
    const out = chartDefaults(spec, { width: 692, card: true, palette: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'], other: 'grey' }) as any
    expect(JSON.stringify(spec)).toBe(before)
    expect(out.datasets.d1).toHaveLength(rows.length)
    const long = { $schema: VL, data: { values: [{ kind: 'protected-branch push', n: 12 }] }, mark: 'bar', encoding: { x: { field: 'kind', type: 'nominal' }, y: { field: 'n', type: 'quantitative' } } }
    const longBefore = JSON.stringify(long)
    chartDefaults(long, {})
    expect(JSON.stringify(long)).toBe(longBefore)
  })

  describe("a label's classes", () => {
    // an invented label, "kind of change", as files/labels resolves its classes' tokens; the neutral inks are stand-ins
    const kind = [
      { name: 'bug fix', colour: '#e69f00' },
      { name: 'new feature', colour: '#009e73' },
      { name: 'refactor', colour: '#cc79a7' },
      { name: 'other', colour: '#a09c93', none: true },
    ]
    const flaky = [
      { name: 'flaky', colour: '#0072b2' },
      { name: 'no', colour: '#a09c93', none: true },
    ]
    const neutral = ['ink1', 'ink2', 'ink4']
    const days = [
      { day: '2026-03-01', series: 'commits', kind: 'new feature', n: 4 },
      { day: '2026-03-01', series: 'commits', kind: 'other', n: 1 },
      { day: '2026-03-02', series: 'commits', kind: 'bug fix', n: 7 },
      { day: '2026-03-02', series: 'reverts', kind: 'revert by a reviewer', n: 2 },
    ]
    const faceted = (color: object) => ({
      $schema: VL,
      data: { name: 'd1' },
      datasets: { d1: days },
      facet: { row: { field: 'series', type: 'nominal' } },
      spec: { mark: 'bar', encoding: { x: { field: 'day', type: 'temporal' }, y: { field: 'n', type: 'quantitative' }, color: { field: 'kind', type: 'nominal', ...color } } },
    })

    test("take the label's colours, and a value the label does not define a neutral ink", () => {
      const spec = faceted({})
      const before = JSON.stringify(spec)
      const out = chartDefaults(spec, { width: 692, card: true, labels: [flaky, kind], neutral }) as any
      expect(out.spec.encoding.color.scale).toEqual({ domain: ['bug fix', 'new feature', 'other', 'revert by a reviewer'], range: ['#e69f00', '#009e73', '#a09c93', 'ink1'] })
      expect(JSON.stringify(spec)).toBe(before)
      // a sort list keeps its order, and a scheme gives way to the label's colours
      const sorted = chartDefaults(faceted({ sort: ['other', 'bug fix'], scale: { scheme: 'category10' } }), { labels: [kind], neutral }) as any
      expect(sorted.spec.encoding.color.scale).toEqual({ domain: ['other', 'bug fix', 'new feature', 'revert by a reviewer'], range: ['#a09c93', '#e69f00', '#009e73', 'ink1'] })
      // two classes stay in the label's colours rather than the ink pair of two groups
      const two = { $schema: VL, data: { values: [{ flaky: 'flaky', n: 3 }, { flaky: 'no', n: 9 }] }, mark: 'bar', encoding: { x: { field: 'flaky', type: 'nominal' }, y: { field: 'n', type: 'quantitative' }, color: { field: 'flaky', type: 'nominal' } } }
      const drawn = inkSmallNominal(chartDefaults(two, { labels: [flaky], neutral }), ['ink1', 'ink3']) as any
      expect(drawn.encoding.color.scale.range).toEqual(['#0072b2', '#a09c93'])
    })

    test('a chart of other values, or of colours of its own, is left as it is', () => {
      // "other" alone, the label's grey, does not make a chart the label's
      const others = { $schema: VL, data: { values: [{ tool: 'grep', n: 3 }, { tool: 'other', n: 1 }] }, mark: 'bar', encoding: { x: { field: 'tool', type: 'nominal' }, y: { field: 'n', type: 'quantitative' }, color: { field: 'tool', type: 'nominal' } } }
      expect((chartDefaults(others, { labels: [kind], neutral }) as any).encoding.color.scale).toBeUndefined()
      expect((chartDefaults(faceted({}), { neutral }) as any).spec.encoding.color.scale, 'no label, no change').toBeUndefined()
      const own = faceted({ scale: { domain: ['bug fix', 'new feature'], range: ['red', 'blue'] } })
      expect((chartDefaults(own, { labels: [kind], neutral }) as any).spec.encoding.color.scale).toEqual({ domain: ['bug fix', 'new feature'], range: ['red', 'blue'] })
    })

    test("the kernel's colours are the label's, and its neutral inks become the theme's", () => {
      const src = py('kernel_thimble.py')
      const list = (name: string) => JSON.parse(new RegExp(`^${name} = (\\[[^\\]]*\\])`, 'm').exec(src)![1]) as string[]
      const tokens = readFileSync(path.resolve(__dirname, '../../src/styles/tokens.css'), 'utf8')
      // a token's first value in tokens.css: the Warm paper's, which comes first, or the one value of a label colour
      const tok = (name: string) => new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(tokens)![1].toLowerCase()
      expect(list('LABEL_COLOURS')).toEqual(['--label-none', ...Array.from({ length: 12 }, (_, i) => `--label-${i + 1}`)].map(tok))
      expect(list('NEUTRAL_COLOURS')).toEqual(['--viz-ink-1', '--viz-ink-2', '--viz-ink-4'].map(tok))
      // a scale from thimble.colours: the classes in the label's colours, the other value in the Warm paper's darkest ink
      const fromKernel = faceted({ scale: { domain: ['bug fix', 'revert by a reviewer'], range: ['#E69F00', '#1b1a18'] } })
      expect((chartDefaults(fromKernel, { labels: [kind], neutral }) as any).spec.encoding.color.scale).toEqual({ domain: ['bug fix', 'revert by a reviewer'], range: ['#e69f00', 'ink1'] })
    })
  })

  test('a chart sits on the paper that shows it, and the stored spec is not changed', () => {
    const spec = { $schema: VL, background: '#ddd6fe', config: { background: 'white', view: { fill: '#eee', stroke: null } }, mark: 'bar' }
    const out = onPaper(spec) as any
    expect(out.background).toBe('transparent')
    expect(out.config.background).toBe('transparent')
    expect(out.config.view).toEqual({ stroke: null })
    expect(spec.background).toBe('#ddd6fe')
    expect(onPaper(null)).toBeNull()
  })
})

describe('media', () => {
  test('a ref to an image, a recording or a video names the file and the moment an example card shows', () => {
    expect(mediaOf('reports/figures/reviews.png')).toEqual({ kind: 'image', path: 'reports/figures/reviews.png' })
    expect(mediaOf('recordings/standup.mp4#t=30:55')).toEqual({ kind: 'video', path: 'recordings/standup.mp4', start: 1855 })
    expect(mediaOf('recordings/standup.mp4#t=1:02:03,1:02:30')).toEqual({ kind: 'video', path: 'recordings/standup.mp4', start: 3723, end: 3750 })
    expect(mediaOf('logs/run.jsonl#L4')).toBeNull()
    expect(mediaOf('card:ab12cd34')).toBeNull()
    expect(seconds('90')).toBe(90)
    expect(seconds('x:10')).toBeNull()
    expect(mediaUrl('w', mediaOf('recordings/standup.mp4#t=30:55')!)).toBe('/api/ws/w/media?path=recordings%2Fstandup.mp4#t=1855')
    expect(mediaUrl('a b', mediaOf('c d.png')!)).toBe('/api/ws/a%20b/media?path=c%20d.png')
  })

  test('a file is shown as media only when the media route serves its type (backend/app/views.py MEDIA_TYPES)', () => {
    const block = /^MEDIA_TYPES = \{([\s\S]*?)^\}/m.exec(py('views.py'))
    expect(block).not.toBeNull()
    const served = [...block![1].matchAll(/"\.(\w+)": "(image|audio|video)\//g)]
    expect(served.length).toBeGreaterThan(10)
    for (const [, ext, kind] of served) expect(mediaOf(`a/file.${ext}`)?.kind, ext).toBe(kind)
    for (const ext of ['svg', 'pdf', 'html', 'txt']) expect(mediaOf(`a/file.${ext}`), ext).toBeNull()
  })
})
