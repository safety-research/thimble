// atlas.js: the Atlas page. One atlas object (lean/verbs/atlas) drawn as a force graph on a canvas, with no library:
// a node per claim colored by its kind, edges for its relations (supports: a line, contradicts: red dashes, same
// topic: dots), clusters as soft regions with their names. Hover names a claim and lights its neighbors, with a label
// placement pass so no two names overlap. A click opens the claim below the graph: its kind and cluster, its evidence
// (each citation opens its rows through the page server's `lean resolve`), its related claims, and ↵ ask, which sends
// a question about the claim to the terminal. 1-5 filter by kind, / searches, esc steps back.
//
// It reads the object from the page server (the first route that answers, see SOURCES) and asks again every few
// seconds while the page is visible, so claims a later message adds arrive in place.
(function () {
  'use strict'
  const $ = (s, r) => (r || document).querySelector(s)
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const fmt = n => (typeof n === 'number' ? n.toLocaleString('en-US') : String(n))
  const slug = s => String(s).replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^-+/, '').slice(0, 56) || 'x'

  // ------------------------------------------------------------------------------------------------ where it reads
  const params = new URLSearchParams(location.search)
  const HASH = location.hash
  const READY = /(^|[#&])ready\b/.test(HASH)
  const token = location.pathname.split('/').filter(Boolean)[0] || ''
  const BASE = params.get('base') || (token && token !== 'atlas' ? '/' + token : '')
  const OID = params.get('o') || 'atlas'
  const enc = encodeURIComponent
  const SOURCES = params.get('src') ? [params.get('src')] : [`${BASE}/o/${enc(OID)}.json`, `${BASE}/api/object/${enc(OID)}`, `${BASE}/api/objects/${enc(OID)}`, `${BASE}/objects/${enc(OID)}.json`]
  const POLL_MS = 3000

  // ------------------------------------------------------------------------------------------------ kinds and colors
  const KINDS = [
    { id: 'fact', name: 'fact', color: '#5b6b82', dark: '#8fa1bd' },
    { id: 'finding', name: 'finding', color: '#1f8a84', dark: '#3cc2b9' },
    { id: 'judgment', name: 'judgment call', color: '#c25c8a', dark: '#e384b2' },
    { id: 'event', name: 'event', color: '#a8875a', dark: '#cfae7e' },
    { id: 'claim', name: 'claim', color: '#7b5bb6', dark: '#a98be0' },
  ]
  const KORDER = KINDS.map(k => k.id)
  const KNAME = {}
  KINDS.forEach(k => { KNAME[k.id] = k.name })
  const kindOf = k => {
    const s = String(k == null ? '' : k).toLowerCase().trim()
    if (s.startsWith('judg') || s === 'decision') return 'judgment'
    return KORDER.includes(s) ? s : 'claim'
  }
  const relOf = t => {
    const s = String(t == null ? '' : t).toLowerCase()
    return s.startsWith('contra') ? 'x' : s.startsWith('support') ? 's' : 't'
  }
  // cluster regions: a tint, its edge and the ink of its name (light), and the same three on a dark page
  const TINTS = [
    ['#ece8df', '#d9d2c4', '#7b7266'], ['#ece5f6', '#d8cbec', '#76609f'], ['#e2ecf3', '#c9dae6', '#4f6f84'], ['#e0efe4', '#c3dfcb', '#457f54'],
    ['#f6e8d3', '#ecd2ad', '#9c661c'], ['#ebe8e2', '#d8d3ca', '#7f796f'], ['#f6e4ec', '#ecc9d8', '#9c4a6e'], ['#dff0ee', '#bfe0dc', '#2f7a74'],
  ]
  const TINTS_DARK = [
    ['#2f2c27', '#4a443a', '#c2b8a8'], ['#2e2838', '#4a3e5e', '#c3b0e6'], ['#25303a', '#3a4c5c', '#a9c4d8'], ['#26332a', '#3b5442', '#a6d1b1'],
    ['#382e22', '#5a4730', '#e2bc80'], ['#2d2b28', '#47433d', '#bdb6aa'], ['#372a30', '#59414c', '#e0a8c0'], ['#243331', '#38524e', '#9fd6cf'],
  ]
  let DARK = false
  const T = { bg: '#fcfbf8', ink: '#1f1e1c', ink2: '#4a4945', mut: '#85837c', halo: 'rgba(252,251,248,.92)', pill: '#ffffff', pillLine: '#e2e0da', ring: '#8a4fb5', bad: '#c94f4a', good: '#3f8a3e', line: '#9c978d', topic: '#8f8a80' }
  function readTheme() {
    const cs = getComputedStyle(document.documentElement)
    const v = n => cs.getPropertyValue(n).trim()
    DARK = matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light' || document.documentElement.dataset.theme === 'dark'
    Object.assign(T, { bg: v('--view'), ink: v('--ink'), ink2: v('--ink2'), mut: v('--mut'), halo: v('--halo'), pill: v('--bg'), pillLine: v('--line2'), ring: v('--atl'), bad: v('--bad'), good: v('--good') })
    T.line = DARK ? '#8a857c' : '#9c978d'
    T.topic = DARK ? '#7d786f' : '#8f8a80'
    T.font = getComputedStyle(document.body).fontFamily
    CLUSTERS.forEach(tint)
  }
  const kcolor = k => { const x = KINDS.find(y => y.id === k) || KINDS[4]; return DARK ? x.dark : x.color }
  function hexA(hex, a) {
    if (!hex || hex[0] !== '#') return hex
    const v = parseInt(hex.slice(1), 16)
    return `rgba(${v >> 16 & 255},${v >> 8 & 255},${v & 255},${a})`
  }

  // ------------------------------------------------------------------------------------------------ the graph's state
  let OBJ = null
  let SRC = null
  const N = []
  let byId = {}
  let EDGES = []
  const CLUSTERS = []
  let CBY = {}
  const S = { hover: null, sel: null, solo: null, query: '', panel: 0, asking: false, fresh: new Set(), loaded: false }
  let seed = 17
  const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }

  function tint(c) {
    const t = (DARK ? TINTS_DARK : TINTS)[c.ti % TINTS.length]
    c.tint = t[0]; c.edge = t[1]; c.ink = t[2]
  }
  function radiusOf(n) {
    const refs = n.ev.length
    let r = 4.6 + Math.min(5, Math.sqrt(refs + n.adj.length) * 1.25)
    if (typeof n.n === 'number' && typeof n.of === 'number' && n.of > 0) r = Math.max(r, 4.6 + Math.sqrt(Math.min(1, n.n / n.of)) * 7.5)
    return Math.min(13, r)
  }
  function layoutAnchors() {
    const used = CLUSTERS.filter(c => N.some(n => n.cluster === c.id))
    const m = used.length
    const rx = 150 + 12 * Math.sqrt(N.length)
    const ry = rx * 0.62
    used.forEach((c, i) => {
      const a = -Math.PI / 2 + (i / Math.max(1, m)) * Math.PI * 2 + (m % 2 ? 0 : Math.PI / m / 2)
      c.ax = m === 1 ? 0 : Math.cos(a) * rx
      c.ay = m === 1 ? 0 : Math.sin(a) * ry
    })
  }

  /** The object's claims, clusters and relations into the graph; claims already there keep their place. */
  function ingest(o) {
    const d = o && o.data ? o.data : {}
    const claims = (Array.isArray(d.claims) ? d.claims : []).filter(c => c && c.id != null && c.name)
    const clusters = (Array.isArray(d.clusters) ? d.clusters : []).filter(c => c && c.id != null)
    clusters.forEach(c => {
      const id = String(c.id)
      if (CBY[id]) { CBY[id].name = String(c.name || id); return }
      const k = { id, name: String(c.name || id), lead: c.lead, ti: CLUSTERS.length, form: 0, hl: 0, lx: 0, ly: 0, cx: 0, cy: 0, ax: 0, ay: 0 }
      tint(k)
      CLUSTERS.push(k)
      CBY[id] = k
    })
    const keep = new Set(claims.map(c => String(c.id)))
    for (let i = N.length - 1; i >= 0; i--) if (!keep.has(N[i].id)) N.splice(i, 1)
    const added = []
    claims.forEach((c, i) => {
      const id = String(c.id)
      const ev = (Array.isArray(c.evidence) ? c.evidence : []).map(e => (typeof e === 'string' ? { ref: e } : e)).filter(e => e && e.ref)
      const fields = { name: String(c.name), kind: kindOf(c.kind), cluster: CBY[String(c.cluster)] ? String(c.cluster) : null, ev, n: c.n, of: c.of, note: c.note || '', order: i }
      if (byId[id]) Object.assign(byId[id], fields)
      else {
        const n = Object.assign({ id, x: 0, y: 0, vx: 0, vy: 0, live: false, born: 0, va: 1, hv: 0, fx: null, fy: null, adj: [] }, fields)
        N.push(n)
        added.push(n)
      }
    })
    byId = {}
    N.forEach(n => { byId[n.id] = n; n.adj = [] })
    EDGES = []
    const seen = new Set()
    for (const r of Array.isArray(d.relations) ? d.relations : []) {
      const a = byId[String(r && r.from)]
      const b = byId[String(r && r.to)]
      if (!a || !b || a === b) continue
      const t = relOf(r.type)
      const key = a.id + '\u0000' + b.id + '\u0000' + t
      if (seen.has(key)) continue
      seen.add(key)
      const e = { a, b, t, born: 0, cross: a.cluster !== b.cluster }
      EDGES.push(e)
      a.adj.push({ n: b, t, dir: 'out', e })
      b.adj.push({ n: a, t, dir: 'in', e })
    }
    N.forEach(n => { n.r = radiusOf(n) })
    layoutAnchors()
    return added
  }

  // ------------------------------------------------------------------------------------------------ the simulation
  // velocity Verlet with d3-style alpha cooling: repulsion, links, a pull toward each cluster's centre and anchor,
  // and position-based collisions
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
        const same = p.cluster && p.cluster === q.cluster
        const w = (same ? -150 : -210) * a / Math.max(l2, 120)
        p.vx += dx * w; p.vy += dy * w; q.vx -= dx * w; q.vy -= dy * w
      }
    }
    for (const e of EDGES) {
      const s = e.a, t = e.b
      if (!s.live || !t.live) continue
      const dist = (e.t === 'x' ? 92 : e.t === 's' ? 52 : 58) + (e.cross ? 45 : 0)
      const str = (e.t === 's' ? 0.55 : e.t === 'x' ? 0.25 : 0.4) * (e.cross ? 0.22 : 1) / Math.max(1, Math.min(s.adj.length, t.adj.length)) * 2.2
      let dx = t.x + t.vx - s.x - s.vx, dy = t.y + t.vy - s.y - s.vy
      let l = Math.sqrt(dx * dx + dy * dy) || 1
      l = (l - dist) / l * a * str
      dx *= l; dy *= l
      t.vx -= dx * 0.5; t.vy -= dy * 0.5; s.vx += dx * 0.5; s.vy += dy * 0.5
    }
    for (const c of CLUSTERS) {
      const ms = L.filter(n => n.cluster === c.id)
      if (!ms.length) continue
      let cx = 0, cy = 0
      ms.forEach(n => { cx += n.x; cy += n.y })
      cx /= ms.length; cy /= ms.length
      c.cx = cx; c.cy = cy
      const g = 0.09 * a * Math.min(1, ms.length / 3)
      ms.forEach(n => {
        n.vx += (cx - n.x) * g + (c.ax - n.x) * 0.018 * a
        n.vy += (cy - n.y) * g + (c.ay - n.y) * 0.018 * a
      })
    }
    // clusters keep apart: two whose discs overlap push their members away from each other, so no region covers
    // another's claims
    const discs = []
    for (const c of CLUSTERS) {
      const ms = L.filter(n => n.cluster === c.id)
      if (!ms.length) continue
      let s2 = 0
      ms.forEach(n => { s2 += (n.x - c.cx) ** 2 + (n.y - c.cy) ** 2 })
      discs.push({ ms, x: c.cx, y: c.cy, r: Math.sqrt(s2 / ms.length) * 1.25 + 26 })
    }
    for (let i = 0; i < discs.length; i++) {
      for (let j = i + 1; j < discs.length; j++) {
        const p = discs[i], q = discs[j]
        const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 1
        const gap = p.r + q.r - d
        if (gap <= 0) continue
        const f = gap / d * 0.12 * a
        const wp = q.ms.length / (p.ms.length + q.ms.length), wq = 1 - wp
        p.ms.forEach(n => { n.vx -= dx * f * wp; n.vy -= dy * f * wp })
        q.ms.forEach(n => { n.vx += dx * f * wq; n.vy += dy * f * wq })
      }
    }
    L.forEach(n => { if (!n.cluster) { n.vx += -n.x * 0.01 * a; n.vy += -n.y * 0.01 * a } })
    L.forEach(n => {
      if (n.fx != null) { n.x = n.fx; n.y = n.fy; n.vx = n.vy = 0; return }
      n.vx *= SIM.vdecay; n.vy *= SIM.vdecay
      n.x += n.vx; n.y += n.vy
    })
    for (let i = 0; i < L.length; i++) {
      for (let j = i + 1; j < L.length; j++) {
        const p = L[i], q = L[j]
        const min = p.r + q.r + 9
        let dx = q.x - p.x, dy = q.y - p.y
        const l2 = dx * dx + dy * dy
        if (l2 >= min * min) continue
        const l = Math.sqrt(l2) || 0.01, m = (min - l) / l * 0.5 * 0.7
        dx *= m; dy *= m
        if (p.fx == null) { p.x -= dx; p.y -= dy }
        if (q.fx == null) { q.x += dx; q.y += dy }
      }
    }
    SIM.alpha += (SIM.target - SIM.alpha) * SIM.decay
  }
  const reheat = v => { SIM.alpha = Math.max(SIM.alpha, v) }

  /** A node's first place: beside a live neighbor in its cluster, else near its cluster's anchor. */
  function place(n) {
    const nb = n.adj.map(x => x.n).filter(m => m.live)
    const c = CBY[n.cluster]
    if (nb.length) {
      const m = nb.find(m => m.cluster === n.cluster) || nb[0]
      const ang = rnd() * Math.PI * 2
      n.x = m.x + Math.cos(ang) * 26; n.y = m.y + Math.sin(ang) * 26
    } else if (c) {
      const has = N.some(m => m.live && m.cluster === c.id)
      n.x = (has ? c.cx : c.ax) + (rnd() - 0.5) * 40; n.y = (has ? c.cy : c.ay) + (rnd() - 0.5) * 40
    } else { n.x = (rnd() - 0.5) * 60; n.y = (rnd() - 0.5) * 60 }
    n.vx = n.vy = 0
    n.live = true
  }

  /** The whole graph laid out at once, off screen, as a live build would leave it; then shown arriving claim by
   *  claim (or at once with #ready). */
  function settle(now) {
    const order = N.slice().sort((a, b) => (a.cluster === b.cluster ? a.order - b.order : String(a.cluster).localeCompare(String(b.cluster))))
    SIM.target = 0.28
    SIM.alpha = 0.5
    order.forEach((n, i) => { place(n); for (let k = 0; k < 3; k++) tick(); if (i % 8 === 7) reheat(0.5) })
    for (let i = 0; i < 260; i++) tick()
    SIM.target = 0
    for (let i = 0; i < 420; i++) tick()
    const step = READY ? 0 : Math.min(60, 2400 / Math.max(1, order.length))
    order.forEach((n, i) => { n.born = now + i * step })
    EDGES.forEach(e => { e.born = Math.max(e.a.born, e.b.born) })
    CLUSTERS.forEach(c => { c.form = READY ? 1 : 0 })
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
  const panelH = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--panel')) || 282
  const vpTop = 58
  const vpBot = () => 36 + S.panel * (panelH() - 30)
  const vpCenterY = () => vpTop + (H - vpTop - vpBot()) / 2
  const toScreen = n => [W / 2 + (n.x - cam.x) * cam.k, vpCenterY() + (n.y - cam.y) * cam.k]
  const rScreen = n => n.r * Math.max(0.78, Math.min(1.25, cam.k))
  function fitCamera(snap) {
    const L = live()
    if (!L.length) return 0
    let set = L
    if (S.sel && S.panel > 0.5) set = [S.sel].concat(S.sel.adj.map(x => x.n).filter(n => n.live))
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    set.forEach(n => { x0 = Math.min(x0, n.x - n.r - 34); x1 = Math.max(x1, n.x + n.r + 34); y0 = Math.min(y0, n.y - n.r - 40); y1 = Math.max(y1, n.y + n.r + 28) })
    const vw = W - 60, vh = H - vpTop - vpBot()
    let k = Math.min(vw / Math.max(1, x1 - x0), vh / Math.max(1, y1 - y0), 1.45)
    k = Math.max(k, 0.35)
    const tx = (x0 + x1) / 2, ty = (y0 + y1) / 2
    const f = snap ? 1 : 0.06
    const mv = Math.abs(tx - cam.x) * cam.k + Math.abs(ty - cam.y) * cam.k + Math.abs(k - cam.k) * 400
    cam.x += (tx - cam.x) * f; cam.y += (ty - cam.y) * f; cam.k += (k - cam.k) * f
    return mv
  }

  function hull(pts) {
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1])
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    const lo = [], up = []
    for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p) }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p) }
    up.pop(); lo.pop()
    return lo.concat(up)
  }
  function smoothPath(h) {
    const n = h.length
    ctx.beginPath()
    for (let i = 0; i < n; i++) {
      const p0 = h[(i - 1 + n) % n], p1 = h[i], p2 = h[(i + 1) % n], p3 = h[(i + 2) % n]
      if (i === 0) ctx.moveTo(p1[0], p1[1])
      ctx.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1])
    }
    ctx.closePath()
  }
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath() }
  const ease = t => (t < 0 ? 0 : t > 1 ? 1 : 1 - Math.pow(1 - t, 3))
  const back = t => { if (t <= 0) return 0; if (t >= 1) return 1; const c1 = 1.5, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2) }
  const matches = n => (!S.solo || n.kind === S.solo) && (!S.query || (n.name + ' ' + n.note).toLowerCase().includes(S.query.toLowerCase()))
  const filtering = () => !!(S.solo || S.query)
  const font = (w, px) => `${w} ${px}px ${T.font || 'sans-serif'}`
  const clip = (s, max) => (s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s)
  const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))

  /**
   * Names placed so that none overlaps another name, a node or a cluster's name: each label tries spots around its
   * node (below, above, right, left, then the corners), first touching the node and then farther out with a short
   * leader line; the first spot that is free wins, in order of priority (the hovered claim first, then contradictions,
   * then support, then the rest by size). A label with no free spot within reach is left out rather than drawn over
   * another, and the claim's name is still in the panel and the search.
   */
  function placeLabels(labs, obstacles, discs) {
    const placed = []
    const out = []
    for (const lab of labs) {
      const n = lab.n
      const [sx, sy] = toScreen(n)
      const r = rScreen(n) * (1 + 0.22 * n.hv)
      if (lab.big) {
        ctx.font = font(600, 13.5)
        const text = clip(n.name, 64)
        const tw = ctx.measureText(text).width
        const bw = tw + 30, bh = 26
        const spots = []
        for (const d of [9, 24, 40]) {
          spots.push([sx - bw / 2, sy - r - bh - d], [sx - bw / 2, sy + r + d], [sx + r + d, sy - bh / 2], [sx - r - d - bw, sy - bh / 2])
          spots.push([sx - bw * 0.2, sy - r - bh - d], [sx - bw * 0.8, sy - r - bh - d], [sx - bw * 0.2, sy + r + d], [sx - bw * 0.8, sy + r + d])
        }
        let best = null
        for (const [x0, y0] of spots) {
          const b = { x: Math.max(6, Math.min(W - bw - 6, x0)), y: Math.max(vpTop - 36, Math.min(H - bh - 6, y0)), w: bw, h: bh }
          const cost = placed.reduce((s, p) => s + overlap(b, p), 0) + discs.reduce((s, d) => (d.n === n ? s : s + overlap(b, d)), 0)
          if (!best || cost < best.cost) best = { ...b, cost }
          if (!cost) break
        }
        placed.push(best)
        out.push({ n, big: true, text, box: best })
        continue
      }
      ctx.font = font(500, 11.5)
      const text = clip(n.name, 46)
      const tw = ctx.measureText(text).width, lh = 14
      let got = null
      for (const d of [3, 16, 30]) {
        const rr = r + d
        const cands = [
          [sx - tw / 2, sy + rr], [sx - tw / 2, sy - rr - lh], [sx + rr + 2, sy - lh / 2], [sx - rr - 2 - tw, sy - lh / 2],
          [sx + rr * 0.7, sy + rr * 0.7], [sx - rr * 0.7 - tw, sy + rr * 0.7], [sx + rr * 0.7, sy - rr * 0.7 - lh], [sx - rr * 0.7 - tw, sy - rr * 0.7 - lh],
        ]
        for (const [x, y] of cands) {
          const b = { x: x - 2, y: y - 1, w: tw + 4, h: lh + 2 }
          if (b.x < 4 || b.x + b.w > W - 4 || b.y < vpTop - 30 || b.y + b.h > H - 4) continue
          if (placed.some(p => overlap(b, p) > 0)) continue
          if (discs.some(q => q.n !== n && overlap(b, q) > 0)) continue
          if (obstacles.some(q => overlap(b, q) > 0)) continue
          got = { b, x, y, lead: d > 3 }
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

  function draw(now) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    ctx.clearRect(0, 0, W, H)
    const L = live().filter(n => now >= n.born)
    const focus = S.hover || (S.panel > 0.02 && !filtering() ? S.sel : null)
    const nbr = new Set(focus ? [focus].concat(focus.adj.map(x => x.n)) : [])
    L.forEach(n => {
      let t = 1
      if (filtering()) t = matches(n) ? 1 : 0.1
      if (focus) t = nbr.has(n) ? 1 : 0.13
      n.va += (t - n.va) * 0.16
      n.hv += ((n === S.hover ? 1 : 0) - n.hv) * 0.25
    })
    // cluster regions, with their names at the top
    const names = []
    CLUSTERS.forEach(c => {
      const ms = L.filter(n => n.cluster === c.id)
      const tgt = ms.length >= 3 ? 1 : ms.length === 2 ? 0.45 : 0
      c.form += (tgt - c.form) * 0.05
      let hlT = 0
      if (filtering()) { const m = ms.filter(matches).length; hlT = ms.length ? m / ms.length : 0 }
      c.hl += (hlT - c.hl) * 0.1
      if (c.form < 0.01 || ms.length < 2) return
      const pts = []
      ms.forEach(n => {
        const [sx, sy] = toScreen(n), e = back((now - n.born) / 600)
        const rr = (rScreen(n) + 22) * e + 2
        for (let i = 0; i < 10; i++) { const a = i / 10 * Math.PI * 2; pts.push([sx + Math.cos(a) * rr, sy + Math.sin(a) * rr]) }
      })
      const h = hull(pts)
      let fade = c.form
      if (focus) fade *= 0.55
      if (filtering()) fade *= 0.4 + 1.1 * c.hl
      smoothPath(h)
      const lit = filtering() ? Math.max(0, (c.hl - 0.3) / 0.4) : 0
      ctx.save()
      if (lit > 0.01) { ctx.shadowColor = hexA(c.ink, 0.5 * Math.min(1, lit)); ctx.shadowBlur = 30 }
      ctx.fillStyle = hexA(c.tint, Math.min(1, 0.85 * fade))
      ctx.fill()
      ctx.restore()
      ctx.strokeStyle = lit > 0.01 ? hexA(c.ink, 0.55 * Math.min(1, lit)) : hexA(c.edge, Math.min(1, 0.9 * fade * (filtering() ? 0.5 + c.hl : 1)))
      ctx.lineWidth = lit > 0.01 ? 1.5 : 1
      ctx.stroke()
      let top = h[0]
      h.forEach(p => { if (p[1] < top[1]) top = p })
      let cx = 0
      ms.forEach(n => { cx += toScreen(n)[0] })
      cx /= ms.length
      c.lx = c.lx ? c.lx + (cx - c.lx) * 0.2 : cx
      const nm = ms.filter(matches).length
      const lab = c.name + (filtering() && nm ? '  ·  ' + nm + ' of ' + ms.length : '')
      ctx.font = lit > 0.5 ? font(700, 13) : font(600, 12)
      const tw = ctx.measureText(lab).width
      const x = Math.max(6 + tw / 2, Math.min(W - 6 - tw / 2, c.lx))
      const y = Math.max(vpTop - 26 + 14, top[1] - 3)
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
      ctx.fillStyle = hexA(c.ink, Math.min(1, fade * 1.15))
      ctx.fillText(lab, x, y)
      names.push({ x: x - tw / 2 - 2, y: y - 15, w: tw + 4, h: 16 })
    })
    // edges
    EDGES.forEach(e => {
      if (!L.includes(e.a) || !L.includes(e.b)) return
      const ea = ease((now - e.born) / 700)
      const [x1, y1] = toScreen(e.a), [x2, y2] = toScreen(e.b)
      const hot = focus && (e.a === focus || e.b === focus)
      let al = Math.min(e.a.va, e.b.va) * ea
      if (focus && !hot) al *= 0.25
      if (al < 0.01) return
      ctx.save()
      if (e.t === 'x') { ctx.setLineDash([4, 3.5]); ctx.strokeStyle = hexA(T.bad, (hot ? 0.95 : 0.42) * al); ctx.lineWidth = hot ? 1.7 : 1.1 }
      else if (e.t === 's') { ctx.strokeStyle = hexA(hot ? T.good : T.line, (hot ? 0.9 : 0.5) * al); ctx.lineWidth = hot ? 1.7 : 1 }
      else { ctx.setLineDash([1.5, 3]); ctx.strokeStyle = hexA(T.topic, (hot ? 0.85 : 0.4) * al); ctx.lineWidth = hot ? 1.4 : 1 }
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
      ctx.restore()
    })
    // nodes
    L.forEach(n => {
      const [sx, sy] = toScreen(n)
      const e = back((now - n.born) / 520)
      const r = rScreen(n) * e * (1 + 0.22 * n.hv)
      const col = kcolor(n.kind)
      const p = (now - n.born) / 1100
      if (p < 1) { ctx.beginPath(); ctx.arc(sx, sy, rScreen(n) + 4 + 16 * ease(p), 0, 7); ctx.strokeStyle = hexA(col, 0.45 * (1 - p)); ctx.lineWidth = 1.5; ctx.stroke() }
      if (S.fresh.has(n.id)) { ctx.beginPath(); ctx.arc(sx, sy, r + 4, 0, 7); ctx.strokeStyle = hexA(T.ring, 0.6 * n.va); ctx.lineWidth = 1.4; ctx.setLineDash([2, 2]); ctx.stroke(); ctx.setLineDash([]) }
      if (S.sel === n && S.panel > 0.02) { ctx.beginPath(); ctx.arc(sx, sy, r + 5, 0, 7); ctx.strokeStyle = hexA(T.ring, 0.9 * S.panel); ctx.lineWidth = 2; ctx.stroke() }
      ctx.beginPath(); ctx.arc(sx, sy, Math.max(0.1, r), 0, 7)
      ctx.fillStyle = hexA(col, Math.max(0.08, n.va))
      ctx.fill()
      ctx.lineWidth = 1.5; ctx.strokeStyle = hexA(DARK ? '#191817' : '#ffffff', 0.95 * n.va); ctx.stroke()
    })
    // labels: the focus in a pill, its neighbors by priority; the matches when filtering
    const rank = { x: 0, s: 1, t: 2 }
    let labs = []
    if (focus) {
      labs.push({ n: focus, big: true })
      focus.adj.filter(x => L.includes(x.n)).sort((a, b) => rank[a.t] - rank[b.t] || b.n.r - a.n.r).slice(0, 14).forEach(x => labs.push({ n: x.n }))
    } else if (filtering()) {
      L.filter(matches).sort((a, b) => b.r - a.r).slice(0, 24).forEach(n => labs.push({ n }))
    }
    const discs = L.filter(n => n.va > 0.5).map(n => { const [x, y] = toScreen(n), r = rScreen(n); return { n, x: x - r, y: y - r, w: 2 * r, h: 2 * r } })
    const got = placeLabels(labs, names, discs)
    for (const g of got.filter(g => !g.big)) {
      const al = Math.min(1, g.n.va)
      if (g.lead) {
        const cx = Math.max(g.x, Math.min(g.x + ctx.measureText(g.text).width, g.sx)), cy = Math.max(g.y, Math.min(g.y + 14, g.sy))
        const dx = cx - g.sx, dy = cy - g.sy, dl = Math.hypot(dx, dy) || 1
        ctx.beginPath(); ctx.moveTo(g.sx + dx / dl * (g.r + 1), g.sy + dy / dl * (g.r + 1)); ctx.lineTo(cx, cy)
        ctx.strokeStyle = hexA(DARK ? '#8f8c85' : '#85837c', 0.5 * al); ctx.lineWidth = 1; ctx.stroke()
      }
      ctx.font = font(500, 11.5)
      ctx.textAlign = 'left'; ctx.textBaseline = 'top'
      ctx.lineWidth = 3.5; ctx.strokeStyle = T.halo; ctx.lineJoin = 'round'
      ctx.strokeText(g.text, g.x, g.y + 1)
      ctx.fillStyle = hexA(T.ink2.startsWith('#') ? T.ink2 : '#4a4945', al); ctx.fillText(g.text, g.x, g.y + 1)
    }
    for (const g of got.filter(g => g.big)) {
      const b = g.box
      ctx.save()
      ctx.shadowColor = 'rgba(30,28,24,.16)'; ctx.shadowBlur = 12; ctx.shadowOffsetY = 3
      ctx.fillStyle = T.pill; roundRect(b.x, b.y, b.w, b.h, 8); ctx.fill()
      ctx.restore()
      ctx.strokeStyle = T.pillLine; ctx.lineWidth = 1; roundRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1, 8); ctx.stroke()
      ctx.beginPath(); ctx.arc(b.x + 12, b.y + b.h / 2, 4, 0, 7); ctx.fillStyle = kcolor(g.n.kind); ctx.fill()
      ctx.font = font(600, 13.5)
      ctx.fillStyle = T.ink; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      ctx.fillText(g.text, b.x + 21, b.y + b.h / 2 + 0.5)
    }
    S.lastLabels = got.map(g => ({ id: g.n.id, big: g.big, box: g.big ? g.box : { x: g.x - 2, y: g.y - 1, w: ctx.measureText(g.text).width + 4, h: 16 } }))
  }

  // ------------------------------------------------------------------------------------------------ the frame loop
  let changed = 0
  let sig = ''
  function frame(now) {
    const pt = S.sel && gw.classList.contains('open') ? 1 : 0
    S.panel += (pt - S.panel) * 0.12
    const s = [S.hover && S.hover.id, S.sel && S.sel.id, S.solo, S.query, N.length].join('|')
    if (s !== sig) { sig = s; changed = now }
    tick()
    const mv = fitCamera(false)
    const arriving = N.some(n => now - n.born < 1200)
    if (SIM.alpha > 0.002 || drag || mv > 0.3 || arriving || now - changed < 2200 || Math.abs(S.panel - pt) > 0.002) draw(now)
    requestAnimationFrame(frame)
  }

  // ------------------------------------------------------------------------------------------------ toolbar and status
  const atool = $('#atool')
  function toolbar() {
    const count = k => N.filter(n => n.kind === k).length
    atool.innerHTML = KINDS.map((k, i) => `<button class="kc${S.solo === k.id ? ' on' : S.solo ? ' off' : ''}" data-k="${k.id}"><i style="background:${kcolor(k.id)}"></i>${k.name}<span class="n">${count(k.id)}</span><kbd>${i + 1}</kbd></button>`).join('') +
      `<span class="sp"></span><label class="search" id="search"><svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6" opacity=".55"/><path d="M10.5 10.5l3.4 3.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity=".55"/></svg><input id="q" placeholder="search claims" spellcheck="false" autocomplete="off" value="${esc(S.query)}"><span class="n" id="qn"></span><kbd>/</kbd></label>`
    atool.querySelectorAll('.kc').forEach(b => b.addEventListener('click', () => setSolo(b.dataset.k)))
    const q = $('#q')
    q.addEventListener('focus', () => $('#search').classList.add('focus'))
    q.addEventListener('blur', () => $('#search').classList.remove('focus'))
    q.addEventListener('input', () => setQuery(q.value))
    setQuery(S.query)
  }
  function setSolo(k) {
    S.solo = S.solo === k ? null : k
    atool.querySelectorAll('.kc').forEach(b => { b.classList.toggle('on', b.dataset.k === S.solo); b.classList.toggle('off', !!S.solo && b.dataset.k !== S.solo) })
  }
  function setQuery(v) {
    S.query = String(v || '').trim()
    const qn = $('#qn')
    if (qn) qn.textContent = S.query ? N.filter(matches).length : ''
  }
  function status() {
    const d = OBJ && OBJ.data ? OBJ.data : {}
    const sc = d.scope && typeof d.scope === 'object' ? d.scope : {}
    const used = CLUSTERS.filter(c => N.some(n => n.cluster === c.id)).length
    const from = typeof sc.n === 'number' ? ` · from <span class="num">${fmt(sc.n)}</span> ${esc(sc.unit || 'files')}` : ''
    const fresh = S.fresh.size ? `<span class="new">+${S.fresh.size} new</span>` : ''
    $('#gstat').innerHTML = `<span class="num">${N.length}</span> claims · <span class="num">${used}</span> clusters${from}${fresh}`
    $('#sub').textContent = [d.title || OBJ.title, OBJ.version != null ? 'v' + OBJ.version : ''].filter(Boolean).join(' · ')
    document.title = `Atlas · ${d.title || OBJ.title || OBJ.id}`
  }
  $('#glegend').innerHTML =
    `<span><svg width="22" height="6"><line x1="1" y1="3" x2="21" y2="3" stroke="#9c978d" stroke-width="1.4"/></svg>supports</span>` +
    `<span><svg width="22" height="6"><line x1="1" y1="3" x2="21" y2="3" stroke="#c94f4a" stroke-width="1.4" stroke-dasharray="4 3"/></svg>contradicts</span>` +
    `<span><svg width="22" height="6"><line x1="1" y1="3" x2="21" y2="3" stroke="#8f8a80" stroke-width="1.4" stroke-dasharray="1.5 3"/></svg>same topic</span>`

  // ------------------------------------------------------------------------------------------------ pointer
  let downAt = null
  const local = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] }
  function pick(px, py) {
    let best = null, bd = Infinity
    live().forEach(n => {
      if (filtering() && !matches(n) && !S.hover) return
      const [sx, sy] = toScreen(n), d = Math.hypot(sx - px, sy - py)
      if (d < rScreen(n) + 7 && d < bd) { best = n; bd = d }
    })
    return best
  }
  cv.addEventListener('mousemove', e => {
    const [px, py] = local(e)
    if (drag) { drag.fx = cam.x + (px - W / 2) / cam.k; drag.fy = cam.y + (py - vpCenterY()) / cam.k; reheat(0.25); return }
    if (S.panel > 0.5 && py > H - panelH()) { setHover(null); return }
    setHover(pick(px, py))
  })
  cv.addEventListener('mouseleave', () => { if (!drag) setHover(null) })
  cv.addEventListener('mousedown', e => {
    const [px, py] = local(e)
    const n = pick(px, py)
    downAt = [px, py]
    if (n) { drag = n; n.fx = n.x; n.fy = n.y; cv.classList.add('grab') }
  })
  addEventListener('mouseup', () => {
    if (!drag) return
    const n = drag
    drag = null; n.fx = n.fy = null; cv.classList.remove('grab')
    reheat(0.15)
  })
  cv.addEventListener('click', e => {
    const [px, py] = local(e)
    if (downAt && Math.hypot(px - downAt[0], py - downAt[1]) > 4) return
    const n = pick(px, py)
    if (n) select(n); else if (S.sel) closeDetail()
  })
  function setHover(n) {
    if (S.hover === n) return
    S.hover = n
    cv.classList.toggle('hand', !!n)
  }

  // ------------------------------------------------------------------------------------------------ the claim's panel
  const resolved = new Map()
  function resolve(ref, n) {
    const key = ref + '|' + n
    if (!resolved.has(key)) {
      resolved.set(key, fetch(`${BASE}/resolve?ref=${enc(ref)}&n=${n}`, { cache: 'no-store' }).then(r => (r.ok ? r.json() : r.text().then(t => ({ error: t.slice(0, 200) || 'HTTP ' + r.status })))).catch(e => ({ error: String(e.message || e) })))
    }
    return resolved.get(key)
  }
  /** A ref as a person reads it: a row as `file:line`, a query value as `q3 · day=… · col`. */
  function shortRef(ref) {
    const m = /^(q\d+)(?:#(.*))?$/.exec(ref)
    if (m) {
      const [frag, col] = String(m[2] || '').split('@')
      return [m[1], decodeURIComponent(frag || '').replace(/&/g, ' '), col].filter(Boolean).join(' · ')
    }
    const [path, loc] = ref.split('#')
    const segs = path.split('/')
    const file = segs.pop()
    // a file named like its siblings (agent-04.jsonl, transcript.jsonl) reads with the run it belongs to
    while (segs.length > 1 && /^(agents|sessions|runs|transcripts|subagents|session-data|data|logs)$/i.test(segs[segs.length - 1])) segs.pop()
    const run = segs[segs.length - 1]
    const head = /^(agent|transcript|session|events|board|run|trace)/i.test(file) && run ? run + '/' + file : file
    const line = /^L(\d+)(?:\.b(\d+))?/.exec(loc || '')
    return line ? `${head}:${line[1]}${line[2] ? '.' + line[2] : ''}` : head + (loc ? '#' + loc : '')
  }
  /** What a resolved ref says in one line: a query's value and what it counted, or the row's own words. */
  function gist(r) {
    if (!r || r.error) return { text: r ? `does not resolve: ${r.error}` : '', bad: true }
    const q = (r.chain || []).find(s => s.step === 'query')
    if (q && q.value != null) return { text: `= ${q.value}`, more: q.about || '', val: true }
    const rec = (r.records || [])[0]
    if (rec) return { text: String(rec.words || rec.text || '').replace(/\s+/g, ' ').slice(0, 300), more: rec.words ? rec.meta || '' : '' }
    return { text: (r.rows || []).slice(0, 2).join(', ') }
  }
  function select(n) {
    S.sel = n
    S.asking = false
    renderDetail(n)
    gw.classList.add('open')
    history.replaceState(null, '', location.pathname + location.search + '#c=' + enc(n.id))
  }
  function closeDetail() {
    gw.classList.remove('open')
    S.sel = null
    S.asking = false
    history.replaceState(null, '', location.pathname + location.search)
  }
  function renderDetail(n) {
    const c = CBY[n.cluster]
    const unit = (OBJ && OBJ.data && OBJ.data.scope && OBJ.data.scope.unit) || ''
    const frac = typeof n.n === 'number'
      ? `<span class="frac">in <b>${fmt(n.n)}</b>${typeof n.of === 'number' ? ` of ${fmt(n.of)}` : ''} ${esc(unit)}${typeof n.of === 'number' && n.of > 0 ? `<span class="fbar"><i style="width:${Math.min(100, n.n / n.of * 100).toFixed(1)}%"></i></span>` : ''}</span>`
      : ''
    const evs = n.ev.map((e, i) => `<div class="ev" data-i="${i}"><span class="cite" title="${esc(e.ref)}">${esc(shortRef(e.ref))}</span><span class="q">${e.quote ? '“' + esc(e.quote) + '”' : '<span class="dim">…</span>'}</span></div>`).join('')
    const rank = { x: 0, s: 1, t: 2 }
    const rel = n.adj.slice().sort((a, b) => rank[a.t] - rank[b.t] || b.n.r - a.n.r)
    const rt = x => (x.t === 'x' ? 'contradicts' : x.t === 's' ? (x.dir === 'in' ? 'supported by' : 'supports') : 'same topic')
    const rels = rel.map(x => `<div class="rel" data-id="${esc(x.n.id)}"><span class="rt ${x.t}">${rt(x)}</span><i style="background:${kcolor(x.n.kind)}"></i><span class="nm">${esc(x.n.name)}</span></div>`).join('') || '<div class="more">no relations</div>'
    const cchip = c ? `<span class="cchip" style="background:${c.tint};color:${c.ink}">${esc(c.name)}</span>` : '<span class="cchip" style="background:var(--chip);color:var(--mut)">between clusters</span>'
    $('#detail').innerHTML =
      `<div class="dh"><span class="kchip"><i style="background:${kcolor(n.kind)}"></i>${KNAME[n.kind]}</span>${cchip}${frac}<span class="sp"></span><span class="closer" id="closer"><kbd>esc</kbd> close</span></div>` +
      `<div class="dt" title="${esc(n.name)}">${esc(n.name)}</div>` +
      (n.note ? `<div class="dnote" title="${esc(n.note)}">${esc(n.note)}</div>` : '') +
      `<div class="dcols"><div><div class="lab">EVIDENCE</div><div class="evs">${evs || '<div class="more">no evidence</div>'}</div></div><div><div class="lab">RELATED</div><div class="rels">${rels}</div></div></div>` +
      `<div class="dfoot" id="dfoot"><button class="ask" id="ask"><kbd>↵</kbd>ask about this claim</button><span class="tip">click a related claim to go there · a citation opens its rows</span>` +
      `<div class="askbox"><span class="about"><i style="background:${kcolor(n.kind)}"></i>${esc(n.name)}</span><input id="askq" placeholder="Ask about this claim…" spellcheck="false" autocomplete="off"><button class="send" id="send" title="send">↑</button></div><span class="said" id="said"></span></div>`
    $('#detail').querySelectorAll('.rel').forEach(r => r.addEventListener('click', () => { const m = byId[r.dataset.id]; if (m) select(m) }))
    $('#closer').addEventListener('click', closeDetail)
    $('#ask').addEventListener('click', () => ask())
    $('#send').addEventListener('click', () => send())
    $('#askq').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); send() } if (e.key === 'Escape') { e.preventDefault(); stopAsking() } e.stopPropagation() })
    $('#detail').querySelectorAll('.ev').forEach(row => {
      const e = n.ev[Number(row.dataset.i)]
      row.querySelector('.cite').addEventListener('click', () => toggleRows(row, e))
      if (!e.quote) resolve(e.ref, 1).then(r => { if (S.sel !== n) return; const g = gist(r); const q = row.querySelector('.q'); q.className = 'q' + (g.val ? ' val' : ''); q.innerHTML = esc(g.text) + (g.more ? ` <span class="dim">· ${esc(g.more)}</span>` : ''); if (g.bad) q.style.color = 'var(--bad)' })
    })
  }
  function toggleRows(row, e) {
    const next = row.nextElementSibling
    if (next && next.classList.contains('rows')) { next.remove(); row.classList.remove('openrow'); return }
    const box = document.createElement('div')
    box.className = 'rows'
    box.innerHTML = '<div class="r">reading…</div>'
    row.after(box)
    row.classList.add('openrow')
    resolve(e.ref, 5).then(r => {
      if (!r || r.error) { box.innerHTML = `<div class="err">${esc(e.ref)} does not resolve: ${esc(r ? r.error : 'no answer')}</div>`; return }
      const q = (r.chain || []).find(s => s.step === 'query')
      const lines = []
      if (q) lines.push(`<div><span class="r">${esc(q.id)}</span>${esc(q.about || '')}${q.value != null ? ' = ' + esc(q.value) : ''} · ${esc(r.count != null ? fmt(r.count) + ' source rows' : (r.rows || []).join(', '))}</div>`)
      // a row reads as its words and who and when (the kernel's `words` and `meta`), not as its `field: value` pairs
      for (const x of (r.records || []).slice(0, 5)) lines.push(`<div title="${esc(x.text)}"><span class="r">${esc(shortRef(x.ref))}</span>${esc(String(x.words || x.text).replace(/\s+/g, ' ').slice(0, 400))}${x.words && x.meta ? ` <span class="dim">· ${esc(x.meta)}</span>` : ''}</div>`)
      for (const x of (r.notes || []).slice(0, 1)) lines.push(`<div><span class="r">note</span>${esc(x)}</div>`)
      box.innerHTML = lines.join('') || `<div>${esc(e.ref)}</div>`
    })
  }
  function ask() {
    if (!S.sel) return
    S.asking = true
    $('#dfoot').classList.add('asking')
    $('#askq').focus()
  }
  function stopAsking() {
    S.asking = false
    const f = $('#dfoot')
    if (f) f.classList.remove('asking')
    const q = $('#askq')
    if (q) q.blur()
  }
  async function send() {
    const n = S.sel
    const q = $('#askq')
    const text = q ? q.value.trim() : ''
    if (!n || !text) return
    const region = 'claim-' + slug(n.id)
    const body = { object: OBJ.id, v: OBJ.version, region, ask: text, scope: { object: OBJ.id, region, claim: n.id, label: n.name } }
    const said = $('#said')
    try {
      const r = await fetch(`${BASE}/back`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (!r.ok) throw new Error((await r.text()).slice(0, 120) || 'HTTP ' + r.status)
      q.value = ''
      said.className = 'said ok'
      said.textContent = 'sent to the terminal: Claude answers there, about this claim'
      stopAsking()
    } catch (e) {
      said.className = 'said bad'
      said.textContent = `not sent (${e.message}). In the terminal, ask about "${n.name}" (${n.id} in ${OBJ.id}).`
    }
  }

  // ------------------------------------------------------------------------------------------------ keys
  document.addEventListener('keydown', e => {
    const k = e.key
    const q = $('#q')
    if (document.activeElement === q) {
      if (k === 'Escape') { q.value = ''; setQuery(''); q.blur(); e.preventDefault() }
      if (k === 'Enter') { q.blur(); e.preventDefault() }
      return
    }
    if (k === 'Escape') {
      e.preventDefault()
      if (S.asking) return stopAsking()
      if (S.query) { if (q) q.value = ''; return setQuery('') }
      if (S.solo) return setSolo(S.solo)
      if (S.sel) return closeDetail()
      return
    }
    if (/^[1-5]$/.test(k)) { setSolo(KORDER[Number(k) - 1]); e.preventDefault(); return }
    if (k === '/') { if (q) q.focus(); e.preventDefault(); return }
    if (k === 'Enter' && S.sel) { ask(); e.preventDefault() }
  })

  // ------------------------------------------------------------------------------------------------ loading
  function empty(html) {
    const el = $('#empty')
    el.innerHTML = html ? `<div>${html}</div>` : ''
    el.classList.toggle('on', !!html)
  }
  async function fetchObject() {
    const embedded = window.ATLAS_OBJECT || (document.getElementById('atlas-object') && JSON.parse(document.getElementById('atlas-object').textContent))
    if (embedded) return { o: embedded, src: null }
    const list = SRC ? [SRC] : SOURCES
    let last = ''
    for (const url of list) {
      try {
        const r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' })
        if (!r.ok) { last = `${r.status} ${(await r.text()).slice(0, 120)}`; continue }
        const o = await r.json()
        const obj = o && o.object && o.object.data ? o.object : o
        if (obj && obj.data && Array.isArray(obj.data.claims)) return { o: obj, src: url }
        last = 'the object is not an atlas'
      } catch (e) { last = String(e.message || e) }
    }
    return { error: last || 'no answer' }
  }
  async function load(first) {
    const got = await fetchObject()
    const st = $('#st')
    if (got.error) {
      if (first || !OBJ) {
        $('#sub').textContent = 'no atlas yet'
        empty(`<b>No atlas here yet.</b><br>Press <code>a</code> under a message in the terminal. This page shows the atlas as soon as Claude saves it.<br><span style="font-size:12px">(${esc(got.error)})</span>`)
      } else {
        st.className = 'st'
        st.textContent = 'the page server stopped · open the atlas again from the terminal'
      }
      return
    }
    empty('')
    SRC = got.src
    const o = got.o
    if (OBJ && o.version === OBJ.version && o.updated === OBJ.updated) return
    const before = new Set(N.map(n => n.id))
    OBJ = o
    const added = ingest(o)
    const now = performance.now()
    if (!S.loaded) {
      settle(now)
      fitCamera(true)
      S.loaded = true
      const want = /[#&]c=([^&]+)/.exec(HASH)
      const region = /[#&]r=claim-([^&]+)/.exec(HASH)
      const hit = want ? byId[decodeURIComponent(want[1])] : region ? N.find(n => slug(n.id) === decodeURIComponent(region[1])) : null
      if (hit) setTimeout(() => select(hit), READY ? 0 : 900)
    } else if (added.length) {
      added.forEach((n, i) => { place(n); n.born = now + i * 220 })
      EDGES.forEach(e => { if (!before.has(e.a.id) || !before.has(e.b.id)) e.born = now })
      S.fresh = new Set(added.filter(n => before.size && !before.has(n.id)).map(n => n.id))
      SIM.target = 0
      reheat(0.35)
    }
    const fresh = OBJ.data && OBJ.data.added && Array.isArray(OBJ.data.added.claims) ? OBJ.data.added.claims.map(String) : []
    if (!S.fresh.size && fresh.length) S.fresh = new Set(fresh.filter(id => byId[id]))
    toolbar()
    status()
    if (S.sel) { if (byId[S.sel.id]) renderDetail(byId[S.sel.id]); else closeDetail() }
    st.className = 'st'
    st.textContent = OBJ.updated ? `saved ${String(OBJ.updated).slice(11, 16)}` : ''
  }

  readTheme()
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readTheme(); changed = performance.now() })
  addEventListener('resize', () => { size(); changed = performance.now() })
  size()
  const SRC_FIXED = !!window.ATLAS_OBJECT
  load(true).then(() => {
    requestAnimationFrame(frame)
    document.body.dataset.ready = '1'
    setInterval(() => { if (document.visibilityState === 'visible' && !SRC_FIXED) load(false) }, POLL_MS)
  })
  window.Atlas = { S, N, byId, CLUSTERS, cam, select, closeDetail, setSolo, setQuery, ask, send, labels: () => S.lastLabels || [],
    nodeAt(id) { const n = byId[id]; if (!n) return null; const [x, y] = toScreen(n); const r = cv.getBoundingClientRect(); return [r.left + x, r.top + y] },
    hover(id) { setHover(byId[id] || null); changed = performance.now() } }
})()
