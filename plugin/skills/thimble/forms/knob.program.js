// A knob that changes the answer: how many CI jobs hung depends on how long a job may stay quiet. Each job is a strip of
// its minutes, its quiet stretches drawn where they fell, red when they pass the knob's threshold; the count follows.
const t = k.knob('quiet', { values: [2, 5, 10, 20], at: 5, label: 'hung after', fmt: v => `${v} min quiet` })
const W = Math.max(20, Math.min(k.w - 20, 70))
const hung = data.jobs.filter(j => j.gaps.some(g => g.min >= t))
return k.stack(
  k.beside(k.text(`**${hung.length}** of ${data.jobs.length} jobs hung`), k.dial('quiet'), { gap: 3 }),
  ...data.jobs.map(j => {
    const c = k.canvas(W, 1)
    c.fill(0, 0, W, 1, '─', 'unseen')
    for (const g of j.gaps) {
      const x = Math.min(W - 1, Math.floor(g.at / j.minutes * W))
      c.fill(x, 0, Math.max(1, Math.min(W - x, Math.round(g.min / j.minutes * W))), 1, '█', g.min >= t ? 'bad' : 'c4-faint')
    }
    const longest = Math.max(...j.gaps.map(g => g.min))
    return k.region('job-' + j.id, { label: `${j.id}: quiet for ${longest} min at most`, ref: j.ref },
      k.beside(k.text(j.id, { w: 10 }), c, k.text(longest >= t ? '{bad:hung}' : '{dim:ran}', { w: 5 }), { gap: 1 }))
  }),
)
