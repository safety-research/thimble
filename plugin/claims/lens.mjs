// lens.mjs: the claims lens of the observer's look (observer/lenses.mjs). Pure. The turn's statements, each placed by a
// quote and given a cluster, each statement said again by its id, each correction with the id it revises, and the
// renames and splits of grown clusters. Its digest is every claim so far and the clusters, as claims/seam.ts
// claimsState gives them (st.claims: {CLAIMS, CLUSTERS, GROWN}, lines of 0.10's claims/store.js promptLines and
// grownLines); what it gives is placed by claims/seam.ts claimsMerge.
export default {
  name: 'claims',
  feature: 'lens-claims',
  option: 'claims',
  skeleton: '"claims": []',
  read: reply => ({ claims: Array.isArray(reply?.claims) ? reply.claims : [], clusters: Array.isArray(reply?.clusters) ? reply.clusters : [] }),
  raw: d => (d ? { claims: d.claims, clusters: d.clusters } : null),
  digest: st => ({ CLAIMS: '(none yet)', CLUSTERS: '(none yet)', GROWN: '', ...((st && st.claims) || {}) }),
  // whether a turn holds a claim is the lens's own judgment (a plan, a step or a question holds none): no rule of code's
  when: () => [],
}
