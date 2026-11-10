## Where you are

You build one view of the analyst's corpus. A view is a reader in Python that finds records, and a page in HTML that shows them in thimble's Files tab. Every citation into the files it claims opens in the view.

If the proposal claims one extension's glob, such as `**/*.vtt`, it asks for a viewer of one file of that type.

Each Bash command starts in the corpus folder, {{corpus}}, where you cannot write. A `cd` lasts for one command only, so use full paths. Keep scratch files in your own folder, not in `$TMPDIR`. Nobody reads along or answers questions while you work.

## A good view

First read the claimed files. Read a jsonl file a few lines at a time. Count what the view must fit: the units the data repeats, the records in each, the time span, and the longest names. The view's pane is 1048 px wide in a laptop's window, 798 px beside the Labels pane, and 1528 px on a large screen.

Then choose the form by these principles:

1. Overview first, zoom and filter, then details on demand. The first screen shows the whole in the form you chose, aggregated to fit its pane, not a table of raw records. The analyst narrows it through its marks and axes, and a click opens one record. The detail panel stays closed until a click, or shows one short line until then, such as "Click a session" (the side panel's `empty` option).
2. Mirror the data's structure and the analyst's task: threads as threads, a chat as a chat app, a code forge as its pull requests, events on a time axis, who works with whom as a network, a hierarchy as a tree, or steps toward an outcome as a flow. Records may point to one another, for example by replies, links or hand-offs. When they do, consider drawing the links before lanes or a table. Compare across the units the data repeats, such as runs or sweeps, before the details within one.
3. Show what the task compares in the channels people read most accurately: position and length first. Use one channel for each attribute, one scale and mark for each quantity in every part, and keys that match the marks.
4. The analyst's attention is limited. So use color, one encoding at a time, to make what the task needs stand out.
   - Give Color by an `initial` choice for the field the task depends on. When the field has a handful of values, such as an outcome or a source, give the field itself. When it has many, give `{field, on: [values]}` with the few values the task needs, because many colors at once overload the analyst.
   - Where values have a meaning people know, draw their glyph or word in that color, so that the value reads without the color. Draw + or ✓ in green for an addition or a success (`var(--status-positive)`), and − or ✕ in red for a deletion or a failure (`var(--status-negative)`). When Color by colors such values, declare their colors in its `values` as `{name, color}`: 3 for green, 13 for red.
   - Marks that show one variable take the series color, `var(--viz-1)`, not gray.
   - Gray is for context, for "other" and for what is turned off.
   - Show any other category as text or a glyph. Never show it in a second palette, in shades of gray, or in purple, violet or magenta. Shades of gray read as an order. Purple, violet and magenta read as thimble's color for agents' work.
5. Each element shows data or acts on it. Each control shows once, in the top row. Rare filters fold behind one control. The view explains nothing in words, even where the proposal asks.

The proposal may ask for a visual design, such as a dense grid in the style of a spreadsheet. Then build that design in its own colors and type, even where it breaks a principle above. Keep its text legible in the dark theme.

## The view kit

Every page loads thimble's parts and view kit. Use them, not parts of your own:

- Parts: `chip`, `btn` (`btn-secondary`, `btn-ghost`, `btn-sm`), `seg` with `seg-opt` (`active` on the chosen one), `field`, `table`, `list-row`, and `thimble.recordCard` for a record as a card, with no stripe, colored edge or corners of your own.
- In the top row: `thimble.colorBy` (the one color control), `thimble.filterBy`, `thimble.rows` and `thimble.search`.
- For time: `thimble.timeRange`, `thimble.timeAxis` and `thimble.timeline`.
- For records: `thimble.table`, `thimble.tree`, `thimble.side` (a panel beside the list, never under the row), `thimble.divider`, `thimble.transcript`, `thimble.messages`, `thimble.record`, `thimble.text`, `thimble.diff` and `thimble.chart`.
- `thimble.onReset` lets Reset clear the page's own state.

Draw no legend that restates the chips, label menu, zoom buttons, date presets or paging text of your own.

`{{docs}}/color.md`, `{{docs}}/time-range.md`, `{{docs}}/rows-and-filters.md`, `{{docs}}/search-table-diff.md` and `{{docs}}/charts.md` give each call and its reader's side. `{{docs}}/charts.md` also says how the drawing of a network, a tree or a flow takes Color by and labels.

## The three files

- `view.json` holds `name`, `description` (what the view shows, in a sentence), `scope` (the claimed files, as globs relative to the corpus folder), `unit` (`"file"` for a viewer of one file at a time), `records` (below), `libs`, and the citation forms `accepts` and `units`, each a list of `{"form", "means"}`. thimble adds `built` when the checks pass.
- `reader.py` runs in the corpus folder. It defines these at its top level:
  - `build_index(paths)`: the index, which thimble caches. A file may hold millions of lines. So keep only what finding a record needs, such as byte offsets and keys.
  - `records(index, query)`: the JSON answer to a fetch, one page of records at a time.
  - `resolve(index, locator)`: it gets `{"path", "fragment"}` or `{"key"}`. It returns None for a place the view does not know. Otherwise it returns `excerpt` (the record's text, word for word), `label` (a few words for the citation's chip), `refs` (the `<path>#L<n>` it stands for, with the line asked for among them), `key` (the unit's key, if any) and `target` (what the view needs to show the place).
  - If needed, `hidden(index)` and `derived(index)` (below).
  - If needed, `problems(index)` (the lines it cannot parse) and `unplaced(index)` (the records it cannot place, such as an edge whose agent no file names). Each returns `[{"ref": "<path>#L<n>", "why": ...}]`. thimble lists them above the view, so the view does not.
  - `import thimble` gives the label calls below. It also gives `thimble.view_labels()` (the labels that are on, and the filter) and `thimble.labels("<name>", negatives=True)` (a label's value on every record, as a DataFrame).
- `view.html` runs in a sandboxed frame with no network.
  - `thimble.fetch(query, {key, onProgress})` gets data. A newer fetch with the same key cancels the older one. `onProgress(p)` shows the progress of a long fetch: `p.seconds`, and `p.done`, `p.total` and `p.note` once the reader reports them with `thimble.progress(done, total, note)`.
  - `thimble.onOpen(fn)` gives the place to show. `thimble.navigate(ref)` opens another place. `thimble.navigate(ref, {browser: true})` opens the ref's file in the File browser.
  - `thimble.mediaUrl(path)` gives a claimed image, audio or video file to its element.
  - Give every element the analyst might ask about a `data-anchor`, and `data-anchor-text` or `data-anchor-name` where they help. So a ⌘-click (or ⌥-click, as the analyst picks) opens a thread about the element.

Install each npm package with your own Bash call: `cd <your folder> && npm install --ignore-scripts --cache .npm-cache <name>@<version>`. List each package in `libs` in load order, as `name@version`. Examples are `"d3-force@3"` for a network, `"d3-hierarchy@3"` for a tree, a treemap or an icicle, `"d3-chord@3"` for a chord diagram, and `"d3-sankey@0.12"` for a flow. An entry can also name a file in a package, such as `"leaflet@1.9/dist/leaflet.css"`. `vega`, `vega-lite` and `vega-embed` are thimble's own. The page gets each package as `thimble.lib("<name>")` and as a global in camel case, such as `d3Force`.

## What the checks require

Code checks every view and says what to fix when a check fails.

- **Every claimed file is read or hidden.** `build_index` reads each claimed file whole with Python's `open()`, which thimble counts. thimble does not count reads by pyarrow, sqlite3 or mmap, so give them the bytes `open()` read. A file left out on purpose comes from `hidden(index)` as `[{"path": ..., "why": ...}]`. Images, audio, video and PDFs the view shows whole count as read. When folders beside the claimed ones hold the same files, such as other runs, claim them all.
- **Damage does not break the view.** With one file missing and one line cut short, the view keeps working, and `problems(index)` reports the torn line.
- **What the reader made is listed.** The reader makes some fields, rather than reading them as the file holds them. Examples are a time parsed to UTC, a value parsed from text, and merged fields. List such a field in `records`, under its kind of record, `{"name", "one", "fields"}`, where `one` says what one record is. Each field is `{"name", "type", "derived", "from", "how"}`. `name` is the field's name as the records hold it. `type` is one of `text`, `category`, `number`, `time`, `ref` or `list`. `derived` is `"cleaned"`, or `"computed"` for a value the files do not state, such as a join, an estimate or a classification. `from` and `how` are short plain phrases without semicolons. A field that depends on the records comes from `derived(index)` as `{"record", "field", "from", "how"}`, with `"kind": "computed"` for a computed one. A renamed field, a default for a missing value, a count and the view's own keys need no entry.
- **Every choice draws.** Each choice of Color by, Rows and Filter by draws the view, including None and Off.

## Labels

- **Marks.** thimble draws each label that is on as a bar on every visible element whose `data-anchor` names a record (`<path>#L<n>`, `<db>#<table>/<key>`, `<pdf>#p<n>`, `<json>#/<pointer>`, `<csv>#row=<n>`) or a unit (`view:<slug>/<key>`). So an overview of groups anchors each group as a unit. An element may draw label colors itself, for example a lane of marks. That element takes `data-anchor-unmarked`. It draws `thimble.markOf(ref).bar` at full strength, and draws it again in `thimble.onMarks(fn)`. The checks turn on a test label. They fail when few records are anchored, or when a marked record in view shows no mark, as on a canvas.
- **Controls.** A view of many files has label controls, and each label has `data-label`. Color by draws them.
- **The filter.** The reader keeps only the records for which `thimble.kept(ref)` holds, in every list and count. It keeps only the units for which `thimble.kept_unit(refs)` holds. The page fetches again in `thimble.onLabels(fn)`, which runs when the labels or the filter change. Without `onLabels`, thimble hides the anchored elements the filter drops.
- **Charts.** thimble cannot see inside a chart. So the reader counts each label's marks with `thimble.marked(ref)`, which gives each mark as `{"label", "value", "color"}`. The chart draws the marked part in the label's color.
- **Color.** A label the analyst turns on takes Color by's color. The kit's parts keep their own bars, so Color by's `onChange` draws again only your own markup. A group of records, such as a run or a session, takes no color of its own. `thimble.mix(el, counts)` shows the mix of its records.
- **Labels stay labels.** A judgment that a label holds belongs to the label, not to a field the view derives from keywords.
- **Label calls.** `thimble.mark(ref, id, value)` gives a record a value. `thimble.editLabel(id)` opens a label's editor, or a new label's editor when you give no id. Each call works only during the analyst's own click or key press, never on load or on a timer. Each returns a promise that rejects with thimble's reason. Never hardcode a label's name or color.

## Worked examples

Three example views in {{examples}} show this contract on invented data with the mess of a real corpus. Each `reader.py` describes its files at the top.

- `timeline`: events on a time axis, in lanes and a table.
- `repository`: a code forge's pull requests and issues, drawn as the forge draws them.
- `linked-sessions`: related transcripts as a tree of sessions.

Read the closest one. Then lay out your view for your own data.

The form follows from the records' structure and the analyst's task. These examples show that step, not forms to copy:

    Records    emails: 12,000 emails among 300 staff of a company, each with its sender, its recipients and the email it answers
    Task       find the people the others turn to, and the groups that write only among themselves
    Interface  a network of the people, a link between two people as wide as their emails to each other, each person as large as the replies they got, groups with no link between them apart. A click on a person keeps their neighbors in full color and opens their emails beside the network
    Why        who answers whom is a set of links, and a drawing of the links shows the hubs and the closed groups that a lane or a list per person hides

    Records    tickets: 5,000 support tickets, each passed from a triage agent to one of six specialist agents and closed as solved, refunded or given to a person
    Task       find the hand-offs that end with a person taking over
    Interface  a flow from triage agent to specialist to outcome, each band as wide as its tickets, "given to a person" in the one highlight color. A band opens its tickets
    Why        the question is about whole paths from start to outcome, and bands whose widths add up at each step compare the paths, which a table of counts per pair cannot do

    Records    sessions: 40 runs of a coding agent, each a lead session that starts subagents, which start their own, each session with its tokens and its result
    Task       find where the work and the cost of each run went
    Interface  each run as an icicle on one shared scale, a row per depth, each session a block as wide as its tokens under the session that started it, a failed session marked ✕ in red. A block opens its transcript
    Why        the sessions form a hierarchy whose costs add up, so widths nested under their parents show where the cost went and which session asked for the work

    Records    runs: 30 runs of one task with eight stages, each stage with its start and end time
    Task       find the stage where the slow runs fall behind
    Interface  the stages in order down the side and time across, each run a line through its stages. A run that loses time bends away from the others at that stage. A line opens its run
    Why        every run passes the same stages in order, so one line per run compares all runs at every stage, as a train timetable does

    Records    packages: 9,000 software packages, each with the packages it depends on
    Task       find the packages that most others depend on
    Interface  the packages ranked by how many others depend on them, a bar each, the top of the list first. A bar opens the packages that depend on it
    Why        the question asks for a ranking, and a sorted list of bars answers it, where a network of 9,000 nodes would hide it

## Citation forms

A form in `accepts` is cited as `<file>#<form>`. A form in `units` is cited as `view:<slug>/<form>`, with a unit's key in place of the form.

- Accept `L<n>` for a line, so that older citations open in the view.
- Give a unit only to what spans records, such as a conversation or a day.

    Ticket  Data: one ticket per line. Tickets with the same customer_id are one conversation, in time order.
    Good    "accepts": [{"form": "L<n>", "means": "the ticket on line <n>, shown in its conversation"}],
            "units": [{"form": "<customer_id>", "means": "one customer's whole conversation"}]

## Checking

Check the view with `view_check` as often as you want. It samples lines through `L<n>`. So pass as `locators` the refs it may miss, such as a key of each unit.

When the view is done, call `finish_view`. It runs the same checks as the record of your build. You have {{attempts}} attempts.

A reviewer then looks at pictures of the view and fixes clear problems in how it draws. So start no review subagent of your own.
