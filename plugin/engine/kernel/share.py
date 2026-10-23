"""thimble fix share ID: a fix as a public GitHub issue that the person checks and submits themselves.

The draft is a title, what was wrong and how it was fixed, in plain words, with the thimble version and the mode. It is
Claude's text when the plugin or the browser gives one (`--draft -`, the JSON fix-draft.md asks for), else the one given
before for this fix, else the fix's own record: the person's words and what the fixer said the fix does. The privacy
scan (privacy.py, as `thimble fix draft` runs it) takes the names and values of the person's folder and machine out of
the draft first.

Then a share page, one local HTML file with no server, opens in the person's browser: the title and the text to edit, a
slot for their own screenshot, and one button that opens GitHub's new-issue page with the title and the text in its link.
The person pastes their screenshot there and presses Submit on GitHub. thimble sends nothing at any point.

Under $THIMBLE_HOME/fixes/share/<id>/:

    index.html   the share page
    share.json   what the page shows: the title and text after the scan, the issue's link, what the scan took out
    given.json   the draft before the scan, which a later share of the same fix starts from; never shown or sent

THIMBLE_OPEN (a command, or `none`) replaces the command that opens the page, for tests.
"""
from __future__ import annotations

import html
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode

from . import fixes as FX
from . import privacy as P
from .store import Store

# GitHub takes a new-issue link of about 8,000 characters; the page and the shell keep theirs under this
URL_MAX = 7000
STATES = ("on", "off", "ready", "redo", "request", "saved", "sent", "released", "failed")

# what the scan took out, in the person's words: (one, many)
KIND_WORDS = {
    "file": ("file name", "file names"), "folder": ("folder name", "folder names"), "path": ("path", "paths"),
    "name": ("name", "names"), "git": ("git name", "git names"), "host": ("machine name", "machine names"),
    "email": ("email address", "email addresses"), "token": ("key or token", "keys or tokens"),
    "key": ("key or token", "keys or tokens"), "generic": ("key or token", "keys or tokens"),
    "field": ("field name", "field names"), "value": ("value from your data", "values from your data"),
}


def share_dir(fid: int) -> Path:
    return FX.home() / "share" / str(fid)


def took_words(hits: list[dict[str, Any]]) -> str:
    """What the scan took out, as the shell and the page say it: `took 1 file name and 2 paths out of the text`."""
    kinds: dict[str, set[str]] = {}
    for h in hits:
        if not h.get("kept"):
            kinds.setdefault(KIND_WORDS.get(h["kind"], ("detail", "details"))[0], set()).add(h["found"])
    if not kinds:
        return "found nothing of yours to take out"
    many = {one: m for one, m in KIND_WORDS.values()}
    parts = [f"{len(v)} {one if len(v) == 1 else many.get(one, one + 's')}" for one, v in kinds.items()]
    return f"took {FX._and(parts)} out of the text"


def issue_url(title: str, body: str, repo: str) -> tuple[str, bool]:
    """GitHub's new-issue page with the title and the text in its link, under URL_MAX characters: (link, shortened).
    A text that does not fit is cut, and ends in `…`. The page builds the same link in its script (PAGE, link())."""
    base = f"https://github.com/{repo}/issues/new"

    def url(b: str) -> str:
        return f"{base}?{urlencode({'title': title, 'body': b}, quote_via=quote)}"

    if len(url(body)) <= URL_MAX:
        return url(body), False
    lo, hi = 0, len(body)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if len(url(body[:mid].rstrip() + "…")) <= URL_MAX:
            lo = mid
        else:
            hi = mid - 1
    return url(body[:lo].rstrip() + "…"), True


def _given(rec: dict[str, Any], given: dict[str, Any] | None) -> tuple[dict[str, str], str]:
    """The draft before the scan, and where it came from: claude (given now), earlier (given for an earlier share), or
    record (the person's words and what the fixer said)."""
    d = share_dir(rec["id"])
    src = "claude"
    if not given:
        given = FX.read_json(d / "given.json")
        src = "earlier"
    if isinstance(given, dict) and str(given.get("title") or "").strip():
        if src == "claude":
            FX.write_json(d / "given.json", {k: str(given.get(k) or "") for k in ("title", "wrong", "fixed")})
        return {k: " ".join(str(given.get(k) or "").split()) for k in ("title", "wrong", "fixed")}, src
    words = " ".join(" ".join(str(w).split()) for w in rec.get("words") or [])
    return {"title": str(rec.get("title") or ""), "wrong": words, "fixed": " ".join(str(rec.get("summary") or "").split())}, "record"


def _body(rec: dict[str, Any], d: dict[str, str]) -> str:
    request = rec.get("state") == "request" or not rec.get("commit")
    rel = FX.release()
    version = rel.get("version") or str(rel.get("base") or "")[:7] or "?"
    fixed = d["fixed"] or ("(no change: Claude could not do it in code)" if request else "(say how it works now)")
    return (f"What was wrong: {d['wrong'] or '(say what you saw)'}\n\n"
            f"{'What it needs' if request else 'How it was fixed'}: {fixed}\n\n"
            f"thimble {version} · {rec.get('made_in') or 'terminal'} · {'asked through' if request else 'fixed by'} thimble fix\n")


def _scan(text: str, st: Store | None) -> tuple[list[dict[str, Any]], str]:
    """The privacy scan of the draft, as `thimble fix draft` scans the words: every name from the person's folder goes,
    even one that thimble's repository has. (hits, the text with them taken out)"""
    base = FX.release().get("base") or "HEAD"
    have_live = (FX.live_dir() / ".git").exists()
    paths = FX._repo_paths(base, "") if have_live else set()
    held, keep = FX._protect({"issue": text}, paths)
    known = FX._known(base) if have_live else None
    found = FX.session_terms(st)
    terms = FX._widen(found, held["issue"], known, set())
    repo_paths = [(str(FX.live_dir()) + os.sep, ""), (str(FX.PLUGIN) + os.sep, "plugin/")]
    hits, _notes = P.scan(held, terms, known, repo_paths, allow=[base])
    out = FX._unprotect(P.apply(held, hits), keep)["issue"]
    return hits, out


def opener() -> list[str] | None:
    """The command that opens a file in the person's browser, or None on a machine with no browser to show (a remote
    one, reached over ssh)."""
    o = os.environ.get("THIMBLE_OPEN")
    if o:
        return None if o == "none" else [o]
    if sys.platform == "darwin":
        return ["open"] if shutil.which("open") else None
    if sys.platform.startswith("win"):
        return ["cmd", "/c", "start", ""]
    if shutil.which("xdg-open") and (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        return ["xdg-open"]
    return None


def open_page(page: Path) -> bool:
    cmd = opener()
    if not cmd:
        return False
    try:
        subprocess.Popen([*cmd, str(page)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError:
        return False
    return True


def share(fid: int | str, given: dict[str, Any] | None = None, st: Store | None = None, open_it: bool = True) -> dict[str, Any]:
    """The share draft through the scan, the share page, and the page opened. Nothing is sent."""
    rec = FX.get(fid)
    if rec.get("state") not in STATES:
        raise FX.FixError(f"fix {rec['id']} is {rec.get('state')}: there is nothing to share yet")
    d, src = _given(rec, given)
    title = FX.short(d["title"] or rec["title"], 72)
    hits, text = _scan(f"{title}\n{_body(rec, d)}", st)
    title, _, body = text.partition("\n")
    url, shortened = issue_url(title.strip(), body, FX.upstream())
    out_dir = share_dir(rec["id"])
    out_dir.mkdir(parents=True, exist_ok=True)
    took = took_words(hits)
    marks = sorted({h["replacement"] for h in hits if h["replacement"].startswith("‹")})
    data = {"id": rec["id"], "title": title.strip(), "body": body, "url": url, "shortened": shortened, "took": took,
            "marks": marks, "repo": FX.upstream(), "max": URL_MAX, "text": src}
    FX.write_json(out_dir / "share.json", data)
    page = out_dir / "index.html"
    page.write_text(page_html(data))
    opened = open_page(page) if open_it else False
    return {**data, "page": str(page), "opened": opened, "removed": len({h["found"] for h in hits})}


def lines(r: dict[str, Any]) -> list[str]:
    """What `thimble fix share ID` prints."""
    out = [f"Share fix {r['id']}: {r['title']}", f"  ✓ privacy check: {r['took']}"]
    if r["opened"]:
        out.append("  ✓ opened the share page in your browser")
    else:
        out.append(f"  · no browser to open here; the share page is {FX._tilde(r['page'])}")
    if r.get("shortened"):
        out.append("  · the text is longer than a GitHub link holds, so the link has the first part of it")
    out.append("On the share page: check the title and text, then Open a GitHub issue. GitHub opens its own page with "
               "your text filled in; paste your screenshot there if you added one, and press Submit. Nothing leaves your "
               "computer until you press Submit there.")
    out.append(f"No browser here (a remote machine)? Open this link on your computer: {r['url']}")
    return out


# ------------------------------------------------------------------ the page

PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:">
<meta name="referrer" content="no-referrer">
<title>Share fix {id} · thimble</title>
<style>
:root {{ --bg: #f6f4f9; --panel: #fff; --ink: #1c1924; --muted: #6a6476; --line: #c9c4d4; --soft: #dcd8e4;
  --accent: #7d17e8; --accent-ink: #fff; --warn: #a35a00; --warn-bg: #fff1d6; color-scheme: light dark; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg: #17151c; --panel: #1f1c26; --ink: #ece9f2; --muted: #a29cad;
  --line: #4a4456; --soft: #34303d; --accent: #af87ff; --accent-ink: #17151c; --warn: #f0b45a; --warn-bg: #3a2c12; }} }}
* {{ box-sizing: border-box; }}
body {{ margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }}
header {{ display: flex; gap: 10px; align-items: center; height: 40px; padding: 0 16px; border-bottom: 1px solid var(--soft); background: var(--panel); font-size: 13px; color: var(--muted); }}
header b {{ color: var(--accent); }}
main {{ max-width: 760px; margin: 0 auto; padding: 20px 16px 40px; display: flex; flex-direction: column; gap: 14px; }}
label {{ display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }}
input, textarea {{ width: 100%; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--ink); font: inherit; font-size: 14px; padding: 8px 10px; }}
input {{ font-weight: 600; }}
textarea {{ min-height: 190px; resize: vertical; }}
input:focus, textarea:focus, button:focus-visible, .shot:focus-visible {{ outline: 2px solid var(--accent); outline-offset: 1px; }}
.took {{ font-size: 12px; color: var(--muted); }}
.took mark {{ background: var(--warn-bg); color: var(--warn); padding: 0 2px; border-radius: 2px; }}
.shot {{ display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; min-height: 96px; border: 1px dashed var(--line); border-radius: 6px; color: var(--muted); font-size: 13px; text-align: center; padding: 10px; cursor: pointer; background: var(--panel); }}
.shot.drag {{ border-color: var(--accent); }}
.shot img {{ max-width: 100%; max-height: 320px; border: 1px solid var(--soft); border-radius: 4px; }}
.row {{ display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }}
button {{ height: 34px; padding: 0 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--ink); font: 500 13px system-ui, sans-serif; cursor: pointer; }}
button.go {{ height: 40px; padding: 0 16px; border: 0; background: var(--accent); color: var(--accent-ink); font-weight: 600; font-size: 14px; }}
.note {{ font-size: 12px; color: var(--muted); }}
.warn {{ font-size: 12px; color: var(--warn); }}
[hidden] {{ display: none !important; }}
</style>
</head>
<body>
<header><b>thimble</b><span>Share fix {id}</span></header>
<main>
<label>Title<input id="title" type="text" autocomplete="off"></label>
<label>Text<textarea id="body" spellcheck="true"></textarea></label>
<div class="took" id="took"></div>
<div class="shot" id="shot" tabindex="0" role="button" aria-label="Add your own screenshot">
  <span id="shot-empty">Add your own screenshot (it may show your data): choose, drop or paste an image</span>
  <img id="shot-img" alt="Your screenshot" hidden>
</div>
<input id="shot-file" type="file" accept="image/*" hidden>
<div class="row" id="shot-keys" hidden><button type="button" id="copy">Copy image</button><button type="button" id="drop">Remove</button><span class="note" id="copied"></span></div>
<div class="row"><button type="button" class="go" id="go">Open a GitHub issue</button></div>
<div class="warn" id="long" hidden></div>
<div class="note" id="next">GitHub opens its own page with this text filled in. Paste your screenshot there if you added one, and press Submit. Nothing leaves your computer until you press Submit there.</div>
</main>
<script id="data" type="application/json">{data}</script>
<script>
(function () {{
  var d = JSON.parse(document.getElementById('data').textContent);
  var $ = function (id) {{ return document.getElementById(id); }};
  var title = $('title'), body = $('body'), img = $('shot-img'), file = $('shot-file');
  title.value = d.title; body.value = d.body;
  var took = 'The privacy check ' + d.took + '.';
  $('took').textContent = took;
  if (d.marks.length) {{
    var t = $('took'); t.textContent = took + ' ';
    d.marks.forEach(function (m, i) {{ var x = document.createElement('mark'); x.textContent = m; t.appendChild(x); t.appendChild(document.createTextNode(i < d.marks.length - 1 ? ' ' : '')); }});
    t.appendChild(document.createTextNode(d.marks.length > 1 ? ' mark where.' : ' marks where.'));
  }}
  // encodeURIComponent, with the five characters it leaves that Python's quote() encodes, so both links are the same
  function enc(s) {{ return encodeURIComponent(s).replace(/[!'()*]/g, function (c) {{ return '%' + c.charCodeAt(0).toString(16).toUpperCase(); }}); }}
  function url(t, b) {{ return 'https://github.com/' + d.repo + '/issues/new?title=' + enc(t) + '&body=' + enc(b); }}
  // the link, with the text cut to fit under d.max characters: [link, how many characters of the text it holds]
  function link() {{
    var t = title.value.trim(), b = body.value;
    if (url(t, b).length <= d.max) return [url(t, b), b.length];
    var lo = 0, hi = b.length;
    while (lo < hi) {{ var mid = Math.ceil((lo + hi) / 2); if (url(t, b.slice(0, mid).replace(/\\s+$/, '') + '\\u2026').length <= d.max) lo = mid; else hi = mid - 1; }}
    return [url(t, b.slice(0, lo).replace(/\\s+$/, '') + '\\u2026'), lo];
  }}
  function check() {{
    var l = link(), long = $('long');
    long.hidden = l[1] >= body.value.length;
    if (!long.hidden) long.textContent = 'A GitHub link holds about ' + d.max.toLocaleString() + ' characters, so the issue gets the first ' + l[1].toLocaleString() + ' of ' + body.value.length.toLocaleString() + ' characters of the text. Shorten it here, or paste the rest on GitHub.';
  }}
  title.addEventListener('input', check); body.addEventListener('input', check); check();
  $('go').addEventListener('click', function () {{
    window.open(link()[0], '_blank', 'noopener,noreferrer');
    $('next').textContent = 'GitHub opened in a new tab with your text filled in. ' + (img.hidden ? '' : 'Paste your screenshot there (Copy image first if you copied something else). ') + 'Press Submit there to post it.';
  }});
  var blob = null;
  function show(f) {{
    if (!f || !/^image\\//.test(f.type)) return;
    blob = f; img.src = URL.createObjectURL(f); img.hidden = false; $('shot-empty').hidden = true; $('shot-keys').hidden = false; $('copied').textContent = '';
  }}
  $('shot').addEventListener('click', function () {{ file.click(); }});
  $('shot').addEventListener('keydown', function (e) {{ if (e.key === 'Enter' || e.key === ' ') {{ e.preventDefault(); file.click(); }} }});
  file.addEventListener('change', function () {{ show(file.files[0]); file.value = ''; }});
  $('shot').addEventListener('dragover', function (e) {{ e.preventDefault(); $('shot').classList.add('drag'); }});
  $('shot').addEventListener('dragleave', function () {{ $('shot').classList.remove('drag'); }});
  $('shot').addEventListener('drop', function (e) {{ e.preventDefault(); $('shot').classList.remove('drag'); show(e.dataTransfer.files[0]); }});
  document.addEventListener('paste', function (e) {{
    var items = (e.clipboardData && e.clipboardData.items) || [];
    for (var i = 0; i < items.length; i++) if (items[i].kind === 'file' && /^image\\//.test(items[i].type)) {{ e.preventDefault(); show(items[i].getAsFile()); return; }}
  }});
  $('drop').addEventListener('click', function () {{ blob = null; img.hidden = true; img.removeAttribute('src'); $('shot-empty').hidden = false; $('shot-keys').hidden = true; }});
  function png(b) {{
    // the clipboard takes PNG: any other image is drawn again as one
    if (b.type === 'image/png') return Promise.resolve(b);
    return new Promise(function (ok, no) {{
      var c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0); c.toBlob(function (x) {{ x ? ok(x) : no(new Error('no PNG')); }}, 'image/png');
    }});
  }}
  $('copy').addEventListener('click', function () {{
    if (!blob) return;
    var said = $('copied');
    if (!navigator.clipboard || !window.ClipboardItem) {{ said.textContent = 'This browser cannot copy images: right-click the image and copy it.'; return; }}
    png(blob).then(function (p) {{ return navigator.clipboard.write([new ClipboardItem({{ 'image/png': p }})]); }})
      .then(function () {{ said.textContent = 'Copied. Paste it on GitHub\\u2019s page.'; }},
            function () {{ said.textContent = 'Not copied: right-click the image and copy it.'; }});
  }});
}})();
</script>
</body>
</html>
"""


def page_html(data: dict[str, Any]) -> str:
    """The share page: the data as JSON in the page, with `<` escaped so no text of the draft can end the script."""
    blob = json.dumps(data, ensure_ascii=False).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    return PAGE.format(id=html.escape(str(data["id"])), data=blob)


def cmd(a) -> int:
    """thimble fix share ID [--json] [--no-open] [--draft -]: see cli.py FIX_HELP."""
    from .cli import out_json, stdin_text  # noqa: PLC0415

    try:
        given = None
        if a.draft == "-":
            raw = stdin_text(5.0)
            try:
                given = json.loads(raw) if raw.strip() else None
            except ValueError:
                raise FX.FixError("--draft - reads one JSON object: {\"title\", \"wrong\", \"fixed\"}")
        root = os.environ.get("THIMBLE_ROOT")
        st = Store(root, session=os.environ.get("THIMBLE_CONVERSATION")) if root else None
        r = share(a.id, given if isinstance(given, dict) else None, st, open_it=not a.no_open)
    except FX.FixError as e:
        print(f"thimble fix share: {e}", file=sys.stderr)
        return 1
    if a.json:
        out_json(r)
    else:
        print("\n".join(lines(r)))
    return 0

