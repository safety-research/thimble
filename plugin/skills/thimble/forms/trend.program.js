// A trend and the moment that changed it: p95 latency per hour for two regions, the deploy marked on the axis where it
// landed. Each line is a part that opens its rows, and so is the deploy.
const d = data.deploy
return k.stack(
  k.text(`eu-west's p95 rose from **${data.before} ms** to **${data.after} ms** after ${d.version} went out, and us-east stayed flat`),
  k.plot(data.regions.map((r, i) => ({ id: 'region-' + r.name, name: r.name, tone: i ? 'c3' : 'c1', points: r.hours.map(h => [h.hour, h.p95]), meta: { label: `${r.name}, p95 per hour`, ref: `r2#region=${r.name}@p95` } })),
    { h: k.mode === 'detail' ? 14 : 8, x: { label: 'hours from Jun 17 00:00', min: 0, max: 72, ticks: [0, 24, { at: d.hour, label: `▲ ${d.version}` }, 72] }, y: { label: 'p95 ms', min: 0 } }),
  k.region('deploy', { label: `${d.version} deployed ${d.label}`, ref: d.ref }, k.text(`{warn:▲} ${d.version} deployed ${d.label}`)),
)
