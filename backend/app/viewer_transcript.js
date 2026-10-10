// thimble's transcript for a view's page, part of the view kit: views.frame_document loads it after viewer_side.js and
// before viewer_range.js; viewer_parts.css styles it. It draws an agent's turns as the File browser's Transcript mode
// draws them (frontend/src/files/views/transcript.tsx AgentTranscript, views/common.tsx RecordCard, files.css
// .reader-*): one card per turn, its number in a column at the left, its speaker, tool and time in a mono head, its
// words under it; a tool call and what came back, and a system record, folded to one line until opened, a chevron at
// the start of its head that opens and folds it and turns as it does; a long block folded to six lines with Show more
// under it, Show less in the same place once open; a thought quiet; an error in the problem red, a failed call's head
// with ✕ before its tool; a line between sessions. Each turn is anchored with its ref, so a label marks it, a ⌘-click
// asks about it and Color by draws its bar, and its number opens its lines in the File browser. Its bars follow the
// page's Color by unless it is given `colour` (or `color`; false for none), and it keeps them as Color by changes,
// stamping each turn again from its turn, its folds and the scroll as they were.
//
//   const tr = thimble.transcript({ mount: '#turns', onOpen: (turn) => fetchWhole(turn) })
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

  function lines(s) {
    return String(s == null ? '' : s).split('\n').length
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
    this.bars = shared.bars(opts)
    this.restampAll = function () {
      self.restamp()
    }
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
  }
  Transcript.prototype.isOpen = function (turn) {
    var o = this.opened[turn.ref]
    return o === undefined ? !this.fold(turn) : o
  }
  Transcript.prototype.block = function (turn, k, kind, text, cls) {
    if (text == null || String(text) === '') return ''
    var key = turn.ref + ':' + k
    var long = lines(text) > FOLD_LINES
    var open = !long || !!this.expanded[key]
    var body = String(text)
    if (kind === 'call') {
      var nl = body.indexOf('\n')
      body = '<span class="thimble-turn-toolname">' + esc(nl < 0 ? body : body.slice(0, nl)) + '</span>' + esc(nl < 0 ? '' : body.slice(nl))
    } else body = esc(body)
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
    if (!open) body = '<div class="thimble-turn-line" data-open="' + esc(turn.ref) + '">' + esc(summary(turn)) + '</div>'
    else {
      if (kind === 'tool') {
        body += this.block(turn, 0, 'call', (turn.tool || 'tool') + (turn.input != null && turn.input !== '' ? '\n' + turn.input : ''))
        body += this.block(turn, 1, 'result', turn.output != null ? turn.output : turn.result, turn.error ? 'is-error' : '')
      } else if (kind === 'thinking') body += this.block(turn, 0, 'thinking', turn.text)
      else if (kind === 'system') body += this.block(turn, 0, 'raw', turn.text)
      else body += this.block(turn, 0, 'text', turn.text, turn.error ? 'is-error' : '')
      if (!body) body = '<div class="thimble-turn-empty">(empty)</div>'
    }
    var colour = this.bars.attr(turn)
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
    this.bars.watch(this.mount, this.restampAll)
  }
  // Color by's choices changed: each turn's bar stamped again from its turn, nothing drawn again
  Transcript.prototype.restamp = function () {
    var all = this.mount.querySelectorAll(':scope > .thimble-turn')
    for (var i = 0; i < all.length; i++) {
      var turn = this.byRef[all[i].getAttribute('data-anchor')]
      if (turn) this.bars.stamp(all[i], turn)
    }
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
    if (ex) {
      var key = ex.getAttribute('data-expand')
      this.expanded[key] = !this.expanded[key]
      return this.redrawTurn(key.slice(0, key.lastIndexOf(':')))
    }
    var place = t.closest('[data-place]')
    if (place) thimble.navigate(place.getAttribute('data-place'), { browser: true })
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
