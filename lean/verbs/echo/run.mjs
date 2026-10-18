// echo: the smallest verb, which proves the path from a key press to a result. It reads the object (and the selected
// region, when there is one), asks the kernel where the region's value came from, and returns:
//   text  a few lines the person sees under the command row (Claude reads them too)
//   note  one line for Claude alone
//   object  a small object drawing what it said, which the runner saves with `lean save` and the terminal draws
export async function run(ctx) {
  const o = ctx.object
  if (!o) return { text: 'echo needs an object: open one first.' }
  const parts = Object.entries(o.data || {}).map(([k, v]) => `${k}: ${Array.isArray(v) ? `${v.length} rows` : typeof v}`)
  const lines = [`${o.title || o.id} (${o.id}@${o.version}) holds ${parts.join(', ') || 'no data'}.`]
  let rows = null
  const ref = (ctx.refs || [])[0] || refOf(ctx)
  if (ref) {
    const r = ctx.kernel.resolve(ref, 2)
    if (!r.error) {
      rows = r.count
      lines.push(`${ctx.region}: ${ref} comes from ${(r.count ?? 0).toLocaleString('en-US')} source rows, such as ${(r.records || [])[0]?.ref || 'none'}.`)
    } else lines.push(`${ctx.region}: ${r.error}`)
  } else if (ctx.region) lines.push(`${ctx.region} is selected; its meta names no kernel ref.`)
  return {
    text: lines.join('\n'),
    note: `The person ran echo on ${o.id}${ctx.region ? ` ▸ ${ctx.region}` : ''}.`,
    object: {
      name: `${o.id.replace(/^\d+-/, '')}-echo`,
      title: `echo of ${o.title || o.id}`,
      data: { parts, rows, region: ctx.region || null },
      declared: { made_by: 'the echo verb', from: `obj:${o.id}@${o.version}` },
      program: [
        "return k.frame(k.stack(",
        "  data.parts.map(p => k.text('· ' + k.escape(p))),",
        "  data.region ? k.text(`{dim:selected} **${k.escape(data.region)}**` + (data.rows != null ? ` · ${k.fmt(data.rows)} source rows` : '')) : false,",
        "), { title: 'echo' })",
      ].join('\n'),
    },
  }
}

// the kernel ref a region names: its meta's `ref`, its cite's `ref`, or none
function refOf(ctx) {
  const m = ctx.regionMeta || {}
  const r = m.ref || (m.cite && typeof m.cite === 'object' ? m.cite.ref : null)
  return typeof r === 'string' ? r : Array.isArray(r) ? r[0] : null
}
