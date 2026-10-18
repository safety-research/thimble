// card.js: the card detail, one pattern for every card. ?o=<id>&v=<k>&from=<row>#r=<region>
//
// The header: the title, the takeaway (the object's words, its citations live: one that a part rests on selects the
// part), and the versions, v1 · v2. The card large, drawn by draw/svg.js from its program; a click or ↑ ↓ selects a
// part. One "from" line: sources · rows used · labels used · coverage, from the object's lineage and `lean coverage`.
// The examples behind the selected part, flipped with [ ]. The side thread: the turn that made the card, and the
// questions asked here, each sent to the terminal session with this card and part as its scope, with Claude's answer
// when it comes. p lays the program over the page, its lines that drew the part lit. esc goes back.
import { $, $$, api, back, esc, fmt, follow, objectOf, pageUrl } from '../common/base.js'
import { citedHtml, messageHtml, plain } from '../common/marks.js'
import { columnsIn, drawingOf, fontsReady, svgOf, unframe } from '../common/draw.js'
import { drawSide, sideData } from '../common/side.js'
import { knobOf, turn } from '../draw/handoff.js'
import { chainWords, isRef, regionRefs } from '../lib/object.js'

const q = new URLSearchParams(location.search)
const h = new URLSearchParams(location.hash.slice(1))
const st = {
  id: q.get('o'), v: q.get('v') ? Number(q.get('v')) : null, from: q.get('from'),
  object: null, versions: [], latest: null, fresh: null,
  drawing: null, res: null, w: 80, state: {}, part: h.get('r'), hover: null,
  cite: null,           // a takeaway citation no part rests on, shown in place of a part
  ex: 0, overlay: false, facts: null, rows: [], asks: [], live: false, info: null, objects: [],
}
const resolved = new Map()
const resolve = ref => { if (!resolved.has(ref)) resolved.set(ref, api(`resolve?ref=${encodeURIComponent(ref)}&n=8`)); return resolved.get(ref) }

// ---------------------------------------------------------------- loading
async function load(v) {
  const r = await objectOf(st.id, v)
  if (r.error || !r.object) {
    $('#dtitle').textContent = st.id || 'No card'
    $('#dcard').innerHTML = `<p class="notice bad">${esc(r.error || 'no object named in the link')}</p>`
    return false
  }
  st.object = r.object
  st.v = r.object.version
  st.versions = r.versions
  st.latest = r.latest
  st.facts = null
  api(`from/${encodeURIComponent(st.id)}?v=${st.v}`).then(f => { st.facts = f.error ? null : f; drawFrom() })
  await draw()
  return true
}

async function draw() {
  await fontsReady
  st.w = columnsIn($('#dcard').clientWidth - 44)
  st.drawing = unframe(await drawingOf(st.object, { w: st.w, mode: 'detail', state: Object.keys(st.state).length ? st.state : undefined })).drawing
  paint()
}

function partsOf() { return st.res ? st.res.parts : [] }
const partNow = () => partsOf().find(p => p.id === st.part) || null

function paint() {
  const o = st.object
  document.title = `${o.title || o.id} · thimble`
  $('#dtitle').textContent = o.title || o.id
  st.res = svgOf(st.drawing, { w: st.w, selected: st.cite ? null : st.part, hover: st.hover })
  if (!st.cite && st.part && !partNow()) st.part = null
  if (!st.cite && !st.part && partsOf().length) { st.part = partsOf()[0].id; st.res = svgOf(st.drawing, { w: st.w, selected: st.part }) }
  $('#dcard').innerHTML = (st.drawing.error ? `<p class="err">× its program failed: ${esc(st.drawing.error.name)}: ${esc(st.drawing.error.message)}</p>` : '') + st.res.svg
  versions()
  takeaway()
  drawFrom()
  evidence()
  foot()
  scopeLine()
  if (st.overlay) program()
  history.replaceState(null, '', `${location.pathname}?${new URLSearchParams({ o: st.id, v: st.v, ...(st.from ? { from: st.from } : {}) })}${st.part ? '#r=' + encodeURIComponent(st.part) : ''}`)
}

function versions() {
  const vs = st.versions
  $('#vers').innerHTML = vs.map((x, i) => `${i ? '<span class="sep">·</span>' : ''}<button data-v="${x.v}" class="${x.v === st.v ? 'on' : ''}${st.fresh === x.v ? ' fresh' : ''}" title="${esc(x.change || (x.at ? 'saved ' + x.at.slice(0, 16).replace('T', ' ') : ''))}">v${x.v}</button>`).join('') + (vs.length > 1 ? '<kbd>h</kbd>' : '')
}

// the part a citation's ref rests under, if any
function partOfRef(ref) {
  for (const p of partsOf()) if (regionRefs(st.object, st.drawing, p.id).refs.includes(ref)) return p.id
  return null
}

function takeaway() {
  const text = st.object.text || st.object.question || ''
  $('#take').innerHTML = citedHtml(text)
  $$('#take .cite').forEach(el => {
    const ref = el.dataset.ref.replace(/&amp;/g, '&')
    const p = ref.startsWith('#') ? ref.slice(1) : partOfRef(ref)
    el.classList.toggle('on', (p && p === st.part && !st.cite) || st.cite === ref)
  })
}

// ---------------------------------------------------------------- from · rows · labels · coverage
function drawFrom() {
  const f = st.facts
  const p = partNow()
  if (!f) { $('#dfrom').innerHTML = 'from …'; return }
  const files = f.sources.map(s => s.path)
  const src = files.length ? `<b>${esc(files[0])}</b>${files.length > 1 ? ` and ${files.length - 1} more` : ''}` : '<b>no source rows</b>'
  // rows used: the selected part's own rows when its ref resolves, else the object's
  const pr = st.cite ? st.cite : p ? regionRefs(st.object, st.drawing, p.id).refs[0] : null
  const res = pr && resolved.get(pr)
  let rows = `${fmt(f.rows)} rows`
  if (res) res.then(r => { if (r && r.count != null && (st.cite || partNow()) === (st.cite ? st.cite : p) && $('#dfrom .rows')) $('#dfrom .rows').textContent = `${fmt(r.count)} of ${fmt(f.rows)} rows` })
  const labels = f.labels.length ? `labels <b>${f.labels.map(esc).join(', ')}</b>` : 'no labels'
  const c = f.coverage
  const all = c && c.feeding === c.files
  const cov = c ? `<span class="covd${all ? ' all' : ''}"><i></i>${fmt(c.feeding)} of ${fmt(c.files)} files</span>` : ''
  const unread = f.session && f.session.notReadFiles ? ` · the session had not read ${fmt(f.session.notReadFiles)} file${f.session.notReadFiles === 1 ? '' : 's'} (${fmt(f.session.notReadRows)} rows)` : ''
  $('#dfrom').innerHTML = `from ${src} · <span class="rows">${rows}</span> · ${labels}${cov ? ' · ' + cov : ''}${unread}`
}

// ---------------------------------------------------------------- the examples behind the part
const fill = (f, rec) => String(f).replace(/\{([\w.]+)\}/g, (m, key) => { const v = key.split('.').reduce((x, k) => (x == null ? undefined : x[k]), rec); return v === undefined ? m : typeof v === 'number' && !/(^|_)(id|rev|step|epoch|run|ref|line)$/i.test(key) ? fmt(v) : String(v) })

async function evidence(flash) {
  const d = st.drawing
  const p = partNow()
  const box = $('#dev')
  const meta = p?.meta || {}
  const cite = typeof meta.cite === 'string' ? d.cites?.[meta.cite] : null
  const exset = typeof meta.examples === 'string' ? d.examples?.[meta.examples] : null
  const claim = st.cite ? ($(`#take .cite[data-ref="${CSS.escape(st.cite)}"]`)?.textContent || st.cite) : cite?.text || meta.label || p?.id || ''
  const head = (n, total) => `<div class="evh"><div class="claim">${esc(plain(claim))}</div><div class="pos">${n ? `<kbd data-flip="-1">[</kbd><kbd data-flip="1">]</kbd> <b>${st.ex + 1}</b> of ${fmt(total ?? n)}` : ''}</div></div>`
  if (!p && !st.cite) { box.innerHTML = partsOf().length ? '' : `<p class="evnote">This card has no parts to select.</p>`; return }
  // the examples the program attached to the part
  if (exset && exset.records?.length) {
    const recs = exset.records, n = recs.length
    st.ex = ((st.ex % n) + n) % n
    const fit = 6, from = Math.max(0, Math.min(st.ex - 2, n - fit))
    box.innerHTML = head(n, exset.total) + '<div class="recs">' + recs.slice(from, from + fit).map((r, j) => {
      const on = from + j === st.ex
      const [a, b] = exset.fmt && typeof r === 'object' ? fill(exset.fmt, r).split('\n') : [typeof r === 'string' ? r : r.text ?? JSON.stringify(r), r.ref || '']
      return `<div class="rec${on ? ' on' : ''}${on && flash ? ' flash' : ''}" data-ex="${from + j}"><div class="q">${citedHtml(a).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')}</div><div class="m">${esc(b || '')}</div></div>`
    }).join('') + '</div>'
    return
  }
  // else the rows the part rests on, read through the kernel
  const refs = st.cite ? [st.cite] : regionRefs(st.object, d, p.id).refs
  if (!refs.length) {
    const rows = cite?.rows || []
    box.innerHTML = head(0) + (rows.length ? rowsTable(rows) : `<p class="evnote">This part names no ref and matches no data row, so there are no rows to show.</p>`)
    return
  }
  box.innerHTML = head(0) + '<p class="evnote">reading the rows behind it…</p>'
  const want = st.cite || p.id
  const r = await resolve(refs[0])
  if ((st.cite || st.part) !== want) return
  drawFrom()
  const c = chainWords(r)
  if (c.error) { box.innerHTML = head(0) + `<p class="evnote bad">${esc(c.notes[0])}</p>`; return }
  const recs = c.records
  const n = recs.length
  if (n) st.ex = ((st.ex % n) + n) % n
  box.innerHTML = head(n, r.count) + `<p class="evnote">← ${esc(c.line)}</p>` + '<div class="recs">' + recs.map((x, j) => `<div class="rec${j === st.ex ? ' on' : ''}${j === st.ex && flash ? ' flash' : ''}" data-ex="${j}"><div class="q">${esc(x.text)}</div><div class="m">${esc(x.ref)}</div></div>`).join('') + '</div>'
}

function rowsTable(rows) {
  const keys = [...new Set(rows.flatMap(r => Object.keys(r || {})))].filter(k => k !== '_rows').slice(0, 6)
  const num = k => rows.every(r => typeof r[k] === 'number')
  return `<table class="rows"><tr>${keys.map(k => `<th class="${num(k) ? 'n' : ''}">${esc(k)}</th>`).join('')}</tr>${rows.slice(0, 8).map(r => `<tr>${keys.map(k => `<td class="${num(k) ? 'n' : ''}">${esc(typeof r[k] === 'number' ? fmt(r[k]) : typeof r[k] === 'object' ? JSON.stringify(r[k]) : r[k])}</td>`).join('')}</tr>`).join('')}</table>`
}

function foot() {
  const knob = (st.drawing.controls || [])[0]
  const items = [['↑↓', 'part', 'part'], knob ? ['← →', `turn ${knob.label}`, 'knob'] : null, ['[ ]', 'example', 'ex'], ['p', st.overlay ? 'close program' : 'program', 'p'], st.versions.length > 1 ? ['h', 'versions', 'h'] : null, ['esc', 'back', 'esc']].filter(Boolean)
  $('#dfoot').innerHTML = items.map(([k, l, a]) => `<button data-act="${a}"><kbd>${k}</kbd>${l}</button>`).join('') + `<span class="sp"></span><span class="mono">${esc(st.id)}@${esc(st.v)}</span>`
}

// ---------------------------------------------------------------- p: the program behind it
const KW = /^(const|let|var|function|return|if|else|for|of|in|new|true|false|null|undefined|typeof|while)$/
function jsHtml(line) {
  const re = /(\/\/.*$)|(`(?:\\.|[^`])*`?|'(?:\\.|[^'])*'|"(?:\\.|[^"])*")|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|(\s+)|(.)/g
  let m, out = ''
  while ((m = re.exec(line))) {
    if (m[1]) out += `<span class="cm">${esc(m[1])}</span>`
    else if (m[2]) out += `<span class="st">${esc(m[2])}</span>`
    else if (m[3]) out += `<span class="nu">${m[3]}</span>`
    else if (m[4]) out += KW.test(m[4]) ? `<span class="kw">${m[4]}</span>` : m[4] === 'k' || m[4] === 'data' ? `<span class="kd">${m[4]}</span>` : m[4]
    else out += esc(m[0])
    if (m[0] === '') re.lastIndex++
  }
  return out
}

/** The program's lines that name the part: its id, else the id's stem (`day-` of `day-2026-05-04`), else its maker. */
function linesFor(lines, id) {
  if (!id) return new Set()
  const stem = id.replace(/[-_.:][^-_.:]*$/, '')
  const hit = new Set()
  const find = t => lines.forEach((l, i) => { if (l.includes(t)) hit.add(i + 1) })
  find(id)
  if (stem.length >= 2 && stem !== id) find(stem.endsWith('-') ? stem : stem + '-')
  if (!hit.size) for (const t of ['region(', 'bars(', 'table(']) { find(t); if (hit.size) break }
  return hit
}

async function program() {
  const lines = String(st.object.program || '').split('\n')
  const p = partNow()
  const on = linesFor(lines, p?.id)
  $('#pgmeta').textContent = `· ${lines.length} lines of the card program`
  $('#pgpart').textContent = p ? plain(p.meta?.label || p.id) : 'the card'
  const first = Math.min(...[...on]) || 1
  $('#pgcode').innerHTML = lines.map((l, i) => `<div class="row${on.has(i + 1) ? ' on' : ''}"><span class="ln">${i + 1}</span><span class="src">${jsHtml(l)}</span></div>`).join('')
  const rowEl = $$('#pgcode .row')[Math.max(0, first - 4)]
  if (rowEl) $('#pgcode').scrollTop = rowEl.offsetTop - 6
  // the query behind the part's rows
  const ref = p ? regionRefs(st.object, st.drawing, p.id).refs[0] : null
  $('#pgq').innerHTML = ''
  if (ref) {
    const r = await resolve(ref)
    const qy = (r.chain || []).find(s => s.step === 'query')
    if (qy && st.overlay) $('#pgq').innerHTML = `<span>rows</span>${esc(qy.id)} · ${esc(qy.about || '')}${qy.code ? ' · ' + esc(String(qy.code).trim().split('\n').slice(-1)[0]) : ''}`
  }
}

function toggleProgram(on) {
  st.overlay = on == null ? !st.overlay : on
  $('#dprog').classList.toggle('on', st.overlay)
  $('#dprog').setAttribute('aria-hidden', String(!st.overlay))
  if (st.overlay) program()
  foot()
}

// ---------------------------------------------------------------- the side thread
function scopeLine() {
  const p = partNow()
  const label = st.cite ? ($(`#take .cite[data-ref="${CSS.escape(st.cite)}"]`)?.textContent || st.cite) : p ? plain(p.meta?.label || p.id) : (st.object.title || st.id)
  $('#tscope').innerHTML = `about <b>${esc(label)}</b>`
  $('#tprompt').placeholder = `Ask about ${label}…`
}

/** Claude's messages after a prompt, up to the next prompt: its answer, once it is in the session. */
function answerAfter(i) {
  const out = []
  for (let j = i + 1; j < st.rows.length && st.rows[j].kind !== 'user'; j++) if (st.rows[j].record) out.push(st.rows[j])
  return out
}

function thread() {
  const box = $('#tmsgs')
  const stick = box.childElementCount > 0 && box.scrollHeight - box.scrollTop - box.clientHeight < 60
  let h = ''
  // the turn that made the card: the prompt before it, and Claude's message that carries it
  const at = st.rows.findIndex(r => r.kind === 'assistant' && (r.row === st.from || (r.record?.objects || []).some(x => String(x).split('@')[0] === st.id)))
  if (at >= 0) {
    let u = at
    while (u >= 0 && st.rows[u].kind !== 'user') u--
    if (u >= 0) h += `<div class="bub">${esc(st.rows[u].text)}</div>`
    h += lead(st.rows[at])
  }
  // what was asked here, and the answer once it came
  for (const a of st.asks.filter(x => x.scope?.object === st.id)) {
    const label = a.scope.label || a.scope.region || ''
    h += `<div class="bub">${esc(a.text)}</div>${label ? `<div class="about">about <b>${esc(label)}</b></div>` : ''}`
    if (a.error) { h += `<div class="problem">not sent: ${esc(a.error)}</div>`; continue }
    const i = st.rows.findIndex(r => r.kind === 'user' && r.text === a.text)
    const ans = i >= 0 ? answerAfter(i) : []
    if (!ans.length) { h += `<div class="wait"><span class="s7">✻</span>${i >= 0 ? 'Claude is working in the terminal' : 'sent to the terminal session'}…</div>`; continue }
    for (const r of ans) {
      const made = (r.record.objects || []).map(String).filter(x => x.split('@')[0] === st.id)
      if (made.length) h += `<div class="made"><i></i><b>cards</b><code>saved ${esc(st.id)}${st.latest ? ' v' + esc(st.latest) : ''}</code></div>`
      h += lead(r)
    }
  }
  if (!h) h = `<div class="when">questions here go to the terminal session with this card</div>`
  box.innerHTML = h
  if (stick) box.scrollTop = box.scrollHeight
}

/** A message of Claude's in the thread: its first paragraph, and the whole of it a click away in the mirror. */
function lead(row) {
  const rec = row.record
  const text = String(rec.shown ?? rec.text ?? '')
  const cut = text.search(/\n\s*\n/)
  if (cut < 0 || cut > 900) return `<div class="say">${messageHtml(rec).html}</div>`
  const first = { ...rec, shown: text.slice(0, cut), marks: (rec.marks || []).filter(m => m.end <= cut) }
  return `<div class="say">${messageHtml(first).html}</div><a class="whole" href="${pageUrl('mirror', {}, { row: row.row })}">the whole message ›</a>`
}

async function ask() {
  const t = $('#tprompt')
  const text = t.value.trim()
  if (!text) return
  t.value = ''
  const p = partNow()
  const label = st.cite ? ($(`#take .cite[data-ref="${CSS.escape(st.cite)}"]`)?.textContent || st.cite) : p ? plain(p.meta?.label || p.id) : ''
  const scope = { object: st.id, v: st.v, ...(p && !st.cite ? { region: p.id } : {}), ...(label ? { label } : {}), ...(st.from ? { row: st.from } : {}), ...(st.cite ? { mark: { kind: 'cite', ref: st.cite, label } } : {}) }
  const a = { text, scope, at: new Date().toISOString() }
  st.asks.push(a)
  thread()
  const r = await back({ ask: text, scope })
  if (r.error) a.error = r.error
  thread()
}

// ---------------------------------------------------------------- actions
function select(id) {
  st.cite = null
  st.part = id
  st.ex = 0
  st.res = svgOf(st.drawing, { w: st.w, selected: id })
  $('#dcard').innerHTML = (st.drawing.error ? $('#dcard .err')?.outerHTML || '' : '') + st.res.svg
  takeaway(); drawFrom(); evidence(); scopeLine()
  if (st.overlay) program()
  history.replaceState(null, '', `${location.pathname}${location.search}${id ? '#r=' + encodeURIComponent(id) : ''}`)
}
function movePart(step) {
  const ps = partsOf()
  if (!ps.length) return
  const i = ps.findIndex(p => p.id === st.part)
  select(ps[i < 0 ? 0 : (i + step + ps.length) % ps.length].id)
  const r = st.res.regions.find(x => x.id === st.part)
  if (r) { const box = $('#dcard'); const y = r.rects[0].y; if (y < box.scrollTop || y > box.scrollTop + box.clientHeight - 30) box.scrollTop = y - 40 }
}
function showCite(ref) {
  const p = ref.startsWith('#') ? ref.slice(1) : partOfRef(ref)
  if (p && partsOf().some(x => x.id === p)) return select(p)
  st.cite = ref
  st.ex = 0
  st.res = svgOf(st.drawing, { w: st.w })
  $('#dcard').innerHTML = st.res.svg
  takeaway(); drawFrom(); evidence(); scopeLine()
}
function flip(step, to) { st.ex = to != null ? to : st.ex + step; evidence(true) }
async function turnKnob(id, step) {
  st.state = turn(st.drawing, st.state, id, step)
  st.drawing = unframe(await drawingOf(st.object, { w: st.w, mode: 'detail', state: st.state })).drawing
  paint()
}
async function showVersion(v) {
  if (v === st.v) return
  const keep = st.part
  st.state = {}
  if (await load(v)) { if (keep && partsOf().some(p => p.id === keep)) select(keep) }
}
function goBack() {
  if (document.referrer && new URL(document.referrer).pathname.includes('/mirror/')) history.back()
  else location.href = pageUrl('mirror', {}, { row: st.from })
}

document.addEventListener('click', e => {
  const t = e.target
  if (t.closest('#dprog') || t.closest('#tcomp')) return
  const act = t.closest('#dfoot [data-act]')
  if (act) {
    const a = act.dataset.act
    if (a === 'esc') goBack(); else if (a === 'p') toggleProgram(); else if (a === 'part') movePart(1); else if (a === 'ex') flip(1); else if (a === 'h') cycleVersion(); else if (a === 'knob') turnKnob(null, 1)
    return
  }
  if (st.overlay) { toggleProgram(false); return }
  const vb = t.closest('#vers button'); if (vb) { showVersion(Number(vb.dataset.v)); return }
  const fl = t.closest('[data-flip]'); if (fl) { flip(Number(fl.dataset.flip)); return }
  const rec = t.closest('#dev [data-ex]'); if (rec) { flip(0, Number(rec.dataset.ex)); return }
  const c = t.closest('#take .cite'); if (c) { showCite(c.dataset.ref.replace(/&amp;/g, '&')); return }
  const r = t.closest('#dcard [data-region]')
  if (r) {
    const id = r.dataset.region
    if (knobOf(st.drawing, id)) { const b = r.getBoundingClientRect(); turnKnob(id, e.clientX < b.left + b.width / 2 ? -1 : 1); return }
    select(id)
  }
})
$('#dcard').addEventListener('mousemove', e => {
  const r = e.target.closest('[data-region]')
  const id = r ? r.dataset.region : null
  if (id === st.hover) return
  st.hover = id
  const res = svgOf(st.drawing, { w: st.w, selected: st.cite ? null : st.part, hover: id })
  $('.sel-layer', $('#dcard'))?.replaceWith(new DOMParser().parseFromString(res.svg, 'image/svg+xml').querySelector('.sel-layer'))
})
function cycleVersion() { if (st.versions.length > 1) { const i = st.versions.findIndex(x => x.v === st.v); showVersion(st.versions[(i - 1 + st.versions.length) % st.versions.length].v) } }

const tp = $('#tprompt')
tp.addEventListener('focus', () => $('#tcomp').classList.add('focus'))
tp.addEventListener('blur', () => $('#tcomp').classList.remove('focus'))
$('#tsend').addEventListener('click', ask)
document.addEventListener('keydown', e => {
  const k = e.key
  if (document.activeElement === tp) {
    if (k === 'Enter' && !e.shiftKey) { e.preventDefault(); ask() }
    else if (k === 'Escape') { e.preventDefault(); tp.blur() }
    return
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (k === 'Escape') { e.preventDefault(); if (st.overlay) toggleProgram(false); else goBack() }
  else if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'Tab') { e.preventDefault(); movePart(k === 'ArrowUp' || (k === 'Tab' && e.shiftKey) ? -1 : 1) }
  else if (k === 'ArrowLeft' || k === 'ArrowRight') { if ((st.drawing?.controls || []).length) { e.preventDefault(); turnKnob(knobOf(st.drawing, st.part) ? st.part : null, k === 'ArrowLeft' ? -1 : 1) } }
  else if (k === '[' || k === ']') flip(k === ']' ? 1 : -1)
  else if (k === 'p') toggleProgram()
  else if (k === 'h') cycleVersion()
  else if (k === '?' || k === 'Enter') { e.preventDefault(); tp.focus() }
})

// ---------------------------------------------------------------- start, and follow the session
async function refreshRows() {
  const [m, a] = await Promise.all([api('messages'), api('asks')])
  const rows = m.rows || []
  const mine = st.asks.filter(x => !x.error)
  const asks = (a.asks || [])
  // asks this page made and the server kept are one
  st.asks = asks.concat(st.asks.filter(x => x.error || !asks.some(y => y.text === x.text)))
  const changed = JSON.stringify(rows) !== JSON.stringify(st.rows) || mine.length !== asks.length
  st.rows = rows
  if (changed) thread()
}
async function refreshVersions() {
  const r = await api(`object/${encodeURIComponent(st.id)}`)
  if (r.error || !r.versions) return
  if (r.latest !== st.latest) {
    const wasLatest = st.v === st.latest
    st.fresh = r.latest
    st.versions = r.versions
    st.latest = r.latest
    if (wasLatest) await showVersion(r.latest); else versions()
  }
}
async function refreshSide() {
  const d = await sideData()
  st.info = d.info; st.objects = d.objects
  drawSide($('#side'), { info: st.info, objects: st.objects, on: st.id, live: st.live })
}

async function start() {
  if (!st.id) { $('#dcard').innerHTML = '<p class="notice bad">No card named in the link.</p>'; document.body.dataset.ready = '1'; return }
  await Promise.all([refreshSide(), refreshRows()])
  await load(st.v)
  thread()
  if (h.get('ask')) tp.focus()
  follow(() => { refreshRows(); refreshVersions(); refreshSide() }, open => { st.live = open; drawSide($('#side'), { info: st.info, objects: st.objects, on: st.id, live: open }) })
  addEventListener('resize', () => { clearTimeout(st.rz); st.rz = setTimeout(() => draw(), 200) })
  document.body.dataset.ready = '1'
}
start()
window.Card = { st, select, movePart, flip, toggleProgram, showVersion, ask }
