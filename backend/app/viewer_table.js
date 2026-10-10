// thimble's table for a view's page, part of the view kit: views.frame_document loads it after viewer_search.js and
// before viewer_range.js; viewer_kit.css styles it. A table of records with columns a click sorts, as the kit's .table
// looks (a caps header, hairline rows), for thousands of rows: it draws only the rows near its view and keeps those it
// drew as it scrolls.
//
//   const table = thimble.table({
//     mount: '#list',                       the element the table fills and scrolls in; the page gives it a height
//     columns: [
//       { name: 'from', title: 'From', width: 180, drop: 1 },  the first to drop in a narrow table
//       { name: 'subject', title: 'Subject', min: 200 },     text takes the width left, at least `min`, cut with an ellipsis
//       { name: 'subject', sub: (m) => m.snippet },        a second line under it, in the secondary ink: two-line rows
//       { name: 't', title: 'Date', type: 'time' },          seconds since 1970, shown in UTC; or 'number', or 'id'
//     ],
//     rows: emails,                         plain records, each with its `ref`, which is its row's data-anchor
//     sort: { by: 't', desc: true },        how it opens; a click on a column's head sorts by it, again the other way
//     side, details: (m) => ({ title: m.subject, sub: m.from, html: body(m) }),   a row opens in thimble.side
//     search, filter,                       a thimble.search finds in its rows, a thimble.filterBy hides rows
//     colour,                               the Color by of its bars and strip (or `color`), the page's by default;
//                                           false for none
//     attrs: (r) => ({ 'data-anchor-unmarked': !!r.mix }),   more attributes of a row, as thimble.recordCard takes them
//   })
//   table.draw(rows)                        new rows, such as after a fetch; table.draw() after Filter by changed
//
// Each row is a record: its data-anchor is its ref, so a label marks it, a ⌘-click asks about it and a citation reveals
// it (table.reveal(ref)), and its time in the first column of times is its data-t, so the lanes tint the rows in view
// (thimble.timeline's `follow`); with the page's Color by its value's colour is the bar on its left edge; the list's strip
// shows the colours of every row, scrolled to or not, and the chips count the rows. A click or Enter opens a row in the
// side panel (`details`, by default its columns), ↑ and ↓ move the chosen row, which an open side panel follows.
// thimble keeps the sort per view, and Reset puts back the one it opens with. A table too narrow for its columns, such
// as one beside the side panel, first writes its times shorter, then narrows its columns of text to their `min`, then
// drops columns in `drop` order (with none, the rightmost first, the one the rows are sorted by last, and never the main
// column, the first column of text that takes the width left), and draws them again when the room comes back. A head
// never cuts its title: a column of text with a `width` narrower than its title widens to the title while the table has
// room; in a column narrower than the title it wraps to two lines, and a column keeps the width of its title on two
// lines, with room for the sort's arrow, before it drops.
// A column of numbers writes amounts with thousands separators (12,345) and identifiers as they are (67028): a column of
// `type: 'id'`, and one of numbers whose name or title names an identifier (ID_WORDS), such as an id, a key, a PR, issue
// or line number, or a year, so the search finds an identifier as it is written.
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
  var SUB_ROW = 20 // px a row takes more when a column draws a second line under its value (`sub`)
  var CHAR = 7 // px, a character of the mono face when it cannot be measured
  var PAD = 16 // px, a cell's padding, both sides
  var SORT_ROOM = 15 // px, the sort's arrow beside a head's title and the gap before it
  var MIN_W = 56 // px, the narrowest column of numbers or times, and the widest
  var MAX_W = 260
  var MIN_TEXT = 64 // px, the narrowest a column of text gets in a table too narrow for its columns, unless it says (`min`)
  var MIN_MAIN = 120 // px, the same for the main column, which holds what a row is about
  var EASE_MAIN = 240 // px the main column takes before the other columns give up width; below it, it gives up width with them
  var STAMP = 16 // characters of a time as the kit writes it, YYYY-MM-DD HH:MM; 3 more with the seconds, 5 fewer without the year
  var SAMPLE = 2000 // rows read to fit a column of numbers or times to its values
  var FR = /^\d*\.?\d+fr$/ // a track that shares what is left
  // the last word of a column's name or title that makes its numbers identifiers: `pr_number`, `issueId`, `Year`,
  // `PR #`; a name that ends in another word, such as `lines_added` or `comment_count`, is of amounts
  var ID_WORDS = /^(#|id|ids|uid|uuid|guid|key|pk|no|nr|num|number|pr|issue|ticket|line|lineno|row|turn|step|page|port|index|idx|seq|rev|revision|version|build|pid|code|zip|year)$/
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
    var d = new Date(seconds(v) * 1000)
    var s = d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes())
    return secs ? s + ':' + pad2(d.getUTCSeconds()) : s
  }
  // a time in seconds: one past MS_FROM is read as milliseconds, which no time in seconds reaches before the year 5000
  var MS_FROM = 1e11
  function seconds(v) {
    return Math.abs(v) >= MS_FROM ? v / 1000 : v
  }
  // markup's text, for the search of a column drawn as html
  function textOfHtml(h) {
    return String(h)
      .replace(/<[^>]*>/g, '')
      .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, function (m, e) {
        return { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }[e]
      })
  }
  // the two lines a head's title can wrap to: after a space, or after a slash or a hyphen inside a word, [first, second]
  function twoLines(t) {
    var out = []
    for (var i = 1; i < t.length - 1; i++) {
      var ch = t.charAt(i)
      var at = ch === ' ' ? i : (ch === '/' || ch === '-') && t.charAt(i + 1) !== ' ' ? i + 1 : -1
      if (at < 0) continue
      var a = t.slice(0, at).trim()
      var b = t.slice(at).trim()
      if (a && b) out.push([a, b])
    }
    return out
  }
  // a head's title as markup, free to wrap after a slash or a hyphen inside a word as after a space (twoLines)
  function titleHtml(t) {
    return esc(t).replace(/([/-])(?=\S)/g, '$1<wbr>')
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
  // whether a column's name or title names an identifier (ID_WORDS), its words split at case (an acronym's end too, as
  // in `PRNumber`), punctuation and space
  function idName(s) {
    var words = String(s == null ? '' : s)
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9#]+|(?=#)/)
      .filter(Boolean)
    return words.length > 0 && ID_WORDS.test(words[words.length - 1])
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
        var type = c.type === 'number' || c.type === 'time' ? c.type : c.type === 'id' ? 'number' : 'text'
        var title = String(c.title == null ? c.name : c.title)
        return {
          name: String(c.name),
          title: title,
          type: type,
          // a column of identifiers: its numbers as they are, laid out and sorted as numbers
          plain: c.type === 'id' || (type === 'number' && (idName(c.name) || idName(title))),
          width: c.width,
          value: typeof c.value === 'function' ? c.value : null,
          html: typeof c.html === 'function' ? c.html : null,
          sorts: c.sort !== false,
          drop: c.drop === false ? false : typeof c.drop === 'number' && isFinite(c.drop) ? c.drop : null,
          min: typeof c.min === 'number' && c.min > 0 ? c.min : null,
          sub: typeof c.sub === 'function' ? c.sub : null,
        }
      })
    // the main column: the first column of text that takes the width left (no width in px), else the first column of
    // text; it keeps MIN_MAIN in a narrow table and, without a `drop`, never drops
    this.main = -1
    var firstText = -1
    for (var ci = 0; ci < this.columns.length && this.main < 0; ci++) {
      var cc = this.columns[ci]
      if (cc.type !== 'text') continue
      if (firstText < 0) firstText = ci
      if (!(typeof cc.width === 'number' && cc.width > 0)) this.main = ci
    }
    if (this.main < 0) this.main = firstText
    this.timeCol = null // the first column of times, whose value is a row's data-t
    for (var tc = 0; tc < this.columns.length && !this.timeCol; tc++) if (this.columns[tc].type === 'time') this.timeCol = this.columns[tc]
    this.drawnCols = this.columns // the columns drawn, those that fit the table's width
    this.all = Array.isArray(opts.rows) ? opts.rows : []
    this.initial = this.sortOf(opts.sort)
    var kept = ctl.kept(this.name).sort
    this.sort = (kept && this.sortOf(kept)) || this.initial
    this.side = opts.side || null
    this.details = typeof opts.details === 'function' ? opts.details : null
    this.search = opts.search || null
    this.filter = opts.filter || null
    this.bars = shared.bars(opts)
    this.onOpen = typeof opts.onOpen === 'function' ? opts.onOpen : null
    this.attrs = typeof opts.attrs === 'function' ? opts.attrs : null
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
    // a column with a second line under its value makes every row two lines tall
    if (this.columns.some(function (c) { return c.sub })) this.rowH += SUB_ROW
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
        self.scrollTo(to, false)
        // while the side panel shows a row, it shows the chosen one
        if (to !== at && self.side && self.side.isOpen) self.open(to)
        else self.choose(to)
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
    // a taller table draws more rows; a wider or narrower one, such as beside the side panel, fits its columns again
    if (typeof ResizeObserver === 'function') {
      var h = -1
      this.resized = new ResizeObserver(function () {
        if (self.dead) return
        if (self.body.clientWidth !== self.laidW && self.fit()) self.redrawColumns()
        if (self.mount.clientHeight === h) return
        h = self.mount.clientHeight
        self.window()
      })
      this.resized.observe(this.mount)
    }
    // Color by changed: the rows' bars, the chips' counts and the strip's colours drawn again
    shared.onColour(function () {
      if (!self.dead && self.colourSig() !== self.colourKey) self.recolour(true)
    })
    // a label colored by reaches the rows as they come into view: the strip's colours follow
    var marksFrame = null
    thimble.onMarks(function () {
      var c = self.bars.colour()
      if (self.dead || !c || !c.label || marksFrame != null) return
      marksFrame = requestAnimationFrame(function () {
        marksFrame = null
        self.colourStrip()
      })
    })
    // the columns of numbers and times fitted again once the page's faces have loaded, which are wider than the fallback
    if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function')
      document.fonts.ready.then(function () {
        if (!self.dead && self.layout()) self.redrawColumns()
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
        self.chosen = null
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
  // the order the columns drop in, in a table too narrow for them: those with a `drop` the highest first, then the others
  // the rightmost first but the one the rows are sorted by last, so that the sort shows; never one with `drop: false`,
  // nor the main column unless it has a `drop`
  Table.prototype.dropOrder = function () {
    var cols = this.columns
    var main = this.main
    var by = this.sort ? this.sort.by : null
    return cols
      .map(function (c, i) {
        return i
      })
      .filter(function (i) {
        return cols[i].drop !== false && (cols[i].drop != null || i !== main)
      })
      .sort(function (a, b) {
        var da = cols[a].drop
        var db = cols[b].drop
        if ((da == null) !== (db == null)) return da == null ? 1 : -1
        if (da == null && (cols[a].name === by) !== (cols[b].name === by)) return cols[a].name === by ? 1 : -1
        return (da != null && db - da) || b - a
      })
  }
  // what a cell shows, as text
  Table.prototype.text = function (col, r) {
    if (col.html) return textOfHtml(ctl.safe(function () { return col.html(r) }, ''))
    var v = this.value(col, r)
    if (empty(v)) return ''
    if (col.type === 'time') return stamp(v, col.secs)
    if (col.type === 'number' && typeof v === 'number') return col.plain ? String(v) : num(v)
    return typeof v === 'object' ? JSON.stringify(v) : String(v)
  }
  // a column's second line under a row's value (`sub`): text, or {html} as thimble.recordCard takes its parts; '' for none
  Table.prototype.subHtml = function (col, r) {
    if (!col.sub) return ''
    var v = ctl.safe(function () { return col.sub(r) }, null)
    if (v == null || v === '' || v === false) return ''
    return typeof v === 'object' && v.html != null ? String(v.html) : esc(v)
  }
  // a cell's markup. A time in a column too narrow for its whole stamp keeps the year and the seconds it leaves out in
  // the page, drawn 0 wide (.thimble-table-cut), so that the search finds the same text at every width.
  Table.prototype.cell = function (col, r) {
    if (col.html) return String(ctl.safe(function () { return col.html(r) }, '') || '')
    var s = this.text(col, r)
    var f = col.type === 'time' ? col.form : null
    var v = f ? this.value(col, r) : null
    if (!f || typeof v !== 'number' || !isFinite(v)) return esc(s)
    var tail = col.secs ? 3 : 0 // :SS
    var head = s.length - 11 - tail // YYYY-, before MM-DD HH:MM
    var cut = function (t) {
      return t ? '<span class="thimble-table-cut">' + t + '</span>' : ''
    }
    return cut(f.year ? '' : s.slice(0, head)) + s.slice(f.year ? 0 : head, s.length - (f.secs ? 0 : tail)) + cut(f.secs ? '' : s.slice(s.length - tail))
  }
  // The columns' widths: a column's own, else for numbers and times as wide as their widest value or title, else an
  // equal share of what is left; and what each keeps in a table too narrow for them (fit): a column of text its `min`,
  // a column of times its shortest form, a column of numbers its width. True when the columns drawn changed.
  Table.prototype.layout = function () {
    var self = this
    var charW = measureChar(this.mount) || CHAR
    // each title's width on one line, and the least width it takes on two (headLeast): the longer of its two lines
    // where it wraps the most evenly, after a space, a slash or a hyphen, as the head draws it
    var splits = this.columns.map(function (c) {
      return twoLines(c.title)
    })
    var titles = this.columns.map(function (c) {
      return c.title
    })
    splits.forEach(function (ls) {
      ls.forEach(function (l) {
        titles.push(l[0], l[1])
      })
    })
    var widths = measureHeads(this.mount, titles)
    var wide = function (k) {
      return widths[k] || titles[k].length * charW
    }
    var heads = []
    var headLeast = [] // px a column keeps so that its head shows its whole title, with the cell's padding and the arrow
    var k = this.columns.length
    this.columns.forEach(function (c, i) {
      heads[i] = wide(i)
      var two = heads[i]
      splits[i].forEach(function () {
        two = Math.min(two, Math.max(wide(k), wide(k + 1)))
        k += 2
      })
      headLeast[i] = Math.ceil(two) + PAD + (c.sorts ? SORT_ROOM : 0)
    })
    var sample = this.all.length > SAMPLE ? this.all.slice(0, SAMPLE) : this.all
    var fitW = function (w) {
      return Math.round(Math.max(MIN_W, Math.min(MAX_W, w)))
    }
    // a column of times shows their seconds when one of them has any, so that every time in it reads alike; in a narrow
    // table it leaves out the year when they all share one
    this.columns.forEach(function (c) {
      if (c.type !== 'time') return
      c.secs = false
      c.years = false
      var from = null // the first time's year, from its first second to the next year's
      var to = null
      for (var i = 0; i < self.all.length && !(c.secs && c.years); i++) {
        var v = self.value(c, self.all[i])
        if (typeof v !== 'number' || !isFinite(v)) continue
        var t = seconds(v)
        if (Math.floor(t) % 60 !== 0) c.secs = true
        if (from == null) {
          var y = new Date(t * 1000).getUTCFullYear()
          from = Date.UTC(y, 0, 1) / 1000
          to = Date.UTC(y + 1, 0, 1) / 1000
        } else if (t < from || t >= to) c.years = true
      }
    })
    this.want = [] // px, a CSS track, or null for a share of what is left
    this.least = [] // px a column keeps before it drops
    this.ease = [] // px a column takes before the others give up width, for one that shares what is left
    this.forms = [] // a column of times: the forms it is written in as it narrows, [{secs, year, w}], the widest first
    this.columns.forEach(function (c, i) {
      var w = (typeof c.width === 'number' && c.width > 0) || (typeof c.width === 'string' && c.width) ? c.width : null
      self.forms[i] = null
      if (c.type === 'text') {
        var keeps = Math.max(c.min || (i === self.main ? MIN_MAIN : MIN_TEXT), headLeast[i])
        // a width in px narrower than the title takes the title on one line while the table has room, and gives that up
        // with the other columns of text in a narrow table, its title wrapping to two lines
        if (typeof w === 'number') w = Math.max(w, Math.ceil(heads[i]) + PAD + (c.sorts ? SORT_ROOM : 0))
        self.want[i] = w
        self.least[i] = typeof w === 'number' ? Math.min(w, keeps) : keeps
        self.ease[i] = i === self.main ? Math.max(keeps, EASE_MAIN) : keeps
        return
      }
      if (typeof w === 'string') {
        self.want[i] = w
        self.least[i] = self.ease[i] = Math.max(MIN_W, headLeast[i])
        return
      }
      var most = 0
      var asWritten = 0 // the longest time given as a string, which no form shortens
      for (var k = 0; k < sample.length; k++) {
        var t = self.text(c, sample[k])
        most = Math.max(most, t.length)
        if (c.type === 'time' && t && typeof self.value(c, sample[k]) !== 'number') asWritten = Math.max(asWritten, t.length)
      }
      if (w == null) w = fitW(Math.max(most * charW + PAD, heads[i] + PAD + SORT_ROOM))
      w = Math.max(w, headLeast[i])
      self.want[i] = w
      self.least[i] = w
      if (c.type !== 'time') return
      // the full stamp, then without the seconds, then without the year when the times share one: the first form is the
      // widest the column's width holds, each next one only when it is narrower
      var forms = [{ secs: c.secs, year: true }, { secs: false, year: true }, { secs: false, year: c.years }]
      var steps = []
      forms.forEach(function (f, j) {
        var fw = Math.max(fitW(Math.max(asWritten, STAMP + (f.secs ? 3 : 0) - (f.year ? 0 : 5)) * charW + PAD), headLeast[i])
        if (!steps.length) {
          if (fw <= w || j === forms.length - 1) steps.push({ secs: f.secs, year: f.year, w: w })
        } else if (fw < steps[steps.length - 1].w) steps.push({ secs: f.secs, year: f.year, w: fw })
      })
      self.forms[i] = steps
      self.least[i] = steps[steps.length - 1].w
    })
    return this.fit()
  }
  // The columns' tracks for the table's width, from what layout() found. In a table too narrow for them, such as one
  // beside the side panel, the times are written shorter (without their seconds, then without their year), then the
  // columns of text give up width in proportion down to what each keeps, the main column from EASE_MAIN; and when the
  // columns need more than the table has even so, they drop in their order until the rest fit, so that no cell passes
  // the table's edge. True when the columns drawn or the form of their times changed, which redrawColumns() then draws.
  Table.prototype.fit = function () {
    var self = this
    var cols = this.columns
    var room = this.body.clientWidth
    var least = (this.least || []).slice()
    var on = cols.map(function () {
      return true
    })
    var need = function () {
      var s = 0
      for (var i = 0; i < cols.length; i++) if (on[i]) s += least[i]
      return s
    }
    if (room > 0) {
      var order = this.dropOrder()
      for (var d = 0, left = cols.length; d < order.length && left > 1 && need() > room; d++, left--) on[order[d]] = false
      // the columns that never drop, still too wide: their text shares what the others leave
      var lack = need() - room
      var textLeast = 0
      cols.forEach(function (c, i) {
        if (on[i] && c.type === 'text') textLeast += least[i]
      })
      if (lack > 0 && textLeast > 0)
        cols.forEach(function (c, i) {
          if (on[i] && c.type === 'text') least[i] = Math.floor((least[i] * Math.max(0, textLeast - lack)) / textLeast)
        })
    }
    var width = [] // each column's width in px, a CSS track, or null for a share of what is left
    var share = [] // px a column that shares what is left (`1fr`) keeps of it
    var step = [] // the form each column of times is written in
    var over = 0
    cols.forEach(function (c, i) {
      if (!on[i]) return
      width[i] = self.want[i]
      step[i] = 0
      share[i] = width[i] == null || FR.test(width[i]) ? Math.max(least[i], self.ease[i] || 0) : least[i]
      over += typeof width[i] === 'number' ? width[i] : share[i]
    })
    over = room > 0 ? over - room : 0
    // first the times written shorter, a step at a time in every column of times
    for (var s = 1; over > 0; s++) {
      var stepped = false
      cols.forEach(function (c, i) {
        var f = self.forms[i]
        if (!on[i] || !f || s >= f.length) return
        over -= width[i] - f[s].w
        width[i] = f[s].w
        step[i] = s
        stepped = true
      })
      if (!stepped) break
    }
    // then the columns of text give up width in proportion, down to what each keeps: one with a width from it, the main
    // column from the share it takes before the others give up theirs
    if (over > 0) {
      var from = function (c, i) {
        return !on[i] || c.type !== 'text' ? 0 : typeof width[i] === 'number' ? width[i] : width[i] == null || FR.test(width[i]) ? share[i] : 0
      }
      var spare = 0
      cols.forEach(function (c, i) {
        spare += Math.max(0, from(c, i) - least[i])
      })
      var k = spare > 0 ? Math.min(1, over / spare) : 0
      cols.forEach(function (c, i) {
        var f = from(c, i)
        if (!k || f <= least[i]) return
        f = Math.floor(f - (f - least[i]) * k)
        if (typeof width[i] === 'number') width[i] = f
        else share[i] = f
      })
    }
    var tracks = []
    var drawn = []
    var key = []
    cols.forEach(function (c, i) {
      if (!on[i]) return
      var w = width[i] == null ? '1fr' : width[i]
      // a share of what is left keeps its px, rather than growing to its longest cell
      if (typeof w !== 'number') tracks.push(FR.test(w) ? 'minmax(' + share[i] + 'px, ' + w + ')' : w)
      else tracks.push(Math.round(w) + 'px')
      c.form = self.forms[i] ? self.forms[i][step[i]] : null
      drawn.push(c)
      key.push(i + (c.form ? (c.form.secs ? 's' : '') + (c.form.year ? 'y' : '') : ''))
    })
    this.root.style.setProperty('--thimble-table-cols', tracks.join(' '))
    this.laidW = room
    this.drawnCols = drawn
    var changed = key.join(' ') !== this.colsKey
    this.colsKey = key.join(' ')
    return changed
  }
  // the columns drawn again after they changed: the head, the rows near the view and the search's rows
  Table.prototype.redrawColumns = function () {
    this.drawHead()
    this.drawn.forEach(function (el) {
      el.remove()
    })
    this.drawn.clear()
    this.searchRows()
    this.window()
  }
  Table.prototype.drawHead = function () {
    var s = this.sort
    this.head.innerHTML = this.drawnCols
      .map(function (c) {
        var on = s && s.by === c.name
        var sort = on ? (s.desc ? 'descending' : 'ascending') : 'none'
        return (
          '<div class="thimble-table-th thimble-table-' + c.type + (on ? ' active' : '') + '" role="columnheader" aria-sort="' + sort + '"' +
          (c.sorts ? ' data-col="' + esc(c.name) + '" tabindex="0" title="Sort by ' + esc(c.title) + '"' : '') + '>' +
          '<span class="thimble-table-title">' + titleHtml(c.title) + '</span>' + (on ? (s.desc ? ARROW.down : ARROW.up) : '') + '</div>'
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
    var c = this.bars.colour()
    if (!c) return ''
    return JSON.stringify([c.picks, (c.values || []).map(function (v) { return [v.value, v.colour, v.on] })])
  }
  // Everything drawn again: the head, the rows that show and those near the view, the chips' counts, the strip and the
  // search's rows
  Table.prototype.draw = function () {
    if (!this.mount || this.dead) return
    this.shown = this.order()
    this.layout()
    this.drawHead()
    this.body.style.height = this.shown.length * this.rowH + 'px'
    this.none.hidden = this.shown.length > 0
    this.none.textContent = this.all.length ? 'Filter by hides every row' : 'No rows'
    this.recolour(false)
    this.searchRows()
    this.window()
  }
  // the search's rows: each row's columns drawn, then those a narrow table dropped, which it still finds
  Table.prototype.searchRows = function () {
    if (!this.search || typeof this.search.rows !== 'function') return
    var self = this
    var drawn = this.drawnCols
    var cols = drawn.concat(
      this.columns.filter(function (c) {
        return drawn.indexOf(c) < 0
      }),
    )
    this.search.rows({
      texts: this.shown.map(function (r) {
        return cols
          .map(function (col) {
            var sub = col.sub ? textOfHtml(self.subHtml(col, r)) : ''
            return self.text(col, r) + (sub ? '\n' + sub : '')
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
  // What Color by draws, drawn again: the chips count the rows while a field is the colour (a label's values reach only
  // the rows drawn), the strip shows every row's colour, and the rows near the view are drawn anew with their bars
  Table.prototype.recolour = function (rows) {
    var c = this.bars.colour()
    this.colourKey = this.colourSig()
    if (c && c.field) {
      var counts = {}
      for (var i = 0; i < this.shown.length; i++) {
        var v = c.valueOf(this.shown[i])
        var k = v == null ? '' : v
        counts[k] = (counts[k] || 0) + 1
      }
      // the counts of the rows in its mount, which the chips count while the table shows (not in a tab out of view)
      c.counts(counts, this.mount)
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
    var c = this.bars.colour()
    var timeCol = null
    var textCols = []
    this.columns.forEach(function (col) {
      if (col.type === 'time' && !timeCol) timeCol = col
      else if (col.type === 'text' && textCols.length < 2) textCols.push(col)
    })
    shared.strip(this.mount, {
      bare: this.bars.off,
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
    // the rows in the page in their order, so a part that reads them in order, such as the lanes' tint of the rows in
    // view (`follow`), reads them as they stand: each before the first row drawn below it
    var drawn = this.drawn
    for (var j = 0; j < add.length; j++) {
      var el = tmp.firstChild
      var below = null
      var at = Infinity
      drawn.forEach(function (e, k) {
        if (k > add[j] && k < at) {
          at = k
          below = e
        }
      })
      drawn.set(add[j], el)
      this.body.insertBefore(el, below)
    }
  }
  Table.prototype.rowHtml = function (i) {
    var r = this.shown[i]
    var ref = this.refOf(r)
    var self = this
    // its time, from the first column of times, so the lanes tint the rows in view (`follow`)
    var t = this.timeCol ? this.value(this.timeCol, r) : null
    // the page's attributes of the row, as a card takes them (thimble.recordCard's attrs): a class joins the row's own
    var cls = 'thimble-table-row' + (this.same(r, this.chosen) ? ' active' : '')
    var more = ''
    var extra = this.attrs ? ctl.safe(function () { return self.attrs(r) }, null) : null
    if (extra && typeof extra === 'object')
      for (var name in extra) {
        // a name an attribute can have, never an event handler's nor one the table writes itself
        if (!/^[a-zA-Z_:][\w:.-]*$/.test(name) || /^on/i.test(name) || /^(role|style|data-anchor|data-thimble-row|data-t)$/i.test(name)) continue
        if (extra[name] == null || extra[name] === false) continue
        if (name.toLowerCase() === 'class') cls += extra[name] === true ? '' : ' ' + String(extra[name])
        else more += ' ' + name + '="' + esc(extra[name] === true ? '' : extra[name]) + '"'
      }
    return (
      '<div class="' + esc(cls) + '" role="row" data-thimble-row="' + i + '"' +
      (ref != null ? ' data-anchor="' + esc(ref) + '"' : '') + (typeof t === 'number' && isFinite(t) ? ' data-t="' + seconds(t) + '"' : '') +
      this.bars.attr(r) + more + ' style="top:' + i * this.rowH + 'px">' +
      this.drawnCols
        .map(function (col) {
          var sub = col.sub ? self.subHtml(col, r) : ''
          var body = col.sub ? '<div class="thimble-table-line">' + self.cell(col, r) + '</div>' + (sub ? '<div class="thimble-table-sub">' + sub + '</div>' : '') : self.cell(col, r)
          return '<div class="thimble-table-td thimble-table-' + col.type + '" role="gridcell">' + body + '</div>'
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
          var sub = self.subHtml(col, r)
          return '<dt>' + esc(col.title) + '</dt><dd class="thimble-table-' + col.type + '">' + (col.html ? self.cell(col, r) : esc(self.text(col, r)) || '<span class="thimble-table-dim">—</span>') +
            (sub ? '<div class="thimble-table-sub">' + sub + '</div>' : '') + '</dd>'
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

  // each of `titles` as wide as a head draws it on one line, in capitals and spaced out, which a count of the cells'
  // characters underrates (Comments lost its last letters beside the sort's arrow); 0 where nothing lays out
  function measureHeads(at, titles) {
    var box = document.createElement('div')
    box.className = 'thimble-table-probe-heads'
    box.innerHTML = titles
      .map(function (t) {
        return '<div class="thimble-table-th"><span class="thimble-table-title">' + esc(t) + '</span></div>'
      })
      .join('')
    at.appendChild(box)
    var out = Array.prototype.map.call(box.querySelectorAll('.thimble-table-title'), function (t) {
      return t.getBoundingClientRect().width
    })
    box.remove()
    return out
  }

  /** a table of records with sortable columns, for thousands of rows (see the top of this file) */
  thimble.table = function (opts) {
    var t = new Table(opts || {})
    return {
      /** drawn with these rows, such as after a fetch, the sort and the chosen row kept; with none, drawn again, such
       *  as after Filter by changed */
      draw: function (rows) {
        // anything but a list (or null for none) draws again, so `onChange: table.draw` keeps the rows
        if (Array.isArray(rows) || rows === null) t.all = rows || []
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
