// The claims lens of the observer's pass: the turn's statements, each placed by a quote and given a cluster, each
// statement said again by its id, each correction with the id it revises, and the renames and splits of grown
// clusters. Its fragment is the registry's lens-claims; its digest is every claim so far and the clusters; its merge
// hands the claims to the observer, which places them in the session's store (claims/term.ts, store.js applyTurn),
// where the turn's messages are known.
import { claimless, grownLines, promptLines } from './store.js'

export default {
  name: 'claims',
  feature: 'lens-claims',
  skeleton: '"claims": []',
  read: reply => ({ claims: Array.isArray(reply?.claims) ? reply.claims : [], clusters: Array.isArray(reply?.clusters) ? reply.clusters : [] }),
  raw: d => (d ? { claims: d.claims, clusters: d.clusters } : null),
  // every claim so far, one compact line each, and the clusters: the model judges a repeat, a correction and a cluster
  // against the whole session (store.js applyTurn keeps a near-duplicate check of its own)
  digest: st => {
    if (!st.store) return { CLAIMS: '(none yet)', CLUSTERS: '(none yet)', GROWN: '' }
    const lines = promptLines(st.store, Infinity)
    const grown = st.grown || []
    return { CLAIMS: lines.claims, CLUSTERS: lines.clusters, GROWN: grown.length ? `\nGrown clusters, which you can rename or split:\n${grownLines(grown)}\n` : '' }
  },
  // a turn whose words state nothing that could be true or false: the fragment's `quiet` rule says to give none
  when: st => (st.turnText != null && claimless(st.turnText) ? ['quiet'] : []),
  async merge(value, ctx) {
    if (ctx.claims) await ctx.claims(value)
  },
}
