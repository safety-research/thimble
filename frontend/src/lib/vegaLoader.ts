// What Vega may fetch for a chart. A spec is written by a model or a kernel, and Vega loads the URLs it names, so a spec
// could leak corpus data to another host. The loader lets through only data: URLs, and any `usermeta.embedOptions`
// (a loader, config or patch URL) are dropped.

type Sanitizing = { sanitize: (uri: string, options?: any) => Promise<{ href: string }> }

/** `base` (vega.loader()) with every URL but a data: URL refused, for loading and for links alike. */
export function dataOnly<L extends Sanitizing>(base: L): L {
  return {
    ...base,
    sanitize(this: L, uri: string, options?: unknown) {
      if (typeof uri === 'string' && /^\s*data:/i.test(uri)) return base.sanitize.call(this, uri, options)
      return Promise.reject(new Error(`a chart loads no URL (${String(uri).slice(0, 80)}): its data goes in the spec`))
    },
  }
}

/** The spec without `usermeta.embedOptions`, which vega-embed would merge over the options thimble passes. */
export function withoutEmbedOptions(spec: unknown): unknown {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return spec
  const meta = (spec as { usermeta?: unknown }).usermeta
  if (!meta || typeof meta !== 'object' || !('embedOptions' in meta)) return spec
  const { embedOptions: _drop, ...rest } = meta as Record<string, unknown>
  return { ...(spec as Record<string, unknown>), usermeta: rest }
}
