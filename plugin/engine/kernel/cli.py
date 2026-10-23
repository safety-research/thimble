"""thimble: the thimble command. In a shell, it updates thimble and keeps your fixes (your own changes to thimble). In
a Claude Code session, Claude runs it to label records and to see what it read.

In a shell:

    thimble update                 the newest thimble, for the terminal plugin and the browser workbench. Your fixes
                                   are set aside, so that nothing is fixed twice; thimble reapply brings them back
    thimble reapply                Claude Code opens in your copy of thimble and brings back each fix that the new
                                   release still needs, once
    thimble fixes                  your fixes that are not in the release: on, off or ready (also: thimble fix list)
    thimble fix show N             what fix N does, in a few lines
    thimble fix share N            post fix N as a GitHub issue; you check it before it goes
    thimble fix off N | on N       turn fix N off, or on (on asks for your key in the terminal)
    thimble fix off | on           all your fixes off (the plain release), or on again
    thimble browser [FOLDER]       the browser workbench on a folder (the same as thimble-browser)
    thimble demo [NAME...]         the demo datasets, in the browser workbench
    thimble doctor                 a checklist of what works, with the fix for each problem

In Claude Code, /thimble-fix <what should work differently> asks Claude for a new fix.

Claude runs these in a session:

    thimble label [NAME]                       the labels, or one label's counts per value
    thimble label NAME --csv                   each record's ref, value, confidence, by and checked, for your code
    thimble label NAME --in GLOB (--regex RE | --code [FILE] | --prompt "DEFINITION") [--values yes,no]
                  [--where EXPR] [--within LABEL=VALUE] [--limit N] [--reason]
                                               give each record of GLOB one of the values; a --prompt label's records
                                               wait for the model, which reads each one beside the session
                                               (--wait waits for it; thimble label --help says more)
    thimble coverage [--all]                   what entered Claude's context, what was only computed over, and what
                                               was never touched (of this session, or of every session)
    thimble update --continue                  in the session thimble reapply opens: records the fixes Claude brought
                                               back, turns them on, and leaves out the rest

Add --json to label or coverage for the whole record.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

from . import coverage as CV
from . import estimate as EST
from . import labels as LB
from .store import Store


def stdin_text(wait: float = 1.0) -> str:
    """stdin when it holds input (a heredoc or a pipe); the Bash tool's open stdin with nothing on it reads as ''."""
    import select

    if sys.stdin is None or sys.stdin.isatty():
        return ""
    try:
        r, _, _ = select.select([sys.stdin], [], [], wait)
    except (OSError, ValueError):
        return sys.stdin.read()
    return sys.stdin.read() if r else ""


def out_json(v: Any) -> None:
    print(json.dumps(v, indent=1, ensure_ascii=False, default=str))


# ------------------------------------------------------------------ coverage

# Claude Code reads the first 4 MiB of a command's output, so the --json record keeps to COVER_BYTES
COVER_BYTES = 3 << 20
COVER_PER_FOLDER = 200  # untouched files named of each folder, at most


def cmd_coverage(a: argparse.Namespace) -> int:
    st = Store()
    cov = CV.coverage(st, None if a.all else "", per_folder=COVER_PER_FOLDER)
    if a.json:
        # The totals, groups and types count every file and always print; then the touched files by status, then the
        # untouched files coverage named (a few of each folder), while the record keeps to COVER_BYTES. `cut` says how
        # many of each are left out.
        size = lambda v: len(json.dumps(v, ensure_ascii=False, separators=(",", ":"), default=str).encode()) + 1  # noqa: E731
        quiet = cov["untouched"]
        n_quiet = cov["total"]["files"] - cov["total"]["touched_files"]
        cols = list(quiet)
        most = {"files": len(cov["files"]), "untouched": n_quiet}  # `cut` at its longest
        room = COVER_BYTES - size({**cov, "files": [], "untouched": {k: [] for k in cols}, "cut": most})
        files = []
        for o in sorted(cov["files"], key=lambda o: CV.ORDER.index(o["status"])):
            room -= size(o)
            if room < 0:
                break
            files.append(o)
        kept = 0
        for i in range(len(quiet["path"])):
            room -= sum(size(quiet[k][i]) for k in cols)
            if room < 0:
                break
            kept = i + 1
        cut = {"files": len(cov["files"]) - len(files), "untouched": n_quiet - kept}
        if cut["files"] or cut["untouched"]:
            cov["cut"] = cut
        cov["files"] = files
        cov["untouched"] = {k: v[:kept] for k, v in quiet.items()}
        print(json.dumps(cov, ensure_ascii=False, separators=(",", ":"), default=str))
        return 0
    print(CV.coverage_text(cov))
    return 0


# ------------------------------------------------------------------ labels

LABEL_HELP = """A label gives every record of a scope one of a few values, and keeps each record's ref.

    thimble label                              the labels here, with their counts
    thimble label NAME                         its counts per value; what waits; what the analyst checked
    thimble label NAME --csv                   every record as a CSV row: ref, value, confidence, by, checked. The
                                               analyst's check is the value where they checked one (by: analyst); a
                                               record that waits or got no value has an empty value. Read it in your
                                               code with Python's csv module to count or join
    thimble label NAME --in GLOB --regex RE    the first value where the record's text matches: a JSON or JSONL
                                               record's values, decoded, one per line (a newline in a value is a real
                                               newline), not its keys or quotes; a line of text or a CSV row as the
                                               file holds it
    thimble label NAME --in GLOB --code FILE   label(unit) in Python returns a value, (value, confidence) or None; a
                                               unit is the record as a dict, with `_ref` and `_text` (or the code on
                                               stdin). None leaves the record outside the label: it is not counted
    thimble label NAME --in GLOB --prompt "DEFINITION"
                                               the model reads each record against the definition, in calls of up to
                                               50 records that run beside the session, through its own model
    thimble label NAME --set REF=VALUE ...     values you give records yourself, after reading them
    thimble label NAME --wait [SECONDS]        wait for the model's calls (default 600 s), then the counts
    thimble label NAME --again                 ask the model again for the records that got no value

    --values a,b,c      the values, the positive first (default yes,no; --code takes the values it returns, the most
                        common first)
    --where EXPR        only records for which this Python expression is true (r is the record, text its raw text)
    --within L=V        only records the label L gave the value V
    --limit N           a trial: N records at random; the same label without --limit then labels the rest
    --reason            the model also gives a one-line reason per record

A --prompt label over more than 300 records does not start at once: the analyst is asked first, in the terminal, to
run all, run on a random sample of 300, or cancel. `thimble label NAME` shows their choice. A trial never asks. The
choices leave the screen once the analyst answers. After a sample, the same command again asks them to run the rest.

The same definition again keeps the values it has and labels only records it has not seen. A --prompt label prints how
many model calls it makes before they run. The analyst can open a value's records and check a sample of them: what
they say a record is counts in place of the label's value."""


def _parse_within(s: str | None) -> tuple[str, str] | None:
    if not s:
        return None
    if "=" not in s:
        raise LB.LabelError("--within takes LABEL=VALUE, such as --within apology=yes")
    k, v = s.split("=", 1)
    return k.strip(), v.strip()



def _where_of(st: Store, lab: dict[str, Any]) -> str:
    """The files a label reads, as its ask names them: " of revisions.jsonl", or nothing for every file."""
    g = str(lab.get("in") or "")
    return f" of {LB.shown_path(g, st.root)}" if g and g not in ("*", "**/*") else ""


def _label_lines(st: Store, lab: dict[str, Any]) -> list[str]:
    """What `thimble label NAME` prints: the definition, the records it holds, its counts per value as plain numbers
    with the records they count over, and what waits, failed or the analyst checked."""
    s = LB.status(lab)
    rule = str(lab.get("rule") or "")
    rule = rule if len(rule) <= 90 else rule[:89] + "…"
    head = f"label {lab['name']} v{lab.get('version')} · {lab.get('kind')}" + (f" {rule!r}" if rule and lab.get("kind") != "code" else "")
    head += f" · values {', '.join(lab['values'])}"
    scope = lab.get("in") or "records you named"
    if lab.get("where"):
        scope += f" where {lab['where']}"
    if lab.get("within"):
        scope += f" within {lab['within'][0]}={lab['within'][1]}"
    parts = LB.units_of(st, lab)
    unit = parts[0]["unit"] if len(parts) == 1 else "records"
    out = [head, f"  {LB.unit_count(s['records'], unit)} of {scope}" + (f" (a trial: {s['records']:,} of {lab.get('matched', 0):,} at random)" if lab.get("trial") else "")
           + (f"; the code returned None for {s['out']:,} more, which are outside the label" if s["out"] else "")]
    vals = lab["values"] + [v for v in s["counts"] if v not in lab["values"]]
    each = " · ".join(f"{v} {s['counts'].get(v, 0):,}" for v in vals)
    if not s["waiting"]:
        out.append(f"  {lab['name']}: {each} of {LB.unit_count(s['records'], unit)}")
    elif s["valued"]:
        # the records read so far (a trial, or the first calls) are no count of the label: it has more that wait
        out.append(f"  so far, only of the {LB.unit_count(s['valued'], unit)} with a value: {each}; not the label's "
                   f"counts while {s['waiting']:,} wait")
    if len(parts) > 1:
        # a file's unit is its own: a count over lines and whole files together is no count of either
        out.append(f"  the records mix units: {LB.units_said(parts)}; count each unit apart:")
        for v in vals:
            out.append(f"    {v}: " + ", ".join(f"{u['counts'].get(v, 0):,} of the {LB.unit_count(u['n'], u['unit'])}" for u in parts))
    run = lab.get("run") or {}
    if run.get("state") == "ask" and (run.get("ask") or {}).get("rest"):
        out.append(f"  the other {s['waiting']:,} records wait for the analyst's choice: the model reads them "
                   f"({EST.calls_line((run.get('ask') or {}).get('calls') or 0)}), or none")
    elif run.get("state") == "ask":
        out.append(f"  {s['waiting']:,} records wait for the analyst's choice: the model reads all of them "
                   f"({EST.calls_line((run.get('ask') or {}).get('calls') or 0)}), a random sample of {EST.SAMPLE}, or none")
    elif s["waiting"]:
        chose = {"sample": f"the random sample of {run.get('of') or EST.SAMPLE} the analyst chose",
                 "all": "the run the analyst chose"}.get(str(run.get("chose") or ""), "")
        doing = "the model is reading them" if run.get("state") == "running" else "the model's reads start beside the session"
        read = int(run.get("of") or 0) - s["waiting"] if run.get("chose") else 0
        out.append(f"  {s['waiting']:,} records wait for the model" + (f" ({chose}; {read:,} read)" if chose else "")
                   + f": {doing}. `thimble label {lab['name']} --wait` waits for them, then prints the counts")
    if run.get("state") == "cancelled":
        out.append(f"  the analyst chose not to run it over its {run.get('units') or 0:,} records")
    rest = int(lab.get("matched") or 0) - s["records"]
    if lab.get("trial") and lab.get("sampled") == LB.scope_key(lab) and run.get("state") != "ask" and rest > 0:
        out.append(f"  the analyst chose a random sample; the other {rest:,} records have no value. The same command "
                   f"without --limit asks the analyst again, to run them or cancel")
    if s["failed"]:
        why = next((u.get("err") for u in (lab.get("units") or {}).values() if u.get("v") is None and u.get("err")), "")
        out.append(f"  {s['failed']:,} records have no value" + (f" ({why})" if why else "")
                   + (f": `thimble label {lab['name']} --again` asks the model again" if lab.get("kind") == "prompt" else ""))
    if s["checked"]:
        out.append(f"  the analyst checked {s['checked']:,}: {s['agree']:,} agree, {s['disagree']:,} disagree")
    return out


def _load(st: Store, name: str) -> dict[str, Any]:
    lab = LB.load(st, name)
    if lab is None:
        raise LB.LabelError(f"no label {name!r}; labels: {', '.join(LB.names(st)) or 'none'}")
    return lab


def cmd_label(a: argparse.Namespace) -> int:
    st = Store()
    try:
        return _label(st, a)
    except LB.LabelError as e:
        print(f"thimble label: {e}")
        return 1


def _label(st: Store, a: argparse.Namespace) -> int:
    if a.records is not None and a.name:
        # a page of records for the plugin's labels pane: the person's read
        out_json(LB.page(st, a.name, None if a.records == "*" else a.records, a.at or 0, a.count or LB.PAGE))
        return 0
    if not a.name:
        labs = [LB.load(st, n) for n in LB.names(st)]
        if a.json:
            out_json([LB.head(x) for x in labs if x])
            return 0
        if not labs:
            print("no labels yet: thimble label NAME --in GLOB --regex RE | --code FILE | --prompt \"DEFINITION\" makes one")
        for x in labs:
            if x:
                s = LB.status(x)
                print(f"{x['name']}  {x.get('kind')}  {s['records']:,} records: " + ", ".join(f"{v} {s['counts'].get(v, 0):,}" for v in x["values"])
                      + (f" · {s['waiting']:,} waiting" if s["waiting"] else "") + (f" · {s['checked']:,} checked" if s["checked"] else ""))
        return 0
    name = a.name
    if a.csv:
        LB.write_csv(_load(st, name), sys.stdout)
        return 0
    if a.delete:
        p = LB.path(st, name)
        if not p.exists():
            print(f"no label {name}")
            return 1
        p.unlink()
        print(f"deleted the label {name}")
        return 0
    if a.check:
        ref, value = a.check
        r = LB.check(st, name, ref, None if value in ("-", "none") else value)
        if a.json:
            # every check that changed a value, for the note the plugin gives Claude
            changed = [{"ref": k, "was": c.get("was"), "now": c.get("v")} for k, c in (r["label"].get("checks") or {}).items()
                       if c.get("v") != c.get("was")]
            out_json({"ref": r["ref"], "was": r["was"], "now": r["now"], **LB.status(r["label"]), "changed": changed})
            return 0
        print(f"{r['ref']}: the analyst says {r['now']}" + (f" (the label gave {r['was']})" if r["was"] is not None else ""))
        return 0
    if a.waiting is not None:
        out_json(LB.waiting(st, name, first=a.waiting or None))
        return 0
    if a.answer:
        # the person's choice for a big label's ask (the terminal's ask runs this, as the person); the key that ran
        # this starts the model's reads itself (labels/use.ts answerAsk), so the feed has no line
        r = LB.answer_ask(st, name, a.ask or "", a.answer, EST.SAMPLE, a.seed)
        out_json({"name": name, "choice": r["choice"], "reads": r["reads"], "of": r["of"], **LB.status(_load(st, name))})
        return 0
    if a.answers:
        raw = Path(a.answers).read_text() if a.answers != "-" else stdin_text(5.0)
        try:
            payload = json.loads(raw or "{}")
        except ValueError as e:
            print(f"thimble label --answers reads one JSON object: {e}")
            return 2
        r = LB.answers(st, name, payload)
        s = LB.status(r["label"])
        if a.json:
            out_json({"took": r["took"], "failed": r["failed"], **s})
        else:
            print(f"{name}: {r['took']:,} records took a value, {r['failed']:,} got none; {s['waiting']:,} still wait")
        return 0
    if a.again:
        r = LB.again(st, name)
        if not r["waiting"]:
            print(f"{name}: every record has a value")
            return 0
        st.emit({"kind": "label", "name": name})
        calls = len(LB.batches(LB.waiting(st, name)["units"]))
        print(f"{name}: {r['waiting']:,} records wait for the model ({EST.calls_line(calls)}), which run beside the "
              f"session. `thimble label {name} --wait` waits for them.")
        return 0
    if a.set_values is not None:
        given: dict[str, str] = {}
        pairs = list(a.set_values)
        if not pairs:
            raw = stdin_text()
            try:
                got = json.loads(raw) if raw.strip() else {}
            except ValueError as e:
                print(f"thimble label --set reads REF=VALUE pairs, or one JSON object {{ref: value}} on stdin: {e}")
                return 2
            given = {str(k): str(v) for k, v in (got.items() if isinstance(got, dict) else [])}
        for x in pairs:
            if "=" not in x:
                print(f"--set takes REF=VALUE, not {x!r}")
                return 2
            k, v = x.rsplit("=", 1)
            given[k] = v
        if not given:
            print("nothing to set: give REF=VALUE pairs")
            return 2
        r = LB.set_values(st, name, given, a.values.split(",") if a.values else None)
        for b in r["bad"][:3]:
            print(f"  {b} names no record of a source file, so it got no value")
        for line in _label_lines(st, _load(st, name)):
            print(line)
        return 0
    kinds = [k for k, v in (("regex", a.regex), ("code", a.code), ("prompt", a.prompt)) if v is not None]
    if len(kinds) > 1:
        print("give one predicate: --regex, --code or --prompt")
        return 2
    if kinds:
        kind = kinds[0]
        if not a.glob:
            print("--in GLOB names the records to label, such as --in 'agents/*.jsonl'")
            return 2
        rule = a.regex if kind == "regex" else a.prompt if kind == "prompt" else None
        if kind == "code":
            rule = Path(a.code).read_text() if a.code not in ("-", "") else stdin_text(5.0)
            if not rule.strip():
                print("no code: pass a file with --code FILE, or the code on stdin, defining label(unit)")
                return 2
        r = LB.define(st, name, kind, rule, a.glob, a.values.split(",") if a.values else None, a.where,
                      _parse_within(a.within), a.limit, a.reason, a.seed)
        lab = _load(st, name)
        s = LB.status(lab)
        # a big prompt label asks the person first (estimate.py), unless it is a trial or they said yes to this exact
        # label and scope; the person's key answers with --answer, as the person (labels/use.ts)
        ask = None
        if kind == "prompt" and not a.limit and EST.needs_asking(s["waiting"]) and not LB.approved(lab):
            calls = len(LB.batches(LB.waiting(st, name)["units"]))
            ask = LB.hold_for_ask(st, name, calls)
            lab = _load(st, name)
            # after the analyst's sample, the ask is for the rest: run them or cancel, with no second sample
            st.emit({"kind": "label_ask", "name": name, "ask": ask["id"], "units": ask["units"], "calls": ask["calls"],
                     "sample": 0 if ask["rest"] else min(EST.SAMPLE, ask["units"]), "rest": ask["rest"],
                     "text": f"Read {'the other ' if ask['rest'] else ''}{ask['units']:,} records{_where_of(st, lab)} with Claude",
                     "meta": EST.calls_line(ask["calls"])})
        elif kind == "prompt" and s["waiting"]:
            # the plugin reads the change feed and starts the model's reads beside the session (labels/labels.ts)
            st.emit({"kind": "label", "name": name})
        if a.json:
            out_json({"name": name, **s, "added": r["added"], "errors": r["errors"]})
            return 0
        if r["same"] and not r["added"]:
            print(f"{name}: the same definition again, and every record has been seen; its values stand")
        for line in _label_lines(st, lab):
            print(line)
        for e in r["errors"]:
            print(f"  error: {e}")
        if ask:
            choices = "run them or cancel" if ask["rest"] else f"run all, run on a random sample of {EST.SAMPLE}, or cancel"
            print(f"  Not started: the model would read {'the other ' if ask['rest'] else ''}{ask['units']:,} records in "
                  f"{EST.calls_line(ask['calls'])}, so the analyst is asked first, in the terminal: {choices}. "
                  f"`thimble label {name} --wait` waits for their choice, then for the model's reads, and prints the "
                  f"label's counts; run it before you answer from this label. Counts from a trial are not the "
                  f"label's. The choices leave the screen once they answer, so after that do not point them to a key: "
                  f"to read more records, run this command again, and the terminal asks again. A trial (--limit N) "
                  f"never asks.")
        elif s["waiting"]:
            calls = len(LB.batches(LB.waiting(st, name)["units"]))
            print(f"  The model reads them in {EST.calls_line(calls)} of up to {LB.BATCH_ITEMS} records each, which run "
                  f"beside the session through its own model. `thimble label {name} --wait` waits for them, then "
                  f"prints the counts.")
        return 0
    if a.wait is not None:
        t0 = time.time()
        while True:
            lab = _load(st, name)
            s = LB.status(lab)
            run = lab.get("run") or {}
            if not s["waiting"] or run.get("state") == "cancelled":
                break
            if run.get("state") == "ask" and time.time() - t0 > a.wait:
                # the ask waits in the bar while this waits; once the analyst chooses, the reads start and this waits on
                print(f"{name}: still waiting for the analyst's choice in the bar after {a.wait:.0f}s; nothing runs "
                      f"until then. {s['waiting']:,} records wait, and the counts so far are not the label's. Their "
                      f"choice reaches you with their next message.")
                return 0
            if run.get("state") == "ask":
                time.sleep(1.0)
                continue
            if time.time() - t0 > a.wait:
                print(f"{name}: still {s['waiting']:,} records waiting after {a.wait:.0f}s; the calls go on beside the session")
                break
            if run.get("state") == "failed":
                print(f"{name}: the model's calls stopped: {run.get('error') or 'the session gave no reason'}. "
                      f"{s['waiting']:,} records still wait; `thimble label {name} --again` asks for them again.")
                return 1
            if run.get("state") == "asked" and time.time() - float(run.get("asked") or t0) > 45:
                print(f"{name}: no session has started the model's calls. They run in a Claude Code session with the "
                      "thimble plugin; outside one, label with --regex or --code, or give values with --set.")
                return 1
            if run.get("state") == "running" and time.time() - float(run.get("at") or run.get("started") or t0) > 900:
                print(f"{name}: the model's calls stopped 15 minutes ago with {s['waiting']:,} records still waiting (the "
                      f"session that made them may have ended). `thimble label {name} --again` asks for them again.")
                return 1
            time.sleep(1.0)
    lab = _load(st, name)
    if a.json:
        out_json({"name": name, **LB.status(lab), "definition": lab.get("rule"), "kind": lab.get("kind"),
                  "values": lab["values"]})
        return 0
    for line in _label_lines(st, lab):
        print(line)
    return 0


FIX_HELP = """Your changes to thimble (fixes), kept in $THIMBLE_HOME/fixes (engine/kernel/fixes.py says how).

    thimble fixes                    your fixes that are not in the release, one row each: number, state (on, off,
                                     ready), title, date and the start of your words (also: thimble fix list)
    thimble fix show N               what fix N does, in a few lines
    thimble fix share N              post fix N as a GitHub issue; you check it before it goes
    thimble fix off N | on N         turn fix N off, or on (on asks for your key in the terminal)
    thimble fix off | on             all your fixes off (the plain release), or on again
    thimble fix diff N               its change, as git shows it
    thimble fix export N [--to DIR]  its patch and its record as files in DIR (default: here); nothing is sent

Ask for a fix in Claude Code or the browser: /thimble-fix <what should work differently>. A fix goes on only by your
key: y on the fix in thimble, or thimble fix on N in a terminal."""


UPDATE_HELP = """thimble update: the newest thimble release (its newest vX.Y.Z tag on GitHub), for the terminal plugin and the
browser workbench in one go. Run it in a shell, not inside Claude Code.

When you have fixes, it does not put them on the release by itself: the release may already fix some of the same
things. It sets them aside, so thimble is the plain release, and keeps each fix's old change. Then:

    thimble reapply                  Claude Code opens in ~/.thimble/fixes/live. Claude checks each fix against the
                                     release, brings back what is still needed (one commit per fix), and runs:
    thimble update --continue        records those commits as the fixes' new versions and turns them on; a set-aside
                                     fix with no commit is left out, because the release does it or it cannot work there
    thimble update --check           only says whether a newer release is out

Afterwards: /reload-plugins in Claude Code, and restart thimble-browser."""


def cmd_update(a: argparse.Namespace) -> int:
    from . import fixes as FX  # noqa: PLC0415

    return FX.cmd_update(a)


def cmd_fix(a: argparse.Namespace) -> int:
    from . import fixes as FX  # noqa: PLC0415

    return FX.cmd(a)


def cmd_reapply(a: argparse.Namespace) -> int:
    from . import fixes as FX  # noqa: PLC0415

    return FX.cmd_reapply(a)


def cmd_doctor(a: argparse.Namespace) -> int:
    from . import shell as SH  # noqa: PLC0415

    return SH.doctor(a)


def _no_share(text: str) -> str:
    from . import fixes as FX  # noqa: PLC0415

    return text if FX.can_share() else "\n".join(x for x in text.splitlines() if "thimble fix share" not in x)


def _help() -> str:
    """thimble --help: this file's text, without the share line while this thimble has no thimble fix share."""
    from . import fixes as FX  # noqa: PLC0415

    lines = __doc__.strip().splitlines()
    return "\n".join(x for x in lines if FX.can_share() or "thimble fix share" not in x)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="thimble", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", metavar="{update,reapply,fixes,fix,browser,demo,doctor,label,coverage}")
    p = sub.add_parser("label", help="give each record of a scope one of a few values", description=LABEL_HELP,
                       formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("name", nargs="?")
    p.add_argument("--in", dest="glob", metavar="GLOB")
    p.add_argument("--regex")
    p.add_argument("--code", nargs="?", const="-", metavar="FILE")
    p.add_argument("--prompt", metavar="DEFINITION")
    p.add_argument("--values")
    p.add_argument("--where")
    p.add_argument("--within", metavar="LABEL=VALUE")
    p.add_argument("--limit", type=int)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--reason", action="store_true")
    p.add_argument("--set", dest="set_values", nargs="*", metavar="REF=VALUE")
    p.add_argument("--wait", nargs="?", type=float, const=600.0, metavar="SECONDS")
    p.add_argument("--again", action="store_true")
    p.add_argument("--check", nargs=2, metavar=("REF", "VALUE"), help="the analyst's check of one record (- takes it back)")
    p.add_argument("--answers", metavar="FILE", help="the model's answers for waiting records (the plugin writes them)")
    p.add_argument("--waiting", nargs="?", type=int, const=0, metavar="BATCHES",
                   help="the records that wait for the model, with their text, as JSON (those of the first BATCHES calls)")
    p.add_argument("--delete", action="store_true")
    p.add_argument("--json", action="store_true")
    p.add_argument("--csv", action="store_true", help="every record's ref, value, confidence, by and checked, as CSV")
    # the labels pane's reads (the person's, in the terminal): a page of records, all (*), of one value, or with none (-)
    p.add_argument("--records", nargs="?", const="*", help=argparse.SUPPRESS)
    p.add_argument("--at", type=int, help=argparse.SUPPRESS)
    p.add_argument("--count", type=int, help=argparse.SUPPRESS)
    # the person's answer to a big label's ask, which their key in the terminal runs (never Claude's to pass)
    p.add_argument("--answer", choices=("all", "sample", "cancel"), help=argparse.SUPPRESS)
    p.add_argument("--ask", help=argparse.SUPPRESS)
    p.set_defaults(fn=cmd_label)
    p = sub.add_parser("coverage", help="what entered Claude's context and what was only computed over")
    p.add_argument("--all", action="store_true", help="every session, not only this one")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_coverage)
    p = sub.add_parser("fix", help="your changes to thimble", description=_no_share(FIX_HELP),
                       formatter_class=argparse.RawDescriptionHelpFormatter)
    # the verbs after `export` are the plugin's own: a request, the fixer's end, and the person's keys
    p.add_argument("verb", nargs="?", default="list",
                   choices=("list", "show", "diff", "export", "off", "on", "update", "new", "round", "done", "apply", "notnow",
                            "redo", "undo", "remove", "sandbox", "draft", "keep", "send"), metavar="VERB")
    p.add_argument("id", nargs="?")
    p.add_argument("hit", nargs="?", help=argparse.SUPPRESS)
    p.add_argument("--json", action="store_true")
    p.add_argument("--to", metavar="DIR")
    p.add_argument("--words", help=argparse.SUPPRESS)
    p.add_argument("--title", help=argparse.SUPPRESS)
    p.add_argument("--summary", help=argparse.SUPPRESS)
    p.add_argument("--made-in", dest="made_in", default="terminal", help=argparse.SUPPRESS)
    p.add_argument("--request", action="store_true", help=argparse.SUPPRESS)
    p.add_argument("--no-tests", dest="no_tests", action="store_true", help=argparse.SUPPRESS)
    p.add_argument("--answer", choices=("pr", "file"), default="file", help=argparse.SUPPRESS)
    p.add_argument("--ask", help=argparse.SUPPRESS)
    p.set_defaults(fn=cmd_fix)
    p = sub.add_parser("update", help="the newest thimble release, for both modes", description=UPDATE_HELP,
                       formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--continue", dest="cont", action="store_true",
                   help="record the commits Claude made for the pending fixes, and turn them on")
    p.add_argument("--check", action="store_true", help="only say whether a newer release is out")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_update)
    p = sub.add_parser("reapply", help="Claude brings back the fixes thimble update set aside",
                       description="thimble reapply: Claude Code opens in your copy of thimble (~/.thimble/fixes/live) "
                       "with the fixes thimble update set aside. Claude checks each one against the new release, brings "
                       "back what is still needed, and runs thimble update --continue. Run it in a shell.")
    p.add_argument("--print", action="store_true", help="print Claude's first message, and open nothing")
    p.set_defaults(fn=cmd_reapply)
    p = sub.add_parser("doctor", help="a checklist of what works, with the fix for each problem")
    p.add_argument("--offline", action="store_true", help="do not look for a newer release")
    p.set_defaults(fn=cmd_doctor)
    args = list(sys.argv[1:] if argv is None else argv)
    if args and args[0] == "fixes":
        args = ["fix", "list", *args[1:]]
    if args and args[0] in ("browser", "demo"):
        from . import shell as SH  # noqa: PLC0415

        return SH.browser(args[0], args[1:])
    if not args or args[0] in ("-h", "--help", "help"):
        # the commands in one screen: argparse's usage lines would only repeat them
        print(_help())
        return 0
    if not args[0].startswith("-") and args[0] not in sub.choices:
        ap.error(f"no command {args[0]!r}: thimble --help lists the commands")
    a = ap.parse_args(args)
    if not getattr(a, "fn", None):
        print(_help())
        return 0
    try:
        return a.fn(a)
    except BrokenPipeError:
        # a reader that stopped early (`thimble label NAME --csv | head`): the rest goes nowhere, with no traceback
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        return 0
