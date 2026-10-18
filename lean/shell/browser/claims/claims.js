// claims.js: the Claims page. The session's claims (thimble/claims/<session>.json, CONTRACT 7) drawn as a force graph
// on a canvas, with no library. A node is a claim, in the color of its cluster (or of what Color by says): Claude's a
// circle, the person's a diamond, the corpus orientation's a small dotted ring, larger when it was said again (×N).
// Each cluster is named above its claims; a thin line joins the claims of a cluster in the order said, and claims said
// one after the other in a message. A revised claim is a dashed ring, its words struck through, with a dashed arrow
// "revised in turn N" to the claim that replaced it. The time strip replays the claims in the order made. A click
// opens the claim below: where it was said, its sources, ×N, what it replaces, and ↵ ask.
//
// It reads the store from the page server (/api/claims, with its ETag) and asks again every few seconds while the page
// is visible, so the claims a later turn adds arrive in place.
(function () {
  'use strict'
  const $ = (s, r) => (r || document).querySelector(s)
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const fmt = n => (typeof n === 'number' ? n.toLocaleString('en-US') : String(n))

  // ------------------------------------------------------------------------------------------------ where it reads
  const params = new URLSearchParams(location.search)
  const HASH = location.hash
  const READY = /(^|[#&])ready\b/.test(HASH)
  const EMBED = params.get('embed') === '1'
  const token = location.pathname.split('/').filter(Boolean)[0] || ''
  const BASE = params.get('base') || (token && token !== 'claims' ? '/' + token : '')
  const SRC = params.get('src') || `${BASE}/api/claims`
  const POLL_MS = 2500
  const enc = encodeURIComponent
  if (EMBED) document.documentElement.classList.add('embed')

  // ------------------------------------------------------------------------------------------------ colors
  const PAL = ['#1f5fbf', '#d7781f', '#0f5b3a', '#1f9e8f', '#7a6a12', '#b34a7a', '#6d4fd8', '#8a5a2b']
  const PAL_DARK = ['#6aa2f0', '#f0a050', '#4fbf86', '#4fd0c0', '#c9b54a', '#ea86b2', '#a593f5', '#d09a66']
  const TAGC = { fact: ['#3f6f8f', '#8fbcdc'], interp: ['#8a4fb5', '#c79ae9'] }
  const BYC = { claude: ['#5b6b82', '#9fb0c9'], person: ['#b9466e', '#ec8fb3'], orientation: ['#a8875a', '#d9b98a'] }
  let DARK = false
  const T = { bg: '#fcfbf8', ink: '#1f1e1c', ink2: '#4a4945', mut: '#85837c', halo: 'rgba(252,251,248,.92)', pill: '#ffffff', pillLine: '#e2e0da', ring: '#6d4fd8', warn: '#b7791f', edge: '#cfcac0' }
  function readTheme() {
    const cs = getComputedStyle(document.documentElement)
    const v = n => cs.getPropertyValue(n).trim()
    DARK = (matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light') || document.documentElement.dataset.theme === 'dark'
    Object.assign(T, { bg: v('--view'), ink: v('--ink'), ink2: v('--ink2'), mut: v('--mut'), halo: v('--halo'), pill: v('--bg'), pillLine: v('--line2'), ring: v('--atl'), warn: v('--warn') })
    T.edge = DARK ? '#4a4741' : '#d6d1c7'
    T.font = getComputedStyle(document.body).fontFamily
  }
  function hexA(hex, a) {
    if (!hex || hex[0] !== '#') return hex
    const v = parseInt(hex.slice(1), 16)
    return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`
  }
  const tagOf = k => (['fact', 'finding', 'event'].includes(k) ? 'fact' : 'interp')
  const kindOf = k => {
    const s = String(k == null ? '' : k).toLowerCase().trim()
    if (s.startsWith('judg') || s === 'decision') return 'judgment'
    return ['fact', 'finding', 'event', 'claim'].includes(s) ? s : 'claim'
  }

  // ------------------------------------------------------------------------------------------------ the graph's state
  let STORE = null
  const N = []
  let byId = {}
  let EDGES = []
  const CLUSTERS = []
  let CBY = {}
  const S = { hover: null, sel: null, solo: null, query: '', upto: null, color: 'cluster', asking: false, fresh: new Set(), loaded: false, etag: '' }
  let seed = 17
  const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }

  /** The group a claim is in for the color mode, and that group's name and color. */
  function groupOf(n) {
    if (S.color === 'tag') return { key: n.tag, name: n.tag, color: TAGC[n.tag][DARK ? 1 : 0] }
    if (S.color === 'by') { const b = n.by === 'person' ? 'person' : n.by === 'orientation' ? 'orientation' : 'claude'; return { key: b, name: b === 'person' ? 'you' : b === 'orientation' ? 'the corpus' : 'Claude', color: BYC[b][DARK ? 1 : 0] } }
    if (S.color === 'turn') {
      const ts = turnsOf()
      const i = n.turn == null ? ts.length : ts.indexOf(n.turn)
      const a = ts.length > 1 ? i / (ts.length - 1) : 1
      const lo = DARK ? [90, 120, 170] : [176, 196, 226], hi = DARK ? [190, 160, 250] : [60, 40, 150]
      const c = lo.map((x, k) => Math.round(x + (hi[k] - x) * Math.min(1, a)))
      return { key: n.turn == null ? 'corpus' : 't' + n.turn, name: n.turn == null ? 'corpus' : 'turn ' + n.turn, color: '#' + c.map(x => x.toString(16).padStart(2, '0')).join('') }
    }
    const c = CBY[n.cluster]
    return { key: n.cluster, name: c ? c.name : 'between clusters', color: c ? c.color : T.mut }
  }
  const colorOf = n => groupOf(n).color
  const radiusOf = n => Math.min(12, (n.by === 'orientation' ? 4 : 5.2) + Math.sqrt(Math.max(0, n.n - 1)) * 2.8)
  function layoutAnchors() {
    const used = CLUSTERS.filter(c => N.some(n => n.cluster === c.key))
    const m = used.length
    const rx = 170 + 14 * Math.sqrt(N.length)
    const ry = rx * 0.55
    used.forEach((c, i) => {
      const a = Math.PI + (i / Math.max(1, m)) * Math.PI * 2 + 0.3
      c.ax = m === 1 ? 0 : Math.cos(a) * rx
      c.ay = m === 1 ? 0 : Math.sin(a) * ry
    })
  }

  /** The store's claims and clusters into the graph; claims already there keep their place. */
  function ingest(store) {
    const claims = (Array.isArray(store.claims) ? store.claims : []).filter(c => c && c.id != null && c.text)
    const clusters = (Array.isArray(store.clusters) ? store.clusters : []).filter(c => c && c.id != null)
    const loose = claims.some(c => !c.cluster || !clusters.some(k => String(k.id) === String(c.cluster)))
    for (const c of [...clusters, ...(loose ? [{ id: null, name: 'between clusters' }] : [])]) {
      const key = c.id == null ? '' : String(c.id)
      if (CBY[key]) { CBY[key].name = String(c.name || key); continue }
      const i = CLUSTERS.filter(x => x.id != null).length
      const k = { id: c.id == null ? null : key, key, name: String(c.name || 'between clusters'), from: c.from, i, cx: 0, cy: 0, ax: 0, ay: 0, lx: 0 }
      k.color = k.id == null ? '#9c978d' : (DARK ? PAL_DARK : PAL)[i % PAL.length]
      CLUSTERS.push(k)
      CBY[key] = k
    }
    const keep = new Set(claims.map(c => String(c.id)))
    for (let i = N.length - 1; i >= 0; i--) if (!keep.has(N[i].id)) N.splice(i, 1)
    const added = []
    claims.forEach((c, i) => {
      const id = String(c.id)
      const cluster = c.cluster != null && CBY[String(c.cluster)] ? String(c.cluster) : ''
      const said = (Array.isArray(c.said) ? c.said : []).filter(p => p && typeof p === 'object')
      const sources = (Array.isArray(c.sources) ? c.sources : []).map(s => (typeof s === 'string' ? { ref: s, label: s } : s)).filter(s => s && s.ref)
      const kind = kindOf(c.kind)
      const fields = { text: String(c.text), kind, tag: tagOf(kind), by: c.by || 'claude', cluster, turn: typeof c.turn === 'number' ? c.turn : null, said, sources, n: Math.max(1, said.length), revises: c.revises || null, revised_by: c.revised_by || null, order: i, row: said[0] && said[0].row }
      if (byId[id]) Object.assign(byId[id], fields)
      else {
        const n = Object.assign({ id, x: 0, y: 0, vx: 0, vy: 0, live: false, born: 0, va: 1, hv: 0, fx: null, fy: null, adj: [] }, fields)
        N.push(n)
        added.push(n)
      }
    })
    byId = {}
    N.sort((a, b) => a.order - b.order)
    N.forEach(n => { byId[n.id] = n; n.adj = []; n.r = radiusOf(n) })
    EDGES = []
    const link = (a, b, t) => { if (!a || !b || a === b) return; const e = { a, b, t, born: 0 }; EDGES.push(e); a.adj.push({ n: b, t, e }); b.adj.push({ n: a, t, e }) }
    // a cluster's claims in the order said; claims said one after the other in a message; a revision
    const lastIn = {}
    const lastRow = {}
    N.forEach(n => {
      if (lastIn[n.cluster]) link(lastIn[n.cluster], n, 'c')
      lastIn[n.cluster] = n
      const prev = n.row && lastRow[n.row]
      if (prev && prev.cluster !== n.cluster) link(prev, n, 'm')
      if (n.row) lastRow[n.row] = n
    })
    N.forEach(n => { if (n.revised_by && byId[n.revised_by]) link(n, byId[n.revised_by], 'r') })
    layoutAnchors()
    return added
  }

  // ------------------------------------------------------------------------------------------------ time
  const turnsOf = () => [...new Set(N.map(n => n.turn).filter(t => t != null))].sort((a, b) => a - b)
  /** Whether a claim was made by the cut-off of the time strip (all, with none set). */
  const shown = n => S.upto == null || n.order < S.upto
  const revisedNow = n => !!n.revised_by && byId[n.revised_by] && shown(byId[n.revised_by])
  const saidNow = n => {
    if (S.upto == null) return n.n
    const last = N[Math.max(0, S.upto - 1)]
    const lt = last ? last.turn : null
    return Math.max(1, n.said.filter((p, i) => i === 0 || p.turn == null || lt == null || p.turn < lt || (p.turn === lt && p.row && N.some(m => m.row === p.row && shown(m)))).length)
  }

  // ------------------------------------------------------------------------------------------------ the simulation
  const SIM = { alpha: 0, target: 0, decay: 1 - Math.pow(0.001, 1 / 320), vdecay: 0.56 }
  const live = () => N.filter(n => n.live)
  let drag = null
  function tick() {
    const L = live()
    const a = SIM.alpha
    if (a < 0.002 && !drag) return
    for (let i = 0; i < L.length; i++) {
      const p = L[i]
      for (let j = i + 1; j < L.length; j++) {
        const q = L[j]
        let dx = q.x - p.x, dy = q.y - p.y, l2 = dx * dx + dy * dy
        if (l2 > 360000) continue
        if (l2 < 1) { dx = rnd() - 0.5; dy = rnd() - 0.5; l2 = dx * dx + dy * dy }
        const w = ((p.cluster === q.cluster ? -130 : -230) * a) / Math.max(l2, 120)
        p.vx += dx * w; p.vy += dy * w; q.vx -= dx * w; q.vy -= dy * w
      }
    }
    for (const e of EDGES) {
      const s = e.a, t = e.b
      if (!s.live || !t.live) continue
      const cross = s.cluster !== t.cluster
      const dist = e.t === 'r' ? 70 : cross ? 150 : 42
      const str = e.t === 'm' ? 0.04 : e.t === 'r' ? (cross ? 0.08 : 0.4) : 0.5
      let dx = t.x + t.vx - s.x - s.vx, dy = t.y + t.vy - s.y - s.vy
      let l = Math.sqrt(dx * dx + dy * dy) || 1
      l = ((l - dist) / l) * a * str
      dx *= l; dy *= l
      t.vx -= dx * 0.5; t.vy -= dy * 0.5; s.vx += dx * 0.5; s.vy += dy * 0.5
    }
    for (const c of CLUSTERS) {
      const ms = L.filter(n => n.cluster === c.key)
      if (!ms.length) continue
      let cx = 0, cy = 0
      ms.forEach(n => { cx += n.x; cy += n.y })
      cx /= ms.length; cy /= ms.length
      c.cx = cx; c.cy = cy
      const g = 0.1 * a * Math.min(1, ms.length / 3)
      ms.forEach(n => {
        n.vx += (cx - n.x) * g + (c.ax - n.x) * 0.02 * a
        n.vy += (cy - n.y) * g + (c.ay - n.y) * 0.02 * a
      })
    }
    const discs = []
    for (const c of CLUSTERS) {
      const ms = L.filter(n => n.cluster === c.key)
      if (!ms.length) continue
      let s2 = 0
      ms.forEach(n => { s2 += (n.x - c.cx) ** 2 + (n.y - c.cy) ** 2 })
      discs.push({ ms, x: c.cx, y: c.cy, r: Math.sqrt(s2 / ms.length) * 1.3 + 34 })
    }
    for (let i = 0; i < discs.length; i++) {
      for (let j = i + 1; j < discs.length; j++) {
        const p = discs[i], q = discs[j]
        const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 1
        const gap = p.r + q.r - d
        if (gap <= 0) continue
        const f = (gap / d) * 0.12 * a
        const wp = q.ms.length / (p.ms.length + q.ms.length), wq = 1 - wp
        p.ms.forEach(n => { n.vx -= dx * f * wp; n.vy -= dy * f * wp })
        q.ms.forEach(n => { n.vx += dx * f * wq; n.vy += dy * f * wq })
      }
    }
    L.forEach(n => {
      if (n.fx != null) { n.x = n.fx; n.y = n.fy; n.vx = n.vy = 0; return }
      n.vx *= SIM.vdecay; n.vy *= SIM.vdecay
      n.x += n.vx; n.y += n.vy
    })
    for (let i = 0; i < L.length; i++) {
      for (let j = i + 1; j < L.length; j++) {
        const p = L[i], q = L[j]
        const min = p.r + q.r + 12
        let dx = q.x - p.x, dy = q.y - p.y
        const l2 = dx * dx + dy * dy
        if (l2 >= min * min) continue
        const l = Math.sqrt(l2) || 0.01, m = ((min - l) / l) * 0.5 * 0.7
        dx *= m; dy *= m
        if (p.fx == null) { p.x -= dx; p.y -= dy }
        if (q.fx == null) { q.x += dx; q.y += dy }
      }
    }
    SIM.alpha += (SIM.target - SIM.alpha) * SIM.decay
  }
  const reheat = v => { SIM.alpha = Math.max(SIM.alpha, v) }
  function place(n) {
    const nb = n.adj.map(x => x.n).filter(m => m.live)
    const c = CBY[n.cluster]
    if (nb.length) { const m = nb[0], ang = rnd() * Math.PI * 2; n.x = m.x + Math.cos(ang) * 30; n.y = m.y + Math.sin(ang) * 30 }
    else if (c) { const has = N.some(m => m.live && m.cluster === c.key); n.x = (has ? c.cx : c.ax) + (rnd() - 0.5) * 40; n.y = (has ? c.cy : c.ay) + (rnd() - 0.5) * 40 }
    else { n.x = (rnd() - 0.5) * 60; n.y = (rnd() - 0.5) * 60 }
    n.vx = n.vy = 0
    n.live = true
  }
  function settle(now) {
    SIM.target = 0.28
    SIM.alpha = 0.5
    N.forEach((n, i) => { place(n); for (let k = 0; k < 3; k++) tick(); if (i % 8 === 7) reheat(0.5) })
    for (let i = 0; i < 260; i++) tick()
    SIM.target = 0
    for (let i = 0; i < 420; i++) tick()
    const step = READY ? 0 : Math.min(60, 2000 / Math.max(1, N.length))
    N.forEach((n, i) => { n.born = now + i * step })
    EDGES.forEach(e => { e.born = Math.max(e.a.born, e.b.born) })
  }

  // ------------------------------------------------------------------------------------------------ the view
  const cv = $('#g'), gw = $('#gwrap'), ctx = cv.getContext('2d')
  let W = 900, H = 600
  const DPR = Math.max(1, window.devicePixelRatio || 1)
  function size() {
    W = gw.clientWidth; H = gw.clientHeight
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR)
    cv.style.width = W + 'px'; cv.style.height = H + 'px'
  }
  const cam = { x: 0, y: 0, k: 1.2 }
  const toScreen = n => [W / 2 + (n.x - cam.x) * cam.k, H / 2 + 8 + (n.y - cam.y) * cam.k]
  // a claim's size follows how often it was said by the cut-off of the time strip
  const rScreen = n => (S.upto == null ? n.r : Math.min(12, (n.by === 'orientation' ? 4 : 5.2) + Math.sqrt(Math.max(0, saidNow(n) - 1)) * 2.8)) * Math.max(0.8, Math.min(1.25, cam.k))
  function fitCamera(snap) {
    const L = live().filter(shown)
    if (!L.length) return 0
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    L.forEach(n => { x0 = Math.min(x0, n.x - n.r - 60); x1 = Math.max(x1, n.x + n.r + 60); y0 = Math.min(y0, n.y - n.r - 46); y1 = Math.max(y1, n.y + n.r + 30) })
    let k = Math.min((W - 40) / Math.max(1, x1 - x0), (H - 30) / Math.max(1, y1 - y0), 1.45)
    k = Math.max(k, 0.35)
    const tx = (x0 + x1) / 2, ty = (y0 + y1) / 2
    const f = snap ? 1 : 0.06
    const mv = Math.abs(tx - cam.x) * cam.k + Math.abs(ty - cam.y) * cam.k + Math.abs(k - cam.k) * 400
    cam.x += (tx - cam.x) * f; cam.y += (ty - cam.y) * f; cam.k += (k - cam.k) * f
    return mv
  }
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath() }
  const ease = t => (t < 0 ? 0 : t > 1 ? 1 : 1 - Math.pow(1 - t, 3))
  const back = t => { if (t <= 0) return 0; if (t >= 1) return 1; const c1 = 1.5, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2) }
  const matches = n => (!S.solo || groupOf(n).key === S.solo) && (!S.query || (n.text + ' ' + n.said.map(p => p.quote || '').join(' ')).toLowerCase().includes(S.query.toLowerCase()))
  const filtering = () => !!(S.solo || S.query)
  const font = (w, px) => `${w} ${px}px ${T.font || 'sans-serif'}`
  const clip = (s, max) => (s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s)
  const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))

  function mark(n, sx, sy, r, alpha) {
    const col = colorOf(n)
    if (revisedNow(n)) {
      ctx.save(); ctx.setLineDash([2.5, 2.5]); ctx.beginPath(); ctx.arc(sx, sy, r, 0, 7)
      ctx.fillStyle = hexA(T.bg, alpha); ctx.fill(); ctx.strokeStyle = hexA(T.mut, alpha); ctx.lineWidth = 1.3; ctx.stroke(); ctx.restore()
      return
    }
    ctx.beginPath()
    if (n.by === 'person') { ctx.moveTo(sx, sy - r * 1.2); ctx.lineTo(sx + r * 1.2, sy); ctx.lineTo(sx, sy + r * 1.2); ctx.lineTo(sx - r * 1.2, sy); ctx.closePath() }
    else ctx.arc(sx, sy, Math.max(0.1, r), 0, 7)
    ctx.fillStyle = hexA(col, Math.max(0.08, alpha)); ctx.fill()
    ctx.lineWidth = 1.5; ctx.strokeStyle = hexA(DARK ? '#191817' : '#ffffff', 0.9 * alpha); ctx.stroke()
    if (n.by === 'orientation') { ctx.save(); ctx.setLineDash([2, 2.5]); ctx.beginPath(); ctx.arc(sx, sy, r + 3.5, 0, 7); ctx.strokeStyle = hexA(col, 0.7 * alpha); ctx.lineWidth = 1.1; ctx.stroke(); ctx.restore() }
  }
  function textAt(s, x, y, strike) {
    ctx.fillText(s, x, y)
    if (!strike) return
    const w = ctx.measureText(s).width
    const x0 = ctx.textAlign === 'center' ? x - w / 2 : ctx.textAlign === 'right' ? x - w : x
    const mid = ctx.textBaseline === 'middle' ? y : ctx.textBaseline === 'top' ? y + 7 : y - 4
    ctx.save(); ctx.beginPath(); ctx.moveTo(x0, mid); ctx.lineTo(x0 + w, mid); ctx.lineWidth = 1; ctx.strokeStyle = ctx.fillStyle; ctx.stroke(); ctx.restore()
  }
  /** Names placed so that none overlaps another name or a node; a name with no free spot near its node is left out. */
  function placeLabels(labs, obstacles, discs) {
    const placed = obstacles.slice()
    const out = []
    for (const lab of labs) {
      const n = lab.n
      const [sx, sy] = toScreen(n)
      const r = rScreen(n) * (1 + 0.22 * n.hv)
      if (lab.big) {
        ctx.font = font(600, 13.5)
        const text = clip(n.text, 72)
        const tw = ctx.measureText(text).width, bw = tw + 30, bh = 26
        const spots = []
        for (const d of [9, 24, 40]) spots.push([sx - bw / 2, sy - r - bh - d], [sx - bw / 2, sy + r + d], [sx + r + d, sy - bh / 2], [sx - r - d - bw, sy - bh / 2])
        let best = null
        for (const [x0, y0] of spots) {
          const b = { x: Math.max(6, Math.min(W - bw - 6, x0)), y: Math.max(4, Math.min(H - bh - 6, y0)), w: bw, h: bh }
          const cost = placed.reduce((s, p) => s + overlap(b, p), 0) + discs.reduce((s, d) => (d.n === n ? s : s + overlap(b, d)), 0)
          if (!best || cost < best.cost) best = { ...b, cost }
          if (!cost) break
        }
        placed.push(best)
        out.push({ n, big: true, text, box: best })
        continue
      }
      ctx.font = font(500, 11.5)
      const text = clip(n.text, lab.max || 44)
      const tw = ctx.measureText(text).width, lh = 14
      let got = null
      for (const d of [4, 16, 30]) {
        const rr = r + d
        const cands = lab.left ? [[sx - rr - 2 - tw, sy - lh / 2], [sx - tw / 2, sy + rr], [sx - tw / 2, sy - rr - lh]] : [[sx + rr + 2, sy - lh / 2], [sx - tw / 2, sy + rr], [sx - tw / 2, sy - rr - lh], [sx - rr - 2 - tw, sy - lh / 2]]
        for (const [x, y] of cands) {
          const b = { x: x - 2, y: y - 1, w: tw + 4, h: lh + 2 }
          if (b.x < 4 || b.x + b.w > W - 4 || b.y < 2 || b.y + b.h > H - 4) continue
          if (placed.some(p => overlap(b, p) > 0)) continue
          if (discs.some(q => q.n !== n && overlap(b, q) > 0)) continue
          got = { b, x, y, lead: d > 4 }
          break
        }
        if (got) break
      }
      if (!got) continue
      placed.push(got.b)
      out.push({ n, big: false, text, x: got.x, y: got.y, lead: got.lead, sx, sy, r })
    }
    return out
  }
  function arrow(x1, y1, x2, y2, r2, color, width) {
    const dx = x2 - x1, dy = y2 - y1, d = Math.hypot(dx, dy) || 1
    const ex = x2 - (dx / d) * (r2 + 3), ey = y2 - (dy / d) * (r2 + 3)
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash([4, 3.5])
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(ex, ey); ctx.stroke(); ctx.setLineDash([])
    const a = Math.atan2(dy, dx), h = 7
    ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex - h * Math.cos(a - 0.42), ey - h * Math.sin(a - 0.42)); ctx.moveTo(ex, ey); ctx.lineTo(ex - h * Math.cos(a + 0.42), ey - h * Math.sin(a + 0.42))
    ctx.stroke(); ctx.restore()
  }

  function draw(now) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    ctx.clearRect(0, 0, W, H)
    const L = live().filter(n => now >= n.born && shown(n))
    const focus = S.hover || S.sel
    const nbr = new Set(focus ? [focus].concat(focus.adj.filter(x => x.t === 'r').map(x => x.n)) : [])
    L.forEach(n => {
      let t = 1
      if (filtering()) t = matches(n) ? 1 : 0.12
      if (focus) t = nbr.has(n) ? 1 : focus.cluster === n.cluster ? 0.55 : 0.18
      n.va += (t - n.va) * 0.16
      n.hv += ((n === S.hover ? 1 : 0) - n.hv) * 0.25
    })
    // thin lines: a cluster's claims in the order said, claims said one after the other in a message
    EDGES.forEach(e => {
      if (e.t === 'r' || !L.includes(e.a) || !L.includes(e.b)) return
      const hot = focus && (e.a === focus || e.b === focus)
      const al = Math.min(e.a.va, e.b.va) * ease((now - e.born) / 700) * (e.t === 'm' ? (hot ? 0.8 : 0.3) : 1)
      if (al < 0.02) return
      const [x1, y1] = toScreen(e.a), [x2, y2] = toScreen(e.b)
      ctx.strokeStyle = hexA(T.edge, al); ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
    })
    // revisions: a dashed arrow from the revised claim to the claim that replaced it, "revised in turn N" on it
    const names = []
    EDGES.forEach(e => {
      if (e.t !== 'r' || !L.includes(e.a) || !L.includes(e.b)) return
      const hot = focus && (e.a === focus || e.b === focus)
      const al = (focus && !hot ? 0.35 : 1) * ease((now - e.born) / 700)
      const [x1, y1] = toScreen(e.a), [x2, y2] = toScreen(e.b)
      arrow(x1, y1, x2, y2, rScreen(e.b), hexA(T.ink2.startsWith('#') ? T.ink2 : '#4a4945', 0.75 * al), hot ? 1.6 : 1.2)
      const lab = `revised in turn ${e.b.turn ?? '?'}`
      ctx.font = font(500, 10.5); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2 - 4
      const tw = ctx.measureText(lab).width
      const box = { x: mx - tw / 2 - 2, y: my - 13, w: tw + 4, h: 14 }
      // a label that would overlap another is left out (the arrow still says it)
      if (names.some(b => overlap(b, box) > 0)) return
      ctx.lineWidth = 3; ctx.strokeStyle = T.halo; ctx.strokeText(lab, mx, my)
      ctx.fillStyle = hexA(T.mut, al); ctx.fillText(lab, mx, my)
      names.push(box)
    })
    // nodes
    L.forEach(n => {
      const [sx, sy] = toScreen(n)
      const e = back((now - n.born) / 520)
      const r = rScreen(n) * e * (1 + 0.22 * n.hv)
      const p = (now - n.born) / 1100
      if (p < 1) { ctx.beginPath(); ctx.arc(sx, sy, rScreen(n) + 4 + 16 * ease(p), 0, 7); ctx.strokeStyle = hexA(colorOf(n), 0.45 * (1 - p)); ctx.lineWidth = 1.5; ctx.stroke() }
      if (S.fresh.has(n.id)) { ctx.beginPath(); ctx.arc(sx, sy, r + 4.5, 0, 7); ctx.strokeStyle = hexA(T.ring, 0.65 * n.va); ctx.lineWidth = 1.4; ctx.setLineDash([2, 2]); ctx.stroke(); ctx.setLineDash([]) }
      if (S.sel === n) { ctx.beginPath(); ctx.arc(sx, sy, r + 5.5, 0, 7); ctx.strokeStyle = hexA(T.ring, 0.95); ctx.lineWidth = 2; ctx.stroke() }
      mark(n, sx, sy, r, n.va)
      const k = saidNow(n)
      if (k > 1 && n.va > 0.4) { ctx.font = font(700, 10); ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = hexA(T.ink2.startsWith('#') ? T.ink2 : '#4a4945', n.va); ctx.fillText(`×${k}`, sx + r + 3, sy - r * 0.8) }
    })
    // the clusters' names (by cluster), above their claims, with how many
    if (S.color === 'cluster') {
      CLUSTERS.forEach(c => {
        const ms = L.filter(n => n.cluster === c.key)
        if (!ms.length) return
        let top = Infinity, cx = 0
        ms.forEach(n => { const [x, y] = toScreen(n); top = Math.min(top, y - rScreen(n)); cx += x })
        cx /= ms.length
        c.lx = c.lx ? c.lx + (cx - c.lx) * 0.2 : cx
        const lab = c.name, cnt = `${ms.length}`
        ctx.font = font(600, 13)
        const w1 = ctx.measureText(lab + ' ').width
        ctx.font = font(500, 11.5)
        const w2 = ctx.measureText(cnt).width
        const x = Math.max(6, Math.min(W - 6 - w1 - w2, c.lx - (w1 + w2) / 2)), y = Math.max(18, top - 12)
        const fade = focus && focus.cluster !== c.key ? 0.4 : 1
        ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'
        ctx.font = font(600, 13); ctx.fillStyle = hexA(T.ink.startsWith('#') ? T.ink : '#1f1e1c', fade); ctx.fillText(lab, x, y)
        ctx.font = font(500, 11.5); ctx.fillStyle = hexA(T.mut, fade); ctx.fillText(cnt, x + w1, y)
        names.push({ x: x - 2, y: y - 16, w: w1 + w2 + 4, h: 17 })
      })
    }
    // labels: the hovered claim in a pill; the revised claims (struck, left of them) and what replaced them
    const labs = []
    if (S.hover) labs.push({ n: S.hover, big: true })
    L.filter(revisedNow).forEach(n => labs.push({ n, left: true, max: 40 }))
    L.filter(n => n.revises && byId[n.revises] && shown(byId[n.revises])).forEach(n => labs.push({ n, max: 40 }))
    if (S.sel && S.sel !== S.hover) labs.push({ n: S.sel })
    if (filtering()) L.filter(matches).sort((a, b) => b.r - a.r).slice(0, 16).forEach(n => labs.push({ n }))
    const discs = L.filter(n => n.va > 0.4).map(n => { const [x, y] = toScreen(n), r = rScreen(n); return { n, x: x - r, y: y - r, w: 2 * r, h: 2 * r } })
    const got = placeLabels(labs.filter((x, i) => labs.findIndex(y => y.n === x.n) === i), names, discs)
    for (const g of got.filter(g => !g.big)) {
      const al = Math.max(0.5, Math.min(1, g.n.va))
      ctx.font = font(500, 11.5); ctx.textAlign = 'left'; ctx.textBaseline = 'top'
      ctx.lineWidth = 3.5; ctx.strokeStyle = T.halo; ctx.lineJoin = 'round'; ctx.strokeText(g.text, g.x, g.y + 1)
      const rev = revisedNow(g.n)
      ctx.fillStyle = hexA(rev ? T.mut : T.ink2.startsWith('#') ? T.ink2 : '#4a4945', al)
      textAt(g.text, g.x, g.y + 1, rev)
    }
    for (const g of got.filter(g => g.big)) {
      const b = g.box
      ctx.save(); ctx.shadowColor = 'rgba(30,28,24,.16)'; ctx.shadowBlur = 12; ctx.shadowOffsetY = 3
      ctx.fillStyle = T.pill; roundRect(b.x, b.y, b.w, b.h, 8); ctx.fill(); ctx.restore()
      ctx.strokeStyle = T.pillLine; ctx.lineWidth = 1; roundRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1, 8); ctx.stroke()
      ctx.beginPath(); ctx.arc(b.x + 12, b.y + b.h / 2, 4, 0, 7); ctx.fillStyle = colorOf(g.n); ctx.fill()
      ctx.font = font(600, 13.5); ctx.fillStyle = revisedNow(g.n) ? T.mut : T.ink; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      textAt(g.text, b.x + 21, b.y + b.h / 2 + 0.5, revisedNow(g.n))
    }
    S.lastLabels = got.map(g => ({ id: g.n.id, big: g.big }))
  }

  // ------------------------------------------------------------------------------------------------ the frame loop
  let changed = 0
  let sig = ''
  function frame(now) {
    const s = [S.hover && S.hover.id, S.sel && S.sel.id, S.solo, S.query, S.upto, S.color, N.length].join('|')
    if (s !== sig) { sig = s; changed = now }
    tick()
    const mv = fitCamera(false)
    const arriving = N.some(n => now - n.born < 1200)
    if (SIM.alpha > 0.002 || drag || mv > 0.3 || arriving || now - changed < 2200) draw(now)
    requestAnimationFrame(frame)
  }

  // ------------------------------------------------------------------------------------------------ tools
  const strip = $('#strip')
  /** The time strip: a section per turn (the corpus orientation last), a tick per claim in the order made, colored
   *  as the graph is; the handle at the cut-off. */
  function drawStrip() {
    const n = N.length
    if (!n) { strip.innerHTML = ''; $('#upto').innerHTML = ''; return }
    const at = i => (i / n) * 100
    const secs = []
    N.forEach((c, i) => {
      const key = c.by === 'orientation' ? 'corpus' : c.turn == null ? '?' : 'turn ' + c.turn
      if (!secs.length || secs[secs.length - 1].key !== key) secs.push({ key, from: i, to: i + 1 })
      else secs[secs.length - 1].to = i + 1
    })
    const cut = S.upto == null ? n : S.upto
    strip.innerHTML = secs.map(s => `<div class="sec" style="left:${at(s.from)}%;width:${at(s.to) - at(s.from)}%"><b>${esc(s.key)}</b></div>`).join('') +
      N.map((c, i) => `<i class="tick${revisedNow(c) ? ' rev' : ''}" style="left:calc(${at(i + 0.5)}% - .75px);background:${colorOf(c)}"></i>`).join('') +
      (cut < n ? `<div class="later" style="left:${at(cut)}%"></div>` : '') +
      `<div class="handle" style="left:${at(cut)}%"></div>`
    const last = N[Math.max(0, cut - 1)]
    const turns = turnsOf()
    $('#upto').innerHTML = cut >= n
      ? `all ${turns.length} turn${turns.length === 1 ? '' : 's'}<small>${n} of ${n} claims</small>`
      : `up to ${last.by === 'orientation' ? 'the corpus' : 'turn ' + (last.turn ?? '?')}<small>${cut} of ${n} claims</small>`
  }
  function setUpto(k) {
    const n = N.length
    k = Math.max(1, Math.min(n, Math.round(k)))
    S.upto = k >= n ? null : k
    drawStrip(); legend(); count()
    if (S.sel && !shown(S.sel)) closeDetail(); else if (S.sel) renderDetail(S.sel)
    reheat(0.04)
  }
  let striping = false
  const fromStrip = e => { const r = strip.getBoundingClientRect(); setUpto(((e.clientX - r.left) / r.width) * N.length) }
  strip.addEventListener('mousedown', e => { striping = true; fromStrip(e) })
  addEventListener('mousemove', e => { if (striping) fromStrip(e) })
  addEventListener('mouseup', () => { striping = false })
  /** The legend: one chip per group of the color mode, with how many claims it holds by the cut-off; a chip shows its
   *  group alone. */
  function legend() {
    const groups = new Map()
    N.filter(shown).forEach(n => {
      const g = groupOf(n)
      if (!groups.has(g.key)) groups.set(g.key, { ...g, n: 0 })
      groups.get(g.key).n++
    })
    $('#legend').innerHTML = [...groups.values()].map(g => `<button class="lg${S.solo === g.key ? ' on' : S.solo ? ' off' : ''}" data-k="${esc(g.key)}"><i style="background:${g.color}"></i>${esc(g.name)}<span class="n">${g.n}</span></button>`).join('')
    $('#legend').querySelectorAll('.lg').forEach(b => b.addEventListener('click', () => { S.solo = S.solo === b.dataset.k ? null : b.dataset.k; legend() }))
  }
  function count() {
    const L = N.filter(shown)
    const used = new Set(L.map(n => n.cluster).filter(Boolean)).size
    const merged = L.filter(n => saidNow(n) > 1).length
    const revised = L.filter(revisedNow).length
    $('#count').innerHTML = `<b>${L.length}</b> claims · <b>${used}</b> clusters · <b>${merged}</b> merged` + (revised ? ` · <b>${revised}</b> revised` : '') + (S.fresh.size ? ` · <span style="color:var(--atl)">+${S.fresh.size} new</span>` : '')
    const o = STORE && STORE.orientation
    $('#from').textContent = `from Claude's work and our chat${o && o.claims ? ' and the corpus' : ''} · deduped`
    const turns = turnsOf()
    $('#sub').textContent = turns.length ? (turns.length > 1 ? `turns ${turns[0]}–${turns[turns.length - 1]}` : `turn ${turns[0]}`) : 'this session'
    document.title = `Claims · ${L.length}`
  }
  $('#colorby').addEventListener('change', e => { S.color = e.target.value; S.solo = null; legend(); drawStrip(); changed = performance.now() })
  const q = $('#q')
  q.addEventListener('focus', () => $('#search').classList.add('focus'))
  q.addEventListener('blur', () => $('#search').classList.remove('focus'))
  q.addEventListener('input', () => { S.query = q.value.trim(); $('#qn').textContent = S.query ? N.filter(n => matches(n) && shown(n)).length : '' })

  // ------------------------------------------------------------------------------------------------ pointer
  let downAt = null
  const local = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] }
  function pick(px, py) {
    let best = null, bd = Infinity
    live().forEach(n => {
      if (!shown(n)) return
      const [sx, sy] = toScreen(n), d = Math.hypot(sx - px, sy - py)
      if (d < rScreen(n) + 7 && d < bd) { best = n; bd = d }
    })
    return best
  }
  cv.addEventListener('mousemove', e => {
    const [px, py] = local(e)
    if (drag) { drag.fx = cam.x + (px - W / 2) / cam.k; drag.fy = cam.y + (py - H / 2 - 8) / cam.k; reheat(0.25); return }
    const n = pick(px, py)
    if (S.hover !== n) { S.hover = n; cv.classList.toggle('hand', !!n) }
  })
  cv.addEventListener('mouseleave', () => { if (!drag) S.hover = null })
  cv.addEventListener('mousedown', e => { const [px, py] = local(e); const n = pick(px, py); downAt = [px, py]; if (n) { drag = n; n.fx = n.x; n.fy = n.y; cv.classList.add('grab') } })
  addEventListener('mouseup', () => { if (!drag) return; const n = drag; drag = null; n.fx = n.fy = null; cv.classList.remove('grab'); reheat(0.15) })
  cv.addEventListener('click', e => {
    const [px, py] = local(e)
    if (downAt && Math.hypot(px - downAt[0], py - downAt[1]) > 4) return
    const n = pick(px, py)
    if (n) select(n); else if (S.sel) closeDetail()
  })

  // ------------------------------------------------------------------------------------------------ the details
  const detail = $('#detail')
  const resolved = new Map()
  function resolve(ref, n) {
    const key = ref + '|' + n
    if (!resolved.has(key)) resolved.set(key, fetch(`${BASE}/api/resolve?ref=${enc(ref)}&n=${n}`, { cache: 'no-store' }).then(r => (r.ok ? r.json() : r.text().then(t => ({ error: t.slice(0, 200) || 'HTTP ' + r.status })))).catch(e => ({ error: String(e.message || e) })))
    return resolved.get(key)
  }
  function shortRef(ref) {
    const m = /^(q\d+)(?:#(.*))?$/.exec(ref)
    if (m) {
      const [frag, col] = String(m[2] || '').split('@')
      let words = frag || ''
      try { words = decodeURIComponent(words) } catch { /* as written */ }
      return [m[1], words.replace(/&/g, ' '), col].filter(Boolean).join(' · ')
    }
    const [path, loc] = ref.split('#')
    const file = path.split('/').pop()
    const line = /^L(\d+)/.exec(loc || '')
    return line ? `${file}:${line[1]}` : file + (loc ? '#' + loc : '')
  }
  const who = p => (p.by === 'person' ? 'you' : p.by === 'orientation' ? 'corpus' : 'reply')
  function sentenceHtml(p) {
    const s = String(p.sentence || ''), qt = String(p.quote || '')
    if (!s) return qt ? `“${esc(qt)}”` : ''
    const k = qt ? s.toLowerCase().indexOf(qt.toLowerCase()) : -1
    if (k < 0) return `“${esc(qt || s)}”`
    return `“${esc(s.slice(0, k))}<b>${esc(s.slice(k, k + qt.length))}</b>${esc(s.slice(k + qt.length))}”`
  }
  const post = m => { try { if (window.parent !== window) window.parent.postMessage(m, '*') } catch { /* no parent page */ } }
  function select(n) {
    S.sel = n
    S.asking = false
    renderDetail(n)
    history.replaceState(null, '', location.pathname + location.search + '#c=' + enc(n.id))
    post({ type: 'thimble:claim', claim: n.id })
  }
  function closeDetail() {
    S.sel = null
    S.asking = false
    renderNone()
    history.replaceState(null, '', location.pathname + location.search)
  }
  function renderNone() {
    detail.classList.remove('on')
    detail.innerHTML = `<div class="none"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2l9 5-4 1-1 4z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>Select a claim to see where it was said<span class="sp"></span><span class="lab">DETAILS</span></div>`
  }
  function renderDetail(n) {
    detail.classList.add('on')
    const c = CBY[n.cluster]
    const k = saidNow(n)
    const revised = revisedNow(n)
    const rep = revised ? byId[n.revised_by] : null
    const org = n.revises && byId[n.revises] && shown(byId[n.revises]) ? byId[n.revises] : null
    const places = n.said.slice(0, k)
    const first = places[0] || {}
    const srcs = n.sources.map((s, i) => `<span class="cite" data-i="${i}" title="${esc(s.ref)}">${esc(s.label || shortRef(s.ref))}</span>`).join(' ')
    detail.innerHTML =
      `<div class="dh"><i style="background:${colorOf(n)}"></i><span class="t${revised ? ' struck' : ''}">${esc(n.text)}</span><span class="tag${revised ? ' rev' : ''}">${revised ? 'revised' : n.tag}</span>${k > 1 ? `<span class="xn">×${k}</span>` : ''}<span class="sp"></span><span class="cl">${esc(c ? c.name : 'between clusters')}</span><span class="x" id="x">esc</span></div>` +
      `<div class="meta"><span>${first.by === 'orientation' ? 'from the <b>corpus orientation</b>' : `said in <b>turn ${first.turn ?? '?'}</b>${first.by === 'person' ? ' by you' : ''}`}</span>${srcs ? `<span>sources ${srcs}</span>` : '<span>no citation in or near its sentence</span>'}${k > 1 ? `<span><span class="xn">×${k}</span> said ${k} times, merged into one</span>` : ''}</div>` +
      `<div class="places" id="places">${places.map((p, i) => `<span class="w${p.row ? ' go' : ''}" data-i="${i}">${p.by === 'orientation' ? 'corpus' : 'turn ' + (p.turn ?? '?')}</span><span class="w">${who(p)}</span><span class="q${p.row ? ' go' : ''}" data-i="${i}">${sentenceHtml(p)}${p.ref ? ` <span class="w">${esc(shortRef(p.ref))}</span>` : ''}</span>`).join('')}</div>` +
      (rep ? `<div class="repl">revised in turn ${rep.turn ?? '?'} → <a data-id="${esc(rep.id)}">${esc(rep.text)}</a></div>` : '') +
      (org ? `<div class="repl">replaces <s>${esc(org.text)}</s> · said in turn ${org.turn ?? '?'}, revised in turn ${n.turn ?? '?'} · <a data-id="${esc(org.id)}">open it</a></div>` : '') +
      `<div class="dfoot" id="dfoot"><button class="ask" id="ask"><kbd>↵</kbd>ask about this claim</button><span class="tip">] [ step through time · a place opens its message · a source opens its rows</span><div class="askbox"><input id="askq" placeholder="Ask about this claim…" spellcheck="false" autocomplete="off"><button class="send" id="send" title="send">↑</button></div><span class="said" id="said"></span></div>`
    detail.querySelectorAll('.repl a').forEach(a => a.addEventListener('click', () => { const m = byId[a.dataset.id]; if (m) select(m) }))
    detail.querySelectorAll('.places .go').forEach(el => el.addEventListener('click', () => openPlace(places[Number(el.dataset.i)])))
    detail.querySelectorAll('.meta .cite').forEach(el => el.addEventListener('click', () => toggleRows(n.sources[Number(el.dataset.i)])))
    $('#x').addEventListener('click', closeDetail)
    $('#ask').addEventListener('click', ask)
    $('#send').addEventListener('click', send)
    $('#askq').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); send() } if (e.key === 'Escape') { e.preventDefault(); stopAsking() } e.stopPropagation() })
  }
  function openPlace(p) {
    if (!p || !p.row) return
    if (window.parent !== window) { post({ type: 'thimble:row', row: p.row }); return }
    window.open(`${BASE}/mirror/#row=${enc(p.row)}`, '_blank', 'noopener')
  }
  function toggleRows(s) {
    const box0 = $('#places')
    const old = box0.querySelector('.rows')
    if (old && old.dataset.ref === s.ref) { old.remove(); return }
    if (old) old.remove()
    const box = document.createElement('div')
    box.className = 'rows'
    box.dataset.ref = s.ref
    box.innerHTML = '<div class="r">reading…</div>'
    box0.appendChild(box)
    resolve(s.ref, 5).then(r => {
      if (!r || r.error) { box.innerHTML = `<div class="err">${esc(s.ref)} does not resolve: ${esc(r ? r.error : 'no answer')}</div>`; return }
      const qy = (r.chain || []).find(x => x.step === 'query')
      const lines = []
      if (qy) lines.push(`<div><span class="r">${esc(qy.id)}</span>${esc(qy.about || '')}${qy.value != null ? ' = ' + esc(qy.value) : ''} · ${esc(r.count != null ? fmt(r.count) + ' source rows' : (r.rows || []).join(', '))}</div>`)
      for (const x of (r.records || []).slice(0, 5)) lines.push(`<div title="${esc(x.text)}"><span class="r">${esc(shortRef(x.ref))}</span>${esc(String(x.text).replace(/\s+/g, ' ').slice(0, 400))}</div>`)
      box.innerHTML = lines.join('') || `<div>${esc(s.ref)}</div>`
    })
  }
  function ask() { if (!S.sel) return; S.asking = true; $('#dfoot').classList.add('asking'); $('#askq').focus() }
  function stopAsking() { S.asking = false; const f = $('#dfoot'); if (f) f.classList.remove('asking'); const x = $('#askq'); if (x) x.blur() }
  async function send() {
    const n = S.sel
    const box = $('#askq')
    const text = box ? box.value.trim() : ''
    if (!n || !text) return
    const first = n.said.find(p => p.row)
    const said = $('#said')
    try {
      const r = await fetch(`${BASE}/api/back`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ask: text, scope: { claim: n.id, label: n.text, ...(first ? { row: first.row } : {}) } }) })
      if (!r.ok) throw new Error((await r.text()).slice(0, 120) || 'HTTP ' + r.status)
      box.value = ''
      said.className = 'said ok'
      said.textContent = 'sent to the terminal: Claude answers there, about this claim'
      stopAsking()
    } catch (e) {
      said.className = 'said bad'
      said.textContent = `not sent (${e.message}). In the terminal, press c, put the ring on "${n.text}", and type the question.`
    }
  }

  // ------------------------------------------------------------------------------------------------ keys
  document.addEventListener('keydown', e => {
    const k = e.key
    if (document.activeElement === q) {
      if (k === 'Escape') { q.value = ''; S.query = ''; q.blur(); e.preventDefault() }
      if (k === 'Enter') { q.blur(); e.preventDefault() }
      return
    }
    if (k === 'Escape') {
      e.preventDefault()
      if (S.asking) return stopAsking()
      if (S.query) { q.value = ''; S.query = ''; return }
      if (S.solo) { S.solo = null; return legend() }
      if (S.sel) return closeDetail()
      return
    }
    if (k === ']' || k === '[') { setUpto((S.upto == null ? N.length : S.upto) + (k === ']' ? 1 : -1)); e.preventDefault(); return }
    if (k === '/') { q.focus(); e.preventDefault(); return }
    if (k === 'Enter' && S.sel) { ask(); e.preventDefault() }
  })

  // ------------------------------------------------------------------------------------------------ loading
  function empty(html) {
    const el = $('#empty')
    el.innerHTML = html ? `<div>${html}</div>` : ''
    el.classList.toggle('on', !!html)
  }
  async function fetchStore() {
    const embedded = window.CLAIMS_STORE || (document.getElementById('claims-store') && JSON.parse(document.getElementById('claims-store').textContent))
    if (embedded) return { store: embedded }
    try {
      const headers = S.etag ? { 'if-none-match': S.etag } : {}
      const r = await fetch(SRC + (SRC.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store', headers })
      if (r.status === 304) return { same: true }
      if (!r.ok) return { error: `${r.status} ${(await r.text()).slice(0, 120)}` }
      S.etag = r.headers.get('etag') || ''
      const j = await r.json()
      const store = j && j.store ? j.store : j
      return store && Array.isArray(store.claims) ? { store } : { error: 'the answer is not a claims store' }
    } catch (e) { return { error: String(e.message || e) } }
  }
  async function load(first) {
    const got = await fetchStore()
    if (got.same) return
    if (got.error) {
      if (first || !STORE) { $('#sub').textContent = 'no claims yet'; empty(`<b>No claims yet.</b><br>They are read after each turn of work in the terminal, from what Claude and you said.<br><span style="font-size:12px">(${esc(got.error)})</span>`) }
      else $('#st').textContent = 'the page server stopped · open the claims again from the terminal'
      return
    }
    const store = got.store
    if (STORE && store.updated && store.updated === STORE.updated && store.claims.length === STORE.claims.length) return
    STORE = store
    readTheme()
    if (!store.claims.length) { empty('<b>No claims yet.</b><br>They are read after each turn of work in the terminal, from what Claude and you said.'); count(); return }
    empty('')
    const before = new Set(N.map(n => n.id))
    const added = ingest(store)
    const now = performance.now()
    if (!S.loaded) {
      settle(now)
      fitCamera(true)
      S.loaded = true
      const want = /[#&]c=([^&]+)/.exec(HASH)
      const hit = want ? byId[decodeURIComponent(want[1])] : null
      if (hit) setTimeout(() => select(hit), READY ? 0 : 900)
    } else if (added.length) {
      added.forEach((n, i) => { place(n); n.born = now + i * 200 })
      EDGES.forEach(e => { if (!before.has(e.a.id) || !before.has(e.b.id)) e.born = now })
      S.fresh = new Set(added.filter(n => before.size && !before.has(n.id)).map(n => n.id))
      SIM.target = 0
      reheat(0.35)
    }
    drawStrip(); legend(); count()
    if (S.sel) { if (byId[S.sel.id]) renderDetail(byId[S.sel.id]); else closeDetail() }
    $('#st').textContent = store.updated ? `read ${String(store.updated).slice(11, 16)}` : ''
  }

  readTheme()
  renderNone()
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readTheme(); CLUSTERS.forEach(c => { if (c.id != null) c.color = (DARK ? PAL_DARK : PAL)[c.i % PAL.length] }); legend(); drawStrip(); changed = performance.now() })
  addEventListener('resize', () => { size(); changed = performance.now() })
  // the details below grow and shrink: the graph's room follows
  if (window.ResizeObserver) new ResizeObserver(() => { size(); changed = performance.now() }).observe(gw)
  addEventListener('message', e => { const m = e.data; if (m && m.type === 'thimble:open-claim' && byId[m.claim]) select(byId[m.claim]) })
  size()
  const FIXED = !!window.CLAIMS_STORE
  load(true).then(() => {
    requestAnimationFrame(frame)
    document.body.dataset.ready = '1'
    setInterval(() => { if (document.visibilityState === 'visible' && !FIXED) load(false) }, POLL_MS)
  })
  window.Claims = { S, N, get byId() { return byId }, CLUSTERS, cam, select, closeDetail, setUpto, setColor: c => { $('#colorby').value = c; $('#colorby').dispatchEvent(new Event('change')) }, labels: () => S.lastLabels || [],
    nodeAt(id) { const n = byId[id]; if (!n) return null; const [x, y] = toScreen(n); const r = cv.getBoundingClientRect(); return [r.left + x, r.top + y] },
    hover(id) { S.hover = byId[id] || null; changed = performance.now() } }
})()
