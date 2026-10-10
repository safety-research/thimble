// thimble's transcript for a view's page, part of the view kit: views.frame_document loads it after viewer_side.js and
// before viewer_range.js; viewer_parts.css styles it. It draws an agent's turns as the File browser's Transcript mode
// draws them (frontend/src/files/views/transcript.tsx AgentTranscript, views/common.tsx RecordCard, files.css
// .reader-*): one card per turn, its number in a column at the left, its speaker, tool and time in a mono head, its
// words under it; a tool call and what came back, and a system record, folded to one line until opened, a chevron at
// the start of its head that opens and folds it and turns as it does; a long block folded to six lines with Show more
// under it, Show less in the same place once open; a thought quiet; an error in the problem red, a failed call's head
// with ✕ before its tool; a line between sessions. Each turn is anchored with its ref, so a label marks it, a ⌘-click
// asks about it and Color by draws its bar, and its number opens its lines in the File browser. What a fold hides stays
// in the page, hidden, in an element with data-thimble-fold, so thimble.search finds it and opens its fold with the
// `thimble-unfold` event: a folded turn's words, and a long block's lines past the sixth.
//
//   const tr = thimble.transcript({ mount: '#turns', colour, onOpen: (turn) => fetchWhole(turn) })
//   tr.draw(turns, { title: 'explorer · Run 2' })   turns: [{ref, t, speaker, kind, tool, text, input, output, error,
//                                                    session, line}], kind text | prompt | tool | thinking | system,
//                                                    error true or the failure's word (✕'s hover gives it)
//   tr.reveal(ref)                                  a cited turn: opened, scrolled to the middle, its highlight fading
//   tr.set(ref, {text, input, output})              a turn's words once the reader sent them whole
;(function () {
  'use strict'
  var kit = window.__thimbleKit
  if (!kit || !window.thimble || !kit.shared || !kit.shared.controls) return
  var thimble = window.thimble
  var shared = kit.shared
  var ctl = shared.controls
  var esc = shared.esc
  var num = shared.num

  var FOLD_LINES = 6 // a block longer than this folds to it, with Show more (views/common.tsx COLLAPSE_LINES)
  var HIT_MS = 1500 // how long a cited turn keeps its highlight (views/common.tsx HIT_MS)
  var LINE_MAX = 200 // characters of a folded turn's one line
  var FOLDED = { tool: true, system: true, result: true }
  // the chevron at the start of a folding turn's head, turned down while the turn is open (Icon chevron-right)
  var CARET = '<svg class="thimble-turn-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>'

  // a block's first FOLD_LINES lines and the rest from the line break after them, '' when it is no longer
  function cut(s) {
    var at = -1
    for (var i = 0; i < FOLD_LINES; i++) if ((at = s.indexOf('\n', at + 1)) < 0) return [s, '']
    return [s.slice(0, at), s.slice(at)]
  }
  // the blocks an open turn draws, [k, kind, text, class]: a tool call and what came back, a system record's raw text,
  // or its words
  function blocks(turn) {
    var kind = turn.kind || 'text'
    if (kind === 'tool')
      return [
        [0, 'call', (turn.tool || 'tool') + (turn.input != null && turn.input !== '' ? '\n' + turn.input : '')],
        [1, 'result', turn.output != null ? turn.output : turn.result, turn.error ? 'is-error' : ''],
      ]
    if (kind === 'thinking') return [[0, 'thinking', turn.text]]
    if (kind === 'system') return [[0, 'raw', turn.text]]
    return [[0, 'text', turn.text, turn.error ? 'is-error' : '']]
  }
  function filled(text) {
    return text != null && String(text) !== ''
  }
  function firstLine(s) {
    var line = String(s == null ? '' : s).split('\n').filter(function (l) { return l.trim() })[0] || ''
    return line.length > LINE_MAX ? line.slice(0, LINE_MAX) + '…' : line
  }
  // a time as the reader's head writes it: seconds since 1970 as YYYY-MM-DD HH:MM:SS in UTC, a string as written
  function stamp(turn) {
    if (turn.time != null && turn.time !== '') return String(turn.time)
    var t = turn.t
    if (typeof t !== 'number' || !isFinite(t)) return ''
    return new Date(t * 1000).toISOString().slice(0, 19).replace('T', ' ')
  }
  // a turn's one line while it is folded: a tool call's tool and the first telling line of its input
  function summary(turn) {
    if (turn.kind === 'tool') return (turn.tool || 'tool') + (turn.input ? '  ' + firstLine(turn.input) : '')
    return firstLine(turn.text) || '(empty)'
  }

  function Transcript(opts) {
    var self = this
    this.mount = ctl.el(opts.mount)
    this.colour = opts.colour || null
    this.onOpen = typeof opts.onOpen === 'function' ? opts.onOpen : null
    this.fold = typeof opts.fold === 'function' ? opts.fold : function (turn) { return !!FOLDED[turn.kind] }
    this.turns = []
    this.byRef = {}
    this.opened = {} // ref -> true (opened) or false (folded by hand)
    this.expanded = {} // `${ref}:${block}` -> true
    if (!this.mount) return
    this.mount.classList.add('thimble-transcript')
    this.mount.addEventListener('click', function (e) {
      self.click(e)
    })
    // the search goes to a match folded away (viewer_search.js): what folds it opens
    this.mount.addEventListener('thimble-unfold', function (e) {
      self.unfold(e.target)
    })
  }
  Transcript.prototype.isOpen = function (turn) {
    var o = this.opened[turn.ref]
    return o === undefined ? !this.fold(turn) : o
  }
  // A block: a longer one folded, its height cut to six lines as drawn (viewer_parts.css) and its lines past the sixth
  // in the page, hidden until Show more (data-thimble-fold, so the search finds them)
  Transcript.prototype.block = function (turn, k, kind, text, cls) {
    if (!filled(text)) return ''
    var key = turn.ref + ':' + k
    var parts = cut(String(text))
    var long = parts[1] !== ''
    var open = !long || !!this.expanded[key]
    var body = parts[0]
    if (kind === 'call') {
      var nl = body.indexOf('\n')
      body = '<span class="thimble-turn-toolname">' + esc(nl < 0 ? body : body.slice(0, nl)) + '</span>' + esc(nl < 0 ? '' : body.slice(nl))
    } else body = esc(body)
    if (long) body += '<span class="thimble-turn-rest" data-thimble-fold' + (open ? '' : ' hidden') + '>' + esc(parts[1]) + '</span>'
    return (
      '<div class="thimble-turn-fold' + (open ? '' : ' is-folded') + '">' +
      '<div class="thimble-turn-block thimble-turn-' + kind + (cls ? ' ' + cls : '') + '">' + body + '</div>' +
      (long ? '<button type="button" class="thimble-turn-more" data-expand="' + esc(key) + '" aria-expanded="' + open + '" data-thimble-chrome>' + (open ? 'Show less' : 'Show more') + '</button>' : '') +
      '</div>'
    )
  }
  Transcript.prototype.turnHtml = function (turn, i) {
    var open = this.isOpen(turn)
    // a turn that folds, or that was folded or opened by hand: its head opens and folds it, its chevron turning
    var folds = this.fold(turn) || this.opened[turn.ref] !== undefined
    var kind = turn.kind || 'text'
    // a failed call: ✕ and its tool in the problem red, whether the turn is folded or open
    var failed = kind === 'tool' && turn.error
    var tool = failed ? '<span class="thimble-turn-failed" title="' + esc(typeof turn.error === 'string' ? turn.error : 'failed') + '">✕ ' + esc(turn.tool || 'tool') + '</span>' : esc(turn.tool)
    var head = esc(turn.speaker || '(unsigned)') + ((turn.tool || failed) && kind === 'tool' ? '<span class="thimble-turn-tool"> · ' + tool + '</span>' : '') + (stamp(turn) ? ' · ' + esc(stamp(turn)) : '')
    var body = ''
    var bs = blocks(turn)
    if (!open) {
      // the one line stands for the words, which stay in the page hidden, each block's text as the open turn shows it,
      // so the search counts the same matches folded or open; the line is the page's wording (data-thimble-chrome)
      var words = ''
      for (var b = 0; b < bs.length; b++) if (filled(bs[b][2])) words += '<div>' + esc(String(bs[b][2])) + '</div>'
      body =
        '<div class="thimble-turn-line" data-open="' + esc(turn.ref) + '" data-thimble-chrome>' + esc(summary(turn)) + '</div>' +
        (words ? '<div class="thimble-turn-folded" data-thimble-fold hidden>' + words + '</div>' : '')
    } else {
      for (var j = 0; j < bs.length; j++) body += this.block(turn, bs[j][0], bs[j][1], bs[j][2], bs[j][3])
      if (!body) body = '<div class="thimble-turn-empty" data-thimble-chrome>(empty)</div>'
    }
    var colour = this.colour && typeof this.colour.attr === 'function' ? this.colour.attr(turn) : ''
    var no = turn.line != null ? turn.line : i + 1
    return (
      '<div class="thimble-turn thimble-turn-k-' + esc(kind) + '" data-anchor="' + esc(turn.ref) + '" data-anchor-text="' + esc(summary(turn).slice(0, 300)) + '"' + (typeof turn.t === 'number' ? ' data-t="' + turn.t + '"' : '') + colour + '>' +
      '<button type="button" class="thimble-turn-no" data-place="' + esc(turn.ref) + '" title="Open its lines in the File browser" data-thimble-chrome>' + esc(no) + '</button>' +
      '<div class="thimble-turn-main">' +
      (folds ? '<button type="button" class="thimble-turn-head thimble-turn-toggle" data-toggle="' + esc(turn.ref) + '" aria-expanded="' + (open ? 'true' : 'false') + '" data-thimble-chrome>' + CARET + head + '</button>' : '<div class="thimble-turn-head" data-thimble-chrome>' + head + '</div>') +
      '<div class="thimble-turn-body">' + body + '</div></div></div>'
    )
  }
  Transcript.prototype.draw = function (turns, o) {
    if (!this.mount) return
    o = o || {}
    var self = this
    this.turns = Array.isArray(turns) ? turns : []
    this.byRef = {}
    this.turns.forEach(function (t) {
      self.byRef[t.ref] = t
    })
    var out = []
    if (o.title != null) out.push('<div class="thimble-transcript-head" data-thimble-chrome><span class="thimble-transcript-title">' + esc(o.title) + '</span><span class="thimble-transcript-n">' + num(this.turns.length) + (this.turns.length === 1 ? ' turn' : ' turns') + '</span>' + (o.sub ? '<span class="thimble-transcript-sub">' + esc(o.sub) + '</span>' : '') + '</div>')
    var prev
    this.turns.forEach(function (t, i) {
      if (t.session != null && prev != null && t.session !== prev) out.push('<div class="thimble-transcript-session" data-thimble-chrome><span>' + esc(t.sessionName || t.session) + '</span></div>')
      if (t.session != null) prev = t.session
      out.push(self.turnHtml(t, i))
    })
    if (!this.turns.length) out.push('<div class="thimble-turn-empty thimble-transcript-none">' + esc(o.empty || 'No turn') + '</div>')
    this.mount.innerHTML = out.join('')
  }
  // one turn drawn again in its place; a control of it that had the focus keeps it, the chevron for the line that opened it
  Transcript.prototype.redrawTurn = function (ref) {
    var turn = this.byRef[ref]
    var node = this.find(ref)
    if (!turn || !node) return
    var i = this.turns.indexOf(turn)
    var tmp = document.createElement('div')
    tmp.innerHTML = this.turnHtml(turn, i)
    var fresh = tmp.firstChild
    // drawn at once, not when it next scrolls into view (content-visibility), so that its size and the place of its
    // words are right at once for the search and a citation that scroll to them
    fresh.classList.add('is-drawn')
    var had = document.activeElement && document.activeElement !== node && node.contains(document.activeElement) ? document.activeElement : null
    node.replaceWith(fresh)
    if (!had) return
    var key = had.getAttribute('data-expand')
    var again = had.hasAttribute('data-place') ? fresh.querySelector('[data-place]') : null
    if (key != null) {
      var mores = fresh.querySelectorAll('[data-expand]')
      for (var m = 0; m < mores.length; m++) if (mores[m].getAttribute('data-expand') === key) again = mores[m]
    }
    again = again || fresh.querySelector('[data-toggle]')
    if (again) again.focus({ preventScroll: true })
  }
  Transcript.prototype.find = function (ref) {
    var all = this.mount.querySelectorAll('.thimble-turn')
    for (var i = 0; i < all.length; i++) if (all[i].getAttribute('data-anchor') === String(ref)) return all[i]
    return null
  }
  Transcript.prototype.open = function (ref, on) {
    var turn = this.byRef[ref]
    if (!turn) return
    var was = this.isOpen(turn)
    this.opened[ref] = on === undefined ? !was : !!on
    this.redrawTurn(ref)
    if (!was && this.isOpen(turn) && this.onOpen) {
      var self = this
      ctl.safe(function () { self.onOpen(turn) })
    }
  }
  Transcript.prototype.click = function (e) {
    var t = e.target
    if (!t.closest) return
    var go = t.closest('[data-open]')
    if (go) return this.open(go.getAttribute('data-open'), true)
    var toggle = t.closest('[data-toggle]')
    if (toggle) return this.open(toggle.getAttribute('data-toggle'))
    var ex = t.closest('[data-expand]')
    if (ex) return this.expand(ex)
    var place = t.closest('[data-place]')
    if (place) thimble.navigate(place.getAttribute('data-place'), { browser: true })
  }
  // Show more shows a long block's lines past the sixth in place, and Show less folds them again
  Transcript.prototype.expand = function (button) {
    var key = button.getAttribute('data-expand')
    var on = !this.expanded[key]
    if (on) this.expanded[key] = true
    else delete this.expanded[key]
    var box = button.parentElement
    var rest = box && box.querySelector('[data-thimble-fold]')
    if (!rest) return this.redrawTurn(key.slice(0, key.lastIndexOf(':')))
    rest.hidden = !on
    box.classList.toggle('is-folded', !on)
    button.setAttribute('aria-expanded', String(on))
    button.textContent = on ? 'Show less' : 'Show more'
  }
  // the search goes to a match folded away, or cut from view by a folded block's height: the turn it is in opens, as a
  // click on its line opens it (onOpen told), and the long block it is in shows whole
  Transcript.prototype.unfold = function (el) {
    var node = el && el.closest ? el.closest('.thimble-turn') : null
    var ref = node && node.getAttribute('data-anchor')
    var turn = ref != null && this.find(ref) === node ? this.byRef[ref] : null
    if (!turn) return
    var box = el.closest('.thimble-turn-fold')
    var more = box && box.querySelector('[data-expand]')
    if (more) this.expanded[more.getAttribute('data-expand')] = true
    if (this.isOpen(turn)) this.redrawTurn(ref)
    else this.open(ref, true)
  }
  // a cited turn: opened, in the middle of its box, its highlight fading as Files' does
  Transcript.prototype.reveal = function (ref) {
    var turn = this.byRef[ref]
    if (!turn) return false
    if (!this.isOpen(turn)) this.open(ref, true)
    var node = this.find(ref)
    if (!node) return false
    if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: node.getBoundingClientRect().height > (this.mount.clientHeight || innerHeight) ? 'start' : 'center' })
    node.classList.remove('thimble-turn-hit')
    void node.offsetWidth
    node.classList.add('thimble-turn-hit')
    setTimeout(function () {
      node.classList.remove('thimble-turn-hit')
    }, HIT_MS)
    return true
  }
  Transcript.prototype.set = function (ref, patch) {
    var turn = this.byRef[ref]
    if (!turn || !patch) return
    for (var k in patch) turn[k] = patch[k]
    this.redrawTurn(ref)
  }
  /** a transcript's turns as the File browser's Transcript mode draws them (see the top of this file) */
  thimble.transcript = function (opts) {
    var tr = new Transcript(opts || {})
    return {
      draw: function (turns, o) {
        tr.draw(turns, o)
      },
      reveal: function (ref) {
        return tr.reveal(ref)
      },
      open: function (ref, on) {
        tr.open(ref, on)
      },
      set: function (ref, patch) {
        tr.set(ref, patch)
      },
      /** the turns as last drawn */
      get turns() {
        return tr.turns.slice()
      },
    }
  }
})()
