## Sketches

Each sketch below describes a card made on real data with this runtime: the picture, its encoding and its interaction, without its program. Together they show what a card can do. They are not templates. Choose the form from this claim and this data.

### Bars split by a label: what the calls were, per group

- **The picture:** one bar per task, split into what its tool calls were (edit, write, shell, read, other), each part labelled inside it where the word fits; the total at the right end and one sentence with the overall shares under it.
- **Encoding:** a part's length is its count of calls; with the knob on share, every bar is its own 100%, so tasks of different sizes compare by their mix.
- **Interaction:** a knob switches counts and shares; each bar opens the calls behind it; the detail shows one bar per run, grouped under its task.

### Trail of one page: its eras, then every save

- **The picture:** the page's eras as stretches of one line, each named where it starts, and under them one column per save, in order.
- **Encoding:** a column's height is the page's length after that save; its color is what the save did (grew, wiped, restored, trimmed). The line under it says how far the page grew and how often it was wiped.
- **Interaction:** a press on an era, or the zoom knob, opens that era with wider, taller columns and each save's number; a filter knob colors only the wipes and leaves the other saves gray, so the wipes stand out against the page's shape.

### Curves with a knob: a noisy rate, averaged over a window you choose

- **The picture:** one line per run over its training steps, the main run's training rate in color, its held-out checks in a second color, a run that never took off in gray; two sentences under the plot carry the claim, their colored words naming the lines.
- **Encoding:** y is the win rate in percent of games, x the training step; the training line is a trailing mean over the window the knob sets, the held-out checks are drawn as they are.
- **Interaction:** a knob sets the window (each step, 5, 10, 20, 50 steps); the sentence reads it, so the size of the rise changes as the person turns it, and each line and sentence opens the rows behind it.

### Region map of a diff: where one change touched each file

- **The picture:** one strip per changed file, its path at the left and its lines added and removed at the right; under the strips, how many lines changed and what share of the added lines are tests.
- **Encoding:** a strip runs from line 1 to the last line the diff touches; each hunk is a block at its place and of its size, green where it added lines, red where it removed them, amber where it did both. In the detail, each hunk's line number sits under it.
- **Interaction:** a zoom knob opens one file as a row per hunk, its added and removed lines as a bar and its first changed line beside it; a press picks a hunk, and a key asks about it.

### Aligned strips: what each run was doing, at the same share of its work

- **The picture:** one strip per run, the busiest on top, every strip scaled to its own length so the same share of the work lines up; at the right end, the run's condition, its count of calls and its main activity in color.
- **Encoding:** each cell is one fortieth of the run's tool calls, colored by what the run did most then (read, write, run, wait, delegate, named once in color in the header and under long stretches in the detail).
- **Interaction:** a press on a strip zooms into that run, one row of heights per activity; a press on a column there picks it and a key asks about its calls; a knob shows one activity alone as heights across all runs.

### Unfold a number: one total, taken apart one way at a time

- **The picture:** one total at the top, and under it the pieces of one way of taking it apart, as bars against the total.
- **Encoding:** each piece is a bar as long as its count, with its count and its share; a line checks that the pieces add up to the total. The detail shows every way at once, the chosen one first.
- **Interaction:** a knob picks the way (where the items came from, model, condition, setup, who acted); a press picks a piece, and a key asks about its rows.

### Small multiples: one histogram per group on the same axes

- **The picture:** one small histogram per wiki, side by side, the largest first, each titled with its page count.
- **Encoding:** columns are page lengths in powers of ten of bytes, on the same axis in every panel; a column's height is the share of that wiki's pages, so the shapes compare whatever the wiki's size. The line under it compares the share of short pages.
- **Interaction:** a knob switches the heights to page counts on one scale for all; a press on a column marks that length in every panel and names each wiki's share of it, and a key asks about those pages.

### Two-sided flip: names to network ranges, and back

- **The picture:** a card with two sides. The front counts, for each account name, how many /16 network ranges it saved from; the back counts, for each range, how many names saved from it. Each side has one strip of the whole spread and bars for the widest five.
- **Encoding:** the strip is as long as all names (or ranges), cut into parts by how many of the other each saw (1, 2–5, 6–20, 21+), each part named under it with its count; the bars are the widest, each with its saves beside it. The line under it gives the share that saw more than one.
- **Interaction:** space flips the card to the other side; a press picks a bar, and a key asks about the saves behind it.

### Heat strips: when in the day the saves land

- **The picture:** one strip per wiki, one cell per hour of the day (UTC), the busiest wiki on top, its total at the right end.
- **Encoding:** a cell's height is its count, against the wiki's own busiest hour; a dot marks an hour with none. The line under it names the busiest four hours.
- **Interaction:** a knob switches the heights to one scale for all wikis, so the small wikis shrink; a press on a cell picks that hour, and a key asks about its rows.

### Dumbbell: two groups compared under each condition

- **The picture:** one line per condition, with one dot per model on a shared scale and a rule between them; the model names stand above the first line's dots, and the ratio sits at the right end.
- **Encoding:** a dot's position is the measure per worker agent; the smaller value is written left of its dot, the larger right of its dot. A quiet scale from zero runs under the lines, and the line under the card gives both totals.
- **Interaction:** a knob picks the measure (merges, reviews, pushes, comments); a press on a condition picks it, and a key asks about the rows behind both of its dots. The detail adds the raw counts under each line.

### Sign grid: what each condition did with the same items

- **The picture:** one row per item, one column per run, the runs grouped under their model and each column headed by its condition; the share of runs that merged the item at the right end.
- **Encoding:** a sign per cell, named once above the grid: a filled dot for merged, a ring for closed, a small dot for left open. Under the grid, three counts: the items every run merged, the items that split the runs, and the items no run merged.
- **Interaction:** a knob (or a press on one of the three counts) picks which items to list, the most divided first; a press on a cell picks it, and a key asks about its source row.

### Brushable timeline: when the work happened, and a window to ask about

- **The picture:** one strip per kind of action on one shared clock of the run, the hours marked under it, and a window marked under the clock.
- **Encoding:** each 10-minute bin is as tall as its count, each strip on its own scale; the count in the window and the total sit at the right of each strip. The line under it names the stretches where the whole swarm went quiet.
- **Interaction:** in the browser a drag across the strips picks the window; in the terminal [ and ] move it one bin; a key asks about the rows in the window, or, when it holds none, the bins on either side.

### Flow between two sides: who reviewed whose work

- **The picture:** reviewer groups on the left, each with its number of reviews; on the right, whose claim the reviewed pull request was under (another agent's, its own, none), each with its total; one line for each pair between them.
- **Encoding:** a line runs across from its group, turns once, and ends at its node; its weight (heavy, light, dashed) shows its count, and the count and its share of the group are written at its end in the group's color. The line under it names the node whose share differs most between the groups.
- **Interaction:** a knob regroups the reviewers (by model or by condition); a press on a count picks that flow and draws it on top, and a key asks about its rows.

### A number with its denominator: how many runs did a thing

- **The picture:** the count as the headline ("7 of 23 runs ..."), and under it one sign per run: filled for the runs that count, hollow for the rest, each group named in place under its signs.
- **Encoding:** a sign is a run; filled means it reached the threshold; the line under it says how much the counted runs did and which did most.
- **Interaction:** a knob sets the threshold (1, 2, 5, 10 commits) and the headline follows; a press on a sign picks that run and a key asks about its rows; each group of signs opens its rows; the detail lists every run with its count drawn to scale.
