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
// off); `onPick(row)`, a mark clicked, with its row; and `height`, the plot's height in px. Called again on the same
// mount it replaces the chart, so a page draws it in its draw(). A chart with no rows draws none, and a wrong call says
// what is wrong in the chart's place, as a card's chart does.
;(function () {
  'use strict'
  var kit = window.__thimbleKit
  if (!kit || !window.thimble || !kit.shared || !kit.shared.controls) return
  var thimble = window.thimble
  var ctl = kit.shared.controls

  var OWN = { colour: true, onPick: true, height: true } // the kit's own options; the others are thimble.chart's
  var KEPT = 32 // the specs kept, by what they were asked with, so drawing the same chart again asks thimble nothing

  var specs = {}
  var order = []
  // a label's colours or values changed: a spec that names a label is asked for again
  kit.labels(function (state, labelsChanged) {
    if (!labelsChanged) return
    order = order.filter(function (k) {
      if (!specs[k].label) return true
      delete specs[k]
      return false
    })
  })
  function ask(kind, rows, options) {
    var own = {}
    for (var k in options) if (!OWN[k] && options[k] !== undefined) own[k] = options[k]
    var query = { $thimble: 'chart', kind: kind, rows: rows, options: own }
    var key = JSON.stringify(query)
    if (specs[key]) return specs[key].answer
    var answer = thimble.fetch(query).then(null, function (e) {
      if (specs[key]) {
        delete specs[key]
        order.splice(order.indexOf(key), 1)
      }
      throw e
    })
    specs[key] = { answer: answer, label: own.label != null }
    order.push(key)
    while (order.length > KEPT) delete specs[order.shift()]
    return answer
  }

  function message(e) {
    return e && e.message ? e.message : String(e)
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
        var domain = Array.isArray(c.sort) ? c.sort.slice() : distinct(own, c.field)
        var range = domain.map(function (v) {
          return ctl.safe(function () { return colour.colourOf(v) }, null) || gray
        })
        out.encoding = Object.assign({}, s.encoding, { color: Object.assign({}, c, { scale: { domain: domain, range: range }, legend: null }) })
      }
      return out
    }
    return walk(spec, [])
  }
  // the spec as the page asked: Color by's colours, the plot's height
  function finished(spec, options) {
    var out = spec
    if (options.colour && typeof options.colour.colourOf === 'function') out = coloured(out, options.colour)
    var h = Number(options.height)
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

  // what a mount keeps: the chart drawn, the last call's spec, and which call is the latest; its plot and its note are
  // made again when the page emptied the mount
  function stateOf(el) {
    var st = el.__thimbleChart
    if (!st) {
      st = el.__thimbleChart = { seq: 0, drawn: null, last: null, width: 0, waiting: null, plot: null, note: null }
      if (typeof ResizeObserver === 'function') {
        new ResizeObserver(function () {
          resized(el, st)
        }).observe(el)
      }
    }
    if (!st.plot || st.plot.parentNode !== el) {
      if (st.drawn) st.drawn.finalize()
      st.drawn = null
      el.classList.add('thimble-chart')
      el.innerHTML = '<div class="thimble-chart-plot"></div><div class="thimble-chart-note" data-thimble-chrome hidden></div>'
      st.plot = el.firstChild
      st.note = el.lastChild
    }
    return st
  }
  // a call that waited for the mount's width and was replaced draws nothing
  function unwait(st) {
    var w = st.waiting
    st.waiting = null
    if (w) w.resolve(null)
  }
  function note(el, st, text, error) {
    if (st.drawn) {
      st.drawn.finalize()
      st.drawn = null
    }
    st.plot.innerHTML = ''
    st.note.textContent = text
    st.note.classList.toggle('is-error', !!error)
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
    else draw(el, st, ++st.seq)
  }
  function draw(el, st, seq) {
    var charts = window.__thimbleCharts
    if (!charts) return failed(el, st, 'thimble.chart: the chart drawing, frontend/dist/kit/chart.js, is not built in this install')
    if (!el.clientWidth) {
      // drawn once the mount has a width, as a chart on a card waits for its box
      return new Promise(function (resolve) {
        st.waiting = {
          resolve: resolve,
          go: function () {
            resolve(seq === st.seq ? draw(el, st, seq) : null)
          },
        }
      })
    }
    var last = st.last
    var pick = typeof last.options.onPick === 'function' ? last.options.onPick : null
    var cols = pick ? columns(last.spec) : null
    st.note.hidden = true
    if (pick) el.setAttribute('data-pick', '')
    else el.removeAttribute('data-pick')
    st.width = el.clientWidth
    return charts
      .draw(st.plot, last.spec, {
        labels: last.labels,
        alive: function () {
          return seq === st.seq
        },
        replace: function () {
          if (st.drawn) st.drawn.finalize()
          st.drawn = null
        },
        drawn: function (d) {
          st.drawn = d
          if (pick)
            d.view.addEventListener('click', function (e, item) {
              if (item && item.datum && typeof item.datum === 'object') ctl.safe(function () { pick(rowOf(item.datum, cols)) })
            })
        },
      })
      .then(
        function (d) {
          return seq === st.seq && d ? d.view : null
        },
        function (e) {
          return seq === st.seq ? failed(el, st, 'thimble.chart: ' + message(e)) : null
        }
      )
  }

  /** a chart of thimble.chart's kinds, or of any Vega-Lite spec, in the canvas's theme (see the top of this file);
   *  resolves with its Vega view once drawn, or null when it draws none */
  thimble.chart = function (mount, kind, data, options) {
    var el = ctl.el(mount)
    if (!el) return Promise.resolve(null)
    var spec = null
    if (kind && typeof kind === 'object' && !Array.isArray(kind)) {
      spec = kind
      options = data
      data = null
    }
    options = options && typeof options === 'object' ? options : {}
    var st = stateOf(el)
    var seq = ++st.seq
    st.last = null
    unwait(st)
    if (!spec && !Array.isArray(data)) return Promise.resolve(failed(el, st, 'thimble.chart(' + JSON.stringify(String(kind)) + ") takes its data as a list of rows, each an object whose keys come in the kind's order"))
    if (!spec && !data.length) return Promise.resolve(note(el, st, 'No data'))
    var answer = spec ? Promise.resolve({ spec: spec }) : ask(kind, data, options)
    return answer.then(
      function (got) {
        if (seq !== st.seq) return null
        if (!got || got.error || !got.spec) return failed(el, st, (got && got.error) || 'thimble.chart: thimble gave no chart')
        st.last = { spec: finished(got.spec, options), labels: got.label ? [classes(got.label)] : [], options: options }
        return draw(el, st, seq)
      },
      function (e) {
        if (seq !== st.seq || (e && e.name === 'AbortError')) return null
        return failed(el, st, 'thimble.chart: ' + message(e))
      }
    )
  }
})()
