/* kit.js: the drawing toolkit an object's program is written against.

   A program is the body of a function `(k, data) => node`. It builds a tree of nodes with `k` and returns it.
   DrawKit.run(program, data, opts) runs it and returns a drawing: plain JSON that both renderers read.

     drawing = { kit, w, h, mode, root, cites: {id: cite}, examples: {id: set}, regions: [{id, meta}], warnings, ms, error? }

   The toolkit draws nothing itself. It records meaning: text as styled runs, values as values (a bar keeps its
   number, a spark its series), and regions with the ids the program gave them. The terminal renderer (term.js) lays
   the tree out in cells, the browser renderer (svg.js) in pixels, each with its own rules.

   This file is a plain script with no imports, so it can run inside a sandbox: a Node vm context
   (sandbox-node.mjs) or a sandboxed iframe (browser/sandbox.js). It reads no clock but performance.now/Date.now for
   the time limit, and nothing else from the environment. It defines globalThis.DrawKit.
*/
(function (root) {
  'use strict'

  const KIT = 1
  const TONES = ['ink', 'dim', 'accent', 'good', 'bad', 'warn', 'unseen', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6']
  const CATS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']
  const ALIAS = {
    default: 'ink', normal: 'ink', text: 'ink', black: 'ink', fg: 'ink',
    muted: 'dim', grey: 'dim', gray: 'dim', faint: 'dim', secondary: 'dim',
    blue: 'accent', link: 'accent', primary: 'accent',
    red: 'bad', error: 'bad', fail: 'bad',
    green: 'good', ok: 'good', pass: 'good',
    amber: 'warn', yellow: 'warn', warning: 'warn', orange: 'warn',
    missing: 'unseen', none: 'unseen',
    teal: 'c1', purple: 'c2', sand: 'c3', slate: 'c4', rose: 'c5', olive: 'c6'
  }
  const MAX_SIDE = 400
  const MAX_CITE_ROWS = 50
  const MAX_RECORDS = 200
  const MAX_SERIES_POINTS = 2000
  const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/

  // ---------------------------------------------------------------- small utilities
  const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v)
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
  const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())
  function int(v, d) { v = Math.round(Number(v)); return isFinite(v) ? v : d }
  function num(v) {
    if (typeof v === 'number') return v
    if (typeof v === 'string' && v.trim() !== '') {
      const t = v.trim().replace(/,/g, '').replace(/%$/, '')
      if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return parseFloat(t)
    }
    return NaN
  }
  function clone(v) {
    if (v === undefined) return undefined
    try { return JSON.parse(JSON.stringify(v)) } catch (e) { return null }
  }
  // Characters a renderer can draw: control and zero-width characters go, tabs become a space.
  function clean(s) {
    const out = []
    for (const ch of Array.from(String(s == null ? '' : s))) {
      const cp = ch.codePointAt(0)
      if (ch === '\t') { out.push(' '); continue }
      if (ch === '\n') { out.push('\n'); continue }
      if (cp < 0x20 || (cp >= 0x7F && cp < 0xA0)) continue
      if ((cp >= 0x200B && cp <= 0x200F) || cp === 0x2060 || (cp >= 0xFE00 && cp <= 0xFE0F) || cp === 0x20E3 || (cp >= 0x0300 && cp <= 0x036F) || cp === 0xFEFF) continue
      out.push(ch)
    }
    return out.join('')
  }
  function sep3(i) { return i.length > 3 ? i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : i }
  // Numbers for people: 1546 -> "1,546", 95.4321 -> "95.43". o: {dp, pct, sign, compact, raw}
  function fmt(v, o) {
    o = o || {}
    if (v == null) return ''
    if (typeof v !== 'number') { const n = num(v); if (!isFinite(n) || o.raw) return String(v); v = n }
    if (!isFinite(v)) return isNaN(v) ? 'NaN' : (v > 0 ? '∞' : '-∞')
    let suffix = ''
    if (o.pct) { v = v * 100; suffix = '%' }
    if (o.compact && Math.abs(v) >= 1000) {
      for (const [d, u] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']]) {
        if (Math.abs(v) >= d) { const x = v / d; return (o.sign && v > 0 ? '+' : '') + String(+x.toFixed(Math.abs(x) >= 100 ? 0 : 1)) + u + suffix }
      }
    }
    let s
    if (o.dp != null) s = Math.abs(v).toFixed(clamp(int(o.dp, 0), 0, 12))
    else if (Number.isInteger(v)) s = String(Math.abs(v))
    else s = String(Math.abs(+v.toPrecision(4)))
    if (s.indexOf('e') >= 0) return String(v) + suffix
    const p = s.split('.')
    return (v < 0 ? '-' : (o.sign && v > 0 ? '+' : '')) + sep3(p[0]) + (p[1] ? '.' + p[1] : '') + suffix
  }
  function slug(s) {
    const t = String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9_.:]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
    return /^[a-z0-9]/.test(t) ? t : ''
  }
  function escapeMarkup(s) { return String(s == null ? '' : s).replace(/([\\*{}[\]])/g, '\\$1') }
  function plain(runs) { return (runs || []).map(r => r.br ? '\n' : r.s).join('') }

  // ---------------------------------------------------------------- tones
  function toneOf(t, ctx, fallback) {
    fallback = fallback || 'ink'
    if (t == null || t === '') return fallback
    const k = String(t).toLowerCase().trim()
    if (TONES.indexOf(k) >= 0) return k
    if (ALIAS[k]) return ALIAS[k]
    const m = /^c(\d+)$/.exec(k)
    if (m) return CATS[((+m[1] - 1) % 6 + 6) % 6]
    warn(ctx, `unknown tone "${t}"; drawn as ${fallback}`)
    return fallback
  }
  function knownTone(name) { const k = String(name).toLowerCase(); return TONES.indexOf(k) >= 0 || !!ALIAS[k] || /^c\d+$/.test(k) }
  function warn(ctx, msg) { if (ctx && ctx.warnings.indexOf(msg) < 0 && ctx.warnings.length < 60) ctx.warnings.push(msg) }

  // ---------------------------------------------------------------- inline markup -> runs
  // **bold**   {tone:words} (nests; known tone names only)   [words](#id) a link to a cite, examples or region id
  // \* \{ \} \[ \] \\ escape.  A newline is a hard break.  Runs: {s, tone, b?, ref?} and {br: true}.
  function inline(str, o, ctx) {
    o = o || {}
    const a = Array.from(clean(typeof str === 'number' ? fmt(str) : str))
    const runs = []
    let bold = !!o.bold
    const tones = [toneOf(o.tone, ctx)]
    const push = (ch, ref) => {
      const tone = ref && tones.length === 1 ? 'accent' : tones[tones.length - 1]
      const last = runs[runs.length - 1]
      if (last && !last.br && last.tone === tone && !!last.b === bold && last.ref === ref) { last.s += ch; return }
      const r = { s: ch, tone: tone }
      if (bold) r.b = true
      if (ref) r.ref = ref
      runs.push(r)
    }
    if (o.raw) {
      for (const ch of a) { if (ch === '\n') runs.push({ br: true }); else push(ch) }
      return runs
    }
    let i = 0
    while (i < a.length) {
      const ch = a[i]
      if (ch === '\\' && i + 1 < a.length && '*{}[]\\'.indexOf(a[i + 1]) >= 0) { push(a[i + 1]); i += 2; continue }
      if (ch === '\n') { runs.push({ br: true }); i++; continue }
      if (ch === '*' && a[i + 1] === '*') { bold = !bold; i += 2; continue }
      if (ch === '{') {
        const m = /^\{([a-zA-Z][\w-]*):/.exec(a.slice(i, i + 24).join(''))
        if (m && knownTone(m[1])) { tones.push(toneOf(m[1], ctx)); i += m[0].length; continue }
      }
      if (ch === '}' && tones.length > 1) { tones.pop(); i++; continue }
      if (ch === '[') {
        const m = /^\[([^\]\n]+)\]\(#([^)\s]+)\)/.exec(a.slice(i, i + 300).join(''))
        if (m) {
          for (const c of Array.from(m[1])) push(c, m[2])
          ctx.links.push(m[2])
          i += Array.from(m[0]).length
          continue
        }
      }
      push(ch)
      i++
    }
    return runs
  }

  // ---------------------------------------------------------------- the kit
  function makeKit(ctx, W, H, opts) {
    const tick = n => {
      ctx.ops += n || 1
      if (ctx.ops >= ctx.nextCheck) {
        ctx.nextCheck = ctx.ops + 2000
        if (nowMs() - ctx.t0 > ctx.limit) { const e = new Error(`the program ran past the ${ctx.limit} ms limit`); e.name = 'TimeLimit'; throw e }
      }
    }
    const T = t => toneOf(t, ctx)
    const node = (t, props) => { tick(1); return Object.assign({ t: t }, props) }
    const isNode = v => isObj(v) && typeof v.t === 'string' && !(v instanceof Canvas)
    // anything a program hands where a node goes: a node, a canvas, a string (text), a number, an array (a stack)
    const asNode = v => {
      if (v == null || v === false) return null
      if (v instanceof Canvas) return v.node()
      if (isNode(v)) return v
      if (Array.isArray(v)) return k.stack.apply(null, v)
      if (typeof v === 'number') return k.text(fmt(v))
      return k.text(String(v))
    }
    const splitArgs = args => {
      const list = Array.prototype.slice.call(args)
      let o = {}
      const last = list[list.length - 1]
      if (list.length && isObj(last) && !isNode(last) && !(last instanceof Canvas)) o = list.pop()
      const kids = []
      const walk = v => { if (Array.isArray(v)) v.forEach(walk); else { const n = asNode(v); if (n) kids.push(n) } }
      list.forEach(walk)
      return { kids: kids, o: o }
    }
    const sizing = (n, o) => {
      if (!o) return n
      if (o.w != null) n.w = clamp(int(o.w, 1), 1, MAX_SIDE)
      if (o.grow != null) n.grow = Math.max(0, num(o.grow) || 0)
      if (o.minW != null) n.minW = clamp(int(o.minW, 1), 1, MAX_SIDE)
      return n
    }
    const metaOf = (m, where) => normMeta(m, ctx, where)

    const k = {
      w: W, h: H, mode: opts.mode || 'inline',
      tones: TONES.slice(), cats: CATS.slice(),
      fmt: fmt, num: num, escape: escapeMarkup,
      cat(i) { return CATS[((i | 0) % 6 + 6) % 6] },
      // the width of a string in columns, as the terminal counts it (wide characters count 2)
      len(s) { return Array.from(clean(s)).reduce((n, ch) => n + (ch === '\n' ? 0 : wide(ch.codePointAt(0)) ? 2 : 1), 0) },

      // ---------------- text
      text(str, o) {
        o = o || {}
        const n = node('text', { runs: inline(str, { tone: o.tone, bold: o.bold, raw: o.raw }, ctx) })
        if (o.align === 'right' || o.align === 'center') n.align = o.align
        if (o.wrap === false) n.wrap = false
        if (o.max != null) n.max = Math.max(1, int(o.max, 1))
        return sizing(n, o)
      },

      // ---------------- layout
      stack() {
        const { kids, o } = splitArgs(arguments)
        const n = node('stack', { kids: kids })
        if (o.gap) n.gap = Math.max(0, int(o.gap, 0))
        if (o.align === 'right' || o.align === 'center') n.align = o.align
        return sizing(n, o)
      },
      beside() {
        const { kids, o } = splitArgs(arguments)
        const n = node('beside', { kids: kids, gap: o.gap == null ? 2 : Math.max(0, int(o.gap, 2)) })
        if (o.align === 'middle' || o.align === 'center' || o.align === 'bottom') n.align = o.align === 'center' ? 'middle' : o.align
        return sizing(n, o)
      },
      frame(kid, o) {
        o = o || {}
        const n = node('frame', { kid: asNode(kid) || k.space(1, 1) })
        if (o.title != null) n.title = inline(o.title, { bold: true }, ctx)
        if (o.right != null) n.right = inline(o.right, { tone: 'dim' }, ctx)
        if (o.bottom != null) n.bottom = inline(o.bottom, { tone: 'dim' }, ctx)
        if (o.tone) n.tone = T(o.tone)
        return sizing(n, o)
      },
      size(kid, o) { const n = asNode(kid) || k.space(1, 1); return sizing(Object.assign({}, n), o || {}) },
      space(w, h) { return node('space', { w: Math.max(0, int(w == null ? 1 : w, 1)), h: Math.max(0, int(h == null ? 1 : h, 1)) }) },
      rule(o) { o = o || {}; return sizing(node('rule', { tone: T(o.tone || 'dim') }), o) },

      // ---------------- values
      // a bar: one value against a max, or stacked parts [{value, tone, label}]; it grows to the width it is given
      bar(value, o) {
        if (isObj(value) && !Array.isArray(value)) { o = value; value = o.parts || o.value }
        o = o || {}
        const n = node('bar', { tone: T(o.tone || 'accent') })
        if (Array.isArray(value)) {
          n.parts = value.map((p, pi) => {
            p = isObj(p) ? p : { value: p }
            const q = { value: Math.max(0, num(p.value) || 0), tone: T(p.tone || CATS[pi % 6]) }
            if (p.label != null) q.label = clean(p.label)
            return q
          })
          n.value = n.parts.reduce((s, p) => s + p.value, 0)
        } else n.value = num(value)
        n.max = num(o.max)
        if (!(n.max > 0)) n.max = Math.max(1, Math.abs(isFinite(n.value) ? n.value : 1))
        if (o.track) n.track = true
        return sizing(n, o)
      },

      // Conveniences: compositions of the primitives above, written here so programs need not repeat them.
      // A program may build its own the same way.

      // rows of  label  ▆▆▆▆▆▆  value  note : beside(text, bar, text, text) per item, in one column plan
      bars(items, o) {
        o = o || {}
        items = (Array.isArray(items) ? items : []).map(it => Array.isArray(it) ? { label: it[0], value: it[1] } : (isObj(it) ? it : { label: String(it) }))
        const vals = items.map(it => Array.isArray(it.parts) ? it.parts.reduce((s, p) => s + Math.max(0, num(isObj(p) ? p.value : p) || 0), 0) : num(it.value))
        const max = num(o.max) > 0 ? num(o.max) : Math.max.apply(null, vals.filter(isFinite).concat([0])) || 1
        const texts = items.map((it, i) => it.text != null ? String(it.text) : isFinite(vals[i]) ? fmt(vals[i], o.fmt) : (it.missing || 'unseen'))
        const width = o.w != null ? int(o.w, W) : W - 4
        const labelW = o.labelW != null ? int(o.labelW, 12) : Math.min(Math.max(1, ...items.map(it => k.len(it.label == null ? '' : it.label))), Math.max(6, Math.floor(width * 0.4)))
        const valW = Math.max(1, ...texts.map(t => k.len(t)))
        const noteW = Math.max(0, ...items.map(it => it.note != null ? k.len(plain(inline(it.note, {}, ctx))) : 0))
        const notes = noteW > 0 && width - labelW - valW - noteW - 4 >= 12
        const rows = items.map((it, i) => {
          const row = k.beside(
            k.text(it.label == null ? '' : it.label, { w: labelW, tone: it.labelTone || o.labelTone || 'ink', raw: !o.markup, wrap: false }),
            Array.isArray(it.parts) ? k.bar(it.parts, { max: max }) : isFinite(vals[i]) ? k.bar(vals[i], { max: max, tone: it.tone || o.tone }) : k.unseen(),
            k.text(texts[i], { w: valW, align: 'right', bold: !!(it.bold || o.bold), tone: isFinite(vals[i]) ? 'ink' : 'unseen', raw: true }),
            notes && k.text(' ' + (it.note == null ? '' : it.note), { w: noteW + 1, tone: 'dim', wrap: false }),
            { gap: 1 })
          const id = it.id != null ? it.id : typeof it.cite === 'string' ? it.cite : typeof it.examples === 'string' ? it.examples : null
          if (id == null && !it.cite && !it.examples && !it.meta) return row
          const meta = it.meta || {}
          return k.region(id != null ? id : slug(it.label), Object.assign({}, meta, { label: it.regionLabel || `${it.label == null ? '' : it.label} ${texts[i]}`.trim(), cite: it.cite != null ? it.cite : meta.cite, examples: it.examples != null ? it.examples : meta.examples }), row)
        })
        return k.stack(rows, { gap: o.gap ? 1 : 0 })
      },
      // ■ label   ■ label : one text
      legend(items, o) {
        o = o || {}
        const its = (Array.isArray(items) ? items : []).map(it => Array.isArray(it) ? { label: it[0], tone: it[1] } : it).filter(isObj)
        return k.text(its.map(it => { const t = T(it.tone); return `{${t}:${t === 'unseen' ? '░' : '■'}} {dim:${escapeMarkup(it.label)}}` }).join('   '), o)
      },
      // ●●●○○ : n of total, or a list of tones (an entry {tone, on: false} is hollow)
      dots(a, b, o) {
        let list
        if (Array.isArray(a)) { o = b || {}; list = a.map(x => isObj(x) ? { tone: T(x.tone || 'accent'), on: x.on !== false } : { tone: T(x || 'accent'), on: true }) }
        else {
          o = o || {}
          const n = Math.max(0, int(a, 0)), total = clamp(Math.max(n, int(b, n)), 0, 400)
          list = []
          for (let i = 0; i < total; i++) list.push(i < n ? { tone: T(o.tone || 'accent'), on: true } : { tone: 'dim', on: false })
        }
        return k.text(list.map(d => d.on ? `{${d.tone}:●}` : '{dim:○}').join(''), Object.assign({ wrap: false }, o))
      },
      // a one-line trend: one cell per value in the terminal, a line in the browser; null is a gap
      spark(values, o) {
        o = o || {}
        let vals = (Array.isArray(values) ? values : []).map(v => v == null ? null : num(v)).map(v => v === null || !isFinite(v) ? null : v)
        if (vals.length > MAX_SERIES_POINTS) { warn(ctx, `spark has ${vals.length} values; keeps the last ${MAX_SERIES_POINTS}`); vals = vals.slice(-MAX_SERIES_POINTS) }
        const fin = vals.filter(v => v !== null)
        const mn = isFinite(num(o.min)) ? num(o.min) : Math.min(0, Math.min.apply(null, fin.concat([0])))
        let mx = isFinite(num(o.max)) ? num(o.max) : Math.max.apply(null, fin.concat([mn + 1]))
        if (mx === mn) mx = mn + 1
        const n = node('spark', { values: vals, min: mn, max: mx, tone: T(o.tone || 'accent') })
        if (Array.isArray(o.tones)) n.tones = o.tones.slice(0, vals.length).map(t => t == null ? null : T(t))
        tick(vals.length / 8)
        return sizing(n, o)
      },
      // lines (or dots) of series over x: [numbers], [[x, y]...], or [{name, values | points, tone, id, cite}]
      plot(series, o) {
        o = o || {}
        const S = normSeries(series, ctx).map((s, i, all) => {
          const q = { name: s.name != null ? clean(s.name) : (all.length > 1 ? `series ${i + 1}` : ''), pts: s.pts, tone: T(s.tone || (i === 0 ? 'accent' : CATS[(i - 1) % 6])) }
          if (s.id != null || s.cite || s.examples || s.meta) {
            q.meta = metaOf(Object.assign({}, s.meta, { label: s.label || q.name, cite: s.cite, examples: s.examples }), 'plot series')
            q.region = regionId(ctx, s.id, 'plot series', q.meta)
          }
          return q
        })
        const axis = a => {
          a = isObj(a) ? a : {}
          const r = {}
          if (a.label != null) r.label = clean(a.label)
          if (isFinite(num(a.min))) r.min = num(a.min)
          if (isFinite(num(a.max))) r.max = num(a.max)
          if (a.log) r.log = true
          if (Array.isArray(a.ticks)) r.ticks = a.ticks.map(t => isObj(t) ? { at: num(t.at), label: t.label != null ? String(t.label) : undefined } : { at: num(t) }).filter(t => isFinite(t.at))
          return r
        }
        const n = node('plot', { series: S, h: clamp(int(o.h, 8), 3, 60), x: axis(o.x), y: axis(o.y) })
        if (o.dots) n.dots = true
        if (o.legend === false) n.legend = false
        tick(S.reduce((s, q) => s + q.pts.length, 0) / 8)
        return sizing(n, o)
      },
      // rows of records in columns; numbers right-aligned. o.cols [{key, label, align, fmt, tone, w}],
      // o.id / o.cite / o.examples: functions of (row, i) that make a row a region
      table(rows, o) {
        o = o || {}
        rows = Array.isArray(rows) ? rows : []
        let cols = Array.isArray(o.cols) ? o.cols : null
        if (!cols) {
          cols = []
          rows.forEach(r => { if (isObj(r)) Object.keys(r).forEach(kk => { if (cols.indexOf(kk) < 0) cols.push(kk) }) })
          if (!cols.length && rows.length && Array.isArray(rows[0])) cols = rows[0].map((_, i) => i)
        }
        cols = cols.map(c => isObj(c) ? Object.assign({}, c, { key: c.key != null ? c.key : c.label }) : { key: c })
        const get = (r, c) => Array.isArray(r) ? r[c.key] : isObj(r) ? r[c.key] : r
        const max = o.max != null ? Math.max(1, int(o.max, rows.length)) : 200
        const shown = rows.length > max ? rows.slice(0, max) : rows
        const RAW = /(^|_)(id|rev|step|epoch|year|run|batch|seed|pid|line)$/i
        const cells = shown.map((r, i) => cols.map(c => {
          let v = get(r, c)
          let tone = c.tone ? T(typeof c.tone === 'function' ? c.tone(v, r, i) : c.tone) : 'ink'
          let bold = false
          if (isObj(v)) { tone = v.tone ? T(v.tone) : tone; bold = !!v.bold; v = v.text != null ? v.text : v.value }
          let s
          if (typeof c.fmt === 'function') s = String(c.fmt(v, r, i))
          else if (typeof v === 'number') s = (c.raw || o.raw || RAW.test(String(c.key))) ? String(v) : fmt(v, isObj(c.fmt) ? c.fmt : undefined)
          else s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
          if ((typeof v === 'number' && !isFinite(v)) || /^\s*nan\s*$/i.test(s)) tone = 'bad'
          return inline(s, { tone: tone, bold: bold, raw: !c.markup }, ctx).filter(x => !x.br)
        }))
        const isNum = (r, c) => { let v = get(r, c); if (isObj(v)) v = v.value != null ? v.value : v.text; return v == null || v === '' || typeof v === 'number' || isFinite(num(v)) || /^\s*[-+]?(nan|inf)/i.test(String(v)) }
        const outCols = cols.map(c => {
          const q = { label: c.label != null ? clean(c.label) : typeof c.key === 'number' ? '' : clean(c.key) }
          q.align = c.align ? (c.align === 'right' ? 'right' : 'left') : (shown.length && shown.every(r => isNum(r, c)) ? 'right' : 'left')
          if (c.w != null) q.w = clamp(int(c.w, 4), 1, 120)
          return q
        })
        const outRows = cells.map((cs, i) => {
          const r = { cells: cs }
          const rid = typeof o.id === 'function' ? o.id(shown[i], i) : null
          const rc = typeof o.cite === 'function' ? o.cite(shown[i], i) : null
          const re = typeof o.examples === 'function' ? o.examples(shown[i], i) : null
          if (rid != null || rc || re) {
            r.meta = metaOf({ label: cs.map(plain).join(' ').replace(/\s+/g, ' ').trim().slice(0, 60), cite: rc, examples: re }, 'table row')
            r.region = regionId(ctx, rid, 'table row', r.meta)
          }
          return r
        })
        tick(shown.length * cols.length)
        const n = node('table', { cols: outCols, rows: outRows })
        if (rows.length > shown.length) n.more = rows.length - shown.length
        if (o.head === false) n.head = false
        return sizing(n, o)
      },
      unseen(o) {
        if (typeof o === 'string') o = { label: o }
        o = o || {}
        const n = node('unseen', {})
        if (o.label != null) n.label = clean(o.label)
        if (o.h != null) n.h = clamp(int(o.h, 1), 1, 40)
        return sizing(n, o)
      },

      // ---------------- meaning
      region(id, meta, kid) {
        if ((isNode(meta) || meta instanceof Canvas) && !(isNode(kid) || kid instanceof Canvas)) { const t = meta; meta = kid; kid = t }
        const m = metaOf(meta, 'region')
        const n = node('region', { id: regionId(ctx, id, 'region', m), meta: m, kid: asNode(kid) || k.space(1, 1) })
        if (!m.label) m.label = labelOf(n.kid) || (m.cite && ctx.cites[m.cite] && ctx.cites[m.cite].text) || (m.examples && ctx.examples[m.examples] && ctx.examples[m.examples].label) || n.id
        return n
      },
      cite(id, c) {
        if (isObj(id) && c == null) { c = id; id = c.id }
        return registerCite(ctx, id, c)
      },
      examples(id, e) {
        if (isObj(id) && e == null) { e = id; id = e.id }
        return registerExamples(ctx, id, e)
      },

      // ---------------- raw cells
      canvas(w, h) {
        w = clamp(int(w, W), 1, MAX_SIDE); h = clamp(int(h, 1), 1, MAX_SIDE)
        tick(w * h / 50)
        return new Canvas(w, h, ctx, tick, metaOf)
      }
    }
    k.vstack = k.stack; k.hstack = k.beside; k.hatch = k.unseen
    return k
  }
  function S0len(series) { return Array.isArray(series) ? series.length : 1 }

  // ---------------------------------------------------------------- ids, cites, examples
  // A region's id is what a selection and a handoff carry, so it should come from the program. When a program gives
  // none, the id comes from what the region shows (its cite, examples or label), never from where the call sits.
  function regionId(ctx, id, where, meta) {
    let s = id == null || id === '' ? '' : String(id)
    if (!s) {
      const m = meta || {}
      s = (typeof m.cite === 'string' && m.cite) || (typeof m.examples === 'string' && m.examples) || slug(m.label) || `${where.replace(/\W+/g, '-')}-${ctx.regionOrder.length + 1}`
      warn(ctx, `a ${where} has no id, so it is "${s}"; give each region an id of its own, so a selection survives a change to the program`)
    }
    if (!ID_RE.test(s)) {
      const t = slug(s) || 'r'
      warn(ctx, `region id "${s}" uses characters ids cannot hold; it is "${t}"`)
      s = t
    }
    if (ctx.ids[s]) {
      ctx.ids[s]++
      const t = s + '~' + ctx.ids[s]
      warn(ctx, `region id "${s}" is used ${ctx.ids[s]} times; the later one is "${t}"`)
      s = t
    } else ctx.ids[s] = 1
    ctx.regionOrder.push(s)
    return s
  }
  function registerCite(ctx, id, c) {
    if (!isObj(c)) { warn(ctx, 'k.cite needs (id, {text, source, query, rows, note})'); return null }
    id = String(id != null ? id : 'cite-' + (++ctx.seq))
    const o = Object.assign(clone(c) || {}, { id: id })
    if (c.text != null) o.text = clean(c.text)
    if (c.source != null) o.source = clean(c.source)
    if (c.query != null) o.query = String(c.query)
    let rows = Array.isArray(c.rows) ? c.rows : []
    let more = Math.max(0, num(c.more) || 0)
    if (rows.length > MAX_CITE_ROWS) { more += rows.length - MAX_CITE_ROWS; rows = rows.slice(0, MAX_CITE_ROWS) }
    o.rows = clone(rows)
    o.more = more
    if (c.note != null) o.note = clean(c.note)
    if (!rows.length && !o.note && !o.text) warn(ctx, `cite "${id}" has no rows, text or note`)
    if (ctx.cites[id] && JSON.stringify(ctx.cites[id]) !== JSON.stringify(o)) warn(ctx, `cite "${id}" is defined twice; the first one is kept`)
    if (!ctx.cites[id]) ctx.cites[id] = o
    return id
  }
  function registerExamples(ctx, id, e) {
    if (Array.isArray(e)) e = { records: e }
    if (!isObj(e)) { warn(ctx, 'k.examples needs (id, {label, records, total, fmt})'); return null }
    id = String(id != null ? id : 'ex-' + (++ctx.seq))
    const o = Object.assign(clone(e) || {}, { id: id, label: e.label != null ? clean(e.label) : '' })
    let recs = Array.isArray(e.records) ? e.records : []
    if (recs.length > MAX_RECORDS) recs = recs.slice(0, MAX_RECORDS)
    o.records = clone(recs)
    o.total = Math.max(o.records.length, num(e.total) || 0)
    if (e.fmt != null) o.fmt = String(e.fmt)
    if (!ctx.examples[id]) ctx.examples[id] = o
    return id
  }
  // meta: a label string, or {label, cite, examples, note, tone}; cite and examples are ids or inline objects
  function normMeta(m, ctx, where) {
    if (m == null) return {}
    if (typeof m === 'string' || typeof m === 'number') return { label: clean(String(m)) }
    if (!isObj(m)) return {}
    // any other field the program adds (a lineage note, a confidence, a verb's own data) is kept as given
    const o = clone(m) || {}
    if (m.label != null) o.label = clean(String(m.label)).slice(0, 120)
    if (m.note != null) o.note = clean(String(m.note))
    if (m.tone) o.tone = toneOf(m.tone, ctx)
    if (m.cite != null) o.cite = typeof m.cite === 'string' ? m.cite : registerCite(ctx, m.cite.id, m.cite)
    if (m.examples != null) o.examples = typeof m.examples === 'string' ? m.examples : registerExamples(ctx, Array.isArray(m.examples) ? null : m.examples.id, m.examples)
    if (o.label == null) delete o.label
    if (o.cite == null) delete o.cite
    if (o.examples == null) delete o.examples
    return o
  }
  // a region's label when the program gave none: the text it holds, in reading order
  function labelOf(n) {
    const out = []
    const walk = x => {
      if (!x || out.join(' ').length > 80) return
      if (x.t === 'text') out.push(plain(x.runs).replace(/\s+/g, ' ').trim())
      else if (x.t === 'canvas') x.ops.forEach(op => { if (op[0] === 'text') out.push(plain(op[3])) })
      ;(x.kids || []).forEach(walk)
      if (x.kid) walk(x.kid)
    }
    walk(n)
    return out.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 72)
  }

  // ---------------------------------------------------------------- series for plots
  function normSeries(series, ctx) {
    const isNumLike = v => typeof v === 'number' || v == null || (typeof v === 'string' && isFinite(num(v)))
    if (!Array.isArray(series)) series = series ? [series] : []
    if (series.length && series.every(isNumLike)) series = [{ values: series }]
    else if (series.length && series.every(p => Array.isArray(p) && p.length === 2 && isNumLike(p[0]))) series = [{ points: series }]
    return series.filter(isObj).map(s => {
      let pts = []
      if (Array.isArray(s.points)) pts = s.points.map(p => Array.isArray(p) ? [num(p[0]), p[1] == null ? null : num(p[1])] : [num(p.x), p.y == null ? null : num(p.y)])
      else if (Array.isArray(s.values)) pts = s.values.map((v, j) => [j, v == null ? null : num(v)])
      pts = pts.filter(p => isFinite(p[0])).map(p => [p[0], p[1] === null || !isFinite(p[1]) ? null : p[1]])
      if (pts.length > MAX_SERIES_POINTS) { warn(ctx, `a plot series has ${pts.length} points; keeps ${MAX_SERIES_POINTS}`); pts = pts.slice(0, MAX_SERIES_POINTS) }
      return Object.assign({}, s, { pts: pts })
    })
  }

  // ---------------------------------------------------------------- canvas: raw cells, recorded as operations
  // Positions are cells (x across, y down). px and line work in half cells down: y from 0 to 2h-1.
  function Canvas(w, h, ctx, tick, metaOf) {
    this.w = w; this.h = h
    this._ops = []
    this._ctx = ctx; this._tick = tick; this._metaOf = metaOf
  }
  const cT = (c, t, d) => toneOf(t, c._ctx, d || 'ink')
  const fl = v => Math.floor(Number(v) || 0)
  Canvas.prototype._op = function (op) { this._tick(1); if (this._ops.length < 20000) this._ops.push(op); else warn(this._ctx, 'canvas: more than 20,000 drawing calls; the rest are dropped'); return this }
  Canvas.prototype.put = function (x, y, ch, tone, o) {
    if (typeof o === 'boolean') o = { bold: o }
    o = o || {}
    const c = Array.from(clean(ch == null ? ' ' : ch).replace(/\n/g, ''))[0] || ' '
    const op = ['put', fl(x), fl(y), c, cT(this, tone)]
    if (o.bold || o.bg) op.push(o.bold ? 1 : 0)
    if (o.bg) op.push(cT(this, o.bg))
    return this._op(op)
  }
  Canvas.prototype.text = function (x, y, str, o) {
    if (typeof o === 'string') o = { tone: o }
    o = o || {}
    const op = ['text', fl(x), fl(y), inline(str, { tone: o.tone, bold: o.bold, raw: o.raw }, this._ctx).filter(r => !r.br), o.align === 'right' || o.align === 'center' ? o.align : 'left']
    if (o.max != null) op.push(Math.max(0, int(o.max, 0)))
    return this._op(op)
  }
  Canvas.prototype.fill = function (x, y, w, h, ch, tone) {
    const c = Array.from(clean(ch == null ? ' ' : ch).replace(/\n/g, ''))[0] || ' '
    return this._op(['fill', fl(x), fl(y), Math.max(0, fl(w)), Math.max(0, fl(h)), c, cT(this, tone)])
  }
  Canvas.prototype.hline = function (x, y, w, ch, tone) { return this._op(['hline', fl(x), fl(y), Math.max(0, fl(w)), Array.from(String(ch || '─'))[0], cT(this, tone, 'dim')]) }
  Canvas.prototype.vline = function (x, y, h, ch, tone) { return this._op(['vline', fl(x), fl(y), Math.max(0, fl(h)), Array.from(String(ch || '│'))[0], cT(this, tone, 'dim')]) }
  Canvas.prototype.box = function (x, y, w, h, o) {
    if (typeof o === 'string') o = { title: o }
    o = o || {}
    const op = ['box', fl(x), fl(y), Math.max(0, fl(w)), Math.max(0, fl(h)), cT(this, o.tone, 'dim')]
    if (o.title != null) op.push(inline(o.title, { bold: true }, this._ctx).filter(r => !r.br))
    return this._op(op)
  }
  Canvas.prototype.px = function (x, y, tone) { return this._op(['px', fl(x), fl(y), cT(this, tone, 'accent')]) }
  Canvas.prototype.line = function (x0, y0, x1, y1, tone) { return this._op(['line', +x0 || 0, +y0 || 0, +x1 || 0, +y1 || 0, cT(this, tone, 'accent')]) }
  // value marks inside a canvas keep their numbers, so the browser draws them exactly
  Canvas.prototype.bar = function (x, y, w, value, max, tone) { return this._op(['bar', fl(x), fl(y), Math.max(1, fl(w)), num(value), num(max) > 0 ? num(max) : 1, cT(this, tone, 'accent')]) }
  Canvas.prototype.spark = function (x, y, values, o) {
    o = o || {}
    const vals = (Array.isArray(values) ? values : []).slice(-MAX_SERIES_POINTS).map(v => v == null || !isFinite(num(v)) ? null : num(v))
    const fin = vals.filter(v => v !== null)
    const mn = isFinite(num(o.min)) ? num(o.min) : Math.min(0, Math.min.apply(null, fin.concat([0])))
    let mx = isFinite(num(o.max)) ? num(o.max) : Math.max.apply(null, fin.concat([mn + 1]))
    if (mx === mn) mx = mn + 1
    return this._op(['spark', fl(x), fl(y), Math.max(1, int(o.w, vals.length)), vals, mn, mx, cT(this, o.tone, 'accent')])
  }
  Canvas.prototype.region = function (id, x, y, w, h, meta) {
    const m = this._metaOf(meta, 'canvas region')
    const rid = regionId(this._ctx, id, 'canvas region', m)
    if (!m.label) m.label = rid
    return this._op(['region', rid, fl(x), fl(y), Math.max(1, fl(w)), Math.max(1, fl(h)), m])
  }
  Canvas.prototype.node = function () { return { t: 'canvas', w: this.w, h: this.h, ops: this._ops.slice() } }

  // ---------------------------------------------------------------- wide characters (the terminal draws them 2 cells)
  function wide(cp) {
    if (cp >= 0x1F000 && cp <= 0x1FAFF) return true
    if ((cp >= 0x1100 && cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0xA4CF) || (cp >= 0xAC00 && cp <= 0xD7A3) ||
      (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFE30 && cp <= 0xFE4F) || (cp >= 0xFF00 && cp <= 0xFF60) || (cp >= 0xFFE0 && cp <= 0xFFE6) || (cp >= 0x20000 && cp <= 0x3FFFD)) return true
    return false
  }

  // ---------------------------------------------------------------- run
  // Names a program should not lean on are shadowed as undefined parameters. This is a courtesy, not the boundary:
  // the sandbox the program runs in (a vm context with nothing of the host's, or an iframe with no network) is.
  // The program runs inside an inner function, so it may still declare variables with these names.
  const SHADOW = ['globalThis', 'self', 'window', 'document', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'postMessage', 'localStorage', 'sessionStorage', 'indexedDB', 'navigator', 'location', 'parent', 'top', 'frames', 'opener', 'setTimeout', 'setInterval', 'queueMicrotask', 'Function', 'require', 'process', 'module', 'DrawKit', 'WebAssembly', 'Worker', 'SharedArrayBuffer', 'Atomics']
  const PRELUDE = '"use strict";\nreturn (function (k, data) {\n'
  function errorInfo(e, program) {
    const msg = e && e.message ? String(e.message) : String(e)
    const name = e && e.name ? String(e.name) : 'Error'
    let line = null
    const st = e && e.stack ? String(e.stack) : ''
    const m = /<anonymous>:(\d+):(\d+)/.exec(st) || /program\.js:(\d+):(\d+)/.exec(st)
    if (m) line = +m[1] - 4
    if (!(line >= 1)) line = null
    const src = line && typeof program === 'string' ? (program.split('\n')[line - 1] || '').trim().slice(0, 160) : ''
    return { name: name, message: msg.slice(0, 400), line: line, source: src }
  }
  function toRoot(ret, k) {
    if (ret && typeof ret.then === 'function') {
      try { ret.then(null, () => {}) } catch (e) { /* nothing to wait for */ }
      const e = new Error('the program returned a promise; a program runs start to end and returns a node, with no await or import')
      e.name = 'ReturnError'
      throw e
    }
    if (ret instanceof Canvas) return ret.node()
    if (ret && typeof ret === 'object' && typeof ret.t === 'string') return ret
    if (typeof ret === 'string' || typeof ret === 'number') return k.text(String(ret))
    if (Array.isArray(ret)) return k.stack.apply(null, ret)
    const e = new Error('the program returned ' + (ret === undefined ? 'nothing' : typeof ret) + '; return a node, such as k.stack(...), k.frame(...) or a canvas')
    e.name = 'ReturnError'
    throw e
  }
  function collectRegions(rootNode) {
    const out = []
    const walk = n => {
      if (!n || typeof n !== 'object') return
      if (n.t === 'region') out.push({ id: n.id, meta: n.meta })
      if (n.t === 'table') n.rows.forEach(r => { if (r.region) out.push({ id: r.region, meta: r.meta }) })
      if (n.t === 'plot') n.series.forEach(s => { if (s.region) out.push({ id: s.region, meta: s.meta }) })
      if (n.t === 'canvas') n.ops.forEach(op => { if (op[0] === 'region') out.push({ id: op[1], meta: op[6] }) })
      if (n.kids) n.kids.forEach(walk)
      if (n.kid) walk(n.kid)
    }
    walk(rootNode)
    return out
  }

  /**
   * Run a program. `program` is the source of a function body (a string) or a function (k, data) => node.
   * opts: {w: columns (default 96), h: rows the host prefers (default 24), mode: 'inline' | 'detail', limit: ms (default 2000)}
   * Returns the drawing; on an error, `drawing.error` = {name, message, line, source} and root draws the error.
   */
  function run(program, data, opts) {
    opts = opts || {}
    const W = clamp(int(opts.w, 96), 8, MAX_SIDE), H = clamp(int(opts.h, 24), 3, MAX_SIDE)
    const ctx = { warnings: [], cites: {}, examples: {}, ids: {}, regionOrder: [], links: [], seq: 0, ops: 0, nextCheck: 2000, t0: nowMs(), limit: Math.max(50, num(opts.limit) || 2000) }
    const k = makeKit(ctx, W, H, opts)
    let rootNode = null, error = null
    try {
      let fn
      if (typeof program === 'function') fn = program
      else if (typeof program === 'string' && program.trim()) {
        // eslint-disable-next-line no-new-func
        fn = new Function('k', 'data', ...SHADOW, PRELUDE + program + '\n}).call(undefined, k, data)')
      } else { const e = new Error('the object has no program'); e.name = 'ProgramError'; throw e }
      rootNode = toRoot(fn.call(undefined, k, clone(data == null ? {} : data)), k)
    } catch (e) {
      error = errorInfo(e, typeof program === 'string' ? program : '')
      const kk = makeKit({ warnings: [], cites: {}, examples: {}, ids: {}, regionOrder: [], links: [], seq: 0, ops: 0, nextCheck: Infinity, t0: 0, limit: Infinity }, W, H, opts)
      const lines = [kk.text(`{bad:**${escapeMarkup(error.name)}**} ${escapeMarkup(error.message)}`)]
      if (error.line) lines.push(kk.text(`{dim:line ${error.line}}  ${escapeMarkup(error.source)}`, { wrap: false }))
      lines.push(kk.text('{dim:the program failed, so nothing else was drawn}'))
      rootNode = kk.frame(kk.stack(lines), { title: 'program error', tone: 'bad', grow: 1 })
    }
    const regions = error ? [] : collectRegions(rootNode)
    if (!error) {
      const known = {}
      regions.forEach(r => { known[r.id] = 1 })
      ctx.links.forEach(id => { if (!known[id] && !ctx.cites[id] && !ctx.examples[id]) warn(ctx, `a link points at "#${id}", which no region, k.cite or k.examples defines`) })
      regions.forEach(r => {
        if (r.meta.cite && !ctx.cites[r.meta.cite]) warn(ctx, `region "${r.id}" cites "${r.meta.cite}", which no k.cite defines`)
        if (r.meta.examples && !ctx.examples[r.meta.examples]) warn(ctx, `region "${r.id}" points at examples "${r.meta.examples}", which no k.examples defines`)
      })
    }
    const ms = Math.round((nowMs() - ctx.t0) * 10) / 10
    const out = { kit: KIT, w: W, h: H, mode: opts.mode || 'inline', root: rootNode, cites: error ? {} : ctx.cites, examples: error ? {} : ctx.examples, regions: regions, warnings: ctx.warnings, ms: ms }
    if (error) out.error = error
    return JSON.parse(JSON.stringify(out))
  }

  root.DrawKit = { KIT: KIT, TONES: TONES, CATS: CATS, run: run, fmt: fmt, inline: (s, o) => inline(s, o, { warnings: [], links: [] }), wide: wide, plain: plain }
})(typeof globalThis !== 'undefined' ? globalThis : this)
