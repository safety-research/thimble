"""The view pipeline's helper (views/SPEC.md): proposals, the reader's run and the checks a built view must pass.

thimble's pipeline (backend/app/views.py, dev.py) for the terminal: a proposal names a view and what it shows; a
builder writes reader.py and view.json in .thimble-cc-mod/views/<slug>/; this file runs the reader (helper/viewhost.py
keeps thimble's reader contract and counts the bytes it reads), writes rows.json, and holds the view to thimble's gates:
every claimed file read or hidden with a why, unreadable lines reported, derived fields declared, the reader still
working with a file missing and a line cut short, sampled lines resolving back to themselves, and the spec drawn
within the panel by tools/render_view.mjs.

    python3 viewpipe.py propose --name N --why W --claims G [G ...] --unit U --overview O --zoom Z --filter F
                                --details D [--build] [--by main]
    python3 viewpipe.py propose --json '{"name": ..., ...}' [--build]
    python3 viewpipe.py run <slug>                        the reader's rows written to rows.json
    python3 viewpipe.py check <slug> [locator ...] [--width 96] [--height 48] [--json]
    python3 viewpipe.py list                              proposals and views, as JSON
    python3 viewpipe.py keep <slug> | restore <slug>      the view's files copied to reviewed/, or back from it

The folder is THIMBLE_CC_MOD_ROOT, else the current one (`--root` overrides). `check` exits 1 when the view fails.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import viewhost  # noqa: E402
from refs import resolve as resolve_ref  # noqa: E402

HOME = ".thimble-cc-mod"
RENDER = os.path.join(os.path.dirname(HERE), "tools", "render_view.mjs")
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,40}$")
FIELDS = ("unit", "overview", "zoom", "filter", "details")  # a proposal's layout, as thimble's propose_view asks it
NAMED = 5  # files or fields a problem names before "and more"
CHECK_FILES, CHECK_LINES, CHECK_KEYS = 3, 3, 3
SIBLING_SAMPLE = 200
TORN_SUFFIXES = (".jsonl", ".ndjson")
TORN_LINE = '{"torn": "a line cut short'
TORN_MAX = 64 * 1024 * 1024
DERIVED_SAMPLE = 60
PART_BYTES = 3_500_000  # rows.json and each of its parts: Claude Code's hooks read a file of at most 4 MiB
ROWS_MAX = 10_000_000  # rows.json with its parts: the panel holds every row at once
KEPT = ("reader.py", "view.json", "rows.json")  # with rows.json's parts, the files `keep` and `restore` copy
UNSAMPLED = viewhost.SHOWN_SUFFIXES + (".db", ".sqlite", ".sqlite3", ".parquet", ".zip", ".gz", ".xlsx")


def home(root: str) -> str:
    return os.path.join(root, HOME)


def view_dir(root: str, slug: str) -> str:
    return os.path.join(home(root), "views", slug)


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def _named(items: list, n: int = NAMED) -> str:
    return "; ".join(items[:n]) + (" and more" if len(items) > n else "")


# ------------------------------------------------------------------------------------------------ proposals


def title_case(name: str) -> str:
    """A view's name as its tab shows it: each word's first letter upper case, the rest as written."""
    return " ".join(w[:1].upper() + w[1:] for w in " ".join(str(name or "").split()).split(" ") if w)


def slug_for(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:41].strip("-")
    return s or "view"


def propose(root: str, raw: dict, build: bool = False, by: str = "main") -> dict:
    """Store a proposal as .thimble-cc-mod/views/<slug>/proposal.json: {ok, slug, proposal} or {ok: false, problems}.
    Every field is required, and each claim must match a file of the folder. A proposal of a name proposed before
    replaces it under its slug; `build` asks the mod to build it now."""
    problems = []
    name = title_case(raw.get("name") or "")
    why = " ".join(str(raw.get("why") or "").split())
    claims = raw.get("claims") or []
    claims = [claims] if isinstance(claims, str) else [str(c).strip() for c in claims if str(c).strip()]
    if not name:
        problems.append("name: a short name in Title Case, as its tab shows it")
    if not why:
        problems.append("why: what the analyst sees and why that helps")
    if not claims:
        problems.append("claims: globs of every file that holds its records, relative to the folder")
    spec = {k: " ".join(str(raw.get(k) or "").split()) for k in FIELDS}
    for k in FIELDS:
        if not spec[k]:
            problems.append(f"{k}: {PROPOSAL_ASKS[k]}")
    files = viewhost.claimed(root, claims) if claims else []
    for g in claims:
        if not any(viewhost.glob_matches(p, g) for p in files):
            problems.append(f"claims: {g} matches no file of the folder")
    if problems:
        return {"ok": False, "problems": problems}
    slug = slug_for(name)
    d = view_dir(root, slug)
    os.makedirs(d, exist_ok=True)
    prop = {"slug": slug, "name": name, "why": why, "claims": claims, **spec, "proposed_by": by or "main",
            "build": bool(build), "files": len(files), "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    tmp = os.path.join(d, "proposal.json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(prop, f, indent=1, ensure_ascii=False)
    os.replace(tmp, os.path.join(d, "proposal.json"))
    return {"ok": True, "slug": slug, "proposal": prop}


PROPOSAL_ASKS = {
    "unit": "what one row, mark or card stands for, the field that keys it, and how many there are",
    "overview": "what the view opens on",
    "zoom": "how the analyst narrows it",
    "filter": "which fields it filters by",
    "details": "what one record shows on demand",
}


def listing(root: str) -> list:
    """Every folder under .thimble-cc-mod/views with its proposal, its status (the mod's) and whether it is drawable."""
    out = []
    base = os.path.join(home(root), "views")
    for slug in sorted(os.listdir(base)) if os.path.isdir(base) else []:
        d = os.path.join(base, slug)
        if not SLUG_RE.match(slug) or not os.path.isdir(d):
            continue
        row = {"slug": slug}
        for name in ("proposal", "status", "check"):
            with contextlib.suppress(OSError, ValueError):
                with open(os.path.join(d, f"{name}.json"), encoding="utf-8") as f:
                    row[name] = json.load(f)
        row["drawable"] = all(os.path.isfile(os.path.join(d, n)) for n in ("view.json", "rows.json"))
        out.append(row)
    return out


# ------------------------------------------------------------------------------------------------ the reader's run


def label_defs(root: str, folder: str) -> list:
    """The labels over the folder's files: regex labels from .thimble-cc-mod/labels.json, then the view's labels.json
    ([{name, kind: regex, spec, labels, paths}], as thimble's labels.json writes them)."""
    out, names = [], set()
    for p in (os.path.join(home(root), "labels.json"), os.path.join(folder, "labels.json")):
        with contextlib.suppress(OSError, ValueError):
            with open(p, encoding="utf-8") as f:
                for d in json.load(f):
                    if isinstance(d, dict) and d.get("name") and d.get("spec") and d["name"] not in names:
                        names.add(d["name"])
                        out.append(d)
    return out


def rows_of(viewer: viewhost.Viewer) -> dict:
    """The reader's answer to {"op": "rows"}, with what it could not read: rows.json without its labels."""
    got = viewer.records({"op": "rows"})
    if not isinstance(got, dict) or not isinstance(got.get("collections"), dict):
        raise ValueError('records(index, {"op": "rows"}) must return {"collections": {<name>: [row, ...]}}')
    return {"collections": got["collections"], "problems": viewer.problems(),
            "hidden": list(viewer._optional("hidden") or []), "unplaced": list(viewer._optional("unplaced") or []),
            "files": len(viewer.paths)}


def run(root: str, slug: str) -> dict:
    """Run the view's reader and write rows.json. Returns the rows written."""
    d = view_dir(root, slug)
    viewer = viewhost.Viewer(d, root, defs=os.devnull, cache=os.path.join(d, "cache"))
    data = rows_of(viewer)
    spec = viewer.view
    data["labels"] = viewhost.label_marks(label_defs(root, d), root, data["collections"], spec)
    write_rows(d, data)
    return data


def write_rows(folder: str, data: dict) -> list:
    """rows.json, in parts when it is larger than the hooks can read in one go: rows.json then holds everything but the
    rows and `parts`, the names of files rows-<n>.json, each {"collections": {...}} with a slice of the rows, in order.
    The parts are written first, so a reader that sees the new rows.json finds its parts. Returns the files written."""
    old = [f for f in os.listdir(folder) if re.fullmatch(r"rows-\d+\.json", f)]
    text = json.dumps(data, ensure_ascii=False, default=str)
    if len(text.encode()) <= PART_BYTES:
        write_json(os.path.join(folder, "rows.json"), data)
        for f in old:
            os.remove(os.path.join(folder, f))
        return ["rows.json"]
    parts: list = []
    cur: dict = {}
    size = 20

    def flush() -> None:
        nonlocal cur, size
        if cur:
            name = f"rows-{len(parts) + 1}.json"
            write_json(os.path.join(folder, name), {"collections": cur})
            parts.append(name)
        cur, size = {}, 20

    for name, rows in data["collections"].items():
        for r in rows:
            n = len(json.dumps(r, ensure_ascii=False, default=str).encode()) + 1
            if size + n + len(name) + 8 > PART_BYTES:
                flush()
            cur.setdefault(name, []).append(r)
            size += n
    flush()
    head = {**{k: v for k, v in data.items() if k != "collections"}, "collections": {k: [] for k in data["collections"]},
            "parts": parts}
    write_json(os.path.join(folder, "rows.json"), head)
    for f in old:
        if f not in parts:
            os.remove(os.path.join(folder, f))
    return ["rows.json", *parts]


def read_rows(folder: str) -> dict:
    """rows.json with its parts' rows put back in place."""
    with open(os.path.join(folder, "rows.json"), encoding="utf-8") as f:
        data = json.load(f)
    for part in data.pop("parts", None) or []:
        with open(os.path.join(folder, part), encoding="utf-8") as f:
            for k, rows in json.load(f)["collections"].items():
                data["collections"].setdefault(k, []).extend(rows)
    return data


def copy_view(src: str, dst: str) -> None:
    """The view's files (reader.py, view.json, rows.json and its parts) copied from one folder to another, the files of
    an older copy in dst removed first."""
    os.makedirs(dst, exist_ok=True)
    for f in os.listdir(dst):
        if f in KEPT or re.fullmatch(r"rows-\d+\.json", f):
            os.remove(os.path.join(dst, f))
    for f in os.listdir(src):
        if f in KEPT or re.fullmatch(r"rows-\d+\.json", f):
            shutil.copyfile(os.path.join(src, f), os.path.join(dst, f))


def write_json(path: str, v: object) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(v, f, ensure_ascii=False, default=str)
    os.replace(tmp, path)


# ------------------------------------------------------------------------------------------------ the checks


def alike(a: str, b: str) -> bool:
    if re.sub(r"\d+", "#", a) == re.sub(r"\d+", "#", b):
        return True
    return len(os.path.commonprefix([a, b])) >= 3 or len(os.path.commonprefix([a[::-1], b[::-1]])) >= 3


def sibling_files(claimed: list, every: list) -> list:
    """thimble's views.sibling_files: files in folders beside a claimed one that hold the same files, such as another
    run's beside the one run a view claims."""
    mine = set(claimed)
    under: dict = {}
    for p in mine:
        parts = p.split("/")
        for i in range(len(parts) - 1):
            under.setdefault(("/".join(parts[:i]), parts[i]), set()).add("/".join(parts[i + 1:]))
    if not under:
        return []
    parents = {q for q, _ in under}
    tree: dict = {}
    for p in every:
        if p in mine:
            continue
        parts = p.split("/")
        for i in range(len(parts) - 1):
            q = "/".join(parts[:i])
            if q in parents:
                rest = "/".join(parts[i + 1:])
                kind = (os.path.dirname(rest), os.path.splitext(rest)[1])
                tree.setdefault(q, {}).setdefault(parts[i], {}).setdefault(kind, []).append(rest)
    have = set(every)
    out: set = set()
    for (q, r), rests in under.items():
        beside = [(s, by_kind) for s, by_kind in (tree.get(q) or {}).items() if s != r and alike(r, s)]
        if not beside:
            continue
        kinds = {(os.path.dirname(x), os.path.splitext(x)[1]) for x in rests}
        own = tree.get(q, {}).get(r, {})
        whole = {k for k in kinds if not own.get(k)}
        sample = sorted(rests)[:SIBLING_SAMPLE]
        for s, by_kind in beside:
            if not kinds & set(by_kind):
                continue
            base = f"{q}/{s}" if q else s
            if sum(f"{base}/{x}" in have for x in sample) * 2 < len(sample):
                continue
            out |= {f"{base}/{x}" for k in kinds for x in by_kind.get(k, []) if x in rests or k in whole}
    return sorted(out)


def squeeze(s: str) -> str:
    return " ".join(str(s).split())


def missing_lines(excerpt: str, source: str) -> list:
    src = squeeze(source)
    return [ln.strip() for ln in str(excerpt).splitlines() if ln.strip() and squeeze(ln) not in src]


REF_RE = re.compile(r"^(?P<path>[^#]+)#L(?P<a>\d+)(?:-L?(?P<b>\d+))?$")


def covers(refs: list, path: str, line: int) -> bool:
    for r in refs:
        m = REF_RE.match(str(r))
        if m and m["path"] == path and int(m["a"]) <= line <= int(m["b"] or m["a"]):
            return True
    return False


def line_count(path: str) -> int:
    n, last = 0, b"\n"
    with io.open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            n += block.count(b"\n")
            last = block[-1:]
    return n + (last != b"\n")


def sample_lines(root: str, rel: str) -> list:
    try:
        total = line_count(os.path.join(root, rel))
    except OSError:
        return []
    return [x for x in sorted({1, max(1, total // 2), max(1, (2 * total) // 3)}) if 1 <= x <= total][:CHECK_LINES]


def sample_files(files: list, sizes: dict) -> list:
    if not files:
        return []
    return list(dict.fromkeys([max(files, key=lambda p: sizes.get(p, 0)), files[0], files[len(files) // 2]]))[:CHECK_FILES]


def texty(path: str) -> bool:
    try:
        with io.open(path, "rb") as f:
            head = f.read(4096)
    except OSError:
        return False
    return b"\0" not in head


# fields that need no entry among the derived ones: a record's place, the view's own keys, counts and defaults
POSITION_KEYS = {"ref", "refs", "line", "lines", "path", "file", "key", "anchor", "offset", "index", "idx", "n", "id",
                 "uid", "row", "pos", "position", "order", "rank", "i", "k", "seq"}
KEY_SUFFIXES = ("_key", "_idx", "_index", "_pos", "_row", "_order", "_rank")
COUNT_NAME = re.compile(r"(^|[_\s-])(n|num|count|counts|total|totals|size|len|length)([_\s-]|$)|^n[A-Z]|Count$|^(num|count)[A-Z]")
DEFAULTS = {"", "-", "?", "—", "unknown", "none", "null", "n/a", "na", "other", "missing", "(none)", "(unknown)"}


def exempt(field: str, value: object) -> bool:
    low = field.lower()
    if low in POSITION_KEYS or low.endswith(KEY_SUFFIXES):
        return True
    if isinstance(value, int) and not isinstance(value, bool) and (COUNT_NAME.search(field) or plural_name(low)):
        return True
    return isinstance(value, str) and value.strip().lower() in DEFAULTS


def plural_name(name: str) -> bool:
    return len(name) > 3 and name.endswith("s") and not name.endswith(("ss", "us", "is"))


def scalars(v: object, out: list) -> None:
    if isinstance(v, dict):
        for x in v.values():
            scalars(x, out)
    elif isinstance(v, list):
        for x in v:
            scalars(x, out)
    elif isinstance(v, str):
        out.append(v)
    elif isinstance(v, (int, float)) and not isinstance(v, bool):
        out.append(json.dumps(v))


def held(value: object, text: str, numbers: set) -> bool:
    if isinstance(value, (int, float)):
        return json.dumps(value) in text or float(value) in numbers
    v = squeeze(value).rstrip("…").removesuffix("...").strip()
    return not v or v[:80] in text


def cited_text(root: str, ref: str) -> str | None:
    """The values of the record a row cites, as text: each JSON value of its lines, or the lines as written."""
    got = resolve_ref(root, ref)
    if got.get("status") == "missing" or not got.get("text"):
        return None
    parts: list = []
    for ln in str(got["text"]).splitlines():
        try:
            scalars(json.loads(ln), parts)
        except ValueError:
            parts.append(ln)
    return "\n".join(parts)


def unlisted_derived(root: str, spec: dict, collections: dict) -> list:
    """thimble's views.unlisted_derived over the rows: each field whose values the line a row cites does not hold, for
    at least two rows and most of those that have it, and that the spec does not declare derived. [{field, value, ref}]."""
    out = []
    for c in spec.get("collections") or []:
        rows = collections.get(c.get("name")) or []
        declared = {f.get("name") for f in c.get("fields") or [] if f.get("derived")}
        reff = c.get("ref") or "ref"
        seen: dict = {}
        missed: dict = {}
        texts: dict = {}
        step = max(1, len(rows) // DERIVED_SAMPLE)
        for r in rows[::step][:DERIVED_SAMPLE]:
            ref = r.get(reff) if isinstance(r, dict) else None
            m = REF_RE.match(ref) if isinstance(ref, str) else None
            if not m:
                continue
            if ref not in texts:
                texts[ref] = cited_text(root, ref)
            text = texts[ref]
            if text is None:
                continue
            sq = squeeze(text)
            numbers = set()
            for x in text.split():
                with contextlib.suppress(ValueError):
                    numbers.add(float(x.strip(",;:\"'()[]{}")))
            for k, v in r.items():
                if k in declared or k == reff or v is None or isinstance(v, (dict, bool)) or exempt(k, v):
                    continue
                if isinstance(v, list) and (not v or not all(isinstance(x, (str, int, float)) and not isinstance(x, bool) for x in v)):
                    continue
                if isinstance(v, str) and (len(v.strip()) < 2 or v in ref or REF_RE.match(v)):
                    continue
                seen[k] = seen.get(k, 0) + 1
                ok = all(held(x, sq, numbers) for x in v) if isinstance(v, list) else held(v, sq, numbers)
                if not ok:
                    missed.setdefault(k, []).append((v, ref))
        for k, xs in missed.items():
            if len(xs) >= 2 and len(xs) * 2 > seen[k] and len({json.dumps(v, default=str) for v, _ in xs}) > 1:
                v, ref = xs[0]
                out.append({"collection": c.get("name"), "field": k, "value": str(v)[:60], "ref": ref})
    return out


def heaviest(collections: dict, n: int = 3) -> str:
    """The fields that take the most bytes over every row, their names counted with their values, as
    "revisions.body 21.3 MB"."""
    sizes: dict = {}
    for name, rows in collections.items():
        for r in rows if isinstance(rows, list) else []:
            for k, v in r.items() if isinstance(r, dict) else []:
                b = len(json.dumps({k: v}, ensure_ascii=False, default=str).encode())
                sizes[f"{name}.{k}"] = sizes.get(f"{name}.{k}", 0) + b
    top = sorted(sizes.items(), key=lambda kv: -kv[1])[:n]
    return ", ".join(f"{k} {b / 1e6:.1f} MB" for k, b in top) or "none"


def robust_pick(scope: list, files: list, sizes: dict, whole: set) -> tuple:
    """(the claimed file the damaged copy leaves out, the one it tears): a file of a claim over several folders, else
    the smallest of a claim of several files; the smallest JSON lines file the reader reads whole."""
    removed = None
    by_claim = [(g, [p for p in files if viewhost.glob_matches(p, g)]) for g in scope]
    for g, hit in by_claim:
        head, _, base = g.rpartition("/")
        if head and re.search(r"[*?\[]", head) and not re.search(r"[*?\[]", base) and len(hit) >= 2:
            removed = hit[-1]
            break
    if removed is None:
        removed = next((min(hit, key=lambda p: sizes[p]) for _, hit in by_claim if len(hit) >= 2), None)
    torn = min((p for p in files if p.lower().endswith(TORN_SUFFIXES) and p != removed and sizes[p] <= TORN_MAX
                and p in whole), key=lambda p: sizes[p], default=None)
    return removed, torn


def robust(root: str, folder: str, files: list, sizes: dict, whole: set, before: int) -> list:
    """Problems of the reader on a copy of its files with one missing and a line cut short: build_index, problems() and
    the rows must not fail, problems() must report the torn line, and the rows must not all go."""
    removed, torn = robust_pick(viewhost.Viewer(folder, root, defs=os.devnull).scope, files, sizes, whole)
    if removed is None and torn is None:
        return []
    with tempfile.TemporaryDirectory(prefix="thimble-view-robust-") as tmp:
        copy = os.path.join(tmp, "corpus")
        torn_ref = None
        for rel in files:
            if rel == removed:
                continue
            dst = os.path.join(copy, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            src = os.path.realpath(os.path.join(root, rel))
            if rel == torn:
                shutil.copyfile(src, dst)
                with io.open(dst, "rb+") as fh:
                    fh.seek(0, os.SEEK_END)
                    if fh.tell():
                        fh.seek(-1, os.SEEK_END)
                        if fh.read(1) != b"\n":
                            fh.write(b"\n")
                    fh.write(TORN_LINE.encode())
                torn_ref = f"{rel}#L{line_count(dst)}"
            else:
                os.symlink(src, dst)
        what = " and ".join([*([f"{removed} missing"] if removed else []), *([f"a torn line at {torn_ref}"] if torn_ref else [])])
        try:
            v = viewhost.Viewer(folder, copy, defs=os.devnull)
            v.index()
            probs = v.problems()
            data = rows_of(v)
        except Exception as e:  # noqa: BLE001 — the reader's failure is the finding
            return [f"With {what}, the reader failed: {type(e).__name__}: {e}. A real folder can lack a file or hold a "
                    "line cut short, so read what is there, and report each line you cannot parse with problems()."]
        out = []
        if torn_ref and not any(covers([p.get("ref")], *_parts(torn_ref)) for p in probs if isinstance(p, dict)):
            out.append(f"The checks added a line cut short at {torn_ref}, and problems() does not report it. Report each "
                       "line the reader cannot parse with problems(), so the analyst sees it above the view.")
        after = sum(len(r) for r in data["collections"].values() if isinstance(r, list))
        if before and not after:
            out.append(f"With {what}, the reader returns no rows, though over the whole folder it returns rows. One "
                       "missing file or bad line must leave the rest of the view working.")
        return out


def _parts(ref: str) -> tuple:
    m = REF_RE.match(ref)
    return (m["path"], int(m["a"])) if m else (ref, 0)


def render_check(spec_path: str, rows_path: str, width: int, height: int, labeltest: bool = False) -> dict:
    """tools/render_view.mjs --check (and --labeltest): the spec's and the rows' problems and each tab drawn in the panel."""
    argv = ["node", RENDER, "--spec", spec_path, "--rows", rows_path, "--check", "--width", str(width), "--height", str(height)]
    if labeltest:
        argv.append("--labeltest")
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=180)
    except (OSError, subprocess.TimeoutExpired) as e:
        return {"ok": False, "error": f"render_view.mjs did not run: {e}"}
    try:
        return json.loads(p.stdout)
    except ValueError:
        return {"ok": False, "error": (p.stderr or p.stdout or "render_view.mjs printed nothing").strip()[-1500:]}


def check(root: str, slug: str, locators: list | None = None, width: int = 96, height: int = 48) -> dict:
    """Every check of a view, in code: {ok, problems, notes, lines, checks, rows}. rows.json is written on the way."""
    rep: dict = {"ok": False, "problems": [], "notes": [], "checks": [], "lines": []}
    P, N, L = rep["problems"], rep["notes"], rep["lines"]
    d = view_dir(root, slug)
    for name in ("reader.py", "view.json"):
        if not os.path.isfile(os.path.join(d, name)):
            P.append(f"{HOME}/views/{slug}/{name} does not exist yet")
    if P:
        return finish(rep)
    try:
        with open(os.path.join(d, "view.json"), encoding="utf-8") as f:
            spec = json.load(f)
    except ValueError as e:
        P.append(f"view.json is not JSON: {e}")
        return finish(rep)
    if not isinstance(spec, dict):
        P.append("view.json is not a JSON object")
        return finish(rep)
    if spec.get("slug") != slug:
        P.append(f"view.json's slug is {spec.get('slug')!r}, not {slug!r}, the name of its folder")
    scope = spec.get("scope")
    if not isinstance(scope, list) or not scope:
        P.append("view.json's scope lists no glob of the files the view claims")
        return finish(rep)
    t0 = time.monotonic()
    try:
        viewer = viewhost.Viewer(d, root, defs=os.devnull)
        files = viewer.paths
        if not files:
            P.append(f"no file of the folder matches the scope {', '.join(scope)}")
            return finish(rep)
        viewer.index()
    except Exception as e:  # noqa: BLE001
        P.append(f"build_index failed: {type(e).__name__}: {e}")
        rep["traceback"] = traceback.format_exc()[-1500:]
        return finish(rep)
    L.append(f"index: {_plural(len(files), 'file')} in {time.monotonic() - t0:.1f} s")
    sizes = {p: os.path.getsize(os.path.join(root, p)) for p in files}
    try:
        data = rows_of(viewer)
    except Exception as e:  # noqa: BLE001
        P.append(f"the rows failed: {type(e).__name__}: {e}")
        rep["traceback"] = traceback.format_exc()[-1500:]
        return finish(rep)
    probs = data["problems"]
    if any(not isinstance(p, dict) or not p.get("ref") or not p.get("why") for p in probs):
        P.append("problems(index) returns a list of {\"ref\": \"<path>#L<n>\", \"why\": ...}")
    elif probs:
        L.append(f"unread: {_plural(len(probs), 'line')} the reader could not parse, such as {probs[0]['ref']}: {probs[0]['why']}")
    hidden = {h.get("path"): h.get("why") for h in data["hidden"] if isinstance(h, dict)}
    if any(not w for w in hidden.values()):
        P.append("hidden(index) returns a list of {\"path\", \"why\"}, each with a why")
    parsed = [p for p in files if not p.lower().endswith(viewhost.SHOWN_SUFFIXES)]
    unread = [p for p in parsed if p not in hidden and viewer.reads.get(p, 0) < sizes[p]]
    if unread:
        P.append(f"{_plural(len(unread), 'claimed file')} {'is' if len(unread) == 1 else 'are'} neither read to the end by "
                 "build_index nor listed with a why by hidden(index): "
                 + _named([f"{p} (read {viewer.reads.get(p, 0):,} of {sizes[p]:,} bytes)" for p in unread])
                 + ". Read each file whole in build_index, with Python's open(), or return it from hidden(index) with "
                 "its path and a why.")
    beside = sibling_files(files, viewhost.corpus_files(root))
    if beside:
        N.append(f"{_plural(len(beside), 'file')} sit in folders beside the claimed ones and hold the same files: "
                 f"{_named(beside)}. If the view is for all of them, claim them and let the analyst choose.")
    missing = [g for g in scope if not any(viewhost.glob_matches(p, g) for p in files)]
    if missing:
        N.append(f"the scope's {', '.join(missing)} match{'es' if len(missing) == 1 else ''} no file")
    counts = {k: len(v) for k, v in data["collections"].items() if isinstance(v, list)}
    derived = [f"{c.get('name')}.{f.get('name')}" for c in spec.get("collections") or [] if isinstance(c, dict)
               for f in c.get("fields") or [] if isinstance(f, dict) and f.get("derived")]
    L.append(f"files: {len(files) - len(unread)} of {len(files)} read to the end or hidden with a why"
             + (f", {len(hidden)} hidden" if hidden else "") + "; rows: "
             + (", ".join(f"{k} {n:,}" for k, n in counts.items()) or "none")
             + "; derived fields: " + (", ".join(derived) or "none"))
    data["labels"] = viewhost.label_marks(label_defs(root, d), root, data["collections"], spec)
    rows_path = os.path.join(d, "rows.json")
    written = write_rows(d, data)
    rep["rows"] = counts
    size = sum(os.path.getsize(os.path.join(d, p)) for p in written)
    L.append(f"rows.json: {f'{size / 1e6:.1f} MB' if size >= 100_000 else f'{size / 1e3:.0f} KB'}"
             + (f" in {len(written) - 1} parts" if len(written) > 1 else ""))
    if size > ROWS_MAX:
        total = sum(counts.values())
        P.append(f"the rows take {size / 1e6:.1f} MB, more than the {ROWS_MAX / 1e6:.0f} MB a view may take, since the "
                 f"panel loads every row at once: that leaves about {ROWS_MAX // max(1, total):,} bytes for each of its "
                 f"{total:,} rows. The largest fields are {heaviest(data['collections'])}. Cut each long text to its start "
                 "or leave it out, since the row's ref opens the whole record, and count records in the reader rather "
                 "than list each one")
    elif len(written) > 1:
        N.append(f"rows.json is in {len(written) - 1} parts, as its rows take {size:,} bytes; "
                 "the panel reads them all, so cut long text the detail does not need (the row's ref opens the whole record)")

    # the spec and the rows, drawn in the panel at its width and 30 columns narrower, with a test label on
    drawn = render_check(os.path.join(d, "view.json"), rows_path, width, height, labeltest=True)
    if drawn.get("error"):
        P.append(drawn["error"])
    for p in drawn.get("spec") or []:
        P.append(f"view.json {p}")
    for p in drawn.get("rows") or []:
        P.append(f"rows {p}")
    for n in drawn.get("notes") or []:
        (P if "hex id" in n else N).append(n)
    for p in drawn.get("width") or []:
        P.append(f"drawn: {p}")
    for p in drawn.get("labels") or []:
        P.append(f"labels: {p}")
    if drawn.get("ok"):
        L.append(f"drawn: {_plural(len(spec.get('tabs') or []), 'tab')} at {width} and {max(60, width - 30)} columns"
                 + (f", the test label's marks drawn on {drawn.get('marked', 0)} rows" if drawn.get("marked") is not None else ""))
    for x in shortened_names(spec, data["collections"]):
        P.append(f"{x['collection']}.{x['field']} shortens {x['n']:,} of {x['of']:,} names with an ellipsis in the middle, "
                 f"such as {x['value']!r}: give each name whole, as the panel shortens a name that does not fit, keeping "
                 "its start and its end")
    if spec.get("labels") is False and len(files) > 1:
        P.append("view.json sets labels false, so a view of many files draws no label controls; leave labels on")

    # fields the reader made that the spec does not declare
    if not P:
        for x in unlisted_derived(root, spec, data["collections"]):
            P.append(f"{x['collection']}.{x['field']} holds values the line each row cites does not, such as "
                     f"{x['value']!r} on {x['ref']}, and the spec does not declare it derived: give the field "
                     "\"derived\": \"cleaned\" (or \"computed\" for a value the files do not state) with from and how")

    # sampled lines and the locators given resolve back to themselves, with literal excerpts
    accepts_lines = any(re.fullmatch(r"L<[^<>]+>", str(a.get("form", "")).strip()) for a in spec.get("accepts") or [] if isinstance(a, dict))
    wanted = list(dict.fromkeys(str(x).strip() for x in locators or [] if str(x).strip()))
    if accepts_lines:
        texts = [p for p in parsed if p not in hidden and not p.lower().endswith(UNSAMPLED)]
        for rel in sample_files(texts, sizes):
            if texty(os.path.join(root, rel)):
                wanted += [loc for n in sample_lines(root, rel) if (loc := f"{rel}#L{n}") not in wanted]
    keys: list = []
    for loc in wanted:
        rep["checks"].append(check_locator(viewer, root, slug, loc, keys))
    if spec.get("units"):
        for k in keys[:CHECK_KEYS]:
            rep["checks"].append(check_locator(viewer, root, slug, f"view:{slug}/{k}", keys))
    for r in rep["checks"]:
        L.append(f"ok  {r['locator']} -> {r.get('label') or '(no label)'}: {squeeze(r.get('excerpt') or '')[:100]}" if r["ok"]
                 else f"bad {r['locator']}: {r.get('why')}")

    if not P and all(r["ok"] for r in rep["checks"]):
        whole = {p for p in parsed if viewer.reads.get(p, 0) >= sizes[p] and p not in hidden}
        P.extend(robust(root, d, files, sizes, whole, sum(counts.values())))
    return finish(rep)


MID_CUT = re.compile(r"\S…\S")


def shortened_names(spec: dict, collections: dict) -> list:
    """Name fields (each collection's title, the label of lanes drawn from a collection) whose values the reader cut in
    the middle, "Count…ataReview": the panel cannot show such a name whole at any width."""
    names: dict = {}
    for c in spec.get("collections") or []:
        if isinstance(c, dict) and isinstance(c.get("title"), str):
            names.setdefault(c.get("name"), set()).add(c["title"])
    for t in spec.get("tabs") or []:
        for b in [t.get("overview"), *(t.get("body") or [])] if isinstance(t, dict) else []:
            lanes = b.get("lanes") if isinstance(b, dict) else None
            if isinstance(lanes, dict) and isinstance(lanes.get("label"), str):
                names.setdefault(lanes.get("collection"), set()).add(lanes["label"])
    out = []
    for col, fields in names.items():
        rows = [r for r in collections.get(col) or [] if isinstance(r, dict)]
        for f in sorted(fields):
            cut = [str(r[f]) for r in rows if isinstance(r.get(f), str) and MID_CUT.search(r[f])]
            if len(cut) >= 3 and len(cut) * 20 >= len(rows):
                out.append({"collection": col, "field": f, "n": len(cut), "of": len(rows), "value": cut[0]})
    return out


def check_locator(viewer: viewhost.Viewer, root: str, slug: str, loc: str, keys: list) -> dict:
    row: dict = {"locator": loc, "ok": False}
    try:
        res = viewer.resolve(loc)
    except Exception as e:  # noqa: BLE001
        row["why"] = f"resolve() failed: {type(e).__name__}: {e}"
        return row
    if not isinstance(res, dict):
        row["why"] = "resolve() answered None" if res is None else "resolve() answers a dict"
        return row
    excerpt, refs = str(res.get("excerpt") or ""), [str(r) for r in res.get("refs") or []]
    row.update(label=str(res.get("label") or ""), excerpt=excerpt[:300])
    if not excerpt.strip():
        row["why"] = "the excerpt is empty"
        return row
    if not refs:
        row["why"] = "the answer cites no file ref (refs)"
        return row
    m = REF_RE.match(loc)
    if m and not covers(refs, m["path"], int(m["a"])):
        row["why"] = f"the answer does not cite {loc} back (its refs: {', '.join(refs[:3])})"
        return row
    source = "\n".join(t for r in refs[:30] if (t := resolve_ref(root, r).get("text")))
    if source:
        gone = missing_lines(excerpt, source)
        if gone:
            row["why"] = f"the excerpt is not literal text of the records it cites: {gone[0][:160]!r}"
            return row
    if res.get("key") and res["key"] not in keys and not loc.startswith("view:"):
        keys.append(str(res["key"]))
    row["ok"] = True
    return row


def finish(rep: dict) -> dict:
    rep["ok"] = not rep["problems"] and all(r["ok"] for r in rep["checks"])
    rep["lines"] += [f"problem: {p}" for p in rep["problems"]]
    if rep.get("traceback"):
        rep["lines"].append(rep["traceback"].strip())
    rep["lines"] += [f"note: {n}" for n in rep["notes"]]
    rep["lines"].append("checks passed" if rep["ok"] else "checks failed")
    return rep


# ------------------------------------------------------------------------------------------------ the command line


def main(argv: list) -> int:
    args, opts, flags = [], {}, set()
    i = 0
    multi = {"claims"}
    while i < len(argv):
        a = argv[i]
        if a.startswith("--"):
            k = a[2:]
            if k in ("build", "json-out") or (k == "json" and argv[0] == "check"):
                flags.add(k)
            elif k in multi:
                vals = []
                while i + 1 < len(argv) and not argv[i + 1].startswith("--"):
                    vals.append(argv[i + 1])
                    i += 1
                opts[k] = vals
            else:
                opts[k] = argv[i + 1] if i + 1 < len(argv) else ""
                i += 1
        else:
            args.append(a)
        i += 1
    if not args:
        print(__doc__, file=sys.stderr)
        return 2
    root = os.path.abspath(opts.get("root") or os.environ.get("THIMBLE_CC_MOD_ROOT") or os.getcwd())
    op = args[0]
    if op == "propose":
        raw = json.loads(opts["json"]) if opts.get("json") else {k: opts.get(k) for k in ("name", "why", "claims", *FIELDS)}
        got = propose(root, raw, build="build" in flags or bool(raw.get("build")), by=opts.get("by") or "main")
        if not got["ok"]:
            print("the proposal is incomplete:\n" + "\n".join(f"- {p}" for p in got["problems"]))
            return 1
        p = got["proposal"]
        print(f"proposed the view {p['name']}: {_plural(p['files'], 'file')} match its claims; saved as "
              f"{HOME}/views/{p['slug']}/proposal.json. "
              + ("thimble-cc-mod builds it now and opens it in the panel when its checks pass."
                 if p["build"] else "The analyst can build it from the row above the prompt.")
              + f" Reply in one sentence that names the view {p['name']}, with no layout, no clicks and no numbers: "
                "the builder lays it out, and the view shows the counts.")
        return 0
    if op == "list":
        print(json.dumps(listing(root), ensure_ascii=False, indent=1))
        return 0
    if len(args) < 2 or not SLUG_RE.match(args[1]):
        print("give the view's slug: the name of its folder under .thimble-cc-mod/views/", file=sys.stderr)
        return 2
    slug = args[1]
    if op in ("keep", "restore"):
        d = view_dir(root, slug)
        src, dst = (d, os.path.join(d, "reviewed")) if op == "keep" else (os.path.join(d, "reviewed"), d)
        if not os.path.isfile(os.path.join(src, "view.json")):
            print(f"nothing to {op}: {src} holds no view.json", file=sys.stderr)
            return 1
        copy_view(src, dst)
        return 0
    if op == "run":
        data = run(root, slug)
        print(json.dumps({k: len(v) for k, v in data["collections"].items()}))
        return 0
    if op == "check":
        rep = check(root, slug, args[2:], int(opts.get("width") or 96), int(opts.get("height") or 48))
        with contextlib.suppress(OSError):
            write_json(os.path.join(view_dir(root, slug), "check.json"),
                       {"ok": rep["ok"], "lines": rep["lines"], "rows": rep.get("rows"),
                        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        print(json.dumps(rep, ensure_ascii=False, default=str) if "json" in flags else "\n".join(rep["lines"]))
        return 0 if rep["ok"] else 1
    print(f"unknown operation {op!r}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
