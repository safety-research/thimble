// thimble's table for a view's page, part of the view kit: views.frame_document loads it after viewer_search.js and
// before viewer_range.js; viewer_kit.css styles it. A table of records with columns a click sorts, as the kit's .table
// looks (a caps header, hairline rows), for thousands of rows: it draws only the rows near its view and keeps those it
// drew as it scrolls.
//
//   const table = thimble.table({
//     mount: '#list',                       the element the table fills and scrolls in; the page gives it a height
//     columns: [
//       { name: 'from', title: 'From', width: 180 },
//       { name: 'subject', title: 'Subject' },               text takes the width left, cut with an ellipsis
//       { name: 't', title: 'Date', type: 'time' },          seconds since 1970, shown in UTC; or 'number'
//     ],
//     rows: emails,                         plain records, each with its `ref`, which is its row's data-anchor
//     sort: { by: 't', desc: true },        how it opens; a click on a column's head sorts by it, again the other way
//     side, details: (m) => ({ title: m.subject, sub: m.from, html: body(m) }),   a row opens in thimble.side
//     search, filter,                       a thimble.search finds in its rows, a thimble.filterBy hides rows
//   })
//   table.set(rows)                         new rows, such as after a fetch; table.draw() after Filter by changed
//
// Each row is a record: its data-anchor is its ref, so a label marks it, a ⌘-click asks about it and a citation reveals
// it (table.reveal(ref)), and with the page's Color by its value's colour is the bar on its left edge; the list's strip
// shows the colours of every row, scrolled to or not, and the chips count the rows. A click or Enter opens a row in the
// side panel (`details`, by default its columns), ↑ and ↓ move the chosen row. thimble keeps the sort per view, and
// Reset puts back the one it opens with.
;(function () {
  'use strict'
  var kit = window.__thimbleKit
  if (!kit || !window.thimble || !kit.shared || !kit.shared.controls) return
  var thimble = window.thimble
  var shared = kit.shared
  var ctl = shared.controls
  var esc = shared.esc
  var num = shared.num

  var OVER = 12 // rows drawn above and below the view, so a scroll shows drawn rows
  var ROW = 28 // px, a row's height when the theme gives no --h-row
  var CHAR = 7 // px, a character of the mono face when it cannot be measured
  var PAD = 16 // px, a cell's padding, both sides
  var SORT_ROOM = 14 // px, the sort's arrow beside a head's title
  var MIN_W = 56 // px, the narrowest column of numbers or times, and the widest
  var MAX_W = 260
  var SAMPLE = 2000 // rows read to fit a column of numbers or times to its values
  var collator = typeof Intl !== 'undefined' ? new Intl.Collator('en', { numeric: true, sensitivity: 'base' }) : null
  var ARROW = {
    up: '<svg class="thimble-colour-ico thimble-table-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
    down: '<svg class="thimble-colour-ico thimble-table-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n
  }
  // a time as the kit writes it: seconds since 1970 as YYYY-MM-DD HH:MM in UTC, with the seconds in a column whose times
  // have them (`secs`); a string as written
  function stamp(v, secs) {
    if (typeof v !== 'number' || !isFinite(v)) return v == null ? '' : String(v)
    var d = new Date(v * 1000)
    var s = d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes())
    return secs ? s + ':' + pad2(d.getUTCSeconds()) : s
  }
  // markup's text, for the search of a column drawn as html
  function textOfHtml(h) {
    return String(h)
      .replace(/<[^>]*>/g, '')
      .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, function (m, e) {
        return { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }[e]
      })
  }
  function cmp(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return a - b
    a = String(a)
    b = String(b)
    return collator ? collator.compare(a, b) : a < b ? -1 : a > b ? 1 : 0
  }
  function empty(v) {
    return v == null || v === '' || (typeof v === 'number' && !isFinite(v))
  }

  var HOSTED = typeof WeakMap === 'function' ? new WeakMap() : null // a mount -> the table it holds, which a new one there retires

  function Table(opts) {
    var self = this
    this.mount = ctl.el(opts.mount)
    this.dead = false
    this.name = 'table:' + (opts.key || (this.mount && this.mount.id) || 'table')
    this.columns = (Array.isArray(opts.columns) ? opts.columns : [])
      .filter(function (c) {
        return c && (typeof c === 'string' || typeof c.name === 'string')
      })
      .map(function (c) {
        if (typeof c === 'string') c = { name: c }
        var type = c.type === 'number' || c.type === 'time' ? c.type : 'text'
        return {
          name: String(c.name),
          title: String(c.title == null ? c.name : c.title),
          type: type,
          width: c.width,
          value: typeof c.value === 'function' ? c.value : null,
          html: typeof c.html === 'function' ? c.html : null,
          sorts: c.sort !== false,
        }
      })
    this.all = Array.isArray(opts.rows) ? opts.rows : []
    this.initial = this.sortOf(opts.sort)
    var kept = ctl.kept(this.name).sort
    this.sort = (kept && this.sortOf(kept)) || this.initial
    this.side = opts.side || null
    this.details = typeof opts.details === 'function' ? opts.details : null
    this.search = opts.search || null
    this.filter = opts.filter || null
    this.onOpen = typeof opts.onOpen === 'function' ? opts.onOpen : null
    this.refOf = function (r) {
      return r && r.ref != null ? String(r.ref) : null
    }
    this.shown = []
    this.drawn = new Map() // row index -> its element, the rows near the view
    this.chosen = null // the chosen row's record
    this.colourKey = ''
    if (!this.mount) return
    // a table made again on the same mount takes its place: the one before hears nothing more
    var before = HOSTED && HOSTED.get(this.mount)
    if (before) before.retire()
    if (HOSTED) HOSTED.set(this.mount, this)
    this.mount.classList.add('thimble-table-host')
    if (!this.mount.hasAttribute('tabindex')) this.mount.tabIndex = 0
    this.mount.innerHTML =
      '<div class="thimble-table" role="grid"><div class="thimble-table-head thimble-part" role="row" data-thimble-chrome></div>' +
      '<div class="thimble-table-body" role="rowgroup"></div><div class="thimble-table-none" hidden></div></div>'
    this.root = this.mount.firstChild
    this.head = this.root.children[0]
    this.body = this.root.children[1]
    this.none = this.root.children[2]
    this.rowH = parseFloat(getComputedStyle(this.mount).getPropertyValue('--h-row')) || ROW
    this.root.style.setProperty('--thimble-table-row', this.rowH + 'px')
    this.head.addEventListener('click', function (e) {
      var th = e.target.closest && e.target.closest('[data-col]')
      if (th) self.sortBy(th.getAttribute('data-col'))
    })
    this.head.addEventListener('keydown', function (e) {
      var th = e.target.closest && e.target.closest('[data-col]')
      if (!th || (e.key !== 'Enter' && e.key !== ' ')) return
      e.preventDefault()
      self.sortBy(th.getAttribute('data-col'))
      var again = self.head.querySelector('[data-col="' + th.getAttribute('data-col').replace(/["\\]/g, '\\$&') + '"]')
      if (again) again.focus()
    })
    this.body.addEventListener('click', function (e) {
      if (e.metaKey || e.ctrlKey || (e.target.closest && e.target.closest('a,button,input,select,textarea'))) return
      var row = e.target.closest && e.target.closest('.thimble-table-row')
      if (row) self.open(Number(row.getAttribute('data-thimble-row')))
    })
    this.mount.addEventListener('keydown', function (e) {
      if (e.target !== self.mount) return
      var n = self.shown.length
      if (!n) return
      var at = self.place(self.chosen)
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        var to = at < 0 ? self.firstInView() : Math.max(0, Math.min(n - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))
        self.choose(to)
        self.scrollTo(to, true)
      } else if (e.key === 'Enter' && at >= 0) {
        e.preventDefault()
        self.open(at)
      }
    })
    var frame = null
    this.mount.addEventListener(
      'scroll',
      function () {
        if (frame != null) return
        frame = requestAnimationFrame(function () {
          frame = null
          if (!self.dead) self.window()
        })
      },
      { passive: true },
    )
    if (typeof ResizeObserver === 'function') {
      var h = -1
      this.resized = new ResizeObserver(function () {
        if (self.dead || self.mount.clientHeight === h) return
        h = self.mount.clientHeight
        self.window()
      }).observe(this.mount)
    }
    // Color by changed: the rows' bars, the chips' counts and the strip's colours drawn again
    shared.onColour(function () {
      if (!self.dead && self.colourSig() !== self.colourKey) self.recolour(true)
    })
    // a label colored by reaches the rows as they come into view: the strip's colours follow
    var marksFrame = null
    thimble.onMarks(function () {
      var c = shared.colour()
      if (self.dead || !c || !c.label || marksFrame != null) return
      marksFrame = requestAnimationFrame(function () {
        marksFrame = null
        self.colourStrip()
      })
    })
    // the columns of numbers and times fitted again once the page's faces have loaded, which are wider than the fallback
    if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function')
      document.fonts.ready.then(function () {
        if (!self.dead) self.layout()
      })
    // Reset puts back the sort the table opens with
    this.checkReset = shared.part({
      changed: function () {
        return !self.dead && !self.sameSort(self.sort, self.initial)
      },
      reset: function () {
        delete ctl.kept(self.name).sort
        ctl.save()
        self.sort = self.initial
        self.draw()
      },
    })
    this.draw()
  }
  // the table made again on its mount: it hears nothing more and draws nothing more
  Table.prototype.retire = function () {
    this.dead = true
    if (this.resized) this.resized.disconnect()
  }
  // a sort as given, {by, desc}, for a column that sorts; null for none
  Table.prototype.sortOf = function (s) {
    if (!s) return null
    if (typeof s === 'string') s = { by: s }
    var col = this.col(s.by)
    return col && col.sorts ? { by: col.name, desc: !!s.desc } : null
  }
  Table.prototype.sameSort = function (a, b) {
    return (!a && !b) || (!!a && !!b && a.by === b.by && a.desc === b.desc)
  }
  Table.prototype.col = function (name) {
    for (var i = 0; i < this.columns.length; i++) if (this.columns[i].name === name) return this.columns[i]
    return null
  }
  Table.prototype.value = function (col, r) {
    if (r == null) return null
    var v = col.value ? ctl.safe(function () { return col.value(r) }, null) : typeof r === 'object' ? r[col.name] : null
    return v
  }
  // what a cell shows, as text
  Table.prototype.text = function (col, r) {
    if (col.html) return textOfHtml(ctl.safe(function () { return col.html(r) }, ''))
    var v = this.value(col, r)
    if (empty(v)) return ''
    if (col.type === 'time') return stamp(v, col.secs)
    if (col.type === 'number' && typeof v === 'number') return num(v)
    return typeof v === 'object' ? JSON.stringify(v) : String(v)
  }
  Table.prototype.cell = function (col, r) {
    if (col.html) return String(ctl.safe(function () { return col.html(r) }, '') || '')
    return esc(this.text(col, r))
  }
  // the columns' widths: a column's own, else for numbers and times as wide as their widest value or title, else an
  // equal share of what is left
  Table.prototype.layout = function () {
    var self = this
    var charW = measureChar(this.mount) || CHAR
    var sample = this.all.length > SAMPLE ? this.all.slice(0, SAMPLE) : this.all
    // a column of times shows their seconds when one of them has any, so that every time in it reads alike
    this.columns.forEach(function (c) {
      if (c.type !== 'time') return
      c.secs = false
      for (var i = 0; i < self.all.length && !c.secs; i++) {
        var v = self.value(c, self.all[i])
        c.secs = typeof v === 'number' && isFinite(v) && Math.floor(v) % 60 !== 0
      }
    })
    var tracks = this.columns.map(function (c) {
      if (typeof c.width === 'number' && c.width > 0) return c.width + 'px'
      if (typeof c.width === 'string' && c.width) return c.width
      if (c.type === 'text') return 'minmax(0, 1fr)'
      var most = 0
      for (var i = 0; i < sample.length; i++) most = Math.max(most, self.text(c, sample[i]).length)
      var w = Math.max(most * charW + PAD, c.title.length * charW + PAD + SORT_ROOM)
      return Math.round(Math.max(MIN_W, Math.min(MAX_W, w))) + 'px'
    })
    this.root.style.setProperty('--thimble-table-cols', tracks.join(' '))
  }
  Table.prototype.drawHead = function () {
    var s = this.sort
    this.head.innerHTML = this.columns
      .map(function (c) {
        var on = s && s.by === c.name
        var sort = on ? (s.desc ? 'descending' : 'ascending') : 'none'
        return (
          '<div class="thimble-table-th thimble-table-' + c.type + (on ? ' active' : '') + '" role="columnheader" aria-sort="' + sort + '"' +
          (c.sorts ? ' data-col="' + esc(c.name) + '" tabindex="0" title="Sort by ' + esc(c.title) + '"' : '') + '>' +
          '<span class="thimble-table-title">' + esc(c.title) + '</span>' + (on ? (s.desc ? ARROW.down : ARROW.up) : '') + '</div>'
        )
      })
      .join('')
  }
  // a click on a column's head: sorted by it, numbers and times the largest first and text from A; again, the other way
  Table.prototype.sortBy = function (name, desc) {
    var col = this.col(name)
    if (!col || !col.sorts) return
    var s = this.sort
    if (desc === undefined) desc = s && s.by === name ? !s.desc : col.type !== 'text'
    this.sort = { by: name, desc: !!desc }
    ctl.kept(this.name).sort = this.sort
    ctl.save()
    this.draw()
    if (this.checkReset) this.checkReset()
  }
  // the rows that show, in order: those Filter by keeps, sorted, the rows with no value last either way
  Table.prototype.order = function () {
    var self = this
    var rows = this.all
    if (this.filter && typeof this.filter.keeps === 'function') {
      var f = this.filter
      rows = rows.filter(function (r) {
        return ctl.safe(function () { return f.keeps(r) }, true)
      })
    }
    var s = this.sort
    var col = s && this.col(s.by)
    if (!col) return rows.slice()
    var keyed = rows.map(function (r, i) {
      var v = self.value(col, r)
      return [empty(v) ? null : col.type === 'number' && typeof v === 'string' && v.trim() !== '' && isFinite(+v) ? +v : v, i, r]
    })
    var dir = s.desc ? -1 : 1
    keyed.sort(function (a, b) {
      if (a[0] == null || b[0] == null) return a[0] == null && b[0] == null ? a[1] - b[1] : a[0] == null ? 1 : -1
      return dir * cmp(a[0], b[0]) || a[1] - b[1]
    })
    return keyed.map(function (k) {
      return k[2]
    })
  }
  // what Color by draws, but not how many each value has: the rows are drawn again only when it changes
  Table.prototype.colourSig = function () {
    var c = shared.colour()
    if (!c) return ''
    return JSON.stringify([c.picks, c.values.map(function (v) { return [v.value, v.colour, v.on] })])
  }
  // Everything drawn again: the head, the rows that show and those near the view, the chips' counts, the strip and the
  // search's rows
  Table.prototype.draw = function () {
    if (!this.mount || this.dead) return
    var self = this
    this.shown = this.order()
    this.layout()
    this.drawHead()
    this.body.style.height = this.shown.length * this.rowH + 'px'
    this.none.hidden = this.shown.length > 0
    this.none.textContent = this.all.length ? 'Filter by hides every row' : 'No rows'
    this.recolour(false)
    if (this.search && typeof this.search.rows === 'function') {
      var cols = this.columns
      this.search.rows({
        texts: this.shown.map(function (r) {
          return cols
            .map(function (col) {
              return self.text(col, r)
            })
            .join('\n')
        }),
        refs: this.shown.map(this.refOf),
        go: function (i) {
          self.scrollTo(i, true)
        },
        box: this.mount,
      })
    }
    this.window()
  }
  // What Color by draws, drawn again: the chips count the rows while a field is the colour (a label's values reach only
  // the rows drawn), the strip shows every row's colour, and the rows near the view are drawn anew with their bars
  Table.prototype.recolour = function (rows) {
    var c = shared.colour()
    this.colourKey = this.colourSig()
    if (c && c.field) {
      var counts = {}
      for (var i = 0; i < this.shown.length; i++) {
        var v = c.valueOf(this.shown[i])
        var k = v == null ? '' : v
        counts[k] = (counts[k] || 0) + 1
      }
      c.counts(counts)
    }
    this.colourStrip()
    this.drawn.forEach(function (el) {
      el.remove()
    })
    this.drawn.clear()
    if (rows) this.window()
  }
  // the strip: every row's Color by value, ref and record, and what the loupe says of it
  Table.prototype.colourStrip = function () {
    var self = this
    var c = shared.colour()
    var timeCol = null
    var textCols = []
    this.columns.forEach(function (col) {
      if (col.type === 'time' && !timeCol) timeCol = col
      else if (col.type === 'text' && textCols.length < 2) textCols.push(col)
    })
    shared.strip(this.mount, {
      rows: this.shown.map(function (r) {
        return c ? c.valueOf(r) : null
      }),
      refs: this.shown.map(this.refOf),
      records: this.shown,
      preview: function (i) {
        var r = self.shown[i]
        return {
          when: timeCol ? self.text(timeCol, r) : '',
          text: textCols
            .map(function (col) {
              return self.text(col, r)
            })
            .filter(Boolean)
            .join(' · '),
        }
      },
    })
  }
  // the rows near the view drawn, those that were drawn and still are near kept as they are
  Table.prototype.window = function () {
    if (!this.mount) return
    var n = this.shown.length
    var top = this.mount.scrollTop - this.body.offsetTop
    var h = this.mount.clientHeight || this.rowH * 30
    var a = Math.max(0, Math.floor(top / this.rowH) - OVER)
    var b = Math.min(n, Math.ceil((top + h) / this.rowH) + OVER)
    var self = this
    this.drawn.forEach(function (el, i) {
      if (i < a || i >= b) {
        el.remove()
        self.drawn.delete(i)
      }
    })
    var html = ''
    var add = []
    for (var i = a; i < b; i++) if (!this.drawn.has(i)) {
      add.push(i)
      html += this.rowHtml(i)
    }
    if (!add.length) return
    var tmp = document.createElement('div')
    tmp.innerHTML = html
    for (var j = 0; j < add.length; j++) {
      var el = tmp.firstChild
      this.drawn.set(add[j], el)
      this.body.appendChild(el)
    }
  }
  Table.prototype.rowHtml = function (i) {
    var r = this.shown[i]
    var ref = this.refOf(r)
    var c = shared.colour()
    var self = this
    return (
      '<div class="thimble-table-row' + (this.same(r, this.chosen) ? ' active' : '') + '" role="row" data-thimble-row="' + i + '"' +
      (ref != null ? ' data-anchor="' + esc(ref) + '"' : '') + (c ? c.attr(r) : '') + ' style="top:' + i * this.rowH + 'px">' +
      this.columns
        .map(function (col) {
          return '<div class="thimble-table-td thimble-table-' + col.type + '" role="gridcell">' + self.cell(col, r) + '</div>'
        })
        .join('') +
      '</div>'
    )
  }
  Table.prototype.indexOf = function (ref) {
    if (ref == null) return -1
    for (var i = 0; i < this.shown.length; i++) if (this.refOf(this.shown[i]) === ref) return i
    return -1
  }
  // one record twice: the same object, or two with one ref (the rows given again after a fetch)
  Table.prototype.same = function (a, b) {
    if (a == null || b == null) return false
    var ra = this.refOf(a)
    return a === b || (ra != null && ra === this.refOf(b))
  }
  // where a record shows among the rows, -1 for nowhere
  Table.prototype.place = function (r) {
    if (r == null) return -1
    var ref = this.refOf(r)
    if (ref != null) return this.indexOf(ref)
    return this.shown.indexOf(r)
  }
  Table.prototype.firstInView = function () {
    return Math.max(0, Math.min(this.shown.length - 1, Math.ceil((this.mount.scrollTop - this.body.offsetTop) / this.rowH)))
  }
  // row `i` scrolled into view: in the middle when `middle` or when it was out of view, else just inside the edge
  Table.prototype.scrollTo = function (i, middle) {
    if (i < 0 || i >= this.shown.length) return
    var m = this.mount
    var y = this.body.offsetTop + i * this.rowH
    var headH = this.head.offsetHeight
    var top = m.scrollTop + headH
    var bottom = m.scrollTop + m.clientHeight
    var out = y < top || y + this.rowH > bottom
    if (out && middle) m.scrollTop = y - headH - (m.clientHeight - headH - this.rowH) / 2
    else if (y < top) m.scrollTop = y - headH
    else if (y + this.rowH > bottom) m.scrollTop = y + this.rowH - m.clientHeight
    this.window()
  }
  // the chosen row, marked as the open one is
  Table.prototype.choose = function (i) {
    this.chosen = this.shown[i] || null
    var self = this
    this.drawn.forEach(function (el, k) {
      el.classList.toggle('active', k === i && self.chosen != null)
    })
  }
  // a row opened: chosen, shown in the side panel (its details, or its columns), and the page told
  Table.prototype.open = function (i) {
    var r = this.shown[i]
    if (!r) return
    this.choose(i)
    var self = this
    if (this.side && typeof this.side.open === 'function') {
      var got = this.details ? ctl.safe(function () { return self.details(r) }, null) : null
      var o = got != null && typeof got === 'object' ? got : { html: got == null ? this.fieldsHtml(r) : String(got) }
      var first = this.columns[0]
      this.side.open({
        title: o.title != null ? o.title : first ? this.text(first, r) : '',
        sub: o.sub != null ? o.sub : this.refOf(r) || '',
        ref: this.refOf(r),
        html: o.html,
        render: o.render,
      })
    }
    if (this.onOpen) ctl.safe(function () { self.onOpen(r) })
  }
  // a row's columns as the side panel's list, each value whole
  Table.prototype.fieldsHtml = function (r) {
    var self = this
    return (
      '<dl class="thimble-table-fields">' +
      this.columns
        .map(function (col) {
          return '<dt>' + esc(col.title) + '</dt><dd class="thimble-table-' + col.type + '">' + (col.html ? self.cell(col, r) : esc(self.text(col, r)) || '<span class="thimble-table-dim">—</span>') + '</dd>'
        })
        .join('') +
      '</dl>'
    )
  }
  // a cited row: scrolled to the middle, chosen and highlighted for a moment
  Table.prototype.reveal = function (ref) {
    var i = this.indexOf(ref == null ? null : String(ref))
    if (i < 0) return false
    this.choose(i)
    this.scrollTo(i, true)
    var el = this.drawn.get(i)
    if (el) {
      el.removeAttribute('data-thimble-snap')
      void el.offsetWidth
      el.setAttribute('data-thimble-snap', '')
      setTimeout(function () {
        el.removeAttribute('data-thimble-snap')
      }, 1600)
    }
    return true
  }
  // the width of one character of the table's mono face, 0 when it cannot be measured
  function measureChar(at) {
    var s = document.createElement('span')
    s.className = 'thimble-table-probe'
    s.textContent = '0'.repeat(40)
    at.appendChild(s)
    var w = s.getBoundingClientRect().width / 40
    s.remove()
    return w
  }

  /** a table of records with sortable columns, for thousands of rows (see the top of this file) */
  thimble.table = function (opts) {
    var t = new Table(opts || {})
    return {
      /** new rows, drawn at once; the chosen row and the sort are kept */
      set: function (rows) {
        t.all = Array.isArray(rows) ? rows : []
        t.draw()
      },
      /** drawn again, such as after Filter by changed */
      draw: function () {
        t.draw()
      },
      /** a cited row scrolled to, chosen and highlighted for a moment; false when no row shows it */
      reveal: function (ref) {
        return t.reveal(ref)
      },
      /** a row opened as a click opens it; false when no row shows it */
      open: function (ref) {
        var i = t.indexOf(ref == null ? null : String(ref))
        if (i < 0) return false
        t.scrollTo(i, true)
        t.open(i)
        return true
      },
      /** sorted by a column, the largest first with `desc`; with no `desc` as a click on its head sorts */
      sortBy: function (name, desc) {
        t.sortBy(name, desc)
      },
      /** the rows that show, in order */
      get rows() {
        return t.shown.slice()
      },
      /** the sort, {by, desc}, or null for the rows' own order */
      get sort() {
        return t.sort ? { by: t.sort.by, desc: t.sort.desc } : null
      },
      /** the ref of the chosen row, or null */
      get selected() {
        return t.chosen ? t.refOf(t.chosen) : null
      },
    }
  }
})()
