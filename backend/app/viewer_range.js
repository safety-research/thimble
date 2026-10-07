// thimble's time range selector for a view's page, part of the view kit: views.frame_document loads it after
// viewer_colour.js, whose kept state, Color by and Reset it shares, and viewer_kit.css styles it. It is the one control
// for a view's time: an overview of the data's whole span, its records per moment in the Color by colours, with a
// viewfinder over it, as a video editor's zoom bar or a music editor's arrangement navigator:
//
//   const range = thimble.timeRange({
//     mount: '#range',                  the element the control fills, as wide as the time the view draws below it
//     times: rows.map((r) => r.t),      each record's time (seconds since 1970 by default, see `unit`), or
//     bins: { from, step, counts },     counts already binned: counts[i] is a number or {value: n} for the bin at from+i*step
//     values: (i) => colour.valueOf(i), each record's Color by value (an array or a function of the record's index)
//     gap: 3600,                        an empty stretch longer than this is drawn as a narrow break
//     marks: [{ t, label }],            point events, drawn as flags
//     onChange: (range) => draw(range), the viewfinder settled: draw what lies between range.from and range.to
//   })
//
// Drag the viewfinder to pan, drag either edge to zoom, drag across the overview outside it (or anywhere but the edges
// while it shows the whole span) to frame a new range, click outside it to move it there, double-click to show the whole
// span; Ctrl, ⌘ or Alt with the wheel (or a pinch) zooms around the pointer, Shift with the wheel pans, and with the
// viewfinder focused the arrow keys pan, + and - zoom and Home shows the whole span, each in the overview's px as a drag
// moves, so a key never lands an edge in a break and collapses the range. The part outside the viewfinder is
// dimmed, and the readout gives its start, end and length in the data's units, as wide as the widest of the span so the
// overview never moves. The range opens on the whole span; thimble keeps a range zoomed in per view (with the Color by
// choice, the bridge's `colour` message) and Reset in Color by's row brings back the whole span. Hovering the overview
// gives the time and the records there in a tip under it.
// The overview carries light ticks and at most a few labels, none while it shows the whole span and none once the page
// draws thimble.timeAxis for the range: the view's own chart, drawn on range.scale(width) and labelled by that axis,
// holds the one readable axis. That axis gives the date with the first time after a break or on a new day.
;(function () {
  'use strict'
  var kit = window.__thimbleKit
  try {
    delete window.__thimbleKit
  } catch (e) {
    window.__thimbleKit = undefined
  }
  if (!kit || !window.thimble) return
  var thimble = window.thimble
  var shared = kit.shared || null

  var SEC = 1000
  var MIN = 60 * SEC
  var HOUR = 60 * MIN
  var DAY = 24 * HOUR
  var MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  var BAR = 3 // px of the overview per column of records
  var BREAK = 10 // px a break in the time takes
  var MIN_SEG = 3 // px, the least width of a stretch of time between breaks
  var GRIP = 9 // px either side of the viewfinder's edge that takes a drag of the edge
  var MOVED = 3 // px a press moves before it is a drag
  var SETTLE = 180 // ms after the wheel stops before the range is told
  var LABELS = 4 // the overview's labels, at most
  var READ_LINE = 30 // characters: a readout wider than this gives its start and end on two lines
  // the steps of an axis, in ms: seconds, minutes, hours, days, a week; months and years go by the calendar
  var STEPS = [SEC, 2 * SEC, 5 * SEC, 10 * SEC, 15 * SEC, 30 * SEC, MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY]
  var CAL = [1, 3, 6, 12, 24, 60, 120] // months

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    })
  }
  function num(n) {
    return Number(n || 0).toLocaleString('en-US')
  }
  function el(target) {
    if (typeof target === 'string') return document.querySelector(target)
    return target && target.nodeType === 1 ? target : null
  }
  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v))
  }
  function report(e) {
    if (kit.report) kit.report(e)
  }
  var tip = shared ? shared.tip : function () {}
  var untip = shared ? shared.untip : function () {}

  // ---------------------------------------------------------------- time in words
  // A unit: 's' seconds since 1970, 'ms' milliseconds, 'n' a plain number such as a row or a turn. `utc` shows times in
  // UTC, else in the browser's zone.
  function Units(unit, utc) {
    this.unit = unit === 'ms' || unit === 'n' ? unit : 's'
    this.utc = utc !== false
    this.time = this.unit !== 'n'
    this.k = this.unit === 's' ? SEC : 1
  }
  Units.prototype.ms = function (t) {
    return t * this.k
  }
  Units.prototype.of = function (ms) {
    return ms / this.k
  }
  Units.prototype.parts = function (t) {
    var d = new Date(this.ms(t))
    return this.utc
      ? { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() }
      : { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds() }
  }
  Units.prototype.make = function (y, mo, d, h) {
    var ms = this.utc ? Date.UTC(y, mo, d || 1, h || 0) : new Date(y, mo, d || 1, h || 0).getTime()
    return this.of(ms)
  }
  function p2(n) {
    return n < 10 ? '0' + n : String(n)
  }
  Units.prototype.hm = function (t, secs) {
    var p = this.parts(t)
    return p2(p.h) + ':' + p2(p.mi) + (secs ? ':' + p2(p.s) : '')
  }
  Units.prototype.dm = function (t, year) {
    var p = this.parts(t)
    return p.d + ' ' + MONTH[p.mo] + (year ? ' ' + p.y : '')
  }
  Units.prototype.sameDay = function (a, b) {
    var x = this.parts(a)
    var y = this.parts(b)
    return x.y === y.y && x.mo === y.mo && x.d === y.d
  }
  // a length of time in words: 2y 11mo, 3mo 12d, 4d 15h, 3h 20m, 45m, 12s; a count for plain numbers
  Units.prototype.length = function (len) {
    if (!this.time) return num(Math.round(len))
    var ms = this.ms(len)
    var mo = ms / (30.44 * DAY)
    if (mo >= 24) return Math.floor(mo / 12) + 'y' + (Math.floor(mo % 12) ? ' ' + Math.floor(mo % 12) + 'mo' : '')
    if (mo >= 2) return Math.floor(mo) + 'mo' + (mo % 1 >= 0.25 && mo < 6 ? ' ' + Math.round((mo % 1) * 30.44) + 'd' : '')
    if (ms >= 2 * DAY) return Math.floor(ms / DAY) + 'd' + (ms % DAY >= HOUR ? ' ' + Math.floor((ms % DAY) / HOUR) + 'h' : '')
    if (ms >= HOUR) return Math.floor(ms / HOUR) + 'h' + (ms % HOUR >= MIN ? ' ' + Math.floor((ms % HOUR) / MIN) + 'm' : '')
    if (ms >= MIN) return Math.floor(ms / MIN) + 'm' + (ms % MIN >= SEC && ms < 10 * MIN ? ' ' + Math.floor((ms % MIN) / SEC) + 's' : '')
    return Math.max(0, Math.round(ms / SEC)) + 's'
  }
  // the readout of a range, as precise as its length needs; the year when the span crosses one: [start, end]
  Units.prototype.ends = function (a, b, years) {
    if (!this.time) return [num(Math.round(a)), num(Math.round(b))]
    var len = this.ms(b - a)
    if (len >= 3 * DAY) return [this.dm(a, years), this.dm(b - this.of(1), years)]
    var secs = len < 2 * MIN
    if (this.sameDay(a, b - this.of(1))) return [this.dm(a, years) + ' ' + this.hm(a, secs), this.hm(b, secs)]
    return [this.dm(a, years) + ' ' + this.hm(a, secs), this.dm(b, years) + ' ' + this.hm(b, secs)]
  }
  Units.prototype.range = function (a, b, years) {
    return this.ends(a, b, years).join(' – ')
  }
  // the characters of the widest readout of a span to `hi` (to the minute; a range under two minutes, which adds the
  // seconds, wraps at its dash), and of the widest one end
  Units.prototype.widest = function (hi, years) {
    var one = this.time ? 12 + (years ? 5 : 0) : num(Math.round(hi)).length + 1
    return { all: 2 * one + 3, one: one }
  }
  // a moment, as precise as `step` (in the units) needs
  Units.prototype.at = function (t, step, years) {
    if (!this.time) return num(Math.round(t))
    var ms = this.ms(step || 0)
    if (ms >= DAY) return this.dm(t, years)
    return this.dm(t, years) + ' ' + this.hm(t, ms < MIN)
  }

  // ---------------------------------------------------------------- scales
  // A scale lays the time from `from` to `to` across `width` px. With `segs`, the stretches of time that hold data,
  // the empty time between them is a narrow break (BREAK px), so bursts far apart share one axis.
  function Scale(u, from, to, width, segs) {
    this.u = u
    this.from = from
    this.to = to
    this.width = Math.max(1, width)
    var parts = []
    if (segs && segs.length) {
      for (var i = 0; i < segs.length; i++) {
        var a = Math.max(from, segs[i][0])
        var b = Math.min(to, segs[i][1])
        if (b >= a && !(b === a && (b === to || a === from) && segs.length > 1)) parts.push([a, b])
      }
    }
    if (parts.length < 2) parts = [[from, to]]
    var room = Math.max(1, this.width - BREAK * (parts.length - 1))
    var total = 0
    for (var j = 0; j < parts.length; j++) total += parts[j][1] - parts[j][0]
    var ws = parts.map(function (p) {
      return total > 0 ? ((p[1] - p[0]) / total) * room : room / parts.length
    })
    // a stretch too short to see takes MIN_SEG px, from the others in proportion
    var short = 0
    var long = 0
    for (var k = 0; k < ws.length; k++) {
      if (ws[k] < MIN_SEG) short += MIN_SEG - ws[k]
      else long += ws[k]
    }
    if (short && long > short)
      ws = ws.map(function (w) {
        return w < MIN_SEG ? MIN_SEG : w - (w / long) * short
      })
    var x = 0
    this.segs = parts.map(function (p, n) {
      var s = { a: p[0], b: p[1], x0: x, x1: x + ws[n] }
      x += ws[n] + BREAK
      return s
    })
    this.broken = this.segs.length > 1
    // the time per px where the data is, for the bins
    this.density = total > 0 ? total / room : (to - from) / this.width
  }
  /** the px at time t */
  Scale.prototype.x = function (t) {
    var s = this.segs
    if (t <= s[0].a) return s[0].x0 - (s[0].a - t) / Math.max(1e-12, this.density) * (this.broken ? 0 : 1)
    for (var i = 0; i < s.length; i++) {
      var g = s[i]
      if (t <= g.b) return g.b > g.a ? g.x0 + ((t - g.a) / (g.b - g.a)) * (g.x1 - g.x0) : (g.x0 + g.x1) / 2
      var n = s[i + 1]
      if (n && t < n.a) return g.x1 + ((t - g.b) / (n.a - g.b)) * (n.x0 - g.x1)
    }
    var last = s[s.length - 1]
    return last.x1 + (this.broken ? 0 : (t - last.b) / Math.max(1e-12, this.density))
  }
  /** the time at px x */
  Scale.prototype.t = function (x) {
    var s = this.segs
    if (x <= s[0].x0) return s[0].a
    for (var i = 0; i < s.length; i++) {
      var g = s[i]
      if (x <= g.x1) return g.x1 > g.x0 ? g.a + ((x - g.x0) / (g.x1 - g.x0)) * (g.b - g.a) : g.a
      var n = s[i + 1]
      if (n && x < n.x0) return g.b + ((x - g.x1) / (n.x0 - g.x1)) * (n.a - g.b)
    }
    return s[s.length - 1].b
  }
  /** the breaks, as [x0, x1] px */
  Scale.prototype.gaps = function () {
    var out = []
    for (var i = 1; i < this.segs.length; i++) out.push([this.segs[i - 1].x1, this.segs[i].x0])
    return out
  }
  // a nice step for `px` px per mark at this scale's density, in the units; months by the calendar as {months}
  Scale.prototype.step = function (px) {
    var want = this.density * px
    var u = this.u
    if (!u.time) {
      var p = Math.pow(10, Math.floor(Math.log(Math.max(want, 1e-9)) / Math.LN10))
      var m = [1, 2, 5, 10]
      for (var i = 0; i < m.length; i++) if (m[i] * p >= want) return Math.max(1, m[i] * p)
      return 10 * p
    }
    var ms = u.ms(want)
    for (var j = 0; j < STEPS.length; j++) if (STEPS[j] >= ms) return u.of(STEPS[j])
    var months = ms / (30.44 * DAY)
    for (var k = 0; k < CAL.length; k++) if (CAL[k] >= months) return { months: CAL[k] }
    return { months: 12 * Math.ceil(months / 12) }
  }
  // the times of a step's marks between a and b
  Scale.prototype.marks = function (step, a, b) {
    var out = []
    var u = this.u
    if (typeof step === 'object') {
      var p = u.parts(a)
      var mo = Math.floor((p.y * 12 + p.mo) / step.months) * step.months
      for (var guard = 0; guard < 2000; guard++, mo += step.months) {
        var t = u.make(Math.floor(mo / 12), mo % 12, 1)
        if (t > b) break
        if (t >= a) out.push(t)
      }
      return out
    }
    // aligned in the shown zone: a day starts at midnight there
    var off = u.time && !u.utc ? -new Date(u.ms(a)).getTimezoneOffset() * MIN : 0
    var st = step
    var first = Math.ceil((u.ms(a) + off) / u.ms(st)) * u.ms(st) - off
    for (var n = 0, x = first; n < 5000 && u.of(x) <= b; n++, x += u.ms(st)) out.push(u.of(x))
    return out
  }
  /** the ticks of an axis, a label at least `px` px apart: [{t, x, lx, label, major}], lx where the label's middle
   *  stands (beside a break it moves off the tick) */
  Scale.prototype.ticks = function (px, opts) {
    opts = opts || {}
    var u = this.u
    var step = this.step(px || 64)
    var out = []
    var self = this
    var years = opts.years != null ? opts.years : u.time && u.parts(this.from).y !== u.parts(this.to).y
    var ms = typeof step === 'object' ? step.months * 30 * DAY : u.ms(step)
    var label = function (t) {
      if (!u.time) return num(t)
      var p = u.parts(t)
      if (typeof step === 'object') return p.mo === 0 || step.months >= 12 ? String(p.y) : MONTH[p.mo] + (years && p.mo === 0 ? ' ' + p.y : '')
      if (ms >= DAY) return p.d === 1 && ms <= 7 * DAY ? u.dm(t) : u.dm(t)
      if (p.h === 0 && p.mi === 0 && p.s === 0) return u.dm(t, years && p.mo === 0 && p.d === 1)
      return u.hm(t, ms < MIN)
    }
    var major = function (t) {
      if (!u.time) return false
      var p = u.parts(t)
      if (typeof step === 'object') return p.mo === 0
      if (ms >= DAY) return p.d === 1
      return p.h === 0 && p.mi === 0 && p.s === 0
    }
    // a label keeps 8 px from the next label and 4 px clear of a break's // mark
    var breaks = this.gaps().map(function (gp) {
      var m = (gp[0] + gp[1]) / 2
      return [m - 6, m + 6]
    })
    var taken = []
    var free = function (a, w) {
      return (
        a >= -2 &&
        a + w <= self.width + 2 &&
        taken.every(function (q) { return a + w + 8 <= q[0] || a >= q[1] + 8 }) &&
        breaks.every(function (q) { return a + w + 4 <= q[0] || a >= q[1] + 4 })
      )
    }
    // where a label of width w for the tick at x stands: centred on it, else moved off a break beside it, just past the
    // break's // on the tick's side, when it still starts (or ends) by its tick and stays in its stretch of time, else
    // nowhere (null)
    var place = function (x, w, g) {
      var a = x - w / 2
      if (free(a, w)) return a
      for (var k = 0; k < breaks.length; k++) {
        var b = breaks[k]
        var after = x >= (b[0] + b[1]) / 2
        var a2 = after ? b[1] + 4 : b[0] - 4 - w
        if (after ? a2 - x > 14 || a2 + w < x : x - (a2 + w) > 14 || a2 > x) continue
        if (a2 >= g.x0 - 2 && a2 + w <= g.x1 + 2 && free(a2, w)) return a2
      }
      return null
    }
    // an axis of hours: the first label after a break or on a new day gives the date with its time, so every time can be
    // told apart ("13 Sep 09:30"); where that does not fit, the date alone
    var hours = u.time && typeof step !== 'object' && ms < DAY
    var dayOf = function (t) {
      var p = u.parts(t)
      return p.y * 400 + p.mo * 32 + p.d
    }
    var lastDay = null
    var days = hours && !u.sameDay(this.from, this.to)
    this.segs.forEach(function (g, si) {
      // the axis's first label too, when it covers more than a day
      var dated = si > 0 || days
      var list = self.marks(step, g.a, g.b)
      for (var i = 0; i < list.length; i++) {
        var t = list[i]
        var x = self.x(t)
        if (x < -0.5 || x > self.width + 0.5) continue
        var lab = label(t)
        var day = hours ? dayOf(t) : null
        var tries = [lab]
        if (hours && /^\d\d:/.test(lab) && (dated || (lastDay != null && day !== lastDay))) tries = [u.dm(t, years) + ' ' + lab, u.dm(t, years)]
        var at = null
        var shown = ''
        for (var j = 0; j < tries.length && at == null; j++) {
          at = place(x, tries[j].length * 6.2, g)
          if (at != null) shown = tries[j]
        }
        if (at == null) {
          // a stub with no label beside a break's // reads as part of it: left out
          if (breaks.some(function (b) { return x > b[0] - 4 && x < b[1] + 4 })) continue
          out.push({ t: t, x: x, lx: x, label: '', major: major(t) })
          continue
        }
        var w = shown.length * 6.2
        taken.push([at, at + w])
        if (hours) {
          lastDay = day
          dated = false
        }
        out.push({ t: t, x: x, lx: at + w / 2, label: shown, major: major(t) })
      }
    })
    return out
  }
  /** the bins of a chart on this scale, each at least `px` px wide: {step, bins: [[t0, t1]], of(t)} */
  Scale.prototype.binning = function (px) {
    var u = this.u
    var step = this.step(px || BAR)
    if (typeof step === 'object') step = u.of(step.months * 30 * DAY)
    var a = this.from
    var b = this.to
    var off = u.time && !u.utc ? -new Date(u.ms(a)).getTimezoneOffset() * MIN : 0
    var sm = u.ms(step)
    var first = u.of(Math.floor((u.ms(a) + off) / sm) * sm - off)
    var n = Math.max(1, Math.ceil((b - first) / step))
    var bins = []
    for (var i = 0; i < n && i < 20000; i++) bins.push([first + i * step, first + (i + 1) * step])
    return {
      step: step,
      bins: bins,
      of: function (t) {
        var k = Math.floor((t - first) / step)
        return k >= 0 && k < bins.length ? k : -1
      },
    }
  }
  function scaleApi(s) {
    var bn = null
    return {
      from: s.from,
      to: s.to,
      width: s.width,
      broken: s.broken,
      x: function (t) {
        return s.x(t)
      },
      t: function (x) {
        return s.t(x)
      },
      gaps: function () {
        return s.gaps()
      },
      ticks: function (px) {
        return s.ticks(px)
      },
      /** the bins of a chart at this scale: [[t0, t1]], `px` the least width of one (3 by default) */
      bins: function (px) {
        bn = s.binning(px)
        return bn.bins
      },
      /** the size of a bin, in the units, for bins(px) */
      step: function (px) {
        return s.binning(px).step
      },
      /** the bin a time falls in, for the last bins(), or -1 */
      binOf: function (t) {
        if (!bn) bn = s.binning()
        return bn.of(t)
      },
      _s: s,
    }
  }

  // the stretches of time that hold data: the sorted times, split where two lie more than `gap` apart
  function stretches(sorted, gap) {
    var out = []
    if (!sorted.length) return out
    var a = sorted[0]
    var b = sorted[0]
    for (var i = 1; i < sorted.length; i++) {
      var t = sorted[i]
      if (t - b > gap) {
        out.push([a, b])
        a = t
      }
      b = t
    }
    out.push([a, b])
    return out
  }

  // ---------------------------------------------------------------- the control
  var ranges = []
  function Range(opts) {
    var self = this
    this.opts = opts
    this.u = new Units(opts.unit, opts.utc)
    this.key = typeof opts.key === 'string' && opts.key ? opts.key : 'time'
    this.mount = el(opts.mount)
    this.onChange = typeof opts.onChange === 'function' ? opts.onChange : null
    this.onInput = typeof opts.onInput === 'function' ? opts.onInput : null
    this.onMark = typeof opts.onMark === 'function' ? opts.onMark : null
    this.h = Math.max(16, Number(opts.height) || 28)
    this.span = [0, 1]
    this.extent = null // the first and the last record's time, which the readout gives while the range is whole
    this.win = null // [from, to], null while it shows the whole span
    this.times = null
    this.values = null
    this.binsIn = null
    this.marksIn = []
    this.segs = null
    this.hasData = false
    this.drag = null
    this.timer = null
    this.readEl = null
    this.axisBelow = false // thimble.timeAxis draws the chart's axis of this range: the overview then shows no labels
    if (!this.mount) return
    this.mount.classList.add('thimble-range-mount')
    this.mount.setAttribute('data-thimble-chrome', '')
    this.mount.innerHTML = ''
    this.root = document.createElement('div')
    this.root.className = 'thimble-range'
    var read = opts.readout === false ? null : el(opts.readout)
    this.root.innerHTML =
      (opts.readout === false || read ? '' : '<div class="thimble-range-read"></div>') +
      '<div class="thimble-range-body"><div class="thimble-range-strip" style="height:' + this.h + 'px"><canvas></canvas>' +
      '<div class="thimble-range-dim thimble-range-dim-l"></div><div class="thimble-range-dim thimble-range-dim-r"></div>' +
      '<div class="thimble-range-win" tabindex="0" role="group" aria-roledescription="time range" aria-label="Time range">' +
      '<div class="thimble-range-grip thimble-range-grip-l" role="slider" tabindex="-1" aria-label="Start"><span></span></div>' +
      '<div class="thimble-range-grip thimble-range-grip-r" role="slider" tabindex="-1" aria-label="End"><span></span></div></div>' +
      '<div class="thimble-range-flags"></div></div><div class="thimble-range-axis"></div></div>'
    this.mount.appendChild(this.root)
    this.readEl = read || this.root.querySelector('.thimble-range-read')
    this.ownRead = !read && !!this.readEl
    if (read) read.classList.add('thimble-range-read')
    this.strip = this.root.querySelector('.thimble-range-strip')
    this.canvas = this.strip.querySelector('canvas')
    this.winEl = this.strip.querySelector('.thimble-range-win')
    this.dimL = this.strip.querySelector('.thimble-range-dim-l')
    this.dimR = this.strip.querySelector('.thimble-range-dim-r')
    this.flagsEl = this.strip.querySelector('.thimble-range-flags')
    this.axisEl = this.root.querySelector('.thimble-range-axis')
    this.strip.addEventListener('pointerdown', function (e) {
      self.down(e)
    })
    this.strip.addEventListener('pointermove', function (e) {
      self.move(e)
    })
    this.strip.addEventListener('pointerup', function (e) {
      self.up(e)
    })
    this.strip.addEventListener('pointercancel', function (e) {
      self.up(e)
    })
    this.strip.addEventListener('pointerleave', function () {
      if (!self.drag) self.unhover()
    })
    this.strip.addEventListener('dblclick', function (e) {
      e.preventDefault()
      self.fit()
    })
    this.strip.addEventListener(
      'wheel',
      function (e) {
        self.wheel(e)
      },
      { passive: false },
    )
    // onKey, not key: this.key is the name the range is kept under, which would hide a method of that name
    this.winEl.addEventListener('keydown', function (e) {
      self.onKey(e)
    })
    this.axisEl.addEventListener('click', function (e) {
      var lab = e.target.closest && e.target.closest('[data-t]')
      if (lab) self.zoomTo(Number(lab.getAttribute('data-t')), Number(lab.getAttribute('data-to')))
    })
    var width = -1
    if (typeof ResizeObserver === 'function')
      new ResizeObserver(function () {
        var w = self.strip.clientWidth
        if (w === width) return
        width = w
        self.root.classList.toggle('thimble-range-narrow', self.mount.clientWidth < 460)
        self.draw()
      }).observe(this.mount)
    this.root.classList.toggle('thimble-range-narrow', this.mount.clientWidth < 460)
  }
  Range.prototype.full = function () {
    return !this.win
  }
  Range.prototype.from = function () {
    return this.win ? this.win[0] : this.span[0]
  }
  Range.prototype.to = function () {
    return this.win ? this.win[1] : this.span[1]
  }
  Range.prototype.least = function () {
    var given = Number(this.opts.min)
    if (given > 0) return given
    var sp = this.span[1] - this.span[0]
    return Math.max(this.u.time ? this.u.of(SEC) : 1, sp / 5000)
  }
  // the data: each record's time and value, or counts already binned, and the span
  Range.prototype.data = function (d) {
    d = d || {}
    if ('times' in d) this.times = d.times && d.times.length != null ? d.times : null
    if ('values' in d) this.values = d.values || null
    if ('bins' in d) this.binsIn = d.bins && d.bins.counts ? d.bins : null
    if ('marks' in d) this.marksIn = Array.isArray(d.marks) ? d.marks.filter(function (m) { return m && isFinite(m.t) }) : []
    if ('gap' in d) this.opts.gap = d.gap
    var lo = Infinity
    var hi = -Infinity
    var sorted = null
    if (this.times) {
      sorted = Array.prototype.slice.call(this.times).filter(function (t) { return isFinite(t) }).sort(function (a, b) { return a - b })
      if (sorted.length) {
        lo = sorted[0]
        hi = sorted[sorted.length - 1]
      }
    } else if (this.binsIn) {
      var b = this.binsIn
      sorted = []
      for (var i = 0; i < b.counts.length; i++) {
        var c = b.counts[i]
        var n = typeof c === 'number' ? c : c && typeof c === 'object' ? Object.keys(c).reduce(function (s, k) { return s + (Number(c[k]) || 0) }, 0) : 0
        if (n > 0) {
          sorted.push(b.from + i * b.step)
          sorted.push(b.from + (i + 1) * b.step)
        }
      }
      if (sorted.length) {
        lo = sorted[0]
        hi = sorted[sorted.length - 1]
      }
    }
    var span = Array.isArray(d.span) && d.span[1] > d.span[0] ? d.span : Array.isArray(this.opts.span) && this.opts.span[1] > this.opts.span[0] && !('times' in d || 'bins' in d) ? this.opts.span : null
    this.extent = lo <= hi ? [lo, hi] : null
    if (!span) span = lo <= hi ? (hi > lo ? [lo, hi] : [lo - this.pad1(), hi + this.pad1()]) : this.span
    // a little room at the ends, so the first and the last record do not sit on the edge
    if (!Array.isArray(d.span) && !(Array.isArray(this.opts.span) && this.opts.span[1] > this.opts.span[0])) {
      var room = (span[1] - span[0]) * 0.004
      span = [span[0] - room, span[1] + room]
    }
    this.span = [span[0], span[1]]
    // a span the page gives is what the readout gives while the range is whole
    if (Array.isArray(d.span) && d.span[1] > d.span[0]) this.extent = [d.span[0], d.span[1]]
    else if (Array.isArray(this.opts.span) && this.opts.span[1] > this.opts.span[0]) this.extent = [this.opts.span[0], this.opts.span[1]]
    var gap = Number(this.opts.gap)
    this.segs = gap > 0 && sorted && sorted.length ? stretches(sorted, gap) : null
    if (this.segs) {
      this.segs[0][0] = Math.min(this.segs[0][0], this.span[0])
      this.segs[this.segs.length - 1][1] = Math.max(this.segs[this.segs.length - 1][1], this.span[1])
    }
    var first = !this.hasData
    this.hasData = true
    if (first) {
      var kept = shared && shared.state.range ? shared.state.range[this.key] : null
      if (kept) this.win = this.clampWin(kept)
    } else if (this.win) this.win = this.clampWin(this.win)
    this.draw()
    return this
  }
  Range.prototype.pad1 = function () {
    return this.u.time ? this.u.of(HOUR) / 2 : 0.5
  }
  // a window within the span, at least the least width, or null when it covers the whole span
  Range.prototype.clampWin = function (w) {
    if (!w) return null
    var a = Math.max(this.span[0], Math.min(w[0], w[1]))
    var b = Math.min(this.span[1], Math.max(w[0], w[1]))
    var least = this.least()
    if (b - a < least) {
      var mid = (a + b) / 2
      a = Math.max(this.span[0], mid - least / 2)
      b = Math.min(this.span[1], a + least)
      a = Math.max(this.span[0], b - least)
    }
    // an edge in a break moves to the data beside it: the start to where the next stretch begins, the end to where the
    // last one ends, so the range never starts or ends in time that holds nothing
    var sg = this.segs
    if (sg && sg.length > 1)
      for (var k = 0; k + 1 < sg.length; k++) {
        if (a > sg[k][1] && a < sg[k + 1][0] && sg[k + 1][0] < b) a = sg[k + 1][0]
        if (b > sg[k][1] && b < sg[k + 1][0] && sg[k][1] > a) b = sg[k][1]
      }
    if (a <= this.span[0] + 1e-9 * Math.abs(this.span[0] || 1) && b >= this.span[1] - 1e-9 * Math.abs(this.span[1] || 1)) return null
    if (!(b > a)) return null
    return [a, b]
  }
  // the overview's scale: the whole span across the strip
  Range.prototype.scaleAll = function () {
    return new Scale(this.u, this.span[0], this.span[1], this.strip ? this.strip.clientWidth : 300, this.segs)
  }
  Range.prototype.colour = function () {
    return shared ? shared.colour() : null
  }
  // the overview: the records per column, each column's values stacked in the chips' order, grey with Color by Off
  Range.prototype.draw = function () {
    if (!this.strip) return
    var W = this.strip.clientWidth
    var H = this.h
    if (W <= 0) return
    var dpr = window.devicePixelRatio || 1
    var cv = this.canvas
    cv.width = Math.ceil(W * dpr)
    cv.height = Math.ceil(H * dpr)
    cv.style.width = W + 'px'
    cv.style.height = H + 'px'
    var sc = this.scaleAll()
    this.sc = sc
    var cols = Math.max(1, Math.floor(W / BAR))
    var colour = this.colour()
    var plain = !colour || colour.off || (!colour.field && !colour.label)
    var order = []
    var slot = {}
    if (!plain) {
      var vs = colour.values
      for (var i = 0; i < vs.length; i++)
        if (vs[i].value != null && vs[i].on) {
          slot[vs[i].value] = order.length
          order.push(vs[i].value)
        }
    }
    var none = order.length
    var counts = []
    var add = function (x, s, n) {
      var c = Math.floor(x / BAR)
      if (c < 0 || c >= cols) return
      var a = counts[c] || (counts[c] = [])
      a[s] = (a[s] || 0) + n
    }
    var valueAt = null
    if (!plain) {
      if (typeof this.values === 'function') valueAt = this.values
      else if (this.values && this.values.length != null) {
        var arr = this.values
        valueAt = function (i) {
          return arr[i]
        }
      } else if (colour)
        valueAt = function (i) {
          return colour.valueOf(i)
        }
    }
    var self = this
    var keepValue = function (v) {
      // a value turned off leaves the overview, as it leaves the lists
      if (v == null || v === '') return none
      if (slot[v] != null) return slot[v]
      return colour.isOn(v) ? none : -1
    }
    if (this.times) {
      for (var j = 0; j < this.times.length; j++) {
        var t = this.times[j]
        if (!isFinite(t)) continue
        var s = none
        if (valueAt) {
          var v = null
          try {
            v = valueAt(j)
          } catch (e) {}
          s = keepValue(v)
          if (s < 0) continue
        }
        add(sc.x(t), s, 1)
      }
    } else if (this.binsIn) {
      var b = this.binsIn
      for (var k = 0; k < b.counts.length; k++) {
        var c = b.counts[k]
        var x = sc.x(b.from + (k + 0.5) * b.step)
        if (typeof c === 'number') add(x, none, c)
        else if (c && typeof c === 'object')
          for (var name in c) {
            var s2 = plain ? none : keepValue(name === '' ? null : name)
            if (s2 >= 0) add(x, s2, Number(c[name]) || 0)
          }
      }
    }
    var max = 0
    for (var q = 0; q < cols; q++) {
      var tot = 0
      var a = counts[q]
      if (a) for (var z = 0; z < a.length; z++) tot += a[z] || 0
      if (tot > max) max = tot
    }
    this.counts = counts
    var ctx = cv.getContext && cv.getContext('2d')
    if (ctx) {
      ctx.clearRect(0, 0, cv.width, cv.height)
      var colours = order.map(function (v) {
        return colour.colourOf(v) || kit.realColour('var(--label-none)')
      })
      var grey = kit.realColour('rgba(var(--ink-rgb), 0.32)')
      var lin = this.opts.scale === 'linear'
      var top = 2
      var room = H - top - 1
      for (var col = 0; col < cols; col++) {
        var cs = counts[col]
        if (!cs) continue
        var total = 0
        for (var m = 0; m < cs.length; m++) total += cs[m] || 0
        if (!total) continue
        var full = Math.max(1, (lin ? total / max : Math.sqrt(total / max)) * room)
        var y = H - 1
        var x0 = Math.round(col * BAR * dpr)
        var bw = Math.max(1, Math.round((BAR - 1) * dpr))
        for (var sIdx = 0; sIdx <= none; sIdx++) {
          var n2 = cs[sIdx]
          if (!n2) continue
          var hh = (n2 / total) * full
          y -= hh
          ctx.fillStyle = sIdx < none ? colours[sIdx] : grey
          var y0 = Math.round(y * dpr)
          ctx.fillRect(x0, y0, bw, Math.max(1, Math.round((y + hh) * dpr) - y0))
        }
      }
      // the breaks: a hairline pair where the time between bursts is left out
      var gaps = sc.gaps()
      ctx.fillStyle = kit.realColour('rgba(var(--ink-rgb), 0.22)')
      for (var g = 0; g < gaps.length; g++) {
        var gx = (gaps[g][0] + gaps[g][1]) / 2
        ctx.fillRect(Math.round((gx - 2) * dpr), Math.round(4 * dpr), Math.max(1, Math.round(dpr)), Math.round((H - 8) * dpr))
        ctx.fillRect(Math.round((gx + 1) * dpr), Math.round(4 * dpr), Math.max(1, Math.round(dpr)), Math.round((H - 8) * dpr))
      }
    }
    this.drawAxis()
    this.drawFlags()
    this.place()
    void self
  }
  // the overview's axis: light ticks, and while the viewfinder frames part of the span at most a few labels of a coarse
  // step, which a click zooms to
  Range.prototype.drawAxis = function () {
    var sc = this.sc
    if (!sc) return
    var W = sc.width
    var ticks = sc.ticks(Math.max(64, W / LABELS))
    var html = ''
    // labels only while the viewfinder frames part of the span, and never beside the chart's own axis, whose scale is
    // another: two rows of labels for one time would contradict each other
    var labelled = !this.full() && !this.axisBelow && this.opts.labels !== false
    var step = sc.step(Math.max(64, W / LABELS))
    for (var i = 0; i < ticks.length; i++) {
      var tk = ticks[i]
      html += '<i class="thimble-range-tick' + (tk.major ? ' major' : '') + '" style="left:' + tk.x.toFixed(1) + 'px"></i>'
      if (labelled && tk.label) {
        var to = typeof step === 'object' ? this.u.make(this.u.parts(tk.t).y, this.u.parts(tk.t).mo + step.months, 1) : tk.t + step
        html += '<span class="thimble-range-lab" data-t="' + tk.t + '" data-to="' + to + '" style="left:' + tk.lx.toFixed(1) + 'px">' + esc(tk.label) + '</span>'
      }
    }
    this.axisEl.innerHTML = html
  }
  // the point events: a flag on the overview, its label on hover
  Range.prototype.drawFlags = function () {
    var sc = this.sc
    if (!sc) return
    var html = ''
    for (var i = 0; i < this.marksIn.length; i++) {
      var m = this.marksIn[i]
      var x = sc.x(m.t)
      if (x < 0 || x > sc.width) continue
      html += '<span class="thimble-range-flag" data-i="' + i + '" style="left:' + x.toFixed(1) + 'px' + (m.colour ? ';--c:' + esc(m.colour) : '') + '"></span>'
    }
    this.flagsEl.innerHTML = html
  }
  // the viewfinder, the dimmed parts beside it, and the readout
  Range.prototype.place = function () {
    if (!this.sc) return
    var sc = this.sc
    var W = sc.width
    var a = this.full() ? 0 : clamp(sc.x(this.from()), 0, W)
    var b = this.full() ? W : clamp(sc.x(this.to()), 0, W)
    if (b - a < 4) {
      var mid = (a + b) / 2
      a = clamp(mid - 2, 0, W - 4)
      b = a + 4
    }
    this.winAt = [a, b]
    this.winEl.style.left = a + 'px'
    this.winEl.style.width = b - a + 'px'
    this.dimL.style.width = a + 'px'
    this.dimR.style.left = b + 'px'
    this.dimR.style.width = Math.max(0, W - b) + 'px'
    this.root.classList.toggle('thimble-range-all', this.full())
    var years = this.u.time && this.u.parts(this.span[0]).y !== this.u.parts(this.span[1]).y
    // the readout gives the records' own first and last time, not the room left at the ends
    var ext = this.extent
    var ra = ext ? Math.max(this.from(), ext[0]) : this.from()
    var rb = ext ? Math.min(this.to(), ext[1]) : this.to()
    if (!(rb > ra)) {
      ra = this.from()
      rb = this.to()
    }
    var words = this.u.range(ra, rb, years)
    var gl = this.winEl.querySelector('.thimble-range-grip-l')
    var gr = this.winEl.querySelector('.thimble-range-grip-r')
    gl.setAttribute('aria-valuetext', this.u.at(this.from(), this.to() - this.from(), years))
    gr.setAttribute('aria-valuetext', this.u.at(this.to(), this.to() - this.from(), years))
    this.winEl.setAttribute('aria-valuetext', words)
    if (this.readEl) {
      // each end whole, so the readout wraps only after its dash, never inside a date; the kit's own readout as wide as
      // the widest this span gives, so the overview beside it keeps its place and width as the range zooms
      var ends = this.u.ends(ra, rb, years)
      this.readEl.innerHTML = '<span class="thimble-range-dates"><span class="thimble-range-d">' + esc(ends[0]) + ' –</span> <span class="thimble-range-d">' + esc(ends[1]) + '</span></span><span class="thimble-range-len">' + esc(this.u.length(rb - ra)) + '</span>'
      if (this.ownRead) {
        var wd = this.u.widest(Math.max(Math.abs(this.span[0]), Math.abs(this.span[1])), years)
        var stack = wd.all > READ_LINE
        this.root.classList.toggle('thimble-range-stack', stack)
        this.readEl.style.setProperty('--thimble-read-w', (stack ? wd.one + 2 : wd.all) + 'ch')
      }
    }
  }
  // ---------------------------------------------------------------- moving the viewfinder
  // the viewfinder set to [a, b] (null for the whole span): drawn at once, the page told while it moves (onInput) and
  // once it settles (onChange)
  Range.prototype.set = function (w, how) {
    var was = this.win ? this.win.join() : ''
    this.win = this.clampWin(w)
    this.place()
    if (this.sc && this.axisEl && (was === '') !== !this.win) this.drawAxis()
    var now = this.win ? this.win.join() : ''
    if (now === was && how !== 'settle') return
    if (how === 'input' || how === 'drag') {
      if (this.onInput) this.call(this.onInput)
      return
    }
    this.settle(how === 'wheel' ? SETTLE : 0, how === 'quiet')
  }
  Range.prototype.settle = function (ms, quiet) {
    var self = this
    if (shared) {
      if (this.win) shared.state.range[this.key] = this.win.slice()
      else delete shared.state.range[this.key]
      shared.save()
    }
    if (this.check) this.check()
    clearTimeout(this.timer)
    if (quiet) return
    this.timer = setTimeout(function () {
      self.timer = null
      if (self.onChange) self.call(self.onChange)
    }, ms)
  }
  Range.prototype.call = function (fn) {
    try {
      fn(this.api)
    } catch (e) {
      report(e)
    }
  }
  Range.prototype.fit = function (quiet) {
    if (this.full()) return
    this.set(null, quiet ? 'quiet' : 'fit')
  }
  Range.prototype.zoomTo = function (a, b) {
    if (isFinite(a) && isFinite(b) && b > a) this.set([a, b], 'set')
  }
  Range.prototype.px = function (e) {
    return e.clientX - this.strip.getBoundingClientRect().left
  }
  Range.prototype.down = function (e) {
    if (e.button !== 0 || !this.sc) return
    e.preventDefault()
    var x = this.px(e)
    var a = this.winAt[0]
    var b = this.winAt[1]
    var what = Math.abs(x - a) <= GRIP && (x <= a + GRIP || b - a > 2 * GRIP) ? 'l' : Math.abs(x - b) <= GRIP ? 'r' : x > a && x < b ? 'pan' : 'new'
    if (what === 'l' && Math.abs(x - b) < Math.abs(x - a)) what = 'r'
    // the whole span has nowhere to pan: a drag across it frames a new range, as the crosshair says
    if (what === 'pan' && this.full()) what = 'new'
    this.drag = { what: what, x0: x, a: a, b: b, from: this.from(), to: this.to(), moved: false }
    this.unhover()
    if (this.strip.setPointerCapture) this.strip.setPointerCapture(e.pointerId)
    this.root.setAttribute('data-drag', what)
    this.winEl.focus({ preventScroll: true })
  }
  Range.prototype.move = function (e) {
    var d = this.drag
    if (!d) return this.hover(e)
    var x = this.px(e)
    if (!d.moved && Math.abs(x - d.x0) < MOVED) return
    d.moved = true
    var sc = this.sc
    var W = sc.width
    var dx = x - d.x0
    if (d.what === 'pan') {
      var w = d.b - d.a
      var na = clamp(d.a + dx, 0, W - w)
      // a broken scale moves by px, so the window keeps its width on the screen
      var ta = sc.t(na)
      var tb = sc.t(na + w)
      if (na <= 0) ta = this.span[0]
      if (na + w >= W) tb = this.span[1]
      this.set([ta, tb], 'drag')
    } else if (d.what === 'l') this.set([sc.t(clamp(x, 0, d.b - 1)), d.to], 'drag')
    else if (d.what === 'r') this.set([d.from, sc.t(clamp(x, d.a + 1, W))], 'drag')
    else this.set([sc.t(clamp(Math.min(x, d.x0), 0, W)), sc.t(clamp(Math.max(x, d.x0), 0, W))], 'drag')
  }
  Range.prototype.up = function (e) {
    var d = this.drag
    if (!d) return
    this.drag = null
    this.root.removeAttribute('data-drag')
    if (!d.moved) {
      if (d.what === 'new') {
        // a click beside the viewfinder moves it there, its width kept
        var sc = this.sc
        var x = this.px(e)
        var w = d.b - d.a
        var na = clamp(x - w / 2, 0, sc.width - w)
        this.set([na <= 0 ? this.span[0] : sc.t(na), na + w >= sc.width ? this.span[1] : sc.t(na + w)], 'set')
      }
      return
    }
    this.settle(0)
  }
  Range.prototype.wheel = function (e) {
    if (!this.sc) return
    var dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY
    var dxw = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaMode === 2 ? e.deltaX * 400 : e.deltaX
    var sc = this.sc
    var W = sc.width
    var a = this.winAt[0]
    var b = this.winAt[1]
    if (e.ctrlKey || e.metaKey || e.altKey) {
      e.preventDefault()
      // zoom around the pointer: the time under it stays under it
      var x = clamp(this.px(e), 0, W)
      var f = Math.exp(clamp(dy, -200, 200) * 0.004)
      var nw = clamp((b - a) * f, 2, W)
      var r = (x - a) / Math.max(1, b - a)
      var na = clamp(x - r * nw, 0, W - nw)
      this.set([na <= 0 ? this.span[0] : sc.t(na), na + nw >= W ? this.span[1] : sc.t(na + nw)], 'wheel')
      return
    }
    var pan = e.shiftKey ? dy || dxw : Math.abs(dxw) > Math.abs(dy) ? dxw : 0
    if (!pan || this.full()) return
    e.preventDefault()
    var w2 = b - a
    var p = clamp(a + pan * 0.5, 0, W - w2)
    this.set([p <= 0 ? this.span[0] : sc.t(p), p + w2 >= W ? this.span[1] : sc.t(p + w2)], 'wheel')
  }
  // The keys move the viewfinder in the overview's px, as the drags do: on a scale with breaks, a step in clock time
  // would land an edge in a break, which takes it to the data beside it and leaves a sliver of the range. The arrows pan
  // by a tenth of the viewfinder (Shift: half), or move a focused grip by 2% of the overview; + takes a third off the
  // viewfinder around its middle, - adds half to it; Home or 0 shows the whole span.
  Range.prototype.onKey = function (e) {
    var sc = this.sc
    if (!sc) return
    var W = sc.width
    var span = this.span
    // the viewfinder's px as its times give them, not as drawn: place() widens a sliver to 4 px
    var a = this.full() ? 0 : clamp(sc.x(this.from()), 0, W)
    var b = this.full() ? W : clamp(sc.x(this.to()), 0, W)
    var w = b - a
    var at = function (x0, x1) {
      return [x0 <= 0 ? span[0] : sc.t(x0), x1 >= W ? span[1] : sc.t(x1)]
    }
    var grip = e.target.closest && e.target.closest('.thimble-range-grip')
    var go = null
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      var sgn = e.key === 'ArrowLeft' ? -1 : 1
      var step = 0.02 * W
      if (grip && grip.classList.contains('thimble-range-grip-l')) go = [at(clamp(a + sgn * step, 0, b - 1), b)[0], this.to()]
      else if (grip) go = [this.from(), at(a, clamp(b + sgn * step, a + 1, W))[1]]
      else {
        var s = clamp(sgn * (e.shiftKey ? 0.5 : 0.1) * w, -a, W - b)
        go = at(a + s, b + s)
      }
    } else if (e.key === '+' || e.key === '=') {
      // a viewfinder a few px wide zooms in its own time, which no break crosses at that width
      go = w >= 8 ? at(a + w / 6, b - w / 6) : [this.from() + (this.to() - this.from()) / 6, this.to() - (this.to() - this.from()) / 6]
    } else if (e.key === '-' || e.key === '_') {
      var nw = Math.min(W, w * 1.5)
      var na = clamp((a + b) / 2 - nw / 2, 0, W - nw)
      go = nw >= W ? null : at(na, na + nw)
    } else if (e.key === 'Home' || e.key === '0') go = null
    else return
    e.preventDefault()
    this.set(go, 'set')
  }
  // hovering the overview: the time under the pointer and how many records lie there, or a flag's label
  Range.prototype.hover = function (e) {
    if (!this.sc) return
    var x = this.px(e)
    var r = this.strip.getBoundingClientRect()
    var flag = e.target.closest && e.target.closest('.thimble-range-flag')
    if (flag) {
      var m = this.marksIn[Number(flag.getAttribute('data-i'))]
      if (m) {
        tip('<div class="thimble-tip-h">' + esc(m.label || '') + '</div><div class="thimble-tip-m">' + esc(this.u.at(m.t, 1)) + '</div>', r.left + this.sc.x(m.t), r.bottom, 'under', r.top)
        if (this.onMark && this.markShown !== m) {
          this.markShown = m
          this.call(function (api) {
            this.onMark(m, api)
          }.bind(this))
        }
        return
      }
    }
    this.unmark()
    var col = Math.floor(x / BAR)
    var cs = this.counts && this.counts[col]
    var n = 0
    if (cs) for (var i = 0; i < cs.length; i++) n += cs[i] || 0
    var t0 = this.sc.t(col * BAR)
    var t1 = this.sc.t((col + 1) * BAR)
    var a = Math.abs(x - this.winAt[0]) <= GRIP || Math.abs(x - this.winAt[1]) <= GRIP
    this.strip.style.cursor = this.drag ? '' : a ? 'ew-resize' : x > this.winAt[0] && x < this.winAt[1] && !this.full() ? 'grab' : this.full() && !a ? 'crosshair' : 'pointer'
    tip('<div class="thimble-tip-h">' + esc(this.u.at(t0, t1 - t0)) + '</div>' + (n ? '<div class="thimble-tip-m">' + num(n) + (n === 1 ? ' record' : ' records') + '</div>' : ''), e.clientX, r.bottom, 'under', r.top)
  }
  Range.prototype.unhover = function () {
    untip()
    this.unmark()
  }
  Range.prototype.unmark = function () {
    if (this.markShown && this.onMark) {
      this.markShown = null
      this.call(function (api) {
        this.onMark(null, api)
      }.bind(this))
    }
    this.markShown = null
  }

  function api(r) {
    var out = {
      /** the start of the time the viewfinder frames, in the data's units */
      get from() {
        return r.from()
      },
      /** its end */
      get to() {
        return r.to()
      },
      /** whether it frames the whole span */
      get full() {
        return r.full()
      },
      /** the whole span: [first, last] */
      get span() {
        return r.span.slice()
      },
      /** whether a time lies in the range: from <= t < to, or t <= to at the span's end */
      has: function (t) {
        var a = r.from()
        var b = r.to()
        return t >= a && (t < b || (t <= b && b >= r.span[1]))
      },
      /** the viewfinder set to [from, to]; set(null) shows the whole span */
      set: function (from, to) {
        r.set(from == null ? null : [Number(from), Number(to)], 'set')
        return out
      },
      /** the whole span */
      fit: function () {
        r.fit()
        return out
      },
      /** new data: {times, values, bins, span, marks, gap}, any of them; the range is kept where it can be */
      data: function (d) {
        r.data(d)
        return out
      },
      /** the scale of the range across `width` px, with the same breaks as the overview: {from, to, width, x(t), t(x),
       *  ticks(px), bins(px), step(px), binOf(t), gaps()}, for a chart below that shows the range */
      scale: function (width) {
        var sc = scaleApi(new Scale(r.u, r.from(), r.to(), width, r.segs))
        sc._r = r
        return sc
      },
      /** a time as the readout words it, as precise as `step` (in the units) needs */
      format: function (t, step) {
        return r.u.at(t, step == null ? r.to() - r.from() : step, r.u.time && r.u.parts(r.span[0]).y !== r.u.parts(r.span[1]).y)
      },
      /** the overview drawn again, after the page changed what its values mean */
      redraw: function () {
        r.draw()
        return out
      },
    }
    return out
  }

  /** The time range selector (see the top of this file), in `opts.mount`. Each control keeps its range under `key`. */
  thimble.timeRange = function (opts) {
    opts = opts || {}
    var r = new Range(opts)
    r.api = api(r)
    ranges.push(r)
    if (shared)
      r.check = shared.part({
        changed: function () {
          return !r.full()
        },
        reset: function () {
          r.fit(true)
        },
        fire: function () {
          if (r.onChange) r.call(r.onChange)
        },
      })
    if (opts.times || opts.bins || opts.span) r.data({ times: opts.times, values: opts.values, bins: opts.bins, span: opts.span, marks: opts.marks })
    else if (opts.marks) r.marksIn = opts.marks
    if (opts.values && !opts.times) r.values = opts.values
    return r.api
  }

  // ---------------------------------------------------------------- the view's one readable axis
  /** The axis of a chart drawn on `scale` (range.scale(width)) in `mount`, an element as wide as the chart: its ticks and
   *  labels, the breaks, and `opts.marks` [{t, label}] as flags on a row under it, each labelled; hovering a flag calls
   *  opts.onMark(mark, x) (null when it leaves), for the guide line the chart draws through itself. */
  thimble.timeAxis = function (mount, scale, opts) {
    var box = el(mount)
    if (!box || !scale || !scale._s) return
    opts = opts || {}
    var s = scale._s
    // the range this scale is of leaves its overview's labels out from now on: this axis is the one that reads
    var owner = scale._r
    if (owner && !owner.axisBelow) {
      owner.axisBelow = true
      if (owner.sc) owner.drawAxis()
    }
    var ticks = s.ticks(opts.px || 72)
    var html = '<div class="thimble-axis-row">'
    for (var i = 0; i < ticks.length; i++) {
      var tk = ticks[i]
      html += '<i class="thimble-axis-tick' + (tk.major ? ' major' : '') + '" style="left:' + tk.x.toFixed(1) + 'px"></i>'
      if (tk.label) html += '<span class="thimble-axis-lab' + (tk.major ? ' major' : '') + '" style="left:' + tk.lx.toFixed(1) + 'px">' + esc(tk.label) + '</span>'
    }
    var gaps = s.gaps()
    for (var g = 0; g < gaps.length; g++) html += '<span class="thimble-axis-break" style="left:' + ((gaps[g][0] + gaps[g][1]) / 2).toFixed(1) + 'px">//</span>'
    html += '</div>'
    var marks = Array.isArray(opts.marks) ? opts.marks : []
    if (marks.length) {
      html += '<div class="thimble-axis-flags">'
      // left to right, a flag's label on the side away from the chart's end, and none where it would run into the
      // label before it (the flag keeps its pin, and its label on hover)
      var order = []
      for (var m = 0; m < marks.length; m++) {
        var x = s.x(marks[m].t)
        if (x >= 0 && x <= s.width) order.push([x, m])
      }
      order.sort(function (p, q) {
        return p[0] - q[0]
      })
      var used = []
      for (var o = 0; o < order.length; o++) {
        var fx = order[o][0]
        var mk = marks[order[o][1]]
        var text = String(mk.label || '')
        var right = fx > s.width - 120
        var lw = Math.min(200, 15 + text.length * 6.5)
        var lb = right ? [fx - lw, fx] : [fx, fx + lw]
        var clear = used.every(function (u2) { return lb[1] + 4 <= u2[0] || lb[0] >= u2[1] + 4 })
        if (clear) used.push(lb)
        html += '<button type="button" class="thimble-axis-flag' + (right ? ' end' : '') + '" data-i="' + order[o][1] + '" title="' + esc(text) + '" style="left:' + fx.toFixed(1) + 'px' + (mk.colour ? ';--c:' + esc(mk.colour) : '') + '"><span class="thimble-axis-pin"></span>' + (clear ? '<span class="thimble-axis-fl">' + esc(text) + '</span>' : '') + '</button>'
      }
      html += '</div>'
    }
    box.classList.add('thimble-axis')
    box.setAttribute('data-thimble-chrome', '')
    box.innerHTML = html
    if (typeof opts.onMark === 'function') {
      var fn = opts.onMark
      var on = null
      box.onpointerover = function (e) {
        var f = e.target.closest && e.target.closest('.thimble-axis-flag')
        var mk = f ? marks[Number(f.getAttribute('data-i'))] : null
        if (mk === on) return
        on = mk
        try {
          fn(mk || null, mk ? s.x(mk.t) : null)
        } catch (err) {
          report(err)
        }
      }
      box.onpointerleave = function () {
        if (!on) return
        on = null
        try {
          fn(null, null)
        } catch (err) {
          report(err)
        }
      }
    }
  }

  // the overviews follow Color by: its choice, the values turned off and their colours
  if (shared)
    shared.onColour(function () {
      for (var i = 0; i < ranges.length; i++) ranges[i].draw()
    })
  if (kit.labels)
    kit.labels(function () {
      for (var i = 0; i < ranges.length; i++) if (ranges[i].hasData) ranges[i].draw()
    })
})()
