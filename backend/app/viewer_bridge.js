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
//                          page to frame: marks {ref: {bar, names, spans: [{text, colour}], keep?}}, the marks of the
//                          labels that are on for the records and units among those refs, drawn over every element with
//                          that data-anchor, with `keep` whether the ref passes the label filter, and `answered` the
//                          `seq` of the anchors whose every ref those marks answer for the filter (-1 while some are
//                          still being read); on [{id, name, colour,
//                          values}], the labels that are on; filter {label, value, colour} or null; all [{id, name, on,
//                          colour, values: [{name, colour, highlight}], count}], every label over files; palette, the
//                          colours a label's value can take. Each replaces the last; window.thimble.onLabels hears all
//                          but the marks, which window.thimble.markOf reads and window.thimble.onMarks hears. In a card's
//                          frame the elements whose records the filter drops are dimmed, never hidden, and the page's
//                          own filtering is left alone
//   key {key}              page to frame, once the frame is ready: the key every labelCall carries, which only this
//                          bridge sees (it stops the message before the view's own listeners)
//   labelCall {id, key, op, args}
//                          frame to page, answered by labelDone {id, error?}: the page's label controls (window.thimble
//                          setLabel, setLabelColour, editLabel, mark and setFilter), each sent only while the frame has
//                          the analyst's transient user activation, which thimble checks again on its side; ops on,
//                          colour, edit, mark and filter
//   labelRefused {op}      frame to page: a label call the bridge refused because the analyst made no gesture in the view
//   hidden {n, self}       frame to page: how many anchored refs the bridge hides or dims for the label filter, null
//                          while thimble has not answered for every anchored ref, and whether the page filters its
//                          records itself (it registered onLabels)
//   cmd {on, cursor}       page to frame: ⌘ went down or up, and the page's ⌘ arrow as a CSS cursor value, which this
//                          page shows while ⌘ is held so the pointer over the frame is the same one pointer
//   state {id}             page to frame, answered by state {id, state}: what the analyst is looking at, before a newer
//                          version of the view is loaded in its place: {ref, scroll, fields, segs} (pageState)
//   restore {state}        page to frame: that state put back in the newer version's page, as far as it fits (restore)
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
  var markKey = '{}'
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
  // a label change, sent to thimble only during the analyst's gesture; the promise rejects with thimble's reason
  function labelCall(op, args) {
    if (!gesture()) {
      post({ type: P + 'labelRefused', op: op })
      return refusal(NO_GESTURE)
    }
    if (!callKey) return refusal('thimble is not ready for label calls yet')
    return new Promise(function (resolve, reject) {
      var id = ++seq
      calls[id] = { resolve: resolve, reject: reject }
      post({ type: P + 'labelCall', id: id, key: callKey, op: op, args: args })
    })
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
    /** open thimble's label editor on the label with this id, or on a new label without one */
    editLabel: function (id) {
      return labelCall('edit', { id: id == null ? null : String(id) })
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
    /** the mark of the labels the page is given on one record or unit ref, {bar, names, keep?}, or null */
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
        var err = new Error(String(d.error))
        err.name = 'ThimbleRefused'
        err.thimbleRefused = true
        c.reject(err)
      } else c.resolve(true)
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
      marks = d.marks && typeof d.marks === 'object' ? d.marks : {}
      filter = d.filter && typeof d.filter === 'object' ? d.filter : null
      answered = typeof d.answered === 'number' ? d.answered : -1
      var state = { labels: Array.isArray(d.on) ? d.on : [], filter: filter }
      if (Array.isArray(d.all)) state.all = d.all
      if (Array.isArray(d.palette)) state.palette = d.palette
      var key = JSON.stringify(state)
      if (key !== labelKey) {
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
      paint()
      var mk = JSON.stringify(marks)
      if (mk !== markKey) {
        markKey = mk
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
  var marks = {}
  var reported = {}
  var unsent = []
  var sentN = 0 // anchored refs reported so far (anchors' seq)
  var answered = -1 // the seq the last labels message answers for
  var marked = []
  var lit = []
  var sheet = null
  var sendTimer = null
  var paintTimer = null
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
  // Whether anything is dropped.
  var dropped = []
  function dropping() {
    return !!filter && (cardMode || !labelFns.length)
  }
  function drop() {
    for (var i = 0; i < dropped.length; i++) dropped[i].removeAttribute('data-thimble-drop')
    dropped = []
    if (!dropping()) return false
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
    for (var k = 0; k < els.length; k++) {
      if (keep.has(els[k])) continue
      els[k].setAttribute('data-thimble-drop', cardMode || els[k] instanceof SVGElement ? 'dim' : 'hide')
      dropped.push(els[k])
    }
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
  // whether the bar fits in the element's left padding with a gap before its text (a row's, its first cell's)
  function room(el) {
    var box = el.tagName === 'TR' && el.cells && el.cells.length ? el.cells[0] : el
    return parseFloat(getComputedStyle(box).paddingLeft) >= 2 * BAR
  }
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
  function edgeOf(el, cut) {
    if (room(el)) return 'in'
    return el.getBoundingClientRect().left - BAR >= clipLeft(el, cut) ? 'out' : 'in'
  }
  function paint() {
    paintTimer = null
    for (var i = 0; i < marked.length; i++) {
      marked[i].removeAttribute('data-thimble-label')
      marked[i].removeAttribute('data-thimble-bar')
      marked[i].removeAttribute('data-thimble-edge')
      marked[i].removeAttribute('data-thimble-own')
    }
    marked = []
    var colours = []
    var ranges = []
    var owns = []
    function slot(c) {
      var k = colours.indexOf(c)
      if (k < 0) {
        k = colours.length
        colours.push(c)
        ranges.push([])
      }
      return k
    }
    if (hasMarks()) {
      // the elements to mark and what the view draws on them are read first, with the previous marks cleared, and written
      // after, so the page's styles are worked out once rather than once per element
      var els = document.querySelectorAll('[data-anchor]')
      var todo = []
      var cut = new Map()
      for (var j = 0; j < els.length; j++) {
        var el = els[j]
        var ref = el.getAttribute('data-anchor')
        var m = marks[ref]
        if (!m || el.tagName === 'CANVAS' || el.hasAttribute('data-anchor-unmarked') || typeof m.bar !== 'string' || !COLOUR.test(m.bar)) continue
        var inner = false
        for (var a = el.parentElement; a && !inner; a = a.parentElement) inner = a.getAttribute('data-anchor') === ref
        if (inner) continue
        if (el instanceof SVGElement) {
          todo.push([el, m, 'svg', null])
          continue
        }
        var own = getComputedStyle(el).boxShadow
        todo.push([el, m, edgeOf(el, cut), own && own !== 'none' && SHADOW.test(own) ? own : null])
      }
      for (var d = 0; d < todo.length; d++) {
        var el2 = todo[d][0]
        var m2 = todo[d][1]
        el2.setAttribute('data-thimble-label', (m2.names || []).join(', '))
        el2.setAttribute('data-thimble-bar', String(slot(m2.bar)))
        el2.setAttribute('data-thimble-edge', todo[d][2])
        if (todo[d][3]) {
          var o = owns.indexOf(todo[d][3])
          if (o < 0) o = owns.push(todo[d][3]) - 1
          el2.setAttribute('data-thimble-own', String(o))
        }
        marked.push(el2)
        var spans = HL && Array.isArray(m2.spans) ? m2.spans : []
        var t = spans.length ? joined(el2) : null
        for (var s = 0; s < spans.length; s++) {
          var sp = spans[s] || {}
          if (typeof sp.colour === 'string' && COLOUR.test(sp.colour)) rangesOf(t, String(sp.text || ''), ranges[slot(sp.colour)])
        }
      }
    }
    var css = (colours.length ? BARS : '') + (drop() ? DROP : '')
    sendHidden()
    for (var k = 0; k < colours.length; k++) {
      css += '[data-thimble-bar="' + k + '"]{--thimble-label:' + colours[k] + '}'
      css += '::highlight(thimble-label-' + k + '){background-color:color-mix(in oklab,' + colours[k] + ' 24%,transparent)}'
    }
    for (var w = 0; w < owns.length; w++) css += '[data-thimble-own="' + w + '"]{--thimble-own:' + owns[w] + '}'
    if (css && !sheet) {
      sheet = document.createElement('style')
      sheet.setAttribute('data-thimble', 'labels')
      ;(document.head || document.documentElement).appendChild(sheet)
    }
    if (sheet && sheet.textContent !== css) sheet.textContent = css
    if (HL) {
      for (var o = 0; o < lit.length; o++) CSS.highlights.delete(lit[o])
      lit = []
      for (var h = 0; h < ranges.length; h++) {
        if (!ranges[h].length) continue
        var name = 'thimble-label-' + h
        var hl = new Highlight()
        for (var q = 0; q < ranges[h].length; q++) hl.add(ranges[h][q])
        CSS.highlights.set(name, hl)
        lit.push(name)
      }
    }
  }
  // A quoted passage inside a record the view shows whole: `open` brings quote {record, text}, and the bridge finds the
  // text in the outermost element anchored at the record (else anywhere), whitespace collapsed and case ignored, then
  // highlights it, scrolls to it and posts `quoted {found}`. The search reruns after each page change until the page is
  // quiet for QUOTE_QUIET ms with no fetch pending, or QUOTE_MAX ms pass; a found passage is kept in view for
  // QUOTE_SETTLE ms.
  var QUOTE_QUIET = 800
  var QUOTE_MAX = 20000
  var QUOTE_SETTLE = 1000
  var quote = null
  var quoteSheet = null
  var quoteTimer = null
  function squeeze(s) {
    return String(s).replace(/\s+/g, ' ').trim().toLowerCase()
  }
  function quoteNeedles(text) {
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
  // change their data-anchor, when the text inside a marked element is replaced, whose highlights then point at text
  // that is gone, and when a marked element's class changes, which may change the shadow the view draws on it (a ring
  // around the record a citation opened); other changes (a tooltip's text, a counter) leave them as they are. A canvas
  // is left alone: its data-anchor names the drawn mark under the pointer and changes as the pointer moves, so it is no
  // record's element.
  new MutationObserver(function (records) {
    var changed = false
    if (quote) quote.changed = Date.now()
    if (restoring) restoring.changed = Date.now()
    for (var i = 0; i < records.length; i++) {
      var r = records[i]
      if (sheet && (r.target === sheet || (r.addedNodes.length === 1 && r.addedNodes[0] === sheet))) continue
      if (r.type === 'attributes') {
        if (r.attributeName === 'class') {
          if (r.target.hasAttribute('data-thimble-label')) changed = true
          continue
        }
        if (r.target.tagName === 'CANVAS') continue
        collect(r.target)
        changed = true
        continue
      }
      for (var j = 0; j < r.addedNodes.length; j++) {
        if (collect(r.addedNodes[j])) changed = true
      }
      if (!changed && r.target.closest && r.target.closest('[data-thimble-label]')) changed = true
    }
    if (unsent.length && sendTimer == null) sendTimer = setTimeout(sendAnchors, 30)
    else if (changed) seenSoon()
    if (changed && (hasMarks() || dropping()) && paintTimer == null) paintTimer = setTimeout(paint, 30)
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-anchor', 'class'] })

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
