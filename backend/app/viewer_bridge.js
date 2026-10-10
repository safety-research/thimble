// The frame half of a viewer's bridge (views.frame_document puts it first in every view page; the page half is
// frontend/src/files/ViewerFrame.tsx, and scripts/view_shot.mjs plays the page for a view's checks and screenshots).
// A viewer runs in a sandboxed iframe that loads nothing but its view's media route (window.thimble.mediaUrl, the
// URL of an image, audio or video file it claims, for an element's src), so everything else it knows arrives through
// postMessage calls:
//   open {locator, quote?} page to frame: show this place (window.thimble.onOpen); with quote {record, text}, a passage
//                          inside that record, which the bridge highlights and scrolls to (the view shows the record).
//                          In a card's frame its target is {ref, pick}, pick to open the record in full; in a view,
//                          `query` is {card, title, args} of the card it was opened from, or null. With no ref, `path`
//                          is the file the view opened on, and `picked` holds when the analyst chose it (Open in)
//                          rather than thimble opening the view on its first file
//   quoted {found}         frame to page: whether the quoted passage showed in the page
//   fetch {id, query, progress, key}
//                          frame to page, answered by result {id, data} from reader.records (window.thimble.fetch), with
//                          no time limit; `progress` when the page shows the wait itself (onProgress), `key` the fetch's
//                          key or null
//   cancel {id}            frame to page: the page dropped that fetch (a newer one with its key, or its signal), so
//                          thimble cancels the reader's call
//   progress {id, seconds, phase, done?, total?, note?}
//                          page to frame, about once a second while a fetch runs: how long it has run, whether the
//                          reader is reading the files (`index`) or answering, and what the reader reported
//                          (thimble.progress). A fetch without onProgress shows it in thimble's own small box at the
//                          page's corner, with a Cancel button, after WAIT_SHOWN_MS
//   cite {ref, text, ...}  frame to page: a ⌘-click on an element with data-anchor, or on any other part of the view
//                          (its legend, a control, the empty page), asked about as the view itself, `view:<slug>`
//   init {mode, data, args, width, card, key}
//                          page to frame, in a card's frame (cardtypes.py): what the card stored, which the page draws
//                          with no fetch (window.thimble.onInit); mode is card, full or render, `card` its id, and `key`
//                          names what it stored, the same key when only the mode or the width changed
//   setQuery {patch}       frame to page, in a card's frame: the card's call's arguments the analyst's reshaping would
//                          change, {} for none, which Keep writes into the call (window.thimble.setQuery); in a view
//                          opened from a card, null when the page dropped the card's arguments
//   navigate {ref, browser?}
//                          frame to page: open another place, in this view or anywhere in thimble, a file ref with
//                          `browser` in the File browser (window.thimble.navigate)
//   reveal {rect}          frame to page: bring this part of the page into view, which a page as tall as its frame
//                          cannot scroll to itself (window.thimble.reveal)
//   size {height}          frame to page: the document's height, for a frame that sizes to its content, or the height a
//                          page says it needs (window.thimble.size), after which the document's own height is not sent
//   settled                frame to page: a card's page has drawn what `init` brought (window.thimble.settled)
//   anchors {refs, seq, seen}
//                          frame to page: the data-anchor values that appeared since the last report, `seq` how many
//                          have been reported in all, and `seen` those of the anchored elements in the frame's viewport
//                          not reported in view before, whose labels thimble reads first
//   seen {refs}            frame to page: the same for the anchored elements a scroll, a resize or a redraw brought into
//                          view
//   labels {marks, on, filter, all, palette, answered}
//                          page to frame: marks {ref: {bar, names, values: [{id, label, value, colour}], spans: [{text,
//                          colour}], keep?}}, the marks of the labels that are on for the records and units among those
//                          refs, drawn over every element with that data-anchor, `values` each label that highlights the
//                          record with its value, with `keep` whether the ref passes the label filter, and `answered` the
//                          `seq` of the anchors whose every ref those marks answer for the filter (-1 while some are
//                          still being read); on [{id, name, colour,
//                          values}], the labels that are on; filter {label, value, colour} or null; all [{id, name, on,
//                          here, colour, values: [{name, colour, highlight}], count}], every label over files, those
//                          that mark records in the view's files first with `here` true; palette, the
//                          colours a label's value can take. Each replaces the last; window.thimble.onLabels hears all
//                          but the marks, which window.thimble.markOf reads and window.thimble.onMarks hears. A colour
//                          that is a CSS variable, var(--label-3), is resolved here to the colour it stands for, so a
//                          canvas can draw every colour the page is given. In a card's
//                          frame the elements whose records the filter drops are dimmed, never hidden, and the page's
//                          own filtering is left alone
//   key {key}              page to frame, once the frame is ready: the key every labelCall carries, which only this
//                          bridge sees (it stops the message before the view's own listeners)
//   labelCall {id, key, op, args}
//                          frame to page, answered by labelDone {id, error?}: the page's label controls (window.thimble
//                          setLabel, setLabelColour, editLabel, mark and setFilter), each sent only while the frame has
//                          the analyst's transient user activation, which thimble checks again on its side; ops on,
//                          colour, edit, mark and filter. edit's args are {id, anchor?, side?}: thimble opens the label
//                          editor in a popover over the page, beside `anchor` {left, top, width, height} (the control
//                          that asked, in the frame's coordinates) on `side` aside or below, or inside the page's
//                          top-left corner without one
//   labelEditorClosed {id, focus}
//                          page to frame: the editor that the edit call `id` opened closed, `focus` when thimble gave
//                          the focus back to the frame, which then puts it back on the element that had it when the
//                          page asked (editLabel's onClose(focused) runs after)
//   labelRefused {op}      frame to page: a label call the bridge refused because the analyst made no gesture in the view
//   hidden {n, self}       frame to page: how many anchored refs the bridge hides or dims for the label filter, null
//                          while thimble has not answered for every anchored ref, and whether the page filters its
//                          records itself (it registered onLabels)
//   cmd {on, cursor}       page to frame: ⌘ went down or up, and the page's ⌘ arrow as a CSS cursor value, which this
//                          page shows while ⌘ is held so the pointer over the frame is the same one pointer
//   state {id}             page to frame, answered by state {id, state}: what the analyst is looking at, before a newer
//                          version of the view is loaded in its place: {ref, scroll, fields, segs} (pageState)
//   restore {state}        page to frame: that state put back in the newer version's page, as far as it fits (restore)
//   colour {state}         frame to page: the view's Color by choice, or a time range (viewer_range.js), changed, which thimble keeps
//                          per view and hands the page again as window.__thimbleColour when it loads
// An anchored element with data-anchor-unmarked takes no mark, where the page draws the labels' colours on it itself,
// such as a lane whose marks carry them; the checks then look for the label's colour on the element. A ⌘-click on it
// still asks about its ref.
// The text of an element marked data-thimble-chrome inside an anchored element is the page's own wording, such as a
// record's header, which a label's matches never highlight. window.thimble.derived lists the fields the view's reader
// made rather than read (window.__thimbleView.derived), which thimble lists above the view; nothing in the page is marked.
// plus ready (the frame can take `open`), error (an uncaught error or a blocked request, shown with a Raw button) and
// point {rect} (the element under the pointer while ⌘ is held, so the page's one highlight follows the pointer into the
// frame).
;(function () {
  'use strict'
  var P = 'thimble:'
  var labelFns = []
  var labelState = null
  var labelKey = ''
  var filter = null
  var seq = 0
  var pending = {}
  var openers = []
  var last = null
  var pointed = null
  var picked = null // the data-anchor of the element the analyst last clicked since the last `open`
  var cardMode = !!(window.__thimbleView && window.__thimbleView.card)
  var init = null
  var initFns = []
  var markFns = []
  // the view kit's own controls (viewer_colour.js): what they hear of the labels, which is not the page's onLabels and
  // so leaves the label filter to thimble, and the Colour by choice that the marks are drawn by (colourHook)
  var kitFns = []
  var colourHook = null
  var ownSize = false // the page said the height it needs, so the document's own height is no longer sent
  // The analyst's gesture: transient user activation in this frame, read through the getter as it was when the bridge
  // ran, so a page that redefines it later changes what it reads itself but not what the bridge reads
  var UA = navigator.userActivation || null
  var uaActive = null
  try {
    var uaDesc = UA && Object.getOwnPropertyDescriptor(Object.getPrototypeOf(UA), 'isActive')
    uaActive = uaDesc && typeof uaDesc.get === 'function' ? uaDesc.get : null
  } catch (e) {}
  function gesture() {
    try {
      return !!(UA && uaActive && uaActive.call(UA))
    } catch (e) {
      return false
    }
  }
  var callKey = null
  var calls = {}
  var NO_GESTURE = 'thimble changes labels only while the analyst clicks or types in the view'
  function refusal(message) {
    var err = new Error(message)
    err.name = 'ThimbleRefused'
    err.thimbleRefused = true
    return Promise.reject(err)
  }
  // a label change, sent to thimble only during the analyst's gesture; the promise rejects with thimble's reason.
  // `closed(focus)` runs when the editor an edit call opened closes
  var editorClosers = {}
  function labelCall(op, args, closed) {
    if (!gesture()) {
      post({ type: P + 'labelRefused', op: op })
      return refusal(NO_GESTURE)
    }
    if (!callKey) return refusal('thimble is not ready for label calls yet')
    return new Promise(function (resolve, reject) {
      var id = ++seq
      calls[id] = { resolve: resolve, reject: reject }
      if (closed) editorClosers[id] = closed
      post({ type: P + 'labelCall', id: id, key: callKey, op: op, args: args })
    })
  }
  // where the label editor stands: beside an element of the page, or a rect {left, top, width, height} in the frame's
  // coordinates (a DOMRect is one); null for anything else
  function anchorRect(a) {
    if (!a) return null
    if (a.nodeType === 1 && typeof a.getBoundingClientRect === 'function') return rectOf(a)
    var r = { left: Number(a.left), top: Number(a.top), width: Number(a.width), height: Number(a.height) }
    return isFinite(r.left) && isFinite(r.top) && isFinite(r.width) && isFinite(r.height) && r.width >= 0 && r.height >= 0 ? r : null
  }
  var WAIT_SHOWN_MS = 1000
  var waitBox = null
  var waitTimer = null
  var derivedList = (window.__thimbleView && Array.isArray(window.__thimbleView.derived) && window.__thimbleView.derived) || []
  var derivedBy = {}
  for (var dv = 0; dv < derivedList.length; dv++) if (derivedList[dv] && derivedList[dv].field) derivedBy[derivedList[dv].field] = derivedList[dv]
  function post(msg) {
    try {
      parent.postMessage(msg, '*')
    } catch (e) {}
  }
  function rectOf(el) {
    // the page as a whole is the part of it the frame shows, not the whole scrolled document
    if (el === document.documentElement) return { left: 0, top: 0, width: innerWidth, height: innerHeight }
    var r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  }
  function textOf(el) {
    var own = el.getAttribute('data-anchor-text')
    var t = own != null && own !== '' ? own : el.innerText || el.textContent || ''
    return String(t).replace(/[ \t]+/g, ' ').replace(/\s+\n/g, '\n').trim().slice(0, 2000)
  }
  function nameOf(el) {
    return el.getAttribute('data-anchor-name') || el.getAttribute('aria-label') || ''
  }
  function report(err) {
    post({ type: P + 'error', message: String((err && (err.message || err.reason)) || err) })
  }
  function aborted() {
    var err = new Error('the fetch was cancelled')
    err.name = 'AbortError'
    return err
  }
  // drop a pending fetch: its promise rejects with an AbortError and thimble cancels the reader's call
  function dropFetch(id) {
    var p = pending[id]
    if (!p) return
    delete pending[id]
    post({ type: P + 'cancel', id: id })
    p.reject(aborted())
    showWait()
  }
  // The box at the page's corner while a fetch without onProgress has run WAIT_SHOWN_MS: what the reader does, how long
  // it has run, and Cancel, which drops those fetches.
  function waiting() {
    var now = Date.now()
    var first = null
    for (var k in pending) {
      var p = pending[k]
      if (!p.onProgress && now - p.started >= WAIT_SHOWN_MS && (!first || p.started < first.started)) first = p
    }
    return first
  }
  function showWait() {
    var p = waiting()
    if (!p) {
      if (waitBox) waitBox.style.display = 'none'
      var later = false
      for (var k in pending) if (!pending[k].onProgress) later = true
      if (waitTimer && !later) {
        clearInterval(waitTimer)
        waitTimer = null
      }
      return
    }
    if (!waitBox) {
      var sheet = document.createElement('style')
      sheet.textContent =
        '.thimble-wait{position:fixed;right:8px;bottom:8px;z-index:2147483646;display:flex;align-items:center;gap:8px;' +
        'padding:3px 3px 3px 10px;border:1px solid rgba(var(--ink-rgb,0,0,0),0.14);border-radius:var(--radius-ui,6px);' +
        'background:var(--surface-card,#fff);color:var(--text-secondary,#555);font:400 var(--text-ui-sm,12px)/1.2 ' +
        'var(--font-body,sans-serif);font-variant-numeric:tabular-nums}'
      ;(document.head || document.documentElement).appendChild(sheet)
      waitBox = document.createElement('div')
      waitBox.className = 'thimble-wait'
      waitBox.setAttribute('data-thimble-chrome', '')
      waitBox.setAttribute('role', 'status')
      var text = document.createElement('span')
      var stop = document.createElement('button')
      stop.type = 'button'
      stop.className = 'btn btn-ghost btn-sm'
      stop.textContent = 'Cancel'
      stop.addEventListener('click', function () {
        for (var k in pending) if (!pending[k].onProgress) dropFetch(+k)
      })
      waitBox.appendChild(text)
      waitBox.appendChild(stop)
      ;(document.body || document.documentElement).appendChild(waitBox)
    }
    var info = p.progress || {}
    var what = info.note || (info.phase === 'index' ? 'Reading the files' : 'Loading')
    var count = typeof info.done === 'number' && typeof info.total === 'number' ? ' · ' + info.done + ' of ' + info.total : ''
    waitBox.firstChild.textContent = what + count + ' · ' + Math.floor((Date.now() - p.started) / 1000) + ' s'
    waitBox.style.display = ''
  }
  function watchWait() {
    if (!waitTimer) waitTimer = setInterval(showWait, 250)
  }
  function escapeHtml(v) {
    return String(v).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    })
  }
  // A colour as a canvas can draw it: one that names a CSS variable, var(--label-3), is read through an element's
  // computed colour in the frame's tokens; any other is kept as it is. The frame is loaded again when the theme changes,
  // so a colour is resolved once per page.
  var colourProbe = null
  var realColours = {}
  function realColour(c) {
    if (typeof c !== 'string' || c.indexOf('var(') < 0) return c
    if (Object.prototype.hasOwnProperty.call(realColours, c)) return realColours[c]
    var root = document.head || document.documentElement
    if (!root) return c
    if (!colourProbe || !colourProbe.isConnected) {
      colourProbe = document.createElement('i')
      colourProbe.setAttribute('data-thimble-chrome', '')
      root.appendChild(colourProbe)
    }
    colourProbe.style.color = ''
    colourProbe.style.color = c
    var got = ''
    try {
      got = getComputedStyle(colourProbe).color
    } catch (e) {}
    var out = got && got.indexOf('var(') < 0 ? got : c
    realColours[c] = out
    return out
  }
  // a mark with every colour resolved (realColour), so markOf hands the page colours a canvas can draw
  function realMark(m) {
    var c = {}
    for (var k in m) c[k] = m[k]
    if (typeof c.bar === 'string') c.bar = realColour(c.bar)
    if (Array.isArray(c.spans))
      c.spans = c.spans.map(function (s) {
        if (!s || typeof s !== 'object') return s
        var sp = { text: s.text, colour: realColour(s.colour) }
        if (s.id != null) sp.id = String(s.id)
        return sp
      })
    if (Array.isArray(c.values))
      c.values = c.values.map(function (v) {
        return v && typeof v === 'object' ? { id: v.id, label: v.label, value: v.value, colour: realColour(v.colour) } : v
      })
    return c
  }
  // whether two values as postMessage hands them over (JSON's kinds) are equal, without serializing either
  function same(a, b) {
    if (a === b) return true
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
    var list = Array.isArray(a)
    if (list !== Array.isArray(b)) return false
    if (list) {
      if (a.length !== b.length) return false
      for (var i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false
      return true
    }
    var n = 0
    for (var k in a) {
      if (!Object.prototype.hasOwnProperty.call(b, k) || !same(a[k], b[k])) return false
      n++
    }
    for (var j in b) n--
    return n === 0
  }
  // A labels message's marks taken in by ref: a ref whose mark is the same as in the last message keeps its resolved
  // mark, so a message costs a comparison per ref rather than the whole map copied and serialized. Whether any changed.
  var given = {} // ref -> the mark as the page last sent it
  function takeMarks(raw) {
    if (!raw || typeof raw !== 'object') raw = {}
    var changed = false
    for (var ref in given) {
      if (Object.prototype.hasOwnProperty.call(raw, ref) && raw[ref] && typeof raw[ref] === 'object') continue
      delete given[ref]
      delete marks[ref]
      changed = true
    }
    for (var r in raw) {
      var m = raw[r]
      if (!m || typeof m !== 'object') continue
      if (Object.prototype.hasOwnProperty.call(given, r) && same(given[r], m)) continue
      given[r] = m
      marks[r] = realMark(m)
      changed = true
    }
    return changed
  }
  function realLabelList(list) {
    if (!Array.isArray(list)) return list
    return list.map(function (l) {
      if (!l || typeof l !== 'object') return l
      var c = {}
      for (var k in l) c[k] = l[k]
      if (typeof c.colour === 'string') c.colour = realColour(c.colour)
      if (Array.isArray(c.values))
        c.values = c.values.map(function (v) {
          if (!v || typeof v !== 'object') return v
          var w = {}
          for (var j in v) w[j] = v[j]
          if (typeof w.colour === 'string') w.colour = realColour(w.colour)
          return w
        })
      return c
    })
  }
  window.thimble = {
    /** the view this page belongs to: {slug, name}, for the view:<slug>/<key> refs it writes */
    view: window.__thimbleView || null,
    /** in a card's frame, what the card stored ({mode, data, args, width, card}) once `init` arrived; null in a view */
    card: null,
    /** fn(place) runs for every `open`, and at once with the last one when it arrived before the view registered */
    onOpen: function (fn) {
      openers.push(fn)
      if (last) {
        try {
          fn(last)
        } catch (e) {
          report(e)
        }
      }
    },
    /** fn({labels, filter, all, palette}) runs with the labels that are on, the label filter, every label over files
     *  and the palette of label colours, at once with the current ones when they have arrived, and again whenever they
     *  change; a page that registers it filters its records itself (its reader's thimble.kept), so the bridge hides
     *  nothing for the filter */
    onLabels: function (fn) {
      labelFns.push(fn)
      if (labelState) {
        try {
          fn(labelState)
        } catch (e) {
          report(e)
        }
      }
      if (dropped.length) paint()
      else sendHidden()
    },
    /** what onLabels last handed over, {labels, filter, all, palette}, or null before thimble sent it */
    labels: function () {
      return labelState
    },
    // The calls below change what thimble shows or stores, so each takes effect only during the analyst's own click or
    // key press in the view, never on load or on a timer. Each returns a promise that rejects with thimble's reason.
    /** turn a label on or off, by the id onLabels' `all` gives it */
    setLabel: function (id, on) {
      return labelCall('on', { id: String(id), on: !!on })
    },
    /** give a label's value one of the colours onLabels' palette holds; every view hears it through onLabels */
    setLabelColour: function (id, value, colour) {
      return labelCall('colour', { id: String(id), value: String(value), colour: String(colour) })
    },
    /** open thimble's label editor on the label with this id, or on a new label without one, in a popover over the page.
     *  opts.anchor, the element or rect {left, top, width, height} it stands beside (default: inside the page's top-left
     *  corner); opts.side, 'aside' (the default, to its right, else its left), 'left' (to its left, else its right) or
     *  'below'; opts.onClose(focused) runs
     *  when the editor closes, `focused` when it closed from inside (Escape, Cancel, Re-run) and the focus came back to
     *  the frame, onto the element that had it */
    editLabel: function (id, opts) {
      opts = opts || {}
      var args = { id: id == null ? null : String(id) }
      var at = anchorRect(opts.anchor)
      if (at) args.anchor = at
      if (opts.side === 'aside' || opts.side === 'below' || opts.side === 'left') args.side = opts.side
      var onClose = typeof opts.onClose === 'function' ? opts.onClose : null
      var had = document.activeElement
      return labelCall('edit', args, function (focus) {
        if (focus && had && had !== document.body && document.contains(had) && typeof had.focus === 'function') {
          try {
            had.focus({ preventScroll: true })
          } catch (e) {}
        }
        if (!onClose) return
        try {
          onClose(!!focus)
        } catch (e) {
          report(e)
        }
      })
    },
    newLabel: function () {
      return labelCall('edit', { id: null })
    },
    /** give the record `ref` the value `value` of a label (by id or name), stored as the analyst's own */
    mark: function (ref, label, value) {
      return labelCall('mark', { ref: String(ref), label: String(label), value: String(value) })
    },
    /** keep only the records that take a label's value (the label filter), or none with setFilter(null) */
    setFilter: function (label, value) {
      return labelCall('filter', label == null ? { label: null, value: null } : { label: String(label), value: String(value) })
    },
    /** the answer of reader.records(index, query), as a promise, with no time limit. `opts.key`: a newer fetch with the
     *  same key drops this one; `opts.signal`, an AbortSignal that drops it; a dropped fetch rejects with an AbortError
     *  and its reader's call is cancelled. `opts.onProgress(p)` hears {seconds, phase, done?, total?, note?} about once a
     *  second while it runs, and the page then shows the wait itself */
    fetch: function (query, opts) {
      opts = opts || {}
      return new Promise(function (resolve, reject) {
        var id = ++seq
        var key = opts.key == null ? null : String(opts.key)
        if (key != null) for (var k in pending) if (pending[k].key === key) dropFetch(+k)
        if (opts.signal && opts.signal.aborted) return reject(aborted())
        var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null
        pending[id] = { resolve: resolve, reject: reject, key: key, onProgress: onProgress, started: Date.now(), progress: null }
        if (opts.signal && opts.signal.addEventListener) opts.signal.addEventListener('abort', function () { dropFetch(id) })
        post({ type: P + 'fetch', id: id, query: query === undefined ? null : query, progress: !!onProgress, key: key })
        if (!onProgress) watchWait()
      })
    },
    /** a package the view's libs name, by its name (`d3-force`, or `three/examples/jsm/controls/OrbitControls.js` for a
     *  file inside one), as thimble bundled it into the view (backend view_libs) */
    lib: function (name) {
      var libs = window.__thimbleLibs || {}
      if (!Object.prototype.hasOwnProperty.call(libs, String(name))) throw new Error('the view loads no library ' + name + ': name it in libs')
      return libs[String(name)]
    },
    /** ask about a place, as a ⌘-click on an element with data-anchor does */
    cite: function (ref, text, element, el) {
      post({ type: P + 'cite', ref: String(ref), text: String(text || ''), element: String(element || ''), rect: el ? rectOf(el) : null })
    },
    /** fn({mode, data, args, width, card}) runs with what a card stored, in a card's frame only: at once when it has
     *  arrived, and again when the card is drawn anew */
    onInit: function (fn) {
      initFns.push(fn)
      if (init) {
        try {
          fn(init)
        } catch (e) {
          report(e)
        }
      }
    },
    /** the mark of the labels the page is given on one record or unit ref, {bar, names, values, spans, keep?}, or null:
     *  `bar` the colour of the first label that highlights it, `values` [{id, label, value, colour}] each label that
     *  does with its value; every colour one a canvas can draw (rgb(), or a hex) */
    markOf: function (ref) {
      return marks[String(ref)] || null
    },
    /** fn() runs whenever the marks change, such as while a label runs */
    onMarks: function (fn) {
      markFns.push(fn)
    },
    /** the height the page needs, in px; thimble fits the frame to it within the card's range */
    size: function (height) {
      ownSize = true
      post({ type: P + 'size', height: Number(height) || 0 })
    },
    /** a card's page has drawn what it was given, so its picture can be taken */
    settled: function () {
      post({ type: P + 'settled' })
    },
    /** the card's call's arguments the analyst's reshaping in the page would change ({} for none), in a card's frame;
     *  in a view opened from a card, setQuery(null) says the page dropped the card's arguments */
    setQuery: function (patch) {
      post({ type: P + 'setQuery', patch: patch && typeof patch === 'object' ? patch : cardMode ? {} : null })
    },
    /** open another place: a view ref, a file ref or any other ref thimble knows; with {browser: true} a file ref opens
     *  in the File browser, as the file shows there, rather than in a view */
    navigate: function (ref, opts) {
      post({ type: P + 'navigate', ref: String(ref), browser: !!(opts && opts.browser) })
    },
    /** bring an element, or a {left, top, width, height} box in the page's coordinates, into view in thimble, whose
     *  scrolling a page sized to its content cannot do itself */
    reveal: function (target) {
      var r = target && target.getBoundingClientRect ? rectOf(target) : target
      if (!r) return
      post({ type: P + 'reveal', rect: { left: +r.left || 0, top: +r.top || 0, width: +r.width || 0, height: +r.height || 0 } })
    },
    /** the fields the view's reader made rather than read, [{field, from, how}] */
    derived: derivedList,
    /** whether the view lists this field as derived */
    isDerived: function (name) {
      return Object.prototype.hasOwnProperty.call(derivedBy, String(name))
    },
    /** HTML for a field's name, `text` (the name by default) in an element with data-field */
    field: function (name, text) {
      return '<span data-field="' + escapeHtml(name) + '">' + escapeHtml(text == null ? name : text) + '</span>'
    },
    /** the URL of an image, audio or video file this view claims (its corpus-relative path), for an <img>, <audio> or
     *  <video> src: thimble streams it with Range requests, so a player can seek (views.media_route) */
    mediaUrl: function (path) {
      var base = window.__thimbleView && window.__thimbleView.media
      if (!base) throw new Error('this page was loaded without a media route')
      return base + '?path=' + encodeURIComponent(String(path).replace(/^\/+/, ''))
    },
  }
  // the key arrives before any of the view's listeners hears it: this listener is the first capturing one
  addEventListener(
    'message',
    function (e) {
      if (e.source !== parent || !e.data || e.data.type !== P + 'key') return
      e.stopImmediatePropagation()
      if (callKey == null && typeof e.data.key === 'string' && e.data.key) callKey = e.data.key
    },
    true,
  )
  addEventListener('message', function (e) {
    if (e.source !== parent) return
    var d = e.data || {}
    if (d.type === P + 'labelDone') {
      var c = calls[d.id]
      if (!c) return
      delete calls[d.id]
      if (d.error) {
        delete editorClosers[d.id]
        var err = new Error(String(d.error))
        err.name = 'ThimbleRefused'
        err.thimbleRefused = true
        c.reject(err)
      } else c.resolve(true)
    } else if (d.type === P + 'labelEditorClosed') {
      var closed = editorClosers[d.id]
      delete editorClosers[d.id]
      if (closed) closed(d.focus === true)
    } else if (d.type === P + 'open') {
      last = d.open || {}
      picked = null
      for (var i = 0; i < openers.length; i++) {
        try {
          openers[i](last)
        } catch (err) {
          report(err)
        }
      }
      startQuote(d.quote)
      if (dropping()) paint()
    } else if (d.type === P + 'result') {
      var p = pending[d.id]
      if (!p) return
      delete pending[d.id]
      if (d.error) p.reject(d.cancelled ? aborted() : new Error(d.error))
      else p.resolve(d.data)
      showWait()
    } else if (d.type === P + 'progress') {
      var q = pending[d.id]
      if (!q) return
      q.progress = { seconds: Number(d.seconds) || 0, phase: String(d.phase || 'call') }
      if (typeof d.done === 'number') q.progress.done = d.done
      if (typeof d.total === 'number') q.progress.total = d.total
      if (typeof d.note === 'string' && d.note) q.progress.note = d.note
      if (q.onProgress) {
        try {
          q.onProgress(q.progress)
        } catch (err) {
          report(err)
        }
      } else showWait()
    } else if (d.type === P + 'init') {
      init = { mode: String(d.mode || 'card'), data: d.data, args: d.args || {}, width: Number(d.width) || 0, card: d.card ? String(d.card) : null, key: String(d.key || '') }
      window.thimble.card = init
      for (var n = 0; n < initFns.length; n++) {
        try {
          initFns[n](init)
        } catch (err) {
          report(err)
        }
      }
    } else if (d.type === P + 'labels') {
      var marksChanged = takeMarks(d.marks)
      filter = d.filter && typeof d.filter === 'object' ? d.filter : null
      if (filter && typeof filter.colour === 'string') filter = realLabelList([filter])[0]
      answered = typeof d.answered === 'number' ? d.answered : -1
      var state = { labels: Array.isArray(d.on) ? realLabelList(d.on) : [], filter: filter }
      if (Array.isArray(d.all)) state.all = realLabelList(d.all)
      if (Array.isArray(d.palette)) state.palette = d.palette.map(realColour)
      var key = JSON.stringify(state)
      var labelsChanged = key !== labelKey
      if (labelsChanged) {
        labelKey = key
        labelState = state
        for (var f = 0; f < labelFns.length; f++) {
          try {
            labelFns[f](state)
          } catch (err) {
            report(err)
          }
        }
      }
      // the view kit's controls hear it before the marks are drawn, so a label turned on is drawn as the colour at once
      for (var kf = 0; kf < kitFns.length; kf++) {
        try {
          kitFns[kf](labelState, labelsChanged, marksChanged)
        } catch (err) {
          report(err)
        }
      }
      // a message that changes neither the labels nor a mark only says how far thimble has answered
      if (labelsChanged || marksChanged) paint()
      else sendHidden()
      if (marksChanged) {
        for (var g = 0; g < markFns.length; g++) {
          try {
            markFns[g]()
          } catch (err) {
            report(err)
          }
        }
      }
    } else if (d.type === P + 'cmd') {
      setCmdCursor(d.cursor)
      cmdHeld(d.on)
    } else if (d.type === P + 'state') {
      post({ type: P + 'state', id: d.id, state: pageState() })
    } else if (d.type === P + 'restore') {
      startRestore(d.state)
    }
  })
  addEventListener('error', function (e) {
    // the browser says so when a ResizeObserver's callback resized what it observes, which it then hears on the next
    // frame: a notice that nothing failed
    if (!e.error && typeof e.message === 'string' && e.message.indexOf('ResizeObserver loop') === 0) return
    report(e.error || e.message)
  })
  // a label call thimble refused is the page's to show; left unhandled, it is no error of the view
  addEventListener('unhandledrejection', function (e) {
    if (e.reason && (e.reason.name === 'AbortError' || e.reason.thimbleRefused)) return e.preventDefault()
    report(e.reason)
  })
  document.addEventListener('securitypolicyviolation', function (e) {
    post({ type: P + 'error', message: 'the view tried to reach ' + (e.blockedURI || 'the network') + ', which a view may not do' })
  })
  // While ⌘ is held the frame shows the page's ⌘ arrow as its cursor (the `cmd` message brings it), since the page
  // cannot draw over the frame. The frame's own key events keep it right while the frame has the focus.
  var cmdCursor = ''
  var cmdShown = false
  var cmdSheet = null
  function setCmdCursor(cursor) {
    if (typeof cursor !== 'string' || !cursor || cursor === cmdCursor) return
    cmdCursor = cursor
    if (document.documentElement) document.documentElement.style.setProperty('--thimble-cmd-cursor', cursor)
  }
  // the attribute changes only when the state does, since this runs on every move of the mouse
  function cmdHeld(on) {
    var root = document.documentElement
    on = !!on && !!cmdCursor
    if (!root || on === cmdShown) return
    cmdShown = on
    if (on && !cmdSheet) {
      cmdSheet = document.createElement('style')
      cmdSheet.setAttribute('data-thimble', 'cmd')
      cmdSheet.textContent = 'html[data-thimble-cmd],html[data-thimble-cmd] *{cursor:var(--thimble-cmd-cursor)!important}'
      ;(document.head || root).appendChild(cmdSheet)
    }
    if (on) root.setAttribute('data-thimble-cmd', '')
    else root.removeAttribute('data-thimble-cmd')
  }
  // Off a Mac, Ctrl does what ⌘ does, since the desktop keeps the Super key for itself (the page's lib/platform.ts)
  var MAC = /mac|iphone|ipad|ipod/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '')
  function held(e) {
    return MAC ? e.metaKey : e.metaKey || e.ctrlKey
  }
  function isPointKey(key) {
    return key === 'Meta' || (!MAC && key === 'Control')
  }
  // What ⌘ points at, which it outlines through the page's own highlight: the anchored element under the pointer with
  // its ref, else the element itself as a part of the view (a legend, a control), asked about as the view, since only
  // the view names it; the page's bare background is the whole view. Null in a page loaded without its view.
  function anchorAt(t) {
    var el = t && t.closest ? t.closest('[data-anchor]') : null
    if (el) return { el: el, ref: el.getAttribute('data-anchor') }
    var slug = window.thimble.view && window.thimble.view.slug
    var own = cardMode ? (init && init.card ? 'card:' + init.card : null) : slug ? 'view:' + slug : null
    if (!own || !t || t.nodeType !== 1) return null
    return { el: t === document.body ? document.documentElement : t, ref: own }
  }
  document.addEventListener(
    'mousemove',
    function (e) {
      cmdHeld(held(e))
      var hit = held(e) ? anchorAt(e.target) : null
      var el = hit ? hit.el : null
      if (el === pointed) return
      pointed = el
      post({ type: P + 'point', rect: el ? rectOf(el) : null })
    },
    true,
  )
  addEventListener('keydown', function (e) {
    if (isPointKey(e.key)) cmdHeld(true)
  })
  addEventListener('keyup', function (e) {
    if (!held(e)) cmdHeld(false)
    if (pointed && !held(e)) {
      pointed = null
      post({ type: P + 'point', rect: null })
    }
  })
  addEventListener('blur', function () {
    cmdHeld(false)
  })
  document.addEventListener(
    'click',
    function (e) {
      if (held(e)) {
        var hit = anchorAt(e.target)
        if (!hit) return
        e.preventDefault()
        e.stopPropagation()
        post({ type: P + 'cite', ref: hit.ref, text: textOf(hit.el), element: nameOf(hit.el), rect: rectOf(hit.el) })
        return
      }
      var own = e.target && e.target.closest ? e.target.closest('[data-anchor]') : null
      if (own) picked = own.getAttribute('data-anchor')
      // a link never takes the frame anywhere: the frame has no network, and a view moves with thimble.navigate
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null
      if (a) e.preventDefault()
    },
    true,
  )
  // The labels the analyst turns on, drawn over the records the view shows: every data-anchor that appears is reported
  // (anchors), and the page answers with the marks of those records (labels). A marked element gets data-thimble-label
  // and a bar in the first label's colour along its left edge, drawn as a box-shadow added to the view's own
  // (data-thimble-own): inset when the left padding has room or when a box that hides overflow, or the frame's edge,
  // would cut a bar outside it; else just outside. Only the outermost element carrying a record's ref takes the bar. Span labels are highlighted with the CSS Custom Highlight API, leaving the DOM as it is.
  // With several choices of the kit's Colour by, the bar is a band per choice (bandsAt), side by side from the left in
  // the order of the strip's lanes, each in the colour of the record's value of that choice and empty where it has none,
  // as a slice of the strip: in the left padding a gradient behind the text (data-thimble-edge="bands"), so an empty
  // band shows the element's own background; with no room there, shadows just outside ("bands-out"), and on an element
  // with a background image of its own inset shadows ("bands-in"), their gaps in the colour behind (data-thimble-gap).
  var marks = {}
  var reported = {}
  var unsent = []
  var sentN = 0 // anchored refs reported so far (anchors' seq)
  var answered = -1 // the seq the last labels message answers for
  var marked = new Set() // the elements that draw a bar
  var lit = []
  var sheet = null
  var sendTimer = null
  var paintTimer = null
  var paintFrame = null
  var HL = typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function'
  var BAR = 3 // px, the file view's bar
  // --thimble-own is reset on every marked element, since a custom property is inherited and a record marked inside
  // another would draw the outer one's shadow
  var BARS =
    '[data-thimble-edge]{--thimble-own:0 0 transparent}' +
    '[data-thimble-edge="in"]{box-shadow:inset ' + BAR + 'px 0 0 var(--thimble-label),var(--thimble-own)!important}' +
    // a row's cells paint over the row's own shadow when they have a background, so a row's bar is drawn on its first
    // cell as well
    'tr[data-thimble-edge="in"]>:first-child{box-shadow:inset ' + BAR + 'px 0 0 var(--thimble-label)!important}' +
    '[data-thimble-edge="out"]{box-shadow:-' + 2 * BAR + 'px 0 0 -' + BAR + 'px var(--thimble-label),var(--thimble-own)!important}' +
    // an SVG element draws no box-shadow, so a mark there is a halo in the label's colour around the shape; a group's
    // text keeps no halo, so its label stays sharp
    '[data-thimble-edge="svg"]:not(g),g[data-thimble-edge="svg"]>:not(text):not(title){filter:drop-shadow(0 0 1.5px var(--thimble-label)) drop-shadow(0 0 1.5px var(--thimble-label))}'
  // the bands of several choices (bandVars gives each set its --thimble-bands*); a row's on its first cell, as its bar
  var BANDS =
    '[data-thimble-edge="bands"]:not(tr),tr[data-thimble-edge="bands"]>:first-child{background-image:var(--thimble-bands)!important;background-repeat:no-repeat!important;background-position:0 0!important;background-size:auto!important}' +
    '[data-thimble-edge="bands"]{box-shadow:var(--thimble-own)!important}' +
    '[data-thimble-edge="bands-in"]{box-shadow:var(--thimble-bands-in),var(--thimble-own)!important}' +
    'tr[data-thimble-edge="bands-in"]>:first-child{box-shadow:var(--thimble-bands-in)!important}' +
    '[data-thimble-edge="bands-out"]{box-shadow:var(--thimble-bands-out),var(--thimble-own)!important}'
  var BAND_GAP = 1 // px between two bands, as between two lanes of the strip
  var BANDS_ROOM = 9 // px the bands take at most
  var GAP = 'var(--thimble-gap,transparent)'
  // a band's width for `n` choices: the bar's for one or two, narrower as more come, so that they fit BANDS_ROOM; and
  // the width of all `n`
  function bandW(n) {
    return Math.max(1, Math.min(BAR, Math.floor((BANDS_ROOM - (n - 1) * BAND_GAP) / n)))
  }
  function bandsW(n) {
    return n * bandW(n) + (n - 1) * BAND_GAP
  }
  // One set of bands (`key`, their colours joined by |, '' for none) as the custom properties its elements draw by: the
  // gradient, and the inset and outside shadows, the band nearest the text on top, each gap and empty band in the
  // colour behind the element. An outside band is a shadow as the bar's (-2·BAR 0 0 -BAR for the one bar).
  function bandVars(key) {
    var cs = key.split('|')
    var n = cs.length
    var w = bandW(n)
    var all = bandsW(n)
    var grad = []
    var inner = []
    var outer = []
    for (var i = 0; i < n; i++) {
      var x0 = i * (w + BAND_GAP)
      var x1 = x0 + w
      grad.push((cs[i] || 'transparent') + ' ' + x0 + 'px ' + x1 + 'px')
      inner.push('inset ' + x1 + 'px 0 0 ' + (cs[i] || GAP))
      if (i === n - 1) continue
      grad.push('transparent ' + x1 + 'px ' + (x1 + BAND_GAP) + 'px')
      inner.push('inset ' + (x1 + BAND_GAP) + 'px 0 0 ' + GAP)
    }
    grad.push('transparent ' + all + 'px')
    for (var j = n - 1; j >= 0; j--) {
      var far = all - j * (w + BAND_GAP)
      outer.push(-(far + BAR) + 'px 0 0 -' + BAR + 'px ' + (cs[j] || GAP))
      if (j) outer.push(-(far + BAND_GAP + BAR) + 'px 0 0 -' + BAR + 'px ' + GAP)
    }
    return '--thimble-bands:linear-gradient(to right,' + grad.join(',') + ');--thimble-bands-in:' + inner.join(',') + ';--thimble-bands-out:' + outer.join(',')
  }
  // The width the bar or the bands take now, as --thimble-bands-w on the root (BAR for one choice, bandsW(n) for n), so
  // that a part that keeps them in its left padding (viewer_kit.css .thimble-card) widens that padding when more come
  // than BANDS_ROOM holds, and its text never sits under a band. In a sheet of its own, written before the elements are
  // measured, so that they are read with the padding they will have; written once Color by first takes two choices.
  var roomSheet = null
  var roomW = null
  function setRoom(w) {
    if (w === roomW) return
    roomW = w
    if (!roomSheet) {
      roomSheet = document.createElement('style')
      roomSheet.setAttribute('data-thimble', 'bands-room')
      ;(document.head || document.documentElement).appendChild(roomSheet)
    }
    roomSheet.textContent = ':root{--thimble-bands-w:' + w + 'px}'
  }
  var DROP = '[data-thimble-drop="hide"]{display:none!important}[data-thimble-drop="dim"]{opacity:.25!important}'
  var COLOUR = /^[\w\s(),.#%-]+$/
  var SHADOW = /^[\w\s(),.#%\/-]+$/ // a computed box-shadow: colours, lengths, inset, commas between shadows
  function hasMarks() {
    for (var k in marks) return true
    return false
  }
  // With a label filter on, a page that does not filter its own records (it registered no onLabels) has every
  // anchored element hidden whose ref the filter does not keep and that holds no kept element: an HTML element leaves
  // the layout, and an SVG shape is dimmed, since removing it would break the drawing. A card's page, whose records its
  // code chose, has them all dimmed instead. The place the page was opened at stays, since the analyst asked for it.
  // Whether anything is dropped. Only the attributes that change are written, since every write makes the browser work
  // out the element's style again.
  var dropped = []
  function dropping() {
    return !!filter && (cardMode || !labelFns.length)
  }
  function drop() {
    if (!dropping()) {
      for (var i = 0; i < dropped.length; i++) if (unset(dropped[i], 'data-thimble-drop')) hiddenTurn++
      dropped = []
      return false
    }
    var opened = last && last.ref ? String(last.ref) : null
    var els = document.querySelectorAll('[data-anchor]')
    var held = []
    for (var j = 0; j < els.length; j++) {
      var ref = els[j].getAttribute('data-anchor')
      var m = marks[ref]
      if ((m && m.keep) || ref === opened) held.push(els[j])
    }
    var keep = new Set(held)
    for (var h = 0; h < held.length; h++) for (var a = held[h].parentElement; a; a = a.parentElement) keep.add(a)
    var now = []
    for (var k = 0; k < els.length; k++) {
      if (keep.has(els[k])) continue
      set(els[k], 'data-thimble-drop', cardMode || els[k] instanceof SVGElement ? 'dim' : 'hide')
      now.push(els[k])
    }
    var still = new Set(now)
    for (var d = 0; d < dropped.length; d++) if (!still.has(dropped[d]) && unset(dropped[d], 'data-thimble-drop')) hiddenTurn++
    dropped = now
    return true
  }
  // an attribute written only when its value differs, and removed only when present
  function set(el, name, value) {
    if (el.getAttribute(name) !== value) el.setAttribute(name, value)
  }
  function unset(el, name) {
    if (!el.hasAttribute(name)) return false
    el.removeAttribute(name)
    return true
  }
  // How many anchored refs the filter drops in the page, told to thimble whenever it or the page's own filtering
  // changes. An element whose ref thimble has not answered for yet is hidden too, so until thimble has answered for
  // every ref reported the count is null.
  var hiddenKey = ''
  function sendHidden() {
    var refs = {}
    var n = 0
    for (var i = 0; i < dropped.length; i++) {
      var r = dropped[i].getAttribute('data-anchor')
      if (r && !refs[r]) {
        refs[r] = true
        n++
      }
    }
    if (n && (unsent.length || answered !== sentN)) n = null
    var self = !!filter && !cardMode && labelFns.length > 0
    var key = n + ':' + self
    if (key === hiddenKey) return
    hiddenKey = key
    post({ type: P + 'hidden', n: n, self: self })
  }
  function note(el) {
    var ref = el.getAttribute('data-anchor')
    if (!ref || reported[ref]) return
    reported[ref] = true
    unsent.push(ref)
  }
  // note every anchored element in node, itself included; whether there was one
  function collect(node) {
    if (node.nodeType !== 1) return false
    var own = node.hasAttribute('data-anchor')
    if (own) note(node)
    var all = node.querySelectorAll('[data-anchor]')
    for (var i = 0; i < all.length; i++) note(all[i])
    return own || all.length > 0
  }
  // The refs of the anchored elements in the frame's viewport not reported in view before (anchors' and seen's `seen`)
  var seenSent = {}
  var seenTimer = null
  function newlySeen() {
    var out = []
    var vw = window.innerWidth
    var vh = window.innerHeight
    var els = document.querySelectorAll('[data-anchor]')
    for (var i = 0; i < els.length; i++) {
      var ref = els[i].getAttribute('data-anchor')
      if (!ref || seenSent[ref]) continue
      var r = els[i].getBoundingClientRect()
      if (!r.width || !r.height || r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue
      seenSent[ref] = true
      out.push(ref)
    }
    return out
  }
  function sendSeen() {
    seenTimer = null
    var refs = newlySeen()
    if (refs.length) post({ type: P + 'seen', refs: refs })
  }
  function seenSoon() {
    if (seenTimer != null) clearTimeout(seenTimer)
    seenTimer = setTimeout(sendSeen, 120)
  }
  document.addEventListener('scroll', seenSoon, { capture: true, passive: true })
  window.addEventListener('resize', seenSoon)
  function sendAnchors() {
    sendTimer = null
    if (!unsent.length) return
    sentN += unsent.length
    post({ type: P + 'anchors', refs: unsent, seq: sentN, seen: newlySeen() })
    unsent = []
  }
  // the element's text nodes joined, with where each starts, so a marked text found across several nodes becomes one
  // range
  function joined(el) {
    var nodes = []
    var starts = []
    var text = ''
    var walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (var n = walk.nextNode(); n; n = walk.nextNode()) {
      var up = n.parentNode && n.parentNode.nodeName
      if (up === 'SCRIPT' || up === 'STYLE') continue
      var chrome = n.parentElement && n.parentElement.closest('[data-thimble-chrome]')
      if (chrome && chrome !== el && el.contains(chrome)) continue
      nodes.push(n)
      starts.push(text.length)
      text += n.data
    }
    return { nodes: nodes, starts: starts, text: text }
  }
  function at(t, pos) {
    var lo = 0
    var hi = t.nodes.length - 1
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1
      if (t.starts[mid] <= pos) lo = mid
      else hi = mid - 1
    }
    return [t.nodes[lo], pos - t.starts[lo]]
  }
  function rangesOf(t, needle, out) {
    if (!needle || !t.nodes.length) return
    for (var i = t.text.indexOf(needle); i >= 0; i = t.text.indexOf(needle, i + needle.length)) {
      var r = document.createRange()
      var a = at(t, i)
      var b = at(t, i + needle.length)
      r.setStart(a[0], a[1])
      r.setEnd(b[0], b[1])
      out.push(r)
    }
  }
  // What a bar needs of an element, read once and kept: its edge (`in` when the left padding has room or a box that
  // hides overflow, or the frame's edge, would cut a bar outside it, else `out`) and the box-shadow the view draws on it
  // (`own`), read while the bar's own shadow is off it. Read again when the element's class changes, which may change
  // both (a ring around the record a citation opened), when the frame's width changes, and, for an element that was not
  // drawn when it was read (hidden), once the bridge shows something it hid.
  var measured = new WeakMap()
  var measureTurn = 0
  var hiddenTurn = 0
  var measuredWidth = window.innerWidth
  window.addEventListener('resize', function () {
    if (window.innerWidth === measuredWidth) return
    measuredWidth = window.innerWidth
    measureTurn++
    if (marked.size) paintSoon()
  })
  // the left edge, in the frame's viewport, of what the element's ancestors that hide overflow let show; `cut` caches
  // it per ancestor for one paint
  function clipLeft(el, cut) {
    var a = el.parentElement
    if (!a || a === document.documentElement || a === document.body) return 0
    if (cut.has(a)) return cut.get(a)
    var left = clipLeft(a, cut)
    if (getComputedStyle(a).overflowX !== 'visible') left = Math.max(left, a.getBoundingClientRect().left + a.clientLeft)
    cut.set(a, left)
    return left
  }
  // With `n` choices of Colour by past one, the bands take the bar's place (bandsW wide), and the element also gets how
  // they are drawn (`bands`, the edge they take) and, for shadows, the colour behind the element (`gap`).
  function measure(el, cut, n) {
    var style = getComputedStyle(el)
    var shadow = style.boxShadow
    // whether the bar fits in the element's left padding with a gap before its text (a row's, its first cell's)
    var box = el.tagName === 'TR' && el.cells && el.cells.length ? el.cells[0] : el
    var boxStyle = box === el ? style : getComputedStyle(box)
    var w = n > 1 ? bandsW(n) : BAR
    var room = parseFloat(boxStyle.paddingLeft) >= w + BAR
    var r = el.getBoundingClientRect()
    var got = {
      turn: measureTurn,
      hidden: r.width || r.height ? null : hiddenTurn,
      edge: room || r.left - w < clipLeft(el, cut) ? 'in' : 'out',
      own: shadow && shadow !== 'none' && SHADOW.test(shadow) ? shadow : null,
    }
    if (n > 1) {
      var image = boxStyle.backgroundImage
      got.bands = got.edge === 'out' ? 'bands-out' : image && image !== 'none' ? 'bands-in' : 'bands'
      if (got.bands !== 'bands') got.gap = behind(got.edge === 'out' ? el.parentElement : box)
    }
    return got
  }
  // the colour behind an element's edge: the first background colour from `from` up that shows, else the canvas's
  function behind(from) {
    for (var a = from; a && a.nodeType === 1; a = a.parentElement) {
      var c = getComputedStyle(a).backgroundColor
      if (!c || c === 'transparent' || /^rgba\(.*,\s*0\)$/.test(c)) continue
      return COLOUR.test(c) ? c : 'Canvas'
    }
    return 'Canvas'
  }
  function stale(el) {
    var got = measured.get(el)
    return !got || got.turn !== measureTurn || (got.hidden != null && got.hidden !== hiddenTurn)
  }
  // drawn again before the browser draws the changed page, so records a redraw brings never show unmarked; a frame
  // the browser does not draw (hidden) gets the marks on the timer
  function paintSoon() {
    if (paintTimer != null) return
    paintTimer = setTimeout(paint, 100)
    if (typeof requestAnimationFrame === 'function') paintFrame = requestAnimationFrame(paint)
  }
  // The mark of the label the view kit colours by on a record (colourHook.label): that label's entry in the mark's
  // values, else, for a mark from before values were sent, its bar when the label is among its names
  function valueIn(m, hook) {
    if (!m) return null
    var vs = Array.isArray(m.values) ? m.values : null
    if (vs) {
      for (var i = 0; i < vs.length; i++) if (vs[i] && vs[i].id === hook.label) return vs[i]
      return null
    }
    if (typeof m.bar === 'string' && Array.isArray(m.names) && m.names.indexOf(hook.name) >= 0) return { id: hook.label, label: hook.name, value: hook.name, colour: m.bar }
    return null
  }
  function outermost(el, ref) {
    for (var a = el.parentElement; a; a = a.parentElement) if (a.getAttribute('data-anchor') === ref) return false
    return true
  }
  // A record's bands for Colour by's choices (colourHook.tracks, the choices past the first): `first`, the first's
  // colour, then each other's: a label's value on the record (its mark), a field's value as the element says it in
  // data-colour-tracks (the kit's attr) in that field's colour; null where the record has none. Null when none has a
  // colour.
  function bandsAt(el, m, first, tracks) {
    var out = [typeof first === 'string' && COLOUR.test(first) ? first : null]
    var any = out[0] != null
    var said
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i] || {}
      var c = null
      if (t.label != null) {
        var hit = valueIn(m, t)
        c = hit ? hit.colour : null
      } else if (t.field != null && typeof t.colourOf === 'function') {
        if (said === undefined) said = tracksOf(el)
        var v = said ? said[t.at] : null
        c = v == null || v === '' ? null : t.colourOf(String(v))
      }
      if (typeof c !== 'string' || !COLOUR.test(c)) c = null
      if (c) any = true
      out.push(c)
    }
    return any ? out : null
  }
  // a set of bands as one string (their colours joined by |, '' for none), by which it has its slot
  function bandKey(bands) {
    return bands
      .map(function (c) {
        return c || ''
      })
      .join('|')
  }
  // what an element with bands shows: the names of the choices that give it a colour
  function namesOf(bands, hook, tracks) {
    var out = []
    for (var i = 0; i < bands.length; i++) if (bands[i]) out.push(i ? (tracks[i - 1] && tracks[i - 1].name) || '' : hook.name)
    return out.join(', ')
  }
  function tracksOf(el) {
    var raw = el.getAttribute('data-colour-tracks')
    if (!raw) return null
    try {
      var got = JSON.parse(raw)
      return Array.isArray(got) ? got : null
    } catch (e) {
      return null
    }
  }
  // With the view kit's Colour by in the page (colourHook, viewer_colour.js), the bar shows the one thing the analyst
  // colours by, on the records alone (the anchored elements). For a label, the outermost element of each anchored record
  // that label highlights takes the bar in its value's colour, with data-thimble-label as before. For a field of the
  // view, every anchored element that says its value in data-colour takes the bar in that value's colour, with
  // data-thimble-colour (an SVG shape the page colours itself), and a group's row, which has no anchor, takes none; the
  // labels that are on then draw no bar, and their texts stay highlighted. An element whose value
  // the analyst turned off takes no bar, nor a band of the first choice, and stays: Color by only colors, and a label's
  // texts of that value take the plain ink (the hook's `off`). With Color by Off (mode 'off') no element takes a bar.
  // One colour encoding: with Colour by in the page, only the chosen label's texts are highlighted in its colours; the
  // texts of the other labels that are on, and every label's with a field or Off chosen, are highlighted in the plain
  // ink of a highlight (--hl-bg). A span names its label (`id`); one from before spans did is
  // the chosen label's when it has the colour of that label's value on the record.
  // The colours bars and highlights take, the sets of bands, the colours behind them and the views' own shadows, each by
  // a number kept from paint to paint, so an element keeps its attributes and the sheet its text while the page
  // scrolls; numbered afresh only when most of them are no longer used, and forgotten when nothing is marked.
  var colourSlots = []
  var ownSlots = []
  var bandSlots = []
  var gapSlots = []
  var bandsN = 1 // the choices the bands were measured for
  function slotIn(list, v) {
    var k = list.indexOf(v)
    return k < 0 ? list.push(v) - 1 : k
  }
  var SVG_EDGE = { edge: 'svg', own: null }
  var spanRanges = new Map() // element -> {key, out: [[colour, or null for the plain ink, Range]]}, as last found
  var textChanged = new Set() // elements with ranges whose text changed since (the observer)
  var greyShown = false
  function unbar(el) {
    unset(el, 'data-thimble-label')
    unset(el, 'data-thimble-colour')
    unset(el, 'data-thimble-bar')
    unset(el, 'data-thimble-edge')
    unset(el, 'data-thimble-own')
    unset(el, 'data-thimble-bands')
    unset(el, 'data-thimble-gap')
  }
  // The highlights of the span texts, from the ranges paint found (spanRanges). WebKit checks every range of a highlight
  // for each piece of text it draws, so with more than NEAR_MAX ranges on the page only those of the elements near the
  // frame's view are registered (an IntersectionObserver), and a scroll brings in the others a frame after they show.
  var NEAR_MAX = 300
  var nearObs = null
  var near = new Set()
  var watched = new Set()
  var lightFrame = null
  function lightSoon() {
    if (lightFrame == null) lightFrame = requestAnimationFrame(light)
  }
  function light() {
    lightFrame = null
    var total = 0
    var anyGrey = false
    spanRanges.forEach(function (got) {
      total += got.out.length
      for (var i = 0; i < got.out.length && !anyGrey; i++) if (got.out[i][0] == null) anyGrey = true
    })
    var only = total > NEAR_MAX && typeof IntersectionObserver === 'function'
    if (only) {
      if (!nearObs)
        nearObs = new IntersectionObserver(
          function (entries) {
            for (var i = 0; i < entries.length; i++) {
              if (entries[i].isIntersecting) near.add(entries[i].target)
              else near.delete(entries[i].target)
            }
            lightSoon()
          },
          { rootMargin: '50% 0px' },
        )
      spanRanges.forEach(function (_, el) {
        if (watched.has(el)) return
        watched.add(el)
        nearObs.observe(el)
      })
      watched.forEach(function (el) {
        if (spanRanges.has(el)) return
        watched.delete(el)
        near.delete(el)
        nearObs.unobserve(el)
      })
    } else if (nearObs) {
      nearObs.disconnect()
      nearObs = null
      watched.clear()
      near.clear()
    }
    var bySlot = []
    var grey = []
    spanRanges.forEach(function (got, el) {
      if (only && !near.has(el)) return
      for (var i = 0; i < got.out.length; i++) {
        var col = got.out[i][0]
        if (col == null) grey.push(got.out[i][1])
        else {
          var k = slotIn(colourSlots, col)
          ;(bySlot[k] = bySlot[k] || []).push(got.out[i][1])
        }
      }
    })
    for (var o = 0; o < lit.length; o++) CSS.highlights.delete(lit[o])
    lit = []
    for (var h = 0; h <= bySlot.length; h++) {
      var hs = h < bySlot.length ? bySlot[h] : grey
      if (!hs || !hs.length) continue
      var name = h < bySlot.length ? 'thimble-label-' + h : 'thimble-label-grey'
      var hl = new Highlight()
      for (var n = 0; n < hs.length; n++) hl.add(hs[n])
      CSS.highlights.set(name, hl)
      lit.push(name)
    }
    greyShown = anyGrey
  }
  // Each paint works out what every anchored element should show, then writes only the attributes that differ and
  // reads the style of only the elements not measured yet, all reads before the bar's writes, so an element the page
  // keeps as it is costs the browser nothing and the page's style is worked out at most once.
  function paint() {
    if (paintTimer != null) clearTimeout(paintTimer)
    if (paintFrame != null) cancelAnimationFrame(paintFrame)
    paintTimer = null
    paintFrame = null
    var hook = colourHook && (colourHook.mode === 'label' || colourHook.mode === 'field') ? colourHook : null
    var plain = !!(colourHook && colourHook.mode === 'off') // Color by: Off, which draws no bar
    // Colour by's choices past the first, each a band beside the first's; the elements are measured again when their
    // number changes, since the bands take more room than the bar
    var tracks = hook && Array.isArray(hook.tracks) ? hook.tracks : []
    var n = tracks.length + 1
    if (n !== bandsN) {
      bandsN = n
      measureTurn++
    }
    if (n > 1 || roomSheet) setRoom(n > 1 ? bandsW(n) : BAR)
    var todo = [] // [element, bar colour (null for bands), what it shows, 'label' or 'colour', mark, bands or null]
    var spanned = []
    if (hasMarks() || hook) {
      var els = document.querySelectorAll(hook && hook.mode === 'field' ? '[data-anchor],[data-colour]' : '[data-anchor]')
      for (var j = 0; j < els.length; j++) {
        var el = els[j]
        if (el.tagName === 'CANVAS') continue
        var ref = el.getAttribute('data-anchor')
        var m = ref ? marks[ref] : null
        var unmarked = el.hasAttribute('data-anchor-unmarked')
        var bar = null
        var bands = null
        var shows = ''
        var kind = 'label'
        if (plain) {
          if (m && !unmarked && outermost(el, ref)) spanned.push([el, m])
          continue
        } else if (!hook) {
          if (!m || unmarked || !outermost(el, ref)) continue
          bar = m.bar
          shows = (m.names || []).join(', ')
        } else if (hook.mode === 'label') {
          if (!ref || !outermost(el, ref)) continue
          // a value turned off draws no bar
          var hit = valueIn(m, hook)
          if (hit && hook.off(hit.value)) hit = null
          if (m && !unmarked) spanned.push([el, m])
          if (unmarked) continue
          bar = hit ? hit.colour : null
          if (n > 1) bands = bandsAt(el, m, bar, tracks)
          if (!hit && !bands) continue
          shows = bands ? namesOf(bands, hook, tracks) : hook.name
        } else {
          var own = el.hasAttribute('data-colour')
          var v = own ? el.getAttribute('data-colour') : null
          if (v === '') v = null
          if (m && !unmarked && outermost(el, ref)) spanned.push([el, m])
          // the bar marks a record, the element the view anchors: a group's row (no anchor) takes none; a value turned
          // off has no colour (hook.colourOf)
          if (!own || !ref || unmarked || el instanceof SVGElement) continue
          if (v != null) bar = hook.colourOf(v)
          if (n > 1) bands = bandsAt(el, m, bar, tracks)
          if (v == null && !bands) continue
          shows = v == null ? '' : v
          kind = 'colour'
        }
        if (bands && el instanceof SVGElement) {
          // a shape draws a halo, in the first colour it has
          bar = bands.filter(Boolean)[0]
          bands = null
        }
        if (!bands && (typeof bar !== 'string' || !COLOUR.test(bar))) continue
        todo.push([el, bands ? null : bar, shows, kind, m, bands])
        if (!hook) spanned.push([el, m])
      }
    }
    // what hides elements first (the label filter), so the elements measured below are read as they will be drawn
    var dropOn = drop()
    // the reads, of the elements to bar not measured yet; one that draws a bar already has its edge taken off, since the
    // view's own shadow is read without the bar's
    var reads = []
    for (var a = 0; a < todo.length; a++) if (!(todo[a][0] instanceof SVGElement) && stale(todo[a][0])) reads.push(todo[a][0])
    if (reads.length) {
      for (var b = 0; b < reads.length; b++) unset(reads[b], 'data-thimble-edge')
      var cut = new Map()
      for (var c = 0; c < reads.length; c++) measured.set(reads[c], measure(reads[c], cut, n))
    }
    // the texts of the span labels, each in its colour, or in the plain ink when it is not the Colour by choice
    var used = new Set()
    var usedOwn = new Set()
    var usedBands = new Set()
    var usedGaps = new Set()
    for (var u = 0; u < todo.length; u++) {
      if (todo[u][1]) used.add(todo[u][1])
      var mu = todo[u][0] instanceof SVGElement ? null : measured.get(todo[u][0])
      if (mu && mu.own) usedOwn.add(mu.own)
      if (!todo[u][5]) continue
      usedBands.add(bandKey(todo[u][5]))
      if (mu && mu.gap) usedGaps.add(mu.gap)
    }
    var texts = [] // [element, [[text, colour or null]]]
    for (var p = 0; p < spanned.length; p++) {
      var sm = spanned[p][1]
      var spans = HL && sm && Array.isArray(sm.spans) ? sm.spans : []
      if (!spans.length) continue
      var chosen = hook && hook.mode === 'label' ? valueIn(sm, hook) : null
      // the texts of a value turned off take the plain ink, as its record takes no bar
      if (chosen && hook.off(chosen.value)) chosen = null
      var list = []
      for (var s = 0; s < spans.length; s++) {
        var sp = spans[s] || {}
        if (typeof sp.colour !== 'string' || !COLOUR.test(sp.colour)) continue
        var mine = !colourHook || (!!chosen && (sp.id != null ? String(sp.id) === String(hook.label) : sp.colour === chosen.colour))
        list.push([String(sp.text || ''), mine ? sp.colour : null])
        if (mine) used.add(sp.colour)
      }
      if (list.length) texts.push([spanned[p][0], list])
    }
    var renumbered = false
    if (!todo.length && !texts.length) {
      renumbered = colourSlots.length > 0
      colourSlots = []
      ownSlots = []
      bandSlots = []
      gapSlots = []
    } else {
      if (colourSlots.length > 16 && colourSlots.length > 2 * used.size) {
        colourSlots = []
        renumbered = true
      }
      if (ownSlots.length > 16 && ownSlots.length > 2 * usedOwn.size) ownSlots = []
      if (bandSlots.length > 16 && bandSlots.length > 2 * usedBands.size) bandSlots = []
      if (gapSlots.length > 16 && gapSlots.length > 2 * usedGaps.size) gapSlots = []
      used.forEach(function (col) {
        slotIn(colourSlots, col)
      })
    }
    // the writes: only the attributes that differ
    var now = new Set()
    for (var d = 0; d < todo.length; d++) {
      var e2 = todo[d][0]
      var mm = e2 instanceof SVGElement ? SVG_EDGE : measured.get(e2)
      set(e2, todo[d][3] === 'label' ? 'data-thimble-label' : 'data-thimble-colour', todo[d][2])
      unset(e2, todo[d][3] === 'label' ? 'data-thimble-colour' : 'data-thimble-label')
      var bs = todo[d][5]
      if (bs) {
        set(e2, 'data-thimble-bands', String(slotIn(bandSlots, bandKey(bs))))
        set(e2, 'data-thimble-edge', mm.bands || mm.edge)
        if (mm.gap) set(e2, 'data-thimble-gap', String(slotIn(gapSlots, mm.gap)))
        else unset(e2, 'data-thimble-gap')
        unset(e2, 'data-thimble-bar')
      } else {
        set(e2, 'data-thimble-bar', String(slotIn(colourSlots, todo[d][1])))
        set(e2, 'data-thimble-edge', mm.edge)
        unset(e2, 'data-thimble-bands')
        unset(e2, 'data-thimble-gap')
      }
      if (mm.own) set(e2, 'data-thimble-own', String(slotIn(ownSlots, mm.own)))
      else unset(e2, 'data-thimble-own')
      now.add(e2)
    }
    marked.forEach(function (e) {
      if (!now.has(e)) unbar(e)
    })
    marked = now
    // the ranges of the texts, found again only in an element whose texts or text changed
    var lit2 = renumbered
    var ranged = new Map()
    for (var x = 0; x < texts.length; x++) {
      var te = texts[x][0]
      var key = texts[x][1].map(function (y) {
        return y[0] + '\u0000' + (y[1] == null ? '' : y[1])
      }).join('\u0001')
      var had = spanRanges.get(te)
      if (had && had.key === key && !textChanged.has(te)) {
        ranged.set(te, had)
        continue
      }
      var t = joined(te)
      var out = []
      for (var z = 0; z < texts[x][1].length; z++) {
        var rs = []
        rangesOf(t, texts[x][1][z][0], rs)
        for (var q = 0; q < rs.length; q++) out.push([texts[x][1][z][1], rs[q]])
      }
      ranged.set(te, { key: key, out: out })
      lit2 = true
    }
    if (!lit2) spanRanges.forEach(function (_, e) {
      if (!ranged.has(e)) lit2 = true
    })
    spanRanges = ranged
    textChanged.clear()
    if (HL && lit2) light()
    var css = (marked.size ? BARS : '') + (usedBands.size ? BANDS : '') + (dropOn ? DROP : '')
    sendHidden()
    for (var k2 = 0; k2 < colourSlots.length; k2++) {
      css += '[data-thimble-bar="' + k2 + '"]{--thimble-label:' + colourSlots[k2] + '}'
      css += '::highlight(thimble-label-' + k2 + '){background-color:color-mix(in oklab,' + colourSlots[k2] + ' 24%,transparent)}'
    }
    for (var w = 0; w < ownSlots.length; w++) css += '[data-thimble-own="' + w + '"]{--thimble-own:' + ownSlots[w] + '}'
    for (var bk = 0; bk < bandSlots.length; bk++) css += '[data-thimble-bands="' + bk + '"]{' + bandVars(bandSlots[bk]) + '}'
    for (var gk = 0; gk < gapSlots.length; gk++) css += '[data-thimble-gap="' + gk + '"]{--thimble-gap:' + gapSlots[gk] + '}'
    if (greyShown && spanRanges.size) css += '::highlight(thimble-label-grey){background-color:var(--hl-bg,rgba(27,26,24,.08))}'
    if (css && !sheet) {
      sheet = document.createElement('style')
      sheet.setAttribute('data-thimble', 'labels')
      ;(document.head || document.documentElement).appendChild(sheet)
    }
    if (sheet && sheet.textContent !== css) sheet.textContent = css
  }
  // A quoted passage inside a record the view shows whole: `open` brings quote {record, text}, and the bridge finds the
  // text in the outermost element anchored at the record (else anywhere), whitespace collapsed and case ignored, then
  // highlights it, scrolls to it and posts `quoted {found}`. In an element that holds the kit's formatted text
  // (viewer_text.js), which shows a record's markdown rendered, the quote of its source is also tried with the markdown
  // taken out. A passage in a fold (data-thimble-fold, hidden) has the part that folded it open it. The search reruns
  // after each page change until the page is quiet for QUOTE_QUIET ms with no fetch pending, or QUOTE_MAX ms pass; a
  // found passage is kept in view for QUOTE_SETTLE ms.
  var QUOTE_QUIET = 800
  var QUOTE_MAX = 20000
  var QUOTE_SETTLE = 1000
  var quote = null
  var quoteSheet = null
  var quoteTimer = null
  function squeeze(s) {
    return String(s).replace(/\s+/g, ' ').trim().toLowerCase()
  }
  // A quote of a markdown source as its rendered text reads: without the markers of emphasis, strikethrough and code,
  // a heading's #, a list's, a task's and a block quote's markers, and with a link's or an image's text alone
  function unmarked(text) {
    return String(text)
      .split('\n')
      .map(function (l) {
        return l
          .replace(/^\s*(?:>\s?)+/, '')
          .replace(/^\s{0,3}#{1,6}(?:\s+|$)/, '')
          .replace(/\s+#+\s*$/, '')
          .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/, '')
      })
      .join('\n')
      .replace(/!?\[([^\]]*)\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+(?:"[^"]*"|'[^']*'))?\)/g, '$1')
      .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, '$1')
      .replace(/<((?:https?|mailto):[^>\s]+)>/gi, '$1')
      .replace(/`+/g, '')
      .replace(/\*\*|__|~~/g, '')
      .replace(/(^|[\s([{"'])[*_]+(?=\S)/g, '$1')
      .replace(/(\S)[*_]+(?=$|[\s)\]}.,;:!?"'])/gm, '$1')
  }
  function quoteNeedles(text, md) {
    var out = []
    function add(n) {
      if (n && out.indexOf(n) < 0) out.push(n)
    }
    add(squeeze(text))
    if (out[0] && out[0].length > 80) add(out[0].slice(0, 80).trim())
    var lines = String(text).split('\n')
    for (var i = 0; i < lines.length; i++) {
      var l = squeeze(lines[i])
      if (l.length >= 12) {
        add(l)
        break
      }
    }
    if (md) quoteNeedles(unmarked(text)).forEach(add)
    return out
  }
  // the first place a squeezed needle shows in the element's squeezed text, as a range over the element's own text
  function squeezedRange(el, needle) {
    var t = joined(el)
    if (!t.nodes.length) return null
    var norm = ''
    var map = []
    for (var i = 0; i < t.text.length; i++) {
      var c = t.text[i]
      if (/\s/.test(c)) {
        if (!norm.length || norm[norm.length - 1] === ' ') continue
        c = ' '
      } else {
        var low = c.toLowerCase()
        if (low.length === 1) c = low
      }
      norm += c
      map.push(i)
    }
    var k = norm.indexOf(needle)
    if (k < 0) return null
    var a = at(t, map[k])
    var b = at(t, map[k + needle.length - 1] + 1)
    var r = document.createRange()
    r.setStart(a[0], a[1])
    r.setEnd(b[0], b[1])
    return r
  }
  function quoteRange(q) {
    var scopes = []
    var els = document.querySelectorAll('[data-anchor]')
    for (var i = 0; i < els.length; i++) {
      if (els[i].getAttribute('data-anchor') !== q.record) continue
      var inner = false
      for (var a = els[i].parentElement; a && !inner; a = a.parentElement) inner = a.getAttribute('data-anchor') === q.record
      if (!inner) scopes.push(els[i])
    }
    if (!scopes.length && document.body) scopes.push(document.body)
    var ns = quoteNeedles(q.text)
    for (var n = 0; n < ns.length; n++) {
      for (var s = 0; s < scopes.length; s++) {
        var r = squeezedRange(scopes[s], ns[n])
        if (r) return r
      }
    }
    // a quote of a record's markdown, in its rendered text
    var ms = quoteNeedles(q.text, true).slice(ns.length)
    for (var m = 0; m < ms.length; m++) {
      for (var t = 0; t < scopes.length; t++) {
        if (!scopes[t].matches('.thimble-text') && !scopes[t].querySelector('.thimble-text')) continue
        var rm = squeezedRange(scopes[t], ms[m])
        if (rm) return rm
      }
    }
    return null
  }
  // scrolls every scrolling box around the range, then the page, so that the range sits a third of the way down
  function scrollToRange(r) {
    if (typeof r.getBoundingClientRect !== 'function') return
    var start = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement
    var box = r.getBoundingClientRect()
    for (var a = start; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      if (!/(auto|scroll)/.test(getComputedStyle(a).overflowY) || a.scrollHeight <= a.clientHeight) continue
      var c = a.getBoundingClientRect()
      if (box.top < c.top || box.bottom > c.bottom) a.scrollTop += box.top - c.top - a.clientHeight / 3
      box = r.getBoundingClientRect()
    }
    if (box.top < 0 || box.bottom > innerHeight) window.scrollBy(0, box.top - innerHeight / 3)
  }
  // the evidence highlight in ink, at the find's stronger step so it reads over the ring views draw around the record a
  // citation opened
  function showQuote(r) {
    var at = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement
    var fold = at && at.closest('[data-thimble-fold]')
    if (fold && fold.hidden) fold.dispatchEvent(new CustomEvent('thimble-unfold', { bubbles: true }))
    if (HL) {
      if (!quoteSheet) {
        quoteSheet = document.createElement('style')
        quoteSheet.setAttribute('data-thimble', 'quote')
        quoteSheet.textContent = '::highlight(thimble-quote){background-color:var(--hl-bg-strong,rgba(27,26,24,.18))}'
        ;(document.head || document.documentElement).appendChild(quoteSheet)
      }
      CSS.highlights.set('thimble-quote', new Highlight(r))
    }
    scrollToRange(r)
  }
  function hasPending() {
    for (var k in pending) return true
    return false
  }
  function seekQuote() {
    quoteTimer = null
    var q = quote
    if (!q) return
    var now = Date.now()
    // the page is searched again only when it changed since the last search, or to scroll a found passage back
    var r = q.found || q.changed >= q.searched ? quoteRange(q) : null
    q.searched = now
    if (r) {
      if (!q.found) {
        q.found = true
        q.until = now + QUOTE_SETTLE
        post({ type: P + 'quoted', found: true })
      }
      showQuote(r)
    }
    if (q.found ? now >= q.until : now >= q.max || (now - q.changed >= QUOTE_QUIET && !hasPending())) {
      if (!q.found) post({ type: P + 'quoted', found: false })
      quote = null
      return
    }
    quoteTimer = setTimeout(seekQuote, q.found ? 200 : 100)
  }
  function startQuote(q) {
    if (HL) CSS.highlights.delete('thimble-quote')
    if (quoteTimer != null) clearTimeout(quoteTimer)
    quoteTimer = null
    quote = null
    if (!q || typeof q.text !== 'string' || !q.text.trim()) return
    var now = Date.now()
    quote = { record: String(q.record || ''), text: q.text, found: false, changed: now, searched: 0, max: now + QUOTE_MAX, until: 0 }
    quoteTimer = setTimeout(seekQuote, 0)
  }

  // New anchored elements are reported. While marks are drawn, they are drawn again when anchored elements appear or
  // change their data-anchor, when the text inside an element with highlighted texts is replaced, whose highlights then
  // point at text that is gone, and when a marked element's class changes, which may change the shadow the view draws on
  // it (a ring around the record a citation opened), so it is measured again; other changes (a tooltip's text, a
  // counter) leave them as they are. A canvas is left alone: its data-anchor names the drawn mark under the pointer and
  // changes as the pointer moves, so it is no record's element.
  new MutationObserver(function (records) {
    var changed = false
    var walked = spanRanges.size ? new Set() : null
    if (quote) quote.changed = Date.now()
    if (restoring) restoring.changed = Date.now()
    for (var i = 0; i < records.length; i++) {
      var r = records[i]
      if (sheet && (r.target === sheet || (r.addedNodes.length === 1 && r.addedNodes[0] === sheet))) continue
      if (r.type === 'attributes') {
        if (r.attributeName === 'class') {
          measured.delete(r.target)
          if (r.target.hasAttribute('data-thimble-label') || r.target.hasAttribute('data-thimble-colour')) changed = true
          continue
        }
        if (r.target.tagName === 'CANVAS') continue
        collect(r.target)
        changed = true
        continue
      }
      for (var j = 0; j < r.addedNodes.length; j++) {
        var added = r.addedNodes[j]
        if (collect(added)) changed = true
        else if (colourHook && added.nodeType === 1 && (added.hasAttribute('data-colour') || added.querySelector('[data-colour]'))) changed = true
      }
      // the elements with highlighted texts around the change find their ranges again
      if (walked && !walked.has(r.target)) {
        walked.add(r.target)
        for (var up = r.target; up; up = up.parentNode) {
          if (!spanRanges.has(up)) continue
          textChanged.add(up)
          changed = true
        }
      }
    }
    if (unsent.length && sendTimer == null) sendTimer = setTimeout(sendAnchors, 30)
    else if (changed) seenSoon()
    if (changed && (hasMarks() || dropping() || colourHook)) paintSoon()
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-anchor', 'data-colour', 'data-colour-tracks', 'class'] })

  // What the analyst is looking at, for a newer version of the view loaded in this page's place: `ref` the element they
  // last clicked since the last `open`, `scroll` the scroll positions of the page and of each box scrolled, `fields`
  // the values typed or picked in its inputs, and `segs` the chosen option of each segmented control, by its text. An
  // element is named by its id, else by its path of child positions from the body.
  var SCAN_MAX = 5000
  function pathOf(el) {
    if (el === document.scrollingElement || el === document.documentElement || el === document.body) return ''
    if (el.id) return '#' + el.id
    var parts = []
    for (var e = el; e && e !== document.body; e = e.parentElement) {
      if (e.id) {
        parts.unshift('#' + e.id)
        break
      }
      parts.unshift(String(Array.prototype.indexOf.call(e.parentElement ? e.parentElement.children : [], e)))
    }
    return parts.join('/')
  }
  function atPath(path) {
    if (!path) return document.scrollingElement || document.documentElement
    var parts = path.split('/')
    var el = document.body
    for (var i = 0; i < parts.length && el; i++) el = parts[i].charAt(0) === '#' ? document.getElementById(parts[i].slice(1)) : el.children[Number(parts[i])]
    return el || null
  }
  function pageState() {
    var scroll = []
    var root = document.scrollingElement || document.documentElement
    if (root.scrollTop || root.scrollLeft) scroll.push({ path: '', top: root.scrollTop, left: root.scrollLeft })
    var all = document.body ? document.body.getElementsByTagName('*') : []
    for (var i = 0; i < all.length && i < SCAN_MAX; i++) {
      var el = all[i]
      if (el.scrollTop || el.scrollLeft) scroll.push({ path: pathOf(el), top: el.scrollTop, left: el.scrollLeft })
    }
    var fields = []
    var inputs = document.querySelectorAll('input, select, textarea')
    for (var j = 0; j < inputs.length; j++) {
      var f = inputs[j]
      var box = f.type === 'checkbox' || f.type === 'radio'
      if (box ? f.checked !== f.defaultChecked : f.tagName === 'SELECT' ? f.selectedIndex > 0 : f.value !== f.defaultValue)
        fields.push(box ? { path: pathOf(f), checked: f.checked } : { path: pathOf(f), value: f.value })
    }
    var segs = []
    var chosen = document.querySelectorAll('.seg .seg-opt.active')
    for (var k = 0; k < chosen.length; k++) segs.push({ path: pathOf(chosen[k].closest('.seg')), text: chosen[k].textContent.trim() })
    return { ref: picked || (last && last.ref) || null, scroll: scroll, fields: fields, segs: segs }
  }
  // The state put back, again after each change of the page, until it has been quiet for QUOTE_QUIET ms with no fetch
  // pending or RESTORE_MAX ms pass, or the analyst scrolls, clicks or types: each field and segmented control once it is
  // there, the change told to the page as the analyst's own would be, and the scroll positions.
  var RESTORE_MAX = 5000
  var restoring = null
  function startRestore(st) {
    if (!st || typeof st !== 'object') return
    var now = Date.now()
    restoring = {
      fields: Array.isArray(st.fields) ? st.fields.slice() : [],
      segs: Array.isArray(st.segs) ? st.segs.slice() : [],
      scroll: Array.isArray(st.scroll) ? st.scroll : [],
      changed: now,
      max: now + RESTORE_MAX,
    }
    setTimeout(restoreStep, 0)
  }
  function restoreField(want) {
    var f = atPath(String(want.path || ''))
    if (!f || !('value' in f)) return false
    if (typeof want.checked === 'boolean') {
      if (f.checked === want.checked) return true
      f.checked = want.checked
    } else if (typeof want.value === 'string' && f.value !== want.value) f.value = want.value
    else return true
    f.dispatchEvent(new Event('input', { bubbles: true }))
    f.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }
  function restoreSeg(want) {
    var seg = atPath(String(want.path || ''))
    var opts = seg ? seg.querySelectorAll('.seg-opt') : []
    for (var o = 0; o < opts.length; o++) {
      if (opts[o].textContent.trim() !== want.text) continue
      if (!opts[o].classList.contains('active')) opts[o].click()
      return true
    }
    return false
  }
  function restoreStep() {
    var r = restoring
    if (!r) return
    r.fields = r.fields.filter(function (f) {
      return !restoreField(f)
    })
    r.segs = r.segs.filter(function (g) {
      return !restoreSeg(g)
    })
    for (var i = 0; i < r.scroll.length; i++) {
      var el = atPath(String(r.scroll[i].path || ''))
      if (!el) continue
      if (el.scrollTop !== r.scroll[i].top) el.scrollTop = r.scroll[i].top
      if (el.scrollLeft !== r.scroll[i].left) el.scrollLeft = r.scroll[i].left
    }
    var now = Date.now()
    if (now >= r.max || (now - r.changed >= QUOTE_QUIET && !hasPending())) restoring = null
    else setTimeout(restoreStep, 100)
  }
  function stopRestore() {
    restoring = null
  }
  addEventListener('wheel', stopRestore, { passive: true, capture: true })
  addEventListener('pointerdown', stopRestore, true)
  addEventListener('keydown', stopRestore, true)

  // What the view kit's own controls (viewer_colour.js and viewer_range.js, loaded right after this bridge) need of it,
  // handed over once (the last of them takes it away): they hear the labels and marks without registering the page's
  // onLabels, set the Color by choice the marks are drawn by, have the page drawn again, and keep the choice and the
  // time ranges with thimble.
  window.__thimbleKit = {
    labels: function (fn) {
      kitFns.push(fn)
      if (labelState) fn(labelState, true, true)
    },
    colour: function (hook) {
      colourHook = hook || null
      paintSoon()
    },
    paint: paintSoon,
    save: function (state) {
      post({ type: P + 'colour', state: state })
    },
    gesture: gesture,
    report: report,
    realColour: realColour,
  }

  function size() {
    var b = document.body
    if (!b || ownSize) return
    var c = getComputedStyle(b)
    post({ type: P + 'size', height: b.offsetHeight + parseFloat(c.marginTop) + parseFloat(c.marginBottom) })
  }
  function ready() {
    size()
    if (window.ResizeObserver && document.body) new ResizeObserver(size).observe(document.body)
    post({ type: P + 'ready' })
    collect(document.documentElement)
    sendAnchors()
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready)
  else setTimeout(ready, 0)
})()
