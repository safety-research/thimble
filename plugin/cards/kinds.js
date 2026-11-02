// kinds.js: the ready kinds of card, which thimble draws from their data, as the workbench draws its cards: example
// (records quoted in place), table, chart, timeline, diagram and note. A call of a ready kind (tool.ts, ready.ts) keeps
// the kind's data as the card's rows file, one object ({kind, answer, ...the kind's fields}), and as its view STUB, which
// hands the drawing to these renderers. The runner puts readyKinds' source into each card's context (runner.mjs, as it
// puts core/text.js printable there), so a ready card runs where every view runs and draws with what a view draws with:
// Ink's Box and Text, surface.colors and surface.num. Everything around a card (versions, the text copy, the side pane,
// the theme, a resumed session) is the same for every kind.
//
//   KINDS             the ready kinds
//   STUB              the view of a ready kind's card: surface.ready draws props.data, its keys turn its pages
//   readyKinds(api)   the renderers, {view(props), key(key, props), keys(props)}. api: the elements, colors, num, the
//                     cells a text takes (core/text.js textWidth) and the surface, for its width and state.
//                     Self-contained: its source runs in a card's context, so it reads nothing outside its own body
//
// Each card draws its answer first, then its data, in at most ROWS rows: what does not fit goes on pages, which j and k
// turn, under a line that says which page shows (`rows 1-20 of 140`). Each line is cut at the card's width. So a ready
// card fits its frame (draw.ts CARD_ROWS) and never waits for the card check (fit.ts). Colors: the palette's categories
// in order, its gray for context (axes, what a value is, a quote's record), ✓ in its green and × in its red; never a
// second palette. Pure: no Node.

export const KINDS = ['example', 'table', 'chart', 'timeline', 'diagram', 'note']

export const STUB = `// thimble draws this card from its data (props.data), by its kind: cards/kinds.js
const keys = (props, surface) => surface.ready.keys(props)
function view(props, surface) { return surface.ready.view(props) }
function onKey(key, surface, props) { surface.ready.key(key, props) }
`

export function readyKinds(api) {
  'use strict'
  const { Box, Text } = api.elements
  const colors = api.colors
  const num = api.num
  const cells = api.textWidth
  const surface = api.surface
  // the rows a ready card draws at most: the frame's 30 (draw.ts CARD_ROWS) less two, which the runner may put between
  // a card's parts (space.js)
  const ROWS = 28
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  // words of a value that people read as a success or a failure, which draw in the palette's green and red
  const GOOD = /^(✓|pass|passed|passes|passing|success|succeeded|successful|ok|yes|true)$/i
  const BAD = /^(×|✗|fail|failed|fails|failing|failure|error|errored|errors|no|false)$/i
  const isArray = Array.isArray

  // ------------------------------------------------------------------------------------------------- text in cells

  /** The first characters of s that fit in n cells. */
  function head(s, n) {
    let out = ''
    let w = 0
    for (const ch of s) {
      const c = cells(ch)
      if (w + c > n) break
      out += ch
      w += c
    }
    return out
  }

  /** The last characters of s that fit in n cells. */
  function tail(s, n) {
    const cs = [...s]
    let out = ''
    let w = 0
    for (let i = cs.length - 1; i >= 0; i--) {
      const c = cells(cs[i])
      if (w + c > n) break
      out = cs[i] + out
      w += c
    }
    return out
  }

  /** s in at most n cells, with … where it was cut: at its end, or, with `middle`, after its first third, so that names
   *  that start alike keep the end that tells them apart. */
  function cut(s, n, middle) {
    const t = String(s)
    if (cells(t) <= n) return t
    if (n <= 0) return ''
    if (n === 1) return '…'
    if (!middle) return head(t, n - 1) + '…'
    const left = head(t, Math.floor((n - 1) / 3))
    return left + '…' + tail(t, n - 1 - cells(left))
  }

  const padEnd = (s, n) => s + ' '.repeat(Math.max(0, n - cells(s)))
  const padStart = (s, n) => ' '.repeat(Math.max(0, n - cells(s))) + s
  /** A value as one line of words: white space folded, nothing for null. */
  const flat = v => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)).replace(/\s+/g, ' ').trim()

  /** Words wrapped at n cells, a word longer than a line cut into pieces: the lines. */
  function wrap(s, n) {
    const out = []
    let cur = ''
    for (const word of String(s).split(' ')) {
      if (!word) continue
      let w = word
      while (cells(w) > n) {
        if (cur) { out.push(cur); cur = '' }
        const part = head(w, n)
        out.push(part)
        w = w.slice(part.length)
      }
      if (!w) continue
      if (!cur) cur = w
      else if (cells(cur) + 1 + cells(w) <= n) cur += ' ' + w
      else { out.push(cur); cur = w }
    }
    if (cur || !out.length) out.push(cur)
    return out
  }

  // ------------------------------------------------------------------------------------------------- lines

  // A line is a list of runs, each a string or {text, color, bold}; ink() makes it a Text.
  const gray = text => ({ text, color: colors.gray })
  const bold = text => ({ text, bold: true })
  const widthOf = line => line.reduce((a, r) => a + cells(typeof r === 'string' ? r : r.text), 0)

  /** A line's runs past n cells cut off, the last one kept with … */
  function fitLine(line, n) {
    if (widthOf(line) <= n) return line
    const out = []
    let left = n
    for (const r of line) {
      const text = typeof r === 'string' ? r : r.text
      if (cells(text) <= left) { out.push(r); left -= cells(text); continue }
      const part = cut(text, left)
      if (part) out.push(typeof r === 'string' ? part : { ...r, text: part })
      break
    }
    return out
  }

  /** Words wrapped at n cells, each word a list of runs that keep their looks: the first line after `lead`, each next
   *  one after `hang`; at most `max` lines, the last ending in … when words are left over. */
  function flowWords(words, n, lead, hang, max) {
    const lines = []
    let line = [lead]
    let used = cells(lead)
    let fresh = true
    for (const word of words) {
      const room = Math.max(1, n - cells(lines.length ? hang : lead))
      const w = widthOf(word) > room ? fitLine(word, room) : word
      if (!fresh && used + 1 + widthOf(w) > n) {
        lines.push(line)
        if (max && lines.length >= max) {
          const last = lines[lines.length - 1]
          lines[lines.length - 1] = widthOf(last) + 1 <= n ? [...last, gray('…')] : fitLine(last, n)
          return lines
        }
        line = [hang]
        used = cells(hang)
        fresh = true
      }
      if (!fresh) {
        // the space between two words of a passage takes its look
        const a = line[line.length - 1]
        line.push(typeof a !== 'string' && a.bold && w[0] && w[0].bold ? { text: ' ', bold: true } : ' ')
        used++
      }
      line.push(...w)
      used += widthOf(w)
      fresh = false
    }
    if (!fresh) lines.push(line)
    return lines
  }

  function ink(line) {
    const runs = line.filter(r => (typeof r === 'string' ? r : r.text) !== '')
    if (!runs.length) return Text({ children: ' ' })
    return Text({ wrap: 'truncate-end', children: runs.map(r => (typeof r === 'string' ? r : Text({ ...(r.color ? { color: r.color } : {}), ...(r.bold ? { bold: true } : {}), children: r.text }))) })
  }

  /** A value's glyph and color when people read it as a success or a failure: ✓ green, × red. */
  function meaning(text) {
    const t = String(text).trim()
    if (GOOD.test(t) || t.startsWith('✓')) return colors.good
    if (BAD.test(t) || t.startsWith('×') || t.startsWith('✗')) return colors.bad
    return null
  }

  /** A text in parts, each ✓ in the palette's green and each × or ✗ in its red where it marks a failure: at the start of
   *  a word, and not a multiplication sign (2×, 3 × 4). */
  function glyphParts(text) {
    const t = String(text)
    const out = []
    let at = 0
    for (let i = 0; i < t.length; i++) {
      const ch = t[i]
      const fails = (ch === '×' || ch === '✗') && !/[\p{L}\p{N}]/u.test(t[i - 1] || '') && !(/\p{N}$/u.test(t.slice(0, i).trimEnd()) && /^\p{N}/u.test(t.slice(i + 1).trimStart()))
      if (ch !== '✓' && !fails) continue
      if (i > at) out.push({ text: t.slice(at, i), style: null })
      out.push({ text: ch, style: { color: ch === '✓' ? colors.good : colors.bad } })
      at = i + 1
    }
    if (at < t.length) out.push({ text: t.slice(at), style: null })
    return out
  }

  /** A text as runs of a line, its ✓ and × in their colors (glyphParts). */
  const glyphRuns = text => glyphParts(text).map(p => (p.style ? { text: p.text, ...p.style } : p.text))

  // ------------------------------------------------------------------------------------------------- numbers and times

  const isNum = v => typeof v === 'number' && isFinite(v)
  /** A number read from a value: a number, or a string that is one; null for any other. */
  const numOf = v => (isNum(v) ? v : typeof v === 'string' && v.trim() !== '' && isFinite(Number(v)) ? Number(v) : null)

  /** A number in few characters, for an axis: 12k, 1.2M. */
  function short(v) {
    const a = Math.abs(v)
    const one = (x, unit) => `${num(x, Math.abs(x) < 10 ? 1 : 0).replace(/\.0$/, '')}${unit}`
    if (a >= 1e9) return one(v / 1e9, 'B')
    if (a >= 1e6) return one(v / 1e6, 'M')
    if (a >= 1e4) return one(v / 1e3, 'k')
    return num(v, a > 0 && a < 1 ? 2 : a < 10 && !Number.isInteger(v) ? 1 : 0)
  }

  /** A time to place a value by: {at, form}, `at` in milliseconds for an ISO date or time (UTC when it names no zone)
   *  and for a clock time ("09:14", "1:02:30", from the day's start), the number itself for a number; null for any
   *  other value. */
  function timeOf(v) {
    if (isNum(v)) return { at: v, form: 'number' }
    const s = flat(v)
    let m = /^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(s)
    if (m) {
      const [, y, mo, d, h, mi, se, frac, zone] = m
      let at = Date.UTC(+y, +mo - 1, d ? +d : 1, h ? +h : 0, mi ? +mi : 0, se ? +se : 0, frac ? Math.round(Number(`0.${frac}`) * 1000) : 0)
      if (zone && zone.toUpperCase() !== 'Z') at -= (zone[0] === '-' ? -1 : 1) * (+zone.slice(1, 3) * 60 + +zone.slice(-2)) * 60000
      return isFinite(at) ? { at, form: h ? 'datetime' : d ? 'date' : 'month' } : null
    }
    m = /^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/.exec(s)
    if (m) return { at: (+m[1] * 3600 + +m[2] * 60 + (m[3] ? +m[3] : 0)) * 1000, form: 'clock' }
    const n = numOf(s)
    return n === null ? null : { at: n, form: 'number' }
  }

  const two = n => String(n).padStart(2, '0')
  const dayOf = at => { const d = new Date(at); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}` }
  const clockOf = (at, secs) => { const d = new Date(at); return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}${secs ? `:${two(d.getUTCSeconds())}` : ''}` }

  /** A time as an axis writes it, in the unit its span reads in: a year and month, a day, or a clock time. */
  function timeText(at, form, span) {
    if (form === 'number') return short(at)
    if (form === 'clock') {
      const s = Math.round(at / 1000)
      return `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}${span < 600000 ? `:${two(s % 60)}` : ''}`
    }
    const d = new Date(at)
    if (form === 'month' || span >= 120 * 86400000) return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
    if (form === 'date' || span >= 2 * 86400000) return dayOf(at)
    return clockOf(at, span < 600000)
  }

  /** A length of time in words: 45 s, 12 min, 2 h 31 min, 3 days. */
  function lasting(ms, form) {
    if (form === 'number') return short(ms)
    const s = Math.round(Math.abs(ms) / 1000)
    if (s < 60) return `${s} s`
    if (s < 3600) return `${Math.round(s / 60)} min`
    if (s < 86400) { const h = Math.floor(s / 3600), mi = Math.round((s % 3600) / 60); return mi ? `${h} h ${mi} min` : `${h} h` }
    const days = Math.round(s / 86400)
    return `${days} ${days === 1 ? 'day' : 'days'}`
  }

  /** Round steps for an axis from lo to hi, about `n` of them: 1, 2 or 5 times a power of ten. */
  function steps(lo, hi, n) {
    if (!(hi > lo)) return [lo]
    const raw = (hi - lo) / Math.max(1, n)
    const p = Math.pow(10, Math.floor(Math.log10(raw)))
    const step = [1, 2, 5, 10].map(k => k * p).find(s => s >= raw) || 10 * p
    const out = []
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v)
    return out
  }

  /** An axis's ticks from lo to hi: four times spread evenly over it, or its round numbers. */
  function ticksOf(lo, hi, time, form) {
    const span = hi - lo
    return time
      ? [0, 0.33, 0.67, 1].map(f => ({ x: f, text: timeText(lo + f * span, form, span) }))
      : steps(lo, hi, 4).map(v => ({ x: span ? (v - lo) / span : 0, text: short(v) }))
  }

  /** An axis line `n` cells wide: each label at its tick's cell (the last one ending at its cell when it would run
   *  past the end), a label that would touch the one before it left out. ticks: [{x, text}], x from 0 to 1. */
  function axisLine(ticks, n, indent) {
    let line = ''
    let used = 0
    ticks.forEach((t, i) => {
      const at = Math.round(t.x * (n - 1))
      const w = cells(t.text)
      let start = at
      if (start + w > n) start = n - w
      if (i === ticks.length - 1 && start < used + 1 && ticks.length > 1) return
      if (start < (used ? used + 1 : 0)) return
      line = padEnd(line, start) + t.text
      used = start + w
    })
    return [gray(' '.repeat(indent) + line)]
  }

  // ------------------------------------------------------------------------------------------------- pages

  const list = v => (isArray(v) ? v : v == null ? [] : [v])
  const width = () => Math.max(20, Math.floor(Number(surface.columns) || 80))

  /** The kind's drawing at the card's width: {answer, lines, pages, page}, its answer, then the lines before its items,
   *  one page of its items (each a block of lines: a row, an event, a record), the line that says which page shows, and
   *  the lines after them. */
  function laid(props) {
    const spec = props && props.data && typeof props.data === 'object' && !isArray(props.data) ? props.data : {}
    const draw = DRAW[spec.kind]
    if (!draw) throw new Error(`the card's data names no kind thimble draws (${KINDS_LIST}): ${flat(spec.kind) || 'none'}`)
    const W = width()
    const answer = flat(spec.answer)
    // the answer's rows as the terminal wraps it, and the blank row under it
    const top = answer ? [...wrap(answer, W).map(() => null), []] : []
    const body = draw(spec, W)
    const before = body.before || []
    const after = body.after || []
    const blocks = (body.blocks || []).filter(b => b.lines.length)
    const room = Math.max(4, ROWS - top.length - before.length - after.length)
    let pages = pack(blocks, room)
    if (pages.length > 1) pages = pack(blocks, room - 2)
    const st = surface.state && typeof surface.state === 'object' ? surface.state : {}
    const page = Math.max(0, Math.min(pages.length - 1, Math.trunc(Number(st.page) || 0)))
    const shown = pages[page] || []
    const lines = [...before, ...shown.flatMap(b => b.lines)]
    if (pages.length > 1) {
      const first = pages.slice(0, page).reduce((a, p) => a + p.length, 0)
      lines.push([], [gray(`${body.unit || 'rows'} ${first + 1}-${first + shown.length} of ${num(blocks.length)}`)])
    }
    lines.push(...after)
    return { answer, lines: lines.map(l => fitLine(l, W)), pages: pages.length, page }
  }

  /** Blocks in pages of at most `room` lines, a block never split (one longer than a page has a page of its own, cut
   *  to fit). */
  function pack(blocks, room) {
    const pages = []
    let cur = []
    let used = 0
    for (const b0 of blocks) {
      const b = b0.lines.length > room ? { ...b0, lines: b0.lines.slice(0, room) } : b0
      if (cur.length && used + b.lines.length > room) { pages.push(cur); cur = []; used = 0 }
      cur.push(b)
      used += b.lines.length
    }
    if (cur.length || !pages.length) pages.push(cur)
    return pages
  }

  // ------------------------------------------------------------------------------------------------- table

  /** Rows as a table: each key a column in the order the rows first give it, sized to its longest value, numbers at
   *  the right with one count of decimals, ✓ and × in their colors; the first column names each row, its values as
   *  given (a PR's number is a name, not an amount). When the columns
   *  do not fit, text columns are cut, the widest first, keeping the part of each value that tells it apart, the first
   *  column no narrower than a third of the card; the last columns that still do not fit are named under the table. */
  function table(spec, W) {
    const rows = list(spec.rows).map(r => (r && typeof r === 'object' && !isArray(r) ? r : { value: r }))
    const cols = []
    for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k)
    const numeric = cols.map((c, i) => i > 0 && rows.some(r => isNum(r[c])) && rows.every(r => r[c] == null || r[c] === '' || isNum(r[c])))
    const decimals = cols.map((c, i) => (numeric[i] ? Math.min(2, Math.max(0, ...rows.map(r => (isNum(r[c]) && !Number.isInteger(r[c]) ? (String(r[c]).split('.')[1] || '').length : 0)))) : 0))
    const text = (v, i) => (v == null || v === '' ? '' : typeof v === 'boolean' ? (v ? '✓' : '×') : numeric[i] ? num(v, decimals[i]) : flat(v))
    const body = rows.map(r => cols.map((c, i) => text(r[c], i)))
    let widths = cols.map((c, i) => Math.max(cells(c), ...body.map(b => cells(b[i]))))
    const total = ws => ws.reduce((a, w) => a + w, 0) + 2 * Math.max(0, ws.length - 1)
    // text columns give up cells, the widest first, down to 8 (or their header), the names of the rows to a third of the card
    const least = cols.map((c, i) => (numeric[i] ? widths[i] : Math.min(widths[i], i ? Math.max(8, Math.min(cells(c), 12)) : Math.max(12, Math.floor(W / 3)))))
    while (total(widths) > W) {
      let at = -1
      widths.forEach((w, i) => { if (w > least[i] && (at < 0 || w > widths[at])) at = i })
      if (at < 0) break
      widths[at]--
    }
    let shown = cols.length
    while (shown > 1 && total(widths.slice(0, shown)) > W) shown--
    widths = widths.slice(0, shown)
    if (total(widths) > W) widths[0] = Math.max(1, W - total(widths) + widths[0])
    // a value cut to its column keeps the part that tells it apart (cutter)
    const cuts = cols.slice(0, shown).map((c, i) => cutter(body.map(b => b[i]), widths[i]))
    const cell = (v, i) => {
      const t = cuts[i](v)
      return numeric[i] ? padStart(t, widths[i]) : padEnd(t, widths[i])
    }
    const header = cols.slice(0, shown).flatMap((c, i) => [...(i ? ['  '] : []), gray(numeric[i] ? padStart(cut(c, widths[i]), widths[i]) : padEnd(cut(c, widths[i]), widths[i]))])
    const blocks = body.map(b => ({
      lines: [b.slice(0, shown).flatMap((v, i) => {
        const t = cell(v, i)
        return [...(i ? ['  '] : []), ...(numeric[i] ? [t] : glyphRuns(t))]
      })],
    }))
    const left = cols.slice(shown)
    return {
      before: [header],
      blocks,
      after: left.length ? [[gray(cut(`+${left.length} ${left.length === 1 ? 'column' : 'columns'}: ${left.join(', ')}`, W))]] : [],
      unit: 'rows',
    }
  }

  // ------------------------------------------------------------------------------------------------- chart

  const MARKS = ['bar', 'line', 'scatter', 'dots', 'range', 'heatmap']

  /** The rows' values of a column, and what they are: numbers, times or text. */
  function field(rows, name) {
    const vals = rows.map(r => r[name])
    const present = vals.filter(v => v != null && v !== '')
    if (present.length && present.every(isNum)) return { vals, type: 'number' }
    const times = present.map(timeOf)
    if (present.length && times.every(t => t && t.form !== 'number')) return { vals, type: 'time', form: times[0].form }
    if (present.length && present.every(v => numOf(v) !== null)) return { vals: vals.map(numOf), type: 'number' }
    return { vals, type: 'text' }
  }

  /** The colors of a column's values, in the order the rows first give them: the palette's categories, green and red
   *  for values people read as a success or a failure, gray past the palette's five. */
  function legendOf(values) {
    const order = []
    for (const v of values) { const k = flat(v); if (!order.includes(k)) order.push(k) }
    let next = 0
    const color = {}
    for (const k of order) color[k] = meaning(k) || (next < colors.cat.length ? colors.cat[next++] : colors.gray)
    return { order, color }
  }

  /** The legend: a sample of each color and what it stands for, on as many lines as it takes, at most three. */
  function legend(lg, W, glyph) {
    const lines = [[]]
    let used = 0
    lg.order.forEach((k, i) => {
      if (lines.length > 3) return
      const name = cut(k || '(none)', Math.max(4, W - 2))
      const w = cells(name) + 2
      if (used && used + 2 + w > W) {
        if (lines.length === 3) { lines[2].push(gray(`  +${lg.order.length - i} more`)); lines.push(null); return }
        lines.push([])
        used = 0
      }
      const line = lines[lines.length - 1]
      if (used) line.push('  ')
      line.push({ text: glyph, color: lg.color[k] }, ` ${name}`)
      used += (used ? 2 : 0) + w
    })
    return [...lines.filter(Boolean), []]
  }

  /** How to cut the names of a column `n` cells wide, so that each keeps the part that tells it apart: the start they
   *  all share said as …, then each cut at its end, or in its middle where the start a cut at the end keeps begins
   *  another name too. */
  function cutter(values, n) {
    const vals = [...new Set(values.map(v => String(v)).filter(Boolean))]
    let shared = ''
    if (vals.length > 1 && vals.some(v => cells(v) > n)) {
      const pre = vals.reduce((p, v) => { let k = 0; while (k < p.length && k < v.length && p[k] === v[k]) k++; return p.slice(0, k) }, vals[0])
      const edge = Math.max(...['/', '_', '-', ' ', '.', ':'].map(ch => pre.lastIndexOf(ch))) + 1
      if (edge >= 4) shared = pre.slice(0, edge)
    }
    const rest = t => (shared && t.startsWith(shared) ? t.slice(shared.length) : t)
    const one = (t, middle) => {
      if (cells(t) <= n) return t
      if (shared && t.startsWith(shared)) return '…' + cut(rest(t), n - 1, middle)
      return cut(t, n, middle)
    }
    const middle = vals.some(v => {
      const c = one(v, false)
      const kept = c.replace(/^…/, '').replace(/…$/, '')
      return c.endsWith('…') && vals.some(o => o !== v && rest(o).startsWith(kept))
    })
    return v => one(String(v), middle)
  }

  /** A chart of the rows by its mark, once each column its x, y, x2 and color name is one the rows have. */
  function chart(spec, W) {
    const mark = flat(spec.mark || 'bar').toLowerCase()
    const draw = { bar: bars, line: lines, scatter: plot, dots, range: ranges, heatmap }[mark]
    if (!draw) throw new Error(`a chart's mark is one of ${MARKS.join(', ')}, not ${flat(spec.mark)}`)
    const rows = list(spec.rows).filter(r => r && typeof r === 'object' && !isArray(r))
    const cols = []
    for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k)
    for (const enc of ['x', 'y', 'x2', 'color']) {
      if (spec[enc] != null && spec[enc] !== '' && !cols.includes(String(spec[enc]))) throw new Error(`the chart's ${enc} is "${flat(spec[enc])}", which no row has; the rows' columns are ${cols.join(', ') || 'none'}`)
    }
    return draw(spec, rows, W, mark)
  }

  /** Bars: the value of each category, summed over its rows (a count of rows when y is left out), split by color into
   *  segments. Named categories go down the side, each with its bar and its value; categories that are times go
   *  across, as columns over a time axis. */
  function bars(spec, rows, W) {
    if (!spec.x) throw new Error('a bar chart needs x, the column of its categories')
    let cat = String(spec.x)
    let val = spec.y ? String(spec.y) : null
    // the value is the column of numbers: x when the call names the axes the other way round
    if (val && field(rows, cat).type === 'number' && field(rows, val).type !== 'number') [cat, val] = [val, cat]
    if (val && field(rows, val).type !== 'number') throw new Error(`a bar chart's value column, ${val}, holds values that are not numbers`)
    const group = spec.color ? String(spec.color) : null
    const sums = new Map()
    const seen = []
    for (const r of rows) {
      const k = flat(r[cat])
      if (!sums.has(k)) { sums.set(k, new Map()); seen.push(r[cat]) }
      const g = group ? flat(r[group]) : ''
      const v = val ? numOf(r[val]) ?? 0 : 1
      sums.get(k).set(g, (sums.get(k).get(g) || 0) + v)
    }
    const lg = group ? legendOf(rows.map(r => r[group])) : null
    const groups = lg ? lg.order : ['']
    const cats = [...sums.keys()]
    const totals = cats.map(k => [...sums.get(k).values()].reduce((a, v) => a + v, 0))
    const across = field(seen.map(v => ({ v })), 'v').type === 'time' && cats.length > 1
    if (across) return columns(spec, cats, seen, sums, groups, lg, totals, W)
    const labelW = Math.min(Math.max(...cats.map(k => cells(k || '(none)')), 1), Math.max(6, Math.floor(W * 0.4)))
    // each bar's value right after it: its total, and with a few groups the sum of their values, each in its color in
    // the legend's order (`13 = 10 + 3`)
    const valueOf = (k, i) => {
      const runs = [bold(num(totals[i]))]
      if (group && groups.length > 1 && groups.length <= 4) groups.forEach((g, j) => runs.push(gray(j ? ' + ' : ' = '), { text: num(sums.get(k).get(g) || 0), color: lg.color[g] }))
      return runs
    }
    const values = cats.map(valueOf)
    const valueW = Math.max(...values.map(widthOf))
    // bars no longer than 60 cells, so that on a wide screen each value stays near the name it belongs to
    const room = Math.max(4, Math.min(60, W - labelW - valueW - 2))
    const top = Math.max(...totals.map(t => Math.abs(t)), 0)
    const neg = totals.some(t => t < 0)
    const name = cutter(cats.map(k => k || '(none)'), labelW)
    const blocks = cats.map((k, i) => {
      const parts = groups.map(g => sums.get(k).get(g) || 0)
      const line = [padEnd(name(k || '(none)'), labelW), ' ']
      let drawn = 0
      if (top && group && groups.length > 1) {
        // whole cells per segment, rounded so that the segments add up to the bar's length
        const len = Math.round((Math.abs(totals[i]) / top) * room)
        let acc = 0
        parts.forEach((v, j) => {
          acc += Math.abs(v)
          const upto = Math.round((acc / (Math.abs(totals[i]) || 1)) * len)
          const n = Math.max(0, upto - drawn)
          drawn += n
          if (n) line.push({ text: '█'.repeat(n), color: lg.color[groups[j]] })
        })
      } else if (top) {
        const eighths = Math.round((Math.abs(totals[i]) / top) * room * 8)
        const bar = '█'.repeat(Math.floor(eighths / 8)) + (eighths % 8 ? '▏▎▍▌▋▊▉'[eighths % 8 - 1] : '')
        line.push({ text: bar, color: neg && totals[i] < 0 ? colors.bad : group ? lg.color[groups[0]] : colors.cat[0] })
        drawn = cells(bar)
      }
      line.push(drawn ? ' ' : '', ...values[i])
      return { lines: [line] }
    })
    return { before: lg && groups.length > 1 ? legend(lg, W, '█') : [], blocks, unit: 'rows' }
  }

  /** Bars over a time axis: a column for each category (summed in groups of neighbors when they outnumber the cells),
   *  its height in eighths of a row, the largest value at the axis's top. */
  function columns(spec, cats, seen, sums, groups, lg, totals, W) {
    const times = seen.map(v => timeOf(v))
    const order = cats.map((k, i) => i).sort((a, b) => times[a].at - times[b].at)
    // the categories in bins of neighbors when they outnumber the cells, and the axis's labels as wide as its top
    let gutter = cells(num(Math.max(...totals, 0))) + 1
    let bins = []
    let per = 1
    for (let pass = 0; pass < 2; pass++) {
      per = Math.max(1, Math.ceil(order.length / (W - gutter)))
      bins = []
      for (let i = 0; i < order.length; i += per) bins.push(order.slice(i, i + per))
      const widest = cells(num(Math.max(...bins.map(b => b.reduce((a, i) => a + totals[i], 0)), 0))) + 1
      if (widest <= gutter) break
      gutter = widest
    }
    const wide = Math.max(1, Math.min(3, Math.floor((W - gutter) / bins.length)))
    const binTotals = bins.map(b => b.reduce((a, i) => a + Math.max(0, totals[i]), 0))
    const top = Math.max(...binTotals, 0) || 1
    const H = 10
    const lines = []
    for (let row = H - 1; row >= 0; row--) {
      const line = [gray(padStart(row === H - 1 ? num(top) : row === 0 ? '0' : '', gutter - 1) + ' ')]
      for (const [bi, b] of bins.entries()) {
        const parts = groups.map(g => b.reduce((a, i) => a + Math.max(0, sums.get(cats[i]).get(g) || 0), 0))
        const eighths = Math.round((binTotals[bi] / top) * H * 8)
        let glyph = ' '
        let color = colors.cat[0]
        if (lg && groups.length > 1) {
          // stacked in whole cells: a cell takes the color of the group at its height
          const high = Math.round(eighths / 8)
          if (row < high) {
            let acc = 0
            const mid = ((row + 0.5) / high) * binTotals[bi]
            const j = parts.findIndex(v => (acc += v) >= mid)
            glyph = '█'
            color = lg.color[groups[Math.max(0, j)]]
          }
        } else {
          const full = Math.floor(eighths / 8)
          glyph = row < full ? '█' : row === full && eighths % 8 ? '▁▂▃▄▅▆▇'[eighths % 8 - 1] : ' '
        }
        line.push(glyph === ' ' ? ' '.repeat(wide) : { text: glyph.repeat(wide > 1 ? wide - 1 : 1) + (wide > 1 ? ' ' : ''), color })
      }
      lines.push(line)
    }
    const at = times.map(t => t.at)
    const span = Math.max(...at) - Math.min(...at)
    const n = bins.length
    const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(f * (n - 1))).filter((v, i, a) => a.indexOf(v) === i)
      .map(i => ({ x: n > 1 ? (i * wide) / (n * wide - 1 || 1) : 0, text: timeText(times[bins[i][0]].at, times[bins[i][0]].form, span) }))
    lines.push(axisLine(ticks, n * wide, gutter))
    const unit = times[0].form === 'date' ? 'days' : times[0].form === 'month' ? 'months' : `${spec.x} values`
    const note = per > 1 ? [[gray(cut(`${per} ${unit} summed in each column`, W))]] : []
    return { before: lg && groups.length > 1 ? legend(lg, W, '█') : [], blocks: [{ lines: [...lines, ...note] }], unit: 'rows' }
  }

  /** A braille canvas `w` cells by `h` rows: each cell holds 2 by 4 dots, and takes the color of the series that set
   *  most of its dots. */
  function canvas(w, h) {
    const dots = new Uint8Array(w * h)
    const votes = new Map()
    const BIT = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]]
    return {
      set(px, py, series) {
        const x = Math.round(px)
        const y = Math.round(py)
        if (x < 0 || y < 0 || x >= w * 2 || y >= h * 4) return
        const c = Math.floor(y / 4) * w + Math.floor(x / 2)
        dots[c] |= BIT[y % 4][x % 2]
        const v = votes.get(c) || {}
        v[series] = (v[series] || 0) + 1
        votes.set(c, v)
      },
      row(r, color) {
        const out = []
        for (let x = 0; x < w; x++) {
          const c = r * w + x
          if (!dots[c]) { out.push(' '); continue }
          const v = votes.get(c)
          const best = Object.keys(v).sort((a, b) => v[b] - v[a] || Number(b) - Number(a))[0]
          out.push({ text: String.fromCharCode(0x2800 + dots[c]), color: color(Number(best)) })
        }
        // neighbors of one color as one run
        const merged = []
        for (const r2 of out) {
          const last = merged[merged.length - 1]
          if (last && typeof r2 !== 'string' && typeof last !== 'string' && last.color === r2.color) last.text += r2.text
          else if (last && typeof r2 === 'string' && typeof last === 'string') merged[merged.length - 1] = last + r2
          else merged.push(typeof r2 === 'string' ? r2 : { ...r2 })
        }
        return merged
      },
    }
  }

  /** A line chart: y against x (numbers or times) as a filled strip, its height in eighths of a row at each cell of x,
   *  read on the line between the rows' points. With `color`, a strip for each series, one under another on one scale,
   *  named at its left with its last value at its right, so series that cross stay apart, and read in the text copy. */
  function lines(spec, rows, W) {
    if (!spec.x || !spec.y) throw new Error('a line chart needs x and y, the columns of its two axes')
    const xs = field(rows, String(spec.x))
    const ys = field(rows, String(spec.y))
    if (ys.type !== 'number') throw new Error(`a line chart's y, ${spec.y}, holds values that are not numbers`)
    if (xs.type === 'text') throw new Error(`a line chart's x, ${spec.x}, holds values that are neither numbers nor times`)
    const lg = spec.color ? legendOf(rows.map(r => r[spec.color])) : null
    const names = lg ? lg.order : ['']
    const pts = rows.map((r, i) => ({ x: xs.type === 'time' ? (timeOf(xs.vals[i]) || {}).at : xs.vals[i], y: ys.vals[i], s: lg ? flat(r[spec.color]) : '' }))
      .filter(p => isNum(p.x) && isNum(p.y))
    if (!pts.length) throw new Error('no row has both an x and a y the line chart can place')
    const series = names.map(k => pts.filter(p => p.s === k).sort((a, b) => a.x - b.x)).filter(ps => ps.length)
    const x0 = Math.min(...pts.map(p => p.x))
    const x1 = Math.max(...pts.map(p => p.x))
    let y0 = Math.min(...pts.map(p => p.y))
    let y1 = Math.max(...pts.map(p => p.y))
    // amounts start at zero unless they all lie far above it
    if (y0 >= 0 && y0 < y1 / 2) y0 = 0
    if (y1 === y0) y1 = y0 + 1
    const many = series.length > 1
    const lastOf = ps => ps[ps.length - 1].y
    const labelW = many ? Math.min(Math.max(...names.map(k => cells(k || '(none)'))), Math.floor(W * 0.3)) : 0
    const valueW = many ? Math.max(...series.map(ps => cells(num(lastOf(ps))))) : 0
    const gutter = many ? 0 : Math.max(cells(short(y1)), cells(short(y0))) + 1
    const w = Math.max(8, W - (many ? labelW + valueW + 2 : gutter + 1))
    const h = many ? Math.max(1, Math.min(4, Math.floor((ROWS - 8) / series.length))) : 8
    // the line's value at each cell of x, read between the points around the cell's middle; none outside the series
    const valueAt = (ps, c) => {
      const x = x1 > x0 ? x0 + ((c + 0.5) / w) * (x1 - x0) : x0
      const half = (x1 - x0) / w / 2
      if (x < ps[0].x - half || x > ps[ps.length - 1].x + half) return null
      if (x <= ps[0].x) return ps[0].y
      for (let i = 1; i < ps.length; i++) {
        if (x <= ps[i].x) return ps[i].x > ps[i - 1].x ? ps[i - 1].y + ((ps[i].y - ps[i - 1].y) * (x - ps[i - 1].x)) / (ps[i].x - ps[i - 1].x) : ps[i].y
      }
      return lastOf(ps)
    }
    // a strip's rows, top first: each cell filled from the bottom to its value, in eighths of a row; where the series
    // runs at the bottom of the scale, a gray dot on the strip's last row, so the strip shows where the series is
    const strip = (ps, color) => {
      const eighths = Array.from({ length: w }, (_, c) => { const v = valueAt(ps, c); return v === null ? null : Math.round(((v - y0) / (y1 - y0)) * h * 8) })
      return Array.from({ length: h }, (_, k) => {
        const row = h - 1 - k
        const runs = []
        for (const e of eighths) {
          const ch = e === null || (e <= row * 8 && (row || e > 0)) ? ' ' : e <= 0 ? '·' : e >= (row + 1) * 8 ? '█' : '▁▂▃▄▅▆▇'[e - row * 8 - 1]
          const look = ch === ' ' ? null : ch === '·' ? colors.gray : color
          const last = runs[runs.length - 1]
          if (last && last.look === look) last.text += ch
          else runs.push({ text: ch, look })
        }
        return runs.map(r => (r.look ? { text: r.text, color: r.look } : r.text))
      })
    }
    const lines = []
    if (many) {
      series.forEach((ps, n) => strip(ps, lg.color[ps[0].s]).forEach((runs, k) => {
        const lastRow = k === h - 1
        lines.push([padEnd(lastRow ? cutter(names.map(x => x || '(none)'), labelW)(ps[0].s || '(none)') : '', labelW), ' ', ...runs, ' ', ...(lastRow ? [bold(padStart(num(lastOf(ps)), valueW))] : [])])
      }))
    } else {
      strip(series[0], colors.cat[0]).forEach((runs, k) => lines.push([gray(padStart(k === 0 ? short(y1) : k === h - 1 ? short(y0) : '', gutter - 1) + ' '), ...runs]))
    }
    lines.push(axisLine(ticksOf(x0, x1, xs.type === 'time', xs.form), w, many ? labelW + 1 : gutter))
    lines.push([gray(padStart(cut(String(spec.x), w), (many ? labelW + 1 : gutter) + w))])
    const scale = many ? `${spec.y}, each strip from ${short(y0)} to ${short(y1)}` : String(spec.y)
    return { before: [[gray(cut(scale, W))]], blocks: [{ lines }], unit: 'rows' }
  }

  /** A scatter chart: y against x (numbers or times) in braille dots, one color for each group of `color`. */
  function plot(spec, rows, W, mark) {
    if (!spec.x || !spec.y) throw new Error(`a ${mark} chart needs x and y, the columns of its two axes`)
    const xs = field(rows, String(spec.x))
    const ys = field(rows, String(spec.y))
    if (ys.type !== 'number') throw new Error(`a ${mark} chart's y, ${spec.y}, holds values that are not numbers`)
    if (xs.type === 'text') throw new Error(`a ${mark} chart's x, ${spec.x}, holds values that are neither numbers nor times`)
    const lg = spec.color ? legendOf(rows.map(r => r[spec.color])) : null
    const pts = rows.map((r, i) => ({ x: xs.type === 'time' ? (timeOf(xs.vals[i]) || {}).at : xs.vals[i], y: ys.vals[i], s: lg ? lg.order.indexOf(flat(r[spec.color])) : 0 }))
      .filter(p => isNum(p.x) && isNum(p.y))
    if (!pts.length) throw new Error(`no row has both an x and a y the ${mark} chart can place`)
    const x0 = Math.min(...pts.map(p => p.x))
    const x1 = Math.max(...pts.map(p => p.x))
    let y0 = Math.min(...pts.map(p => p.y))
    const y1 = Math.max(...pts.map(p => p.y))
    // amounts start at zero unless they all lie far above it
    if (y0 >= 0 && y0 < y1 / 2) y0 = 0
    const labels = [short(y1), short(y0)]
    const gutter = Math.max(...labels.map(cells)) + 1
    const w = Math.max(8, W - gutter - 1)
    const h = Math.max(4, Math.min(12, ROWS - 10))
    const cv = canvas(w, h)
    const px = x => (x1 > x0 ? ((x - x0) / (x1 - x0)) * (w * 2 - 1) : 0)
    const py = y => (y1 > y0 ? (1 - (y - y0) / (y1 - y0)) * (h * 4 - 1) : h * 2)
    const series = lg ? lg.order.map((k, s) => pts.filter(p => p.s === s)) : [pts]
    series.forEach((ps, s) => ps.forEach(p => cv.set(px(p.x), py(p.y), s)))
    const colorOf = s => (lg ? lg.color[lg.order[s]] : colors.cat[0])
    const lines = []
    for (let r = 0; r < h; r++) {
      const label = r === 0 ? labels[0] : r === h - 1 ? labels[1] : ''
      lines.push([gray(padStart(label, gutter - 1) + ' ' + (label ? '┤' : '│')), ...cv.row(r, colorOf)])
    }
    lines.push(axisLine(ticksOf(x0, x1, xs.type === 'time', xs.form), w, gutter + 1))
    if (spec.x) lines.push([gray(padStart(cut(String(spec.x), w), gutter + 1 + w))])
    const before = lg && lg.order.length > 1 ? legend(lg, W, '●') : []
    return { before: [...before, [gray(cut(String(spec.y), W))]], blocks: [{ lines }], unit: 'rows' }
  }

  /** A strip for each row of `y`: each row of data a dot at its x (a number or a time) on a track, a place that holds
   *  more than one showing how many (2 to 9, + for more), and the strip's count at its right. Where two such counts
   *  would touch and read as one number, each place takes two cells. */
  function dots(spec, rows, W) {
    if (!spec.x || !spec.y) throw new Error('a dots chart needs x, the number or time of each dot, and y, the row it stands in')
    const xs = field(rows, String(spec.x))
    if (xs.type === 'text') throw new Error(`a dots chart's x, ${spec.x}, holds values that are neither numbers nor times`)
    const at = xs.vals.map(v => (xs.type === 'time' ? (timeOf(v) || {}).at : numOf(v)))
    const lg = spec.color ? legendOf(rows.map(r => r[spec.color])) : null
    const names = []
    for (const r of rows) { const k = flat(r[spec.y]); if (!names.includes(k)) names.push(k) }
    const ok = at.filter(isNum)
    if (!ok.length) throw new Error('no row has an x the dots chart can place')
    const x0 = Math.min(...ok)
    const x1 = Math.max(...ok)
    const counts = names.map(k => rows.filter((r, i) => flat(r[spec.y]) === k && isNum(at[i])).length)
    const labelW = Math.min(Math.max(...names.map(k => cells(k || '(none)'))), Math.floor(W * 0.35))
    const countW = Math.max(...counts.map(c => cells(num(c))))
    const w = Math.max(8, W - labelW - countW - 3)
    // each row's dots by place, with `slots` places across the strip
    const placed = slots => names.map(k => {
      const hits = new Map()
      rows.forEach((r, i) => {
        if (flat(r[spec.y]) !== k || !isNum(at[i])) return
        const c = x1 > x0 ? Math.round(((at[i] - x0) / (x1 - x0)) * (slots - 1)) : 0
        const h = hits.get(c) || { n: 0, groups: {} }
        h.n++
        const g = lg ? flat(r[spec.color]) : ''
        h.groups[g] = (h.groups[g] || 0) + 1
        hits.set(c, h)
      })
      return hits
    })
    let step = 1
    let hits = placed(w)
    if (hits.some(hs => [...hs.keys()].some(c => hs.get(c).n > 1 && (hs.get(c + 1) || {}).n > 1))) {
      step = 2
      hits = placed(Math.floor(w / 2))
    }
    const name = cutter(names.map(k => k || '(none)'), labelW)
    const blocks = names.map((k, n) => {
      const line = [padEnd(name(k || '(none)'), labelW), ' ']
      let track = ''
      const flush = () => { if (track) { line.push(gray(track)); track = '' } }
      for (let c = 0; c < Math.floor(w / step); c++) {
        const h = hits[n].get(c)
        if (!h) { track += '─'.repeat(step); continue }
        flush()
        const g = Object.keys(h.groups).sort((a, b) => h.groups[b] - h.groups[a])[0]
        line.push({ text: h.n === 1 ? '●' : h.n < 10 ? String(h.n) : '+', color: lg ? lg.color[g] : undefined, bold: h.n > 1 })
        if (step > 1) track += '─'
      }
      track += '─'.repeat(w - Math.floor(w / step) * step)
      flush()
      line.push(' ', bold(padStart(num(counts[n]), countW)))
      return { lines: [line] }
    })
    const ticks = ticksOf(x0, x1, xs.type === 'time', xs.form)
    const several = hits.some(hs => [...hs.values()].some(h => h.n > 1))
    return {
      before: [...(lg && lg.order.length > 1 ? legend(lg, W, '●') : []), ...(several ? [[gray('● one  2-9 several together')], []] : [])],
      blocks,
      after: [axisLine(ticks, w, labelW + 1), [gray(padStart(cut(String(spec.x), w), labelW + 1 + w))]],
      unit: 'rows',
    }
  }

  /** A span for each row of `y`, from x to x2 (numbers or times), on one axis; colored by `color`. */
  function ranges(spec, rows, W) {
    if (!spec.y || !spec.x || !spec.x2) throw new Error('a range chart needs y, the item of each row, and x and x2, where its span starts and ends')
    const xs = field(rows, String(spec.x))
    const x2s = field(rows, String(spec.x2))
    if (xs.type === 'text' || x2s.type === 'text') throw new Error(`a range chart's x and x2 hold numbers or times; ${xs.type === 'text' ? spec.x : spec.x2} holds other values`)
    const place = (f, v) => (f.type === 'time' ? (timeOf(v) || {}).at : numOf(v))
    const items = rows.map((r, i) => ({ k: flat(r[spec.y]), a: place(xs, xs.vals[i]), b: place(x2s, x2s.vals[i]), g: spec.color ? flat(r[spec.color]) : '' }))
      .filter(it => isNum(it.a) && isNum(it.b))
    if (!items.length) throw new Error('no row has an x and an x2 the range chart can place')
    const lo = Math.min(...items.map(it => Math.min(it.a, it.b)))
    const hi = Math.max(...items.map(it => Math.max(it.a, it.b)))
    const lg = spec.color ? legendOf(rows.map(r => r[spec.color])) : null
    const labelW = Math.min(Math.max(...items.map(it => cells(it.k || '(none)'))), Math.floor(W * 0.35))
    const w = Math.max(8, W - labelW - 1)
    const col = x => (hi > lo ? ((x - lo) / (hi - lo)) * w : 0)
    const name = cutter(items.map(it => it.k || '(none)'), labelW)
    const blocks = items.map(it => {
      const a = Math.min(col(it.a), col(it.b))
      const b = Math.max(col(it.a), col(it.b))
      const s = Math.min(w - 1, Math.floor(a))
      const e = Math.max(s + 1, Math.min(w, Math.ceil(b)))
      return { lines: [[padEnd(name(it.k || '(none)'), labelW), ' ', gray('─'.repeat(s)), { text: '█'.repeat(e - s), color: lg ? lg.color[it.g] : colors.cat[0] }, gray('─'.repeat(w - e))]] }
    })
    return { before: lg && lg.order.length > 1 ? legend(lg, W, '█') : [], blocks, after: [axisLine(ticksOf(lo, hi, xs.type === 'time', xs.form), w, labelW + 1)], unit: 'rows' }
  }

  /** A grid of x by y, each cell's value (summed over its rows; a count of rows when color is left out) as a shade:
   *  ░ ▒ ▓ █ by its quarter of the cells, ranked by value, so one large cell leaves the pattern of the rest in sight,
   *  with the range of each shade in the legend; in the palette's sequence, darker for more on a light terminal and
   *  brighter on a dark one, and in the text copy too; an empty cell a gray dot. */
  function heatmap(spec, rows, W) {
    if (!spec.x || !spec.y) throw new Error('a heatmap needs x and y, the columns of its two sides, and color, the column of each cell\'s value (left out: a count of rows)')
    const val = spec.color ? String(spec.color) : null
    if (val && field(rows, val).type !== 'number') throw new Error(`a heatmap's color, ${val}, holds values that are not numbers`)
    const xk = []
    const yk = []
    const sum = new Map()
    for (const r of rows) {
      const x = flat(r[spec.x])
      const y = flat(r[spec.y])
      if (!xk.includes(x)) xk.push(x)
      if (!yk.includes(y)) yk.push(y)
      sum.set(`${y}\u0000${x}`, (sum.get(`${y}\u0000${x}`) || 0) + (val ? numOf(r[val]) ?? 0 : 1))
    }
    // times and numbers in their order
    const xt = field(xk.map(v => ({ v })), 'v')
    if (xt.type !== 'text') xk.sort((a, b) => (timeOf(a)?.at ?? 0) - (timeOf(b)?.at ?? 0))
    // the values that end each quarter of the cells, smallest first
    const ranked = [...sum.values()].filter(v => v > 0).sort((a, b) => a - b)
    const ends = [0.25, 0.5, 0.75].map(f => ranked[Math.min(ranked.length - 1, Math.floor(f * ranked.length))])
    const level = v => (v <= ends[0] ? 0 : v <= ends[1] ? 1 : v <= ends[2] ? 2 : 3)
    const labelW = Math.min(Math.max(...yk.map(k => cells(k || '(none)'))), Math.floor(W * 0.35))
    const room = W - labelW - 1
    const wide = Math.max(1, Math.min(4, Math.floor(room / Math.max(1, xk.length))))
    const fits = xk.length * wide <= room
    const xs = fits ? xk : xk.slice(0, Math.floor(room / wide))
    const shade = v => colors.seq(0.15 + (0.85 * level(v)) / 3)
    const glyphOf = v => '░▒▓█'[level(v)]
    const name = cutter(yk.map(y => y || '(none)'), labelW)
    const blocks = yk.map(y => {
      const line = [padEnd(name(y || '(none)'), labelW), ' ']
      for (const x of xs) {
        const v = sum.get(`${y}\u0000${x}`)
        if (!v) { line.push(gray(wide > 1 ? '·' + ' '.repeat(wide - 1) : '·')); continue }
        line.push({ text: glyphOf(v).repeat(wide > 1 ? wide - 1 : 1), color: shade(v) }, ...(wide > 1 ? [' '] : []))
      }
      return { lines: [line] }
    })
    // the column names over their cells when each fits in its cell, else at a few ticks
    const allFit = xs.every(x => cells(x) <= wide - (wide > 1 ? 1 : 0)) && wide > 1
    const header = allFit
      ? [gray(' '.repeat(labelW + 1) + xs.map(x => padEnd(x, wide)).join(''))]
      : axisLine([0, 0.33, 0.67, 1].map(f => Math.round(f * (xs.length - 1))).filter((v, i, a) => a.indexOf(v) === i).map(i => ({ x: xs.length > 1 ? (i * wide) / (xs.length * wide - 1 || 1) : 0, text: xs[i] })), xs.length * wide, labelW + 1)
    // each shade the cells take, with the range of their values
    const shown = [0, 1, 2, 3].map(l => ranked.filter(v => level(v) === l)).filter(vs => vs.length)
    const range = vs => (vs[0] === vs[vs.length - 1] ? short(vs[0]) : `${short(vs[0])}-${short(vs[vs.length - 1])}`)
    const scale = [gray(`${val || 'rows'}: `), ...shown.flatMap((vs, i) => [...(i ? ['  '] : []), { text: glyphOf(vs[0]), color: shade(vs[0]) }, ` ${range(vs)}`]), gray('  · none')]
    const left = xk.length - xs.length
    return {
      before: [scale, [], header],
      blocks,
      after: left ? [[gray(`+${left} more ${spec.x} past the card's width`)]] : [],
      unit: 'rows',
    }
  }

  // ------------------------------------------------------------------------------------------------- timeline

  /** Events in time order, one under another, each with its time and words: lanes, when the events name a few, as
   *  columns side by side; a wide gap between two events said as its length; an event with an end, how long it lasted
   *  (or, for times that are plain numbers, where it ends). Times are dates, times of day or numbers; events whose times
   *  are none of these keep their order. */
  function timeline(spec, W) {
    const evs = list(spec.events).map((e, i) => {
      const o = isArray(e) ? { time: e[0], label: e[1], lane: e[2] } : e && typeof e === 'object' ? e : { label: e }
      return { i, time: o.time, label: flat(o.label ?? o.text ?? o.event ?? ''), lane: o.lane == null ? '' : flat(o.lane), end: o.end, t: timeOf(o.time), e: o.end == null ? null : timeOf(o.end) }
    })
    const placed = evs.length && evs.every(e => e.t)
    if (placed) {
      // clock times that go back start the next day, as a log read in order does
      if (evs.every(e => e.t.form === 'clock')) {
        let day = 0
        evs.forEach((e, k) => { if (k && e.t.at + day < evs[k - 1].t.at) day += 86400000; e.t = { ...e.t, at: e.t.at + day } })
      }
      evs.sort((a, b) => a.t.at - b.t.at || a.i - b.i)
    }
    const form = placed ? evs[0].t.form : 'text'
    const days = placed && form === 'datetime' && new Set(evs.map(e => dayOf(e.t.at))).size > 1
    const span = placed ? evs[evs.length - 1].t.at - evs[0].t.at : 0
    const secs = placed && form === 'datetime' && evs.some(e => new Date(e.t.at).getUTCSeconds()) && span < 3600000
    const when = (e, k) => {
      if (!placed) return flat(e.time)
      if (form === 'datetime') {
        const day = dayOf(e.t.at)
        const clock = clockOf(e.t.at, secs)
        return days && (!k || dayOf(evs[k - 1].t.at) !== day) ? `${day} ${clock}` : clock
      }
      if (form === 'date') return dayOf(e.t.at) + (new Set(evs.map(x => new Date(x.t.at).getUTCFullYear())).size > 1 ? ` ${new Date(e.t.at).getUTCFullYear()}` : '')
      if (form === 'month') return timeText(e.t.at, 'month', span)
      if (form === 'clock') return timeText(e.t.at % 86400000, 'clock', span)
      return num(e.t.at)
    }
    const times = evs.map(when)
    const timeW = Math.min(Math.max(...times.map(cells), 1), Math.floor(W * 0.3))
    const lanes = []
    for (const e of evs) if (e.lane && !lanes.includes(e.lane)) lanes.push(e.lane)
    const laneW = lanes.map(l => Math.max(cells(l), 1))
    // a few short lanes are columns, each event's dot in its own; more of them are a column of names
    const asColumns = lanes.length > 1 && lanes.length <= 6 && laneW.reduce((a, w) => a + w + 2, 0) <= W * 0.4
    const nameW = !asColumns && lanes.length ? Math.min(Math.max(...laneW), Math.floor(W * 0.25)) : 0
    const lead = timeW + 2 + (asColumns ? laneW.reduce((a, w) => a + w + 2, 0) : nameW ? nameW + 2 : 0) + (asColumns ? 0 : 2)
    const textW = Math.max(8, W - lead)
    // gaps: a wait four times the usual one and a tenth of the whole, said between the two events
    const gaps = placed ? evs.slice(1).map((e, k) => e.t.at - evs[k].t.at) : []
    const usual = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0
    const tracks = asColumns ? lanes.flatMap((l, j) => [gray(padEnd('│', laneW[j])), '  ']) : []
    const blocks = evs.map((e, k) => {
      const gap = k && placed ? gaps[k - 1] : 0
      const lines = []
      // times that are plain numbers show their spacing themselves, and have no unit to say a wait in
      if (form !== 'number' && gap > 0 && gap >= 4 * usual && gap >= span / 10 && evs.length > 2) {
        lines.push([' '.repeat(timeW + 2), ...tracks, ...(asColumns ? [] : [gray('⋮ ')]), gray(`${lasting(gap, form)} later`)])
      }
      // its words, their ✓ and × in their colors, and how long it lasted after them
      const words = wordsOf(glyphParts(e.label || '(no words)'))
      if (e.e && e.t) words.push([gray('·')], ...(form === 'number' ? `to ${num(e.e.at)}` : lasting(e.e.at - e.t.at, form)).split(' ').map(x => [gray(x)]))
      const lane = lanes.indexOf(e.lane)
      flowWords(words, textW, '', '').forEach((w, j) => {
        const line = [gray(padStart(j ? '' : cut(times[k], timeW), timeW)), '  ']
        if (asColumns) lanes.forEach((l, li) => line.push(li === lane && !j ? { text: padEnd('●', laneW[li]), color: colors.cat[li % colors.cat.length] } : gray(padEnd('│', laneW[li])), '  '))
        else {
          if (nameW) line.push(gray(padEnd(j ? '' : cut(e.lane, nameW), nameW)), '  ')
          line.push(j ? gray('│ ') : '● ')
        }
        line.push(...w)
        lines.push(line)
      })
      return { lines }
    })
    const header = asColumns ? [[' '.repeat(timeW + 2), ...lanes.flatMap((l, j) => [{ text: padEnd(l, laneW[j]), color: colors.cat[j % colors.cat.length] }, '  '])]] : []
    return { before: header, blocks, unit: 'events' }
  }

  // ------------------------------------------------------------------------------------------------- diagram

  /** Nodes and the edges between them, drawn from each start (a node no edge leads to) down: a node with one way on
   *  goes straight down to the next (`↓ label`), a node with more branches to each (`├─ label ─▶ node`); a node drawn
   *  already is named with ↑ where another edge leads to it again. A short chain that fits on one line is drawn on
   *  it. */
  function diagram(spec, W) {
    const nodes = new Map()
    const add = (id, label, detail) => {
      const k = flat(id)
      if (!k) return null
      if (!nodes.has(k)) nodes.set(k, { id: k, label: k, detail: '' })
      const n = nodes.get(k)
      if (label != null && flat(label)) n.label = flat(label)
      if (detail != null && flat(detail)) n.detail = flat(detail)
      return k
    }
    for (const n of list(spec.nodes)) {
      if (n && typeof n === 'object' && !isArray(n)) add(n.id ?? n.name ?? n.label, n.label, n.detail ?? n.description)
      else if (isArray(n)) add(n[0], n[1], n[2])
      else add(n)
    }
    const edges = []
    for (const e of list(spec.edges)) {
      const [s, t, label] = isArray(e) ? e : e && typeof e === 'object' ? [e.source ?? e.from, e.target ?? e.to, e.label] : []
      const a = add(s)
      const b = add(t)
      if (a && b) edges.push({ s: a, t: b, label: flat(label) })
    }
    const out = new Map([...nodes.keys()].map(k => [k, []]))
    const into = new Map([...nodes.keys()].map(k => [k, 0]))
    for (const e of edges) { out.get(e.s).push(e); into.set(e.t, into.get(e.t) + 1) }
    const nodeRuns = n => glyphRuns(n.label)
    // a chain (each node one way in and out) on one line, when it fits
    const starts = [...nodes.keys()].filter(k => !into.get(k))
    const chain = starts.length === 1 && [...nodes.values()].every(n => out.get(n.id).length <= 1 && into.get(n.id) <= 1 && !n.detail) && edges.length === nodes.size - 1
    if (chain && nodes.size > 1) {
      const line = []
      let k = starts[0]
      while (k) {
        line.push(...nodeRuns(nodes.get(k)))
        const e = out.get(k)[0]
        if (!e) break
        line.push(gray(e.label ? ` ─ ${e.label} ─▶ ` : ' ──▶ '))
        k = e.t
      }
      if (widthOf(line) <= W) return { before: [], blocks: [{ lines: [line] }], unit: 'lines' }
    }
    const lines = []
    const drawn = new Set()
    const plain = t => wordsOf([{ text: t, look: 'plain' }])
    const named = n => wordsOf(glyphParts(n.label))
    // lines that start with `first` and go on under `rest`, words wrapped between them
    const put = (words, first, rest) => {
      const lead = widthOf(first)
      const hang = widthOf(rest)
      flowWords(words, W - Math.max(lead, hang), '', '').forEach((l, j) => lines.push([...(j ? rest : first), ...l]))
    }
    // one node's lines: its label after `first` (the branch that leads to it, with that edge's label), its detail under
    // it, then the ways on from it
    const walk = (k, first, rest, edge) => {
      const n = nodes.get(k)
      drawn.add(k)
      put([...(edge || []), ...named(n)], first, rest)
      if (n.detail) put(plain(n.detail).map(w => w.map(r => ({ ...r, color: colors.gray }))), [...rest, '  '], [...rest, '  '])
      const ways = out.get(k)
      const straight = ways.length === 1 && !drawn.has(ways[0].t) && into.get(ways[0].t) === 1
      if (straight) {
        const e = ways[0]
        put(plain(`↓ ${e.label}`.trim()).map(w => w.map(r => ({ ...r, color: colors.gray }))), rest, [...rest, '  '])
        walk(e.t, rest, rest)
        return
      }
      ways.forEach((e, i) => {
        const last = i === ways.length - 1
        const branch = [...rest, gray(`${last ? '└' : '├'}─${e.label ? ' ' : '▶ '}`)]
        const under = [...rest, gray(last ? '   ' : '│  ')]
        const edge = e.label ? [...plain(e.label).map(w => w.map(r => ({ ...r, color: colors.gray }))), [gray('─▶')]] : []
        if (drawn.has(e.t)) put([...edge, ...named(nodes.get(e.t)), [gray('↑')]], branch, under)
        else walk(e.t, branch, under, edge)
      })
    }
    for (const k of starts) { if (lines.length) lines.push([]); walk(k, [], []) }
    // what no start reaches: a loop, drawn from its first node
    for (const k of nodes.keys()) if (!drawn.has(k)) { if (lines.length) lines.push([]); walk(k, [], []) }
    return { before: [], blocks: lines.map(l => ({ lines: [l] })), unit: 'lines' }
  }

  // ------------------------------------------------------------------------------------------------- example

  /** The records an example quotes, each under its file and place: its words around each passage it cites, the
   *  passages bold in the default color and the rest of the record in gray, so the analyst reads each quote in its
   *  record; lines of a file with their numbers; a JSON record by the field that holds the passage, with a line of its
   *  other short fields. thimble read the records when the card was drawn (ready.ts), so each passage is the record's
   *  own words. */
  function example(spec, W) {
    const blocks = list(spec.refs).map((r, k) => {
      const lines = k ? [[]] : []
      const place = r.end && r.end !== r.line ? `lines ${num(r.line)}-${num(r.end)}` : r.line ? `line ${num(r.line)}` : ''
      const where = [...(place ? [place] : []), ...(r.field ? [flat(r.field)] : [])].join(' · ')
      lines.push(fitLine([cut(flat(r.path), Math.max(8, W - (where ? cells(where) + 3 : 0)), true), ...(where ? [gray(` · ${where}`)] : [])], W))
      if (r.context) lines.push([gray(cut(`  ${flat(r.context)}`, W))])
      const text = String(r.text ?? '')
      const spans = list(r.spans).filter(s => isArray(s) && s[1] > s[0]).sort((a, b) => a[0] - b[0])
      lines.push(...(text.includes('\n') ? numbered(text, r.line || 1, spans, W) : flowWords(wordsOf(around(text, spans, (W - 2) * 5)), W, '  ', '  ', 5)))
      return { lines }
    })
    return { before: [], blocks, unit: 'records' }
  }

  /** A record's text as parts of one look each: each passage (`quote`) with as much of the record around it as fits in
   *  `budget` characters (`context`), cut at words with …; the whole text in the default look (`plain`) when it marks
   *  no passage. */
  function around(text, spans, budget) {
    if (!spans.length) return [{ text: cells(text) > budget ? cut(text, budget) : text, look: 'plain' }]
    const quoted = spans.reduce((a, s) => a + s[1] - s[0], 0)
    const side = Math.max(16, Math.floor((budget - quoted) / (2 * spans.length)))
    // each passage's window, joined where windows meet
    const wins = []
    for (const s of spans) {
      const w = [Math.max(0, s[0] - side), Math.min(text.length, s[1] + side), [s]]
      const last = wins[wins.length - 1]
      if (last && w[0] <= last[1]) { last[1] = Math.max(last[1], w[1]); last[2].push(s) } else wins.push(w)
    }
    const parts = []
    for (const [a, b, ss] of wins) {
      let from = a
      let to = b
      // a window starts and ends at a word's edge, unless that would cut into a passage
      if (from > 0) { const m = /\s/.exec(text.slice(from, ss[0][0])); from = m ? from + m.index + 1 : ss[0][0] }
      if (to < text.length) { const cut2 = text.slice(ss[ss.length - 1][1], to).search(/\s\S*$/); to = cut2 >= 0 ? ss[ss.length - 1][1] + cut2 : ss[ss.length - 1][1] }
      if (from > 0) parts.push({ text: '…', look: 'context' })
      let at = from
      for (const s of ss) {
        if (s[0] > at) parts.push({ text: text.slice(at, s[0]), look: 'context' })
        parts.push({ text: text.slice(Math.max(at, s[0]), s[1]), look: 'quote' })
        at = Math.max(at, s[1])
      }
      if (to > at) parts.push({ text: text.slice(at, to), look: 'context' })
      if (to < text.length) parts.push({ text: '…', look: 'context' })
    }
    return parts
  }

  const styleOf = look => (look === 'quote' ? { bold: true } : look === 'context' ? { color: colors.gray } : null)

  /** Parts of one look each ({text, look}, or {text, style}) as words: each word a list of runs, so a word a passage
   *  starts or ends inside keeps both looks with no space between them. */
  function wordsOf(parts) {
    const words = []
    let cur = null
    parts.forEach((p, k) => {
      const style = p.style !== undefined ? p.style : styleOf(p.look)
      for (const ch of p.text) {
        if (/\s/.test(ch)) { cur = null; continue }
        if (!cur) { cur = []; words.push(cur) }
        const last = cur[cur.length - 1]
        if (last && last.k === k) last.text += ch
        else cur.push({ k, text: ch, ...(style || {}) })
      }
    })
    return words.map(w => w.map(({ k, ...r }) => r))
  }

  /** Lines of a file with their numbers, at most 8, from the line before the first passage on: the passages bold, the
   *  rest gray; lines in the default look when no passage is marked. */
  function numbered(text, first, spans, W) {
    const rows = []
    let at = 0
    for (const t of text.split('\n')) { rows.push({ t, a: at, b: at + t.length }); at += t.length + 1 }
    const start = spans.length && rows.length > 8 ? Math.max(0, rows.findIndex(r => r.b >= spans[0][0]) - 1) : 0
    const shown = rows.slice(start, start + 8)
    const nw = String(first + start + shown.length - 1).length
    const out = shown.map((r, i) => {
      const runs = [gray(`  ${padStart(String(first + start + i), nw)}  `)]
      const t = r.t.replace(/\t/g, '    ')
      if (!spans.length) runs.push(t)
      else {
        let pos = r.a
        for (const s of spans) {
          const a = Math.max(s[0], r.a)
          const b = Math.min(s[1], r.b)
          if (b <= a) continue
          if (a > pos) runs.push(gray(text.slice(pos, a)))
          runs.push(bold(text.slice(a, b)))
          pos = b
        }
        if (pos < r.b) runs.push(gray(text.slice(pos, r.b)))
      }
      return fitLine(runs, W)
    })
    if (rows.length > start + 8) out.push([gray(`  +${rows.length - start - 8} more lines`)])
    return out
  }

  // ------------------------------------------------------------------------------------------------- note

  /** A few sentences as Markdown reads in a terminal: paragraphs wrapped at the width, a list item with its bullet and
   *  its lines under its words, a heading and **words** bold. */
  function note(spec, W) {
    const out = []
    const inline = s => String(s).split(/(\*\*[^*]+\*\*)/).filter(Boolean).map(p => {
      const b = /^\*\*([^*]+)\*\*$/.exec(p)
      return { text: b ? b[1] : p.replace(/`([^`]*)`/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'), look: b ? 'quote' : 'plain' }
    })
    const paras = String(spec.text ?? '').replace(/\r\n/g, '\n').split(/\n[ \t]*\n/)
    for (const p of paras) {
      if (out.length) out.push([])
      // the lines of a paragraph run on, but a list item or a heading starts a line of its own
      const items = []
      for (const raw of p.split('\n')) {
        const t = raw.trim()
        if (!t) continue
        const h = /^#{1,6}\s+(.*)$/.exec(t)
        const li = /^([-*+]|\d+[.)])\s+(.*)$/.exec(t)
        if (h) items.push({ parts: [{ text: h[1], look: 'quote' }], lead: '', hang: '', heading: true })
        else if (li) {
          const mark = /^\d/.test(li[1]) ? `${li[1]} ` : '• '
          items.push({ parts: inline(li[2]), lead: mark, hang: ' '.repeat(cells(mark)) })
        } else if (items.length && !items[items.length - 1].heading) items[items.length - 1].parts.push({ text: ' ', look: 'plain' }, ...inline(t))
        else items.push({ parts: inline(t), lead: '', hang: '' })
      }
      for (const it of items) out.push(...flowWords(wordsOf(it.parts), W, it.lead, it.hang))
    }
    return { before: [], blocks: out.map(l => ({ lines: [l] })), unit: 'lines' }
  }

  // ------------------------------------------------------------------------------------------------- the surface

  const DRAW = { table, chart, timeline, diagram, example, note }
  const KINDS_LIST = Object.keys(DRAW).join(', ')

  return {
    /** The card: its lines as Texts in one column. */
    view(props) {
      const { answer, lines } = laid(props)
      const head = answer ? [Text({ wrap: 'wrap', children: answer }), Text({ children: ' ' })] : []
      return Box({ flexDirection: 'column', children: [...head, ...lines.map(ink)] })
    },
    /** j turns to the next page, k back. */
    key(key, props) {
      const { pages, page } = laid(props)
      if (pages < 2) return
      const next = key === 'j' ? Math.min(pages - 1, page + 1) : key === 'k' ? Math.max(0, page - 1) : page
      if (next !== page) surface.setState({ ...(surface.state && typeof surface.state === 'object' ? surface.state : {}), page: next })
    },
    /** The keys the card takes: j and k when its data has more than one page at the card's width. */
    keys(props) {
      return laid(props).pages > 1 ? 'jk' : ''
    },
  }
}
