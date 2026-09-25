// A ref to an image, audio or video file of the corpus, which an example card shows as media: `reports/figures/a.png`,
// or `recordings/demo.mp4#t=30:55` (`#t=30:55,31:10` for a stretch). The file comes from the card media route (backend
// views.card_media_route), which answers range requests so a player can seek. The suffixes are backend
// views.MEDIA_TYPES, less the ones no browser plays. Pure but for the URL.

const KINDS: Record<string, 'image' | 'audio' | 'video'> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  bmp: 'image',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  aac: 'audio',
  oga: 'audio',
  ogg: 'audio',
  opus: 'audio',
  flac: 'audio',
  weba: 'audio',
  mp4: 'video',
  m4v: 'video',
  mov: 'video',
  webm: 'video',
  ogv: 'video',
}

export interface MediaRef {
  kind: 'image' | 'audio' | 'video'
  path: string
  /** seconds into a recording, from `#t=` */
  start?: number
  end?: number
}

/** `1855`, `30:55` or `1:02:03` as seconds; null for anything else. */
export function seconds(text: string): number | null {
  const parts = text.split(':')
  if (parts.length < 1 || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null
  return parts.reduce((total, p) => total * 60 + Number(p), 0)
}

/** What a ref shows when it names a media file of the corpus, else null (a record, a card, any other file). */
export function mediaOf(ref: string): MediaRef | null {
  const [path, locator] = ref.trim().split('#', 2)
  if (!path || path.includes(':')) return null
  const kind = KINDS[(path.split('.').pop() ?? '').toLowerCase()]
  if (!kind) return null
  const out: MediaRef = { kind, path }
  const m = /^t=([0-9:.]+)(?:,([0-9:.]+))?$/.exec(locator ?? '')
  if (m && kind !== 'image') {
    const start = seconds(m[1])
    const end = m[2] ? seconds(m[2]) : null
    if (start != null) out.start = start
    if (start != null && end != null && end > start) out.end = end
  }
  return out
}

/** The URL an <img>, <audio> or <video> loads the file from, with the media fragment that starts it at its moment. */
export function mediaUrl(ws: string, m: MediaRef): string {
  const url = `/api/ws/${encodeURIComponent(ws)}/media?path=${encodeURIComponent(m.path)}`
  if (m.start == null) return url
  return `${url}#t=${m.start}${m.end != null ? `,${m.end}` : ''}`
}
