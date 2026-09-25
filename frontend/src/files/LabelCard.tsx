// A label's edit card beside the Labels pane: what it labels (records of files, canvas cards or report sentences), for
// a label over files what it marks (Span, Record or File) and its glob, the classifier (Prompt, Regex or Code) with its
// body, and the classes with colour and highlight switch. Colours and highlights save as they change; the rest is a
// draft that Re-run (Run for a new label) saves before applying the label (backend concepts.apply_route). Cancel, × or
// Escape drops the draft. LabelSheet is the same card in a popover on a canvas card (LabelFields, with each class's
// count); its draft outlasts the popover (canvas/labelDrafts) and its foot offers Discard and Regenerate Card.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Button, Segmented } from '../components/Button'
import { CodeArea } from '../components/Code'
import { TextArea, TextInput } from '../components/Field'
import { Icon } from '../components/Icon'
import { Menu } from '../components/Menu'
import { Switch } from '../components/Switch'
import { TipButton } from '../components/Tooltip'
import { labelApi } from '../lib/api'
import { bus } from '../lib/bus'
import { loadSettings, modelChoices, modelLabel } from '../lib/models'
import { track } from '../lib/telemetry'
import { hhmm } from '../lib/time'
import type { Concept, ConceptKind, ConceptPatch, ConceptRun, LabelClass, LabelDraft, LabelMarks } from '../lib/types'
import { classesOf, colourVar, draftClasses, isFilesLabel, isMultiClass, LABEL_COLOURS, MULTI_COLOUR, labelStatus, marksOf, nextColour, overOf, ownColour, progressText, unitOfOver, unitWord, type LabelOver } from './labels'
import { useFilesLabels, type FilesLabels } from './useLabels'

interface Props {
  ws: string
  /** the label, or null for a new one */
  label: Concept | null
  labels: FilesLabels
  /** what a new label applies to: the file open in the reader, or the files the view in front claims */
  appliesTo: string[]
  /** a new label's definition when the Label from prompt row drafted it, else a blank one */
  draft?: LabelDraft | null
  /** the row above the head, which then holds the card's × (a new label's Label from prompt, LabelPrompt) */
  lead?: ReactNode
  onClose: () => void
  /** an apply started for this label, with the run record the server answered (the Labels pane shows its progress) */
  onRun: (id: string, run: ConceptRun) => void
}

/** A label's definition as its edit card holds it while the analyst edits it. */
export interface Draft {
  name: string
  over: LabelOver
  marks: LabelMarks
  glob: string
  kind: ConceptKind
  body: string
  model: string
  classes: LabelClass[]
}

/** What a label labels, chosen when it is new, since its rows are of that unit. */
const OVER: { value: LabelOver; label: string; icon: 'files' | 'canvas' | 'report'; title?: string }[] = [
  { value: 'files', label: 'Files', icon: 'files' },
  { value: 'cards', label: 'Cards', icon: 'canvas' },
  { value: 'sentences', label: 'Sentences', icon: 'report', title: 'Report sentences' },
]

/** What a label over files marks. */
const MARKS: { value: LabelMarks; label: string; icon: 'span' | 'lines' | 'doc' }[] = [
  { value: 'span', label: 'Span', icon: 'span' },
  { value: 'record', label: 'Record', icon: 'lines' },
  { value: 'file', label: 'File', icon: 'doc' },
]

/** How a label decides a unit's value. */
const CLASSIFIERS: { value: ConceptKind; label: string; icon: 'sparkle' | 'regex' | 'code' }[] = [
  { value: 'prompt', label: 'Prompt', icon: 'sparkle' },
  { value: 'regex', label: 'Regex', icon: 'regex' },
  { value: 'code', label: 'Code', icon: 'code' },
]

/** The label's square in its first class's colour, or the label glyph in MULTI_COLOUR for a multi-class label. */
function LabelSwatch({ classes }: { classes: readonly LabelClass[] }) {
  if (isMultiClass(classes)) return <Icon name="label" size={13} className="label-card-tag" style={{ color: MULTI_COLOUR }} />
  return <span className="label-card-swatch" style={{ '--c': colourVar(classes[0]?.color) } as CSSProperties} />
}

/** The colour a new label takes: the first no label has, else the next in turn (the server's rule, fill_colours). */
export function nextFreeColour(labels: Concept[]): number {
  const used = new Set(labels.map((k) => classesOf(k)[0]?.color).filter((c): c is number => !!c))
  for (let n = 1; n <= LABEL_COLOURS; n++) if (!used.has(n)) return n
  return (labels.length % LABEL_COLOURS) + 1
}

export const draftOf = (k: Concept | null, appliesTo: string[], colour = 1, drafted: LabelDraft | null = null): Draft =>
  drafted && !k
    ? {
        name: drafted.name,
        over: drafted.over,
        marks: drafted.marks ?? 'span',
        glob: drafted.glob || appliesTo.join(', ') || '*',
        kind: drafted.kind,
        body: drafted.text,
        model: '',
        classes: draftClasses(drafted.values, colour),
      }
    : k
    ? {
        name: k.name,
        over: overOf(k),
        marks: isFilesLabel(k) ? marksOf(k) : 'span',
        glob: k.glob ?? '',
        kind: k.kind,
        body: k.kind === 'prompt' ? k.spec || k.description : k.spec,
        model: k.model ?? '',
        classes: classesOf(k),
      }
    : {
        name: '',
        over: 'files',
        marks: 'span',
        glob: appliesTo.join(', ') || '*',
        kind: 'prompt',
        body: '',
        model: '',
        classes: [
          { name: 'match', color: colour, highlight: true },
          { name: 'no match', color: 0, highlight: false },
        ],
      }

/** A draft's classes with the colour and highlight the label has saved for each (they are saved as they change); a new
 * label's are the draft's own. */
export function withSavedColours(label: Concept | null, draft: Draft): LabelClass[] {
  const live = new Map((label ? classesOf(label) : draft.classes).map((c) => [c.name, c]))
  return draft.classes.map((c) => {
    const got = live.get(c.name)
    return got ? { ...c, color: got.color, highlight: got.highlight } : c
  })
}

/** Why a draft cannot run ('' when it can): a label needs a name, a classifier body and two classes. */
export function draftProblem(draft: Draft, classes: LabelClass[]): string {
  if (!draft.name.trim()) return 'The label needs a name.'
  if (classes.map((c) => c.name.trim()).filter(Boolean).length < 2) return 'The label needs two classes.'
  if (!draft.body.trim()) return 'The classifier is empty.'
  return ''
}

/** What a draft saves (PUT /concepts/{id}, or with the unit POST /concepts for a new label). */
export function patchOf(draft: Draft, classes: LabelClass[]): ConceptPatch {
  return {
    name: draft.name.trim(),
    // what a label over files marks and applies to; a label over cards or sentences has neither (the server refuses marks)
    ...(draft.over === 'files' ? { marks: draft.marks, glob: draft.glob } : {}),
    kind: draft.kind,
    model: draft.kind === 'prompt' ? draft.model : '',
    classes: classes.filter((c) => c.name.trim()).map((c) => ({ name: c.name.trim(), color: c.color, highlight: c.highlight })),
    ...(draft.kind === 'prompt' ? { description: draft.body, spec: '' } : { spec: draft.body }),
  }
}

/** A draft's definition, the fields an edit changes (not its name, colours or highlights), as one comparable string. */
const definitionOf = (d: Draft): string => JSON.stringify([d.over, d.marks, d.glob, d.kind, d.body, d.model, d.classes.map((c) => c.name)])

const BODY_WORD: Record<ConceptKind, string> = { prompt: 'its prompt', regex: 'its pattern', code: 'its code' }

/**
 * What a draft changes in label `k`'s definition, each in words, for the hover of the label's red tag on a card; [] when
 * nothing. The name, colours and highlights are not edits. Pure.
 */
export function editsOf(k: Concept, d: Draft): string[] {
  const was = draftOf(k, [])
  const out: string[] = []
  const names = (cs: LabelClass[]) => cs.map((c) => c.name.trim()).filter(Boolean)
  if (names(d.classes).join('\n') !== names(was.classes).join('\n')) out.push(`its values now ${names(d.classes).join(', ')}`)
  if (d.kind !== was.kind) out.push(`its classifier now ${CLASSIFIERS.find((c) => c.value === d.kind)?.label ?? d.kind}`)
  if (d.body.trim() !== was.body.trim()) out.push(BODY_WORD[d.kind])
  if (d.kind === 'prompt' && d.model !== was.model) out.push('its model')
  if (d.over === 'files' && d.marks !== was.marks) out.push('what it marks')
  if (d.over === 'files' && d.glob.trim() !== was.glob.trim()) out.push('what it applies to')
  return out
}

export function LabelCard({ ws, label, labels, appliesTo, draft: drafted = null, lead, onClose, onRun }: Props) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(label, appliesTo, nextFreeColour(labels.all), drafted))
  const [saving, setSaving] = useState(false)
  const isNew = label == null
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))
  const classes = withSavedColours(label, draft)

  useEffect(() => {
    setDraft(draftOf(label, appliesTo, nextFreeColour(labels.all), drafted))
    // a different label (or a new one, or another drafted one) starts a fresh draft; the same label's live changes leave
    // the draft alone
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label?.id, drafted])

  const run = async () => {
    const problem = draftProblem(draft, classes)
    if (problem) {
      bus.emit('toast', { text: problem, kind: 'error' })
      return
    }
    const files = draft.over === 'files'
    const patch = patchOf(draft, classes)
    setSaving(true)
    try {
      const k = isNew ? await labelApi.create(ws, { ...patch, name: patch.name!, unit: unitOfOver(draft.over, draft.marks), shown: files }) : await labels.save(label!.id, patch)
      track('label-apply', { target: `concept:${k.id}`, detail: { over: draft.over, marks: files ? draft.marks : null, kind: draft.kind, created: isNew } })
      onRun(k.id, await labelApi.apply(ws, k.id, {}))
      onClose()
    } catch (e) {
      bus.emit('toast', { text: `Could not run ${patch.name}. ${(e as Error).message}`, kind: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="label-card overlay"
      role="dialog"
      aria-label={isNew ? 'New label' : `Edit ${label!.name}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      {lead && (
        <div className="label-card-lead">
          {lead}
          <Button variant="icon" size="sm" icon="x" title="Close" aria-label="Close" onClick={onClose} />
        </div>
      )}
      <div className="label-card-head">
        <LabelSwatch classes={classes} />
        <TextInput bare value={draft.name} onChange={(v) => set({ name: v })} aria-label="Name" className="label-card-name" autoFocus={isNew && !lead} />
        {!lead && <Button variant="icon" size="sm" icon="x" title="Close" aria-label="Close" onClick={onClose} />}
      </div>
      <LabelFields ws={ws} label={label} labels={labels} draft={draft} classes={classes} set={set} />
      <div className="label-card-foot">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={saving} onClick={() => void run()}>
          {isNew ? 'Run' : 'Re-run'}
        </Button>
      </div>
    </div>
  )
}

/** The fields of a label's edit card under its head, shared by LabelCard and LabelSheet. Colours and highlight
 * switches are saved at once for an existing label. `counts` puts each class's count before its switch. */
function LabelFields({ ws, label, labels, draft, classes, set, counts }: { ws: string; label: Concept | null; labels: FilesLabels; draft: Draft; classes: LabelClass[]; set: (patch: Partial<Draft>) => void; counts?: Record<string, number> }) {
  const [scopeOpen, setScopeOpen] = useState(false)
  const [scope, setScope] = useState<{ files: string[]; total: number } | null>(null)
  const [models, setModels] = useState<{ choices: string[]; role: string }>({ choices: [], role: '' })
  const isNew = label == null
  const liveClasses = label ? classesOf(label) : draft.classes

  useEffect(() => {
    setScopeOpen(false)
  }, [label?.id])

  useEffect(() => {
    let alive = true
    loadSettings(ws)
      .then((s) => alive && setModels({ choices: modelChoices(s, draft.model || null), role: String(s.models?.labels?.model ?? '') }))
      .catch(() => undefined)
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws])

  // the files the glob applies to, read when the list is opened and as the glob changes
  useEffect(() => {
    if (!scopeOpen && scope) return
    let alive = true
    const t = window.setTimeout(() => {
      labelApi
        .glob(ws, draft.glob)
        .then((r) => alive && setScope(r))
        .catch(() => alive && setScope({ files: [], total: 0 }))
    }, 200)
    return () => {
      alive = false
      window.clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, draft.glob, scopeOpen])

  const covered = label ? labels.presence.get(label.id) : undefined
  const setClass = (i: number, patch: Partial<LabelClass>) => {
    const next = classes.map((c, j) => (j === i ? { ...c, ...patch } : c))
    set({ classes: next })
    // a colour or a highlight is saved at once for a label that exists, as the Labels pane's toggles are
    if (label && ('color' in patch || 'highlight' in patch) && next.length === liveClasses.length && next.every((c, j) => c.name === liveClasses[j].name))
      labels.setClasses(label.id, next)
  }
  const addClass = () => set({ classes: [...classes, { name: '', color: ownColour((((classes[0]?.color || 1) - 1 + classes.length) % LABEL_COLOURS) + 1, classes.map((x) => x.color)), highlight: true }] })
  const dropClass = (i: number) => set({ classes: classes.filter((_, j) => j !== i) })
  const saved = new Set(liveClasses.map((c) => c.name))

  const modelShown = draft.model || models.role
  const modelItems = useMemo(
    () =>
      (models.choices.length ? models.choices : [modelShown].filter(Boolean)).map((m) => ({
        id: m,
        label: modelLabel(m),
        note: <span className="mono">{m}</span>,
        checked: m === modelShown,
        onSelect: () => set({ model: m === models.role ? '' : m }),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [models, modelShown],
  )

  return (
    <>
      <div className="label-card-grid">
        <span className="label-card-key">Over</span>
        <Segmented
          label="Over"
          size="sm"
          track
          value={draft.over}
          onChange={(v) => set({ over: v })}
          options={OVER.map((o) => ({ ...o, disabled: !isNew && o.value !== draft.over }))}
        />
        {draft.over === 'files' && (
          <>
            <span className="label-card-key">Marks</span>
            <Segmented
              label="Marks"
              size="sm"
              track
              value={draft.marks}
              onChange={(v) => set({ marks: v })}
              options={MARKS}
            />
            <span className="label-card-key">Applies to</span>
            <span className="label-card-scope">
              <TextInput mono value={draft.glob} onChange={(v) => set({ glob: v })} aria-label="Applies to" className="label-card-glob" spellCheck={false} />
              <button type="button" className="label-card-files" aria-expanded={scopeOpen} onClick={() => setScopeOpen((o) => !o)}>
                {scope ? `${scope.total.toLocaleString()} ${scope.total === 1 ? 'file' : 'files'}` : 'files'}
                <Icon name={scopeOpen ? 'chevron-down' : 'chevron-right'} size={12} />
              </button>
            </span>
            {scopeOpen && scope && (
              <>
                <span />
                <span className="label-card-filelist">
                  {scope.files.map((f) => (
                    <span key={f} className="label-card-file">
                      <span className="label-card-filedot" style={covered?.[f] ? ({ '--c': isMultiClass(classes) ? MULTI_COLOUR : colourVar(classes[0]?.color) } as CSSProperties) : undefined} />
                      {f}
                    </span>
                  ))}
                  {scope.total > scope.files.length && <span className="label-card-file">+{(scope.total - scope.files.length).toLocaleString()}</span>}
                </span>
              </>
            )}
          </>
        )}
        <span className="label-card-key">Classifier</span>
        <Segmented
          label="Classifier"
          size="sm"
          track
          value={draft.kind}
          onChange={(v) => set({ kind: v })}
          options={CLASSIFIERS}
        />
        {draft.kind === 'prompt' && (
          <>
            <span className="label-card-key">Model</span>
            <Menu
              label="Model"
              items={modelItems}
              trigger={
                <button type="button" className="label-card-model">
                  {modelShown ? modelLabel(modelShown) : 'model'}
                  <Icon name="chevron-down" size={12} />
                </button>
              }
            />
          </>
        )}
      </div>
      <div className="label-card-body">
        {draft.kind === 'code' ? (
          // the code kind's `label(unit)` runs in a Python kernel, and is coloured as Python as it is typed
          <CodeArea lang="python" block autoGrow maxHeight={180} rows={4} mono spellCheck={false} value={draft.body} onChange={(v) => set({ body: v })} aria-label="Code" className="label-card-text" />
        ) : (
          <TextArea
            block
            autoGrow
            maxHeight={180}
            rows={2}
            mono={draft.kind !== 'prompt'}
            spellCheck={draft.kind === 'prompt'}
            value={draft.body}
            onChange={(v) => set({ body: v })}
            aria-label={draft.kind === 'prompt' ? 'Prompt' : 'Pattern'}
            className="label-card-text"
          />
        )}
      </div>
      <div className="label-card-classes">
        <div className="label-card-classes-head">
          <span className="label-card-key">Classes</span>
          <span className="label-card-hl">highlight</span>
        </div>
        {classes.map((c, i) => (
          <div key={i} className="label-card-class">
            <TipButton tip="Change colour" className="label-card-colour" aria-label={`Change the colour of ${c.name || 'the class'}`} style={{ '--c': colourVar(c.color) } as CSSProperties} onClick={() => setClass(i, { color: nextColour(c.color, classes.filter((_, j) => j !== i).map((x) => x.color)) })} />
            <TextInput bare mono value={c.name} onChange={(v) => setClass(i, { name: v })} aria-label="Class name" className="label-card-classname" autoFocus={!c.name && i >= 2} />
            {classes.length > 2 && <Button variant="icon" size="sm" icon="x" title="Remove" aria-label={`Remove ${c.name || 'the class'}`} className="label-card-drop" onClick={() => dropClass(i)} />}
            {counts?.[c.name] != null && saved.has(c.name) && <span className="label-sheet-count">{counts[c.name].toLocaleString()}</span>}
            <Switch checked={c.highlight} onChange={(v) => setClass(i, { highlight: v })} label={`Highlight ${c.name}`} />
          </div>
        ))}
        <Button size="sm" icon="plus" className="label-card-add" onClick={addClass}>
          class
        </Button>
      </div>
    </>
  )
}

/**
 * A label's edit card in a popover on a canvas card: its colour and name, its fields (LabelFields) with class counts, and
 * the last run. `draft` holds the unrun edits, owned by the caller so they outlast the popover; `onDraft` hands back each
 * edit, null once it matches the label again. With a draft the foot is Discard and `regenerate`; without, Review
 * records (with `onReview`), Open in Files and `regenerate` when given.
 */
export function LabelSheet({ ws, label, draft, onDraft, onClose, onOpen, onReview, regenerate }: { ws: string; label: Concept; draft: Draft | null; onDraft: (d: Draft | null) => void; onClose: () => void; onOpen: () => void; onReview?: () => void; regenerate?: ReactNode }) {
  const labels = useFilesLabels(ws)
  // the label as Files shows it, a colour just picked included, else as the canvas has it
  const k = labels.byId.get(label.id) ?? label
  const shown = draft ?? draftOf(k, [])
  const classes = withSavedColours(k, shown)
  // a draft back at the label's definition is dropped. The draft is read at the call, since a handler kept from an
  // earlier render (the Model menu's items) would otherwise undo later edits
  const current = useRef({ shown, k })
  current.current = { shown, k }
  const set = (patch: Partial<Draft>) => {
    const { shown: now, k: label } = current.current
    const next = { ...now, ...patch }
    onDraft(definitionOf(next) === definitionOf(draftOf(label, [])) ? null : next)
  }
  const status = labelStatus(k)
  const counted = status?.state === 'done' ? `${status.total.toLocaleString()} ${unitWord(status.unit, status.total)}` : status?.state === 'running' ? progressText(status) : ''
  return (
    <div className="label-sheet">
      <div className="label-card-head">
        <LabelSwatch classes={classes} />
        <span className="label-sheet-name">{k.name}</span>
        {counted && (
          <span className="label-card-hl">
            {counted}
            {status?.state === 'done' && status.ts ? ` · ${hhmm(status.ts)}` : ''}
          </span>
        )}
        <Button variant="icon" size="sm" icon="x" title="Close" aria-label="Close" onClick={onClose} />
      </div>
      <LabelFields ws={ws} label={k} labels={labels} draft={shown} classes={classes} set={set} counts={k.counts} />
      <div className="label-card-foot">
        {draft ? (
          <Button onClick={() => onDraft(null)}>Discard</Button>
        ) : (
          <span className="label-sheet-links">
            {onReview && (
              <button type="button" className="label-card-files" onClick={onReview}>
                Review records
              </button>
            )}
            <button type="button" className="label-card-files" onClick={onOpen}>
              Open in Files
              <Icon name="arrow-up-right" size={12} />
            </button>
          </span>
        )}
        {regenerate}
      </div>
    </div>
  )
}
