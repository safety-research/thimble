// thimble's Color by control for a view's page, part of the view kit: views.frame_document loads it right after
// viewer_bridge.js, whose marks it draws through, and before viewer_range.js (thimble.timeRange), which shares what it
// keeps; viewer_kit.css styles them. A page calls it once:
//
//   const colour = thimble.colorBy({           thimble.colourBy is the same function
//     mount: '#colour',                        an element in the view's top row, which the control fills
//     fields: [{ name: 'kind', title: 'Kind', values: ['Text only', 'With links'] }, { name: 'source' }],
//                                              a declared value may name its palette colour: { name: 'Error', colour: 7 },
//                                              and what it means: { name: 'With links', meaning: 'links to a page' };
//                                              `meanings` says what values mean without declaring them, so their
//                                              order and colors stay the records': { meanings: { payments: 'the
//                                              payments API' } }; `description` says what the field is; a chip's hover
//                                              gives them
//     strip: '#list',                          the list that gets the colored strip, or true for the page; another
//                                              list gets it with colour.strip(el, {rows}) or {whole: true}, and is
//                                              a plain scrollbar otherwise
//     onChange: (colour) => draw(),            the choice, a value turned on or off, or the label values changed
//   })
//
// Color by only colors: a value turned off takes its color off its records, which stay, drawn in gray as the records
// with no value are; Filter by (viewer_controls.js) is what hides records. `chips: 'filter'`, which hid them once, is
// still taken and does nothing, as `chips: 'highlight'` does.
//
// One menu takes several choices: Off, then the view's own fields under "Fields" and every label over files under
// "Labels", those that mark the view's files first, a label a choice as a field is (no switch of its own). The first
// checked is the colour; each checked after it is a lane of its own in the list's tracks; with none checked the view is
// Off. Each field and label says how many values it colors by and shows them as chips on a line under its name, cut off
// with … where they do not fit; a field that declares no values shows those its records take on the page (the records
// the page hands valueOf, attr and keeps), the commonest first. Checking a label turns it on in Files and every view and
// opens thimble's label editor beside the menu (thimble.editLabel), which stays open; unchecking it turns it off unless
// Rows or Filter by holds it. Escape in the editor closes it and puts the focus back on the label's row, and a click in
// the view closes it too. A field colors by the values its records take, each in a palette colour of its own (the label
// palette, --label-1 to --label-12, in the order the values come: the declared `values`, each in the colour it names or
// else the next free one, then the most frequent first, kept per view so a value keeps its colour; the values past the
// twelve share one chip, "Other", in --label-none). Free places go in the order new values take them, blue, orange,
// green, gold, teal, brown, sky, then the rest (backend/app/label_order.json, which views.frame_document puts in the
// frame as window.__thimbleLabelOrder), so the first five are five hues with no second blue; a place a value names or
// keeps is the same hue whatever the order. --label-13 to --label-18, red, purple and pink, a value takes only when the
// analyst picks it. A label colors by its values on each anchored record, in the label's own colours; a label the
// analyst turns on anywhere in thimble takes the first place. Off colors nothing: no chips, no bars, no lanes, the tracks
// a plain scrollbar. Colour marks the records alone, the anchored elements: a group's row takes none, and may show its
// records' mix with thimble.mix.
// Color by is thimble's small secondary button with the choice in it. The chosen field's values are key chips in the
// top row (viewer_kit.css .chip-key), each a square swatch of its colour, its name and its count; a click turns a
// value's color off or on, an Alt-click or a double click keeps that value's alone, and hovering a value shows what it
// means: a label's as the label says, a field's as the page declares it (or what the field is). A click on a chip's swatch opens the picker of thimble's label colours
// around the colour wheel (label_wheel.json, window.__thimbleLabelWheel); "N more" lists the chips it hides, each with
// its box, its swatch (the picker under it) and its meaning on hover. The one picked
// recolours the value everywhere in the view (its chip, the records' bars, the tracks, and what the page draws through
// colourOf). A label's value keeps it through thimble.setLabelColour, so Files and every view show it; a field's value
// keeps it per view with the choice, and the palette's Reset colors gives the field's values their own colours back. On
// a record, colour is always a bar on the left edge of its row or card (the bridge draws it on every element whose
// data-colour is the value of the chosen field, and on every anchored record when a label is chosen), never coloured
// text or a fill; with several choices, a band per choice there, side by side in the order of the strip's lanes, each
// in the record's value's colour of that choice and empty where it has none, as a slice of the strip.
// The strip is a list's scrollbar as one strip at every length, as Files' reader draws it: the whole list in a lane for
// the first choice, each pixel row in the colour most of its records take, grey where they take no value, a lane beside
// it for each of Color by's choices past the first, and a thumb framing the part in view; a list whose colours the
// strip cannot know whole, or whose records take none, is a plain scrollbar. Resting on the strip opens the loupe
// beside it, a line per record around the pointer; a click on the strip goes there and a drag scrubs (the strip's
// section below). thimble keeps the choice, the values turned off and the colours per view (the bridge's `colour` message),
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
  var PALETTE = 12 // --label-1 .. --label-12, the places values take by themselves; a value past them takes --label-none,
  // under the one chip "Other"
  var PICKS = 18 // --label-1 .. --label-18, the places the analyst can pick: the twelve, then red, purple and pink, which
  // no value takes by itself
  // the picker's places (1 to PICKS) around the color wheel, a light and a dark of each hue (label_wheel.json, which
  // views.frame_document puts in the frame as window.__thimbleLabelWheel): red, orange, gold, green, teal, sky, blue,
  // purple, pink
  var WHEEL = (function (w) {
    var out = []
    if (Array.isArray(w))
      for (var i = 0; i < w.length; i++) {
        var pair = Array.isArray(w[i]) ? w[i] : [w[i]]
        for (var j = 0; j < pair.length; j++) if (pair[j] >= 1 && pair[j] <= PICKS && Math.floor(pair[j]) === pair[j] && out.indexOf(pair[j] - 1) < 0) out.push(pair[j] - 1)
      }
    if (out.length === PICKS) return out
    for (out = [], i = 0; i < PICKS; i++) out.push(i)
    return out
  })(window.__thimbleLabelWheel)
  var WHEEL_COLS = Math.max(1, Array.isArray(window.__thimbleLabelWheel) ? window.__thimbleLabelWheel.length : 9)
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
    var out = { by: null, picks: null, field: null, off: {}, seen: null, colours: {}, picked: {}, range: {}, parts: {} }
    if (!s || typeof s !== 'object') return out
    // what the kit's other parts keep (viewer_controls.js, viewer_side.js): each part's own small object, by its name
    if (s.parts && typeof s.parts === 'object' && !Array.isArray(s.parts))
      for (var pk in s.parts) if (s.parts[pk] && typeof s.parts[pk] === 'object') out.parts[pk] = s.parts[pk]
    if (typeof s.by === 'string') out.by = s.by
    // Color by's choices in order, the first the colour and each other a track; [] is Off. A view kept before Color by
    // took several has its one choice
    if (Array.isArray(s.picks)) out.picks = s.picks.filter(function (x) { return typeof x === 'string' && /^[fl]:/.test(x) })
    else if (out.by === OFF) out.picks = []
    else if (out.by && /^[fl]:/.test(out.by)) out.picks = [out.by]
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
        for (var pv in pm) if (typeof pm[pv] === 'number' && pm[pv] >= 0 && pm[pv] < PICKS && Math.floor(pm[pv]) === pm[pv]) out.picked[pf][pv] = pm[pv]
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
  var labelsVer = 0 // bumps whenever the labels or their marks change, so that a strip measures its colours again
  var control = null // the one Color by control of the page
  // The strips a part of the kit gives a list while the page has no Color by (kit.shared.strip), such as the search's
  // ticks on the list it finds in: plain scrollbars, owned by a stand-in for the control that colours nothing, and
  // handed to Color by when the page mounts it
  var BARE = {
    strips: [],
    choice: function () { return null },
    extra: function () { return [] },
    offSet: function () { return [] },
    drawnColour: function () { return null },
    fieldColour: function () { return null },
    fieldValue: function () { return null },
    valueOf: function () { return null },
  }
  function allStrips() {
    return (control ? control.strips : []).concat(BARE.strips)
  }

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
  // are seen. A label another part holds (viewer_controls.js: the one Rows groups the lanes by) takes no colour.
  var holds = []
  function notice() {
    var ids = onLabels().map(function (l) {
      return String(l.id)
    })
    var before = S.seen || []
    S.seen = ids
    var held = []
    for (var h = 0; h < holds.length; h++) held = held.concat(safe(holds[h], []) || [])
    var fresh = ids.filter(function (id) {
      return before.indexOf(id) < 0 && held.indexOf(id) < 0
    })
    if (!fresh.length) return
    // the label takes the first place, the colour; a field it takes it from gives way, a label there keeps a track
    var key = 'l:' + fresh[fresh.length - 1]
    var now = control ? control.pickKeys() : []
    if (now.length && now[0].indexOf('f:') === 0) now = now.slice(1)
    S.picks = [key].concat(now.filter(function (k) { return k !== key }))
    S.by = key
  }

  // A label deleted while the view colors by it leaves Color by at Off: it was in thimble's list of every label (`all`)
  // and is no longer, or the first whole list the page hears lacks it. A label turned off stays in that list, and the
  // colour goes back to the view's field.
  function dropDeleted(before, now) {
    if (!now || !Array.isArray(now.all)) return
    var keys = S.picks || (S.by && S.by.indexOf('l:') === 0 ? [S.by] : [])
    var gone = keys.filter(function (k) {
      if (k.indexOf('l:') !== 0) return false
      var named = function (l) {
        return String(l.id) === k.slice(2)
      }
      var had = before && Array.isArray(before.all) ? before.all.some(named) : now.all.length > 0
      return had && !now.all.some(named)
    })
    if (!gone.length) return
    S.picks = keys.filter(function (k) {
      return gone.indexOf(k) < 0
    })
    save()
  }

  kit.labels(function (state, labelsChanged) {
    var before = labelState
    labelState = state
    labelsVer++
    // a page that has not mounted the control keeps nothing: what it sees is noticed once it does
    if (!control) return
    if (!labelsChanged) return control.marksChanged()
    dropDeleted(before, state)
    notice()
    control.labelsChanged()
  })

  function save() {
    if (S.picks) S.by = S.picks[0] || OFF
    var keep = { v: 1, by: S.by, picks: S.picks, field: S.field, off: S.off, seen: S.seen || [], colours: S.colours, picked: S.picked, range: S.range, parts: S.parts }
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
    tipEl.style.left = clearOfStrips(left, top, w, h) + 'px'
    tipEl.style.top = top + 'px'
  }
  function untip() {
    if (tipEl) tipEl.style.display = 'none'
  }
  // A popover's left edge, `left` moved so that the box (left, top, w, h) leaves every list's tracks clear: a menu, a
  // tip or the picker that would lie over them stands left of them, where the frame has room
  var CLEAR = 6 // px a popover keeps from the tracks
  function stripRects() {
    var out = []
    var all = allStrips()
    for (var i = 0; i < all.length; i++) {
      var el = all[i].el
      if (!el || !el.isConnected || el.style.display === 'none') continue
      var r = el.getBoundingClientRect()
      if (r.width && r.height) out.push(r)
    }
    return out
  }
  function clearOfStrips(left, top, w, h) {
    var rs = stripRects()
    for (var i = 0; i < rs.length; i++) {
      var r = rs[i]
      if (top + h <= r.top || top >= r.bottom) continue
      if (left + w <= r.left - CLEAR || left >= r.right + CLEAR) continue
      var to = r.left - CLEAR - w
      if (to >= 6) left = to
    }
    return left
  }
  // the side thimble's label editor opens on beside a menu: to its left where its right would lie over a list's tracks
  // and its left has room (the editor is EDITOR_W px wide); else as thimble places it
  var EDITOR_W = 340
  function editorSide(anchor) {
    var a = anchor.getBoundingClientRect()
    var rs = stripRects()
    for (var i = 0; i < rs.length; i++) {
      var r = rs[i]
      if (a.right + 8 + EDITOR_W > r.left - CLEAR && a.left - 8 - EDITOR_W >= 8) return 'left'
    }
    return undefined
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
        // what the field is and what its values mean, which a chip's hover says: those of `meanings`, which declares no
        // value, then a declared value's own
        var about = typeof f.description === 'string' ? f.description : ''
        var means = {}
        if (f.meanings && typeof f.meanings === 'object' && !Array.isArray(f.meanings))
          for (var k in f.meanings) if (Object.prototype.hasOwnProperty.call(f.meanings, k) && typeof f.meanings[k] === 'string' && f.meanings[k]) means[k] = f.meanings[k]
        if (declared) for (var d in declared.meanings) means[d] = declared.meanings[d]
        return { name: String(f.name), title: String(f.title || f.name), values: declared && declared.values, slots: declared && declared.slots, meanings: means, description: about, value: typeof f.value === 'function' ? f.value : null }
      })
    // the values the fields that declare none take on the records the page hands the kit, each record once (tally)
    this.tallied = this.fields.filter(function (f) {
      return !f.values
    })
    this.tallies = {}
    this.seenRecs = typeof WeakSet === 'function' ? new WeakSet() : null
    this.seenRows = {}
    this.initial = typeof opts.initial === 'string' ? opts.initial : this.fields.length ? this.fields[0].name : null
    this.onChange = typeof opts.onChange === 'function' ? opts.onChange : null
    this.mount = el(opts.mount)
    this.given = null // counts the page gave for the current choice: {key: n}
    this.givenBy = null
    this.domCounts = {}
    this.values = [] // the current choice's values: [{key, value, name, colour, n}]
    this.menu = null
    // the strips the kit's other parts gave lists before Color by was mounted are its own from now on
    this.strips = BARE.strips.splice(0)
    for (var si = 0; si < this.strips.length; si++) {
      this.strips[si].c = this
      this.strips[si].dirty()
    }
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
        if (chip) self.chipTip(chip)
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
      var any = false
      for (var i = 0; i < records.length; i++) {
        var t = records[i].target
        if (t && t.nodeType === 1 && t.closest && t.closest('.thimble-colour-mount,.thimble-colour-menu,.thimble-colour-strip,.thimble-range,.thimble-tip,.thimble-colour-loupe,.thimble-part')) continue
        any = true
        // a strip of a list of elements measures them again only when a change is inside its list
        for (var j = 0; j < self.strips.length; j++) {
          var st = self.strips[j]
          if (!st.touched && (st.page || (t && st.box.contains(t)))) st.touched = true
        }
      }
      if (any) self.soon()
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-colour', 'data-colour-tracks', 'data-anchor'] })
    if (opts.strip) this.strip(opts.strip, { whole: true })
  }

  Control.prototype.field = function (name) {
    for (var i = 0; i < this.fields.length; i++) if (this.fields[i].name === name) return this.fields[i]
    return null
  }
  // a kept choice, 'f:<field>' or 'l:<label id>', as the control reads it: a field the view has, a label that is on
  Control.prototype.resolve = function (by) {
    if (typeof by !== 'string') return null
    if (by.indexOf('l:') === 0) {
      var id = by.slice(2)
      var l = isOn(id) ? labelById(id) : null
      return l ? { label: id, title: l.name, key: by } : null
    }
    var f = by.indexOf('f:') === 0 ? this.field(by.slice(2)) : null
    return f ? { field: f.name, title: f.title, key: by } : null
  }
  // Color by's choices now, in order: the first is the colour, each other a track beside the list's (Strip). None for
  // Off; with none that holds (a label turned off, a field the view dropped), the field chosen last or the first
  Control.prototype.picks = function () {
    if (S.picks && !S.picks.length) return []
    var out = []
    var seen = {}
    var raw = S.picks || []
    for (var i = 0; i < raw.length; i++) {
      var c = seen[raw[i]] ? null : this.resolve(raw[i])
      if (!c) continue
      seen[raw[i]] = true
      out.push(c)
    }
    if (out.length) return out
    var name = S.field && this.field(S.field) ? S.field : this.initial
    var fd = name ? this.field(name) : null
    return fd ? [{ field: fd.name, title: fd.title, key: 'f:' + fd.name }] : []
  }
  Control.prototype.pickKeys = function () {
    return this.picks().map(function (c) {
      return c.key
    })
  }
  // what the colour is now: Off, a field, a label that is on, or nothing
  Control.prototype.choice = function () {
    if (S.picks && !S.picks.length) return { off: true, title: 'Off', key: OFF }
    return this.picks()[0] || null
  }
  // the choices past the first, each a track of its own
  Control.prototype.extra = function () {
    var c = this.choice()
    return c && !c.off ? this.picks().slice(1) : []
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
    return kit.realColour(idx >= 0 ? 'var(--label-' + (idx + 1) + ')' : 'var(--label-none)')
  }
  // the palette place of a field's value (see fieldColour), a value seen for the first time given one: a place the
  // analyst picked (any of PICKS), else one of the twelve; -1 for a value past them, which goes under "Other"
  Control.prototype.placeOf = function (field, key) {
    var picked = S.picked[field]
    if (picked && typeof picked[key] === 'number') return picked[key]
    var slot = slotOf(this.field(field), key)
    if (slot >= 0) return slot
    var map = S.colours[field] || (S.colours[field] = {})
    if (!(key in map)) this.assign(field, key)
    return typeof map[key] === 'number' && map[key] < PALETTE ? map[key] : -1
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
  // the colour a record of the value is drawn in: none for a value turned off, which keeps its records without its colour
  Control.prototype.drawnColour = function (value) {
    return this.isOn(value) ? this.colourOf(value) : null
  }
  Control.prototype.valueOf = function (record) {
    var c = this.choice()
    if (!c || c.off || record == null) return null
    if (c.field) return this.fieldValue(c.field, record)
    return labelValue(c.label, record)
  }
  // a record's value of a field: a field's own value(record) takes any record the page has, such as a row's index into
  // its columns
  Control.prototype.fieldValue = function (name, record) {
    var f = this.field(name)
    if (!f || record == null) return null
    var v = f.value ? f.value(record) : typeof record === 'object' ? record[name] : null
    return v == null || v === '' || typeof v === 'object' ? null : String(v)
  }
  // a label's value on a record (record.ref, or a ref given as a string), from the marks thimble draws; null for none
  function labelValue(id, record) {
    var ref = record != null && typeof record === 'object' ? record.ref : record
    var m = ref != null ? thimble.markOf(String(ref)) : null
    var vs = m && Array.isArray(m.values) ? m.values : []
    for (var i = 0; i < vs.length; i++) if (vs[i] && vs[i].id === id) return String(vs[i].value)
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
    var els = document.querySelectorAll(c.field ? '[data-anchor][data-colour]' : '[data-anchor]')
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
      if (this.placeOf(f.name, out[o].key) >= 0) kept.push(out[o])
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
    var key = JSON.stringify([this.choice(), this.values, this.offSet(), this.extra()])
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
    for (var i = 0; i < this.strips.length; i++) this.strips[i].refreshed()
  }
  // the hook the bridge draws the marks by: a value turned off draws no bar, and its label's texts the plain ink
  Control.prototype.hook = function () {
    var c = this.choice()
    var self = this
    var off = this.offSet(c)
    kit.colour(
      c && c.off
        ? { mode: 'off' }
        : c
          ? {
              mode: c.label ? 'label' : 'field',
              label: c.label || null,
              name: c.title,
              colourOf: function (v) {
                return self.drawnColour(v)
              },
              off: function (v) {
                return off.indexOf(keyOf(v)) >= 0
              },
              // the choices past the first, a band each beside the first's on every record: a label's value from its
              // mark, a field's from the record's data-colour-tracks (attr), at its place there
              tracks: this.extra().map(function (x, at) {
                return x.label
                  ? { label: String(x.label), name: x.title }
                  : {
                      field: x.field,
                      at: at,
                      name: x.title,
                      colourOf: function (v) {
                        return self.fieldColour(x.field, v)
                      },
                    }
              }),
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
    // the tracks' values, which the page writes for the choices past the first (attr), go with those choices
    var tracks = JSON.stringify(this.extra().map(function (x) { return x.key }))
    if (this.tracksKey !== undefined && this.tracksKey !== tracks) {
      var ts = document.querySelectorAll('[data-colour-tracks]')
      for (var t = 0; t < ts.length; t++) ts[t].removeAttribute('data-colour-tracks')
    }
    this.tracksKey = tracks
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
    return JSON.stringify([c && c.key, l ? (l.values || []).map(function (v) { return [v.name, v.colour, v.highlight] }) : null, this.extra().map(function (x) { return x.key })])
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
    if ((c && c.label) || onLabels().length) this.soon()
  }

  // ---------------------------------------------------------------- the top row: Color by, the values' chips, Reset
  Control.prototype.render = function () {
    if (!this.root) return
    var c = this.choice()
    var off = this.offSet(c)
    var lab = c && c.label ? ' data-label="' + esc(c.label) + '"' : ''
    // Color by is thimble's small secondary button, as a menu's trigger: its choice in it and a chevron
    // the choices past the first, each a track beside the list's, as "+N" after the first
    var more = this.extra().length
    var by = '<button type="button" class="btn btn-secondary btn-sm thimble-colour-by" aria-haspopup="menu" aria-expanded="' + (this.menu && !this.menu.values && this.menu.palette == null ? 'true' : 'false') + '"' + lab + '><span class="thimble-colour-k">Color by:</span><b>' + esc(c ? c.title : 'None') + '</b>' + (more ? '<span class="thimble-colour-plus" title="' + esc(this.extra().map(function (x) { return x.title }).join(', ') + ': a track each') + '">+' + more + '</span>' : '') + ico('down') + '</button>'
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
    // the first chip "N more" stands for: none while every chip shows
    this.hiddenFrom = chips.length
    if (!over()) return
    more.hidden = false
    var hid = 0
    for (var j = chips.length - 1; j >= 0 && over(); j--) {
      chips[j].hidden = true
      hid++
      this.hiddenFrom = j
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
    return (v.value != null && Object.prototype.hasOwnProperty.call(f.meanings, v.value) && f.meanings[v.value]) || f.description || ''
  }
  // what a value says on hover, handed to `show` as the tip's html, at once or once thimble has said: for "Other" each
  // value under it with its count, for a field's value its meaning as the page declares it, for a label's value its
  // meaning from the label's definition; nothing for a value with none
  Control.prototype.aboutValue = function (v, show) {
    var c = this.choice()
    if (!c || c.off || !v) return
    var head = function (name) {
      return '<div class="thimble-tip-h"><span class="thimble-colour-sw"' + (v.colour ? ' style="--c:' + esc(v.colour) + '"' : '') + '></span>' + esc(name) + '</div>'
    }
    if (v.members)
      return show(head('Other') + '<div class="thimble-tip-m">' + v.members.map(function (m) { return esc(m.name) + ' ' + num(m.n) }).join(' · ') + '</div>')
    if (c.field) {
      var about = this.fieldAbout(c, v)
      if (about) show(head(v.name) + '<div class="thimble-tip-m">' + esc(about) + '</div>')
      return
    }
    if (v.value == null) return
    var said = function (def) {
      var m = meaningOf(def, v.value)
      if (m) show(head(v.name) + '<div class="thimble-tip-m">' + esc(m) + '</div>')
    }
    var known = knownDef(c.label)
    if (known !== undefined) return said(known)
    definition(c.label).then(said)
  }
  // what a value means, under its chip; not over the palette or a menu the chip opened, nor once the pointer has left
  // the chip by the time thimble says
  Control.prototype.chipTip = function (chip) {
    var self = this
    var v = this.values[Number(chip.getAttribute('data-i'))]
    var now = true
    this.aboutValue(v, function (html) {
      if (!chip.isConnected || self.menu || (!now && !chip.matches(':hover'))) return
      var r = chip.getBoundingClientRect()
      tip(html, r.left, r.bottom - 8)
    })
    now = false
  }
  // the same beside a value's item in the "N more" menu, where its chip does not show: right of the menu, or left of it
  // where the frame has no room
  Control.prototype.itemTip = function (item) {
    var self = this
    var v = this.values[Number(item.getAttribute('data-i'))]
    var now = true
    this.aboutValue(v, function (html) {
      if (!item.isConnected || !self.menu || !self.menu.values || (!now && !item.matches(':hover'))) return
      var r = self.menu.el.getBoundingClientRect()
      var y = item.getBoundingClientRect().top - 14
      tip(html, r.right - 4, y)
      if (tipEl && tipEl.getBoundingClientRect().left < r.right - 4) tip(html, r.left + 4, y, 'left')
    })
    now = false
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
  // `by` alone the choice: 'f:<field>', 'l:<label id>' or Off
  Control.prototype.choose = function (by) {
    S.picks = by === OFF ? [] : [by]
    S.by = by
    if (by.indexOf('f:') === 0) S.field = by.slice(2)
    this.changed()
  }
  // `by` added after the other choices, a track of its own unless it is the first, or taken away; with none left Color
  // by is Off
  Control.prototype.togglePick = function (by) {
    var keys = this.pickKeys()
    var at = keys.indexOf(by)
    if (at >= 0) keys.splice(at, 1)
    else keys.push(by)
    S.picks = keys
    if (keys[0] && keys[0].indexOf('f:') === 0) S.field = keys[0].slice(2)
    else if (by.indexOf('f:') === 0 && at < 0) S.field = by.slice(2)
    this.changed()
    return at < 0
  }

  // ---------------------------------------------------------------- a value's colour
  // The palette under a chip: thimble's label colours around the colour wheel (the labels message's palette, else the
  // tokens), the value's own ringed; for a field, Reset colors when the analyst picked any of its values' colours.
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
  // a palette place's colour: thimble's (the labels message's palette, the PICKS colours then the grey), else the token
  function paletteColour(i) {
    var pal = labelState && Array.isArray(labelState.palette) ? labelState.palette : null
    return pal && pal.length > PICKS && typeof pal[i] === 'string' ? pal[i] : kit.realColour('var(--label-' + (i + 1) + ')')
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
  // a value of the choice by its key, those under "Other" too
  Control.prototype.valueByKey = function (key) {
    var all = this.flat()
    for (var i = 0; i < all.length; i++) if (all[i].key === key) return all[i]
    return null
  }
  // the picker's swatches around the colour wheel, a column per hue, its light above its dark (WHEEL), the value's own
  // ringed
  Control.prototype.picksHtml = function (v) {
    var now = computed(v.colour)
    var grid = ''
    for (var j = 0; j < WHEEL.length; j++) {
      var at = WHEEL[j]
      var col = paletteColour(at)
      var cur = !!now && computed(col) === now
      grid += '<button type="button" class="thimble-colour-pick' + (cur ? ' on' : '') + '" data-pick="' + at + '" aria-pressed="' + cur + '" aria-label="' + esc('Color ' + (at + 1)) + '" style="--c:' + esc(col) + '"></button>'
    }
    return '<div class="thimble-colour-picks" style="--cols:' + WHEEL_COLS + '">' + grid + '</div>'
  }
  Control.prototype.paletteHtml = function (key) {
    var c = this.choice()
    var v = this.valueByKey(key)
    if (!c || c.off || !v) return ''
    var picked = c.field ? S.picked[c.field] : null
    var reset = picked && Object.keys(picked).length ? '<button type="button" class="btn btn-ghost btn-sm thimble-colour-repick" data-reset-colours>' + ico('reset') + 'Reset colors</button>' : ''
    return '<div class="thimble-colour-head"><span class="thimble-colour-sw" style="--c:' + esc(v.colour || '') + '"></span>' + esc(v.name) + '</div>' + this.picksHtml(v) + reset
  }
  // the colour picked for a value: a label's through thimble, a field's kept per view
  Control.prototype.pick = function (key, i) {
    var c = this.choice()
    if (!c || c.off || key === NONE) return
    if (c.label) {
      var v = this.valueByKey(key)
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
      var mine = typeof picked[fresh[i]] === 'number'
      var at = mine ? picked[fresh[i]] : freePlace(used)
      used[at] = true
      out.push({ name: fresh[i], colour: kit.realColour(mine || at < PALETTE ? 'var(--label-' + (at + 1) + ')' : 'var(--label-none)') })
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
  function choiceBody(colour, name, values, note) {
    var n = values.length
    return (
      '<span class="thimble-colour-body"><span class="thimble-colour-top">' +
      (colour ? '<span class="thimble-colour-sw" style="--c:' + esc(colour) + '"></span>' : '') +
      '<span class="thimble-colour-nm">' + esc(name) + '</span>' + (note || '') +
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
  // the values the "N more" of the top row stands for: the chips it hides, each with what its chip offers: its box turns
  // it off or on (Alt keeps it alone), its swatch opens the picker under it, and hovering it says what it means
  Control.prototype.valuesHtml = function () {
    var c = this.choice()
    var off = this.offSet(c)
    var self = this
    var from = Math.max(0, Math.min(this.values.length, this.hiddenFrom == null ? 0 : this.hiddenFrom))
    var pickFor = this.menu ? this.menu.pickFor : null
    var html = '<div class="thimble-colour-head">' + esc(c ? c.title : '') + '</div>'
    for (var i = from; i < this.values.length; i++) {
      var v = this.values[i]
      var on = self.chipOn(v, off)
      var paints = !!v.colour && !v.members && v.value != null
      html +=
        '<div class="thimble-colour-item thimble-colour-val" role="menuitemcheckbox" tabindex="0" aria-checked="' + on + '" data-i="' + i + '"' + (c && c.label ? ' data-label="' + esc(c.label) + '"' : '') + '>' +
        '<span class="thimble-colour-box' + (on ? ' on' : '') + '">' + (on ? ico('check') : '') + '</span>' +
        (paints
          ? '<button type="button" class="thimble-colour-sw thimble-colour-swbtn" data-palette data-i="' + i + '" aria-expanded="' + (pickFor === v.key) + '" aria-label="' + esc('Color of ' + v.name) + '" title="' + esc('Color of ' + v.name) + '" style="--c:' + esc(v.colour) + '"></button>'
          : '<span class="thimble-colour-sw"' + (v.colour ? ' style="--c:' + esc(v.colour) + '"' : '') + '></span>') +
        '<span class="thimble-colour-nm">' + esc(v.name) + '</span><span class="thimble-colour-n">' + num(v.n) + '</span></div>'
      if (pickFor === v.key && paints) {
        var picked = c && c.field ? S.picked[c.field] : null
        html += '<div class="thimble-colour-inpick">' + this.picksHtml(v) + (picked && Object.keys(picked).length ? '<button type="button" class="btn btn-ghost btn-sm thimble-colour-repick" data-reset-colours>' + ico('reset') + 'Reset colors</button>' : '') + '</div>'
      }
    }
    return html
  }
  // the labels another part of the kit holds (the one Rows groups by, the one Filter by filters by)
  function heldIds() {
    var held = []
    for (var h = 0; h < holds.length; h++) held = held.concat(safe(holds[h], []) || [])
    return held.map(String)
  }
  // Color by's menu: Off, then the view's fields and every label, any of them chosen together. The first chosen is the
  // colour and each other a track beside the list's; a choice is checked, and one past the first says it is a track
  Control.prototype.menuHtml = function (values, paletteKey) {
    var c = this.choice()
    if (paletteKey != null) return this.paletteHtml(paletteKey)
    if (values) return this.valuesHtml()
    var keys = c && c.off ? [] : this.pickKeys()
    var box = function (on) {
      return '<span class="thimble-colour-box' + (on ? ' on' : '') + '">' + (on ? ico('check') : '') + '</span>'
    }
    var track = function (by) {
      return keys.indexOf(by) > 0 ? '<span class="thimble-colour-track-n">track</span>' : ''
    }
    var html = '<div class="thimble-colour-head">Color by</div>'
    html += '<button type="button" class="thimble-colour-item" role="menuitemradio" aria-checked="' + !!(c && c.off) + '" data-by="' + OFF + '"><span class="thimble-colour-tick">' + (c && c.off ? ico('check') : '') + '</span><span class="thimble-colour-nm">Off</span></button>'
    var self = this
    if (this.fields.length) html += '<div class="thimble-colour-head">Fields</div>'
    html += this.fields
      .map(function (f) {
        var by = 'f:' + f.name
        var on = keys.indexOf(by) >= 0
        return '<button type="button" class="thimble-colour-item thimble-colour-choice" role="menuitemcheckbox" aria-checked="' + on + '" data-by="' + esc(by) + '"' + (f.description ? ' title="' + esc(f.description) + '"' : '') + '>' + box(on) + choiceBody('', f.title, self.fieldValues(f), track(by)) + '</button>'
      })
      .join('')
    var all = allLabels()
    var row = function (l) {
      var by = 'l:' + l.id
      var on = keys.indexOf(by) >= 0
      return '<button type="button" class="thimble-colour-item thimble-colour-label thimble-colour-choice" role="menuitemcheckbox" aria-checked="' + on + '" data-by="' + esc(by) + '" data-label="' + esc(l.id) + '">' + box(on) + choiceBody(l.colour || '', l.name, labelValues(l), track(by)) + '</button>'
    }
    // the labels that mark the view's files first
    var here = all.filter(function (l) { return l.here })
    var other = all.filter(function (l) { return !l.here })
    html += '<div class="thimble-colour-head">Labels</div>'
    html += here.length || other.length ? here.concat(other).map(row).join('') : '<div class="thimble-colour-note">No label covers these files yet</div>'
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
    this.menu = { el: m, anchor: anchor, values: !!values, palette: pal ? paletteKey : null, pickFor: null }
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
    // a value's item in the "N more" menu says what its chip would on hover
    if (values) {
      m.addEventListener('pointerover', function (e) {
        var it = e.target.closest && e.target.closest('.thimble-colour-item[data-i]')
        if (it) self.itemTip(it)
      })
      m.addEventListener('pointerout', function (e) {
        var it = e.target.closest && e.target.closest('.thimble-colour-item[data-i]')
        if (it && !(e.relatedTarget && it.contains(e.relatedTarget))) untip()
      })
    }
    m.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('thimble-colour-val')) {
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
    top = Math.max(8, top)
    m.style.left = clearOfStrips(left, top, w, Math.min(h, innerHeight - top - 8)) + 'px'
    m.style.top = top + 'px'
    m.style.maxHeight = Math.max(120, innerHeight - top - 8) + 'px'
  }
  Control.prototype.redrawMenu = function () {
    if (!this.menu) return
    var scroll = this.menu.el.scrollTop
    this.menu.el.innerHTML = this.menuHtml(this.menu.values, this.menu.palette)
    this.menu.el.scrollTop = scroll
  }
  Control.prototype.menuClick = function (e, values) {
    var t = e.target
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
      // the picker under a value: a colour picked recolours it, and the menu stays open with its new colour
      var pk2 = this.menu ? this.menu.pickFor : null
      var pick2 = t.closest('[data-pick]')
      if (pick2 && pk2 != null) {
        this.menu.pickFor = null
        this.pick(pk2, Number(pick2.getAttribute('data-pick')))
        return this.redrawMenu()
      }
      if (t.closest('[data-reset-colours]')) {
        this.menu.pickFor = null
        this.resetColours()
        return this.redrawMenu()
      }
      var it = t.closest('[data-i]')
      var key = it ? this.keyAt(it) : null
      if (key == null) return
      if (t.closest('[data-palette]')) {
        untip()
        this.menu.pickFor = this.menu.pickFor === key ? null : key
        return this.redrawMenu()
      }
      if (e.altKey) this.only(key)
      else this.toggle(key)
      return this.redrawMenu()
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
    if (by === OFF) {
      this.closeMenu()
      return this.choose(OFF)
    }
    this.togglePick(by)
    this.redrawMenu()
  }
  // A label checked: one of Color by's choices, turned on in Files and every view, and its editor opened beside the
  // menu, which stays open. Both calls go during the analyst's click: the label turned on first (it colours once
  // thimble says it is on), then the editor, which takes the focus out of the view; the editor closed from inside, the
  // focus goes back to the label's row. A label unchecked leaves the choices and is turned off, unless another part of
  // the kit (Rows, Filter by) holds it.
  Control.prototype.chooseLabel = function (id) {
    var self = this
    var by = 'l:' + id
    if (this.pickKeys().indexOf(by) >= 0) {
      this.togglePick(by)
      if (heldIds().indexOf(String(id)) < 0) thimble.setLabel(id, false).catch(function () {})
      return this.redrawMenu()
    }
    // seen, so that it keeps its place after the others when thimble says it is on (notice)
    if (!Array.isArray(S.seen)) S.seen = []
    if (S.seen.indexOf(String(id)) < 0) S.seen.push(String(id))
    if (!isOn(id)) {
      var keys = this.pickKeys().filter(function (k) {
        return k !== by
      })
      keys.push(by)
      S.picks = keys
      save()
      thimble.setLabel(id, true).catch(function () {})
    } else this.togglePick(by)
    this.redrawMenu()
    if (typeof thimble.editLabel !== 'function' || !this.menu) return
    thimble
      .editLabel(id, {
        anchor: this.menu.el,
        side: editorSide(this.menu.el),
        onClose: function (focused) {
          // closed from inside it: the focus comes back to the label's row, the menu drawn again since it was opened
          var row = focused && self.menu && self.menu.el.querySelector('[data-by="' + by.replace(/["\\]/g, '\\$&') + '"]')
          if (row) row.focus({ preventScroll: true })
        },
      })
      .catch(function () {})
  }

  // ---------------------------------------------------------------- the strip: a list's colored scrollbar
  // A list's scrollbar as one strip beside the list at every length (the list's own scrollbar is hidden in its favour),
  // as Files' reader and the Report draw theirs (frontend/src/files/Tracks.tsx and Loupe.tsx): the scrollbar's track
  // drawn as the whole list, a lane for Color by's first choice, each pixel row in the colour of a value that is on which
  // most of the records there take, grey where they take no value (as the no-value chip is), never two colours side by
  // side; a lane beside it in its own colours for each choice past the first, named on hover; over the lanes a thumb that
  // frames the part in view. The colours show only where the strip knows the whole list (Color by's own strip, `rows`,
  // or `whole: true`) and some record takes one; otherwise the strip is a plain scrollbar with no lane. A drag of the
  // thumb scrubs the list; a click elsewhere on the strip sends the thumb there, its middle under the pointer, and a
  // click within SNAP_PX of a thin patch of a colour goes to the patch's first record and highlights it for a moment; the
  // wheel over the strip scrolls the list. The strip moves in the browser's animation frames with transforms alone, and
  // goes onto the device's pixel grid once still.
  //
  // Where the strip draws a record shorter than TELL_APART_PX, resting on it LOUPE_REST_MS opens the loupe beside it: a
  // short list, a line per record around the pointer, each its line or key, a cell per lane of the strip in the
  // record's colour, and the start of its text; the record under the pointer darker, those in view tinted, and a bracket
  // beside the strip over the stretch it shows. It follows the pointer along the strip, and the records around the thumb
  // only after a real scroll (the wheel over the strip or the loupe, a drag of the thumb): the list's place changing
  // never moves it, so it never tells a scroll from scroll positions. Once the pointer is in it, it holds still: a click
  // goes to the record there and leaves the rows where they are, and the wheel scrolls the list, its rows following. On
  // a touch screen a press on the strip opens it, a drag scrubs and the release goes there. A strip that tells every
  // record apart names the record under the pointer on rest instead, on one line.
  //
  // What the loupe says of a record comes from what the page gives the strip: for a list given its rows, `preview(i)`
  // (a string, or `{when, text}`), else the row's element where the page draws it; for a list of elements,
  // `preview(el)`, else the element's `<time>` (or data-time) and its text. Its first column is the line its ref names
  // (`refs`, or its data-anchor: `#L12` is 12), else the key after the ref's `#` or its last `/`, else the row's place.
  var PLAIN_W = 10 // px: the strip with no lane, a plain scrollbar
  var LANE_W = 7 // px: a lane of the strip, 2 px from the next, 3 px in from the strip's edges (Files' TRACK_LANES)
  var LANE_GAP = 2
  var LANE_INSET = 3
  var EDGE = 2 // px the strip stands in from the list's box
  var MIN_MARK = 2 // px, a mark's least height on the strip
  var SNAP_PX = 4 // px either side of a click on the strip within which it snaps to a thin patch of colour
  var THIN_PX = 8 // px a patch of colour may be tall at most to be thin: a click in a taller one goes where it is clicked
  var THUMB_MIN = 14 // px, the thumb's least height over lanes, and on a plain scrollbar
  var PLAIN_THUMB_MIN = 32
  var DRAG_PX = 3 // px the pointer moves before a press on the strip becomes a drag
  var GLIDE_MS = 160 // ms the thumb takes to go from where a drag left it to the list's place
  var SETTLE_MS = 60 // ms the thumb stays still before its edges go onto the device's pixel grid
  var JUMP_PX = 12 // px the thumb moves at once, with nothing held, past which it glides to the list's new place
  var LOUPE_REST_MS = 250 // ms the pointer is on the strip before the loupe opens
  var NAME_MS = 120 // ms it is on a strip that tells every record apart before the record under it is named
  var LOUPE_ROWS = 17 // the loupe's rows at most, LOUPE_ROW_PX each, LOUPE_PAD_PX of its paper above and below them
  var LOUPE_ROW_PX = 16
  var LOUPE_PAD_PX = 4
  var LOUPE_OFF_PX = 8 // px between the loupe and the strip, which the pointer crosses into it
  var TELL_APART_PX = 3 // px a record takes on the strip below which the strip cannot tell the records apart
  var LOUPE_MIN_W = 200 // px, the loupe's width at the least and at the most
  var LOUPE_MAX_W = 360
  var LOUPE_INSET = 4 // px the loupe stays inside the strip's height
  var BRACKET_PX = 4 // px, the bracket's width beside the strip
  var TEXT_CHARS = 200 // the characters of a record's text the loupe writes; its row cuts the rest with an ellipsis
  var KEY_CHARS = 12 // the characters of a record's line or key its first column holds at most
  // The search's matches (viewer_search.js) are a lane of their own at the strip's left, as Files' find: a tick in the
  // ink per match, like a cue point on a timeline, never a colour, and a click within TICK_HIT_PX of one goes to that
  // match. With Color by Off the strip is that lane alone; with no search and Off, a plain scrollbar.
  var TICK_HIT_PX = 4
  var FINDS = typeof WeakMap === 'function' ? new WeakMap() : null // a list's box -> its matches, {name, ticks, has, go}

  // the strip's width for `n` lanes, px: the lanes, or a plain scrollbar
  function stripWidth(n) {
    return n ? n * LANE_W + (n - 1) * LANE_GAP + 2 * LANE_INSET : PLAIN_W
  }
  // the `n` lanes' left edges and widths in device pixels at `dpr`, each a whole number of pixels from the last
  function laneBoxes(n, dpr) {
    var w = Math.max(1, Math.round(LANE_W * dpr))
    var pitch = Math.max(w + 1, Math.round((LANE_W + LANE_GAP) * dpr))
    var x0 = Math.round(LANE_INSET * dpr)
    var out = []
    for (var i = 0; i < n; i++) out.push([x0 + i * pitch, w])
    return out
  }
  // the lane under a point `x` css px from the strip's left edge, of `n`
  function laneAt(x, n) {
    return Math.max(0, Math.min(n - 1, Math.floor((x - LANE_INSET + LANE_GAP / 2) / (LANE_W + LANE_GAP))))
  }
  function grey() {
    return kit.realColour('rgba(var(--ink-rgb), 0.34)')
  }
  // a record's text on one line: its spaces as one, cut to TEXT_CHARS with an ellipsis
  function oneLine(text) {
    var t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
    return t.length > TEXT_CHARS ? t.slice(0, TEXT_CHARS - 1) + '\u2026' : t
  }
  // a record's first column in the loupe: the line its ref names, else the key after its `#` or its last `/`, else the
  // row's place (`at`, from 0), else nothing
  function refKey(ref, at) {
    if (ref != null && ref !== '') {
      var s = String(ref)
      var m = /#L(\d+)/.exec(s)
      if (m) return num(m[1])
      var h = s.lastIndexOf('#')
      if (h >= 0 && h < s.length - 1) return s.slice(h + 1)
      var sl = s.replace(/\/+$/, '').lastIndexOf('/')
      return sl >= 0 ? s.slice(sl + 1) : s
    }
    return typeof at === 'number' ? num(at + 1) : ''
  }
  // the first record a loupe of `n` rows shows around the unit `c`: its record in the middle row, kept within `total`
  function loupeStart(c, total, n) {
    return Math.max(0, Math.min(Math.max(0, total - n), Math.floor(c) - Math.floor(n / 2)))
  }
  function loupeHeight(n) {
    return n * LOUPE_ROW_PX + 2 * LOUPE_PAD_PX + 2
  }
  // the bracket on a strip `h` px tall over `top` to `bottom` px: at least 4 px tall, centred on the stretch, on the strip
  function bracketOf(top, bottom, h) {
    var height = Math.max(4, bottom - top)
    return { top: Math.max(0, Math.min(h - height, (top + bottom) / 2 - height / 2)), height: height }
  }
  function wheelPx(e, page) {
    return e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * page : e.deltaY
  }
  // a row of the loupe: its line or key, its cells, its text
  function loupeRowEl(k) {
    var el = document.createElement('div')
    el.className = 'thimble-colour-loupe-row'
    el.setAttribute('data-k', String(k))
    var parts = ['n', 'c', 't']
    for (var i = 0; i < parts.length; i++) {
      var s = document.createElement('span')
      s.className = 'thimble-colour-loupe-' + parts[i]
      el.appendChild(s)
    }
    return el
  }
  function writeLoupeRow(el, row) {
    var n = el.children[0]
    var c = el.children[1]
    var t = el.children[2]
    n.textContent = row.num
    while (c.children.length < row.cells.length) c.appendChild(document.createElement('i'))
    while (c.children.length > row.cells.length) c.lastChild.remove()
    for (var j = 0; j < row.cells.length; j++) c.children[j].style.background = row.cells[j] || ''
    t.textContent = ''
    if (row.who) {
      var b = document.createElement('b')
      b.textContent = row.who
      t.appendChild(b)
    }
    t.appendChild(document.createTextNode(row.text))
  }

  function Strip(control, target, opts) {
    var self = this
    this.c = control
    this.page = target === true || target === document.documentElement || target === document.body || target === document.scrollingElement
    this.box = this.page ? document.scrollingElement || document.documentElement : target
    this.set(opts)
    this.recs = [] // each record: [top, bottom] as fractions of the list's height, its colour or null, its element or row
    this.lanes = [] // a lane for each of Color by's choices past the first: {key, id, field, name, label, recs, by}
    this.dataVer = 0 // bumps when the page gives other rows, refs or says otherwise of the list
    this.measured = 0 // how many times the records were measured, which the canvas is drawn for
    this.sigDone = null // what the records were last measured for (sig)
    this.touched = true // a change of the page inside the list since its elements were measured
    this.stale = true
    this.plain = !(this.rows || this.complete)
    // the search's matches in the list, a lane of ticks at the strip's left (marks), kept by the list's box so that a
    // strip made again for it has them
    this.find = (FINDS && FINDS.get(this.box)) || null
    this.findVer = 0
    // what a drag holds: the thumb's top in px of the strip, whether the list is yet to go there, and from where the
    // thumb glides back to the list's place once a hold ends
    this.hold = { frame: null, seek: false, glide: null }
    this.drawn = null // the geometry last drawn, and whether on the pixel grid
    this.snapped = false
    this.movedAt = 0
    this.raf = null
    this.el = document.createElement('div')
    this.el.className = 'thimble-colour-strip'
    this.el.setAttribute('data-thimble-chrome', '')
    this.el.setAttribute('aria-hidden', 'true')
    this.bareLook()
    this.track = document.createElement('div')
    this.track.className = 'thimble-colour-track thimble-colour-whole'
    this.canvas = document.createElement('canvas')
    this.thumb = document.createElement('div')
    this.thumb.className = 'thimble-colour-thumb'
    this.track.appendChild(this.canvas)
    this.track.appendChild(this.thumb)
    this.el.appendChild(this.track)
    // beside the strip, on the loupe's side, the bracket over the stretch the loupe shows
    this.bracket = document.createElement('div')
    this.bracket.className = 'thimble-colour-bracket'
    this.bracket.style.left = -(BRACKET_PX + 1) + 'px'
    this.bracket.style.width = BRACKET_PX + 'px'
    this.el.appendChild(this.bracket)
    this.loupeEl = document.createElement('div')
    this.loupeEl.className = 'thimble-colour-loupe'
    this.loupeEl.setAttribute('data-thimble-chrome', '')
    this.loupeEl.setAttribute('aria-hidden', 'true')
    this.loupeBox = document.createElement('div')
    this.loupeBox.className = 'thimble-colour-loupe-box'
    this.loupeEl.appendChild(this.loupeBox)
    // the loupe: open, naming one record (`one`), the pointer in it (`frozen`), what it follows (`anchor`: 'pointer',
    // 'view' or 'fixed'), the unit under the pointer and the first record shown, the row under the pointer in it, and
    // what is written in each row, so that a draw writes only what changed
    this.lp = { open: false, one: false, frozen: false, anchor: 'pointer', c: 0, start: 0, n: 0, timer: 0, lastY: null, hover: null, g: null, sigs: [], cls: [], kw: null, place: '', bracket: '' }
    document.body.appendChild(this.el)
    document.body.appendChild(this.loupeEl)
    var pad = this.page ? document.body : this.box
    this.padded = pad
    this.padWas = pad.style.paddingRight
    this.padBase = parseFloat(getComputedStyle(pad).paddingRight || '0') || 0
    this.width = -1
    this.fitWidth()
    this.box.classList.add('thimble-colour-scrolled')
    // the list's scroll moves the thumb in the next animation frame, with transforms
    this.onScroll = function () {
      self.kick()
    }
    ;(this.page ? window : this.box).addEventListener('scroll', this.onScroll, { passive: true })
    // a resize moves the records of a list of elements; a list given its rows keeps their places and is drawn again
    this.onResize = function () {
      if (self.rows) self.relayout()
      else self.dirty()
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
    this.el.addEventListener('pointerenter', function (e) {
      self.lpEnter(e)
    })
    this.el.addEventListener('pointerleave', function (e) {
      if (!self.drag) self.lpLeave(e)
    })
    // the wheel over the strip, a real scroll: an open loupe follows the scroll position
    this.el.addEventListener(
      'wheel',
      function (e) {
        e.preventDefault()
        self.lpWheel()
        self.box.scrollTop += wheelPx(e, self.box.clientHeight)
      },
      { passive: false },
    )
    this.loupeEl.addEventListener('pointermove', function (e) {
      self.lpOver(e)
    })
    this.loupeEl.addEventListener('pointerleave', function (e) {
      self.lpOut(e)
    })
    this.loupeEl.addEventListener('click', function (e) {
      self.lpClick(e)
    })
    // the wheel over the loupe scrolls the list, and its rows follow the scroll position while it keeps its place
    this.loupeEl.addEventListener(
      'wheel',
      function (e) {
        e.preventDefault()
        e.stopPropagation()
        self.lpWheel()
        self.box.scrollTop += wheelPx(e, self.box.clientHeight)
      },
      { passive: false },
    )
    this.dirty()
  }
  Strip.prototype.set = function (opts) {
    // the page draws every record of the list (Color by's own `strip`, or `whole: true`): its elements are the whole
    // list, as `rows` are
    this.complete = !!(opts && opts.whole)
    this.rows = opts && Array.isArray(opts.rows) ? opts.rows : null
    this.refs = opts && Array.isArray(opts.refs) ? opts.refs : null
    this.preview = opts && typeof opts.preview === 'function' ? opts.preview : null
    // each row's record, which the lanes of Color by's fields past the first read
    this.records = opts && Array.isArray(opts.records) ? opts.records : null
  }
  Strip.prototype.remove = function () {
    if (this.raf != null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf)
      else clearTimeout(this.raf)
    }
    this.raf = null
    this.lpClose()
    clearTimeout(this.chosenTimer)
    ;(this.page ? window : this.box).removeEventListener('scroll', this.onScroll)
    window.removeEventListener('resize', this.onResize)
    if (this.ro) this.ro.disconnect()
    this.box.classList.remove('thimble-colour-scrolled')
    this.padded.style.paddingRight = this.padWas
    this.el.remove()
    this.loupeEl.remove()
  }
  // the strip's width, a lane per choice of Color by or a plain scrollbar, and the room the list leaves it; each lane
  // named on hover, when there are several
  Strip.prototype.fitWidth = function () {
    var nf = this.find ? 1 : 0
    var nc = this.plain ? 0 : 1 + (this.lanes ? this.lanes.length : 0)
    var n = nf + nc
    var w = stripWidth(n)
    var names = n > 1 ? (nf ? [this.find.name || ''] : []).concat(nc ? [this.choiceName()].concat(this.lanes.map(function (l) { return l.name })) : []) : []
    var key = names.join('\u0000')
    if (key !== this.laneKey) {
      this.laneKey = key
      var old = this.track.querySelectorAll('.thimble-colour-lane')
      for (var i = 0; i < old.length; i++) old[i].remove()
      for (var j = 0; j < names.length; j++) {
        var sp = document.createElement('span')
        sp.className = 'thimble-colour-lane'
        sp.style.left = LANE_INSET + j * (LANE_W + LANE_GAP) + 'px'
        sp.style.width = LANE_W + 'px'
        if (names[j]) sp.title = names[j]
        this.track.insertBefore(sp, this.thumb)
      }
    }
    if (w === this.width) return false
    var padded = this.width !== -1
    this.width = w
    this.el.style.width = w + 'px'
    this.padded.style.paddingRight = this.padBase + w + 2 * EDGE + 'px'
    return padded
  }
  // what the first lane shows, which its hover names
  Strip.prototype.choiceName = function () {
    var ch = this.c.choice()
    return ch && !ch.off ? ch.title || '' : ''
  }
  // a plain scrollbar's look (data-plain): no lane of colours and no search's ticks
  Strip.prototype.bareLook = function () {
    if (this.plain && !this.find) this.el.setAttribute('data-plain', '')
    else this.el.removeAttribute('data-plain')
  }
  // The search's matches in the list, drawn as ticks in a lane at the strip's left: {name, ticks, has(row), go(k)},
  // `ticks` each match's [top, bottom] as fractions of the list's height in the matches' order, `has(row)` whether a
  // record (its element, or its row's index in a list given rows) holds one, for the loupe's cell, and `go(k)` the step
  // to match k a click on its tick takes; null takes the lane away
  Strip.prototype.marks = function (m) {
    m = m && Array.isArray(m.ticks) && m.ticks.length ? m : null
    if (!m && !this.find) return
    var had = !!this.find
    this.find = m
    this.findVer++
    if (FINDS) {
      if (m) FINDS.set(this.box, m)
      else FINDS.delete(this.box)
    }
    this.bareLook()
    if (had !== !!m && this.fitWidth()) this.dirty()
    else this.relayout()
  }
  // the match whose tick lies within TICK_HIT_PX of a click in the search's lane, the nearest; -1 for none
  Strip.prototype.findAt = function (p) {
    var f = this.find
    if (!f || laneAt(p.x, this.lanesN()) !== 0) return -1
    var h = Math.max(1, this.h || 0)
    var best = -1
    var bestD = TICK_HIT_PX + 1
    for (var k = 0; k < f.ticks.length; k++) {
      var t = f.ticks[k]
      var y0 = t[0] * h
      var y1 = Math.max(t[1] * h, y0 + MIN_MARK)
      var d = p.y < y0 ? y0 - p.y : p.y > y1 ? p.y - y1 : 0
      if (d < bestD) {
        bestD = d
        best = k
      }
    }
    return best
  }
  // the lanes the strip draws: the search's, then one per Color by choice
  Strip.prototype.lanesN = function () {
    return (this.find ? 1 : 0) + (this.plain ? 0 : 1 + this.lanes.length)
  }
  // what the records' colours depend on besides the page's elements: the choice, the values turned off, the field's
  // colours, the labels and their marks, and the rows the page gave
  Strip.prototype.sig = function () {
    var c = this.c.choice()
    var f = c && c.field
    var ex = this.c.extra()
    var fs = ex.filter(function (x) { return x.field }).map(function (x) { return x.field })
    if (f) fs.unshift(f)
    return [c ? c.key : '', ex.map(function (x) { return x.key }).join('\u0001'), this.c.offSet(c).join('\u0001'), JSON.stringify(fs.map(function (n) { return [S.colours[n] || null, S.picked[n] || null] })), labelsVer, this.dataVer].join('\u0000')
  }
  // the control counted the page again: the records are measured again only when what they depend on changed, or, for
  // a list of elements, when the page changed inside it; otherwise the strip is only placed again
  Strip.prototype.refreshed = function () {
    var dom = this.touched && !this.rows
    this.touched = false
    if (dom || this.sig() !== this.sigDone) this.dirty()
    else this.relayout()
  }
  // drawn again in the next frame, the records as they were measured
  Strip.prototype.relayout = function () {
    var self = this
    if (this.frame != null) return
    var go = function () {
      self.frame = null
      self.draw()
    }
    this.frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(go) : setTimeout(go, 16)
  }
  Strip.prototype.dirty = function () {
    this.stale = true
    this.relayout()
  }
  // the box the list shows, in the frame's viewport
  Strip.prototype.rect = function () {
    if (this.page) return { left: 0, top: 0, right: document.documentElement.clientWidth, bottom: innerHeight, height: innerHeight }
    var r = this.box.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, height: r.height }
  }
  // every record of the list: [top, bottom] as fractions of the list's height, its colour (the marks' grey for a record
  // that takes no value or a value turned off, as for every record with Color by Off), its element or its row
  Strip.prototype.measure = function (peeking) {
    this.measured++
    // a list the strip cannot know whole is a plain scrollbar, whose records are read only when the loupe asks for them
    if (!this.rows && !this.complete && !peeking) {
      this.recs = null
      this.grey = grey()
      this.lanes = []
      this.sigDone = this.sig()
      this.plain = true
      this.bareLook()
      if (this.fitWidth()) {
        this.stale = true
        this.dirty()
      }
      return
    }
    var c = this.c
    var ch = c.choice()
    var recs = []
    var plain = !ch || ch.off
    var by = ch && ch.label ? ch.label : null
    var g = grey()
    if (this.rows) {
      var n = this.rows.length
      for (var i = 0; i < n; i++) recs.push([i / n, (i + 1) / n, plain ? g : c.drawnColour(this.rows[i]) || g, i])
    } else {
      var box = this.box
      var H = Math.max(1, box.scrollHeight)
      var top0 = this.page ? -box.scrollTop : this.rect().top + box.clientTop - box.scrollTop
      var scope = this.page ? document : box
      // the records alone: the anchored elements (a group's row, which carries no anchor, is no record)
      var els = scope.querySelectorAll(ch && ch.field ? '[data-anchor][data-colour]' : '[data-anchor]')
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
        var rr = e.getBoundingClientRect()
        if (!rr.height) continue
        var y = rr.top - top0
        recs.push([y / H, (y + rr.height) / H, plain ? g : c.drawnColour(v) || g, e])
      }
      recs.sort(function (a, b) {
        return a[0] - b[0]
      })
    }
    this.recs = recs
    this.grey = g
    // the strip shows colours only where it reflects the whole list, the page giving every row's value (`rows`) or
    // drawing every record (`whole`), and only where some record takes a colour: otherwise a plain scrollbar with no
    // colours and no lanes, never grey lanes whose scale is wrong
    var complete = !!this.rows || !!this.complete
    var coloured = false
    for (var ci = 0; ci < recs.length && !coloured; ci++) coloured = !!recs[ci][2] && recs[ci][2] !== g
    // a lane for each of Color by's choices past the first: a label's records in its own colours, those it does not mark
    // left out; a field's in its values' colours (the page's data-colour-tracks, or `records` for a list given rows).
    // `by` gives each record's colour in the lane, which the loupe's cells read
    var lanes = []
    var extra = complete && !plain ? c.extra() : []
    for (var li = 0; li < extra.length; li++) {
      var x = extra[li]
      var xl = x.label ? labelById(x.label) : null
      if (x.label && !xl) continue
      lanes.push({ key: x.key, id: x.label ? String(x.label) : null, field: x.field || null, at: li, name: x.title, label: xl, recs: [], by: new Map() })
    }
    if (lanes.length) {
      var self = this
      var fieldIn = function (lane, v) {
        return v == null || v === '' ? null : c.fieldColour(lane.field, v)
      }
      var tracksOf = function (e) {
        var raw = e.getAttribute('data-colour-tracks')
        if (!raw) return null
        try {
          var got = JSON.parse(raw)
          return Array.isArray(got) ? got : null
        } catch (err) {
          return null
        }
      }
      var colourIn = function (lane, ref, at) {
        if (lane.field) {
          if (typeof at === 'number') {
            var rec = self.records ? self.records[at] : null
            return rec == null ? null : fieldIn(lane, c.fieldValue(lane.field, rec))
          }
          var tv = at ? tracksOf(at) : null
          return tv ? fieldIn(lane, tv[lane.at]) : null
        }
        var mk = ref != null ? thimble.markOf(String(ref)) : null
        var vs = mk && Array.isArray(mk.values) ? mk.values : []
        for (var vi = 0; vi < vs.length; vi++) {
          if (!vs[vi] || String(vs[vi].id) !== lane.id) continue
          var lv = lane.label.values || []
          for (var vj = 0; vj < lv.length; vj++) if (lv[vj].name === String(vs[vi].value)) return lv[vj].colour || lane.label.colour || null
          return lane.label.colour || null
        }
        return null
      }
      if (this.rows) {
        var nr = this.rows.length
        var refs = this.refs || []
        for (var ri = 0; ri < nr; ri++) for (var la = 0; la < lanes.length; la++) {
          var cr = colourIn(lanes[la], refs[ri], ri)
          if (!cr) continue
          lanes[la].recs.push([ri / nr, (ri + 1) / nr, cr, ri])
          lanes[la].by.set(ri, cr)
        }
      } else {
        var box2 = this.box
        var H2 = Math.max(1, box2.scrollHeight)
        var top2 = this.page ? -box2.scrollTop : this.rect().top + box2.clientTop - box2.scrollTop
        var anchored = (this.page ? document : box2).querySelectorAll('[data-anchor]')
        var seen2 = {}
        for (var ai = 0; ai < anchored.length; ai++) {
          var ae = anchored[ai]
          if (ae.tagName === 'CANVAS' || ae.closest('.thimble-colour-mount,.thimble-colour-menu,[data-thimble-chrome]')) continue
          var aref = ae.getAttribute('data-anchor')
          if (!aref || seen2[aref]) continue
          seen2[aref] = true
          var ar = null
          for (var lb = 0; lb < lanes.length; lb++) {
            var ca = colourIn(lanes[lb], aref, ae)
            if (!ca) continue
            ar = ar || ae.getBoundingClientRect()
            if (!ar.height) break
            var ay = ar.top - top2
            lanes[lb].recs.push([ay / H2, (ay + ar.height) / H2, ca, ae])
            lanes[lb].by.set(ae, ca)
          }
        }
        for (var lc = 0; lc < lanes.length; lc++)
          lanes[lc].recs.sort(function (a, b) {
            return a[0] - b[0]
          })
      }
    }
    for (var lq = 0; lq < lanes.length && !coloured; lq++) coloured = lanes[lq].recs.length > 0
    this.sigDone = this.sig()
    this.plain = !complete || !coloured
    if (this.plain) lanes = []
    this.bareLook()
    this.lanes = lanes
    // lanes that change the strip's width change the room the list leaves it, and the records' places with it
    if (this.fitWidth()) {
      this.stale = true
      this.dirty()
    }
  }
  // the part in view, as fractions of the list's height
  Strip.prototype.view = function () {
    var box = this.box
    var H = Math.max(1, box.scrollHeight)
    return [box.scrollTop / H, Math.min(1, (box.scrollTop + box.clientHeight) / H)]
  }
  Strip.prototype.draw = function () {
    var r = this.rect()
    var box = this.box
    var scrolls = box.scrollHeight > box.clientHeight + 1
    this.el.style.display = scrolls ? '' : 'none'
    if (!scrolls) {
      this.lpClose()
      return
    }
    // measured before the strip is placed, since the lanes the choices need set its width
    if (this.stale) {
      this.stale = false
      this.measure()
    }
    // the strip on the device's pixel grid, so that every edge on it is drawn sharp
    var dpr = window.devicePixelRatio || 1
    var snap = function (v) {
      return Math.round(v * dpr) / dpr
    }
    var top = snap(Math.max(r.top, 0) + EDGE)
    var h = Math.max(0, snap(Math.min(r.bottom, innerHeight) - EDGE) - top)
    this.el.style.left = snap(r.right - this.width - EDGE) + 'px'
    this.el.style.top = top + 'px'
    this.el.style.height = h + 'px'
    this.h = h
    // the canvas drawn again only for records measured again or a strip of another size
    var painted = [h, dpr, this.width, this.measured, this.findVer].join()
    if (painted !== this.painted) {
      this.painted = painted
      this.paint()
    }
    this.drawn = null
    this.place(typeof performance !== 'undefined' ? performance.now() : Date.now())
    this.kick()
    if (this.lp.open) this.lpDraw(this.lpMeasure())
  }
  // the strip's canvas: the search's lane of ticks when it finds something, a lane for the Color by choice, then one for
  // each choice past the first, each on its stripe, in whole device pixels; each lane of colours keeps its rows'
  // colours, for a click to snap to. A plain scrollbar draws none
  Strip.prototype.paint = function () {
    var h = this.h || 0
    var dpr = window.devicePixelRatio || 1
    var cv = this.canvas
    var W = Math.ceil(this.width * dpr)
    var Hp = Math.ceil(h * dpr)
    if (cv.width !== W) cv.width = W
    if (cv.height !== Hp) cv.height = Hp
    cv.style.width = this.width + 'px'
    cv.style.height = h + 'px'
    this.rowColours = null
    this.laneRows = []
    var ctx = cv.getContext && cv.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, cv.width, cv.height)
    var nf = this.find ? 1 : 0
    var nc = this.plain || !this.recs ? 0 : 1 + this.lanes.length
    if (!nf && !nc) return
    var boxes = laneBoxes(nf + nc, dpr)
    ctx.fillStyle = kit.realColour('rgba(var(--ink-rgb), 0.035)')
    for (var b = 0; b < boxes.length; b++) ctx.fillRect(boxes[b][0], 0, boxes[b][1], Hp)
    if (nf) this.ticks(ctx, boxes[0][0], boxes[0][1])
    if (!nc) return
    this.rowColours = this.fill(ctx, this.recs, boxes[nf][0], boxes[nf][1])
    for (var i = 0; i < this.lanes.length; i++) this.laneRows.push(this.fill(ctx, this.lanes[i].recs, boxes[nf + i + 1][0], boxes[nf + i + 1][1]))
  }
  // the search's lane, `x` to `x + w` device px: a tick in the ink per match, at least MIN_MARK px tall
  Strip.prototype.ticks = function (ctx, x, w) {
    var h = this.h || 0
    var dpr = window.devicePixelRatio || 1
    var Hp = Math.ceil(h * dpr)
    var ts = this.find.ticks
    ctx.fillStyle = kit.realColour('var(--text-primary)')
    for (var k = 0; k < ts.length; k++) {
      var y0 = Math.max(0, Math.min(1, ts[k][0])) * h
      var y1 = Math.max(0, Math.min(1, ts[k][1])) * h
      if (y1 - y0 < MIN_MARK) {
        y0 = Math.max(0, Math.min(h - MIN_MARK, (y0 + y1 - MIN_MARK) / 2))
        y1 = y0 + MIN_MARK
      }
      var a = Math.round(y0 * dpr)
      ctx.fillRect(x, a, w, Math.max(1, Math.min(Hp, Math.round(y1 * dpr)) - a))
    }
  }
  // one lane of the canvas, `x` to `x + w` device px: each pixel row in the one colour most of its records take (the
  // records' share of the row), grey where its records take no value; each row's colour
  Strip.prototype.fill = function (ctx, recs, x, w) {
    var h = this.h || 0
    var dpr = window.devicePixelRatio || 1
    var Hp = Math.ceil(h * dpr)
    // per device row, each colour's share of it
    var rows = new Array(Hp)
    for (var i = 0; i < recs.length; i++) {
      var rc = recs[i]
      if (!rc[2]) continue
      var y0 = rc[0] * h
      var y1 = rc[1] * h
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
    var kept = new Array(Hp)
    for (var kr = 0; kr < Hp; kr++) {
      var at = rows[kr]
      var best = null
      var most = 0
      if (at) {
        for (var c in at) {
          if (c !== g && at[c] > most) {
            most = at[c]
            best = c
          }
        }
        if (!best && at[g]) best = g
      }
      kept[kr] = best
    }
    var y = 0
    ctx.globalAlpha = 1
    while (y < Hp) {
      var c0 = kept[y]
      var end = y + 1
      while (end < Hp && kept[end] === c0) end++
      if (c0) {
        ctx.fillStyle = c0
        ctx.fillRect(x, y, w, end - y)
      }
      y = end
    }
    return kept
  }
  // where the thumb stands, in px of the strip: its top and height and how far through the list that is (as a
  // scrollbar's thumb), where a drag holds it or the list's place puts it
  Strip.prototype.geom = function (v) {
    var h = this.h || 0
    v = v || this.view()
    var vh = Math.max(0, v[1] - v[0])
    var frameH = Math.min(h, Math.max(this.plain && !this.find ? PLAIN_THUMB_MIN : THUMB_MIN, vh * h))
    var room = Math.max(0, h - frameH)
    var hold = this.hold
    var f = hold.frame != null ? (room > 0 ? Math.max(0, Math.min(1, hold.frame / room)) : 0) : vh < 1 ? Math.max(0, Math.min(1, v[0] / (1 - vh))) : 0
    return { v: v, f: f, frameTop: f * room, frameH: frameH }
  }
  // the next animation frame moves the thumb, and the next after it while it moves
  Strip.prototype.kick = function () {
    var self = this
    if (this.raf != null) return
    var go = function (now) {
      self.raf = null
      if (self.place(now)) self.kick()
    }
    this.raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(go) : setTimeout(function () { go(Date.now()) }, 16)
  }
  // one frame of the strip: the list scrolled for what a drag asks, then the thumb over the part in view, with
  // transforms alone, and an open loupe drawn again. While the thumb moves it stands where it is computed; once still,
  // its edges go onto the device's pixel grid. Whether it still moves.
  Strip.prototype.place = function (now) {
    var h = this.h || 0
    if (!h || this.el.style.display === 'none') return false
    var box = this.box
    var hold = this.hold
    // the list's height and its box's read once a frame
    var H = Math.max(1, box.scrollHeight)
    var ch = box.clientHeight
    var free = Math.max(0, H - ch)
    var viewAt = function () {
      var t = box.scrollTop
      return [t / H, Math.min(1, (t + ch) / H)]
    }
    // a held thumb: the list goes to the place it frames
    if (hold.seek && hold.frame != null) {
      hold.seek = false
      var g0 = this.geom(viewAt())
      box.scrollTop = Math.max(0, Math.min(free, g0.f * free))
    }
    var g = this.geom(viewAt())
    // a jump of the list (a click, a record gone to) with nothing held, past twice the part in view at once where a
    // scroll goes by frames: the thumb glides there
    var d0 = this.drawn
    var jumped = this.lastV0 != null && Math.abs(g.v[0] - this.lastV0) > 2 * (g.v[1] - g.v[0])
    this.lastV0 = g.v[0]
    if (jumped && !hold.glide && hold.frame == null && d0 && Math.abs(d0.frameTop - g.frameTop) > JUMP_PX) hold.glide = { at: now, frameTop: d0.frameTop }
    var shown = g
    if (hold.glide) {
      var e = Math.min(1, (now - hold.glide.at) / GLIDE_MS)
      e = 1 - Math.pow(1 - e, 3)
      if (e >= 1) hold.glide = null
      else shown = { v: g.v, f: g.f, frameTop: g.frameTop + (hold.glide.frameTop - g.frameTop) * (1 - e), frameH: g.frameH }
    }
    var d = this.drawn
    var moved = !d || Math.abs(d.frameTop - shown.frameTop) > 1e-3 || Math.abs(d.frameH - shown.frameH) > 1e-3
    if (moved) this.movedAt = now
    var still = !moved && !hold.glide && hold.frame == null && now - this.movedAt >= SETTLE_MS
    if (moved || (still && !this.snapped)) this.write(shown, still)
    this.drawn = shown
    this.snapped = still
    // an open loupe follows the list, and the thumb as it glides; its anchor stays as it is
    if (this.lp.open) this.lpDraw()
    return !still
  }
  // the thumb written for a geometry, on the device's pixel grid when `grid`, only where it changed
  Strip.prototype.write = function (g, grid) {
    var dpr = window.devicePixelRatio || 1
    var q = function (v) {
      return grid ? Math.round(v * dpr) / dpr : v
    }
    var at = [q(g.frameTop), q(g.frameTop + g.frameH)]
    var el = this.thumb
    var was = el.__thimbleAt
    if (was && was[0] === at[0] && was[1] === at[1]) return
    el.__thimbleAt = at
    el.style.display = at[1] > at[0] ? '' : 'none'
    if (!was || was[1] - was[0] !== at[1] - at[0]) el.style.height = Math.max(0, at[1] - at[0]) + 'px'
    el.style.transform = 'translateY(' + at[0] + 'px)'
  }
  // a hold ends: the thumb glides from where it stands to the list's place
  Strip.prototype.release = function () {
    var now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    if (this.drawn) this.hold.glide = { at: now, frameTop: this.drawn.frameTop }
    this.hold.frame = null
    this.hold.seek = false
    this.kick()
  }
  // the place under the pointer: px down the strip and across it, and the fraction of the list there
  Strip.prototype.at = function (e) {
    var r = this.track.getBoundingClientRect()
    var h = this.h || 0
    var y = Math.max(0, Math.min(h, e.clientY - r.top))
    return { y: y, x: e.clientX - r.left, at: y / Math.max(1, h) }
  }
  // the record a click snaps to: of the runs of rows in one colour (not the grey of no value) at most THIN_PX tall that
  // come within SNAP_PX of the click, in the lane clicked, the nearest, the upper on a tie; its first record of that
  // colour from where the run starts. Null when none does: a click in a taller patch, or far from any, goes where it is
  Strip.prototype.snapAt = function (p) {
    if (this.plain) return null
    var nf = this.find ? 1 : 0
    var lane = laneAt(p.x, this.lanesN()) - nf
    if (lane < 0) return null
    var rows = lane ? this.laneRows && this.laneRows[lane - 1] : this.rowColours
    var recs = (lane ? this.lanes[lane - 1].recs : this.recs) || []
    if (!rows || !rows.length) return null
    var dpr = window.devicePixelRatio || 1
    var g = this.grey
    var n = rows.length
    var at = Math.max(0, Math.min(n - 1, Math.floor(p.y * dpr)))
    var reach = Math.round(SNAP_PX * dpr)
    var thin = Math.round(THIN_PX * dpr)
    var best = -1
    var bestD = Infinity
    var r = Math.max(0, at - reach)
    while (r > 0 && rows[r] && rows[r - 1] === rows[r]) r--
    while (r < n && r <= at + reach) {
      var c = rows[r]
      var end = r + 1
      while (end < n && rows[end] === c) end++
      if (c && c !== g && end - r <= thin) {
        var d = at < r ? r - at : at >= end ? at - end + 1 : 0
        if (d <= reach && d < bestD) {
          best = r
          bestD = d
        }
      }
      r = end
    }
    if (best < 0) return null
    var colour = rows[best]
    var from = best / n
    for (var i = 0; i < recs.length; i++) {
      var rc = recs[i]
      if (rc[2] === colour && rc[1] > from) return rc
    }
    return null
  }
  // a record gone to (a click that snapped, a click in the loupe, a touch let go): scrolled to, and its element shown as
  // chosen for a moment; a row of a list given its rows once the page has drawn it
  Strip.prototype.choose = function (t) {
    this.go(t)
    var self = this
    var mark = function (el) {
      if (!el || !el.setAttribute) return
      el.setAttribute('data-thimble-snap', '')
      clearTimeout(self.chosenTimer)
      if (self.chosen && self.chosen !== el) self.chosen.removeAttribute('data-thimble-snap')
      self.chosen = el
      self.chosenTimer = setTimeout(function () {
        el.removeAttribute('data-thimble-snap')
        if (self.chosen === el) self.chosen = null
      }, 1600)
    }
    if (typeof t[3] !== 'number') return mark(t[3])
    var i = t[3]
    setTimeout(function () {
      mark(self.rowEl(i))
    }, 60)
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
  // a press on the strip: on the thumb a drag of it moves the list and the loupe opens at it; off it a click sends the
  // thumb there (or to a patch's record) and a drag from there scrubs, once the pointer has moved DRAG_PX. A touch off
  // the thumb scrubs with the loupe, where the strip has one
  Strip.prototype.down = function (e) {
    if (e.button !== 0) return
    e.preventDefault()
    var p = this.at(e)
    var g = this.drawn || this.geom()
    var onThumb = p.y >= g.frameTop - 1 && p.y <= g.frameTop + g.frameH + 1
    try {
      if (this.el.setPointerCapture) this.el.setPointerCapture(e.pointerId)
    } catch (err) {}
    if (e.pointerType === 'touch' && !onThumb && this.lpKind() === 'list') {
      this.drag = { touch: true }
      this.lpOpenAt(e.clientY)
      return
    }
    if (onThumb) this.lpThumb()
    else if (this.lp.one) this.lpClose()
    this.drag = { dy: onThumb ? p.y - g.frameTop : g.frameH / 2, y0: e.clientY, moved: false, onThumb: onThumb }
  }
  // the thumb held with its top at `top` px of the strip, and the list sent there in the next frame
  Strip.prototype.holdFrame = function (top) {
    var g = this.drawn || this.geom()
    this.hold.glide = null
    this.hold.frame = Math.max(0, Math.min(Math.max(0, (this.h || 0) - g.frameH), top))
    this.hold.seek = true
    this.kick()
  }
  Strip.prototype.move = function (e) {
    var d = this.drag
    if (!d) return this.lpMove(e)
    if (d.touch) return this.lpTouchMove(e)
    if (!d.moved && Math.abs(e.clientY - d.y0) < DRAG_PX) return
    if (!d.moved) {
      d.moved = true
      this.el.setAttribute('data-drag', 'frame')
      // a drag of the thumb is a real scroll: the loupe follows the scroll position
      if (!d.onThumb) this.lpThumb()
    }
    this.holdFrame(e.clientY - this.track.getBoundingClientRect().top - d.dy)
  }
  Strip.prototype.up = function (e) {
    var d = this.drag
    this.drag = null
    this.el.removeAttribute('data-drag')
    if (!d) return
    if (d.touch) {
      // let go, the list goes to the record under the loupe's line
      var u = this.lpTouchEnd()
      if (u != null && this.recs && this.recs[u]) this.choose(this.recs[u])
      return
    }
    if (!d.moved) {
      // a click: on a tick of the search's lane, that match; near a patch of colour, the first record of the patch;
      // elsewhere off the thumb, the thumb's middle comes under the pointer
      var p = this.at(e)
      var fk = this.findAt(p)
      var t = fk < 0 ? this.snapAt(p) : null
      if (fk >= 0) {
        var go = this.find.go
        safe(function () { go(fk) })
      } else if (t) this.choose(t)
      else if (!d.onThumb) {
        var g = this.drawn || this.geom()
        var room = Math.max(1e-9, (this.h || 0) - g.frameH)
        var box = this.box
        box.scrollTop = Math.max(0, Math.min(1, (p.y - d.dy) / room)) * Math.max(0, box.scrollHeight - box.clientHeight)
      }
    }
    if (this.hold.seek) this.place(typeof performance !== 'undefined' ? performance.now() : Date.now())
    this.release()
    if (e.pointerType === 'touch') this.lpClose()
  }

  // ---- the loupe beside the strip (frontend/src/files/Loupe.tsx), its units records from 0: record i is the unit i
  // to i + 1, fractions of them between
  // how the loupe opens: 'list' where the strip draws a record shorter than TELL_APART_PX, 'one' (the record under the
  // pointer named on one line) where it tells every record apart, '' with no record. A plain scrollbar's records are
  // read now
  Strip.prototype.lpKind = function () {
    if (!this.recs) this.measure(true)
    var n = this.recs ? this.recs.length : 0
    var h = this.h || 0
    if (!n || h <= 0) return ''
    return h / n < TELL_APART_PX ? 'list' : 'one'
  }
  // the unit at `y` px down the strip, and a unit's place on the strip
  Strip.prototype.unitAt = function (y) {
    var recs = this.recs || []
    var n = recs.length
    if (!n) return 0
    var f = y / Math.max(1, this.h || 0)
    var lo = 0
    var hi = n
    while (lo < hi) {
      var mid = (lo + hi) >> 1
      if (recs[mid][1] <= f) lo = mid + 1
      else hi = mid
    }
    if (lo >= n) return n - 1e-6
    var r = recs[lo]
    if (f <= r[0]) return lo
    return lo + Math.min(0.999999, (f - r[0]) / Math.max(1e-12, r[1] - r[0]))
  }
  Strip.prototype.pxOf = function (u) {
    var recs = this.recs || []
    var n = recs.length
    var h = this.h || 0
    if (!n) return 0
    if (u >= n) return recs[n - 1][1] * h
    var i = Math.max(0, Math.floor(u))
    var r = recs[i]
    return (r[0] + (Math.max(0, u) - i) * (r[1] - r[0])) * h
  }
  // whether the records the strip read reach `y` px down it: always for a list it knows whole; for another, which may
  // draw only some of its records (a list that draws the rows in view), only within a few px of those it draws, so that
  // the loupe never names a record far from the pointer
  Strip.prototype.lpNear = function (y) {
    if (this.rows || this.complete) return true
    var recs = this.recs || []
    var h = Math.max(1, this.h || 0)
    if (!recs.length) return false
    return y / h >= recs[0][0] - 8 / h && y / h <= recs[recs.length - 1][1] + 8 / h
  }
  // the units in view
  Strip.prototype.viewUnits = function () {
    var v = this.view()
    var h = this.h || 0
    return [this.unitAt(v[0] * h), this.unitAt(v[1] * h)]
  }
  // the unit the thumb stands for as drawn, which the loupe shows around after a real scroll: where a drag holds it or a
  // glide has got to, the list's place otherwise
  Strip.prototype.thumbUnit = function () {
    var h = this.h || 0
    var v = this.view()
    var vh = Math.max(0, v[1] - v[0])
    var d = this.drawn
    var f = vh < 1 ? Math.max(0, Math.min(1, v[0] / (1 - vh))) : 0
    if (d) {
      var room = h - d.frameH
      f = room > 0 ? Math.max(0, Math.min(1, d.frameTop / room)) : 0
    }
    return this.unitAt((f * Math.max(0, 1 - vh) + vh / 2) * h)
  }
  Strip.prototype.thumbMid = function () {
    var d = this.drawn || this.geom()
    return d.frameTop + d.frameH / 2
  }
  // the row of the page a list given its rows draws for row `i`, where it draws it
  Strip.prototype.rowEl = function (i) {
    var ref = this.refs ? this.refs[i] : null
    if (ref == null) return null
    return (this.page ? document : this.box).querySelector('[data-anchor="' + String(ref).replace(/["\\]/g, '\\$&') + '"]')
  }
  // what the loupe says of a record (a row, or an element): the page's preview, else the element's time and text
  Strip.prototype.textOf = function (t) {
    var self = this
    var got = this.preview ? safe(function () { return self.preview(t) }, null) : null
    if (got != null && typeof got !== 'object') got = { text: String(got) }
    if (got) return { when: String(got.when || got.time || ''), text: String(got.text || '') }
    var e = typeof t === 'number' ? this.rowEl(t) : t
    if (!e || !e.getAttribute) return { when: '', text: '' }
    var time = e.querySelector && e.querySelector('time')
    var when = (e.getAttribute('data-time') || (time ? time.textContent : '') || '').trim()
    var text = (e.getAttribute('data-preview') || e.getAttribute('data-anchor-text') || e.textContent || '').replace(/\s+/g, ' ').trim()
    if (when && text.indexOf(when) === 0) text = text.slice(when.length).trim()
    return { when: when, text: text }
  }
  // a record's ref: the row's in `refs`, or the element's data-anchor
  Strip.prototype.refOf = function (t) {
    if (typeof t === 'number') return this.refs ? this.refs[t] : null
    return t && t.getAttribute ? t.getAttribute('data-anchor') : null
  }
  // record `i` as a row of the loupe: its line or key, a cell per lane of the strip in the record's colour (none for no
  // value), when it was and the start of its text
  Strip.prototype.lpRow = function (i) {
    var rec = this.recs[i]
    var t = rec[3]
    var cells = []
    var f = this.find
    if (f) cells.push(typeof f.has === 'function' && safe(function () { return f.has(t) }, false) ? kit.realColour('var(--text-primary)') : null)
    if (!this.plain) {
      cells.push(rec[2] && rec[2] !== this.grey ? rec[2] : null)
      for (var l = 0; l < this.lanes.length; l++) cells.push(this.lanes[l].by.get(t) || null)
    }
    var w = this.textOf(t)
    return { num: refKey(this.refOf(t), t), cells: cells, who: oneLine(w.when), text: oneLine(w.text) }
  }
  // the characters of the widest line or key of the list, KEY_CHARS at most, read once per measure
  Strip.prototype.keyChars = function () {
    var ver = this.measured + ':' + this.dataVer
    if (this.kwVer === ver) return this.kw
    var most = 1
    var recs = this.recs || []
    for (var i = 0; i < recs.length && most < KEY_CHARS; i++) most = Math.max(most, refKey(this.refOf(recs[i][3]), recs[i][3]).length)
    this.kwVer = ver
    this.kw = Math.min(KEY_CHARS, most)
    return this.kw
  }
  // where the strip stands, read before anything is written
  Strip.prototype.lpMeasure = function () {
    var r = this.track.getBoundingClientRect()
    var g = { left: r.left, top: r.top, lo: r.top + LOUPE_INSET, hi: r.bottom - LOUPE_INSET, h: this.h || r.height, room: r.left - LOUPE_OFF_PX - LOUPE_INSET }
    this.lp.g = g
    return g
  }
  // the loupe's middle at `y`, px in the viewport, beside the strip: as wide as the room there leaves it, LOUPE_MIN_W
  // to LOUPE_MAX_W; a name as wide as its text, as far
  Strip.prototype.lpPlace = function (y, g) {
    var L = this.lp
    if (!g) return
    var w = Math.max(120, Math.min(g.room, Math.max(LOUPE_MIN_W, Math.min(LOUPE_MAX_W, g.room - 24))))
    var H = loupeHeight(L.one ? 1 : L.n)
    var right = Math.max(0, document.documentElement.clientWidth - g.left)
    var top = Math.max(g.lo, Math.min(g.hi - H, y - H / 2))
    var at = [right, top, w, L.one].join()
    if (at === L.place) return
    L.place = at
    this.loupeEl.style.right = right + 'px'
    this.loupeEl.style.top = top + 'px'
    this.loupeBox.style.width = L.one ? '' : w + 'px'
    this.loupeBox.style.maxWidth = w + 'px'
  }
  Strip.prototype.lpAim = function (unit) {
    var L = this.lp
    var total = this.recs ? this.recs.length : 0
    L.c = Math.max(0, Math.min(total - 1e-6, unit))
    L.start = loupeStart(L.c, total, L.one ? 1 : Math.min(LOUPE_ROWS, total))
  }
  // the loupe drawn: what it shows after its anchor, a row per record written only where it changed, the record under
  // the pointer darker and those in view tinted, and the bracket beside the strip over the stretch it shows
  Strip.prototype.lpDraw = function (g) {
    var L = this.lp
    if (!L.open) return
    // a list that changed how the loupe opens (shorter, longer, gone) closes it
    var kind = this.lpKind()
    if (kind !== (L.one ? 'one' : 'list')) return this.lpClose()
    g = g || L.g || this.lpMeasure()
    var total = this.recs.length
    var n = L.one ? 1 : Math.min(LOUPE_ROWS, total)
    L.n = n
    if (L.anchor === 'view') {
      this.lpAim(this.thumbUnit())
      if (!L.frozen) this.lpPlace(g.top + this.thumbMid(), g)
    } else if (L.c >= total || L.start > total - n) this.lpAim(L.c)
    var box = this.loupeBox
    // a plain scrollbar draws no lane, so its rows have no cells
    var bare = this.plain && !this.find
    if (this.loupeEl.hasAttribute('data-bare') !== bare) {
      if (bare) this.loupeEl.setAttribute('data-bare', '')
      else this.loupeEl.removeAttribute('data-bare')
    }
    var kw = this.keyChars()
    if (L.kw !== kw) {
      L.kw = kw
      box.style.setProperty('--thimble-loupe-key', String(kw))
    }
    while (box.children.length < n) box.appendChild(loupeRowEl(box.children.length))
    while (box.children.length > n) box.lastChild.remove()
    L.sigs.length = Math.min(L.sigs.length, n)
    L.cls.length = Math.min(L.cls.length, n)
    var vu = this.viewUnits()
    var at = L.one ? -1 : L.frozen ? (L.hover == null ? -1 : L.start + L.hover) : L.anchor === 'pointer' ? Math.floor(L.c) : -1
    for (var k = 0; k < n; k++) {
      var i = L.start + k
      var el = box.children[k]
      if (i >= total) continue
      var row = this.lpRow(i)
      var sig = [row.num, row.cells.join(','), row.who, row.text].join('\u0000')
      if (sig !== L.sigs[k]) {
        writeLoupeRow(el, row)
        L.sigs[k] = sig
      }
      var seen = !L.one && i + 1 > vu[0] && i < vu[1]
      var cls = (seen ? 's' : '') + (i === at ? 'a' : '')
      if (cls !== L.cls[k]) {
        el.classList.toggle('seen', seen)
        el.classList.toggle('at', i === at)
        L.cls[k] = cls
      }
    }
    var br = this.bracket
    if (L.one) {
      br.removeAttribute('data-open')
      return
    }
    var b = bracketOf(this.pxOf(L.start), this.pxOf(Math.min(total, L.start + n)), g.h)
    var pos = b.top + '|' + b.height
    if (pos !== L.bracket) {
      L.bracket = pos
      br.style.transform = 'translateY(' + b.top + 'px)'
      br.style.height = b.height + 'px'
    }
    if (!br.hasAttribute('data-open')) br.setAttribute('data-open', '')
  }
  Strip.prototype.lpFreeze = function (frozen) {
    var L = this.lp
    L.frozen = frozen
    if (!frozen) L.hover = null
    if (frozen) this.loupeEl.setAttribute('data-frozen', '')
    else this.loupeEl.removeAttribute('data-frozen')
  }
  Strip.prototype.lpShow = function (anchor, one) {
    var L = this.lp
    L.open = true
    L.one = one
    L.anchor = anchor
    L.place = ''
    this.lpFreeze(false)
    this.loupeEl.setAttribute('data-open', '')
    if (one) this.loupeEl.setAttribute('data-one', '')
    else this.loupeEl.removeAttribute('data-one')
  }
  // opened with the record under the pointer at `y` in its middle row
  Strip.prototype.lpOpenAt = function (y) {
    var kind = this.lpKind()
    if (!kind) return
    var g = this.lpMeasure()
    if (!this.lpNear(y - g.top)) return
    this.lpShow('pointer', kind === 'one')
    this.lp.n = kind === 'one' ? 1 : Math.min(LOUPE_ROWS, this.recs.length)
    this.lpAim(this.unitAt(y - g.top))
    this.lpPlace(y, g)
    this.lpDraw(g)
  }
  // opened at the thumb, following the scroll position
  Strip.prototype.lpOpenAtView = function () {
    if (this.lpKind() !== 'list') return
    this.lpShow('view', false)
    this.lp.n = Math.min(LOUPE_ROWS, this.recs.length)
    this.lpDraw(this.lpMeasure())
  }
  Strip.prototype.lpClose = function () {
    var L = this.lp
    clearTimeout(L.timer)
    L.timer = 0
    L.open = false
    L.frozen = false
    L.hover = null
    this.loupeEl.removeAttribute('data-open')
    this.loupeEl.removeAttribute('data-frozen')
    this.bracket.removeAttribute('data-open')
  }
  // the pointer on the strip a while, which opens the loupe (or names the record) where it then is
  Strip.prototype.lpRest = function () {
    var L = this.lp
    var kind = this.lpKind()
    clearTimeout(L.timer)
    L.timer = 0
    if (!kind) return
    var self = this
    L.timer = setTimeout(function () {
      L.timer = 0
      if (!self.drag && L.lastY != null) self.lpOpenAt(L.lastY)
    }, kind === 'one' ? NAME_MS : LOUPE_REST_MS)
  }
  // the pointer onto the strip: back from the loupe, it follows the pointer again; else it opens on rest
  Strip.prototype.lpEnter = function (e) {
    if (e.pointerType === 'touch') return
    var L = this.lp
    L.lastY = e.clientY
    if (L.open) {
      if (L.one) return
      this.lpFreeze(false)
      L.anchor = 'pointer'
      this.lpFollow(e.clientY)
      return
    }
    this.lpRest()
  }
  // an open loupe at the record under the pointer at `y`; closed where the strip read no record near it
  Strip.prototype.lpFollow = function (y) {
    var g = this.lpMeasure()
    if (!this.lpNear(y - g.top)) return this.lpClose()
    this.lpAim(this.unitAt(y - g.top))
    this.lpPlace(y, g)
    this.lpDraw(g)
  }
  // the pointer along the strip: an open loupe follows it; a move that did not move (one a browser sends as the page
  // scrolls under a still pointer) leaves the anchor
  Strip.prototype.lpMove = function (e) {
    if (e.pointerType === 'touch') return
    var L = this.lp
    if (e.clientY === L.lastY) return
    L.lastY = e.clientY
    if (!L.open) {
      if (!L.timer) this.lpRest()
      return
    }
    if (L.frozen) return
    L.anchor = 'pointer'
    this.lpFollow(e.clientY)
  }
  // the pointer off the strip: into the loupe, which then holds still; elsewhere the loupe closes
  Strip.prototype.lpLeave = function (e) {
    var L = this.lp
    clearTimeout(L.timer)
    L.timer = 0
    L.lastY = null
    if (L.open && !L.one && e && e.relatedTarget && this.loupeEl.contains(e.relatedTarget)) {
      this.lpFreeze(true)
      L.anchor = 'fixed'
      this.lpDraw()
      return
    }
    this.lpClose()
  }
  // a real scroll (the wheel over the strip or the loupe): an open loupe follows the scroll position
  Strip.prototype.lpWheel = function () {
    var L = this.lp
    if (L.open && !L.one) L.anchor = 'view'
  }
  // a press on the thumb or a drag of it: the loupe opens at it and follows the scroll position; a name closes
  Strip.prototype.lpThumb = function () {
    var L = this.lp
    clearTimeout(L.timer)
    L.timer = 0
    if (L.open && L.one) return this.lpClose()
    if (L.open) {
      L.anchor = 'view'
      this.lpDraw(this.lpMeasure())
    } else this.lpOpenAtView()
  }
  Strip.prototype.lpTouchMove = function (e) {
    var L = this.lp
    if (!L.open) return
    L.anchor = 'pointer'
    this.lpFollow(e.clientY)
  }
  Strip.prototype.lpTouchEnd = function () {
    var L = this.lp
    var u = L.open ? Math.floor(L.c) : null
    this.lpClose()
    return u
  }
  // the row of the loupe under the pointer
  Strip.prototype.lpRowAt = function (e) {
    var row = e.target && e.target.closest ? e.target.closest('.thimble-colour-loupe-row') : null
    return row ? Number(row.getAttribute('data-k')) : null
  }
  // the pointer in the loupe: the row under it darker
  Strip.prototype.lpOver = function (e) {
    var L = this.lp
    if (!L.frozen) return
    var k = this.lpRowAt(e)
    if (k === L.hover) return
    L.hover = k
    this.lpDraw()
  }
  Strip.prototype.lpOut = function (e) {
    if (e.relatedTarget && this.el.contains(e.relatedTarget)) return
    this.lpClose()
  }
  // a click in the loupe goes to the record there, and its rows stay where they are
  Strip.prototype.lpClick = function (e) {
    var L = this.lp
    if (!L.open || !L.frozen) return
    var k = this.lpRowAt(e)
    if (k == null) return
    L.anchor = 'fixed'
    var rec = this.recs && this.recs[L.start + k]
    if (rec) this.choose(rec)
  }

  Control.prototype.strip = function (target, opts) {
    var t = el(target)
    if (!t) return null
    for (var i = 0; i < this.strips.length; i++) {
      var s = this.strips[i]
      if (s.box === t || (t === true && s.page)) {
        if (opts) {
          // rows and refs the same as before, as a page that draws its list again gives them, measure nothing again
          var same = function (a, b) {
            if (a === b) return true
            if (!a || !b || a.length !== b.length) return false
            for (var k = 0; k < a.length; k++) if (a[k] !== b[k]) return false
            return true
          }
          var rows = 'rows' in opts ? (Array.isArray(opts.rows) ? opts.rows : null) : s.rows
          var refs = 'refs' in opts ? (Array.isArray(opts.refs) ? opts.refs : null) : s.refs
          var recs = 'records' in opts ? (Array.isArray(opts.records) ? opts.records : null) : s.records
          var whole = 'whole' in opts ? !!opts.whole : s.complete
          if (!same(rows, s.rows) || !same(refs, s.refs) || !same(recs, s.records) || whole !== s.complete) s.dataVer++
          s.rows = rows
          s.refs = refs
          s.records = recs
          s.complete = whole
          if ('preview' in opts) s.preview = typeof opts.preview === 'function' ? opts.preview : null
        }
        s.refreshed()
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
      /** every choice in order, the first the colour and each other a track beside the list's: [{field, title} or
       *  {label, title}]; none for Off */
      get picks() {
        var ch = c.choice()
        if (!ch || ch.off) return []
        return c.picks().map(function (x) {
          return x.label ? { label: x.label, title: x.title } : { field: x.field, title: x.title }
        })
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
      /** the chips' values: [{value, name, colour, on, n}], value null for the records that take none, colour the
       *  chip's whether the value is on or off, each value under the chip "Other" in its place; none for Off */
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
      /** the colour a value's records are drawn in, one a canvas can draw; null for no value, for a value turned off
       *  and for Off: draw those in one gray */
      colourOf: function (value) {
        return c.drawnColour(value)
      },
      /** whether the analyst left a value's colour on */
      isOn: function (value) {
        return c.isOn(value)
      },
      /** always true: Color by only colors, and a value turned off keeps its records (Filter by's keeps hides them);
       *  kept for the pages that ask */
      keeps: function (record) {
        c.tally(record)
        return true
      },
      /** ` data-colour="<value>"` for a record's element while a field is colored by, '' while a label is or for Off:
       *  the bar thimble draws on the element */
      attr: function (record) {
        c.tally(record)
        var ch = c.choice()
        var out = ''
        if (ch && ch.field) {
          var v = c.valueOf(record)
          out = ' data-colour="' + esc(v == null ? '' : v) + '"'
        }
        // the record's values of the fields past the first choice, which their tracks draw
        var ex = c.extra()
        if (ex.some(function (x) { return x.field })) out += ' data-colour-tracks="' + esc(JSON.stringify(ex.map(function (x) { return x.field ? c.fieldValue(x.field, record) : null }))) + '"'
        return out
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
      /** the choice as the reader takes it with a fetch (thimble.colour_value in reader.py): {field} or {label, name};
       *  null for Off. It names no value turned off, so a reader keeps and counts every record */
      query: function () {
        var ch = c.choice()
        if (!ch || ch.off) return null
        if (ch.label) return { label: ch.label, name: ch.title }
        return { field: ch.field }
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

  // Every choice of the kit's controls that the page mounted, for the view's checks (views.py, view_shot.mjs), which
  // try each and fail the view on a script error: [{control, choice, go()}]. Each part adds its own (kit.shared.sweep).
  var sweeps = [
    function () {
      if (!control) return []
      var c = control
      var out = [{ control: 'Color by', choice: 'Off', go: function () { c.choose(OFF) } }]
      c.fields.forEach(function (f) {
        out.push({ control: 'Color by', choice: f.title, go: function () { c.choose('f:' + f.name) } })
      })
      onLabels().forEach(function (l) {
        out.push({ control: 'Color by', choice: l.name, go: function () { c.choose('l:' + l.id) } })
      })
      // two choices together, the second a track
      if (c.fields.length > 1) out.push({ control: 'Color by', choice: c.fields[0].title + ' + ' + c.fields[1].title, go: function () { S.picks = ['f:' + c.fields[0].name, 'f:' + c.fields[1].name]; c.changed() } })
      return out
    },
  ]
  Object.defineProperty(thimble, '__choices', {
    value: function () {
      var out = []
      for (var i = 0; i < sweeps.length; i++) out = out.concat(safe(sweeps[i], []) || [])
      return out
    },
  })
  // How many records the page's lists that draw only the rows near their view hold, for the view's checks
  // (view_shot.mjs `held`): the refs of every row given to a strip with `rows` (colour.strip, the kit's table), each
  // anchored once it is drawn
  Object.defineProperty(thimble, '__held', {
    value: function () {
      var refs = new Set()
      var all = allStrips()
      for (var i = 0; i < all.length; i++) {
        var s = all[i]
        if (!s.rows || !s.refs || !s.el.isConnected) continue
        for (var k = 0; k < s.refs.length; k++) if (s.refs[k] != null && s.refs[k] !== '') refs.add(String(s.refs[k]))
      }
      return refs.size
    },
  })

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

  // A group's mix: a group (a page, an agent, a run, a session) takes no colour of its own, so its row shows how its
  // records divide among Color by's values as a small proportion bar, each value's share in its colour, in the chips'
  // order, the records with no value gray and last; a value turned off keeps its share, in gray, and with Off it is
  // empty.
  function mixHtml(counts) {
    var c = control
    var ch = c && c.choice()
    if (!ch || ch.off || !counts || typeof counts !== 'object') return '<span class="thimble-mix" hidden></span>'
    var got = {}
    var pairs = Array.isArray(counts) ? counts : Object.keys(counts).map(function (k) { return [k, counts[k]] })
    for (var i = 0; i < pairs.length; i++) if (pairs[i] && Number(pairs[i][1]) > 0) got[keyOf(pairs[i][0])] = (got[keyOf(pairs[i][0])] || 0) + Number(pairs[i][1])
    var order = c.flat().map(function (v) { return v.key })
    var keys = Object.keys(got).sort(function (a, b) {
      var ia = a === NONE ? 1e9 : order.indexOf(a) < 0 ? 1e8 : order.indexOf(a)
      var ib = b === NONE ? 1e9 : order.indexOf(b) < 0 ? 1e8 : order.indexOf(b)
      return ia - ib || got[b] - got[a]
    })
    var parts = ''
    var words = []
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k]
      var name = key === NONE ? (ch.label ? 'Not marked' : 'No ' + String(ch.title).toLowerCase()) : key
      var col = key === NONE ? grey() : c.drawnColour(key) || grey()
      parts += '<span style="flex-grow:' + got[key] + ';flex-basis:0;background:' + esc(col) + '"></span>'
      words.push(name + ' ' + num(got[key]))
    }
    if (!parts) return '<span class="thimble-mix" hidden></span>'
    var said = esc(ch.title + ': ' + words.join(' · '))
    return '<span class="thimble-mix" role="img" aria-label="' + said + '" title="' + said + '">' + parts + '</span>'
  }
  /** A group's row's proportion bar of its records' Color by values (above): thimble.mix(el, counts) draws it in `el`,
   *  thimble.mix(counts) gives its html; counts are {value: n}, '' for the records with no value */
  thimble.mix = function (target, counts) {
    if (target && target.nodeType === 1) {
      target.innerHTML = mixHtml(counts)
      return target
    }
    if (typeof target === 'string' && counts !== undefined) {
      var node = document.querySelector(target)
      if (node) node.innerHTML = mixHtml(counts)
      return node
    }
    return mixHtml(target)
  }

  // A record as a card or a tile (viewer_kit.css .thimble-card), as html: the head (`key` at its left, `meta` and `chips`
  // at its right), then the `title`, the `body` and the `foot`, each left out when not given. A part is text, which the
  // card escapes, or {html} for markup the page made, such as a key chip; `chips` are words, each a neutral chip. `ref`
  // is the record's data-anchor. `record` hands the record to Color by (colour.attr), so the bridge draws its value's
  // color as the bar on the card's left edge, and with several choices a band per choice there, in their order, a
  // label's from its mark on `ref`: a card takes no color of its own. `active` marks the chosen card,
  // `act: false` a card a click does nothing on, and `attrs` ({name: value}) gives it more attributes, such as a key the
  // page's click reads; a `class` there is added to the card's own. (thimble.card is a card type's stored data, in a
  // card's frame: viewer_bridge.js.)
  function hasPart(v) {
    return v != null && v !== '' && v !== false
  }
  function cardText(v) {
    return typeof v === 'object' && v.html != null ? String(v.html) : esc(v)
  }
  function cardPart(v, cls) {
    return hasPart(v) ? '<div class="' + cls + '">' + cardText(v) + '</div>' : ''
  }
  /** a record as a card (above): thimble.recordCard({ref, record, key, title, meta, chips, body, foot, active, act,
   *  attrs}) gives its html */
  thimble.recordCard = function (o) {
    o = o || {}
    var cls = 'thimble-card' + (o.act === false ? '' : ' thimble-card-act') + (o.active ? ' active' : '')
    var attrs = hasPart(o.ref) ? ' data-anchor="' + esc(o.ref) + '"' : ''
    if (o.record != null && control) attrs += control.api.attr(o.record)
    var extra = o.attrs || {}
    for (var name in extra) {
      // a name an attribute can have, never an event handler's
      if (!/^[a-zA-Z_:][\w:.-]*$/.test(name) || /^on/i.test(name) || extra[name] == null || extra[name] === false) continue
      // a second class attribute would be dropped by the parser, so the page's classes join the card's
      if (name.toLowerCase() === 'class') cls += extra[name] === true ? '' : ' ' + String(extra[name])
      else attrs += ' ' + name + '="' + esc(extra[name] === true ? '' : extra[name]) + '"'
    }
    var meta = (hasPart(o.meta) ? '<span>' + cardText(o.meta) + '</span>' : '') +
      (o.chips || []).filter(hasPart).map(function (c) {
        return '<span class="chip chip-sans chip-tone-neutral"><span class="chip-text">' + esc(c) + '</span></span>'
      }).join('')
    var head = hasPart(o.key) || meta
      ? '<div class="thimble-card-head">' + (hasPart(o.key) ? '<span class="thimble-card-key">' + cardText(o.key) + '</span>' : '') +
        (meta ? '<span class="thimble-card-meta">' + meta + '</span>' : '') + '</div>'
      : ''
    return '<div class="' + esc(cls) + '"' + attrs + '>' + head + cardPart(o.title, 'thimble-card-title') +
      cardPart(o.body, 'thimble-card-body') + cardPart(o.foot, 'thimble-card-foot') + '</div>'
  }

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
    // fn() gives the ids of the labels a part holds, which take no colour when turned on (notice)
    hold: function (fn) {
      holds.push(fn)
    },
    // fn() gives a part's choices for the view's checks (thimble.__choices)
    sweep: function (fn) {
      sweeps.push(fn)
    },
    // a popover's left edge clear of the lists' tracks, and the side the label editor opens on beside a menu
    clear: function (left, top, w, h) {
      return clearOfStrips(left, top, w, h)
    },
    editorSide: editorSide,
    // a list's strip (an element, a selector or true for the page), made when it has none: Color by's, which colours
    // it as colour.strip does with the same `opts`, or with no Color by a plain scrollbar that Color by takes over once
    // mounted; strip.marks({ticks, has, go, name}) draws the search's ticks on it. strips() lists them all
    strip: function (target, opts) {
      var t = el(target)
      if (!t) return null
      return Control.prototype.strip.call(control || BARE, t, opts)
    },
    strips: allStrips,
    tip: tip,
    untip: untip,
    esc: esc,
    num: num,
    // the labels as Color by reads them, for the kit's other parts (viewer_controls.js): every label over files, one by
    // its id, whether it is on, its value on a record, and what its values mean
    labels: allLabels,
    label: labelById,
    labelOn: isOn,
    labelValue: labelValue,
    definition: definition,
    meaning: meaningOf,
    ico: ico,
  }
})()
