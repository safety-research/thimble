# Timeline

thimble's worked example of a view that puts several systems' exports on one time axis (plugin/viewers/timeline): a
ferry operator's alerts, deploys, chat, support tickets and automated agents' actions over four days. sample/
and labels.json are thimble's; reader.py is thimble's with the `rows` query added; view.json is the terminal spec
(views/SPEC.md) and rows.json the runner's output on the sample. This file says what thimble's HTML view shows and how the
terminal view draws each part of it.

## The data and the reader on its sample

`python3 helper/viewhost.py viewers/timeline shown --root viewers/timeline/sample`

| | |
|---|---|
| claimed files (`agents.log`, `alerts/*.jsonl`, `chat/*.json`, `deploys.csv`, `tickets/*.txt`, `tickets/index.csv`) | 39, 36,537 bytes, every one read to the end |
| problems | 1 unreadable line: `agents.log#L38`, not a log line of time, level, agent and key=value pairs (the torn last line) |
| hidden files | none |
| derived fields declared in view.json | 21: the events' 14 (time, day, clock, source, kind, actor, service, severity, outcome, incident, thread, answers, took, into) and the incidents' 7 |
| events | 198, from 16 May 01:40 to 19 May 14:00 UTC |
| events per day | 16 May 131, 17 May 20, 18 May 37, 19 May 10 |
| by source | ticket 63, chat 44, agent 37, alert 34, deploy 20 |
| by incident | INC-312 100, INC-313 23, INC-311 11, none 64 |
| by service | payments 79, web 45, passes 16, bookings-db 6, none 52 |
| by severity | warning 28, high 25, normal 17, urgent 15, critical 6, none 107 |
| by outcome | ok 44, held 2, failed 1, none 151 |
| events that answer another (`answers`) | 96 |
| incidents (units) and their first events | INC-311 16 May 02:57, INC-312 16 May 07:41, INC-313 18 May 06:48 |
| labels on (Database connections, Charged twice) | connections 22, charged twice 12, no label 164 |
| label filter Charged twice | 12 events |

The index builds in about 30 ms. The first overview page holds all 198 rows (a page holds up to 5,000).

## What thimble's HTML view shows

- **Control row.** Days (one day, a range, or all), a search box, Incident and Source dropdowns, More filters (actor,
  kind, service, severity, outcome, and "took to answer" as a range of minutes), the chosen values as removable chips,
  and the Colour control: colour the marks by a field or by the labels that are on, with a legend where a click shows a
  value alone and a shift-click hides it. Above the view thimble draws `39 files · 1 line could not be read`.
- **Strip (overview).** The whole span of the picked days as stacked bins in the marks' colours. A drag on it picks a
  window; a drag inside the window moves it; a double click lets it go.
- **Lanes (zoom).** One lane per value of the Lanes field (source by default; also incident, service, actor, kind,
  severity, outcome), the window's events as ticks in their colours, the count beside each lane. While an event is
  open, the event it answers and the events that answer it are joined to it by lines.
- **List.** A table of the window's events grouped by day (`Sat 16 May · 131 events`): TIME, SOURCE, KIND, ACTOR,
  INCIDENT, TEXT. "Show 300 more" pages it.
- **An open event (details).** A click opens the event in place: its text, then the facts (time in UTC, source, kind,
  actor, service, severity, outcome, incident, id, took) or Raw, the lines as the file holds them with their line
  numbers and a file chip. Under it "Answers" (the event it answers) and "Answered by" (the events that answer it),
  each a row that opens that event.
- **Labels.** List rows and the open event carry their file ref, so thimble marks them; the Colour menu turns labels on
  and off (the analyst only) and colours the strip and lanes by their values.

## The terminal view

`records(index, {"op": "rows"})` gives 198 `events`, keyed by ref, and 3 `incidents`, each with its events' `refs` so a
label marks the incident when it marks one of them. The reader's thimble queries are unchanged; `rows` adds the fields
the panel needs that thimble's page computes in the browser: `day` and `clock` (the list's day groups and times),
`thread`, `answers` as the answered event's ref (a link the panel follows) and `into`, the time since the incident's
first event (thimble's "From incident start" clock).

| thimble's page | view.json |
|---|---|
| Overview: the whole-span strip and the lanes by source | Events: a `histogram` of every event by time, coloured by source, over `lanes` by source. The strip stands on the lanes' axis, so a tick sits under its bin |
| Zoom: a drag on the strip picks a window | a click on the strip halves the window around it; the lanes redraw the window and the table keeps its events, and the strip dims what is outside it |
| Group by Incident, "From incident start" | Incidents: `lanes` of each incident's span (from its first to its last event), its events coloured by source and counted beside it, over its events grouped by incident, timed from the incident's start |
| Filter: days, search, Incident, Source, More (actor, kind, service, severity, outcome) | `filter.fields` day, incident, source, thread, actor, kind, service, severity, outcome, each counted under the others; search over the text, actor and id; the labels, turned on only by the analyst |
| The list: events by day, TIME SOURCE KIND ACTOR INCIDENT TEXT | a `table` of those columns grouped by `day`, the time of day in `clock` |
| A failed outcome's error icon | `outcome` flags `failed`: red in the detail, `×` at its row's left edge and in the lanes |
| Details: text, facts, Answers, Answered by | the `events` detail: source, kind, actor and service; time, incident (a link to its unit), severity, outcome, answers (a link to the answered event), took to answer, into incident, thread, id; the text whole; the events that answer it, each opening that event |
| An incident (`view:timeline/INC-312`) | the `incidents` detail: first and last event, span, events, the event that opened it (a link), sources, services, and every event |
| `39 files · 1 line could not be read` | the header's "1 unreadable line" (`agents.log#L38`, the torn last line) and "39 files ▸", which lists the 21 fields the reader made |

Drawn at 96 columns, as it opens (`node tools/render_view.mjs --spec viewers/timeline/view.json --rows
viewers/timeline/rows.json --plain --width 96 --height 40`):

```
Timeline  198 events · 5 sources · 3 incidents                     1 unreadable line  39 files ▸
 Events   Incidents
⌕ search   filter ▸ day · incident · source · thread · actor · kind · service · +3    198 events
────────────────────────────────────────────────────────────────────────────────────────────────
        60 ┤       █
         0 ┤ ▂▂▂▂▂▂█▅▃▃▂▂▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▂▁▂▂▂▂▂▂▂▁▂▁▂▂▁▁▂▁▁▁▁▁▁▁▂▅▂▂▂▂▂▁▂▂▁▂▂▁▂▁▁▁▁▁▁▁▁▁▂▂▁▂▂▂▁▂
             16 May 01:40                       17 May 19:50                        19 May 14:00
             ● ticket 63  ● chat 44  ● agent 37  ● alert 34  ● deploy 20

● ticket  63  ●  ●◆◆◆●◆●●                 ●  ●●      ●           ◆●  ●●       ●            ●
● chat    44 ●●  ●●◆◆◆●● ●               ●  ●   ●   ●   ●       ●◆ ●      ● ●          ●  ●    ●
● agent   37  ◆●  ●×◆● ●                   ●                    ●◆ ●●                        ●
● alert   34  ◆●●  ◆◆●● ●                  ●      ●              ◆      ●                    ●
● deploy  20 ◆●     ●◆◆                         ●                ●    ●                  ●
             └──────────────────────────────────────────────────────────────────────────────────
             × failed 1

    time      source  kind      actor           incident  text
▾ Sat 16 May  131
  ● 01:40:12  chat    message   Oona                      Tonight's release train: web 2.31.0 a…
  ● 02:00:05  deploy  started   deploybot                 web 2.31.0: new seat map on the booki…
  ● 02:04:40  deploy  finished  deploybot                 web 2.31.0 live on 3 of 3 replicas
  ● 02:06:02  deploy  started   deploybot                 payments 4.12.0: connection pool rewo…
  ● 02:11:31  deploy  finished  deploybot                 payments 4.12.0 live on 3 of 3 replic…
```

Not drawn: lines from an open event to the event it answers and those that answer it (the detail lists both), the
colour menu (each tab colours one field, labels when they are on), a day picker (the day filter does it), and the raw
lines beside the fields (`↗` opens the line in the citation panel).

## Reader queries thimble's page uses

| op | query | answer used for |
|---|---|---|
| overview (default) | `from` (the next page's first row), `keep` (rows kept whatever the filter) | `cols` {r, t, f, ln, source, kind, actor, service, severity, outcome, incident, re, tk, m, mb} as columns of small integers, `names` (each field's values), `t0`, `span`, `files`, `marks` (label values that are on), `starts` (each incident's first event), `next` |
| texts | `rows` | each row's text for the list |
| search | `q` | the rows holding q |
| record | `r`, `keep` | one event in full: `record` facts, `raw` [[line, text]], `answers`, `answered` |

The page filters, windows and lays out lanes on the columns it already has; only texts, search and a record go back to
the reader. `resolve` answers `<file>#L<n>` (the event on that line, or the nearest) with `target {r}`, and
`view:timeline/<INC-n | YYYY-MM-DD | from..to>` with that incident, day or window.
