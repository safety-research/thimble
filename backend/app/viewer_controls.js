// thimble's row controls for a view's page, part of the view kit: views.frame_document loads it after viewer_colour.js
// (whose labels, kept state, Reset and tip it shares through the bridge's part, window.__thimbleKit.shared) and before
// viewer_range.js, which takes that part away; viewer_parts.css styles it. Each control reads a record's value of a
// field or a label as Color by does (viewer_colour.js valueOf), so a view's fields and every label over files work the
// same way in each. docs/rows-and-filters.md says how a page uses them.
//
//   thimble.filterBy({ mount, fields, onChange })        Filter by, in the top row beside Color by: which rows show. Its
//                                                        menu lists None, the fields and the labels; the chosen one's
//                                                        values are toggles in the row, as Color by's chips, with no colour
//   thimble.rows({ mount, fields, initial, onChange })    Rows, in the top row: what the lanes or rows are grouped by, a field
//                                                        or a label, with a lane for the records with no value. A field with
//                                                        parentOf(key) is a tree, drawn left-aligned with tree guides
//   thimble.lanes({ mount, rows, range, ... })           the overview as lanes on the time range's scale: a lane per group of
//                                                        Rows, the marks in the Color by colours (or with `density` bars of
//                                                        the records per bin), a failure underlined in the problem red, a
//                                                        quiet cursor line on hover, the detail list's rows in view marked
//                                                        as a tint, and the key's entries as toggles
//   thimble.key(mount, entries, { onChange })            a key whose entries turn their series off and on
//   thimble.divider({ top, key })                        a bar between the overview and the detail list that a drag moves
//
// Only Color by draws in colour: Filter by's toggles and Rows' lanes name their values in words, and a failure may take
// the problem red beside the Color by colours. thimble keeps each control's choice, the values turned off, the key's
// series turned off, the lanes folded and the divider's place per view (viewer_colour.js `parts`), and Reset in Color
// by's row turns every value and series back on.
;(function () {
  'use strict'
  var kit = window.__thimbleKit
  if (!kit || !window.thimble || !kit.shared) return
  var thimble = window.thimble
  var shared = kit.shared
  var S = shared.state
  if (!S.parts || typeof S.parts !== 'object') S.parts = {}
  var esc = shared.esc
  var num = shared.num
  var tip = shared.tip
  var untip = shared.untip

  var NONE = '\u0000none' // the key of the records that take no value
  var NONE_BY = 'none' // what a control keeps for no choice
  var LANE_H = 18 // px, a lane's height
  var DENSE_H = 36 // px, a lane's height while the lanes draw density, so that the bars read
  var DENSE_BIN = 4 // px, a density bar's least width
  var MARK_MIN = 2 // px, a mark's least width
  var HIT = 4 // px either side of a mark within which a click or the tip finds it
  var ICON = {
    down: 'M6 9l6 6 6-6',
    check: 'M5 12.5l4.5 4.5L19 7',
    info: 'M12 8h.01M11 12h1v5h1',
  }
  function ico(name, cls) {
    return '<svg class="thimble-colour-ico' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true"><path d="' + ICON[name] + '"/>' + (name === 'info' ? '<circle cx="12" cy="12" r="9"/>' : '') + '</svg>'
  }
  function keyOf(v) {
    return v == null || v === '' ? NONE : String(v)
  }
  function el(target) {
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
  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v))
  }
  // what one part keeps per view, by its name: a small object in S.parts
  function kept(name) {
    var p = S.parts[name]
    if (!p || typeof p !== 'object') p = S.parts[name] = {}
    return p
  }
  function save() {
    shared.save()
  }

  // ---------------------------------------------------------------- the labels the controls hear
  var labelFns = []
  kit.labels(function (state, labelsChanged) {
    for (var i = 0; i < labelFns.length; i++) {
      var fn = labelFns[i]
      safe(function () {
        fn(!!labelsChanged)
      })
    }
  })
  function labels() {
    return safe(shared.labels, []) || []
  }
  // a label's values that the controls offer: those it highlights, in its order
  function labelValues(l) {
    return ((l && l.values) || [])
      .filter(function (v) {
        return v && v.highlight !== false
      })
      .map(function (v) {
        return String(v.name)
      })
  }

  // ---------------------------------------------------------------- a choice of a field or a label
  // What Filter by and Rows share: the fields they offer ({name, title, description, values, meanings, value(record)},
  // as Color by's), the label chosen or the field, a record's value under it, and the values the records the page hands
  // over take, counted per pass (the records one draw hands over, until the page next yields).
  function Choice(opts, part) {
    this.part = part
    this.fields = (Array.isArray(opts.fields) ? opts.fields : [])
      .filter(function (f) {
        return f && (typeof f === 'string' || typeof f.name === 'string')
      })
      .map(function (f) {
        if (typeof f === 'string') f = { name: f }
        var declared = Array.isArray(f.values)
          ? f.values.map(function (v) {
              return String(v != null && typeof v === 'object' ? v.name : v)
            })
          : null
        var means = {}
        if (f.meanings && typeof f.meanings === 'object') for (var k in f.meanings) if (typeof f.meanings[k] === 'string') means[k] = f.meanings[k]
        if (Array.isArray(f.values))
          f.values.forEach(function (v) {
            if (v && typeof v === 'object' && typeof v.meaning === 'string') means[String(v.name)] = v.meaning
          })
        return {
          name: String(f.name),
          title: String(f.title || f.name),
          description: typeof f.description === 'string' ? f.description : '',
          values: declared,
          meanings: means,
          value: typeof f.value === 'function' ? f.value : null,
          nameOf: typeof f.nameOf === 'function' ? f.nameOf : null,
          parentOf: typeof f.parentOf === 'function' ? f.parentOf : null,
        }
      })
    this.labelsToo = opts.labels !== false
    this.none = opts.none !== false
    // what the control opens on until the analyst picks: a field's name, or a list of choices, the first there taken,
    // each a field's name or {label: name or id}, a label counting while it is on; then the default
    var init = opts.initial
    this.starts = Array.isArray(init) ? init.slice() : init && typeof init === 'object' ? [init] : null
    this.initial = typeof init === 'string' ? init : init === null ? null : this.defaultInitial()
    this.tallies = {}
    this.pass = null
    this.passTimer = null
  }
  Choice.prototype.defaultInitial = function () {
    return null
  }
  Choice.prototype.field = function (name) {
    for (var i = 0; i < this.fields.length; i++) if (this.fields[i].name === name) return this.fields[i]
    return null
  }
  // the choice now: {field, title, f, key}, {label, title, key}, or null for None
  Choice.prototype.choice = function () {
    var by = kept(this.part).by
    if (by === NONE_BY) return null
    if (typeof by === 'string' && by.indexOf('l:') === 0) {
      var id = by.slice(2)
      var l = safe(function () {
        return shared.label(id)
      }, null)
      if (l && shared.labelOn(id)) return { label: id, title: l.name, key: by }
    } else if (typeof by === 'string' && by.indexOf('f:') === 0 && this.field(by.slice(2))) {
      var f = this.field(by.slice(2))
      return { field: f.name, title: f.title, f: f, key: by }
    }
    return this.opening()
  }
  // how the control opens (`initial`): the first of its starts that is there, a label while it is on, else its field
  Choice.prototype.opening = function () {
    var list = (this.starts || []).concat(this.initial ? [this.initial] : [])
    for (var i = 0; i < list.length; i++) {
      var s = list[i]
      if (typeof s === 'string') {
        var fd = this.field(s)
        if (fd) return { field: fd.name, title: fd.title, f: fd, key: 'f:' + fd.name }
      } else if (s && typeof s === 'object' && s.label != null && this.labelsToo) {
        var l = findLabel(String(s.label))
        if (l && shared.labelOn(String(l.id))) return { label: String(l.id), title: l.name, key: 'l:' + l.id }
      }
    }
    return null
  }
  // a label by its id, else by its name (one over these files first), the case and the spaces aside
  function findLabel(x) {
    var all = labels()
    var norm = function (s) {
      return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase()
    }
    var i
    for (i = 0; i < all.length; i++) if (String(all[i].id) === x) return all[i]
    var named = all.filter(function (l) {
      return norm(l.name) === norm(x)
    })
    for (i = 0; i < named.length; i++) if (named[i].here) return named[i]
    return named[0] || null
  }
  Choice.prototype.valueOf = function (record, c) {
    c = c === undefined ? this.choice() : c
    if (!c || record == null) return null
    if (c.label) return shared.labelValue(c.label, record)
    var v = c.f.value ? safe(function () { return c.f.value(record) }, null) : typeof record === 'object' ? record[c.field] : null
    return v == null || v === '' || typeof v === 'object' ? null : String(v)
  }
  // a record's values of every field, counted for the menu's words and the toggles' counts, each record once a pass
  Choice.prototype.tally = function (record) {
    if (record == null || typeof record !== 'object') return
    var self = this
    if (!this.pass) {
      this.pass = { seen: typeof WeakSet === 'function' ? new WeakSet() : null, counts: {}, label: {}, records: [] }
      this.passTimer = setTimeout(function () {
        var p = self.pass
        self.pass = null
        self.passTimer = null
        self.tallies = p.counts
        self.labelTally = p.label
        self.lastRecords = p.records
        self.marksSig = self.labelSig()
        self.tallied()
      }, 0)
    }
    var p = this.pass
    if (p.seen) {
      if (p.seen.has(record)) return
      p.seen.add(record)
    }
    p.records.push(record)
    for (var i = 0; i < this.fields.length; i++) {
      var f = this.fields[i]
      var v = this.valueOf(record, { field: f.name, f: f })
      var t = p.counts[f.name] || (p.counts[f.name] = {})
      var k = keyOf(v)
      t[k] = (t[k] || 0) + 1
    }
    var c = this.choice()
    if (c && c.label) {
      var lk = keyOf(this.valueOf(record, c))
      p.label[lk] = (p.label[lk] || 0) + 1
    }
  }
  Choice.prototype.tallied = function () {}
  // the chosen label's values on the records of the last pass, to tell whether new marks moved any of them
  Choice.prototype.labelSig = function () {
    var c = this.choice()
    if (!c || !c.label || !this.lastRecords) return ''
    var out = []
    for (var i = 0; i < this.lastRecords.length; i++) out.push(keyOf(this.valueOf(this.lastRecords[i], c)))
    return c.key + '\u0000' + out.join('\u0000')
  }
  // whether the label chosen gave a record of the last pass another value: only then is the page told, so marks that
  // arrive for the records a redraw anchors again never draw the page again and again
  Choice.prototype.marksMoved = function () {
    var sig = this.labelSig()
    if (sig === this.marksSig) return false
    this.marksSig = sig
    return true
  }
  // the counts of the choice's values: the page's (counts()), else those of the last pass
  Choice.prototype.countsNow = function () {
    var c = this.choice()
    if (!c) return {}
    if (this.given && this.givenBy === c.key) return this.given
    return (c.label ? this.labelTally : this.tallies[c.field]) || {}
  }
  // the values a choice offers, in order: a label's highlighted values, else the field's declared values and those its
  // records take, the commonest first; then no value where any record takes none
  Choice.prototype.valueList = function (c, counts) {
    var out = []
    var have = {}
    var add = function (v) {
      var k = keyOf(v)
      if (have[k]) return
      have[k] = true
      out.push(k)
    }
    if (!c) return out
    if (c.label) {
      labelValues(shared.label(c.label)).forEach(add)
    } else {
      ;(c.f.values || []).forEach(add)
      Object.keys(counts)
        .filter(function (k) {
          return k !== NONE && !have[k]
        })
        .sort(function (a, b) {
          return (counts[b] || 0) - (counts[a] || 0) || (a < b ? -1 : a > b ? 1 : 0)
        })
        .forEach(add)
    }
    if (counts[NONE] || (c.label && !Object.keys(counts).length)) add(null)
    return out
  }
  Choice.prototype.nameOfValue = function (c, k) {
    if (k === NONE) return c && c.label ? 'Not marked' : 'No ' + (c ? c.title.toLowerCase() : 'value')
    if (c && c.f && c.f.nameOf) {
      var n = safe(function () { return c.f.nameOf(k) }, null)
      if (n != null && n !== '') return String(n)
    }
    return k
  }
  // what a value means, for its toggle's tip: a field's meaning or description, a label's from its definition
  Choice.prototype.about = function (c, k, show) {
    if (!c || k === NONE) return
    if (c.f) {
      var m = c.f.meanings[k] || c.f.description
      if (m) show(m)
      return
    }
    shared.definition(c.label).then(function (def) {
      var m = shared.meaning(def, k)
      if (m) show(m)
    })
  }
  // A choice made from the menu. A label not on is turned on first, during the analyst's click, so that its values
  // reach the records; Color by is told it has seen it, so it keeps its own colour (a label turned on elsewhere still
  // takes the colour).
  Choice.prototype.choose = function (by) {
    if (by && typeof by === 'object') by = by.label != null ? 'l:' + by.label : by.field != null ? 'f:' + by.field : NONE_BY
    if (by == null) by = NONE_BY
    var p = kept(this.part)
    if (by.indexOf('l:') === 0) {
      var id = by.slice(2)
      if (!shared.labelOn(id)) {
        if (!Array.isArray(S.seen)) S.seen = []
        if (S.seen.indexOf(id) < 0) S.seen.push(id)
        thimble.setLabel(id, true).catch(function (e) {
          kit.report(e)
        })
      }
    }
    if (p.by === by) return
    p.by = by
    this.given = null
    save()
    this.changed()
  }
  Choice.prototype.changed = function () {}

  // ---------------------------------------------------------------- the menu of fields and labels
  // A menu under its trigger, as Color by's (viewer_kit.css .thimble-colour-menu): None, the fields with their values in
  // words, the labels over these files and the others, each with its values in words and its definition one click away
  // (the info button opens thimble's label editor). The values are words, never colours: only Color by draws in colour.
  var openMenu = null
  function closeMenu() {
    if (!openMenu) return
    openMenu.el.remove()
    untip()
    document.removeEventListener('pointerdown', openMenu.away, true)
    document.removeEventListener('keydown', openMenu.key, true)
    if (openMenu.anchor) openMenu.anchor.setAttribute('aria-expanded', 'false')
    var was = openMenu
    openMenu = null
    if (was.onClose) safe(was.onClose)
  }
  function placeMenu(m, anchor) {
    var r = anchor.getBoundingClientRect()
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
  // a menu `html` under `anchor`; `onClick(e)` hears a click in it, which returns true to keep it open
  function showMenu(anchor, html, onClick, label, onClose) {
    closeMenu()
    var m = document.createElement('div')
    m.className = 'thimble-colour-menu thimble-part'
    m.setAttribute('role', 'menu')
    if (label) m.setAttribute('aria-label', label)
    m.setAttribute('data-thimble-chrome', '')
    m.innerHTML = html
    document.body.appendChild(m)
    placeMenu(m, anchor)
    var away = function (e) {
      if (openMenu && !m.contains(e.target) && !anchor.contains(e.target)) closeMenu()
    }
    var key = function (e) {
      if (e.key === 'Escape' && openMenu) {
        e.stopPropagation()
        closeMenu()
        anchor.focus()
      }
    }
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', key, true)
    m.addEventListener('click', function (e) {
      if (!safe(function () { return onClick(e) }, false)) closeMenu()
    })
    anchor.setAttribute('aria-expanded', 'true')
    openMenu = { el: m, anchor: anchor, away: away, key: key, onClose: onClose || null, redraw: null }
    return openMenu
  }
  // a field's or a label's row: its name, how many values, its values in words cut off with …
  function choiceRow(by, checked, name, values, labelId) {
    var n = values.length
    return (
      '<div class="thimble-colour-item thimble-colour-choice" role="menuitemradio" tabindex="0" aria-checked="' + checked + '" data-by="' + esc(by) + '"' + (labelId != null ? ' data-label="' + esc(labelId) + '"' : '') + '>' +
      '<span class="thimble-colour-tick">' + (checked ? ico('check') : '') + '</span>' +
      '<span class="thimble-colour-body"><span class="thimble-colour-top"><span class="thimble-colour-nm">' + esc(name) + '</span>' +
      (n ? '<span class="thimble-colour-n">' + num(n) + (n === 1 ? ' value' : ' values') + '</span>' : '') + '</span>' +
      (n ? '<span class="thimble-colour-preview thimble-ctl-words">' + esc(values.slice(0, 24).join(' · ')) + '</span>' : '') +
      '</span>' +
      (labelId != null ? '<button type="button" class="btn btn-ghost btn-sm btn-square thimble-ctl-def" data-def="' + esc(labelId) + '" data-label="' + esc(labelId) + '" aria-label="' + esc('What ' + name + ' marks') + '" title="' + esc('What ' + name + ' marks') + '">' + ico('info') + '</button>' : '') +
      '</div>'
    )
  }
  Choice.prototype.menuHtml = function (title) {
    var c = this.choice()
    var self = this
    var html = '<div class="thimble-colour-head">' + esc(title) + '</div>'
    if (this.none) html += choiceRow(NONE_BY, !c, 'None', [])
    html += this.fields
      .map(function (f) {
        var counts = self.tallies[f.name] || {}
        var vals = self.valueList({ field: f.name, f: f, title: f.title }, counts).filter(function (k) { return k !== NONE }).map(function (k) { return self.nameOfValue({ f: f, title: f.title }, k) })
        return choiceRow('f:' + f.name, !!(c && c.field === f.name), f.title, vals)
      })
      .join('')
    if (!this.labelsToo) return html
    var all = labels()
    var row = function (l) {
      return choiceRow('l:' + l.id, !!(c && c.label === String(l.id)), l.name, labelValues(l).concat(['Not marked']), l.id)
    }
    var here = all.filter(function (l) { return l.here })
    var other = all.filter(function (l) { return !l.here })
    html += '<div class="thimble-colour-head">Labels over these files</div>'
    html += here.length ? here.map(row).join('') : '<div class="thimble-colour-note">No label covers these files yet</div>'
    if (other.length) html += '<div class="thimble-colour-head">Other labels</div>' + other.map(row).join('')
    return html
  }
  Choice.prototype.openMenu = function (anchor, title) {
    var self = this
    var m = showMenu(
      anchor,
      this.menuHtml(title),
      function (e) {
        var def = e.target.closest('[data-def]')
        if (def) {
          e.stopPropagation()
          if (typeof thimble.editLabel === 'function') thimble.editLabel(def.getAttribute('data-def'), { anchor: m.el }).catch(function () {})
          return true
        }
        var item = e.target.closest('[data-by]')
        if (!item) return true
        self.choose(item.getAttribute('data-by'))
        return false
      },
      title,
    )
    m.el.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('thimble-colour-choice')) {
        e.preventDefault()
        e.target.click()
      }
    })
    m.redraw = function () {
      var scroll = m.el.scrollTop
      m.el.innerHTML = self.menuHtml(title)
      m.el.scrollTop = scroll
    }
    m.owner = this
  }

  // ---------------------------------------------------------------- Filter by
  // Filter by in the top row: its trigger with the choice in it, "Filter by: Outcome", and the chosen field's or label's
  // values as toggles (a box ticked while the value shows), "N more" for those that do not fit. A click turns a value
  // off or on; an Alt-click or a double click shows that value alone; hovering a value says what it means. The page
  // hides a record whose value is off (keeps), or sends query() to its reader, which takes it as Color by's choice.
  function Filter(opts) {
    Choice.call(this, opts, typeof opts.key === 'string' ? 'filter:' + opts.key : 'filter')
    var self = this
    this.onChange = typeof opts.onChange === 'function' ? opts.onChange : null
    this.mount = el(opts.mount)
    this.given = null
    this.givenBy = null
    this.lastKey = ''
    this.changeTimer = null
    if (this.mount) {
      this.mount.classList.add('thimble-filter-mount', 'thimble-part')
      this.mount.setAttribute('data-thimble-chrome', '')
      this.mount.innerHTML = ''
      this.root = document.createElement('span')
      this.root.className = 'thimble-filter'
      this.mount.appendChild(this.root)
      this.root.addEventListener('click', function (e) {
        self.click(e)
      })
      this.root.addEventListener('dblclick', function (e) {
        var chip = e.target.closest && e.target.closest('.thimble-filter-chip')
        if (!chip) return
        var k = self.keyAt(chip)
        if (self.pre && self.pre.key === k) kept(self.part).off = self.pre.off
        self.pre = null
        self.only(k)
      })
      this.root.addEventListener('pointerover', function (e) {
        var chip = e.target.closest && e.target.closest('.thimble-filter-chip')
        if (chip) self.chipTip(chip)
      })
      this.root.addEventListener('pointerout', function (e) {
        var chip = e.target.closest && e.target.closest('.thimble-filter-chip')
        if (chip && !(e.relatedTarget && chip.contains(e.relatedTarget))) untip()
      })
      if (typeof ResizeObserver === 'function') {
        var w = -1
        new ResizeObserver(function () {
          if (!self.mount || self.mount.clientWidth === w) return
          w = self.mount.clientWidth
          self.fit()
        }).observe(this.mount)
      }
    }
    this.check = shared.part({
      changed: function () {
        return self.offKeys().length > 0
      },
      reset: function () {
        var p = kept(self.part)
        p.off = {}
        save()
        self.render()
      },
      fire: function () {
        self.fire()
      },
    })
    labelFns.push(function (labelsChanged) {
      var c = self.choice()
      if (openMenu && openMenu.owner === self && openMenu.redraw && labelsChanged) openMenu.redraw()
      if (c && c.label && (labelsChanged || self.marksMoved())) self.fire()
      self.render()
    })
    this.render()
  }
  Filter.prototype = Object.create(Choice.prototype)
  Filter.prototype.offKeys = function (c) {
    c = c === undefined ? this.choice() : c
    if (!c) return []
    var off = kept(this.part).off
    return (off && Array.isArray(off[c.key]) && off[c.key]) || []
  }
  Filter.prototype.isOn = function (v) {
    return this.offKeys().indexOf(keyOf(v)) < 0
  }
  Filter.prototype.tallied = function () {
    this.render()
  }
  Filter.prototype.changed = function () {
    if (openMenu && openMenu.owner === this && openMenu.redraw) openMenu.redraw()
    this.render()
    this.check()
    this.fire()
  }
  Filter.prototype.fire = function () {
    var self = this
    if (!this.onChange || this.changeTimer != null || shared.resetting()) return
    this.changeTimer = setTimeout(function () {
      self.changeTimer = null
      safe(function () {
        self.onChange(self.api)
      })
    }, 0)
  }
  Filter.prototype.values = function () {
    var c = this.choice()
    var counts = this.countsNow()
    var off = this.offKeys(c)
    var self = this
    return this.valueList(c, counts).map(function (k) {
      return { key: k, value: k === NONE ? null : k, name: self.nameOfValue(c, k), n: counts[k] || 0, on: off.indexOf(k) < 0 }
    })
  }
  Filter.prototype.render = function () {
    if (!this.root) return
    var c = this.choice()
    var vals = this.values()
    var key = JSON.stringify([c && c.key, vals])
    if (key === this.lastKey) return
    this.lastKey = key
    this.shown = vals
    var by = '<button type="button" class="btn btn-secondary btn-sm thimble-colour-by thimble-filter-by" aria-haspopup="menu" aria-expanded="false"' + (c && c.label ? ' data-label="' + esc(c.label) + '"' : '') + '><span class="thimble-colour-k">Filter by' + (c ? ':' : '') + '</span>' + (c ? '<b>' + esc(c.title) + '</b>' : '') + ico('down') + '</button>'
    var chips = vals
      .map(function (v, i) {
        return '<button type="button" class="chip chip-key chip-act thimble-filter-chip" data-i="' + i + '" aria-pressed="' + v.on + '"' + (c && c.label ? ' data-label="' + esc(c.label) + '"' : '') + '><span class="thimble-filter-box' + (v.on ? ' on' : '') + '">' + (v.on ? ico('check') : '') + '</span><span class="chip-text">' + esc(v.name) + '</span><span class="chip-count">' + num(v.n) + '</span></button>'
      })
      .join('')
    chips += '<button type="button" class="btn btn-ghost btn-sm thimble-colour-more thimble-filter-more" hidden></button>'
    this.root.innerHTML = by + '<span class="thimble-colour-chips thimble-filter-chips">' + chips + '</span>'
    if (openMenu && openMenu.owner === this && !openMenu.anchor.isConnected) {
      var again = this.root.querySelector(openMenu.values ? '.thimble-filter-more' : '.thimble-filter-by')
      if (again) {
        openMenu.anchor = again
        again.setAttribute('aria-expanded', 'true')
      }
    }
    this.fit()
  }
  // the toggles that do not fit the mount go behind "N more", the last first
  Filter.prototype.fit = function () {
    if (!this.root) return
    var box = this.root.querySelector('.thimble-filter-chips')
    var more = this.root.querySelector('.thimble-filter-more')
    if (!box || !more) return
    var over = function () {
      var left = box.getBoundingClientRect().left
      var right = left
      for (var k = 0; k < box.children.length; k++) if (!box.children[k].hidden) right = Math.max(right, box.children[k].getBoundingClientRect().right)
      return right - left > box.clientWidth + 1
    }
    var chips = box.querySelectorAll('.thimble-filter-chip')
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
  }
  Filter.prototype.keyAt = function (node) {
    var v = this.shown && this.shown[Number(node.getAttribute('data-i'))]
    return v ? v.key : null
  }
  Filter.prototype.chipTip = function (chip) {
    var c = this.choice()
    var v = this.shown && this.shown[Number(chip.getAttribute('data-i'))]
    if (!v) return
    var now = true
    this.about(c, v.key, function (m) {
      if (!chip.isConnected || openMenu || (!now && !chip.matches(':hover'))) return
      var r = chip.getBoundingClientRect()
      tip('<div class="thimble-tip-h">' + esc(v.name) + '</div><div class="thimble-tip-m">' + esc(m) + '</div>', r.left, r.bottom - 8)
    })
    now = false
  }
  Filter.prototype.click = function (e) {
    var t = e.target
    if (!t.closest) return
    var trig = t.closest('.thimble-filter-by')
    if (trig) {
      if (openMenu && openMenu.anchor === trig) return closeMenu()
      return this.openMenu(trig, 'Filter by')
    }
    var more = t.closest('.thimble-filter-more')
    if (more) {
      if (openMenu && openMenu.anchor === more) return closeMenu()
      return this.valuesMenu(more)
    }
    var chip = t.closest('.thimble-filter-chip')
    if (!chip) return
    var k = this.keyAt(chip)
    if (k == null) return
    if (e.altKey) return this.only(k)
    if (e.detail > 1) return
    var c = this.choice()
    this.pre = c ? { key: k, off: JSON.parse(JSON.stringify(kept(this.part).off || {})) } : null
    this.toggle(k)
  }
  // every value with its box, for those behind "N more"
  Filter.prototype.valuesMenu = function (anchor) {
    var self = this
    var html = function () {
      var c = self.choice()
      return (
        '<div class="thimble-colour-head">' + esc(c ? c.title : '') + '</div>' +
        self.values()
          .map(function (v, i) {
            return '<button type="button" class="thimble-colour-item" role="menuitemcheckbox" aria-checked="' + v.on + '" data-i="' + i + '"><span class="thimble-colour-box' + (v.on ? ' on' : '') + '">' + (v.on ? ico('check') : '') + '</span><span class="thimble-colour-nm">' + esc(v.name) + '</span><span class="thimble-colour-n">' + num(v.n) + '</span></button>'
          })
          .join('')
      )
    }
    var m = showMenu(
      anchor,
      html(),
      function (e) {
        var it = e.target.closest('[data-i]')
        var v = it && self.values()[Number(it.getAttribute('data-i'))]
        if (!v) return true
        if (e.altKey) self.only(v.key)
        else self.toggle(v.key)
        m.el.innerHTML = html()
        return true
      },
      'Values',
    )
    m.values = true
    m.owner = this
  }
  Filter.prototype.setOff = function (keys) {
    var c = this.choice()
    if (!c) return
    var p = kept(this.part)
    if (!p.off || typeof p.off !== 'object') p.off = {}
    p.off[c.key] = keys
    save()
    this.changed()
  }
  Filter.prototype.toggle = function (k) {
    k = k === null || k === undefined ? NONE : String(k)
    var off = this.offKeys().slice()
    var at = off.indexOf(k)
    if (at >= 0) off.splice(at, 1)
    else off.push(k)
    this.setOff(off)
  }
  Filter.prototype.only = function (k) {
    k = k === null || k === undefined ? NONE : String(k)
    var all = this.values().map(function (v) { return v.key })
    var off = this.offKeys()
    var alone = off.indexOf(k) < 0 && all.every(function (x) { return x === k || off.indexOf(x) >= 0 })
    this.setOff(alone ? [] : all.filter(function (x) { return x !== k }))
  }
  function filterApi(f) {
    var out = {
      /** {field, title} or {label, title}, or null for None */
      get by() {
        var c = f.choice()
        return c ? (c.label ? { label: c.label, title: c.title } : { field: c.field, title: c.title }) : null
      },
      get field() {
        var c = f.choice()
        return c && c.field ? c.field : null
      },
      get label() {
        var c = f.choice()
        return c && c.label ? c.label : null
      },
      /** the toggles: [{value, name, on, n}], value null for the records with no value */
      get values() {
        return f.values().map(function (v) {
          return { value: v.value, name: v.name, on: v.on, n: v.n }
        })
      },
      /** a record's value under the choice, as Color by's valueOf reads a field or a label */
      valueOf: function (record) {
        f.tally(record)
        return f.valueOf(record)
      },
      isOn: function (value) {
        return f.isOn(value)
      },
      /** whether a record shows: its value is on (every record with None) */
      keeps: function (record) {
        f.tally(record)
        var c = f.choice()
        return !c || f.isOn(f.valueOf(record, c))
      },
      /** the choice for the reader, as Color by's query(): {field, off}, {label, name, off}, or null for None */
      query: function () {
        var c = f.choice()
        if (!c) return null
        var off = f.offKeys(c).map(function (k) { return k === NONE ? null : k })
        return c.label ? { label: c.label, name: c.title, off: off } : { field: c.field, off: off }
      },
      /** the reader's counts of the choice's values, {value: n} with '' for no value; null counts the records again */
      counts: function (map) {
        var c = f.choice()
        if (map == null) {
          f.given = null
          f.givenBy = null
        } else {
          var got = {}
          for (var k in map) got[keyOf(k)] = Number(map[k]) || 0
          f.given = got
          f.givenBy = c ? c.key : null
        }
        f.render()
      },
      /** choose a field by name, a label ({label: id}), or None (null) */
      choose: function (by) {
        f.choose(by === null ? NONE_BY : typeof by === 'string' ? 'f:' + by : by)
      },
      toggle: function (value) {
        f.toggle(value)
      },
    }
    return out
  }
  /** Filter by, in the top row beside Color by (see the top of this file). */
  thimble.filterBy = function (opts) {
    var f = new Filter(opts || {})
    f.api = filterApi(f)
    return f.api
  }

  // ---------------------------------------------------------------- Rows
  // Rows in the top row: "Rows: Session", a trigger whose menu picks what the lanes or rows are grouped by. groups()
  // gives the groups in order: a label's values (every class it has, so a class added to the label is a new lane), else
  // the field's values (declared first, then as the records first take them), then the group of the records with no
  // value. A field with parentOf(key) is a tree: each group under its parent, its guide (├ └ │) drawn left-aligned, as a
  // file view draws folders; a parent no record takes is a heading.
  function Rows(opts) {
    Choice.call(this, opts, typeof opts.key === 'string' ? 'rows:' + opts.key : 'rows')
    var self = this
    this.onChange = typeof opts.onChange === 'function' ? opts.onChange : null
    this.mount = el(opts.mount)
    this.changeTimer = null
    this.drawnKey = ''
    if (this.mount) {
      this.mount.classList.add('thimble-rows-mount', 'thimble-part')
      this.mount.setAttribute('data-thimble-chrome', '')
      this.mount.addEventListener('click', function (e) {
        var trig = e.target.closest && e.target.closest('.thimble-rows-by')
        if (!trig) return
        if (openMenu && openMenu.anchor === trig) return closeMenu()
        self.openMenu(trig, 'Rows')
      })
    }
    labelFns.push(function (labelsChanged) {
      var c = self.choice()
      if (openMenu && openMenu.owner === self && openMenu.redraw && labelsChanged) openMenu.redraw()
      self.render()
      // a label's classes or its values on the records changed: its lanes are drawn again
      if (c && c.label && (labelsChanged || self.marksMoved())) self.fire()
    })
    // the label the lanes are grouped by takes no colour when it is turned on: the lanes keep Color by's own choice
    if (typeof shared.hold === 'function')
      shared.hold(function () {
        var c = self.choice()
        return c && c.label ? [c.label] : []
      })
    this.render()
  }
  Rows.prototype = Object.create(Choice.prototype)
  // a record the reader gave its group under the choice (`group`, from thimble.colour_value(rows.query(), ref)) keeps
  // it: a label's value reaches the page only on the records it anchors
  Rows.prototype.valueOf = function (record, c) {
    var now = this.choice()
    c = c === undefined ? now : c
    if (c && now && c.key === now.key && record && typeof record === 'object' && Object.prototype.hasOwnProperty.call(record, 'group')) return record.group == null || record.group === '' ? null : String(record.group)
    return Choice.prototype.valueOf.call(this, record, c)
  }
  Rows.prototype.defaultInitial = function () {
    return this.fields.length ? this.fields[0].name : null
  }
  Rows.prototype.render = function () {
    if (!this.mount) return
    var c = this.choice()
    var key = c ? c.key : NONE_BY
    if (key === this.drawnKey && this.mount.firstChild) return
    this.drawnKey = key
    this.mount.innerHTML = '<button type="button" class="btn btn-secondary btn-sm thimble-colour-by thimble-rows-by" aria-haspopup="menu" aria-expanded="false"' + (c && c.label ? ' data-label="' + esc(c.label) + '"' : '') + '><span class="thimble-colour-k">Rows:</span><b>' + esc(c ? c.title : 'None') + '</b>' + ico('down') + '</button>'
  }
  Rows.prototype.changed = function () {
    this.render()
    this.fire()
  }
  Rows.prototype.fire = function () {
    var self = this
    if (!this.onChange || this.changeTimer != null) return
    this.changeTimer = setTimeout(function () {
      self.changeTimer = null
      safe(function () {
        self.onChange(self.api)
      })
    }, 0)
  }
  // the groups of `items` in order (see Rows above): [{key, value, name, depth, guide, last, heading, parent, items}]
  Rows.prototype.groups = function (items) {
    var c = this.choice()
    var self = this
    items = items || []
    if (!c) return [{ key: '*', value: null, name: 'All', depth: 0, guide: '', last: true, heading: false, parent: null, children: 0, items: items.slice() }]
    var by = {}
    var first = []
    for (var i = 0; i < items.length; i++) {
      this.tally(items[i])
      var k = keyOf(this.valueOf(items[i], c))
      if (!by[k]) {
        by[k] = []
        first.push(k)
      }
      by[k].push(items[i])
    }
    var node = function (k, depth, heading) {
      return { key: k, value: k === NONE ? null : k, name: self.nameOfValue(c, k), depth: depth, guide: '', last: true, heading: !!heading, parent: null, children: 0, items: by[k] || [] }
    }
    var out = []
    if (c.label) {
      labelValues(shared.label(c.label)).forEach(function (k) {
        out.push(node(k, 0))
      })
      if (by[NONE] || !out.length) out.push(node(NONE, 0))
      // a value the label no longer highlights but a record still takes
      first.forEach(function (k) {
        if (!out.some(function (n) { return n.key === k })) out.splice(out.length - 1, 0, node(k, 0))
      })
      return out
    }
    var f = c.f
    if (!f.parentOf) {
      var order = (f.values || []).filter(function (k) { return by[k] })
      first.forEach(function (k) {
        if (k !== NONE && order.indexOf(k) < 0) order.push(k)
      })
      order.forEach(function (k) {
        out.push(node(k, 0))
      })
      if (by[NONE]) out.push(node(NONE, 0))
      return out
    }
    // a tree: every group with records and the parents above them; siblings in the order their records first come
    var parent = {}
    var all = {}
    var rank = {}
    first.forEach(function (k, i) {
      rank[k] = i
    })
    var climb = function (k) {
      var seen = {}
      while (k != null && !seen[k]) {
        seen[k] = true
        all[k] = true
        var p = k === NONE ? null : safe(function () { return f.parentOf(k) }, null)
        p = p == null || p === '' ? null : String(p)
        parent[k] = p
        k = p
      }
    }
    first.forEach(climb)
    var kids = {}
    var roots = []
    Object.keys(all).forEach(function (k) {
      var p = parent[k]
      if (p != null && all[p] && p !== k) (kids[p] || (kids[p] = [])).push(k)
      else roots.push(k)
    })
    // a group's place: its own first record, else its first descendant's
    var place = function (k, seen) {
      if (rank[k] != null) return rank[k]
      seen = seen || {}
      if (seen[k]) return 1e9
      seen[k] = true
      var best = 1e9
      ;(kids[k] || []).forEach(function (x) {
        best = Math.min(best, place(x, seen))
      })
      return best
    }
    var bySpot = function (a, b) {
      if (a === NONE) return 1
      if (b === NONE) return -1
      return place(a) - place(b)
    }
    var walk = function (k, depth, lead, last, p) {
      var n = node(k, depth, !by[k])
      n.parent = p
      n.last = last
      n.guide = depth ? lead + (last ? '└ ' : '├ ') : ''
      var ks = (kids[k] || []).slice().sort(bySpot)
      n.children = ks.length
      out.push(n)
      ks.forEach(function (x, i) {
        walk(x, depth + 1, depth ? lead + (last ? '  ' : '│ ') : '', i === ks.length - 1, k)
      })
    }
    roots.sort(bySpot).forEach(function (k) {
      walk(k, 0, '', true, null)
    })
    return out
  }
  function rowsApi(r) {
    return {
      /** {field, title} or {label, title}, or null for None (one group of every record) */
      get by() {
        var c = r.choice()
        return c ? (c.label ? { label: c.label, title: c.title } : { field: c.field, title: c.title }) : null
      },
      get field() {
        var c = r.choice()
        return c && c.field ? c.field : null
      },
      get label() {
        var c = r.choice()
        return c && c.label ? c.label : null
      },
      /** a record's group: its value of the field or the label, null for the group of no value */
      groupOf: function (record) {
        r.tally(record)
        return r.valueOf(record)
      },
      /** the groups of the records, in order, each with its records and, for a tree, its depth and guide */
      groups: function (items) {
        return r.groups(items)
      },
      /** the choice for the reader: {field}, {label, name}, or null; thimble.colour_value(rows, ref, record) gives a
       *  record's group there */
      query: function () {
        var c = r.choice()
        return c ? (c.label ? { label: c.label, name: c.title } : { field: c.field }) : null
      },
      /** choose a field by name, a label ({label: id}), or None (null) */
      choose: function (by) {
        r.choose(by === null ? NONE_BY : typeof by === 'string' ? 'f:' + by : by)
      },
    }
  }
  /** Rows, in the top row (see the top of this file). */
  thimble.rows = function (opts) {
    var r = new Rows(opts || {})
    r.api = rowsApi(r)
    return r.api
  }

  // ---------------------------------------------------------------- a key whose entries are toggles
  // Each entry is a chip with a swatch drawn as its series is drawn (a band, a mark, an underline in the problem red, a
  // line), its name and its count; a click hides or shows the series, an entry whose series never appears is left out.
  // entries: [{id, name, mark: 'band' | 'mark' | 'problem' | 'line', colour?, n?, count?}]: `n` the series' records (an
  // entry with none is left out), shown after the name unless `count` is false
  function Key(mount, entries, opts) {
    var self = this
    this.mount = el(mount)
    this.name = 'key:' + (opts.key || (this.mount && this.mount.id) || 'key')
    this.onChange = typeof opts.onChange === 'function' ? opts.onChange : null
    this.entries = []
    if (this.mount) {
      this.mount.classList.add('thimble-key', 'thimble-part')
      this.mount.setAttribute('data-thimble-chrome', '')
      this.mount.addEventListener('click', function (e) {
        var chip = e.target.closest && e.target.closest('.thimble-key-chip')
        if (chip) self.toggle(chip.getAttribute('data-id'))
      })
    }
    shared.part({
      changed: function () {
        return self.offIds().length > 0
      },
      reset: function () {
        kept(self.name).off = []
        save()
        self.render()
      },
      fire: function () {
        if (self.onChange) safe(function () { self.onChange(self.api) })
      },
    })
    this.set(entries)
  }
  Key.prototype.offIds = function () {
    var off = kept(this.name).off
    return Array.isArray(off) ? off : []
  }
  Key.prototype.isOn = function (id) {
    return this.offIds().indexOf(String(id)) < 0
  }
  Key.prototype.set = function (entries) {
    this.entries = (Array.isArray(entries) ? entries : []).filter(function (e) {
      return e && e.id != null && !(typeof e.n === 'number' && e.n <= 0)
    })
    this.render()
  }
  Key.prototype.render = function () {
    if (!this.mount) return
    var self = this
    this.mount.innerHTML = this.entries
      .map(function (e) {
        var on = self.isOn(e.id)
        var mark = e.mark || 'mark'
        return '<button type="button" class="chip chip-key chip-act thimble-key-chip" data-id="' + esc(e.id) + '" aria-pressed="' + on + '"' + (e.about ? ' title="' + esc(e.about) + '"' : '') + '><span class="thimble-key-sw thimble-key-' + esc(mark) + '"' + (e.colour ? ' style="--c:' + esc(e.colour) + '"' : '') + '></span><span class="chip-text">' + esc(e.name) + '</span>' + (typeof e.n === 'number' && e.count !== false ? '<span class="chip-count">' + num(e.n) + '</span>' : '') + '</button>'
      })
      .join('')
  }
  Key.prototype.toggle = function (id) {
    id = String(id)
    var off = this.offIds().slice()
    var at = off.indexOf(id)
    if (at >= 0) off.splice(at, 1)
    else off.push(id)
    kept(this.name).off = off
    save()
    this.render()
    if (this.onChange) {
      var self = this
      safe(function () { self.onChange(self.api) })
    }
  }
  function keyApi(k) {
    return {
      isOn: function (id) {
        return k.isOn(id)
      },
      set: function (entries) {
        k.set(entries)
      },
      toggle: function (id) {
        k.toggle(id)
      },
      get entries() {
        return k.entries.map(function (e) {
          return { id: e.id, name: e.name, on: k.isOn(e.id) }
        })
      },
    }
  }
  /** a key whose entries are toggles (see above) */
  thimble.key = function (mount, entries, opts) {
    var k = new Key(mount, entries, opts || {})
    k.api = keyApi(k)
    return k.api
  }

  // ---------------------------------------------------------------- lanes
  // The overview as lanes on the time range's scale (thimble.timeRange): a lane per group of Rows (or of `groups`), its
  // name in a column at the left with its tree guide, its records as marks in the Color by colours (grey with Off), as
  // wide as each ran (`end`), a band where the group ran (`band`), and a record that failed (`problem`) underlined in the
  // problem red. Hovering a lane draws a thin cursor line across the lanes and a tip of the time and the record there;
  // never an inverted band. A click on a mark is onMark(record), on a lane's name onPick(group), which marks the lane
  // chosen; ▾ folds a parent's lanes into its own. The detail list's rows in view (`follow`, rows with data-t) are a
  // light tint across the lanes, and the range's own overview marks them too where it can (range.visible). With
  // `density` (a flag, or a function the page answers at each draw) each lane is bars on the scale's bins instead, a
  // bar's height its bin's records on one scale for every lane, stacked by their Color by values in the chips' order;
  // hovering a bin gives its time and its records per value, a click opens its first record (onMark).
  // a tree guide (`│ ├ `, `  └ `) as cells a level wide, each drawn as lines that meet the lanes above and below, as a
  // file view draws its folders; the glyphs stay as the cells' text
  var GUIDE = { '│': 'pipe', '├': 'tee', '└': 'elbow' }
  function guideHtml(guide) {
    if (!guide) return ''
    var out = ''
    for (var i = 0; i < guide.length; i += 2) {
      var g = guide.charAt(i)
      out += '<span class="thimble-lane-guide thimble-lane-g-' + (GUIDE[g] || 'gap') + '">' + esc(guide.substr(i, 2)) + '</span>'
    }
    return out
  }
  function Lanes(opts) {
    var self = this
    this.opts = opts
    this.mount = el(opts.mount)
    this.rows = opts.rows || null
    this.range = opts.range || null
    this.colour = opts.colour || null
    this.time = typeof opts.time === 'function' ? opts.time : function (it) { return it.t != null ? it.t : it.time }
    this.end = typeof opts.end === 'function' ? opts.end : null
    this.band = typeof opts.band === 'function' ? opts.band : null
    this.problem = typeof opts.problem === 'function' ? opts.problem : null
    this.namesW = Number(opts.names) > 0 ? Number(opts.names) : 200
    this.name = 'lanes:' + (opts.key || (this.mount && this.mount.id) || 'lanes')
    this.items = []
    this.nodes = []
    this.span = null
    this.chosen = null
    var words = opts.words || {}
    this.words = { band: words.band || 'running', problem: words.problem || 'failed' }
    if (!this.mount) return
    this.mount.classList.add('thimble-lanes')
    this.mount.style.setProperty('--thimble-names', this.namesW + 'px')
    this.keyEl = el(opts.keyMount)
    if (!this.keyEl) {
      this.keyEl = document.createElement('div')
      this.keyEl.className = 'thimble-lanes-key'
      this.mount.appendChild(this.keyEl)
    }
    this.key = thimble.key(this.keyEl, [], {
      key: this.name,
      onChange: function () {
        self.paint()
      },
    })
    this.body = document.createElement('div')
    this.body.className = 'thimble-lanes-body'
    this.mount.appendChild(this.body)
    this.spanEl = document.createElement('div')
    this.spanEl.className = 'thimble-lanes-span'
    this.spanEl.setAttribute('aria-hidden', 'true')
    this.cursorEl = document.createElement('div')
    this.cursorEl.className = 'thimble-lanes-cursor'
    this.cursorEl.setAttribute('aria-hidden', 'true')
    this.body.addEventListener('pointermove', function (e) {
      self.hover(e)
    })
    this.body.addEventListener('pointerleave', function () {
      self.unhover()
    })
    this.body.addEventListener('click', function (e) {
      self.click(e)
    })
    if (typeof ResizeObserver === 'function') {
      var w = -1
      new ResizeObserver(function () {
        if (self.mount.clientWidth === w) return
        w = self.mount.clientWidth
        self.paint()
      }).observe(this.mount)
    }
    if (opts.follow) this.follow(opts.follow)
  }
  Lanes.prototype.folded = function () {
    var f = kept(this.name).folded
    return Array.isArray(f) ? f : []
  }
  Lanes.prototype.trackW = function () {
    return Math.max(10, this.body.clientWidth - this.namesW)
  }
  Lanes.prototype.scale = function () {
    var w = this.trackW()
    if (this.range && typeof this.range.scale === 'function') return this.range.scale(w)
    // without a range: the records' whole span, linear
    var a = Infinity
    var b = -Infinity
    for (var i = 0; i < this.items.length; i++) {
      var t = this.time(this.items[i])
      if (t < a) a = t
      if (t > b) b = t
    }
    if (!isFinite(a)) a = b = 0
    if (b <= a) b = a + 1
    return { from: a, to: b, width: w, x: function (t) { return ((t - a) / (b - a)) * w }, t: function (x) { return a + (x / w) * (b - a) } }
  }
  // the lanes: the groups of Rows (or `groups(items)`), a parent folded taking its descendants' records
  Lanes.prototype.layout = function () {
    var items = this.items
    var nodes = typeof this.opts.groups === 'function' ? safe(function () { return this.opts.groups(items) }.bind(this), []) : this.rows ? this.rows.groups(items) : [{ key: '*', name: 'All', depth: 0, guide: '', items: items.slice() }]
    var folded = this.folded()
    var out = []
    var hideBelow = null
    nodes.forEach(function (n) {
      if (hideBelow != null) {
        if (n.depth > hideBelow.depth) {
          hideBelow.items = hideBelow.items.concat(n.items || [])
          return
        }
        hideBelow = null
      }
      var copy = {}
      for (var k in n) copy[k] = n[k]
      copy.items = (n.items || []).slice()
      copy.folded = !!n.children && folded.indexOf(String(n.key)) >= 0
      out.push(copy)
      if (copy.folded) hideBelow = copy
    })
    this.nodes = out
    return out
  }
  Lanes.prototype.draw = function (items) {
    if (Array.isArray(items)) this.items = items
    if (!this.mount) return
    this.layout()
    this.paint()
  }
  Lanes.prototype.on = function (series) {
    return this.key ? this.key.isOn(series) : true
  }
  // whether the lanes draw density (`density`, a flag or a function the page answers)
  Lanes.prototype.dense = function () {
    var d = this.opts.density
    return typeof d === 'function' ? !!safe(d, false) : !!d
  }
  // Density: each lane's records whose value is on, per bin of the scale (at least DENSE_BIN px wide), by value in the
  // chips' order, the records with no value last; a bar's height is its bin's records on one scale for every lane.
  // {bins, step, of(t), per: [Map bin -> {n: [per value], total, first}] per lane, max, names, colours}
  Lanes.prototype.binned = function (sc, colour) {
    var self = this
    var bn
    if (typeof sc.bins === 'function') {
      var bins = sc.bins(DENSE_BIN)
      bn = { bins: bins, of: function (t) { return sc.binOf(t) } }
    } else {
      var n = Math.max(1, Math.floor(sc.width / DENSE_BIN))
      var step = (sc.to - sc.from) / n
      var list = []
      for (var k = 0; k < n; k++) list.push([sc.from + k * step, sc.from + (k + 1) * step])
      bn = { bins: list, of: function (t) { var b = Math.floor((t - sc.from) / step); return b >= 0 && b < n ? b : t === sc.to ? n - 1 : -1 } }
    }
    var vals = colour && !colour.off ? colour.values || [] : []
    var order = vals.filter(function (v) { return v.value != null && v.on }).map(function (v) { return String(v.value) })
    var slot = {}
    order.forEach(function (v, i) { slot[v] = i })
    var K = order.length + 1
    var blank = vals.filter(function (v) { return v.value == null })[0]
    var names = order.map(function (v) {
      var hit = vals.filter(function (x) { return String(x.value) === v })[0]
      return hit && hit.name ? hit.name : v
    }).concat([(blank && blank.name) || 'No value'])
    var colours = order.map(function (v) { return (colour && colour.colourOf(v)) || '' }).concat([''])
    var max = 1
    var per = this.nodes.map(function (node) {
      var m = new Map()
      var its = node.heading && !node.folded ? [] : node.items || []
      for (var i = 0; i < its.length; i++) {
        var it = its[i]
        if (colour && !colour.keeps(it)) continue
        var t = self.time(it)
        var b = bn.of(t)
        if (b < 0) continue
        var bin = m.get(b)
        if (!bin) {
          bin = { n: new Array(K).fill(0), total: 0, first: it, bad: 0 }
          m.set(b, bin)
        }
        var v = colour ? colour.valueOf(it) : null
        bin.n[v != null && Object.prototype.hasOwnProperty.call(slot, String(v)) ? slot[String(v)] : K - 1]++
        bin.total++
        if (t < self.time(bin.first)) bin.first = it
        if (self.problem && safe(function () { return self.problem(it) }, false)) bin.bad++
        if (bin.total > max) max = bin.total
      }
      return m
    })
    return { bins: bn.bins, of: bn.of, per: per, max: max, K: K, names: names, colours: colours }
  }
  Lanes.prototype.paint = function () {
    if (!this.mount || !this.nodes) return
    var self = this
    var sc = this.scale()
    this.sc = sc
    var W = sc.width
    var colour = this.colour || (shared.colour && shared.colour())
    var problems = 0
    var bands = 0
    var dense = this.dense()
    var H = dense ? DENSE_H : LANE_H
    this.mount.classList.toggle('is-density', dense)
    this.dens = dense ? this.binned(sc, colour) : null
    var html = this.nodes
      .map(function (n, ni) {
        var svg = ''
        if (self.band && !n.heading) {
          var spans = safe(function () { return self.band(n) }, []) || []
          for (var s = 0; s < spans.length; s++) {
            var a = Math.max(0, sc.x(spans[s][0]))
            var b = Math.min(W, sc.x(spans[s][1]))
            if (b > a) {
              bands++
              if (self.on('band')) svg += '<rect class="thimble-lane-band" x="' + a.toFixed(1) + '" y="4" width="' + (b - a).toFixed(1) + '" height="' + (H - 8) + '"/>'
            }
          }
        }
        var its = n.items || []
        if (self.dens) {
          // Density: a bar per bin, its values stacked in the chips' order, a bin with a failure underlined in red
          var d = self.dens
          var room = H - 6
          d.per[ni].forEach(function (bin, bi) {
            var bx0 = Math.max(0, sc.x(d.bins[bi][0]))
            var bx1 = Math.min(W, sc.x(d.bins[bi][1]))
            if (bx1 <= bx0) return
            var bw = Math.max(1, bx1 - bx0 - (bx1 - bx0 > 3 ? 1 : 0))
            var hh = Math.max(1, (bin.total / d.max) * room)
            var yy = H - 2
            for (var k = 0; k < d.K; k++) {
              if (!bin.n[k]) continue
              var sh = (hh * bin.n[k]) / bin.total
              yy -= sh
              svg += '<rect class="thimble-lane-mark thimble-lane-bar" x="' + bx0.toFixed(2) + '" y="' + yy.toFixed(2) + '" width="' + bw.toFixed(2) + '" height="' + sh.toFixed(2) + '"' + (d.colours[k] ? ' style="fill:' + esc(d.colours[k]) + '"' : '') + '/>'
            }
            if (bin.bad) {
              problems += bin.bad
              if (self.on('problem')) svg += '<rect class="thimble-lane-bad" x="' + bx0.toFixed(2) + '" y="' + (H - 2) + '" width="' + Math.max(2, bw).toFixed(2) + '" height="2"/>'
            }
          })
          its = []
        }
        for (var i = 0; i < its.length; i++) {
          var it = its[i]
          var t = self.time(it)
          var e = self.end ? safe(function () { return self.end(it) }, t) : t
          if (e < sc.from || t > sc.to) continue
          if (colour && !colour.keeps(it)) continue
          var x = sc.x(Math.max(t, sc.from))
          var w = Math.max(MARK_MIN, sc.x(Math.min(e, sc.to)) - x)
          var c = colour ? colour.colourOf(colour.valueOf(it)) : null
          svg += '<rect class="thimble-lane-mark" data-i="' + i + '" x="' + x.toFixed(1) + '" y="3" width="' + w.toFixed(1) + '" height="' + (LANE_H - 6) + '"' + (c ? ' style="fill:' + esc(c) + '"' : '') + '/>'
          if (self.problem && safe(function () { return self.problem(it) }, false)) {
            problems++
            if (self.on('problem')) svg += '<rect class="thimble-lane-bad" x="' + x.toFixed(1) + '" y="' + (LANE_H - 2) + '" width="' + Math.max(4, w).toFixed(1) + '" height="2"/>'
          }
        }
        var anchor = typeof self.opts.anchor === 'function' ? safe(function () { return self.opts.anchor(n) }, null) : null
        var fold = n.children ? '<button type="button" class="thimble-lane-fold" data-fold="' + esc(n.key) + '" aria-expanded="' + !n.folded + '" aria-label="' + esc((n.folded ? 'Show the lanes under ' : 'Fold the lanes under ') + n.name) + '">' + (n.folded ? '▸' : '▾') + '</button>' : '<span class="thimble-lane-fold-gap"></span>'
        return (
          '<div class="thimble-lane' + (n.heading ? ' is-heading' : '') + (self.chosen === String(n.key) ? ' is-chosen' : '') + '" data-key="' + esc(n.key) + '"' + (anchor ? ' data-anchor="' + esc(anchor) + '" data-anchor-unmarked' : '') + '>' +
          '<div class="thimble-lane-name" data-pick="' + esc(n.key) + '" title="' + esc(n.name) + '">' + guideHtml(n.guide) + fold + '<span class="thimble-lane-nm">' + esc(n.name) + '</span></div>' +
          '<svg class="thimble-lane-track" width="' + W + '" height="' + H + '">' + svg + '</svg></div>'
        )
      })
      .join('')
    this.body.innerHTML = html
    this.body.classList.toggle('has-tree', this.nodes.some(function (n) { return n.children > 0 || n.depth > 0 }))
    this.body.appendChild(this.spanEl)
    this.body.appendChild(this.cursorEl)
    this.cursorEl.style.display = 'none'
    // the key: each series the lanes draw beside Color by's, when it shows at all
    var entries = []
    if (this.band) entries.push({ id: 'band', name: this.words.band, mark: 'band', n: bands, count: false })
    if (this.problem) entries.push({ id: 'problem', name: this.words.problem, mark: 'problem', n: problems })
    if (this.key) {
      var sig = JSON.stringify(entries)
      if (sig !== this.keySig) {
        this.keySig = sig
        this.key.set(entries)
      }
    }
    this.placeSpan()
  }
  // the detail list's rows in view, as a tint across the lanes, and on the range's overview where it marks them
  Lanes.prototype.visible = function (t0, t1) {
    this.span = t0 == null || t1 == null ? null : [Math.min(t0, t1), Math.max(t0, t1)]
    this.placeSpan()
    if (this.range && typeof this.range.visible === 'function') {
      var r = this.range
      var sp = this.span
      safe(function () {
        if (sp) r.visible(sp[0], sp[1])
        else r.visible(null)
      })
    }
  }
  Lanes.prototype.placeSpan = function () {
    var sc = this.sc
    if (!sc || !this.span || !this.nodes.length) {
      this.spanEl.style.display = 'none'
      return
    }
    var a = clamp(sc.x(Math.max(this.span[0], sc.from)), 0, sc.width)
    var b = clamp(sc.x(Math.min(this.span[1], sc.to)), 0, sc.width)
    if (this.span[1] < sc.from || this.span[0] > sc.to) {
      this.spanEl.style.display = 'none'
      return
    }
    if (b - a < 2) {
      var m = (a + b) / 2
      a = m - 1
      b = m + 1
    }
    this.spanEl.style.display = 'block'
    this.spanEl.style.left = this.namesW + a + 'px'
    this.spanEl.style.width = b - a + 'px'
    this.spanEl.style.height = this.body.scrollHeight + 'px'
  }
  // the list's rows that carry data-t and stand in its box: their first and last times, told as the list scrolls,
  // resizes or is drawn again
  Lanes.prototype.follow = function (list) {
    var box = el(list)
    if (!box) return
    var self = this
    var frame = null
    var go = function () {
      frame = null
      var rows = box.querySelectorAll('[data-t]')
      if (!rows.length) return self.visible(null)
      var r = box.getBoundingClientRect()
      var top = r.top
      var bottom = r.bottom
      // the first row whose bottom is below the box's top, and the last whose top is above its bottom
      var lo = 0
      var hi = rows.length - 1
      while (lo < hi) {
        var mid = (lo + hi) >> 1
        if (rows[mid].getBoundingClientRect().bottom <= top) lo = mid + 1
        else hi = mid
      }
      var first = lo
      lo = first
      hi = rows.length - 1
      while (lo < hi) {
        var md = (lo + hi + 1) >> 1
        if (rows[md].getBoundingClientRect().top < bottom) lo = md
        else hi = md - 1
      }
      var last = lo
      var t0 = Number(rows[first].getAttribute('data-t'))
      var t1 = Number(rows[last].getAttribute('data-t'))
      if (!isFinite(t0) || !isFinite(t1) || rows[first].getBoundingClientRect().top >= bottom) return self.visible(null)
      self.visible(t0, t1)
    }
    var soon = function () {
      if (frame == null) frame = requestAnimationFrame(go)
    }
    box.addEventListener('scroll', soon, { passive: true })
    if (typeof ResizeObserver === 'function') new ResizeObserver(soon).observe(box)
    new MutationObserver(soon).observe(box, { childList: true, subtree: true })
    soon()
  }
  Lanes.prototype.laneAt = function (e) {
    var row = e.target.closest && e.target.closest('.thimble-lane')
    if (!row) return null
    var key = row.getAttribute('data-key')
    for (var i = 0; i < this.nodes.length; i++) if (String(this.nodes[i].key) === key) return { node: this.nodes[i], row: row }
    return null
  }
  // the record of a lane nearest the pointer's x, within HIT px of its mark
  Lanes.prototype.itemAt = function (node, x) {
    var sc = this.sc
    var colour = this.colour || (shared.colour && shared.colour())
    var best = null
    var bd = Infinity
    var its = node.items || []
    for (var i = 0; i < its.length; i++) {
      var it = its[i]
      if (colour && !colour.keeps(it)) continue
      var t = this.time(it)
      var e = this.end ? safe(function () { return this.end(it) }.bind(this), t) : t
      if (e < sc.from || t > sc.to) continue
      var x0 = sc.x(Math.max(t, sc.from))
      var x1 = Math.max(x0 + MARK_MIN, sc.x(Math.min(e, sc.to)))
      var d = x < x0 ? x0 - x : x > x1 ? x - x1 : 0
      if (d <= HIT && d < bd) {
        best = it
        bd = d
      }
    }
    return best
  }
  // Density: the bin of a lane under the pointer's x, {bin, t0, t1}, or null where the lane has no record there
  Lanes.prototype.binAt = function (node, x) {
    var d = this.dens
    if (!d || !this.sc) return null
    var ni = this.nodes.indexOf(node)
    var b = d.of(this.sc.t(x))
    var bin = ni >= 0 && b >= 0 ? d.per[ni].get(b) : null
    return bin ? { bin: bin, t0: d.bins[b][0], t1: d.bins[b][1] } : null
  }
  Lanes.prototype.when = function (t) {
    return this.range && typeof this.range.format === 'function' ? this.range.format(t) : new Date(t * 1000).toISOString().slice(11, 19)
  }
  Lanes.prototype.hover = function (e) {
    var at = this.laneAt(e)
    var br = this.body.getBoundingClientRect()
    var x = e.clientX - br.left - this.namesW
    if (!at || x < 0 || !this.sc) return this.unhover()
    // a thin cursor line across the lanes at the pointer, never a band over the marks
    this.cursorEl.style.display = 'block'
    this.cursorEl.style.left = this.namesW + Math.round(x) + 'px'
    this.cursorEl.style.height = this.body.scrollHeight + 'px'
    var t = this.sc.t(x)
    var rr = at.row.getBoundingClientRect()
    var html
    if (this.dens) {
      // Density: the bin's time, its records, and how many take each value, in the chips' colours
      var hit = this.binAt(at.node, x)
      html = '<div class="thimble-tip-h">' + esc(at.node.name) + ' · ' + esc(hit ? this.when(hit.t0) + '–' + this.when(hit.t1) : this.when(t)) + '</div>'
      if (hit) {
        var d = this.dens
        var bin = hit.bin
        html += '<div class="thimble-tip-m">' + num(bin.total) + (bin.total === 1 ? ' record' : ' records') + '</div>'
        if (d.K > 1)
          for (var k = 0; k < d.K; k++)
            if (bin.n[k]) html += '<div class="thimble-tip-m thimble-lanes-row"><span class="chip-sw"' + (d.colours[k] ? ' style="--c:' + esc(d.colours[k]) + '"' : '') + '></span><span class="thimble-lanes-rn">' + esc(d.names[k]) + '</span><span class="thimble-lanes-rc">' + num(bin.n[k]) + '</span></div>'
        if (bin.bad) html += '<div class="thimble-tip-m thimble-lanes-bad">' + num(bin.bad) + ' ' + esc(this.words.problem) + '</div>'
      }
      return tip(html, e.clientX, rr.bottom, 'under', rr.top)
    }
    var it = this.itemAt(at.node, x)
    html = '<div class="thimble-tip-h">' + esc(at.node.name) + ' · ' + esc(this.when(t)) + '</div>'
    if (it) {
      var words = typeof this.opts.tip === 'function' ? safe(function () { return this.opts.tip(it) }.bind(this), '') : it.text || it.name || ''
      if (words) html += '<div class="thimble-tip-m">' + esc(String(words).slice(0, 200)) + '</div>'
      if (this.problem && safe(function () { return this.problem(it) }.bind(this), false)) html += '<div class="thimble-tip-m thimble-lanes-bad">' + esc(this.words.problem) + '</div>'
    }
    tip(html, e.clientX, rr.bottom, 'under', rr.top)
  }
  Lanes.prototype.unhover = function () {
    if (this.cursorEl) this.cursorEl.style.display = 'none'
    untip()
  }
  Lanes.prototype.click = function (e) {
    var fold = e.target.closest && e.target.closest('[data-fold]')
    if (fold) {
      var k = fold.getAttribute('data-fold')
      var f = this.folded().slice()
      var at = f.indexOf(k)
      if (at >= 0) f.splice(at, 1)
      else f.push(k)
      kept(this.name).folded = f
      save()
      this.draw()
      return
    }
    var lane = this.laneAt(e)
    if (!lane) return
    if (e.target.closest('[data-pick]')) {
      this.choose(String(lane.node.key))
      if (typeof this.opts.onPick === 'function') {
        var n = lane.node
        var self = this
        safe(function () { self.opts.onPick(n) })
      }
      return
    }
    var br = this.body.getBoundingClientRect()
    var x = e.clientX - br.left - this.namesW
    // a mark's record, or in Density the first record of the bin
    var hit = this.dens ? this.binAt(lane.node, x) : null
    var it = this.dens ? hit && hit.bin.first : this.itemAt(lane.node, x)
    if (it && typeof this.opts.onMark === 'function') {
      var o = this.opts
      safe(function () { o.onMark(it) })
    }
  }
  Lanes.prototype.choose = function (key) {
    this.chosen = key == null ? null : String(key)
    var rows = this.body.querySelectorAll('.thimble-lane')
    for (var i = 0; i < rows.length; i++) rows[i].classList.toggle('is-chosen', rows[i].getAttribute('data-key') === this.chosen)
  }
  function lanesApi(l) {
    return {
      /** draw the lanes with these records (those of the range the page shows) */
      draw: function (items) {
        l.draw(items)
      },
      /** the lanes as last drawn: [{key, name, depth, guide, heading, folded, items}] */
      get lanes() {
        return l.nodes.slice()
      },
      /** the chosen lane's key, or null */
      get chosen() {
        return l.chosen
      },
      choose: function (key) {
        l.choose(key)
      },
      /** mark the detail list's rows in view, from t0 to t1; visible(null) clears it */
      visible: function (t0, t1) {
        l.visible(t0, t1)
      },
      /** whether a series of the key shows: 'band' or 'problem' */
      isOn: function (series) {
        return l.on(series)
      },
      /** the scale the lanes drew on */
      get scale() {
        return l.sc || null
      },
    }
  }
  /** lanes on the time range's scale (see above) */
  thimble.lanes = function (opts) {
    var l = new Lanes(opts || {})
    l.api = lanesApi(l)
    return l.api
  }

  // ---------------------------------------------------------------- the divider
  // A bar between the overview (`top`) and the detail list under it: a drag moves it, ↑ ↓ move it when it has the focus,
  // a double click or Home puts it back. The overview's box takes the height the bar leaves it and scrolls inside it;
  // thimble keeps the place per view, as a share of the box they share.
  function Divider(opts) {
    var self = this
    this.top = el(opts.top)
    this.name = 'divider:' + (opts.key || (this.top && this.top.id) || 'overview')
    this.min = Number(opts.min) > 0 ? Number(opts.min) : 48
    this.onChange = typeof opts.onChange === 'function' ? opts.onChange : null
    if (!this.top || !this.top.parentElement) return
    this.bar = document.createElement('div')
    this.bar.className = 'thimble-divider thimble-part'
    this.bar.setAttribute('role', 'separator')
    this.bar.setAttribute('aria-orientation', 'horizontal')
    this.bar.setAttribute('aria-label', 'Resize the overview')
    this.bar.setAttribute('tabindex', '0')
    this.bar.setAttribute('data-thimble-chrome', '')
    this.bar.innerHTML = '<span></span>'
    this.top.insertAdjacentElement('afterend', this.bar)
    this.bar.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return
      e.preventDefault()
      self.drag = { y: e.clientY, h: self.top.getBoundingClientRect().height }
      self.bar.setPointerCapture && self.bar.setPointerCapture(e.pointerId)
      self.bar.setAttribute('data-drag', '')
    })
    this.bar.addEventListener('pointermove', function (e) {
      if (!self.drag) return
      self.set(self.drag.h + e.clientY - self.drag.y)
    })
    var up = function () {
      if (!self.drag) return
      self.drag = null
      self.bar.removeAttribute('data-drag')
      self.keep()
    }
    this.bar.addEventListener('pointerup', up)
    this.bar.addEventListener('pointercancel', up)
    this.bar.addEventListener('dblclick', function () {
      self.reset()
    })
    this.bar.addEventListener('keydown', function (e) {
      var h = self.top.getBoundingClientRect().height
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault()
        self.set(h + (e.key === 'ArrowUp' ? -1 : 1) * (e.shiftKey ? 64 : 16))
        self.keep()
      } else if (e.key === 'Home') {
        e.preventDefault()
        self.reset()
      }
    })
    var share = kept(this.name).share
    if (typeof share === 'number' && share > 0 && share < 1) {
      var apply = function () {
        self.set(share * self.room())
      }
      if (this.room() > 0) apply()
      else requestAnimationFrame(apply)
    }
    if (typeof ResizeObserver === 'function') {
      var hh = -1
      new ResizeObserver(function () {
        var s = kept(self.name).share
        var room = self.room()
        if (typeof s !== 'number' || room === hh) return
        hh = room
        self.set(s * room)
      }).observe(this.top.parentElement)
    }
  }
  // the height the overview and the list share
  Divider.prototype.room = function () {
    var p = this.top.parentElement
    var used = 0
    for (var i = 0; i < p.children.length; i++) {
      var c = p.children[i]
      if (c === this.top || c === this.bar || getComputedStyle(c).position === 'absolute' || getComputedStyle(c).position === 'fixed') continue
      if (c.compareDocumentPosition(this.bar) & Node.DOCUMENT_POSITION_FOLLOWING) used += c.getBoundingClientRect().height
    }
    return Math.max(0, p.clientHeight - used - this.bar.offsetHeight)
  }
  Divider.prototype.set = function (h) {
    var room = this.room()
    h = clamp(h, Math.min(this.min, room), Math.max(this.min, room - this.min))
    this.top.style.flex = 'none'
    this.top.style.height = Math.round(h) + 'px'
    this.top.style.maxHeight = 'none'
    this.top.style.overflow = 'auto'
    var self = this
    if (this.onChange) safe(function () { self.onChange(Math.round(h)) })
  }
  Divider.prototype.keep = function () {
    var room = this.room()
    if (room <= 0) return
    kept(this.name).share = Math.round((this.top.getBoundingClientRect().height / room) * 1000) / 1000
    save()
  }
  Divider.prototype.reset = function () {
    delete kept(this.name).share
    save()
    this.top.style.flex = ''
    this.top.style.height = ''
    this.top.style.maxHeight = ''
    this.top.style.overflow = ''
    var self = this
    if (this.onChange) safe(function () { self.onChange(Math.round(self.top.getBoundingClientRect().height)) })
  }
  /** a bar between the overview and the detail list that a drag moves (see above) */
  thimble.divider = function (opts) {
    var d = new Divider(opts || {})
    return {
      get height() {
        return d.top ? Math.round(d.top.getBoundingClientRect().height) : 0
      },
      set: function (px) {
        if (!d.top) return
        d.set(px)
        d.keep()
      },
      reset: function () {
        if (d.top) d.reset()
      },
    }
  }

  // what viewer_side.js and viewer_transcript.js share of this file
  shared.controls = { kept: kept, save: save, closeMenu: closeMenu, el: el, safe: safe, keyOf: keyOf, NONE: NONE }
})()
