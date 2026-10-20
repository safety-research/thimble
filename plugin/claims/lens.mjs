// The claims lens of the observer's pass: the turn's claims with what each leaves open (precisely, unstated,
// judgment, based on), each claim said again by its id, each correction with the id it revises, and the renames of
// grown clusters. Its fragment is the registry's lens-claims; its digest is the claims so far that bear on the turn
// and the clusters; its merge hands the claims to the observer, which places them in the session's store
// (claims/term.ts, store.js applyTurn), where the turn's messages are known.
import { claimless, grownLines, nearLines } from './store.js'

export default {
  name: 'claims',
  feature: 'lens-claims',
  skeleton: '"claims": []',
  read: reply => ({ claims: Array.isArray(reply?.claims) ? reply.claims : [], clusters: Array.isArray(reply?.clusters) ? reply.clusters : [] }),
  raw: d => (d ? { claims: d.claims, clusters: d.clusters } : null),
  // the claims so far that bear on this turn, so the digest stays about the same size as the session grows
  digest: st => {
    if (!st.store) return { NEAR: '(none yet)', LEFT_OUT: '', CLUSTERS: '(none yet)', GROWN: '' }
    const near = nearLines(st.store, st.turnText || '')
    const grown = st.grown || []
    return {
      NEAR: near.claims, LEFT_OUT: near.left ? `; ${near.left} older claims that share no words with it are left out` : '',
      CLUSTERS: near.clusters, GROWN: grown.length ? `\nGrown clusters, which you can rename or split:\n${grownLines(grown)}\n` : '',
    }
  },
  // a turn whose words state nothing that could be true or false: the fragment's `quiet` rule says to give none
  when: st => (st.turnText != null && claimless(st.turnText) ? ['quiet'] : []),
  async merge(value, ctx) {
    if (ctx.claims) await ctx.claims(value)
  },
}
