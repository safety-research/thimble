// A video: the film in a sandboxed frame, the current line under it as a caption with the spoken word marked, the
// controls, and the narration as a transcript with its citations.
// The frame has `allow-scripts` alone, so the film runs at an opaque origin with no access to the app, and its page
// carries the views' policy (backend video.film_document), so it reaches no host; the app's faces are inlined as a
// view's page has them. The film is drawn at 1280×720 and scaled to the column. It hears the time to draw through its
// bridge (backend film_bridge.js), which draws each time it is sent even before the film says ready, and playback is
// videoPlayer.ts. The voice, the rate and the captions switch are this browser's, kept in localStorage.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../components/Button'
import { Menu, type MenuItem } from '../components/Menu'
import { docsApi } from '../lib/api'
import { useFrameFonts, withFrameStyle } from '../lib/frame'
import { track } from '../lib/telemetry'
import type { VideoDoc } from '../lib/types'
import { readStorage, writeStorage } from '../lib/workspace'
import type { CheckLook, DocComment } from './checkComments'
import { EvidencePop, useEvidence } from './Evidence'
import { readableText } from './model'
import { Prose } from './Prose'
import { rankVoices, speech, VideoPlayer } from './videoPlayer'

const FILM_W = 1280
const FILM_H = 720
const RATES = [0.8, 0.9, 1, 1.1, 1.25, 1.5]
const VOICE_KEY = 'thimble:video-voice'
const RATE_KEY = 'thimble:video-rate'
const CAPTIONS_KEY = 'thimble:video-captions'
const P = 'thimble:'

/** m:ss */
const clock = (t: number): string => {
  const s = Math.max(0, Math.floor(t))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The page's language as a voice names it, such as en-US. */
function pageLang(): string {
  const doc = (document.documentElement.lang || 'en').toLowerCase()
  const nav = (navigator.language || '').toLowerCase()
  return nav.split('-')[0] === doc.split('-')[0] ? nav : doc
}

/** The words of a caption with where each starts in the text. */
function captionWords(text: string): { word: string; at: number }[] {
  return [...text.matchAll(/\S+/g)].map((m) => ({ word: m[0], at: m.index ?? 0 }))
}

/** The word being said: the one the voice last reached, else the one a share `frac` of the way through the line's
 * letters. */
function wordAt(words: readonly { word: string; at: number }[], said: number | null, frac: number): number {
  if (!words.length) return -1
  if (said != null) {
    let k = 0
    words.forEach((w, i) => {
      if (w.at <= said) k = i
    })
    return k
  }
  const total = words.reduce((n, w) => n + w.word.length, 0)
  let seen = 0
  for (let i = 0; i < words.length; i++) {
    seen += words[i].word.length
    if (seen >= frac * total) return i
  }
  return words.length - 1
}

/** The browser's voices worth offering, best first (rankVoices), read again when it announces more. */
function useVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => speech()?.getVoices() ?? [])
  useEffect(() => {
    const synth = speech()
    if (!synth) return
    const read = () => setVoices(synth.getVoices())
    read()
    synth.addEventListener('voiceschanged', read)
    return () => synth.removeEventListener('voiceschanged', read)
  }, [])
  return useMemo(() => rankVoices(voices, pageLang()), [voices])
}

export interface VideoViewProps {
  ws: string
  slug: string
  doc: VideoDoc | null
  /** the video's open comments, the checks that are on, how their checks are drawn, and the comment the Checks pane
   * picked */
  comments: readonly DocComment[]
  on: ReadonlySet<string>
  look: CheckLook
  picked: DocComment | null
}

export function VideoView({ ws, slug, doc, comments, on, look, picked }: VideoViewProps) {
  const timing = doc?.timing ?? null
  const lines = useMemo(() => doc?.lines ?? [], [doc])
  const windows = timing?.lines ?? []
  const duration = timing?.duration ?? 0

  // the film's page, read again when the film or the timing changes, then given the app's faces
  const timingKey = JSON.stringify(timing)
  const [page, setPage] = useState<string | null>(null)
  useEffect(() => {
    if (!doc?.film) return setPage(null)
    let live = true
    docsApi
      .film(ws, slug)
      .then((r) => live && setPage(r.html))
      .catch(() => live && setPage(null))
    return () => {
      live = false
    }
  }, [ws, slug, doc?.film, timingKey])
  const fonts = useFrameFonts()
  const shown = useMemo(() => (page != null && fonts != null ? withFrameStyle(page, `<style>${fonts}</style>`) : null), [page, fonts])

  // every time is sent to the frame; its page says ready once it has loaded, and is sent the time again then
  const frame = useRef<HTMLIFrameElement | null>(null)
  const post = useCallback((t: number) => frame.current?.contentWindow?.postMessage({ type: P + 'seek', t }, '*'), [])
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  // the word the voice last reached, by line
  const [said, setSaid] = useState<{ line: number; char: number } | null>(null)
  const player = useMemo(
    () => new VideoPlayer({ draw: (x) => (setT(x), post(x)), playing: setPlaying, word: (line, char) => setSaid(char == null ? null : { line, char }) }),
    [post],
  )
  useEffect(() => () => player.dispose(), [player])
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return
      const d = (e.data ?? {}) as { type?: string; message?: string }
      if (d.type === P + 'ready') post(player.t)
      else if (d.type === P + 'error') console.error(`the film of report:${slug}: ${d.message ?? ''}`)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [post, player, slug])

  const texts = useMemo(() => lines.map((l) => readableText((l.sentences ?? []).map((s) => s.text).join(' '))), [lines])
  // a document read again with the same script leaves playback as it is
  const script = JSON.stringify(texts)
  useEffect(() => player.load(timing, texts), [player, timingKey, script]) // eslint-disable-line react-hooks/exhaustive-deps

  // the voice and the rate
  const voices = useVoices()
  const [voiceUri, setVoiceUri] = useState<string>(() => readStorage<string>(VOICE_KEY, ''))
  const voice = useMemo(() => voices.find((v) => v.voiceURI === voiceUri) ?? voices[0] ?? null, [voices, voiceUri])
  const [rate, setRate] = useState<number>(() => readStorage<number>(RATE_KEY, 1))
  const [captions, setCaptions] = useState<boolean>(() => readStorage<boolean>(CAPTIONS_KEY, true))
  useEffect(() => {
    player.voice = voice
  }, [player, voice])
  useEffect(() => player.setRate(rate), [player, rate])
  const voiceItems: MenuItem[] = voices.map((v) => ({
    id: v.voiceURI,
    label: `${v.name} · ${v.lang}`,
    checked: v.voiceURI === voice?.voiceURI,
    onSelect: () => {
      setVoiceUri(v.voiceURI)
      writeStorage(VOICE_KEY, v.voiceURI)
      track('ui-click', { target: `report:${slug}`, detail: { action: 'video-voice', voice: v.name } })
    },
  }))
  const rateItems: MenuItem[] = RATES.map((r) => ({
    id: String(r),
    label: `${r}×`,
    checked: r === rate,
    onSelect: () => {
      setRate(r)
      writeStorage(RATE_KEY, r)
    },
  }))

  const now = player.lineAt(t)
  const caption = useMemo(() => captionWords(texts[now] ?? ''), [texts, now])
  const w = windows[now]
  const spoken = wordAt(caption, said?.line === now ? said.char : null, w && w.end > w.start ? Math.min(1, Math.max(0, (t - w.start) / (w.end - w.start))) : 0)
  const toggle = () => {
    if (playing) player.pause()
    else player.play()
    track('ui-click', { target: `report:${slug}`, detail: { action: playing ? 'video-pause' : 'video-play', at: Math.round(t) } })
  }
  const go = (i: number) => player.go(i)

  // the film scaled to the column's width
  const stage = useRef<HTMLDivElement | null>(null)
  const [scale, setScale] = useState(0)
  useLayoutEffect(() => {
    const el = stage.current
    if (!el) return
    const fit = () => setScale(el.clientWidth / FILM_W)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const ev = useEvidence(comments, on, look, picked)
  const transcript = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!picked) return
    transcript.current?.querySelector(`[data-sid="${CSS.escape(picked.sid)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [picked])
  const rows = useMemo(
    () =>
      lines.map((l, i) => (
        <div key={l.id} className={`wu-video-line${i === now ? ' now' : ''}`} data-line={l.id}>
          <button type="button" className="wu-video-at" onClick={() => go(i)}>
            {clock(windows[i]?.start ?? 0)}
          </button>
          <Prose ws={ws} slug={slug} sentences={l.sentences ?? []} flags={ev.flags} className="wu-video-say" />
        </div>
      )),
    [lines, windows, now, ws, slug, ev.flags], // eslint-disable-line react-hooks/exhaustive-deps
  )

  return (
    <div className="wu-view">
      <div className="wu-videodoc" data-video={slug}>
        <div className="wu-videodoc-col">
          <div className="wu-video-stage" ref={stage} style={{ height: FILM_H * scale }} onClick={toggle}>
            {shown != null && (
              <iframe
                ref={frame}
                className="wu-video-frame"
                sandbox="allow-scripts"
                srcDoc={shown}
                title={doc?.title || 'video'}
                tabIndex={-1}
                style={{ width: FILM_W, height: FILM_H, transform: `scale(${scale})` }}
              />
            )}
          </div>
          {captions && (
            <p className="wu-video-caption" aria-live="off">
              {caption.map((c, i) => (
                <span key={i} className={i === spoken ? 'now' : undefined}>
                  {i > 0 && ' '}
                  {c.word}
                </span>
              ))}
            </p>
          )}
          <div className="wu-video-controls">
            <Button variant="icon" icon="chevron-left" title="Previous line" disabled={!windows.length} onClick={() => go(now - 1)} />
            <Button variant="icon" icon={playing ? 'pause' : 'run'} title={playing ? 'Pause' : 'Play'} disabled={!windows.length} onClick={toggle} />
            <Button variant="icon" icon="chevron-right" title="Next line" disabled={!windows.length} onClick={() => go(now + 1)} />
            <div className="wu-video-scrub" role="group" aria-label="Lines">
              {windows.map((w, i) => {
                const until = windows[i + 1]?.start ?? duration
                const fill = until > w.start ? Math.min(1, Math.max(0, (t - w.start) / (until - w.start))) : 0
                return (
                  <button key={w.id || i} type="button" className={`wu-video-seg${i === now ? ' now' : ''}`} style={{ flexGrow: Math.max(0.1, until - w.start) }} aria-label={`Line ${i + 1}`} onClick={() => go(i)}>
                    <span className="wu-video-fill" style={{ width: `${fill * 100}%` }} />
                  </button>
                )
              })}
            </div>
            <span className="wu-video-time">
              {clock(t)} / {clock(duration)}
            </span>
            <Button
              size="sm"
              active={captions}
              title="Captions"
              onClick={() => {
                setCaptions(!captions)
                writeStorage(CAPTIONS_KEY, !captions)
              }}
            >
              CC
            </Button>
            <Menu
              trigger={
                <Button size="sm" disabled={!voices.length} className="wu-video-voice">
                  {voice?.name ?? 'Voice'}
                </Button>
              }
              items={voiceItems}
              align="end"
              label="Voice"
              width={320}
            />
            <Menu trigger={<Button size="sm">{`${rate}×`}</Button>} items={rateItems} align="end" label="Rate" />
          </div>
          <div className="wu-video-transcript" ref={transcript} onMouseOver={ev.onOver} onMouseLeave={ev.onLeave}>
            {doc?.title && <h1 className="wu-video-title">{doc.title}</h1>}
            {rows}
          </div>
        </div>
      </div>
      <EvidencePop comments={ev.hovered} look={look} />
    </div>
  )
}
