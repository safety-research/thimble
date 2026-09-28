// A video: the film in a sandboxed frame, the controls under it, and the narration as a transcript with its citations.
// The frame has `allow-scripts` alone, so the film runs at an opaque origin with no access to the app, and its page
// carries the views' policy (backend video.film_document), so it reaches no host; the app's faces are inlined as a
// view's page has them. The film is drawn at 1280×720 and scaled to the column. It hears the time to draw through its
// bridge (backend film_bridge.js), and playback is videoPlayer.ts. The voice and the rate are this browser's, kept in
// localStorage.
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
import { speech, VideoPlayer } from './videoPlayer'

const FILM_W = 1280
const FILM_H = 720
const RATES = [0.8, 0.9, 1, 1.1, 1.25, 1.5]
const VOICE_KEY = 'thimble:video-voice'
const RATE_KEY = 'thimble:video-rate'
const P = 'thimble:'

/** m:ss */
const clock = (t: number): string => {
  const s = Math.max(0, Math.floor(t))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The browser's voices, read again when it announces more; those in the page's language first. */
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
  return useMemo(() => {
    const lang = (navigator.language || 'en').split('-')[0].toLowerCase()
    const mine = (v: SpeechSynthesisVoice) => (v.lang.toLowerCase().startsWith(lang) ? 0 : 1)
    return [...voices].sort((a, b) => mine(a) - mine(b) || a.name.localeCompare(b.name))
  }, [voices])
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

  // the frame takes the time once its film says ready, and each new page says ready again
  const frame = useRef<HTMLIFrameElement | null>(null)
  const ready = useRef(false)
  const post = useCallback((t: number) => {
    const w = frame.current?.contentWindow
    if (w && ready.current) w.postMessage({ type: P + 'seek', t }, '*')
  }, [])
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const player = useMemo(() => new VideoPlayer({ draw: (x) => (setT(x), post(x)), playing: setPlaying }), [post])
  useEffect(() => () => player.dispose(), [player])
  useLayoutEffect(() => {
    ready.current = false
  }, [shown])
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return
      const d = (e.data ?? {}) as { type?: string; message?: string }
      if (d.type === P + 'ready') {
        ready.current = true
        post(player.t)
      } else if (d.type === P + 'error') console.warn(`the film of report:${slug}: ${d.message ?? ''}`)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [post, player, slug])

  const texts = useMemo(() => lines.map((l) => readableText((l.sentences ?? []).map((s) => s.text).join(' '))), [lines])
  useEffect(() => player.load(timing, texts), [player, timingKey, texts]) // eslint-disable-line react-hooks/exhaustive-deps

  // the voice and the rate
  const voices = useVoices()
  const [voiceUri, setVoiceUri] = useState<string>(() => readStorage<string>(VOICE_KEY, ''))
  const voice = useMemo(() => voices.find((v) => v.voiceURI === voiceUri) ?? voices.find((v) => v.default) ?? voices[0] ?? null, [voices, voiceUri])
  const [rate, setRate] = useState<number>(() => readStorage<number>(RATE_KEY, 1))
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
  const toggle = () => {
    if (playing) player.pause()
    else player.play()
    track('ui-click', { target: `report:${slug}`, detail: { action: playing ? 'video-pause' : 'video-play', at: Math.round(t) } })
  }
  const go = (i: number) => player.go(i)

  // the film scaled to the column's width
  const stage = useRef<HTMLDivElement | null>(null)
  const [scale, setScale] = useState(0)
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const ro = new ResizeObserver(() => setScale(el.clientWidth / FILM_W))
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
            {shown != null && scale > 0 && (
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
