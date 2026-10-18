// mirror.js: the session mirror. It draws this session's rows from their records and follows them while Claude
// works (the server's change events). Marks open the tray, a stack of small cards at the bottom: a citation its
// source card (the rows behind it, read through the kernel), a gloss its explainer. `↵ ask` in the tray, the composer,
// and a verb in a message's row go back to the terminal session (CONTRACT 5).
//
// Keys: tab / shift+tab next mark · ↵ open the mark, then ask · esc back through the tray, then close · ↑ ↓ cards ·
// ↵ on a card opens its detail · v s a press a verb on the message in focus (the last, with none).
import { $, $$, api, back, esc, fmt, follow, objectOf, pageUrl, parseObj } from '../common/base.js'
import { citedHtml, messageHtml, plain, sparkSvg } from '../common/marks.js'
import { columnsIn, drawingOf, fontsReady, svgOf } from '../common/draw.js'
import { drawSide, sideData, titleOf } from '../common/side.js'
import { chainWords, isRef } from '../lib/object.js'

const st = {
  rows: [], verbs: [], info: null, objects: [], live: false,
  marks: new Map(),       // row -> its marks, as drawn
  focus: null,            // {row, i}: the mark in focus
  tray: [],               // the tray's stack: [{row, i} | {kind, ref, label, term?, body?}]
  mode: 'card',           // 'card' | 'thread'
  asks: [],               // what this page asked: {text, scope, at, key}
  props: null,            // the row whose v proposals are open
  card: null,             // the card in focus: 'row|id'
}
const nodes = new Map()   // row -> {el, sig}
const cards = new Map()   // 'id@v|w' -> svg html
const tx = $('#tx'), scroll = $('#scroll'), tray = $('#tray'), th = $('#th'), tb = $('#tb')
const prompt = $('#prompt'), cbox = $('#cbox'), scopeEl = $('#scope'), ckeys = $('#ckeys')

// ---------------------------------------------------------------- data
async function refresh() {
  const r = await api('messages')
  if (r.error) { if (!st.rows.length) $('#empty').textContent = `No messages: ${r.error}`; return }
  const changed = JSON.stringify(r.rows) !== JSON.stringify(st.rows)
  st.rows = r.rows || []
  if (changed) { render(); trayAnswers() }
}
async function refreshSide() {
  const d = await sideData()
  st.info = d.info
  st.objects = d.objects
  head()
  drawSide($('#side'), { info: st.info, objects: st.objects, on: 'session', live: st.live })
}

function head() {
  const info = st.info
  $('#title').textContent = titleOf(info)
  document.title = `${titleOf(info)} · thimble`
  $('#folder').textContent = info ? `~/${info.folder}` : ''
  const c = info?.coverage
  if (!c?.total) { $('#cov').innerHTML = ''; return }
  const t = c.total
  const read = t.files - t.not_read_files
  // groups of like files when the folder has them (runs/*.jsonl), else the files and rows read
  const many = (c.groups || []).filter(g => g.files > 1)
  const parts = many.length ? many.slice(0, 2).map(g => `<b>${esc(g.group)} ${fmt(g.files - (g.byStatus?.['not read'] || 0))} of ${fmt(g.files)} files</b>`)
    : [`<b>${fmt(read)} of ${fmt(t.files)} files</b>`, `<b>${fmt(t.rows - t.not_read_rows)} of ${fmt(t.rows)} rows</b>`]
  $('#cov').innerHTML = `coverage ${parts.join('<span class="sep">·</span>')}`
}

// ---------------------------------------------------------------- the transcript
const nearBottom = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80

function render() {
  const stick = nearBottom()
  $('#empty')?.remove()
  const keep = new Set()
  let prev = null
  for (const row of st.rows) {
    keep.add(row.row)
    const sig = JSON.stringify([row, st.verbs, st.props === row.row])
    let n = nodes.get(row.row)
    if (!n || n.sig !== sig) {
      const el = row.kind === 'user' ? userEl(row) : claudeEl(row)
      if (n) n.el.replaceWith(el)
      n = { el, sig }
      nodes.set(row.row, n)
    }
    // in order: after the previous row's node
    const want = prev ? prev.nextSibling : tx.firstChild
    if (want !== n.el) tx.insertBefore(n.el, want)
    prev = n.el
  }
  for (const [k, n] of nodes) if (!keep.has(k)) { n.el.remove(); nodes.delete(k) }
  // Claude works on a prompt that has no answer yet
  let w = $('#working')
  const last = st.rows[st.rows.length - 1]
  if (last && last.kind === 'user') {
    if (!w) { w = document.createElement('div'); w.id = 'working'; w.className = 'turn thinking'; w.innerHTML = '<span class="s7">✻</span>Claude is working in the terminal…' }
    tx.appendChild(w)
  } else if (w) w.remove()
  if (!st.rows.length) tx.innerHTML = '<p class="notice" id="empty">No messages yet. Each prompt and each of Claude\'s messages shows here as the terminal draws it.</p>'
  paintMarks()
  if (stick) scroll.scrollTop = scroll.scrollHeight
}

function userEl(row) {
  const el = document.createElement('div')
  el.className = 'turn user'
  el.dataset.row = row.row
  const asked = st.asks.find(a => a.text === row.text)
  el.innerHTML = `<div><div class="bub">${esc(row.text)}</div>${asked ? `<div class="via">from the browser${asked.scope?.mark ? ` · about ${esc(asked.scope.mark.label || '')}` : ''}</div>` : ''}</div>`
  return el
}

function claudeEl(row) {
  const el = document.createElement('div')
  el.className = 'turn claude-turn'
  el.dataset.row = row.row
  const rec = row.record
  if (!rec) {
    el.innerHTML = '<div class="claude"><span class="notice">…</span></div>'
    return el
  }
  const { html, marks } = messageHtml(rec)
  st.marks.set(row.row, marks)
  el.innerHTML = `<div class="claude">${html}</div>${verbRow(row)}${propsRow(row)}<div class="cards"></div>`
  const box = $('.cards', el)
  for (const ref of rec.objects || []) {
    const o = parseObj(ref)
    if (!o) continue
    const c = document.createElement('div')
    c.className = 'card'
    c.dataset.obj = o.id
    c.dataset.row = row.row
    c.innerHTML = `<div class="wait">drawing ${esc(o.id)}…</div>`
    box.appendChild(c)
    fillCard(c, o)
  }
  return el
}

function verbRow(row) {
  const verbs = row.record?.verbs || {}
  const items = st.verbs.map((v, i) => {
    const r = verbs[v.key] || {}
    const lit = r.lit === true
    const open = st.props === row.row && v.key === 'v'
    return `${i ? '<span class="sep">·</span>' : ''}<button class="vb ${v.key}${lit ? ' lit' : ''}${open ? ' open' : ''}" data-k="${esc(v.key)}" title="${esc(v.line || v.name)}"><b>${esc(v.key)}</b>${lit && r.note ? `<span class="dot">●</span><span>${esc(r.note)}</span>` : `<span>${esc(v.name)}</span>`}</button>`
  })
  return `<div class="verbs">${items.join('')}<span class="said"></span></div>`
}

function propsRow(row) {
  if (st.props !== row.row) return ''
  const p = row.record?.verbs?.v?.proposals || []
  if (!p.length) return ''
  return `<div class="props">${p.map((x, i) => `<button class="prop" data-prop="${i}">▸ ${esc(x)}</button>`).join('')}<span class="hint"><kbd>↵</kbd>draw · <kbd>esc</kbd>close</span></div>`
}

async function fillCard(el, ref) {
  try {
    const width = Math.max(320, Math.min(756, tx.clientWidth - 44 - 24))
    const w = columnsIn(width)
    const r = await objectOf(ref.id, ref.v)
    if (r.error) { el.innerHTML = `<div class="err">× ${esc(ref.id)} cannot be drawn: ${esc(r.error)}</div>`; return }
    const o = r.object
    const key = `${o.id}@${o.version}|${w}`
    let svg = cards.get(key)
    if (!svg) {
      await fontsReady
      const d = await drawingOf(o, { w, mode: 'inline' })
      const s = svgOf(d, { w })
      svg = d.error ? `<div class="err">× its program failed: ${esc(d.error.name)}: ${esc(d.error.message)}</div>${s.svg}` : s.svg
      cards.set(key, svg)
    }
    const kind = o.verb || (o.lineage?.queries ? Object.keys(o.lineage.queries).length + ' quer' + (Object.keys(o.lineage.queries).length === 1 ? 'y' : 'ies') : '')
    el.dataset.v = o.version
    el.innerHTML = `<div class="ch"><b>${esc(o.title || o.id)}</b><span class="meta">${esc(o.id)} · v${esc(o.version)}${kind ? ' · ' + esc(kind) : ''}</span></div><div class="cb">${svg}</div>` +
      `<div class="cf"><button data-act="open"><kbd>↵</kbd>open</button><button data-act="ask"><kbd>?</kbd>ask</button><span class="sp"></span><span>${r.versions.length > 1 ? r.versions.map(x => 'v' + x.v).join(' · ') : ''}</span></div>`
  } catch (e) {
    el.innerHTML = `<div class="err">× ${esc(ref.id)} cannot be drawn: ${esc(String(e?.message || e))}</div>`
  }
}

// ---------------------------------------------------------------- marks and the tray
const markOf = e => (e.row != null ? (st.marks.get(e.row) || [])[e.i] : e)
const order = () => $$('#tx .mk').map(m => ({ row: m.closest('[data-row]').dataset.row, i: Number(m.dataset.m) }))

function paintMarks() {
  $$('#tx .mk').forEach(m => {
    const row = m.closest('[data-row]')?.dataset.row
    m.classList.toggle('on', !!st.focus && st.focus.row === row && st.focus.i === Number(m.dataset.m))
  })
  $$('#tx .card').forEach(c => c.classList.toggle('focus', st.card === `${c.dataset.row}|${c.dataset.obj}`))
}

function hints() {
  if (st.tray.length && st.mode === 'thread') ckeys.innerHTML = '<kbd>↵</kbd> send to the terminal session, about this mark · <kbd>esc</kbd> back'
  else if (st.tray.length) ckeys.innerHTML = `<kbd>↵</kbd> ask · <kbd>tab</kbd> next mark · <kbd>esc</kbd> ${st.tray.length > 1 ? 'back' : 'close'}`
  else if (order().length) ckeys.innerHTML = '<kbd>tab</kbd> next mark &nbsp;·&nbsp; <kbd>↵</kbd> open &nbsp;·&nbsp; or click a mark'
  else ckeys.innerHTML = '<kbd>↵</kbd> send'
}

function openTray(entry, { push = false } = {}) {
  const m = markOf(entry)
  if (!m) return
  if (push) st.tray.push(entry); else st.tray = [entry]
  st.mode = 'card'
  if (entry.row != null) st.focus = { row: entry.row, i: entry.i }
  drawTray(true)
}

function closeTray() {
  st.tray = []
  st.mode = 'card'
  tray.classList.remove('open')
  scroll.classList.remove('tray-open')
  setScope(null)
  paintMarks()
  hints()
}

function backTray() {
  if (st.mode === 'thread') { st.mode = 'card'; setScope(null); drawTray(); return }
  st.tray.pop()
  if (!st.tray.length) return closeTray()
  drawTray(true)
}

function setScope(m) {
  if (!m) { scopeEl.className = 'scope'; scopeEl.innerHTML = ''; prompt.placeholder = 'Reply to Claude…'; cbox.classList.remove('k-gloss'); return }
  scopeEl.className = 'scope on'
  scopeEl.innerHTML = `<span class="mk ${m.kind === 'gloss' ? 'gloss' : 'cite'}">${esc(m.label)}</span><span class="ar">›</span>`
  prompt.placeholder = `Ask about ${m.label}…`
  cbox.classList.toggle('k-gloss', m.kind === 'gloss')
}

function drawTray(fresh) {
  const top = st.tray[st.tray.length - 1]
  const m = markOf(top)
  if (!m) return closeTray()
  tray.className = `open k-${m.kind === 'gloss' ? 'gloss' : 'cite'}`
  scroll.classList.add('tray-open')
  const kind = m.kind === 'gloss' ? 'gloss' : m.kind === 'spark' ? 'series' : 'cite'
  const ttl = m.kind === 'spark' ? `<span class="mk cite">${m.values ? sparkSvg(m.values) : '~'}</span>` : `<span class="mk ${m.kind === 'gloss' ? 'gloss' : 'cite'}">${esc(m.label)}</span>`
  const keys = st.mode === 'thread'
    ? '<button data-k="back"><kbd>esc</kbd> back</button>'
    : `<button data-k="ask"><kbd>↵</kbd> ask</button><button data-k="back"><kbd>esc</kbd> ${st.tray.length > 1 ? 'back' : 'close'}</button>`
  th.innerHTML = `<span class="kind">${kind}</span><span class="ttl">${ttl}</span>${st.tray.length > 1 ? `<span class="depth">${st.tray.length - 1} back</span>` : ''}${st.mode === 'thread' ? '<span class="thr">· ask</span>' : ''}${m.ref ? `<span class="src">${esc(m.ref)}</span>` : ''}<span class="sp"></span><span class="keys">${keys}</span>`
  tb.className = 'tb' + (fresh ? ' fresh' : '')
  if (st.mode === 'thread') tb.innerHTML = threadHtml(top, m)
  else if (m.kind === 'gloss') glossBody(m)
  else sourceBody(m)
  requestAnimationFrame(() => scroll.style.setProperty('--trayH', `${tray.offsetHeight + 8}px`))
  paintMarks()
  hints()
}

// a citation's source card: the value's chain and the rows behind it, read through the kernel (`lean resolve`)
const resolved = new Map()
async function sourceBody(m) {
  const at = st.tray[st.tray.length - 1]
  if (!m.ref) { tb.innerHTML = `<p class="note">This mark names no ref, so there are no rows to show.</p>`; return }
  const series = m.kind === 'spark' && m.values ? seriesSvg(m.values) : ''
  tb.innerHTML = `${series}<p class="note">reading the rows behind it…</p>`
  if (!resolved.has(m.ref)) resolved.set(m.ref, api(`resolve?ref=${encodeURIComponent(m.ref)}&n=6`))
  const r = await resolved.get(m.ref)
  if (st.tray[st.tray.length - 1] !== at || st.mode !== 'card') return
  const c = chainWords(r)
  if (c.error) { tb.innerHTML = `${series}<p class="problem">${esc(c.notes[0])}</p><div class="from">from <b>${esc(m.ref)}</b></div>`; return }
  const file = (r.rows || [])[0] ? String(r.rows[0]).split('#')[0] : String(m.ref).split('#')[0]
  const codeLike = /\.(py|js|mjs|ts|tsx|rb|go|rs|java|c|h|cpp|sh|toml|ya?ml|cfg|ini)$/.test(file)
  const recs = c.records || []
  let body = ''
  if (codeLike && recs.length) {
    body = `<div class="code"><div class="hh">${esc(file)}</div>${recs.map((x, i) => { const n = /#L(\d+)/.exec(x.ref); return `<div class="row${i === 0 ? ' hot' : ''}"><span class="no">${n ? n[1] : ''}</span><span>${esc(x.text)}</span></div>` }).join('')}</div>`
  } else if (recs.length) {
    body = `<table class="rt"><tr><th class="m">row</th><th>what it holds</th></tr>${recs.map((x, i) => `<tr class="${i === 0 ? 'hl' : ''}"><td class="m">${esc(x.ref)}</td><td title="${esc(x.text)}">${esc(x.text)}</td></tr>`).join('')}${r.count != null && r.count > recs.length ? `<tr class="more"><td class="m">+ ${fmt(r.count - recs.length)} more</td><td></td></tr>` : ''}</table>`
  }
  const query = (r.chain || []).find(s => s.step === 'query')
  tb.innerHTML = `${series}<p class="srcline">← ${esc(c.line)}</p>${c.notes.slice(0, 2).map(n => `<p class="note">${esc(n)}</p>`).join('')}${body}` +
    `<div class="from">from <b>${esc(file)}</b>${r.count != null ? ` · ${fmt(r.count)} row${r.count === 1 ? '' : 's'}` : ''}${query ? ` · ${esc(query.id)}${query.about ? ' · ' + esc(query.about) : ''}` : ''}</div>`
}

function seriesSvg(values) {
  const W = 700, H = 74, n = values.length, bw = Math.max(3, Math.min(40, (W - 8) / n - 3))
  const hi = Math.max(...values.map(v => (typeof v === 'number' ? v : 0)), 0) || 1
  const bars = values.map((v, i) => {
    const h = Math.max(1.5, ((typeof v === 'number' ? v : 0) / hi) * (H - 18))
    return `<rect${v ? '' : ' class="z"'} x="${(i * (bw + 3)).toFixed(1)}" y="${(H - 14 - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2"/>`
  }).join('')
  return `<svg class="series" width="${Math.min(W, n * (bw + 3))}" height="${H}">${bars}<text x="0" y="${H - 2}">${n} values · max ${fmt(hi)}</text></svg>`
}

// a gloss's explainer card: a few plain sentences, a small drawing when it has one, and where it bit
async function glossBody(m) {
  const g = m.body || {}
  const at = st.tray[st.tray.length - 1]
  const refs = (g.refs || []).filter(isRef)
  tb.innerHTML = `${g.title ? `<p class="def"><b>${esc(g.title)}</b></p>` : ''}<p class="def">${citedHtml(g.body || 'No explainer was written for this term.')}</p><div class="gdraw"></div>` +
    (refs.length ? `<div class="bit"><span class="lab">rests on</span>${refs.map(r => `<span class="mk cite" data-ref="${esc(r)}">${esc(r.replace(/^obj:/, ''))}</span>`).join(' · ')}</div>` : '')
  if (g.program) {
    try {
      await fontsReady
      const w = columnsIn(Math.min(740, tray.clientWidth - 40))
      const d = await drawingOf({ id: `gloss-${m.gloss || 'x'}`, version: 1, program: g.program, data: g.data || {} }, { w, mode: 'inline' })
      if (st.tray[st.tray.length - 1] !== at || st.mode !== 'card') return
      $('.gdraw', tb).innerHTML = svgOf(d, { w }).svg
    } catch { /* the words stand alone */ }
  }
}

// the tray as a side thread: what was asked about this mark, and Claude's answer once it is in the session
function threadHtml(entry, m) {
  const key = markKey(entry, m)
  const asked = st.asks.filter(a => a.key === key)
  const recap = m.kind === 'gloss' ? (m.body?.title || m.label) : `${m.label}${m.ref ? ' · ' + m.ref : ''}`
  if (!asked.length) return `<div class="thr-recap">about <b>${esc(recap)}</b></div><p class="note">Type a question below. It goes to the terminal session as a prompt that carries this mark, and the answer shows here and in the session.</p>`
  return `<div class="thr-recap">about <b>${esc(recap)}</b></div>` + asked.map(a => {
    const ans = answerTo(a)
    return `<div class="tq"><span>${esc(a.text)}</span></div><div class="ta">${a.error ? `<p class="problem">not sent: ${esc(a.error)}</p>` : ans ? messageHtml(ans.record).html : '<div class="wait"><span class="s7">✻</span>sent to the terminal session · the answer shows here when Claude writes it</div>'}</div>`
  }).join('')
}
const markKey = (entry, m) => (entry.row != null ? `${entry.row}:${entry.i}` : `${m.kind}:${m.ref || m.label}`)

/** Claude's first message after the prompt an ask became, once it is in the session. */
function answerTo(a) {
  const i = st.rows.findIndex(r => r.kind === 'user' && r.text === a.text && (!r.at || !a.at || Date.parse(r.at) >= a.at - 5000))
  if (i < 0) return null
  for (let j = i + 1; j < st.rows.length && st.rows[j].kind !== 'user'; j++) if (st.rows[j].record) return st.rows[j]
  return null
}
function trayAnswers() { if (st.tray.length && st.mode === 'thread') drawTray() }

function askMode() {
  const top = st.tray[st.tray.length - 1]
  const m = markOf(top)
  if (!m) return
  st.mode = 'thread'
  setScope(m)
  drawTray(true)
  prompt.focus()
}

// ---------------------------------------------------------------- what goes back to the terminal
let saidTimer = null
function said(text, bad) {
  const b = $('.brow', cbox)
  let s = $('.sent, .err', b)
  if (!s) { s = document.createElement('span'); b.insertBefore(s, $('.model', b)) }
  s.className = bad ? 'err' : 'sent'
  s.textContent = text
  clearTimeout(saidTimer)
  saidTimer = setTimeout(() => s.remove(), bad ? 9000 : 3500)
}

async function send() {
  const text = prompt.value.trim()
  if (!text) return
  const top = st.tray.length && st.mode === 'thread' ? st.tray[st.tray.length - 1] : null
  const m = top ? markOf(top) : null
  const scope = {}
  if (top && m) {
    if (top.row != null) scope.row = top.row
    scope.mark = { kind: m.kind, ...(m.ref ? { ref: m.ref } : {}), ...(m.gloss ? { gloss: m.gloss } : {}), label: m.label, ...(m.kind === 'gloss' ? { term: m.label } : {}) }
  } else if (st.focus) scope.row = st.focus.row
  prompt.value = ''
  const a = { text, scope, at: Date.now(), key: top && m ? markKey(top, m) : null }
  st.asks.push(a)
  if (top) drawTray()
  const r = await back({ ask: text, scope })
  if (r.error) { a.error = r.error; said(`not sent: ${r.error}`, true); if (top) drawTray(); return }
  said('sent to the terminal session ✓')
  // the prompt's row says it came from here, once it is drawn
  for (const [k, n] of nodes) if (n.el.classList.contains('user')) { const row = st.rows.find(x => x.row === k); if (row && row.text === text) n.sig = '' }
  render()
}

async function pressVerb(row, k, proposal) {
  const el = nodes.get(row)?.el
  const rec = st.rows.find(r => r.row === row)?.record
  const v = rec?.verbs?.[k]
  if (k === 'v' && !proposal && v?.lit && v.proposals?.length) { st.props = st.props === row ? null : row; render(); return }
  st.props = null
  const r = await back({ verb: k, row, ...(proposal ? { proposal } : {}) })
  render()
  const s = $('.said', nodes.get(row)?.el || el)
  if (s) {
    s.className = r.error ? 'said err' : 'said'
    s.textContent = r.error ? `not sent: ${r.error}` : `${k} pressed in the terminal session ✓`
    setTimeout(() => { s.textContent = '' }, r.error ? 9000 : 3500)
  }
}

// ---------------------------------------------------------------- input
function openCard(el, region) {
  location.href = pageUrl('card', { o: el.dataset.obj, v: el.dataset.v, from: el.dataset.row }, { r: region })
}

document.addEventListener('click', e => {
  const t = e.target
  const k = t.closest('#th [data-k]')
  if (k) { if (k.dataset.k === 'ask') askMode(); else backTray(); return }
  const vb = t.closest('.vb')
  if (vb) { pressVerb(vb.closest('[data-row]').dataset.row, vb.dataset.k); return }
  const pr = t.closest('.prop')
  if (pr) { const row = pr.closest('[data-row]').dataset.row; pressVerb(row, 'v', st.rows.find(r => r.row === row)?.record?.verbs?.v?.proposals?.[Number(pr.dataset.prop)]); return }
  const ref = t.closest('#tb [data-ref]')
  if (ref) { openTray({ kind: 'cite', ref: ref.dataset.ref, label: ref.textContent }, { push: true }); return }
  const mk = t.closest('#tx .mk')
  if (mk) { openTray({ row: mk.closest('[data-row]').dataset.row, i: Number(mk.dataset.m) }); return }
  const card = t.closest('#tx .card')
  if (card && card.dataset.v) {
    const act = t.closest('[data-act]')
    if (act && act.dataset.act === 'ask') { location.href = pageUrl('card', { o: card.dataset.obj, v: card.dataset.v, from: card.dataset.row }, { ask: 1 }); return }
    const part = t.closest('[data-region]')
    openCard(card, part ? part.dataset.region : null)
  }
})
$('#send').addEventListener('click', send)
prompt.addEventListener('focus', () => cbox.classList.add('focus'))
prompt.addEventListener('blur', () => cbox.classList.remove('focus'))
prompt.addEventListener('input', () => { prompt.style.height = '22px'; prompt.style.height = Math.min(120, prompt.scrollHeight) + 'px' })

function stepMark(dir) {
  const o = order()
  if (!o.length) return
  let i = st.focus ? o.findIndex(x => x.row === st.focus.row && x.i === st.focus.i) : -1
  i = i < 0 ? (dir > 0 ? 0 : o.length - 1) : (i + dir + o.length) % o.length
  st.focus = o[i]
  st.card = null
  if (st.tray.length) openTray(o[i]); else paintMarks()
  const el = $$('#tx .mk')[i]
  el?.scrollIntoView({ block: 'nearest' })
}

function stepCard(dir) {
  const list = $$('#tx .card[data-v]')
  if (!list.length) return
  let i = list.findIndex(c => st.card === `${c.dataset.row}|${c.dataset.obj}`)
  i = i < 0 ? (dir < 0 ? list.length - 1 : 0) : Math.max(0, Math.min(list.length - 1, i + dir))
  st.card = `${list[i].dataset.row}|${list[i].dataset.obj}`
  st.focus = null
  paintMarks()
  list[i].scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}

document.addEventListener('keydown', e => {
  const typing = document.activeElement === prompt
  if (e.key === 'Tab' && (!typing || !prompt.value)) { e.preventDefault(); stepMark(e.shiftKey ? -1 : 1); return }
  if (e.key === 'Escape') {
    e.preventDefault()
    if (st.props) { st.props = null; render(); return }
    if (st.tray.length) { backTray(); return }
    if (typing) { prompt.blur(); return }
    st.focus = null; st.card = null; paintMarks(); return
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    if (typing) {
      e.preventDefault()
      if (st.tray.length && st.mode === 'card' && prompt.value.trim()) { askMode(); send(); return }
      send()
      return
    }
    e.preventDefault()
    if (st.props) { const row = st.props; pressVerb(row, 'v', st.rows.find(r => r.row === row)?.record?.verbs?.v?.proposals?.[0]); return }
    if (st.tray.length && st.mode === 'card') { askMode(); return }
    if (st.focus) { openTray(st.focus); return }
    if (st.card) { const [row, id] = st.card.split('|'); const el = $(`#tx .card[data-row="${CSS.escape(row)}"][data-obj="${CSS.escape(id)}"]`); if (el?.dataset.v) openCard(el, null); return }
    prompt.focus()
    return
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); stepCard(e.key === 'ArrowUp' ? -1 : 1); return }
  const verb = st.verbs.find(v => v.key === e.key)
  if (verb) {
    const row = st.focus?.row || [...st.rows].reverse().find(r => r.kind === 'assistant')?.row
    if (row) { e.preventDefault(); pressVerb(row, verb.key) }
    return
  }
  if (e.key === '?' && st.card) { const [row, id] = st.card.split('|'); const el = $(`#tx .card[data-row="${CSS.escape(row)}"][data-obj="${CSS.escape(id)}"]`); if (el?.dataset.v) location.href = pageUrl('card', { o: id, v: el.dataset.v, from: row }, { ask: 1 }) }
})

// ---------------------------------------------------------------- start
async function start() {
  const v = await api('verbs')
  st.verbs = v.verbs || []
  await fontsReady
  await refreshSide()
  await refresh()
  hints()
  // a link to one row (#row=<key>): scrolled to and lit
  const want = new URLSearchParams(location.hash.slice(1)).get('row')
  const el = want && nodes.get(want)?.el
  if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash') } else scroll.scrollTop = scroll.scrollHeight
  let sideAt = 0
  follow(() => {
    refresh()
    if (Date.now() - sideAt > 3000) { sideAt = Date.now(); refreshSide() }
  }, open => {
    if (open === st.live) return
    st.live = open
    drawSide($('#side'), { info: st.info, objects: st.objects, on: 'session', live: st.live })
  })
  document.body.dataset.ready = '1'
}
start()
window.Mirror = { st, openTray, closeTray, askMode, refresh }
