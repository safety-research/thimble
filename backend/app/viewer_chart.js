// thimble's charts for a view's page, part of the view kit: views.frame_document loads it after viewer_record.js, with
// the canvas's chart drawing just before it (frontend/src/lib/kitChart.ts, which vite build writes as kit/chart.js),
// and before viewer_range.js; viewer_parts.css styles it. A chart takes the kinds, the data and the options of a card's
// thimble.chart (docs/charts.md) and is drawn as the canvas draws its charts, in the canvas's theme:
//
//   thimble.chart('#posts', 'bar', rows, { colour, onPick, height })   rows: [{agent: 'agent-1', posts: 3}, ...], each
//                                                                      row's keys in the kind's order, as a
//                                                                      DataFrame's columns come
//   thimble.chart('#mine', spec, { onPick, height })                  any other Vega-Lite spec, drawn the same way
//
// It keeps one source of truth for each half. The spec is not built here: the kit asks thimble for it with its own
// fetch, {"$thimble": "chart", kind, rows, options}, which views.chart_answer answers with kernel_thimble.chart_spec,
// the code a card's thimble.chart runs, so a view's chart and a card's take the same kinds, rows and options and fail
// with the same words. The drawing is lib/vegaDraw's drawChart, the code the canvas draws every chart with (the chart
// style of lib/vizTheme read from the page's own tokens, the fixes of lib/chartDefaults, the fitting to the box). The
// page names "vega-embed" in view.json's libs, which brings vega and vega-lite with it.
//
// Beside thimble.chart's options it takes three of its own: `colour`, Color by, whose colours the group or series
// column's values take, in place of a legend, since Color by's chips are the key (gray with Off or for a value turned
// off); `onPick(row)`, a mark clicked, with its row; and `height`, the plot's height in px (at most ROW_MOST a row for
// rows named down its side). Called again on the same mount it replaces the chart, so a page draws it in its draw():
// the same chart again is kept as it is, and a mount asks thimble one call at a time, the latest. A chart with no rows
// draws none, and a wrong call says what is wrong in the chart's place, as a card's chart does, in a line as tall as
// the chart it replaces.
;(function () {
  'use strict'
  var kit = window.__thimbleKit
  if (!kit || !window.thimble || !kit.shared || !kit.shared.controls) return
  var thimble = window.thimble
  var ctl = kit.shared.controls

  var OWN = { colour: true, onPick: true, height: true } // the kit's own options; the others are thimble.chart's
  var KEPT = 32 // the specs kept, by what they were asked with, so drawing the same chart again asks thimble nothing
  var SCHEMA = 'https://vega.github.io/schema/vega-lite/v6.json' // kernel_thimble.VEGALITE_SCHEMA
  var ROW_MOST = 36 // px a row named down the y axis takes at most, so a bar chart of a few bars keeps thin bars
  var KEPT_CHARS = 4e6 // and at most this many characters of what they were asked with, since a chart's rows can be many

  var specs = {}
  var order = []
  var chars = 0
  function forget(key) {
    if (!specs[key]) return
    delete specs[key]
    order.splice(order.indexOf(key), 1)
    chars -= key.length
  }
  // a label's colours or values changed: a spec that names a label is asked for again
  kit.labels(function (state, labelsChanged) {
    if (!labelsChanged) return
    order.filter(function (k) { return specs[k].label }).forEach(forget)
  })
  function ask(kind, rows, options) {
    var own = {}
    for (var k in options) if (!OWN[k] && options[k] !== undefined) own[k] = options[k]
    var query = { $thimble: 'chart', kind: kind, rows: rows, options: own }
    var key = JSON.stringify(query)
    if (specs[key]) return specs[key].answer
    var answer = thimble.fetch(query).then(null, function (e) {
      forget(key)
      throw e
    })
    if (key.length > KEPT_CHARS) return answer
    specs[key] = { answer: answer, label: own.label != null }
    order.push(key)
    chars += key.length
    while (order.length > KEPT || chars > KEPT_CHARS) forget(order[0])
    return answer
  }
  // a mount's calls ask one at a time, so a page that draws its chart on every frame of a drag asks for the latest
  // rows once the answer before comes, and the calls between ask nothing
  function queued(st, seq, kind, rows, options) {
    var go = function () {
      return seq === st.seq ? ask(kind, rows, options) : null
    }
    var got = st.asking ? st.asking.then(go) : new Promise(function (resolve) { resolve(go()) })
    st.asking = got.then(
      function () {},
      function () {}
    )
    return got
  }

  // what failed, named as thimble.chart's errors are, once
  function message(e) {
    var m = e && e.message ? e.message : String(e)
    return /^thimble\.chart\b/.test(m) ? m : 'thimble.chart: ' + m
  }
  // a field's name as its rows hold it: Vega-Lite's field names a dot or a bracket with a backslash before it
  function bare(field) {
    return String(field).replace(/\\(.)/g, '$1')
  }
  function distinct(rows, field) {
    var name = bare(field)
    var seen = {}
    var out = []
    for (var i = 0; i < rows.length; i++) {
      var v = rows[i] && rows[i][name]
      if (v == null || seen['k' + v]) continue
      seen['k' + v] = true
      out.push(v)
    }
    return out
  }
  // whether a row holds `v` (null: no value) in `field`
  function has(rows, field, v) {
    var name = bare(field)
    for (var i = 0; i < rows.length; i++) if (rows[i] && (rows[i][name] == null ? null : rows[i][name]) === v) return true
    return false
  }
  // the spec with every color channel over groups in Color by's colours, in the spec's order of them, and no legend
  function coloured(spec, colour) {
    var gray = kit.realColour('var(--label-none)')
    var walk = function (s, rows) {
      if (!s || typeof s !== 'object' || Array.isArray(s)) return s
      var own = s.data && Array.isArray(s.data.values) ? s.data.values : rows
      var out = Object.assign({}, s)
      if (Array.isArray(s.layer)) out.layer = s.layer.map(function (l) { return walk(l, own) })
      if (s.spec) out.spec = walk(s.spec, own)
      var c = s.encoding && s.encoding.color
      if (c && typeof c.field === 'string' && c.type !== 'quantitative' && c.type !== 'temporal') {
        // the spec's order of the values, then any other its rows hold, and null, the rows with none, last
        var domain = Array.isArray(c.sort) ? c.sort.slice() : []
        distinct(own, c.field).forEach(function (v) {
          if (domain.indexOf(v) < 0) domain.push(v)
        })
        if (!domain.length) return out // a field the rows do not hold, such as one a transform makes
        if (has(own, c.field, null)) domain.push(null)
        var range = domain.map(function (v) {
          return (v != null && ctl.safe(function () { return colour.colourOf(v) }, null)) || gray
        })
        out.encoding = Object.assign({}, s.encoding, { color: Object.assign({}, c, { scale: { domain: domain, range: range }, legend: null }) })
      }
      return out
    }
    return walk(spec, [])
  }
  // how many rows a chart names down its y axis (a bar chart lying down, a dots chart, a box plot); 0 for a y of
  // numbers or times
  function rowsOf(spec) {
    var first = Array.isArray(spec.layer) && spec.layer[0] && typeof spec.layer[0] === 'object' ? spec.layer[0] : {}
    var y = (spec.encoding && spec.encoding.y) || (first.encoding && first.encoding.y)
    if (!y || (y.type !== 'nominal' && y.type !== 'ordinal') || typeof y.field !== 'string') return 0
    var data = (spec.data && spec.data.values) || (first.data && first.data.values)
    return Array.isArray(data) ? distinct(data, y.field).length : 0
  }
  // the spec as the page asked: Color by's colours, the plot's height, with ROW_MOST px a row at most
  function finished(spec, options) {
    var out = spec
    if (options.colour && typeof options.colour.colourOf === 'function') out = coloured(out, options.colour)
    var h = Number(options.height)
    var rows = h > 0 ? rowsOf(out) : 0
    if (rows) h = Math.min(h, rows * ROW_MOST)
    if (h > 0) out = Object.assign({}, out, { height: Math.round(h) })
    return out
  }
  // a label's classes, [[value, colour index]] as thimble answers them, in the colours the page's tokens give them
  function classes(label) {
    return label.map(function (c) {
      return { name: String(c[0]), colour: kit.realColour('var(--label-' + (c[1] ? c[1] : 'none') + ')'), none: !c[1] }
    })
  }
  // the columns a picked mark's row is given by: those the spec's rows hold
  function columns(spec) {
    var out = {}
    var walk = function (s) {
      if (!s || typeof s !== 'object') return
      var rows = s.data && Array.isArray(s.data.values) ? s.data.values : []
      for (var i = 0; i < rows.length && i < 50; i++) for (var k in rows[i]) out[k] = true
      if (Array.isArray(s.layer)) s.layer.forEach(walk)
      if (s.spec) walk(s.spec)
    }
    walk(spec)
    delete out.__thimble_stack
    return Object.keys(out)
  }
  function rowOf(datum, cols) {
    var row = {}
    var any = false
    for (var i = 0; i < cols.length; i++) {
      if (Object.prototype.hasOwnProperty.call(datum, cols[i])) {
        row[cols[i]] = datum[cols[i]]
        any = true
      }
    }
    if (any) return row
    for (var k in datum) if (Object.prototype.hasOwnProperty.call(datum, k) && k.indexOf('__thimble') !== 0) row[k] = datum[k]
    return row
  }

  // what a mount keeps: which call is the latest (seq) and the one that asks now (asking); the chart it shows (last,
  // the spec as drawn with its labels and the call's options, and sig, what it was drawn from), the drawing (drawn) and
  // the draw under way (drawing, and tok, which a later draw replaces); its plot and its note are made again when the
  // page emptied the mount
  function stateOf(el) {
    var st = el.__thimbleChart
    if (!st) {
      st = el.__thimbleChart = { seq: 0, asking: null, last: null, sig: null, drawn: null, drawing: null, tok: null, width: 0, waiting: null, plot: null, note: null }
      if (typeof ResizeObserver === 'function') {
        new ResizeObserver(function () {
          resized(el, st)
        }).observe(el)
      }
    }
    if (!st.plot || st.plot.parentNode !== el) {
      clear(st)
      el.classList.add('thimble-chart')
      el.innerHTML = '<div class="thimble-chart-plot"></div><div class="thimble-chart-note" data-thimble-chrome hidden></div>'
      st.plot = el.firstChild
      st.note = el.lastChild
    }
    return st
  }
  // the chart taken away, and a draw under way or waiting for the mount's width stopped
  function clear(st) {
    st.sig = null
    st.tok = null
    st.drawing = null
    var w = st.waiting
    st.waiting = null
    if (w) w.resolve(null)
    if (st.drawn) st.drawn.finalize()
    st.drawn = null
  }
  // a line in the chart's place, as tall as the chart it replaces, so the page below it keeps its place
  function note(el, st, text, error) {
    var h = st.drawn ? st.plot.offsetHeight : st.note.hidden ? 0 : parseFloat(st.note.style.minHeight) || 0
    clear(st)
    st.last = null
    st.plot.innerHTML = ''
    st.note.textContent = text
    st.note.classList.toggle('is-error', !!error)
    st.note.style.minHeight = h ? h + 'px' : ''
    st.note.hidden = false
    el.removeAttribute('data-pick')
    return null
  }
  function failed(el, st, text) {
    kit.report(new Error(text))
    return note(el, st, 'Chart failed: ' + text, true)
  }
  // the mount's width changed: a chart that takes its box's width is refitted, any other drawn again for the new width;
  // one that waited for a width is drawn
  function resized(el, st) {
    var w = el.clientWidth
    if (w <= 0 || w === st.width) return
    st.width = w
    if (st.waiting) {
      var wait = st.waiting
      st.waiting = null
      return wait.go()
    }
    if (!st.drawn || !st.last || !window.__thimbleCharts) return
    if (st.drawn.container) window.__thimbleCharts.refit(st.drawn, st.plot)
    else draw(el, st)
  }
  // the mark clicked, with its row, to the latest call's onPick
  function picked(st, item) {
    var pick = st.last && st.last.options.onPick
    if (typeof pick !== 'function' || !item || !item.datum || typeof item.datum !== 'object') return
    var row = rowOf(item.datum, columns(st.last.spec))
    ctl.safe(function () { pick(row) })
  }
  // st.last drawn in the plot, in place of the chart before it; resolves with its Vega view, or null when another draw
  // or a line took its place
  function draw(el, st) {
    var charts = window.__thimbleCharts
    if (!charts) return failed(el, st, 'thimble.chart: the chart drawing, frontend/dist/kit/chart.js, is not built in this install')
    var tok = (st.tok = {})
    var w = st.waiting
    st.waiting = null
    if (w) w.resolve(null)
    var alive = function () {
      return st.tok === tok
    }
    st.note.hidden = true
    if (!el.clientWidth) {
      // drawn once the mount has a width, as a chart on a card waits for its box
      return (st.drawing = new Promise(function (resolve) {
        st.waiting = {
          resolve: resolve,
          go: function () {
            resolve(alive() ? draw(el, st) : null)
          },
        }
      }))
    }
    st.width = el.clientWidth
    var last = st.last
    return (st.drawing = charts
      .draw(st.plot, last.spec, {
        labels: last.labels,
        alive: alive,
        replace: function () {
          if (st.drawn) st.drawn.finalize()
          st.drawn = null
        },
        drawn: function (d) {
          st.drawn = d
          d.view.addEventListener('click', function (e, item) {
            picked(st, item)
          })
        },
      })
      .then(
        function (d) {
          return alive() && d ? d.view : null
        },
        function (e) {
          return alive() ? failed(el, st, message(e)) : null
        }
      ))
  }

  /** a chart of thimble.chart's kinds, or of any Vega-Lite spec, in the canvas's theme (see the top of this file);
   *  resolves with its Vega view once drawn, or null when it draws none */
  thimble.chart = function (mount, kind, data, options) {
    var el = ctl.el(mount)
    if (!el) return Promise.resolve(null)
    var spec = null
    if (kind && typeof kind === 'object' && !Array.isArray(kind)) {
      // a spec written by hand often names no schema, which the drawing needs to know it for Vega-Lite and fit it
      spec = typeof kind.$schema === 'string' ? kind : Object.assign({ $schema: SCHEMA }, kind)
      options = data
      data = null
    }
    options = options && typeof options === 'object' ? options : {}
    var st = stateOf(el)
    var seq = ++st.seq
    if (!spec && !Array.isArray(data)) return Promise.resolve(failed(el, st, 'thimble.chart(' + JSON.stringify(String(kind)) + ") takes its data as a list of rows, each an object whose keys come in the kind's order"))
    if (!spec && !data.length) return Promise.resolve(note(el, st, 'No data'))
    var answer = spec ? Promise.resolve({ spec: spec }) : queued(st, seq, kind, data, options)
    return answer.then(
      function (got) {
        if (seq !== st.seq) return null
        if (!got || got.error || !got.spec) return failed(el, st, (got && got.error) || 'thimble.chart: thimble gave no chart')
        var last = { spec: finished(got.spec, options), labels: got.label ? [classes(got.label)] : [], options: options }
        var sig = JSON.stringify([last.spec, last.labels])
        st.last = last
        if (typeof options.onPick === 'function') el.setAttribute('data-pick', '')
        else el.removeAttribute('data-pick')
        // the chart it shows already, or is drawing: kept as it is, with this call's onPick
        if (sig === st.sig && st.drawing) return st.drawing
        st.sig = sig
        return draw(el, st)
      },
      function (e) {
        if (seq !== st.seq || (e && e.name === 'AbortError')) return null
        return failed(el, st, message(e))
      }
    )
  }
})()
