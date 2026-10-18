// The line lens: at most one line above the person's prompt, only at a decision they stated, and whether the line now
// open is settled. Its digest is what the person saw, marked as known, and the line open now; its rules say when no
// line may come (one is open; the person typed past the last ones). Its merge keeps the quiet mechanism: a line that
// names no decision, comes while one is open, during a backoff, repeats one, or comes after a new turn began goes to
// Claude as a note instead (a repeat goes nowhere).
const bullets = xs => (xs.length ? xs.map(x => `- ${x}`).join('\n') : '(none)')

export default {
  name: 'line',
  feature: 'lens-line',
  skeleton: '"line": null, "settled": false',
  read: reply => ({ line: reply?.line ?? null, settled: reply?.settled === true }),
  raw: d => (d ? { line: d.line ?? null, settled: d.settled ?? false } : null),
  digest: st => ({
    SEEN: bullets((st.seen || []).slice(-50)),
    KNOWN: bullets(st.known || []),
    OPEN: st.open ? `"${st.open.line}" (shown ${st.open.prompts} prompt${st.open.prompts === 1 ? '' : 's'} ago)` : '(none)',
  }),
  when: st => (st.open ? ['open'] : st.skips > 0 ? ['backoff'] : []),
  async merge({ line, settled }, ctx) {
    if (ctx.open && settled) await ctx.settle()
    if (!line) return
    let why = ''
    if (!line.decision) why = 'it names no decision'
    else if (await ctx.lineOpenNow()) why = 'a line is open'
    else if (ctx.skips > 0) why = 'backoff'
    else if (ctx.isRepeat(line.line, [...ctx.seen, ...ctx.known])) why = 'repeat'
    else if (ctx.moved) why = 'stale: a new turn began'
    if (!why) { await ctx.showLine(line); return }
    ctx.log('line_dropped', { line: line.line, why })
    // a finding that cannot be a line still reaches Claude; one the person saw or knows goes nowhere
    if (why !== 'repeat') ctx.note({ from: 'line', note: `${line.line}${line.explanation ? ' ' + line.explanation.replace(/\n+/g, ' ') : ''}`, ...(line.rests_on ? { rests_on: line.rests_on } : {}) })
  },
}
