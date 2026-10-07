// thimble's Color by control for a view's page, part of the view kit: views.frame_document loads it right after
// viewer_bridge.js, whose marks it draws through, and before viewer_range.js (thimble.timeRange), which shares what it
// keeps; viewer_kit.css styles them. A page calls it once:
//
//   const colour = thimble.colorBy({           thimble.colourBy is the same function
//     mount: '#colour',                        an element in the view's top row, which the control fills
//     fields: [{ name: 'kind', title: 'Kind', values: ['Text only', 'With links'] }, { name: 'source' }],
//                                              a declared value may name its palette colour: { name: 'Error', colour: 7 },
//                                              and what it means: { name: 'With links', meaning: 'links to a page' };
//                                              `description` says what the field is; a chip's hover gives them
//     chips: 'filter',                         a value turned off hides its records; 'highlight' (the default) dims them
//     strip: '#list',                          the list that gets the colored tracks, or true for the page
//     onChange: (colour) => draw(),            the choice, a value turned on or off, or the label values changed
//   })
//
// One menu lists together Off, the view's own fields it declares colorable and every label over files, those that mark
// the view's files first, each label with its switch. Each field and label says how many values it colors by and shows
// them as chips on a line under its name, cut off with … where they do not fit; a field that declares no values shows
// those its records take on the page (the records the page hands valueOf, attr and keeps), the commonest first.
// Choosing a label colors by it and opens thimble's label editor beside the menu (thimble.editLabel), which stays open;
// Escape in the editor closes it and puts the focus back on the label's row, and a click in the view closes it too. A
// field colors by the values its records take, each in a palette colour of its own (the label palette, --label-1 to
// --label-12, in the order the values come: the declared `values`, each in the colour it names or else the next free
// one, then the most frequent first, kept per view so a value keeps its colour; the values past the twelve share one
// chip, "Other", in --label-none). Free places go in the order new values take them, blue, orange, green, gold, teal,
// brown, sky, then the rest (backend/app/label_order.json, which views.frame_document puts in the frame as
// window.__thimbleLabelOrder), so the first five are five hues with no second blue; a place a value names or keeps is
// the same hue whatever the order. A label colors by its values on each anchored record, in the label's own colours;
// choosing one turns it on, and a label the analyst turns on, here or anywhere in thimble, takes the colour. Off colors
// nothing: no chips, no bars, grey tracks.
// Color by is thimble's small secondary button with the choice in it. The chosen field's values are key chips in the
// top row (viewer_kit.css .chip-key), each a square swatch of its colour, its name and its count; a click turns a value
// off or on, an Alt-click or a double click keeps that value alone, and hovering a value shows what it means: a label's
// as the label says, a field's as the page declares it (or what the field is). A click on a chip's swatch opens the palette of thimble's twelve label colours: the one picked
// recolours the value everywhere in the view (its chip, the records' bars, the tracks, and what the page draws through
// colourOf). A label's value keeps it through thimble.setLabelColour, so Files and every view show it; a field's value
// keeps it per view with the choice, and the palette's Reset colors gives the field's values their own colours back. On
// a record, colour is always a bar on the left edge of its row or card (the bridge draws it on every element whose
// data-colour is the value of the chosen field, and on every anchored record when a label is chosen), never coloured
// text or a fill.
// The strip is a list's scrollbar as an editor's two tracks, as Files' Transcript mode draws them: the overview track
// shows the whole list in one lane, each pixel row in the colour most of its records take, grey where they take no
// value (a label that is on but is not the choice draws nothing there), and a dark frame around the part in view; a
// long list adds the zoomed track at the outer edge, which magnifies the frame: the part around the view at a finer
// scale, its colours faded beyond the part in view, which lies under a lens joined to the frame by two lines. The lens stands as far down the zoomed track
// as the frame stands down the overview, so the two move together. Hovering the overview shows the records there, a
// click goes there and a drag scrubs. thimble keeps the choice, the values turned off and the colours per view (the bridge's `colour` message),
// with the time ranges viewer_range.js keeps, and hands them back as window.__thimbleColour when the page loads.
//
// Reset, at the row's end, shows while the view is not as it opens: a value turned off, a time range zoomed in, a search
// field or select in the row changed, or what the page says of its own state (thimble.onReset). It puts all of them
// back and keeps the choice of Color by. Hidden, it keeps its place unseen, so the chips fit one width either way.
;(function () {
  'use strict'
  // the bridge's part for the kit (window.__thimbleKit), which viewer_range.js, loaded after this file, takes away
  var kit = window.__thimbleKit
  if (!kit || !window.thimble) return
  var thimble = window.thimble

  var NONE = '\u0000none' // the key of the records that take no value
  var OTHER = '\u0000other' // the key of the one chip for a field's values past the palette's twelve colours
  var OFF = 'off' // what thimble keeps for Color by: Off
  var PALETTE = 12 // --label-1 .. --label-12; a value past them takes --label-none, under the one chip "Other"
  // the palette's places (0 for --label-1) in the order new values take them: label_order.json, which the frame gets as
  // window.__thimbleLabelOrder; without a whole one, the palette's own order, and the page hears of it
  var ORDER = (function (o) {
    var out = []
    if (Array.isArray(o)) for (var i = 0; i < o.length; i++) if (o[i] >= 1 && o[i] <= PALETTE && Math.floor(o[i]) === o[i] && out.indexOf(o[i] - 1) < 0) out.push(o[i] - 1)
    if (out.length === PALETTE) return out
    kit.report(new Error('thimble.colorBy: the label order is missing, so new values take the palette in its own order'))
    for (out = [], i = 0; i < PALETTE; i++) out.push(i)
    return out
  })(window.__thimbleLabelOrder)
  var TRACK_W = 12 // px: the overview track, its lane as wide as it, as the frame is
  var ZOOM_W = 18 // px: the zoomed track, its lane as wide as it, so that the lens's margin is the same on every side
  var LANE_X = 0
  var LINK = 14 // px between the overview and the zoomed track, which the lines from the frame to the lens cross
  var LENS_OUT = 3 // px the lens stands out past the part it shows at every side: its edge and a margin of the paper
  var LENS_R = 4 // px, the lens's corners: the lines from the frame meet its left edge where their curves end
  var ZOOM_AT = 8 // the zoomed track shows once the list is this many times the part in view
  var ZOOM_OFF = 6.5 // and goes again below this, so a list near the line does not flip
  var ZOOM_SPAN = 5 // the zoomed track holds this many heights of the part in view
  var FADE = 0.3 // the zoomed track's colours beyond the part in view, as a share of their strength
  var MIN_MARK = 2 // px, a mark's least height on a track
  var HIT = 3 // px either side of a mark within which a click goes to its record
  var THUMB_MIN = 8 // px, the least height of the box around the part in view
  var PEEK = 6 // records the hover preview lists
  var MAX_KEPT = 200 // values whose colour is kept per field
  var DEF_FOR = 60000 // ms what a label's values mean is kept before it is asked for again
  var ICON = {
    down: 'M6 9l6 6 6-6',
    check: 'M5 12.5l4.5 4.5L19 7',
    plus: 'M12 5v14M5 12h14',
    reset: 'M4 12a8 8 0 1 0 2.35-5.65M4 4.5v4h4',
  }
  function ico(name) {
    return '<svg class="thimble-colour-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="' + ICON[name] + '"/></svg>'
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    })
  }
  function num(n) {
    return Number(n || 0).toLocaleString('en-US')
  }
  function keyOf(v) {
    return v == null || v === '' ? NONE : String(v)
  }
  function el(target) {
    if (target === true) return true
    if (typeof target === 'string') return document.querySelector(target)
    return target && target.nodeType === 1 ? target : null
  }
  function safe(fn, fallback) {
    try {
      return fn()
    } catch (e) {
      kit.report(e)
      return fallback
    }
  }

  // ---------------------------------------------------------------- what is kept per view
  function loadState() {
    var s = window.__thimbleColour
    var out = { by: null, field: null, off: {}, seen: null, colours: {}, picked: {}, range: {} }
    if (!s || typeof s !== 'object') return out
    if (typeof s.by === 'string') out.by = s.by
    if (typeof s.field === 'string') out.field = s.field
    if (s.off && typeof s.off === 'object')
      for (var k in s.off) if (Array.isArray(s.off[k])) out.off[k] = s.off[k].filter(function (x) { return typeof x === 'string' })
    if (Array.isArray(s.seen)) out.seen = s.seen.filter(function (x) { return typeof x === 'string' })
    if (s.colours && typeof s.colours === 'object')
      for (var f in s.colours) {
        var m = s.colours[f]
        if (!m || typeof m !== 'object') continue
        out.colours[f] = {}
        for (var v in m) if (typeof m[v] === 'number' && m[v] >= 0) out.colours[f][v] = m[v]
      }
    // the palette places the analyst picked for a field's values, which go before every other
    if (s.picked && typeof s.picked === 'object')
      for (var pf in s.picked) {
        var pm = s.picked[pf]
        if (!pm || typeof pm !== 'object') continue
        out.picked[pf] = {}
        for (var pv in pm) if (typeof pm[pv] === 'number' && pm[pv] >= 0 && pm[pv] < PALETTE && Math.floor(pm[pv]) === pm[pv]) out.picked[pf][pv] = pm[pv]
      }
    // the time ranges of viewer_range.js, by their key: [from, to]
    if (s.range && typeof s.range === 'object')
      for (var r in s.range) {
        var w = s.range[r]
        if (Array.isArray(w) && w.length === 2 && isFinite(w[0]) && isFinite(w[1]) && w[1] > w[0]) out.range[r] = [Number(w[0]), Number(w[1])]
      }
    return out
  }
  var S = loadState()

  var labelState = null
  var control = null // the one Color by control of the page

  // ---------------------------------------------------------------- the labels
  function onLabels() {
    return (labelState && Array.isArray(labelState.labels) && labelState.labels) || []
  }
  function allLabels() {
    var all = labelState && Array.isArray(labelState.all) ? labelState.all : null
    if (all) return all
    return onLabels().map(function (l) {
      return { id: l.id, name: l.name, on: true, here: true, colour: l.colour, values: (l.values || []).map(function (v) { return { name: v.name, colour: v.colour, highlight: true } }), count: null }
    })
  }
  function labelById(id) {
    var all = allLabels()
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i]
    return null
  }
  function isOn(id) {
    var on = onLabels()
    for (var i = 0; i < on.length; i++) if (on[i].id === id) return true
    return false
  }

  // A label turned on since the view last saw the labels takes the colour, the one turned on last; the labels on now
  // are seen.
  function notice() {
    var ids = onLabels().map(function (l) {
      return String(l.id)
    })
    var before = S.seen || []
    S.seen = ids
    var fresh = ids.filter(function (id) {
      return before.indexOf(id) < 0
    })
    if (fresh.length) S.by = 'l:' + fresh[fresh.length - 1]
  }

  kit.labels(function (state, labelsChanged) {
    labelState = state
    // a page that has not mounted the control keeps nothing: what it sees is noticed once it does
    if (!control) return
    if (!labelsChanged) return control.marksChanged()
    notice()
    control.labelsChanged()
  })

  function save() {
    var keep = { v: 1, by: S.by, field: S.field, off: S.off, seen: S.seen || [], colours: S.colours, picked: S.picked, range: S.range }
    try {
      kit.save(JSON.parse(JSON.stringify(keep)))
    } catch (e) {}
  }

  // ---------------------------------------------------------------- what a label's values mean
  // A label's definition, asked of thimble with a fetch the server answers itself (views.kit_answer): {id, name, kind,
  // text, spec, scope, unit, labeled, values: [{name, highlight, n, meaning}]}, or null when thimble does not know it (an
  // older thimble, a card's frame, the checks' test label). A chip of a label's value says what the value means.
  var defs = {}
  function definition(id) {
    var d = defs[id]
    if (d && Date.now() - d.at < DEF_FOR) return d.wait
    var wait = thimble.fetch({ $thimble: 'label', id: String(id) }).then(
      function (r) {
        var got = r && typeof r === 'object' && r.id != null ? r : null
        defs[id].def = got
        return got
      },
      function () {
        defs[id].def = null
        return null
      },
    )
    defs[id] = { at: Date.now(), wait: wait, def: undefined }
    return wait
  }
  function knownDef(id) {
    return defs[id] ? defs[id].def : undefined
  }
  function meaningOf(def, value) {
    var vs = (def && def.values) || []
    for (var i = 0; i < vs.length; i++) if (vs[i].name === value) return vs[i].meaning || ''
    return ''
  }
  // ---------------------------------------------------------------- the kit's tip: a few words beside the pointer
  // `side`: 'left' of x, 'above' y, 'under' (y the bottom of what it points at, `top` its top: under it, or over it
  // when the frame has no room below), or else below and right of the pointer
  var tipEl = null
  function tip(html, x, y, side, top0) {
    if (!html) return untip()
    if (!tipEl) {
      tipEl = document.createElement('div')
      tipEl.className = 'thimble-tip'
      tipEl.setAttribute('role', 'tooltip')
      tipEl.setAttribute('data-thimble-chrome', '')
      document.body.appendChild(tipEl)
    }
    tipEl.innerHTML = html
    tipEl.style.display = 'block'
    var w = tipEl.offsetWidth
    var h = tipEl.offsetHeight
    var vw = document.documentElement.clientWidth
    var left = side === 'left' ? x - w - 10 : x + 12
    if (left + w > vw - 6) left = x - w - 10
    if (left < 6) left = 6
    var top = side === 'above' ? y - h - 10 : side === 'under' ? y + 8 : y + 14
    if (top + h > innerHeight - 6) top = (side === 'under' && top0 != null ? top0 : y) - h - (side === 'under' ? 8 : 10)
    if (top < 6) top = 6
    tipEl.style.left = left + 'px'
    tipEl.style.top = top + 'px'
  }
  function untip() {
    if (tipEl) tipEl.style.display = 'none'
  }

  // where a palette place comes in ORDER, the order new values take the places in; a place past the palette after all
  function rank(place) {
    var at = ORDER.indexOf(place)
    return at >= 0 ? at : place
  }
  // the first palette place `taken` does not hold, in ORDER; past the palette (--label-none) when it holds all twelve
  function freePlace(taken) {
    for (var i = 0; i < ORDER.length; i++) if (!taken[ORDER[i]]) return ORDER[i]
    var p = PALETTE
    while (taken[p]) p++
    return p
  }
  // A field's declared values and the palette place of each: a value given as {name, colour} takes the colour it names
  // (1 to 12, as a label's value names its colour); the others take the free places in ORDER, in their order
  function declare(list) {
    if (!Array.isArray(list)) return null
    var values = []
    var named = []
    var taken = {}
    var meanings = {}
    for (var i = 0; i < list.length; i++) {
      var v = list[i]
      var obj = v != null && typeof v === 'object'
      var name = String(obj ? v.name : v)
      if (values.indexOf(name) >= 0) continue
      if (obj && typeof v.meaning === 'string' && v.meaning) meanings[name] = v.meaning
      var c = obj ? Number(v.colour) : NaN
      var at = c >= 1 && c <= PALETTE && Math.floor(c) === c && !taken[c - 1] ? c - 1 : -1
      if (at >= 0) taken[at] = true
      values.push(name)
      named.push(at)
    }
    var slots = named.map(function (at) {
      if (at >= 0) return at
      var free = freePlace(taken)
      taken[free] = true
      return free
    })
    return { values: values, slots: slots, meanings: meanings }
  }
  // the palette place a field declares for a value, or -1
  function slotOf(f, key) {
    var at = f && f.values ? f.values.indexOf(key) : -1
    return at < 0 ? -1 : f.slots[at]
  }

  // ---------------------------------------------------------------- the control
  function Control(opts) {
    var self = this
    this.opts = opts
    this.fields = (Array.isArray(opts.fields) ? opts.fields : [])
      .filter(function (f) {
        return f && (typeof f === 'string' || typeof f.name === 'string')
      })
      .map(function (f) {
        if (typeof f === 'string') f = { name: f }
        var declared = declare(f.values)
        // what the field is and what each declared value means, which a chip's hover says
        var about = typeof f.description === 'string' ? f.description : ''
        return { name: String(f.name), title: String(f.title || f.name), values: declared && declared.values, slots: declared && declared.slots, meanings: (declared && declared.meanings) || {}, description: about, value: typeof f.value === 'function' ? f.value : null }
      })
    // the values the fields that declare none take on the records the page hands the kit, each record once (tally)
    this.tallied = this.fields.filter(function (f) {
      return !f.values
    })
    this.tallies = {}
    this.seenRecs = typeof WeakSet === 'function' ? new WeakSet() : null
    this.seenRows = {}
    this.mode = opts.chips === 'filter' ? 'filter' : 'highlight'
    this.initial = typeof opts.initial === 'string' ? opts.initial : this.fields.length ? this.fields[0].name : null
    this.onChange = typeof opts.onChange === 'function' ? opts.onChange : null
    this.mount = el(opts.mount)
    this.given = null // counts the page gave for the current choice: {key: n}
    this.givenBy = null
    this.domCounts = {}
    this.values = [] // the current choice's values: [{key, value, name, colour, n}]
    this.menu = null
    this.strips = []
    this.changeTimer = null
    this.countTimer = null
    this.lastKey = ''
    this.resetShown = false
    if (this.mount) {
      this.mount.classList.add('thimble-colour-mount')
      this.mount.setAttribute('data-thimble-chrome', '')
      this.mount.innerHTML = ''
      this.root = document.createElement('span')
      this.root.className = 'thimble-colour'
      this.mount.appendChild(this.root)
      this.root.addEventListener('click', function (e) {
        self.click(e)
      })
      this.root.addEventListener('dblclick', function (e) {
        var chip = e.target.closest && e.target.closest('.thimble-colour-chip')
        if (!chip) return
        var key = self.keyAt(chip)
        var c = self.choice()
        // the first click of the double click turned the value off or on: that is undone before the value is kept alone
        if (c && self.pre && self.pre.key === key && self.pre.by === c.key) S.off[c.key] = self.pre.off
        self.pre = null
        self.only(key)
      })
      // a label's value shows what the label says it means
      this.root.addEventListener('pointerover', function (e) {
        var chip = e.target.closest && e.target.closest('.thimble-colour-chip')
        if (chip) self.chipTip(chip, e)
      })
      this.root.addEventListener('pointerout', function (e) {
        var chip = e.target.closest && e.target.closest('.thimble-colour-chip')
        if (chip && !(e.relatedTarget && chip.contains(e.relatedTarget))) untip()
      })
      // fitted on the next frame, so the chips hidden or shown are not a resize the observer must hear in the same one
      var fitFrame = null
      var fitWidth = -1
      if (typeof ResizeObserver === 'function')
        new ResizeObserver(function () {
          if (fitFrame != null || !self.mount) return
          fitFrame = requestAnimationFrame(function () {
            fitFrame = null
            var w = self.mount.clientWidth
            if (w === fitWidth) return
            fitWidth = w
            self.fit()
          })
        }).observe(this.mount)
    }
    // the page's own redraws change what is counted and where each value's records are
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var t = records[i].target
        if (t && t.nodeType === 1 && t.closest && t.closest('.thimble-colour-mount,.thimble-colour-menu,.thimble-colour-strip,.thimble-range,.thimble-tip,.thimble-colour-peek')) continue
        self.soon()
        return
      }
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-colour', 'data-anchor', 'data-thimble-off'] })
    if (opts.strip) this.strip(opts.strip)
  }

  Control.prototype.field = function (name) {
    for (var i = 0; i < this.fields.length; i++) if (this.fields[i].name === name) return this.fields[i]
    return null
  }
  // what the colour is now: Off, a field, a label that is on, or nothing
  Control.prototype.choice = function () {
    var by = S.by || ''
    if (by === OFF) return { off: true, title: 'Off', key: OFF }
    if (by.indexOf('l:') === 0) {
      var id = by.slice(2)
      var l = isOn(id) ? labelById(id) : null
      if (l) return { label: id, title: l.name, key: by }
    } else if (by.indexOf('f:') === 0 && this.field(by.slice(2))) {
      var f = this.field(by.slice(2))
      return { field: f.name, title: f.title, key: by }
    }
    var name = S.field && this.field(S.field) ? S.field : this.initial
    var fd = name ? this.field(name) : null
    return fd ? { field: fd.name, title: fd.title, key: 'f:' + fd.name } : null
  }
  Control.prototype.offSet = function (c) {
    c = c || this.choice()
    return c && !c.off ? S.off[c.key] || [] : []
  }
  Control.prototype.isOn = function (value) {
    return this.offSet().indexOf(keyOf(value)) < 0
  }
  // the colour of a field's value, from the palette: the place the analyst picked for it, else a declared value's own
  // place, and the others the first time they are seen, the most frequent first, kept per view so a value keeps its
  // colour
  Control.prototype.fieldColour = function (field, value) {
    var key = keyOf(value)
    if (key === NONE) return null
    var idx = this.placeOf(field, key)
    return kit.realColour(idx < PALETTE ? 'var(--label-' + (idx + 1) + ')' : 'var(--label-none)')
  }
  // the palette place of a field's value (see fieldColour), a value seen for the first time given one; PALETTE or more
  // for a value past the palette's twelve, which goes under "Other"
  Control.prototype.placeOf = function (field, key) {
    var picked = S.picked[field]
    if (picked && typeof picked[key] === 'number') return picked[key]
    var slot = slotOf(this.field(field), key)
    if (slot >= 0) return slot
    var map = S.colours[field] || (S.colours[field] = {})
    if (!(key in map)) this.assign(field, key)
    return typeof map[key] === 'number' ? map[key] : PALETTE
  }
  Control.prototype.assign = function (field, want) {
    var map = S.colours[field] || (S.colours[field] = {})
    var f = this.field(field)
    var declared = (f && f.values) || []
    var used = {}
    var n = 0
    for (var k in map) {
      used[map[k]] = true
      n++
    }
    // the declared values' places are theirs whether or not they have shown yet
    for (var d = 0; d < declared.length; d++) used[f.slots[d]] = true
    var c = this.choice()
    var counts = c && c.field === field ? (this.givenBy === c.key && this.given ? this.given : this.countDom()) : {}
    var fresh = Object.keys(counts).filter(function (v) {
      return v !== NONE && !(v in map)
    })
    if (want != null && want !== NONE && !(want in map) && fresh.indexOf(want) < 0) fresh.push(want)
    fresh.sort(function (a, b) {
      var da = declared.indexOf(a)
      var db = declared.indexOf(b)
      if (da >= 0 || db >= 0) return (da < 0 ? 1e9 : da) - (db < 0 ? 1e9 : db)
      return (counts[b] || 0) - (counts[a] || 0) || (a < b ? -1 : a > b ? 1 : 0)
    })
    for (var i = 0; i < fresh.length && n < MAX_KEPT; i++) {
      var v = fresh[i]
      var at = slotOf(f, v)
      if (at < 0) at = freePlace(used)
      map[v] = at
      used[at] = true
      n++
    }
    this.coloursChanged = true
  }
  Control.prototype.colourOf = function (value) {
    var c = this.choice()
    if (!c || c.off || keyOf(value) === NONE) return null
    if (c.field) return this.fieldColour(c.field, value)
    var l = labelById(c.label)
    var vs = (l && l.values) || []
    for (var i = 0; i < vs.length; i++) if (vs[i].name === String(value)) return vs[i].colour || l.colour || null
    return (l && l.colour) || null
  }
  Control.prototype.valueOf = function (record) {
    var c = this.choice()
    if (!c || c.off || record == null) return null
    if (c.field) {
      // a field's own value(record) takes any record the page has, such as a row's index into its columns
      var f = this.field(c.field)
      var v = f && f.value ? f.value(record) : typeof record === 'object' ? record[c.field] : null
      return v == null || v === '' ? null : String(v)
    }
    var ref = typeof record === 'object' ? record.ref : record
    var m = ref != null ? thimble.markOf(String(ref)) : null
    var vs = m && Array.isArray(m.values) ? m.values : []
    for (var i = 0; i < vs.length; i++) if (vs[i] && vs[i].id === c.label) return String(vs[i].value)
    return null
  }

  // ---------------------------------------------------------------- counts and values
  // the values of the records the page shows, each record once: for a field, the elements with data-colour; for a
  // label, the anchored records, or the view's own units when it anchors no record
  Control.prototype.countDom = function () {
    var c = this.choice()
    var out = {}
    var units = {}
    if (!c || c.off) return out
    var seen = {}
    var records = 0
    var els = document.querySelectorAll(c.field ? '[data-colour]' : '[data-anchor]')
    for (var i = 0; i < els.length; i++) {
      var e = els[i]
      if (e.closest('.thimble-colour-mount,.thimble-colour-menu')) continue
      var ref = e.getAttribute('data-anchor')
      if (ref) {
        if (seen[ref]) continue
        seen[ref] = true
      }
      if (c.field) {
        var k = keyOf(e.getAttribute('data-colour'))
        out[k] = (out[k] || 0) + 1
        continue
      }
      if (!ref || e.tagName === 'CANVAS') continue
      var key = keyOf(this.valueOf(ref))
      var into = /^(view|card|cell):/.test(ref) ? units : out
      if (into === out) records++
      into[key] = (into[key] || 0) + 1
    }
    return c.label && !records ? units : out
  }
  // the chips' values: the label's highlighted values, or the field's declared values and those counted, then no
  // value; none for Off
  Control.prototype.list = function () {
    var c = this.choice()
    if (!c || c.off) return []
    var counts = this.givenBy === c.key && this.given ? this.given : this.domCounts
    var out = []
    var have = {}
    var self = this
    function add(value, name) {
      var key = keyOf(value)
      if (have[key]) return
      have[key] = true
      out.push({ key: key, value: key === NONE ? null : String(value), name: name, colour: key === NONE ? null : self.colourOf(value), n: counts[key] || 0 })
    }
    if (c.label) {
      var l = labelById(c.label)
      var vs = (l && l.values) || []
      for (var i = 0; i < vs.length; i++) if (vs[i].highlight !== false) add(vs[i].name, vs[i].name)
      add(null, 'Not marked')
      return out
    }
    var f = this.field(c.field)
    var declared = f.values || []
    var map = S.colours[f.name] || {}
    var extra = []
    for (var k in counts) if (k !== NONE && declared.indexOf(k) < 0) extra.push(k)
    if (extra.some(function (x) { return !(x in map) })) {
      this.assign(f.name)
      map = S.colours[f.name] || {}
    }
    // the values the view did not declare in the order of their colours, which the most frequent took first (their
    // places' rank in ORDER), so the chips keep their places as the counts change
    extra.sort(function (a, b) {
      var ia = a in map ? rank(map[a]) : 1e9
      var ib = b in map ? rank(map[b]) : 1e9
      return ia - ib || (counts[b] || 0) - (counts[a] || 0) || (a < b ? -1 : a > b ? 1 : 0)
    })
    for (var d = 0; d < declared.length; d++) add(declared[d], declared[d])
    for (var e = 0; e < extra.length; e++) add(extra[e], extra[e])
    // the values past the palette's twelve colours share its grey: one chip, "Other", stands for them all
    var kept = []
    var other = null
    for (var o = 0; o < out.length; o++) {
      if (this.placeOf(f.name, out[o].key) < PALETTE) kept.push(out[o])
      else {
        if (!other) kept.push((other = { key: OTHER, value: null, name: 'Other', colour: kit.realColour('var(--label-none)'), n: 0, members: [] }))
        other.members.push(out[o])
        other.n += out[o].n
      }
    }
    out = kept
    if (counts[NONE]) add(null, 'No ' + f.title.toLowerCase())
    return out
  }
  // the values a chip stands for: its own, or for "Other" those under it
  function keysOf(v) {
    return v.members
      ? v.members.map(function (m) {
          return m.key
        })
      : [v.key]
  }
  // the chips' values with each value under "Other" in its place, as the page and the menu list them
  Control.prototype.flat = function () {
    var out = []
    for (var i = 0; i < this.values.length; i++) {
      var v = this.values[i]
      if (v.members) out.push.apply(out, v.members)
      else out.push(v)
    }
    return out
  }
  // whether a chip's value is on: "Other" while any value under it is
  Control.prototype.chipOn = function (v, off) {
    return keysOf(v).some(function (k) {
      return off.indexOf(k) < 0
    })
  }
  // the values of the records the page hands the kit, for the fields that declare none: each record once, a record
  // being an object (record[field]) or what a field's own value(record) takes, such as a row's index
  Control.prototype.tally = function (record) {
    var fields = this.tallied
    if (!fields.length || record == null) return
    var obj = typeof record === 'object'
    if (obj) {
      if (!this.seenRecs || this.seenRecs.has(record)) return
      this.seenRecs.add(record)
    } else if (typeof record === 'number') {
      if (this.seenRows[record]) return
      this.seenRows[record] = true
    } else return
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i]
      var v = null
      if (f.value)
        try {
          v = f.value(record)
        } catch (e) {
          v = null
        }
      else if (obj) v = record[f.name]
      if (v == null || v === '' || typeof v === 'object') continue
      var t = this.tallies[f.name] || (this.tallies[f.name] = {})
      var k = String(v)
      t[k] = (t[k] || 0) + 1
    }
  }
  Control.prototype.soon = function () {
    var self = this
    if (this.countTimer != null) return
    this.countTimer = setTimeout(function () {
      self.countTimer = null
      self.refresh()
    }, 60)
  }
  // counted again, the chips drawn again when what they show changed, the strip drawn again
  Control.prototype.refresh = function () {
    this.domCounts = this.countDom()
    this.values = this.list()
    var key = JSON.stringify([this.choice(), this.values, this.offSet()])
    if (key !== this.lastKey) {
      this.lastKey = key
      this.render()
      if (this.menu && this.menu.values) this.redrawMenu()
      tellColour()
    }
    if (this.coloursChanged) {
      this.coloursChanged = false
      save()
    }
    for (var i = 0; i < this.strips.length; i++) this.strips[i].dirty()
  }
  // the hook the bridge draws the marks by
  Control.prototype.hook = function () {
    var c = this.choice()
    var self = this
    var off = this.offSet(c)
    var how = this.mode === 'filter' ? 'hide' : 'dim'
    kit.colour(
      c && c.off
        ? { mode: 'off' }
        : c
          ? {
              mode: c.label ? 'label' : 'field',
              label: c.label || null,
              name: c.title,
              colourOf: function (v) {
                return self.colourOf(v)
              },
              off: function (v) {
                return off.indexOf(keyOf(v)) >= 0 ? how : null
              },
            }
          : null,
    )
  }
  // the choice or the values turned off changed: kept, drawn, and the page told once
  // A record's data-colour is its value of the field coloured by, so a new choice takes every one off the page until
  // the page draws its records again (onChange): a value of the field before is never drawn, counted or given a colour
  // of the new one.
  Control.prototype.forget = function () {
    var c = this.choice()
    var key = c ? c.key : ''
    if (this.choiceKey === undefined || this.choiceKey === key) {
      this.choiceKey = key
      return
    }
    this.choiceKey = key
    var els = document.querySelectorAll('[data-colour]')
    for (var i = 0; i < els.length; i++) if (!els[i].closest('.thimble-colour-mount,.thimble-colour-menu')) els[i].removeAttribute('data-colour')
    if (this.givenBy !== key) {
      this.given = null
      this.givenBy = null
    }
  }
  Control.prototype.changed = function () {
    this.forget()
    this.labelKey = this.drawnKey()
    save()
    this.hook()
    this.refresh()
    checkReset()
    if (resetting) return
    this.changedQuiet()
  }
  // what the choice draws: which it is, and for a label its values and their colours
  Control.prototype.drawnKey = function () {
    var c = this.choice()
    var l = c && c.label ? labelById(c.label) : null
    return JSON.stringify([c && c.key, l ? (l.values || []).map(function (v) { return [v.name, v.colour, v.highlight] }) : null])
  }
  Control.prototype.labelsChanged = function () {
    this.forget()
    var key = this.drawnKey()
    var was = this.labelKey
    this.labelKey = key
    save()
    this.hook()
    this.refresh()
    if (this.menu && !this.menu.values && this.menu.palette == null) this.redrawMenu()
    if (key !== was) this.changedQuiet()
  }
  Control.prototype.changedQuiet = function () {
    var self = this
    if (this.changeTimer != null) return
    this.changeTimer = setTimeout(function () {
      self.changeTimer = null
      if (self.onChange) {
        try {
          self.onChange(self.api)
        } catch (e) {
          kit.report(e)
        }
      }
    }, 0)
  }
  // the marks of the label colored by are counted and drawn again, on the chips and the tracks (refresh)
  Control.prototype.marksChanged = function () {
    var c = this.choice()
    if (c && c.label) this.soon()
  }

  // ---------------------------------------------------------------- the top row: Color by, the values' chips, Reset
  Control.prototype.render = function () {
    if (!this.root) return
    var c = this.choice()
    var off = this.offSet(c)
    var lab = c && c.label ? ' data-label="' + esc(c.label) + '"' : ''
    // Color by is thimble's small secondary button, as a menu's trigger: its choice in it and a chevron
    var by = '<button type="button" class="btn btn-secondary btn-sm thimble-colour-by" aria-haspopup="menu" aria-expanded="' + (this.menu && !this.menu.values && this.menu.palette == null ? 'true' : 'false') + '"' + lab + '><span class="thimble-colour-k">Color by:</span><b>' + esc(c ? c.title : 'None') + '</b>' + ico('down') + '</button>'
    // each value is a key chip: a square swatch of its colour, its name and its count
    var chips = ''
    for (var i = 0; i < this.values.length; i++) {
      var v = this.values[i]
      var on = this.chipOn(v, off)
      chips +=
        '<button type="button" class="chip chip-key chip-act thimble-colour-chip" data-i="' + i + '" aria-pressed="' + on + '"' + lab + (v.members ? ' data-other' : '') +
        (v.colour ? ' style="--c:' + esc(v.colour) + '"' : '') + ((c && c.label) || v.members || this.fieldAbout(c, v) ? '' : ' title="' + esc(v.name) + '"') + '><span class="chip-sw"' + (v.colour && !v.members ? ' data-palette title="' + esc('Color of ' + v.name) + '"' : '') + '></span><span class="chip-text">' + esc(v.name) + '</span><span class="chip-count">' + num(v.n) + '</span></button>'
    }
    chips += '<button type="button" class="btn btn-ghost btn-sm thimble-colour-more" hidden></button>'
    var reset = '<button type="button" class="btn btn-secondary btn-sm thimble-reset"' + (this.resetShown ? '' : ' hidden') + '>' + ico('reset') + 'Reset</button>'
    this.root.innerHTML = by + '<span class="thimble-colour-chips">' + chips + '</span>' + reset
    // a menu that stays open over a redraw is anchored again to the new button it opened from
    if (this.menu && !this.menu.anchor.isConnected && this.menu.palette == null) {
      var again = this.root.querySelector(this.menu.values ? '.thimble-colour-more' : '.thimble-colour-by')
      if (again) {
        this.menu.anchor = again
        again.setAttribute('aria-expanded', 'true')
      }
    }
    this.fit()
  }
  // Reset shows only while the view is not as it opens. Hidden, it keeps its place in the row unseen (viewer_kit.css), so
  // showing it changes no width and the same chips fit
  Control.prototype.showReset = function (on) {
    if (on === this.resetShown) return
    this.resetShown = on
    var b = this.root && this.root.querySelector('.thimble-reset')
    if (!b) return
    b.hidden = !on
    // a Reset that gave up its place in a narrow row has it again once it shows, and is fitted again once it hides
    if (b.classList.contains('thimble-reset-gone')) this.fit()
  }
  // the chips that do not fit the row go behind "N more", which lists every value. Reset is laid out whether it shows
  // or not, so the box the chips fit in is one width in both states
  Control.prototype.fit = function () {
    if (!this.root) return
    var box = this.root.querySelector('.thimble-colour-chips')
    var more = this.root.querySelector('.thimble-colour-more')
    if (!box || !more) return
    // the chips' own width, not the box's, which takes the row's free width
    var over = function () {
      var left = box.getBoundingClientRect().left
      var right = left
      for (var k = 0; k < box.children.length; k++) {
        var c = box.children[k]
        if (!c.hidden) right = Math.max(right, c.getBoundingClientRect().right)
      }
      return right - left > box.clientWidth + 1
    }
    var reset = this.root.querySelector('.thimble-reset')
    if (reset) reset.classList.remove('thimble-reset-gone')
    var chips = box.querySelectorAll('.thimble-colour-chip')
    for (var i = 0; i < chips.length; i++) chips[i].hidden = false
    more.hidden = true
    if (!over()) return
    more.hidden = false
    var hid = 0
    for (var j = chips.length - 1; j >= 0 && over(); j--) {
      chips[j].hidden = true
      hid++
      more.innerHTML = hid + ' more' + ico('down')
    }
    // no chip fits and "N more" not even alone: the unseen Reset gives up its place, which changes no chip that shows
    if (over() && reset && reset.hidden) reset.classList.add('thimble-reset-gone')
  }
  // the value a chip or a menu item stands for, by its place among the chips' values (a value's own text may hold what
  // an attribute cannot)
  Control.prototype.keyAt = function (node) {
    var v = this.values[Number(node.getAttribute('data-i'))]
    return v ? v.key : null
  }
  // what a field's value means, as the page declares it, else what the field is ('' for neither)
  Control.prototype.fieldAbout = function (c, v) {
    var f = c && c.field ? this.field(c.field) : null
    if (!f || !v) return ''
    return (v.value != null && f.meanings[v.value]) || f.description || ''
  }
  // what a value means, beside its chip: a field's as the page declares it, a label's once thimble has said
  Control.prototype.chipTip = function (chip, e) {
    var c = this.choice()
    if (!c || c.off) return
    var v = this.values[Number(chip.getAttribute('data-i'))]
    if (v && v.members) {
      var or = chip.getBoundingClientRect()
      if (!this.menu)
        tip('<div class="thimble-tip-h"><span class="thimble-colour-sw" style="--c:' + esc(v.colour || '') + '"></span>Other</div><div class="thimble-tip-m">' +
          v.members.map(function (m) { return esc(m.name) + ' ' + num(m.n) }).join(' · ') + '</div>', or.left, or.bottom - 8)
      return
    }
    if (c.field) {
      var about = this.fieldAbout(c, v)
      var fr = chip.getBoundingClientRect()
      if (about && !this.menu) tip('<div class="thimble-tip-h"><span class="thimble-colour-sw"' + (v.colour ? ' style="--c:' + esc(v.colour) + '"' : '') + '></span>' + esc(v.name) + '</div><div class="thimble-tip-m">' + esc(about) + '</div>', fr.left, fr.bottom - 8)
      return
    }
    if (!v || v.value == null) return
    var id = c.label
    var r = chip.getBoundingClientRect()
    var self = this
    var show = function (def) {
      // not over the palette or a menu the chip opened
      if (!chip.isConnected || !chip.matches(':hover') || self.menu) return
      var m = meaningOf(def, v.value)
      if (m) tip('<div class="thimble-tip-h"><span class="thimble-colour-sw" style="--c:' + esc(v.colour || '') + '"></span>' + esc(v.name) + '</div><div class="thimble-tip-m">' + esc(m) + '</div>', r.left, r.bottom - 8)
    }
    var known = knownDef(id)
    if (known !== undefined) return show(known)
    definition(id).then(show)
    void e
  }
  Control.prototype.click = function (e) {
    var t = e.target
    if (!t.closest) return
    if (t.closest('.thimble-colour-by')) return this.toggleMenu(t.closest('.thimble-colour-by'))
    if (t.closest('.thimble-colour-more')) return this.toggleMenu(t.closest('.thimble-colour-more'), true)
    if (t.closest('.thimble-reset')) return doReset()
    var chip = t.closest('.thimble-colour-chip')
    if (!chip) return
    var key = this.keyAt(chip)
    if (key == null) return
    // the swatch: the palette, to pick the value's colour
    if (t.closest('[data-palette]')) return this.togglePalette(chip)
    if (e.altKey) return this.only(key)
    if (e.detail > 1) return // the second click of a double click, which keeps the value alone
    var c = this.choice()
    this.pre = c ? { key: key, by: c.key, off: (S.off[c.key] || []).slice() } : null
    this.toggle(key)
  }
  // the chip of `key` turned off or on: "Other" turns every value under it
  Control.prototype.toggle = function (key) {
    var c = this.choice()
    if (!c || c.off) return
    var off = (S.off[c.key] || []).slice()
    var v = this.chipOf(key)
    var keys = v ? keysOf(v) : [key]
    var on = v ? this.chipOn(v, off) : off.indexOf(key) < 0
    for (var i = 0; i < keys.length; i++) {
      var at = off.indexOf(keys[i])
      if (on && at < 0) off.push(keys[i])
      else if (!on && at >= 0) off.splice(at, 1)
    }
    S.off[c.key] = off
    this.changed()
  }
  Control.prototype.chipOf = function (key) {
    for (var i = 0; i < this.values.length; i++) if (this.values[i].key === key) return this.values[i]
    return null
  }
  // that value alone (for "Other", the values under it), or every value again when it was alone already
  Control.prototype.only = function (key) {
    var c = this.choice()
    if (!c || c.off) return
    var v = this.chipOf(key)
    var mine = v ? keysOf(v) : [key]
    var others = []
    for (var i = 0; i < this.values.length; i++) if (this.values[i].key !== key) others.push.apply(others, keysOf(this.values[i]))
    var off = S.off[c.key] || []
    var alone = mine.every(function (k) { return off.indexOf(k) < 0 }) && others.every(function (k) { return off.indexOf(k) >= 0 })
    S.off[c.key] = alone ? [] : others
    this.changed()
  }
  Control.prototype.choose = function (by) {
    S.by = by
    if (by.indexOf('f:') === 0) S.field = by.slice(2)
    this.changed()
  }

  // ---------------------------------------------------------------- a value's colour
  // The palette under a chip: thimble's twelve label colours (onLabels' palette, else the tokens), the value's own
  // ringed; for a field, Reset colors when the analyst picked any of its values' colours.
  Control.prototype.togglePalette = function (chip) {
    var v = this.values[Number(chip.getAttribute('data-i'))]
    if (this.menu) {
      var was = this.menu.anchor
      this.closeMenu()
      if (was === chip) return
    }
    if (!v || v.value == null) return
    untip()
    this.openMenu(chip, false, v.key)
  }
  function paletteColour(i) {
    var pal = labelState && Array.isArray(labelState.palette) ? labelState.palette : null
    return pal && typeof pal[i] === 'string' ? pal[i] : kit.realColour('var(--label-' + (i + 1) + ')')
  }
  // a colour as the browser computes it, so that the palette's own (a token's hex) and a value's (rgb) compare
  var colourProbe = null
  function computed(c) {
    if (!c) return ''
    if (!colourProbe || !colourProbe.isConnected) {
      colourProbe = document.createElement('i')
      colourProbe.setAttribute('data-thimble-chrome', '')
      colourProbe.style.display = 'none'
      ;(document.body || document.documentElement).appendChild(colourProbe)
    }
    colourProbe.style.color = ''
    colourProbe.style.color = kit.realColour(c)
    return getComputedStyle(colourProbe).color
  }
  Control.prototype.paletteHtml = function (key) {
    var c = this.choice()
    var v = null
    for (var i = 0; i < this.values.length; i++) if (this.values[i].key === key) v = this.values[i]
    if (!c || c.off || !v) return ''
    var now = computed(v.colour)
    var grid = ''
    for (var j = 0; j < PALETTE; j++) {
      var col = paletteColour(j)
      var cur = !!now && computed(col) === now
      grid += '<button type="button" class="thimble-colour-pick' + (cur ? ' on' : '') + '" data-pick="' + j + '" aria-pressed="' + cur + '" aria-label="' + esc('Colour ' + (j + 1)) + '" style="--c:' + esc(col) + '"></button>'
    }
    var picked = c.field ? S.picked[c.field] : null
    var reset = picked && Object.keys(picked).length ? '<button type="button" class="btn btn-ghost btn-sm thimble-colour-repick" data-reset-colours>' + ico('reset') + 'Reset colors</button>' : ''
    return '<div class="thimble-colour-head"><span class="thimble-colour-sw" style="--c:' + esc(v.colour || '') + '"></span>' + esc(v.name) + '</div><div class="thimble-colour-picks">' + grid + '</div>' + reset
  }
  // the colour picked for a value: a label's through thimble, a field's kept per view
  Control.prototype.pick = function (key, i) {
    var c = this.choice()
    if (!c || c.off || key === NONE) return
    if (c.label) {
      var v = null
      for (var k = 0; k < this.values.length; k++) if (this.values[k].key === key) v = this.values[k]
      if (v && v.value != null) thimble.setLabelColour(c.label, v.value, paletteColour(i)).catch(function (e) { kit.report(e) })
      return
    }
    var map = S.picked[c.field] || (S.picked[c.field] = {})
    map[key] = i
    this.changed()
  }
  Control.prototype.resetColours = function () {
    var c = this.choice()
    if (!c || !c.field) return
    delete S.picked[c.field]
    this.changed()
  }

  // ---------------------------------------------------------------- the menu
  Control.prototype.toggleMenu = function (anchor, values) {
    if (this.menu) {
      var was = this.menu.anchor
      this.closeMenu()
      if (was === anchor) return
    }
    this.openMenu(anchor, values)
  }
  Control.prototype.closeMenu = function () {
    if (!this.menu) return
    this.menu.el.remove()
    untip()
    document.removeEventListener('pointerdown', this.menu.away, true)
    document.removeEventListener('keydown', this.menu.key, true)
    this.menu.anchor.setAttribute('aria-expanded', 'false')
    this.menu = null
  }
  // a field's values as the menu shows them: the chips' while it is the choice (those under "Other" each in its place),
  // else those it declares, those it has shown before and, for a field that declares none, those its records take on the
  // page (tally), the commonest first, each in its colour: a value not yet given one in the colour it would take if the
  // field were chosen now, which is not kept
  Control.prototype.fieldValues = function (f) {
    var c = this.choice()
    if (c && c.field === f.name)
      return this.flat()
        .filter(function (v) {
          return v.key !== NONE
        })
        .map(function (v) {
          return { name: v.name, colour: v.colour }
        })
    var names = (f.values || []).slice()
    var map = S.colours[f.name] || {}
    var seen = Object.keys(map).filter(function (k) {
      return names.indexOf(k) < 0
    })
    seen.sort(function (a, b) {
      return rank(map[a]) - rank(map[b])
    })
    var self = this
    var out = names.concat(seen).map(function (n) {
      return { name: n, colour: self.fieldColour(f.name, n) }
    })
    var t = this.tallies[f.name] || {}
    var fresh = Object.keys(t).filter(function (k) {
      return names.indexOf(k) < 0 && !(k in map)
    })
    fresh.sort(function (a, b) {
      return t[b] - t[a] || (a < b ? -1 : a > b ? 1 : 0)
    })
    if (!fresh.length) return out
    var used = {}
    for (var k in map) used[map[k]] = true
    for (var d = 0; d < names.length; d++) used[f.slots[d]] = true
    var picked = S.picked[f.name] || {}
    for (var i = 0; i < fresh.length; i++) {
      var at = typeof picked[fresh[i]] === 'number' ? picked[fresh[i]] : freePlace(used)
      used[at] = true
      out.push({ name: fresh[i], colour: kit.realColour(at < PALETTE ? 'var(--label-' + (at + 1) + ')' : 'var(--label-none)') })
    }
    return out
  }
  // a label's values as the menu shows them: those it colours by
  function labelValues(l) {
    return (l.values || [])
      .filter(function (v) {
        return v.highlight !== false
      })
      .map(function (v) {
        return { name: v.name, colour: v.colour }
      })
  }
  // a field's or a label's row: its name and how many values it has, then its values as chips on one line, cut off with
  // … where they do not fit; nothing of its values when none is known
  function choiceBody(colour, name, values) {
    var n = values.length
    return (
      '<span class="thimble-colour-body"><span class="thimble-colour-top">' +
      (colour ? '<span class="thimble-colour-sw" style="--c:' + esc(colour) + '"></span>' : '') +
      '<span class="thimble-colour-nm">' + esc(name) + '</span>' +
      (n ? '<span class="thimble-colour-n">' + num(n) + (n === 1 ? ' value' : ' values') + '</span>' : '') +
      '</span>' +
      (n
        ? '<span class="thimble-colour-preview">' +
          values
            .map(function (v) {
              return '<span class="thimble-colour-pchip"><span class="thimble-colour-sw"' + (v.colour ? ' style="--c:' + esc(v.colour) + '"' : '') + '></span>' + esc(v.name) + '</span>'
            })
            .join('') +
          '</span>'
        : '') +
      '</span>'
    )
  }
  Control.prototype.menuHtml = function (values, paletteKey) {
    var c = this.choice()
    if (paletteKey != null) return this.paletteHtml(paletteKey)
    if (values) {
      var off = this.offSet(c)
      var self = this
      return (
        '<div class="thimble-colour-head">' + esc(c ? c.title : '') + '</div>' +
        this.values
          .map(function (v, i) {
            var on = self.chipOn(v, off)
            return '<button type="button" class="thimble-colour-item" role="menuitemcheckbox" aria-checked="' + on + '" data-i="' + i + '"' + (c && c.label ? ' data-label="' + esc(c.label) + '"' : '') + '><span class="thimble-colour-box' + (on ? ' on' : '') + '">' + (on ? ico('check') : '') + '</span><span class="thimble-colour-sw"' + (v.colour ? ' style="--c:' + esc(v.colour) + '"' : '') + '></span><span class="thimble-colour-nm">' + esc(v.name) + '</span><span class="thimble-colour-n">' + num(v.n) + '</span></button>'
          })
          .join('')
      )
    }
    var tick = function (on) {
      return '<span class="thimble-colour-tick">' + (on ? ico('check') : '') + '</span>'
    }
    var html = '<div class="thimble-colour-head">Color by</div>'
    html += '<button type="button" class="thimble-colour-item" role="menuitemradio" aria-checked="' + !!(c && c.off) + '" data-by="' + OFF + '">' + tick(!!(c && c.off)) + '<span class="thimble-colour-nm">Off</span></button>'
    var self = this
    html += this.fields
      .map(function (f) {
        var on = !!(c && c.field === f.name)
        return '<button type="button" class="thimble-colour-item thimble-colour-choice" role="menuitemradio" aria-checked="' + on + '" data-by="' + esc('f:' + f.name) + '"' + (f.description ? ' title="' + esc(f.description) + '"' : '') + '>' + tick(on) + choiceBody('', f.title, self.fieldValues(f)) + '</button>'
      })
      .join('')
    var all = allLabels()
    var row = function (l) {
      var on = !!(c && c.label === l.id)
      var lit = !!l.on || isOn(l.id)
      return (
        '<div class="thimble-colour-item thimble-colour-label thimble-colour-choice" role="menuitemradio" tabindex="0" aria-checked="' + on + '" data-by="' + esc('l:' + l.id) + '" data-label="' + esc(l.id) + '">' + tick(on) +
        choiceBody(l.colour || '', l.name, labelValues(l)) +
        '<button type="button" class="thimble-colour-switch' + (lit ? ' on' : '') + '" role="switch" aria-checked="' + lit + '" aria-label="' + esc((lit ? 'Turn off ' : 'Turn on ') + l.name) + '" data-switch="' + esc(l.id) + '" data-label="' + esc(l.id) + '"><span></span></button></div>'
      )
    }
    var here = all.filter(function (l) { return l.here })
    var other = all.filter(function (l) { return !l.here })
    html += '<div class="thimble-colour-head">Labels over these files</div>'
    html += here.length ? here.map(row).join('') : '<div class="thimble-colour-note">No label covers these files yet</div>'
    if (other.length) html += '<div class="thimble-colour-head">Other labels</div>' + other.map(row).join('')
    if (typeof thimble.newLabel === 'function') html += '<div class="thimble-colour-sep"></div><button type="button" class="thimble-colour-item" data-new>' + '<span class="thimble-colour-tick">' + ico('plus') + '</span><span class="thimble-colour-nm">New label</span></button>'
    return html
  }
  Control.prototype.openMenu = function (anchor, values, paletteKey) {
    var self = this
    var m = document.createElement('div')
    var pal = paletteKey != null
    m.className = 'thimble-colour-menu' + (pal ? ' thimble-colour-palette' : '')
    m.setAttribute('role', pal ? 'dialog' : 'menu')
    if (pal) m.setAttribute('aria-label', 'Color')
    m.setAttribute('data-thimble-chrome', '')
    this.menu = { el: m, anchor: anchor, values: !!values, palette: pal ? paletteKey : null }
    m.innerHTML = this.menuHtml(values, paletteKey)
    document.body.appendChild(m)
    this.placeMenu()
    // the anchor read when it is used: a redraw of the top row gives the menu a new one (render)
    var away = function (e) {
      if (self.menu && !m.contains(e.target) && !self.menu.anchor.contains(e.target)) self.closeMenu()
    }
    var key = function (e) {
      if (e.key === 'Escape' && self.menu) {
        e.stopPropagation()
        var at = self.menu.anchor
        self.closeMenu()
        at.focus()
      }
    }
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', key, true)
    m.addEventListener('click', function (e) {
      self.menuClick(e, values)
    })
    m.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('thimble-colour-label')) {
        e.preventDefault()
        e.target.click()
      }
    })
    this.menu.away = away
    this.menu.key = key
    anchor.setAttribute('aria-expanded', 'true')
  }
  Control.prototype.placeMenu = function () {
    var m = this.menu && this.menu.el
    if (!m) return
    var r = this.menu.anchor.getBoundingClientRect()
    m.style.maxHeight = ''
    var w = m.offsetWidth
    var h = m.offsetHeight
    var vw = document.documentElement.clientWidth
    var left = Math.max(8, Math.min(r.left, vw - w - 8))
    var top = r.bottom + 4
    if (top + h > innerHeight - 8 && r.top - 4 - h >= 8) top = r.top - 4 - h
    m.style.left = left + 'px'
    m.style.top = Math.max(8, top) + 'px'
    m.style.maxHeight = Math.max(120, innerHeight - Math.max(8, top) - 8) + 'px'
  }
  Control.prototype.redrawMenu = function () {
    if (!this.menu) return
    var scroll = this.menu.el.scrollTop
    this.menu.el.innerHTML = this.menuHtml(this.menu.values, this.menu.palette)
    this.menu.el.scrollTop = scroll
  }
  Control.prototype.menuClick = function (e, values) {
    var t = e.target
    var self = this
    if (this.menu && this.menu.palette != null) {
      var pk = this.menu.palette
      var pick = t.closest('[data-pick]')
      if (pick) {
        this.closeMenu()
        return this.pick(pk, Number(pick.getAttribute('data-pick')))
      }
      if (t.closest('[data-reset-colours]')) {
        this.closeMenu()
        return this.resetColours()
      }
      return
    }
    if (values) {
      var it = t.closest('[data-i]')
      var key = it ? this.keyAt(it) : null
      if (key == null) return
      if (e.altKey) this.only(key)
      else this.toggle(key)
      return this.redrawMenu()
    }
    var sw = t.closest('[data-switch]')
    if (sw) {
      e.stopPropagation()
      var id = sw.getAttribute('data-switch')
      var on = !(isOn(id))
      sw.classList.toggle('on', on)
      sw.setAttribute('aria-checked', String(on))
      thimble.setLabel(id, on).catch(function () {
        self.redrawMenu()
      })
      return
    }
    if (t.closest('[data-new]')) {
      this.closeMenu()
      thimble.newLabel().catch(function () {})
      return
    }
    var item = t.closest('[data-by]')
    if (!item) return
    var by = item.getAttribute('data-by')
    if (by.indexOf('l:') === 0) return this.chooseLabel(by.slice(2))
    this.closeMenu()
    this.choose(by)
  }
  // A label chosen: colored by, and its editor opened beside the menu, which stays open with the label checked. Both
  // calls go during the analyst's click: the label turned on first (it takes the colour once thimble says it is on),
  // then the editor, which takes the focus out of the view. The editor closed from inside, the focus goes back to the
  // label's row.
  Control.prototype.chooseLabel = function (id) {
    var self = this
    var by = 'l:' + id
    if (!isOn(id)) {
      S.by = by
      save()
      thimble.setLabel(id, true).catch(function () {})
    } else this.choose(by)
    this.redrawMenu()
    if (typeof thimble.editLabel !== 'function' || !this.menu) return
    thimble
      .editLabel(id, {
        anchor: this.menu.el,
        onClose: function (focused) {
          // closed from inside it: the focus comes back to the label's row, the menu drawn again since it was opened
          var row = focused && self.menu && self.menu.el.querySelector('[data-by="' + by.replace(/["\\]/g, '\\$&') + '"]')
          if (row) row.focus({ preventScroll: true })
        },
      })
      .catch(function () {})
  }

  // ---------------------------------------------------------------- the tracks: a list's colored scrollbar
  // A list's scrollbar as a music or video editor's navigator, in one or two tracks beside the list (the list's own
  // scrollbar is hidden in their favour), drawn as Files' Transcript mode draws its tracks. The overview track is the
  // whole list in one lane: each pixel row in the colour of a value that is on which most of the records there take,
  // grey where they take no value (as the no-value chip is, and every record with Color by Off), never two colours side
  // by side; a label that is on but is not the choice
  // draws nothing on the tracks, and a dark frame shows the part in view. A list many times the
  // height of its box adds the zoomed track at the outer edge, which magnifies the frame: the part around the view at a
  // finer scale, its colours faded beyond the part in view, which lies under a lens (a raised box of the paper, framed),
  // and two lines join the frame's top and bottom to the lens's. The zoomed track's span follows the view, the lens as
  // far down it as the frame is down the overview, so that the two move together. Hovering the overview shows the
  // records there in a preview, without scrolling; a click goes there, a click on a mark to its record, and a drag
  // scrubs, on either track; a drag of the frame moves the view; a wheel over them scrolls the list. `rows`, for a list
  // that draws only the rows in view, gives every row's value in order, which the lanes draw in place of the rows on
  // the page (`refs`, each row's record, is taken and not drawn), and `preview(i)` what the preview says of row i; for a
  // list of elements `preview(el)` may say it instead of each record's own time and first line.
  function Strip(control, target, opts) {
    var self = this
    this.c = control
    this.page = target === true || target === document.documentElement || target === document.body || target === document.scrollingElement
    this.box = this.page ? document.scrollingElement || document.documentElement : target
    this.set(opts)
    this.recs = [] // each record: [top, bottom] as fractions of the list's height, its colour or null, its element or row
    this.stale = true
    this.zoomed = false
    this.frozen = null // the zoomed track's span while a drag on it lasts
    this.el = document.createElement('div')
    this.el.className = 'thimble-colour-strip'
    this.el.setAttribute('data-thimble-chrome', '')
    this.el.setAttribute('aria-hidden', 'true')
    this.whole = this.track('whole', TRACK_W)
    this.zoom = this.track('zoom', ZOOM_W)
    // the lines from the overview's frame to the zoomed track's lens, and the wedge between them
    this.link = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    this.link.setAttribute('class', 'thimble-colour-link')
    this.link.setAttribute('width', String(LINK))
    this.link.innerHTML = '<polygon/><line data-edge="top"/><line data-edge="bottom"/>'
    this.link.style.left = TRACK_W + 'px'
    this.el.appendChild(this.link)
    this.peekEl = document.createElement('div')
    this.peekEl.className = 'thimble-colour-peek'
    this.peekEl.setAttribute('data-thimble-chrome', '')
    this.peekEl.setAttribute('aria-hidden', 'true')
    document.body.appendChild(this.el)
    document.body.appendChild(this.peekEl)
    var pad = this.page ? document.body : this.box
    this.padded = pad
    this.padWas = pad.style.paddingRight
    this.padBase = parseFloat(getComputedStyle(pad).paddingRight || '0') || 0
    this.width = -1
    this.fitWidth()
    this.box.classList.add('thimble-colour-scrolled')
    this.onScroll = function () {
      self.place()
    }
    ;(this.page ? window : this.box).addEventListener('scroll', this.onScroll, { passive: true })
    this.onResize = function () {
      self.dirty()
    }
    window.addEventListener('resize', this.onResize)
    if (typeof ResizeObserver === 'function') {
      this.ro = new ResizeObserver(this.onResize)
      this.ro.observe(this.box)
    }
    this.drag = null
    this.el.addEventListener('pointerdown', function (e) {
      self.down(e)
    })
    this.el.addEventListener('pointermove', function (e) {
      self.move(e)
    })
    this.el.addEventListener('pointerup', function (e) {
      self.up(e)
    })
    this.el.addEventListener('pointercancel', function (e) {
      self.up(e)
    })
    this.el.addEventListener('pointerleave', function () {
      if (!self.drag) self.leave()
    })
    this.el.addEventListener(
      'wheel',
      function (e) {
        e.preventDefault()
        self.box.scrollTop += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * self.box.clientHeight : e.deltaY
      },
      { passive: false },
    )
    this.dirty()
  }
  Strip.prototype.set = function (opts) {
    this.rows = opts && Array.isArray(opts.rows) ? opts.rows : null
    this.refs = opts && Array.isArray(opts.refs) ? opts.refs : null
    this.preview = opts && typeof opts.preview === 'function' ? opts.preview : null
  }
  // a track `w` px wide: its canvas over its box, and over them the frame around the part in view; the zoomed track's
  // lens (its paper, under the canvas, and its edge, the frame over it)
  Strip.prototype.track = function (name, w) {
    var t = document.createElement('div')
    t.className = 'thimble-colour-track thimble-colour-' + name
    t.style.width = w + 'px'
    var lens = null
    if (name === 'zoom') {
      lens = document.createElement('div')
      lens.className = 'thimble-colour-lens'
      t.appendChild(lens)
    }
    var cv = document.createElement('canvas')
    var thumb = document.createElement('div')
    thumb.className = 'thimble-colour-thumb'
    t.appendChild(cv)
    t.appendChild(thumb)
    this.el.appendChild(t)
    return { el: t, canvas: cv, thumb: thumb, lens: lens, name: name, w: w }
  }
  Strip.prototype.remove = function () {
    ;(this.page ? window : this.box).removeEventListener('scroll', this.onScroll)
    window.removeEventListener('resize', this.onResize)
    if (this.ro) this.ro.disconnect()
    this.box.classList.remove('thimble-colour-scrolled')
    this.padded.style.paddingRight = this.padWas
    this.el.remove()
    this.peekEl.remove()
  }
  // the tracks' width, and the room the list leaves them
  // the overview at the left, the zoomed track at the outer edge
  Strip.prototype.fitWidth = function () {
    var w = this.zoomed ? TRACK_W + LINK + ZOOM_W : TRACK_W
    if (w === this.width) return
    this.width = w
    this.el.style.width = w + 'px'
    this.zoom.el.style.display = this.zoomed ? '' : 'none'
    this.link.style.display = this.zoomed ? '' : 'none'
    this.zoom.el.style.left = TRACK_W + LINK + 'px'
    this.padded.style.paddingRight = this.padBase + w + 2 + LENS_OUT + 'px'
  }
  Strip.prototype.dirty = function () {
    var self = this
    this.stale = true
    if (this.frame != null) return
    var go = function () {
      self.frame = null
      self.draw()
    }
    this.frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(go) : setTimeout(go, 16)
  }
  // the box the list shows, in the frame's viewport
  Strip.prototype.rect = function () {
    if (this.page) return { left: 0, top: 0, right: document.documentElement.clientWidth, bottom: innerHeight, height: innerHeight }
    var r = this.box.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, height: r.height }
  }
  function grey() {
    return kit.realColour('rgba(var(--ink-rgb), 0.34)')
  }
  // every record of the list: [top, bottom] as fractions of the list's height, its colour (the marks' grey for a record
  // that takes no value, as for every record with Color by Off), its element or its row; a record of a value turned off
  // is left out, the records with no value too when their chip is off
  Strip.prototype.measure = function () {
    var c = this.c
    var ch = c.choice()
    var recs = []
    var plain = !ch || ch.off
    var off = c.offSet(ch)
    var by = ch && ch.label ? ch.label : null
    var g = grey()
    if (this.rows) {
      var n = this.rows.length
      for (var i = 0; i < n; i++) {
        var key = plain ? '' : keyOf(this.rows[i])
        if (!plain && off.indexOf(key) >= 0) continue
        recs.push([i / n, (i + 1) / n, plain || key === NONE ? g : c.colourOf(this.rows[i]) || g, i])
      }
    } else {
      var box = this.box
      var H = Math.max(1, box.scrollHeight)
      var top0 = this.page ? -box.scrollTop : this.rect().top + box.clientTop - box.scrollTop
      var scope = this.page ? document : box
      var els = scope.querySelectorAll(ch && ch.field ? '[data-colour]' : '[data-anchor]')
      var seen = {}
      for (var j = 0; j < els.length; j++) {
        var e = els[j]
        if (e.tagName === 'CANVAS' || e.closest('.thimble-colour-mount,.thimble-colour-menu,[data-thimble-chrome]')) continue
        var ref = e.getAttribute('data-anchor')
        var v = null
        if (ch && ch.field) v = e.getAttribute('data-colour')
        else {
          if (!ref || seen[ref]) continue
          seen[ref] = true
          if (by) v = c.valueOf(ref)
        }
        var k2 = plain ? '' : keyOf(v)
        if (!plain && off.indexOf(k2) >= 0) continue
        var rr = e.getBoundingClientRect()
        if (!rr.height) continue
        var y = rr.top - top0
        recs.push([y / H, (y + rr.height) / H, plain || k2 === NONE ? g : c.colourOf(v) || g, e])
      }
      recs.sort(function (a, b) {
        return a[0] - b[0]
      })
    }
    this.recs = recs
    this.grey = g
  }
  // the part in view, as fractions of the list's height
  Strip.prototype.view = function () {
    var box = this.box
    var H = Math.max(1, box.scrollHeight)
    return [box.scrollTop / H, Math.min(1, (box.scrollTop + box.clientHeight) / H)]
  }
  // the span the zoomed track shows: ZOOM_SPAN heights of the part in view, the part as far down the span as it is down
  // the list (as a scrollbar's thumb stands), so that the lens moves down the zoomed track as the frame moves down the
  // overview
  Strip.prototype.zoomSpan = function () {
    if (this.frozen) return this.frozen
    var v = this.view()
    var vh = v[1] - v[0]
    var s = Math.min(1, ZOOM_SPAN * vh)
    var f = vh < 1 ? Math.max(0, Math.min(1, v[0] / (1 - vh))) : 0
    var z0 = Math.max(0, Math.min(1 - s, v[0] - f * (s - vh)))
    return [z0, z0 + s]
  }
  Strip.prototype.draw = function () {
    var r = this.rect()
    var box = this.box
    var scrolls = box.scrollHeight > box.clientHeight + 1
    this.el.style.display = scrolls ? '' : 'none'
    if (!scrolls) {
      this.leave()
      return
    }
    var ratio = box.scrollHeight / Math.max(1, box.clientHeight)
    var zoomed = this.zoomed ? ratio >= ZOOM_OFF : ratio >= ZOOM_AT
    if (zoomed !== this.zoomed) {
      this.zoomed = zoomed
      this.fitWidth()
    }
    // the tracks on the device's pixel grid, so that every edge on them is drawn sharp
    var dpr = window.devicePixelRatio || 1
    var snap = function (v) {
      return Math.round(v * dpr) / dpr
    }
    var top = snap(Math.max(r.top, 0) + 2)
    var h = Math.max(0, snap(Math.min(r.bottom, innerHeight) - 2) - top)
    // the lens stands out past the zoomed track, which stands in from the list's edge by as much
    this.el.style.left = snap(r.right - this.width - 2 - (this.zoomed ? LENS_OUT : 0)) + 'px'
    this.el.style.top = top + 'px'
    this.el.style.height = h + 'px'
    this.h = h
    if (this.stale) {
      this.measure()
      this.stale = false
    }
    this.paint(this.whole, [0, 1], null)
    this.place()
  }
  // a track's canvas: the records within `span` (fractions of the list), each pixel row in the one colour most of it
  // takes (the records' share of the row), grey where its records take no value, faded outside `bright`, where the
  // lane's ground gives way to the lens's paper
  Strip.prototype.paint = function (t, span, bright) {
    var h = this.h || 0
    var dpr = window.devicePixelRatio || 1
    var cv = t.canvas
    var W = Math.ceil(t.w * dpr)
    var Hp = Math.ceil(h * dpr)
    if (cv.width !== W) cv.width = W
    if (cv.height !== Hp) cv.height = Hp
    cv.style.width = t.w + 'px'
    cv.style.height = h + 'px'
    var ctx = cv.getContext && cv.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, cv.width, cv.height)
    var x = Math.round(LANE_X * dpr)
    var w = Math.max(1, Math.round((t.w - 2 * LANE_X) * dpr))
    var s0 = span[0]
    var sw = Math.max(1e-9, span[1] - span[0])
    // the part in view, in device rows
    var b0 = bright ? ((bright[0] - s0) / sw) * h * dpr : -Infinity
    var b1 = bright ? ((bright[1] - s0) / sw) * h * dpr : Infinity
    var lit = function (row) {
      return row + 0.5 >= b0 && row + 0.5 <= b1
    }
    // the lens's margin of the paper around the part in view, where nothing is drawn
    var m = LENS_OUT * dpr
    var blank = function (row) {
      return !!bright && row + 0.5 >= b0 - m && row + 0.5 <= b1 + m && !lit(row)
    }
    ctx.globalAlpha = 1
    ctx.fillStyle = kit.realColour('rgba(var(--ink-rgb), 0.035)')
    if (bright) {
      var l0 = Math.max(0, Math.min(cv.height, Math.round(b0 - m)))
      var l1 = Math.max(l0, Math.min(cv.height, Math.round(b1 + m)))
      ctx.fillRect(x, 0, w, l0)
      ctx.fillRect(x, l1, w, cv.height - l1)
    } else ctx.fillRect(x, 0, w, cv.height)
    var recs = this.recs
    // the first record that reaches into the span
    var lo = 0
    var hi = recs.length
    while (lo < hi) {
      var mid = (lo + hi) >> 1
      if (recs[mid][1] < s0) lo = mid + 1
      else hi = mid
    }
    // per device row, each colour's share of it
    var rows = new Array(Hp)
    for (var i = lo; i < recs.length; i++) {
      var rc = recs[i]
      if (rc[0] > span[1]) break
      if (!rc[2]) continue
      var y0 = ((rc[0] - s0) / sw) * h
      var y1 = ((rc[1] - s0) / sw) * h
      if (y1 - y0 < MIN_MARK) {
        y0 = Math.max(0, Math.min(h - MIN_MARK, (y0 + y1 - MIN_MARK) / 2))
        y1 = y0 + MIN_MARK
      }
      var a = y0 * dpr
      var b = y1 * dpr
      for (var r = Math.max(0, Math.floor(a)); r < Math.min(Hp, Math.ceil(b)); r++) {
        var share = Math.min(b, r + 1) - Math.max(a, r)
        if (share <= 0) continue
        var got = rows[r] || (rows[r] = {})
        got[rc[2]] = (got[rc[2]] || 0) + share
      }
    }
    // the colour most of the row's records take; the grey of the records with no value only where none of them takes
    // one, so that records with no value never hide a value's
    var g = this.grey
    var colourAt = function (r) {
      var got = rows[r]
      if (!got) return null
      var best = null
      var most = 0
      for (var c in got) {
        if (c !== g && got[c] > most) {
          most = got[c]
          best = c
        }
      }
      return best || (got[g] ? g : null)
    }
    var y = 0
    while (y < Hp) {
      var c0 = blank(y) ? null : colourAt(y)
      var on = lit(y)
      var end = y + 1
      while (end < Hp && (blank(end) ? null : colourAt(end)) === c0 && lit(end) === on) end++
      if (c0) {
        ctx.globalAlpha = on ? 1 : FADE
        ctx.fillStyle = c0
        ctx.fillRect(x, y, w, end - y)
      }
      y = end
    }
    ctx.globalAlpha = 1
  }
  // the frame around the part in view on the overview, the zoomed track drawn for where it now looks with its lens
  // over the part in view, and the lines from the frame to the lens
  Strip.prototype.place = function () {
    var h = this.h || 0
    var v = this.drag && this.drag.view ? this.drag.view : this.view()
    var dpr = window.devicePixelRatio || 1
    // each edge on the device's pixel grid
    var span = function (a, b, min) {
      var y0 = a * h
      var y1 = b * h
      if (y1 - y0 < min) {
        var m = (y0 + y1) / 2
        y0 = Math.max(0, Math.min(h - min, m - min / 2))
        y1 = y0 + min
      }
      return [Math.round(Math.max(0, y0) * dpr) / dpr, Math.round(Math.min(h, y1) * dpr) / dpr]
    }
    var put = function (el, at) {
      el.style.display = at[1] > at[0] ? '' : 'none'
      el.style.height = Math.max(0, at[1] - at[0]) + 'px'
      el.style.transform = 'translateY(' + at[0] + 'px)'
    }
    this.thumbAt = span(v[0], v[1], THUMB_MIN)
    put(this.whole.thumb, this.thumbAt)
    if (!this.zoomed) return
    var z = this.zoomSpan()
    this.zspan = z
    var s = Math.max(1e-9, z[1] - z[0])
    var shown = span((v[0] - z[0]) / s, (v[1] - z[0]) / s, 4)
    // the lens LENS_OUT outside the part in view, so that its edge and its margin of the paper cover none of it
    var lens = [shown[0] - LENS_OUT, shown[1] + LENS_OUT]
    put(this.zoom.lens, lens)
    put(this.zoom.thumb, lens)
    this.lensAt = lens
    this.paint(this.zoom, z, v)
    // each line from a corner of the frame to the lens's left edge where its corner's curve ends; at a pixel ratio where a
    // 1px line is an odd number of device pixels wide, its ends move half a device pixel into the frame's and the lens's
    // edges, so that it lies on whole device pixels there. The wedge reaches the edges themselves.
    var x1 = LINK - LENS_OUT
    var o = Math.round(dpr) % 2 === 1 ? 0.5 / dpr : 0
    var r = Math.min(LENS_R, (lens[1] - lens[0]) / 2)
    var f = this.thumbAt
    var edges = this.link.querySelectorAll('line')
    var set = function (el, a, b) {
      el.setAttribute('x1', String(-o))
      el.setAttribute('y1', String(a))
      el.setAttribute('x2', String(x1 + o))
      el.setAttribute('y2', String(b))
    }
    set(edges[0], f[0] + o, lens[0] + r)
    set(edges[1], f[1] - o, lens[1] - r)
    this.link.querySelector('polygon').setAttribute('points', '0,' + f[0] + ' ' + x1 + ',' + (lens[0] + r) + ' ' + x1 + ',' + (lens[1] - r) + ' 0,' + f[1])
    this.link.style.height = h + 'px'
  }
  // the list scrolled so that the place `at` (a fraction of it) is in the middle of the box
  Strip.prototype.centre = function (at) {
    var box = this.box
    box.scrollTop = Math.max(0, Math.min(box.scrollHeight - box.clientHeight, at * box.scrollHeight - box.clientHeight / 2))
  }
  // the track under the pointer and the place there, as a fraction of the list
  Strip.prototype.at = function (e) {
    var zr = this.zoomed ? this.zoom.el.getBoundingClientRect() : null
    var onZoom = !!(zr && e.clientX >= zr.left - LINK / 2)
    var t = onZoom ? this.zoom : this.whole
    var r = t.el.getBoundingClientRect()
    var y = Math.max(0, Math.min(this.h || 0, e.clientY - r.top))
    var h = this.h || 1
    var span = onZoom ? this.zspan || this.zoomSpan() : [0, 1]
    return { track: t, y: y, x: e.clientX - r.left, at: span[0] + (y / h) * (span[1] - span[0]), span: span }
  }
  Strip.prototype.recAt = function (p) {
    var h = this.h || 1
    var sw = p.span[1] - p.span[0]
    var best = null
    var bd = Infinity
    for (var i = 0; i < this.recs.length; i++) {
      var t = this.recs[i]
      if (!t[2]) continue
      var y0 = ((t[0] - p.span[0]) / sw) * h
      var y1 = Math.max(((t[1] - p.span[0]) / sw) * h, y0 + MIN_MARK)
      var d = p.y < y0 ? y0 - p.y : p.y > y1 ? p.y - y1 : 0
      if (d <= HIT && d <= bd) {
        best = t
        bd = d
      }
    }
    return best
  }
  Strip.prototype.go = function (t) {
    var box = this.box
    if (typeof t[3] === 'number') box.scrollTop = t[0] * box.scrollHeight - box.clientHeight / 3
    else {
      var r = t[3].getBoundingClientRect()
      var top0 = this.page ? 0 : this.rect().top
      box.scrollTop += r.top - top0 - box.clientHeight / 3
    }
  }
  Strip.prototype.down = function (e) {
    if (e.button !== 0) return
    e.preventDefault()
    var p = this.at(e)
    var whole = p.track === this.whole
    var onThumb = whole && this.thumbAt && p.y >= this.thumbAt[0] - 1 && p.y <= this.thumbAt[1] + 1
    if (!whole) this.frozen = p.span.slice()
    this.drag = { track: p.track, dy: onThumb ? p.y - this.thumbAt[0] : null, y0: e.clientY, moved: false, onThumb: onThumb }
    if (!onThumb) this.centre(p.at)
    this.unpeek()
    if (this.el.setPointerCapture) this.el.setPointerCapture(e.pointerId)
    this.el.setAttribute('data-drag', '')
  }
  Strip.prototype.move = function (e) {
    var d = this.drag
    if (!d) return this.hovered(e)
    if (!d.moved && Math.abs(e.clientY - d.y0) < 3) return
    d.moved = true
    var r = d.track.el.getBoundingClientRect()
    var h = this.h || 1
    var y = e.clientY - r.top
    if (d.onThumb) {
      // the box follows the pointer where it was taken
      var box = this.box
      var top = Math.max(0, y - d.dy) / h
      box.scrollTop = Math.max(0, Math.min(box.scrollHeight - box.clientHeight, top * box.scrollHeight))
    } else {
      var span = d.track === this.whole ? [0, 1] : this.frozen || [0, 1]
      this.centre(span[0] + (Math.max(0, Math.min(h, y)) / h) * (span[1] - span[0]))
    }
    this.place()
  }
  Strip.prototype.up = function (e) {
    var d = this.drag
    this.drag = null
    this.el.removeAttribute('data-drag')
    if (d && !d.moved) {
      var p = this.at(e)
      if (d.track !== this.whole) p.span = this.frozen || p.span
      var t = this.recAt(p)
      if (t) this.go(t)
    }
    this.frozen = null
    this.place()
  }
  // hovering a track: the preview lists the records there, without scrolling
  Strip.prototype.hovered = function (e) {
    this.peek(this.at(e), e)
  }
  Strip.prototype.leave = function () {
    this.unpeek()
  }
  // what the preview says of a record: its time and its first line
  Strip.prototype.peekOf = function (rec) {
    var t = rec[3]
    var got = null
    if (this.preview) got = safe(function () { return this.preview(t) }.bind(this), null)
    if (got != null && typeof got !== 'object') got = { text: String(got) }
    if (got) return { when: got.when || got.time || '', text: got.text || '' }
    if (typeof t === 'number') return { when: '', text: 'Row ' + num(t + 1) }
    var time = t.querySelector && t.querySelector('time')
    var when = (t.getAttribute('data-time') || (time ? time.textContent : '') || '').trim()
    var text = t.getAttribute('data-preview') || t.getAttribute('data-anchor-text') || t.textContent || ''
    text = text.replace(/\s+/g, ' ').trim()
    if (when && text.indexOf(when) === 0) text = text.slice(when.length).trim()
    return { when: when, text: text.slice(0, 160) }
  }
  Strip.prototype.peek = function (p, e) {
    var v = this.view()
    var half = Math.max((v[1] - v[0]) / 2, 0.5 / Math.max(1, this.recs.length))
    var at = p.at
    var near = []
    for (var i = 0; i < this.recs.length; i++) {
      var r = this.recs[i]
      if (r[1] < at - half) continue
      if (r[0] > at + half) break
      near.push(r)
    }
    near.sort(function (a, b) {
      return Math.abs((a[0] + a[1]) / 2 - at) - Math.abs((b[0] + b[1]) / 2 - at)
    })
    near = near.slice(0, PEEK).sort(function (a, b) {
      return a[0] - b[0]
    })
    var self = this
    var html = near
      .map(function (r) {
        var w = self.peekOf(r)
        return '<div class="thimble-peek-row"' + (r[2] ? ' style="--c:' + esc(r[2]) + '"' : '') + '>' + (w.when ? '<time>' + esc(w.when) + '</time>' : '') + '<span class="thimble-peek-t">' + esc(w.text) + '</span></div>'
      })
      .join('')
    if (!html) return this.unpeek()
    var pe = this.peekEl
    pe.innerHTML = html
    pe.style.display = 'block'
    var sr = this.el.getBoundingClientRect()
    var w = pe.offsetWidth
    var ph = pe.offsetHeight
    pe.style.left = Math.max(6, sr.left - w - 6) + 'px'
    pe.style.top = Math.max(6, Math.min(innerHeight - ph - 6, e.clientY - ph / 2)) + 'px'
  }
  Strip.prototype.unpeek = function () {
    this.peekEl.style.display = 'none'
  }

  Control.prototype.strip = function (target, opts) {
    var t = el(target)
    if (!t) return null
    for (var i = 0; i < this.strips.length; i++) {
      var s = this.strips[i]
      if (s.box === t || (t === true && s.page)) {
        if (opts) {
          if ('rows' in opts) s.rows = Array.isArray(opts.rows) ? opts.rows : null
          if ('refs' in opts) s.refs = Array.isArray(opts.refs) ? opts.refs : null
          if ('preview' in opts) s.preview = typeof opts.preview === 'function' ? opts.preview : null
        }
        s.dirty()
        return s
      }
    }
    var made = new Strip(this, t, opts)
    this.strips.push(made)
    return made
  }

  // ---------------------------------------------------------------- details in place
  // A row's details open under its own line, as in the File browser's transcript: thimble.expand(row, render) runs
  // render(), which adds or removes the details (the page may draw the whole list again), keeps the row where it was on
  // the screen, under the pointer that clicked it, and lets the details that appeared grow into place, the rows below
  // moving down with them. The details are the elements render() adds with the class `thimble-details`, or `opts.details`
  // (a selector); the row is found again by its data-anchor, its id or `opts.find()` when render() replaced it.
  var GROW_MS = 160
  function scroller(node) {
    for (var a = node.parentElement; a; a = a.parentElement) {
      var o = getComputedStyle(a).overflowY
      if ((o === 'auto' || o === 'scroll') && a.scrollHeight > a.clientHeight) return a
    }
    return document.scrollingElement || document.documentElement
  }
  function expand(row, render, opts) {
    opts = opts || {}
    var sel = opts.details || '.thimble-details'
    var anchor = row && row.getAttribute ? row.getAttribute('data-anchor') : null
    var id = row && row.id
    var box = row ? scroller(row) : null
    var y0 = row ? row.getBoundingClientRect().top : 0
    var before = typeof Set === 'function' ? new Set(document.querySelectorAll(sel)) : null
    try {
      render()
    } catch (e) {
      kit.report(e)
    }
    if (!row) return
    var again = row.isConnected ? row : typeof opts.find === 'function' ? opts.find() : id ? document.getElementById(id) : null
    if (!again && anchor) {
      var all = document.querySelectorAll('[data-anchor]')
      for (var i = 0; i < all.length; i++)
        if (all[i].getAttribute('data-anchor') === anchor && !all[i].closest(sel)) {
          again = all[i]
          break
        }
    }
    if (again && box) {
      var dy = again.getBoundingClientRect().top - y0
      if (Math.abs(dy) > 0.5) box.scrollTop += dy
    }
    if (!before) return
    var fresh = document.querySelectorAll(sel)
    for (var k = 0; k < fresh.length; k++) {
      var d = fresh[k]
      if (before.has(d) || typeof d.animate !== 'function') continue
      var h = d.offsetHeight
      if (!h) continue
      d.animate([{ height: '0px', opacity: 0, overflow: 'hidden' }, { height: h + 'px', opacity: 1, overflow: 'hidden' }], { duration: GROW_MS, easing: 'ease-out' })
    }
  }
  /** a row's details opened or closed under its own line, the row kept where it is on the screen (see above) */
  thimble.expand = expand

  // ---------------------------------------------------------------- Reset
  // The view as it opens: no value turned off, every time range showing its whole span (viewer_range.js), each search
  // field and select in Color by's row as the page wrote it, and the page's own state as thimble.onReset says. Reset
  // puts them back without telling the page part by part, then calls the page's reset(), which draws once; a page that
  // gave none hears Color by's and each range's onChange, and its fields' input and change events, as usual.
  var parts = [] // the kit's other parts that Reset puts back: {changed(), reset(), fire()}
  var pageReset = null
  var resetting = false
  var resetTimer = null
  function rowFields() {
    var row = control && control.mount && control.mount.parentElement
    if (!row) return []
    var out = []
    var fs = row.querySelectorAll('input.field, select.field')
    for (var i = 0; i < fs.length; i++) {
      var f = fs[i]
      if (f.closest('[data-thimble-chrome]') || f.closest('.thimble-colour-mount')) continue
      if (f.tagName === 'INPUT' && !/^(text|search)$/.test(f.type || 'text')) continue
      out.push(f)
    }
    return out
  }
  function firstIndex(sel) {
    for (var i = 0; i < sel.options.length; i++) if (sel.options[i].defaultSelected) return i
    return sel.options.length ? 0 : -1
  }
  function fieldChanged(f) {
    return f.tagName === 'SELECT' ? f.selectedIndex !== firstIndex(f) : f.value !== f.defaultValue
  }
  function isChanged() {
    if (control && control.offSet().length) return true
    for (var i = 0; i < parts.length; i++) if (safe(parts[i].changed, false)) return true
    if (rowFields().some(fieldChanged)) return true
    return !!(pageReset && pageReset.changed && safe(pageReset.changed, false))
  }
  function checkReset() {
    if (resetTimer != null || !control) return
    resetTimer = setTimeout(function () {
      resetTimer = null
      if (control) control.showReset(isChanged())
    }, 30)
  }
  function doReset() {
    untip()
    resetting = true
    var fired = []
    try {
      S.off = {}
      for (var i = 0; i < parts.length; i++) if (safe(parts[i].changed, false)) fired.push(parts[i])
      for (var j = 0; j < fired.length; j++) safe(fired[j].reset)
      if (control) {
        save()
        control.hook()
        control.refresh()
      }
      var fs = rowFields().filter(fieldChanged)
      for (var k = 0; k < fs.length; k++) {
        var f = fs[k]
        if (f.tagName === 'SELECT') f.selectedIndex = firstIndex(f)
        else f.value = f.defaultValue
        f.dispatchEvent(new Event('input', { bubbles: true }))
        f.dispatchEvent(new Event('change', { bubbles: true }))
      }
    } finally {
      resetting = false
    }
    if (pageReset && pageReset.reset) safe(pageReset.reset)
    else {
      if (control) control.changedQuiet()
      for (var m = 0; m < fired.length; m++) if (fired[m].fire) safe(fired[m].fire)
    }
    if (control) control.showReset(isChanged())
  }
  // a click, a key or a typed letter anywhere may change what the page shows
  ;['input', 'change', 'click', 'keyup'].forEach(function (type) {
    document.addEventListener(type, function () {
      checkReset()
    }, true)
  })

  // the kit's parts that hear Color by: viewer_range.js draws its overview in the values' colours
  var colourFns = []
  var colourTimer = null
  function tellColour() {
    if (colourTimer != null) return
    colourTimer = setTimeout(function () {
      colourTimer = null
      for (var i = 0; i < colourFns.length; i++) safe(colourFns[i])
    }, 0)
  }

  // ---------------------------------------------------------------- what the page holds
  function api(c) {
    var out = {
      /** the colour now: {field, title} or {label, title} (the label's id and name), or null (Off, or nothing) */
      get by() {
        var ch = c.choice()
        return ch && !ch.off ? (ch.label ? { label: ch.label, title: ch.title } : { field: ch.field, title: ch.title }) : null
      },
      /** whether the analyst chose Off, which colors nothing */
      get off() {
        var ch = c.choice()
        return !!(ch && ch.off)
      },
      /** the field colored by, or null while a label is or the colour is Off */
      get field() {
        var ch = c.choice()
        return ch && ch.field ? ch.field : null
      },
      /** the label colored by (its id), or null while a field is or the colour is Off */
      get label() {
        var ch = c.choice()
        return ch && ch.label ? ch.label : null
      },
      /** the chips' values: [{value, name, colour, on, n}], value null for the records that take none, each value under
       *  the chip "Other" in its place; none for Off */
      get values() {
        var off = c.offSet()
        return c.flat().map(function (v) {
          return { value: v.value, name: v.name, colour: v.colour, on: off.indexOf(v.key) < 0, n: v.n }
        })
      },
      /** the value a record takes: its field's (record[field], or the field's own value(record), which may take any
       *  record such as a row's index), or for a label the label's value on record.ref (or on a ref given as a
       *  string); null for none, and always null for Off */
      valueOf: function (record) {
        c.tally(record)
        return c.valueOf(record)
      },
      /** the colour of a value, one a canvas can draw; null for no value and for Off */
      colourOf: function (value) {
        return c.colourOf(value)
      },
      /** whether the analyst left a value on */
      isOn: function (value) {
        return c.isOn(value)
      },
      /** whether a record's value is on: the records a page keeps in a list, a count or a chart */
      keeps: function (record) {
        c.tally(record)
        return c.isOn(c.valueOf(record))
      },
      /** ` data-colour="<value>"` for a record's element while a field is colored by, '' while a label is or for Off:
       *  the bar thimble draws on the element */
      attr: function (record) {
        c.tally(record)
        var ch = c.choice()
        if (!ch || !ch.field) return ''
        var v = c.valueOf(record)
        return ' data-colour="' + esc(v == null ? '' : v) + '"'
      },
      /** the counts of the current choice's values from the reader, {value: n} (the key '' for no value) or [[value, n]];
       *  null counts the elements on the page again */
      counts: function (map) {
        var ch = c.choice()
        if (map == null) {
          c.given = null
          c.givenBy = null
        } else {
          var got = {}
          var pairs = Array.isArray(map) ? map : Object.keys(map).map(function (k) { return [k, map[k]] })
          for (var i = 0; i < pairs.length; i++) if (pairs[i]) got[keyOf(pairs[i][0])] = Number(pairs[i][1]) || 0
          c.given = got
          c.givenBy = ch ? ch.key : null
        }
        c.refresh()
      },
      /** the choice as the reader takes it with a fetch (thimble.colour_value and colour_on in reader.py); null for Off */
      query: function () {
        var ch = c.choice()
        if (!ch || ch.off) return null
        var off = c.offSet(ch).map(function (k) { return k === NONE ? null : k })
        if (ch.label) return { label: ch.label, name: ch.title, off: off }
        return { field: ch.field, off: off }
      },
      /** the colored tracks on a list (an element or a selector, or true for the page); `opts.rows` gives every row's
       *  value in order for a list that draws only the rows in view, `opts.refs` every row's record, `opts.preview(i or
       *  element)` what the hover preview says of a record ({when, text} or a string); a later call with the same list
       *  updates them */
      strip: function (target, opts) {
        c.strip(target, opts)
        return out
      },
    }
    return out
  }

  /** Color by, in the view's top row (see the top of this file). Called again, it replaces the control. */
  thimble.colorBy = function (opts) {
    opts = opts || {}
    if (control) {
      control.closeMenu()
      for (var i = 0; i < control.strips.length; i++) control.strips[i].remove()
      if (control.root) control.root.remove()
    }
    var c = new Control(opts)
    control = c
    c.api = api(c)
    if (labelState) notice()
    c.labelKey = c.drawnKey()
    c.forget()
    c.hook()
    c.refresh()
    checkReset()
    return c.api
  }
  thimble.colourBy = thimble.colorBy

  /** What Reset puts back of the page's own state: `changed()` says whether it differs from how the view opens (a menu's
   *  choice, a selection, a mode), `reset()` puts it back and draws the page again, after the kit has put back its
   *  chips, its time ranges and the search fields of the row. Called again, it replaces the last. `check()` on what it
   *  returns asks again whether Reset shows, for a change the page makes without a click or a key. */
  thimble.onReset = function (opts) {
    opts = opts || {}
    pageReset = { changed: typeof opts.changed === 'function' ? opts.changed : null, reset: typeof opts.reset === 'function' ? opts.reset : null }
    checkReset()
    return { check: checkReset }
  }

  // what viewer_range.js shares: what is kept per view, the colour now, Reset, and the tip
  kit.shared = {
    state: S,
    save: save,
    colour: function () {
      return control ? control.api : null
    },
    onColour: function (fn) {
      colourFns.push(fn)
    },
    part: function (p) {
      parts.push(p)
      checkReset()
      return checkReset
    },
    resetting: function () {
      return resetting
    },
    tip: tip,
    untip: untip,
    esc: esc,
    num: num,
  }
})()
