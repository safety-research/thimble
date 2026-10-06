// thimble's Colour by control for a view's page, part of the view kit: views.frame_document loads it right after
// viewer_bridge.js, whose marks it draws through, and viewer_kit.css styles it. A page calls it once:
//
//   const colour = thimble.colourBy({
//     mount: '#colour',                        an element in the view's top row, which the control fills
//     fields: [{ name: 'kind', title: 'Kind', values: ['Text only', 'With links'] }, { name: 'source' }],
//     chips: 'filter',                         a value turned off hides its records; 'highlight' (the default) dims them
//     strip: '#list',                          the list that gets the coloured scrollbar, or true for the page
//     onChange: (colour) => draw(),            the choice, a value turned on or off, or the label values changed
//   })
//
// One menu lists together the view's own fields it declares colourable and every label over files, those that mark the
// view's files first. A field colours by the values its records take, each in a palette colour of its own (the label
// palette, --label-1 to --label-12, in the order the values come: the declared `values`, then the most frequent first,
// kept per view so a value keeps its colour). A label colours by its values on each anchored record, in the label's own
// colours; choosing one turns it on, and a label the analyst turns on, here or anywhere in thimble, takes the colour.
// The chosen field's values are chips in the top row, each with its count and its colour as a bar along the chip's
// left edge; a click turns a value off or on, an Alt-click or a double click keeps that value alone. Colour is always
// a bar on the left edge of a record's row, card or chip (the bridge draws it on every element whose data-colour is the
// value of the chosen field, and on every anchored record when a label is chosen), never coloured text or a fill. The
// strip is the File browser's transcript ruler for any list: its track shows where each value's records are, and its
// thumb frames the part in view. thimble keeps the choice, the values turned off and the colours per view (the bridge's
// `colour` message), and hands them back as window.__thimbleColour when the page loads.
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

  var NONE = '\u0000none' // the key of the records that take no value
  var PALETTE = 12 // --label-1 .. --label-12; a value past them takes --label-none
  var STRIP_W = 13 // px: the File browser's ruler as one rail, a 7px lane in a 3px inset
  var LANE = 7
  var INSET = 3
  var MIN_MARK = 2 // px, a mark's least height on the strip
  var HIT = 3 // px either side of a mark within which a click goes to its record
  var THUMB_MIN = 24
  var MAX_KEPT = 200 // values whose colour is kept per field
  var ICON = {
    palette: 'M12 3a9 9 0 0 0 0 18c1.1 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7H16a5 5 0 0 0 5-5c0-4-4-7.2-9-7.2zM7.5 12h.01M9 7.8h.01M13.5 7h.01M17 10h.01',
    down: 'M6 9l6 6 6-6',
    check: 'M5 12.5l4.5 4.5L19 7',
    plus: 'M12 5v14M5 12h14',
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

  // ---------------------------------------------------------------- what is kept per view
  function loadState() {
    var s = window.__thimbleColour
    var out = { by: null, field: null, off: {}, seen: null, colours: {} }
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
    return out
  }
  var S = loadState()

  var labelState = null
  var control = null // the one Colour by control of the page

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
    var keep = { v: 1, by: S.by, field: S.field, off: S.off, seen: S.seen || [], colours: S.colours }
    try {
      kit.save(JSON.parse(JSON.stringify(keep)))
    } catch (e) {}
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
        return { name: String(f.name), title: String(f.title || f.name), values: Array.isArray(f.values) ? f.values.map(String) : null, value: typeof f.value === 'function' ? f.value : null }
      })
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
        if (t && t.nodeType === 1 && t.closest && t.closest('.thimble-colour-mount,.thimble-colour-menu,.thimble-colour-strip')) continue
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
  // what the colour is now: a field, a label that is on, or nothing
  Control.prototype.choice = function () {
    var by = S.by || ''
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
    return c ? S.off[c.key] || [] : []
  }
  Control.prototype.isOn = function (value) {
    return this.offSet().indexOf(keyOf(value)) < 0
  }
  // the colour of a field's value, from the palette: the declared values in their order, then the others the first
  // time they are seen, the most frequent first, kept per view so a value keeps its colour
  Control.prototype.fieldColour = function (field, value) {
    var key = keyOf(value)
    if (key === NONE) return null
    var map = S.colours[field] || (S.colours[field] = {})
    if (!(key in map)) this.assign(field, key)
    var idx = map[key]
    if (typeof idx !== 'number') return kit.realColour('var(--label-none)')
    return kit.realColour(idx < PALETTE ? 'var(--label-' + (idx + 1) + ')' : 'var(--label-none)')
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
    var next = declared.length
    for (var i = 0; i < fresh.length && n < MAX_KEPT; i++) {
      var v = fresh[i]
      var at = declared.indexOf(v)
      if (at < 0) {
        while (used[next]) next++
        at = next
      }
      map[v] = at
      used[at] = true
      n++
    }
    this.coloursChanged = true
  }
  Control.prototype.colourOf = function (value) {
    var c = this.choice()
    if (!c || keyOf(value) === NONE) return null
    if (c.field) return this.fieldColour(c.field, value)
    var l = labelById(c.label)
    var vs = (l && l.values) || []
    for (var i = 0; i < vs.length; i++) if (vs[i].name === String(value)) return vs[i].colour || l.colour || null
    return (l && l.colour) || null
  }
  Control.prototype.valueOf = function (record) {
    var c = this.choice()
    if (!c || record == null) return null
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
    if (!c) return out
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
  // the chips' values: the label's highlighted values, or the field's declared values and those counted, then no value
  Control.prototype.list = function () {
    var c = this.choice()
    if (!c) return []
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
    // the values the view did not declare in the order of their colours, which the most frequent took first, so the
    // chips keep their places as the counts change
    extra.sort(function (a, b) {
      var ia = a in map ? map[a] : 1e9
      var ib = b in map ? map[b] : 1e9
      return ia - ib || (counts[b] || 0) - (counts[a] || 0) || (a < b ? -1 : a > b ? 1 : 0)
    })
    for (var d = 0; d < declared.length; d++) add(declared[d], declared[d])
    for (var e = 0; e < extra.length; e++) add(extra[e], extra[e])
    if (counts[NONE]) add(null, 'No ' + f.title.toLowerCase())
    return out
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
      c
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
    var self = this
    this.forget()
    this.labelKey = this.drawnKey()
    save()
    this.hook()
    this.refresh()
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
    if (this.menu && !this.menu.values) this.redrawMenu()
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
  Control.prototype.marksChanged = function () {
    if (this.choice() && this.choice().label) this.soon()
  }

  // ---------------------------------------------------------------- the top row: Colour by and the values' chips
  Control.prototype.render = function () {
    if (!this.root) return
    var c = this.choice()
    var off = this.offSet(c)
    var lab = c && c.label ? ' data-label="' + esc(c.label) + '"' : ''
    var by = '<button type="button" class="btn btn-ghost btn-sm thimble-colour-by" aria-haspopup="menu" aria-expanded="' + (this.menu ? 'true' : 'false') + '"' + lab + '>' + ico('palette') + '<span class="thimble-colour-k">Colour by</span><b>' + esc(c ? c.title : 'None') + '</b>' + ico('down') + '</button>'
    var chips = ''
    for (var i = 0; i < this.values.length; i++) {
      var v = this.values[i]
      var on = off.indexOf(v.key) < 0
      chips +=
        '<button type="button" class="thimble-colour-chip' + (v.colour ? '' : ' thimble-colour-none') + '" data-i="' + i + '" aria-pressed="' + on + '"' + lab +
        (v.colour ? ' style="--c:' + esc(v.colour) + '"' : '') + ' title="' + esc(v.name) + '"><span class="thimble-colour-name">' + esc(v.name) + '</span><span class="thimble-colour-n">' + num(v.n) + '</span></button>'
    }
    chips += '<button type="button" class="btn btn-ghost btn-sm thimble-colour-more" hidden></button>'
    this.root.innerHTML = by + '<span class="thimble-colour-chips">' + chips + '</span>'
    this.fit()
  }
  // the chips that do not fit the row go behind "N more", which lists every value
  Control.prototype.fit = function () {
    if (!this.root) return
    var box = this.root.querySelector('.thimble-colour-chips')
    var more = this.root.querySelector('.thimble-colour-more')
    if (!box || !more) return
    var chips = box.querySelectorAll('.thimble-colour-chip')
    for (var i = 0; i < chips.length; i++) chips[i].hidden = false
    more.hidden = true
    if (box.scrollWidth <= box.clientWidth + 1) return
    more.hidden = false
    var hid = 0
    for (var j = chips.length - 1; j >= 0 && box.scrollWidth > box.clientWidth + 1; j--) {
      chips[j].hidden = true
      hid++
      more.textContent = hid + ' more'
    }
  }
  // the value a chip or a menu item stands for, by its place among the chips' values (a value's own text may hold what
  // an attribute cannot)
  Control.prototype.keyAt = function (node) {
    var v = this.values[Number(node.getAttribute('data-i'))]
    return v ? v.key : null
  }
  Control.prototype.click = function (e) {
    var t = e.target
    if (!t.closest) return
    if (t.closest('.thimble-colour-by')) return this.toggleMenu(t.closest('.thimble-colour-by'))
    if (t.closest('.thimble-colour-more')) return this.toggleMenu(t.closest('.thimble-colour-more'), true)
    var chip = t.closest('.thimble-colour-chip')
    if (!chip) return
    var key = this.keyAt(chip)
    if (key == null) return
    if (e.altKey) return this.only(key)
    if (e.detail > 1) return // the second click of a double click, which keeps the value alone
    var c = this.choice()
    this.pre = c ? { key: key, by: c.key, off: (S.off[c.key] || []).slice() } : null
    this.toggle(key)
  }
  Control.prototype.toggle = function (key) {
    var c = this.choice()
    if (!c) return
    var off = (S.off[c.key] || []).slice()
    var at = off.indexOf(key)
    if (at >= 0) off.splice(at, 1)
    else off.push(key)
    S.off[c.key] = off
    this.changed()
  }
  // that value alone, or every value again when it was alone already
  Control.prototype.only = function (key) {
    var c = this.choice()
    if (!c) return
    var others = this.values.map(function (v) { return v.key }).filter(function (k) { return k !== key })
    var off = S.off[c.key] || []
    var alone = off.indexOf(key) < 0 && others.every(function (k) { return off.indexOf(k) >= 0 })
    S.off[c.key] = alone ? [] : others
    this.changed()
  }
  Control.prototype.choose = function (by) {
    S.by = by
    if (by.indexOf('f:') === 0) S.field = by.slice(2)
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
    document.removeEventListener('pointerdown', this.menu.away, true)
    document.removeEventListener('keydown', this.menu.key, true)
    this.menu = null
    var b = this.root && this.root.querySelector('.thimble-colour-by')
    if (b) b.setAttribute('aria-expanded', 'false')
  }
  Control.prototype.menuHtml = function (values) {
    var c = this.choice()
    var self = this
    if (values) {
      var off = this.offSet(c)
      return (
        '<div class="thimble-colour-head">' + esc(c ? c.title : '') + '</div>' +
        this.values
          .map(function (v, i) {
            var on = off.indexOf(v.key) < 0
            return '<button type="button" class="thimble-colour-item" role="menuitemcheckbox" aria-checked="' + on + '" data-i="' + i + '"' + (c && c.label ? ' data-label="' + esc(c.label) + '"' : '') + '><span class="thimble-colour-box' + (on ? ' on' : '') + '">' + (on ? ico('check') : '') + '</span><span class="thimble-colour-sw"' + (v.colour ? ' style="--c:' + esc(v.colour) + '"' : '') + '></span><span class="thimble-colour-nm">' + esc(v.name) + '</span><span class="thimble-colour-n">' + num(v.n) + '</span></button>'
          })
          .join('')
      )
    }
    var tick = function (on) {
      return '<span class="thimble-colour-tick">' + (on ? ico('check') : '') + '</span>'
    }
    var html = ''
    if (this.fields.length) {
      html += '<div class="thimble-colour-head">Colour by</div>'
      html += this.fields
        .map(function (f) {
          var on = !!(c && c.field === f.name)
          return '<button type="button" class="thimble-colour-item" role="menuitemradio" aria-checked="' + on + '" data-by="' + esc('f:' + f.name) + '">' + tick(on) + '<span class="thimble-colour-nm">' + esc(f.title) + '</span></button>'
        })
        .join('')
    }
    var all = allLabels()
    var row = function (l) {
      var on = !!(c && c.label === l.id)
      var lit = !!l.on || isOn(l.id)
      return (
        '<div class="thimble-colour-item thimble-colour-label" role="menuitemradio" tabindex="0" aria-checked="' + on + '" data-by="' + esc('l:' + l.id) + '" data-label="' + esc(l.id) + '">' + tick(on) +
        '<span class="thimble-colour-sw" style="--c:' + esc(l.colour || '') + '"></span><span class="thimble-colour-nm">' + esc(l.name) + '</span>' +
        (typeof l.count === 'number' ? '<span class="thimble-colour-n">' + num(l.count) + '</span>' : '') +
        '<button type="button" class="thimble-colour-switch' + (lit ? ' on' : '') + '" role="switch" aria-checked="' + lit + '" aria-label="' + esc((lit ? 'Turn off ' : 'Turn on ') + l.name) + '" data-switch="' + esc(l.id) + '" data-label="' + esc(l.id) + '"><span></span></button></div>'
      )
    }
    var here = all.filter(function (l) { return l.here })
    var other = all.filter(function (l) { return !l.here })
    html += '<div class="thimble-colour-head">Labels over these files</div>'
    html += here.length ? here.map(row).join('') : '<div class="thimble-colour-note">No label covers these files yet</div>'
    if (other.length) html += '<div class="thimble-colour-head">Other labels</div>' + other.map(row).join('')
    if (typeof thimble.newLabel === 'function') html += '<div class="thimble-colour-sep"></div><button type="button" class="thimble-colour-item" data-new>' + '<span class="thimble-colour-tick">' + ico('plus') + '</span><span class="thimble-colour-nm">New label</span></button>'
    void self
    return html
  }
  Control.prototype.openMenu = function (anchor, values) {
    var self = this
    var m = document.createElement('div')
    m.className = 'thimble-colour-menu'
    m.setAttribute('role', 'menu')
    m.setAttribute('data-thimble-chrome', '')
    m.innerHTML = this.menuHtml(values)
    document.body.appendChild(m)
    var r = anchor.getBoundingClientRect()
    var w = m.offsetWidth
    var h = m.offsetHeight
    var vw = document.documentElement.clientWidth
    var left = Math.max(8, Math.min(r.left, vw - w - 8))
    var top = r.bottom + 4
    if (top + h > innerHeight - 8 && r.top - 4 - h >= 8) top = r.top - 4 - h
    m.style.left = left + 'px'
    m.style.top = Math.max(8, top) + 'px'
    m.style.maxHeight = Math.max(120, innerHeight - Math.max(8, top) - 8) + 'px'
    var away = function (e) {
      if (!m.contains(e.target) && !anchor.contains(e.target)) self.closeMenu()
    }
    var key = function (e) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        self.closeMenu()
        anchor.focus()
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
    this.menu = { el: m, anchor: anchor, away: away, key: key, values: !!values }
    anchor.setAttribute('aria-expanded', 'true')
  }
  Control.prototype.redrawMenu = function () {
    if (!this.menu) return
    this.menu.el.innerHTML = this.menuHtml(this.menu.values)
  }
  Control.prototype.menuClick = function (e, values) {
    var t = e.target
    var self = this
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
    this.closeMenu()
    if (by.indexOf('l:') === 0 && !isOn(by.slice(2))) {
      // the label is turned on; it takes the colour once thimble says it is on
      S.by = by
      save()
      thimble.setLabel(by.slice(2), true).catch(function () {})
      return
    }
    this.choose(by)
  }

  // ---------------------------------------------------------------- the coloured scrollbar
  // A list's scrollbar as the File browser's transcript ruler draws it with one rail: a track the height of the list
  // whose lane shows each record of a value that is on, in its colour, where it stands in the list, and a thumb that
  // frames the part in view. A drag of the thumb or a press on the track scrolls the list, a wheel over it too, and a
  // click on a mark goes to its record. The list's own scrollbar is hidden in its favour. `rows`, for a list that draws
  // only the rows in view, gives every row's value in order, which the lane draws in place of the rows on the page.
  function Strip(control, target, opts) {
    var self = this
    this.c = control
    this.page = target === true || target === document.documentElement || target === document.body || target === document.scrollingElement
    this.box = this.page ? document.scrollingElement || document.documentElement : target
    this.rows = opts && Array.isArray(opts.rows) ? opts.rows : null
    this.ticks = []
    this.stale = true
    this.el = document.createElement('div')
    this.el.className = 'thimble-colour-strip'
    this.el.setAttribute('data-thimble-chrome', '')
    this.el.setAttribute('aria-hidden', 'true')
    this.canvas = document.createElement('canvas')
    this.thumb = document.createElement('div')
    this.thumb.className = 'thimble-colour-thumb'
    this.el.appendChild(this.canvas)
    this.el.appendChild(this.thumb)
    document.body.appendChild(this.el)
    var pad = this.page ? document.body : this.box
    this.padded = pad
    this.padWas = pad.style.paddingRight
    pad.style.paddingRight = parseFloat(getComputedStyle(pad).paddingRight || '0') + STRIP_W + 2 + 'px'
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
  Strip.prototype.remove = function () {
    ;(this.page ? window : this.box).removeEventListener('scroll', this.onScroll)
    window.removeEventListener('resize', this.onResize)
    if (this.ro) this.ro.disconnect()
    this.box.classList.remove('thimble-colour-scrolled')
    this.padded.style.paddingRight = this.padWas
    this.el.remove()
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
  // each record of a value that is on: [top, bottom] as fractions of the list's height, its colour and its element
  Strip.prototype.measure = function () {
    var c = this.c
    var ch = c.choice()
    var out = []
    if (!ch) return out
    var off = c.offSet(ch)
    if (this.rows) {
      var n = this.rows.length
      for (var i = 0; i < n; i++) {
        var key = keyOf(this.rows[i])
        if (key === NONE || off.indexOf(key) >= 0) continue
        var col = c.colourOf(this.rows[i])
        if (col) out.push([i / n, (i + 1) / n, col, i])
      }
      return out
    }
    var box = this.box
    var H = Math.max(1, box.scrollHeight)
    var top0 = this.page ? -box.scrollTop : this.rect().top + box.clientTop - box.scrollTop
    var scope = this.page ? document : box
    var els = scope.querySelectorAll(ch.field ? '[data-colour]' : '[data-anchor]')
    var seen = {}
    for (var j = 0; j < els.length; j++) {
      var e = els[j]
      if (e.closest('.thimble-colour-mount,.thimble-colour-menu') || e.tagName === 'CANVAS') continue
      var ref = e.getAttribute('data-anchor')
      var v
      if (ch.field) v = e.getAttribute('data-colour')
      else {
        if (!ref || seen[ref]) continue
        seen[ref] = true
        v = c.valueOf(ref)
      }
      var k = keyOf(v)
      if (k === NONE || off.indexOf(k) >= 0) continue
      var r = e.getBoundingClientRect()
      if (!r.height) continue
      var colour = c.colourOf(v)
      if (!colour) continue
      var y = r.top - top0
      out.push([y / H, (y + r.height) / H, colour, e])
    }
    out.sort(function (a, b) {
      return a[0] - b[0]
    })
    return out
  }
  Strip.prototype.draw = function () {
    var r = this.rect()
    var box = this.box
    var scrolls = box.scrollHeight > box.clientHeight + 1
    this.el.style.display = scrolls ? '' : 'none'
    if (!scrolls) return
    var h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0) - 4)
    this.el.style.left = r.right - STRIP_W - 2 + 'px'
    this.el.style.top = Math.max(r.top, 0) + 2 + 'px'
    this.el.style.height = h + 'px'
    this.h = h
    if (this.stale) {
      this.ticks = this.measure()
      this.stale = false
    }
    var dpr = window.devicePixelRatio || 1
    var cv = this.canvas
    cv.width = Math.ceil(STRIP_W * dpr)
    cv.height = Math.ceil(h * dpr)
    cv.style.width = STRIP_W + 'px'
    cv.style.height = h + 'px'
    var ctx = cv.getContext && cv.getContext('2d')
    if (ctx) {
      ctx.clearRect(0, 0, cv.width, cv.height)
      var x = Math.round(INSET * dpr)
      var w = Math.max(1, Math.round(LANE * dpr))
      ctx.fillStyle = kit.realColour('rgba(var(--ink-rgb), 0.035)')
      ctx.fillRect(x, 0, w, cv.height)
      for (var i = 0; i < this.ticks.length; i++) {
        var t = this.ticks[i]
        var y0 = t[0] * h
        var y1 = t[1] * h
        if (y1 - y0 < MIN_MARK) {
          y0 = Math.max(0, Math.min(h - MIN_MARK, (y0 + y1 - MIN_MARK) / 2))
          y1 = y0 + MIN_MARK
        }
        var a = Math.round(y0 * dpr)
        ctx.fillStyle = t[2]
        ctx.fillRect(x, a, w, Math.max(1, Math.round(y1 * dpr) - a))
      }
    }
    this.place()
  }
  Strip.prototype.place = function () {
    var box = this.box
    var H = Math.max(1, box.scrollHeight)
    var h = this.h || 0
    var th = Math.max(THUMB_MIN, Math.min(h, (box.clientHeight / H) * h))
    var room = Math.max(0, h - th)
    var free = H - box.clientHeight
    var top = this.drag ? this.drag.top : free > 0 ? (box.scrollTop / free) * room : 0
    this.thumb.style.height = th + 'px'
    this.thumb.style.transform = 'translateY(' + top + 'px)'
    this.th = th
    this.thumbTop = top
  }
  Strip.prototype.scrollTo = function (thumbTop) {
    var box = this.box
    var room = Math.max(1, (this.h || 0) - (this.th || 0))
    box.scrollTop = (Math.max(0, Math.min(room, thumbTop)) / room) * Math.max(0, box.scrollHeight - box.clientHeight)
  }
  Strip.prototype.tickAt = function (y) {
    var h = this.h || 1
    var best = null
    var bd = Infinity
    for (var i = 0; i < this.ticks.length; i++) {
      var t = this.ticks[i]
      var y0 = t[0] * h
      var y1 = Math.max(t[1] * h, y0 + MIN_MARK)
      var d = y < y0 ? y0 - y : y > y1 ? y - y1 : 0
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
    var y = e.clientY - this.el.getBoundingClientRect().top
    var onThumb = y >= this.thumbTop && y <= this.thumbTop + this.th
    this.drag = { dy: onThumb ? y - this.thumbTop : this.th / 2, y0: e.clientY, moved: false, onThumb: onThumb, top: this.thumbTop }
    if (this.el.setPointerCapture) this.el.setPointerCapture(e.pointerId)
    this.el.setAttribute('data-drag', '')
  }
  Strip.prototype.move = function (e) {
    var d = this.drag
    if (!d) return
    if (!d.moved && Math.abs(e.clientY - d.y0) < 3) return
    d.moved = true
    d.top = e.clientY - this.el.getBoundingClientRect().top - d.dy
    this.scrollTo(d.top)
    this.place()
  }
  Strip.prototype.up = function (e) {
    var d = this.drag
    this.drag = null
    this.el.removeAttribute('data-drag')
    if (!d || d.moved) return this.place()
    var y = e.clientY - this.el.getBoundingClientRect().top
    var t = this.tickAt(y)
    if (t) this.go(t)
    else if (!d.onThumb) this.scrollTo(y - this.th / 2)
    this.place()
  }

  Control.prototype.strip = function (target, opts) {
    var t = el(target)
    if (!t) return null
    for (var i = 0; i < this.strips.length; i++) {
      var s = this.strips[i]
      if (s.box === t || (t === true && s.page)) {
        if (opts && 'rows' in opts) s.rows = Array.isArray(opts.rows) ? opts.rows : null
        s.dirty()
        return s
      }
    }
    var made = new Strip(this, t, opts)
    this.strips.push(made)
    return made
  }

  // ---------------------------------------------------------------- what the page holds
  function api(c) {
    var out = {
      /** the colour now: {field, title} or {label, title} (the label's id and name), or null */
      get by() {
        var ch = c.choice()
        return ch ? (ch.label ? { label: ch.label, title: ch.title } : { field: ch.field, title: ch.title }) : null
      },
      /** the field coloured by, or null while a label is */
      get field() {
        var ch = c.choice()
        return ch && ch.field ? ch.field : null
      },
      /** the label coloured by (its id), or null while a field is */
      get label() {
        var ch = c.choice()
        return ch && ch.label ? ch.label : null
      },
      /** the chips' values: [{value, name, colour, on, n}], value null for the records that take none */
      get values() {
        var off = c.offSet()
        return c.values.map(function (v) {
          return { value: v.value, name: v.name, colour: v.colour, on: off.indexOf(v.key) < 0, n: v.n }
        })
      },
      /** the value a record takes: its field's (record[field], or the field's own value(record), which may take any
       *  record such as a row's index), or for a label the label's value on record.ref (or on a ref given as a
       *  string); null for none */
      valueOf: function (record) {
        return c.valueOf(record)
      },
      /** the colour of a value, one a canvas can draw; null for no value */
      colourOf: function (value) {
        return c.colourOf(value)
      },
      /** whether the analyst left a value on */
      isOn: function (value) {
        return c.isOn(value)
      },
      /** whether a record's value is on: the records a page keeps in a list, a count or a chart */
      keeps: function (record) {
        return c.isOn(c.valueOf(record))
      },
      /** ` data-colour="<value>"` for a record's element while a field is coloured by, '' while a label is: the bar
       *  thimble draws on the element */
      attr: function (record) {
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
      /** the choice as the reader takes it with a fetch (thimble.colour_value and colour_on in reader.py) */
      query: function () {
        var ch = c.choice()
        if (!ch) return null
        var off = c.offSet(ch).map(function (k) { return k === NONE ? null : k })
        if (ch.label) return { label: ch.label, name: ch.title, off: off }
        return { field: ch.field, off: off }
      },
      /** the coloured scrollbar on a list (an element or a selector, or true for the page); `opts.rows` gives every
       *  row's value in order for a list that draws only the rows in view, and a later call with the same list updates
       *  them */
      strip: function (target, opts) {
        c.strip(target, opts)
        return out
      },
    }
    return out
  }

  /** Colour by, in the view's top row (see the top of this file). Called again, it replaces the control. */
  thimble.colourBy = function (opts) {
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
    return c.api
  }
})()
