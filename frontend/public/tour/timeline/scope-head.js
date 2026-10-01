// The scope header thimble draws above every corpus view (the same code for every view): the unit picker, Combined |
// Compare, the files the view reads, its derived data per record type, and the lines it could not read. A view gives
// its unit, files, schema and labels; the header sends the unit's selection back to the view (thimble.onScope).
;(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const svg = (d, size = 14) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"></path></svg>`
  const I = { down: 'M6 9l6 6 6-6', right: 'M9 6l6 6-6 6', check: 'M5 12.5l4.5 4.5L19 7', file: 'M8 3h6l5 5v11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM14 3v5h5' }
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)

  function mount(o) {
    const keysAll = o.unit.options.map((u) => u.key)
    const S = { keys: (o.unit.initial || keysAll).slice(), compare: false, open: null }
    const host = o.host
    let pop = null

    const unitValue = () => {
      if (!o.unit.multi) return o.unit.options.find((u) => u.key === S.keys[0]).title
      if (S.keys.length === keysAll.length) return `All ${keysAll.length}`
      return S.keys.length <= 3 ? S.keys.join(', ') : `${S.keys.length} ${o.unit.label.toLowerCase()}`
    }
    const derivedText = () => {
      const n = o.derived.records.reduce((s, r) => s + r.fields.filter((f) => f.derived).length, 0)
      const parts = [n ? plural(n, 'field') : 'no fields']
      if (o.derived.labels.length) parts.push(plural(o.derived.labels.length, 'label'))
      return `Derived data: ${parts.join(', ')}`
    }

    function render() {
      const files = o.files(S.keys), bad = o.problems(S.keys)
      let h = `<button type="button" class="btn btn-secondary btn-sm sh-unit" data-pop="units" aria-haspopup="dialog" aria-expanded="${S.open === 'units'}"><span class="k">${esc(o.unit.label)}</span><b>${esc(unitValue())}</b>${svg(I.down, 12)}</button>`
      if (o.compare && o.unit.multi && S.keys.length >= 2) {
        h += `<span class="seg seg-md" role="radiogroup" aria-label="Combined or compared">` + ['Combined', 'Compare'].map((n, i) =>
          `<button type="button" role="radio" aria-checked="${S.compare === !!i}" class="seg-opt${S.compare === !!i ? ' active' : ''}" data-compare="${i}"><span class="seg-label">${n}</span></button>`).join('') + '</span>'
      }
      h += `<span class="sh-dot">·</span><button type="button" class="view-pane-files" data-pop="files" aria-expanded="${S.open === 'files'}">${plural(files.count, 'file')}</button>`
      h += `<span class="sh-dot">·</span><button type="button" class="view-pane-files" data-pop="derived" aria-expanded="${S.open === 'derived'}">${derivedText()}</button>`
      if (bad.length) h += `<span class="sh-dot">·</span><button type="button" class="view-pane-problems" data-pop="bad" aria-expanded="${S.open === 'bad'}">${plural(bad.length, 'line')} could not be read</button>`
      host.innerHTML = `${o.side || ''}<div class="sh">${h}</div>`
      for (const b of host.querySelectorAll('[data-pop]')) b.onclick = (e) => { e.stopPropagation(); toggle(b.dataset.pop) }
      for (const b of host.querySelectorAll('[data-compare]')) b.onclick = () => { S.compare = b.dataset.compare === '1'; render(); tell() }
    }
    const tell = () => o.onScope && o.onScope(S.keys.slice(), S.compare && S.keys.length >= 2)

    // ------------------------------------------------------------------------------------------------ popovers
    function close() { pop?.remove(); pop = null; if (S.open) { S.open = null; render() } }
    function toggle(name) {
      if (S.open === name) return close()
      pop?.remove()
      S.open = name
      render()
      const trigger = host.querySelector(`[data-pop="${name}"]`)
      pop = document.createElement('div')
      pop.className = `popover sh-pop sh-${name}` + (name === 'units' ? ' menu' : '')
      pop.setAttribute('role', 'dialog')
      pop.innerHTML = ({ units: unitsPop, files: filesPop, derived: derivedPop, bad: badPop })[name]()
      document.body.append(pop)
      const r = trigger.getBoundingClientRect()
      pop.style.top = `${r.bottom + 6}px`
      pop.style.left = `${Math.max(8, Math.min(r.left - (name === 'units' ? 0 : 8), innerWidth - pop.offsetWidth - 12))}px`
      pop.onclick = (e) => e.stopPropagation()
      wire(name)
    }
    document.addEventListener('click', () => { if (pop) close() })
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pop) close() })

    const tick = (on) => `<span class="sh-tick${on ? ' on' : ''}">${svg(I.check, 10)}</span>`
    function unitsPop() {
      let h = o.unit.note ? `<div class="sh-sum">${esc(o.unit.note)}</div>` : ''
      if (o.unit.multi) h += `<button type="button" class="menu-item all" data-unit="*">${tick(S.keys.length === keysAll.length)}<span class="sh-unit-text"><b>All ${esc(o.unit.label.toLowerCase())}</b></span><span class="menu-item-note">${keysAll.length}</span></button><div class="menu-sep"></div>`
      for (const u of o.unit.options) h += `<button type="button" class="menu-item" data-unit="${esc(u.key)}">${tick(S.keys.includes(u.key))}<span class="sh-unit-text"><b>${esc(u.title)}</b>${u.sub ? `<span>${esc(u.sub)}</span>` : ''}</span><span class="menu-item-note">${u.note || ''}</span></button>`
      return h
    }
    function filesPop() {
      const f = o.files(S.keys)
      let h = `<div class="sh-sum">${esc(f.summary)}</div>`
      f.groups.forEach((g, i) => {
        h += `<button type="button" class="sh-group" data-g="${i}" aria-expanded="${!g.collapsed}">${svg(I.right, 12)}${esc(g.title)}<span class="n">${esc(g.note)}</span></button><div class="sh-rows" data-rows="${i}"${g.collapsed ? ' hidden' : ''}>`
        for (const r of g.rows) {
          h += `<button type="button" class="sh-file" data-file="${esc(r.path)}" title="Open ${esc(r.path)} in the File browser"><span class="ok">${svg(I.file, 12)}</span><span class="p">${r.dir ? `<span class="dir">${esc(r.dir)}</span>` : ''}${esc(r.name)}</span><span class="gives">${esc(r.gives)}</span>` +
            (r.bad || []).map((b) => `<span class="bad">${esc(b)}</span>`).join('') + '</button>'
        }
        h += '</div>'
      })
      return h
    }
    function derivedPop() {
      const d = o.derived
      let h = `<div class="sh-sum">Per record type. Cleaned: the file's own value, renamed, parsed or put in UTC. Computed: a value the files do not hold.</div>`
      d.records.forEach((rec, i) => {
        const der = rec.fields.filter((f) => f.derived), comp = der.filter((f) => f.derived === 'computed'), raw = rec.fields.filter((f) => !f.derived)
        const count = d.count && d.count(rec.name)
        h += `<div class="dg${i === 0 ? ' open' : ''}" data-rec="${esc(rec.name)}"><button type="button" class="dg-head">${svg(I.right, 12)}<b>Per ${esc(rec.name)}</b><span class="one">${[count != null ? plural(count, rec.name) : '', rec.one !== 'one ' + rec.name ? rec.one : ''].filter(Boolean).map(esc).join(' · ')}</span><span class="n">${der.length} of ${plural(rec.fields.length, 'field')} derived</span></button><div class="dg-body">`
        for (const f of [...comp, ...der.filter((x) => x.derived !== 'computed')]) {
          h += `<div class="df"><span class="f">${esc(f.name)}</span><span class="t ${f.derived}">${f.derived}</span><span class="h" title="from ${esc(f.from)}: ${esc(f.how)}"><i>from</i> ${esc(f.from)}${f.how ? `<i>:</i> ${esc(f.how)}` : ''}</span></div>`
        }
        if (raw.length) h += `<div class="df raw"><span class="f">${raw.map((f) => esc(f.name)).join(', ')}</span><span class="t">as read</span><span class="h"></span></div>`
        h += '</div></div>'
      })
      if (d.labels.length) {
        h += `<div class="dg"><button type="button" class="dg-head">${svg(I.right, 12)}<b>Labels</b><span class="one">${esc(d.labelsOn)}</span><span class="n">${plural(d.labels.length, 'label')}</span></button><div class="dg-body">`
        for (const l of d.labels) h += `<div class="dl"><span class="sw" style="background:${l.colour}"></span><span>${esc(l.name)}</span><span class="h">${esc(l.how)}</span><span class="n">${esc(l.n)}</span></div>`
        h += '</div></div>'
      }
      return h
    }
    function badPop() {
      return o.problems(S.keys).map((p) => {
        const [path, line] = p.ref.split('#L')
        return `<button type="button" class="sh-file" data-file="${esc(path)}" title="Open ${esc(path)} at line ${line}"><span class="ok">${svg(I.file, 12)}</span><span class="p">${esc(path)} <span class="dir">line ${line}</span></span><span class="gives"></span><span class="why">${esc(cap(p.why))}</span>${p.text ? `<code>${esc(p.text)}</code>` : ''}</button>`
      }).join('')
    }
    function wire(name) {
      if (name === 'units') for (const b of pop.querySelectorAll('[data-unit]')) b.onclick = (e) => {
        e.stopPropagation()
        const k = b.dataset.unit
        if (!o.unit.multi) S.keys = [k]
        else if (k === '*') S.keys = keysAll.slice()
        else if (S.keys.includes(k)) { if (S.keys.length > 1) S.keys = S.keys.filter((x) => x !== k) }
        else S.keys = keysAll.filter((x) => x === k || S.keys.includes(x))
        if (S.keys.length < 2) S.compare = false
        pop.innerHTML = unitsPop(); wire('units'); render(); tell()
      }
      if (name === 'files') for (const g of pop.querySelectorAll('.sh-group')) g.onclick = () => {
        const rows = pop.querySelector(`[data-rows="${g.dataset.g}"]`)
        rows.hidden = !rows.hidden; g.setAttribute('aria-expanded', String(!rows.hidden))
      }
      if (name === 'derived') for (const g of pop.querySelectorAll('.dg-head')) g.onclick = () => g.parentElement.classList.toggle('open')
      for (const f of pop.querySelectorAll('[data-file]')) f.addEventListener('click', () => { if (o.onFile) { const p = f.dataset.file; close(); o.onFile(p) } })
    }

    render()
    return {
      setScope(keys, compare = false) { S.keys = keys.slice(); S.compare = compare; render(); tell() },
      open(name) { toggle(name) },
      close,
      expand(rec) { pop?.querySelector(`.dg[data-rec="${rec}"]`)?.classList.add('open') },
      collapse(rec) { pop?.querySelector(`.dg[data-rec="${rec}"]`)?.classList.remove('open') },
      get keys() { return S.keys.slice() },
    }
  }
  window.ScopeHead = { mount, plural }
})()
