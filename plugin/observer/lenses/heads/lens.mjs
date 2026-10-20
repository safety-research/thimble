// The heads-up lens: at most one important detail of the answer that the analyst should know before they rely on it (a
// caveat said in passing, a surprising fact, a limit of the scope, a correction), as an orange mark on its words that
// opens a short card: a title, two to four points with citations, one line on what to do. Its digest is the heads-ups
// the analyst already saw. Its merge hands the one it gives to the observer, which places it by its words in the
// answer's record beside the explainers (shell/message.js headsOf).
const bullets = xs => (xs.length ? xs.map(x => `- ${x}`).join('\n') : '(none)')

export default {
  name: 'heads',
  feature: 'lens-heads',
  skeleton: '"heads": null',
  read: reply => (reply && reply.heads && typeof reply.heads === 'object' && !Array.isArray(reply.heads) ? reply.heads : null),
  raw: d => d?.heads,
  digest: st => ({ HEADS: bullets((st.headsGiven || []).slice(-20)) }),
  when: () => [],
  async merge(item, ctx) {
    ctx.heads = item || null
  },
}
