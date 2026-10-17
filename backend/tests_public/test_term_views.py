"""Terminal views (app/term_views.py, app/term_kit): a view's view.term.js runs sandboxed, one process per open view, and
draws the view in thimble-term's panel. The sandbox lets it read no file and open no socket; the host answers its
reader queries through the views' reader calls and passes its acts on only with the frame that answers the analyst's
key or click; `draw_text` draws a view as text with no Claude Code, as each worked example shows at 120 columns. Reader calls run in this process (views._runner), so no kernel starts."""
from __future__ import annotations

import asyncio
import contextlib
import io
import json
import os
import re
import shutil
import socket
import sys
import tempfile
import threading
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from app import concepts, config, kernel_wrap, srt, term_views, views
from target_blocks import target_blocks  # noqa: F401 — the core lane's target flags, where prompts.py lacks them

NODE = srt.node()
SRT = srt.package(config.REPO_ROOT)
LINUX = sys.platform.startswith("linux")


def _works(wrap: str) -> bool:
    if NODE is None or (srt.node_version(NODE) or (0, 0)) < term_views.NODE_MIN:
        return False
    if wrap == "srt":
        return kernel_wrap.srt_works(NODE, SRT)
    if wrap == "bwrap":
        return LINUX and kernel_wrap.works()
    return wrap == "node"


SANDBOXES = [w for w in ("srt", "bwrap") if _works(w)]
# the wrap the drawing tests run their program in: a real sandbox where one runs, else Node's permission model alone
DRAW_WRAP = SANDBOXES[0] if SANDBOXES else "node"
needs_node = pytest.mark.skipif(not _works("node"), reason="needs Node 20.11 or later")

READER = """
def build_index(paths):
    rows = []
    for p in paths:
        with open(p) as fh:
            rows += [line.rstrip("\\n") for line in fh]
    return rows


def records(index, query):
    return {"rows": index, "asked": query}


def resolve(index, locator):
    return None
"""
HTML = "<!doctype html><div id=v></div>"
CORPUS = "board"


async def _inproc_run(c: str, code: str, timeout: float) -> tuple[list[dict], str]:
    buf = io.StringIO()
    here = os.getcwd()
    os.chdir(config.corpus_dir(c))
    try:
        with contextlib.redirect_stdout(buf):
            exec(code, {})  # noqa: S102 — the snippet the views kernel runs
    finally:
        os.chdir(here)
    return [{"text/plain": buf.getvalue(), "_stream": "stdout"}], "ok"


@pytest.fixture()
def inproc(monkeypatch):
    monkeypatch.setattr(views, "_runner", _inproc_run)
    views._bind_loop()


@pytest.fixture()
def board(tmp_path, monkeypatch, workspaces_tmp) -> Path:
    d = tmp_path / "data"
    (d / CORPUS).mkdir(parents=True)
    (d / CORPUS / "manifest.json").write_text(json.dumps({"name": CORPUS, "description": "a message board"}))
    (d / CORPUS / "board.jsonl").write_text("".join(json.dumps({"body": b}) + "\n" for b in ("first", "second", "third")))
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    return d / CORPUS


def _view(program: str, slug: str = "board") -> str:
    views.write_view(CORPUS, slug, name="Board", description="the board", scope=["board.jsonl"], reader=READER, html=HTML,
                     term=program)
    return slug


# ------------------------------------------------------------------------------------------------------ the sandbox

PROBE = r"""
import { draw } from 'thimble-term'
const got = {}
const tryIt = async (name, fn) => {
  try {
    const v = await fn()
    got[name] = `ALLOWED ${String(v).slice(0, 40)}`
  } catch (e) {
    got[name] = `denied ${e.code || e.name || e.message}`
  }
}
const connect = (how) => new Promise(async (ok, no) => {
  const net = await import('node:net')
  const s = net.connect(how)
  const t = setTimeout(() => { s.destroy(); no(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })) }, 3000)
  s.on('connect', () => { clearTimeout(t); s.destroy(); ok('connected') })
  s.on('error', (e) => { clearTimeout(t); no(e) })
})
await tryIt('read the secret', async () => (await import('node:fs')).readFileSync(SECRET, 'utf8'))
await tryIt('read /etc/passwd', async () => (await import('node:fs')).readFileSync('/etc/passwd', 'utf8'))
await tryIt('list the home', async () => (await import('node:fs')).readdirSync(HOME).join(','))
await tryIt('import the secret', async () => (await import(`file://${SECRET}`)))
await tryIt('write a file', async () => (await import('node:fs')).writeFileSync(`${HOME}/written-by-a-view`, 'x'))
await tryIt('start a process', async () => (await import('node:child_process')).execFileSync('/bin/echo', ['hi']).toString())
await tryIt('start a worker', async () => new (await import('node:worker_threads')).Worker('1', { eval: true }))
await tryIt('tcp to 127.0.0.1', () => connect({ host: '127.0.0.1', port: PORT }))
await tryIt('a unix socket', () => connect({ path: SOCK }))
await tryIt('http fetch', async () => (await fetch(`http://127.0.0.1:${PORT}/`)).status)
draw((d) => { for (const [k, v] of Object.entries(got)) d.line(`${k}: ${v}`) })
"""


class _Listener:
    """A TCP server on 127.0.0.1 and a Unix socket server that count the connections they accept: the host can reach
    both (the control), so a program that reaches neither was stopped by its sandbox."""

    def __init__(self) -> None:
        self.accepted = 0
        self.tcp = socket.create_server(("127.0.0.1", 0))
        self.port = self.tcp.getsockname()[1]
        self.dir = tempfile.mkdtemp(prefix="tv-test-", dir="/tmp" if Path("/tmp").is_dir() else None)
        self.path = os.path.join(self.dir, "s")
        self.unix = socket.socket(socket.AF_UNIX)
        self.unix.bind(self.path)
        self.unix.listen()
        self.open = True
        for s in (self.tcp, self.unix):
            s.settimeout(0.2)
            threading.Thread(target=self._accept, args=(s,), daemon=True).start()

    def _accept(self, s: socket.socket) -> None:
        while self.open:
            try:
                c, _ = s.accept()
            except (TimeoutError, socket.timeout):
                continue
            except OSError:
                return
            self.accepted += 1
            c.close()

    def close(self) -> None:
        self.open = False
        self.tcp.close()
        self.unix.close()
        shutil.rmtree(self.dir, ignore_errors=True)


@pytest.mark.parametrize("wrap", SANDBOXES or [pytest.param("srt", marks=pytest.mark.skip(reason="neither srt nor bubblewrap runs here"))])
async def test_a_view_program_can_read_no_file_open_no_socket_and_start_no_process(wrap, board, inproc, tmp_path):
    """In the sandbox a view's program reads no file (a secret beside the workspace, /etc/passwd, the home folder, by
    fs or by import), writes none, starts no process or worker, and reaches neither a TCP server on 127.0.0.1 nor a Unix
    socket, both of which the host reaches; its frame still arrives over stdout."""
    secret = tmp_path / "secret.txt"
    secret.write_text("the analyst's secret")
    home = Path.home()
    lis = _Listener()
    try:
        with socket.create_connection(("127.0.0.1", lis.port), timeout=2):
            pass
        with socket.socket(socket.AF_UNIX) as s:
            s.connect(lis.path)
        await asyncio.sleep(0.5)
        control = lis.accepted
        assert control == 2, "the host reaches both servers"
        program = (PROBE.replace("SECRET", json.dumps(str(secret))).replace("HOME", json.dumps(str(home)))
                   .replace("PORT", str(lis.port)).replace("SOCK", json.dumps(lis.path)))
        slug = _view(program)
        out = await term_views.draw_text(CORPUS, slug, cols=100, rows=20, wrap=wrap, panel=False)
        got = dict(line.strip().split(": ", 1) for line in out.splitlines() if ": " in line)
        assert set(got) == {"read the secret", "read /etc/passwd", "list the home", "import the secret", "write a file",
                            "start a process", "start a worker", "tcp to 127.0.0.1", "a unix socket", "http fetch"}, out
        assert all(v.startswith("denied") for v in got.values()), out
        assert lis.accepted == control, "no connection reached the servers from the sandbox"
        assert not (home / "written-by-a-view").exists()
    finally:
        lis.close()


def test_the_sandbox_gives_no_network_hides_the_user_s_folders_and_lets_node_read_only_the_kit(monkeypatch, tmp_path):
    """srt's settings refuse every host and hide the home folder, thimble's folders and the temp folders, showing only
    the kit, Node and srt's seccomp helper; bubblewrap shares no network and binds the kit read-only with a clean
    environment; Node's permission model reads the kit's folder alone."""
    if NODE is None:
        pytest.skip("needs node")
    kit = str(term_views._real(term_views.KIT_DIR))
    flags = term_views.node_flags(NODE)
    assert flags[0] in ("--permission", "--experimental-permission")
    assert [f for f in flags if f.startswith("--allow-")] == [f"--allow-fs-read={kit}{os.sep}"]
    monkeypatch.setattr(kernel_wrap, "srt_works", lambda node, pkg: pkg is not None)
    if SRT is not None:
        wrap, argv, env, tmp = term_views.sandbox_argv("srt")
        try:
            settings = json.loads(Path(argv[argv.index("--settings") + 1]).read_text())
            assert settings["network"] == {"allowedDomains": [], "deniedDomains": []}
            deny = set(settings["filesystem"]["denyRead"])
            assert str(term_views._real(Path.home())) in deny or any(str(term_views._real(Path.home())).startswith(d) for d in deny)
            assert settings["filesystem"]["allowWrite"] == []
            assert set(settings["filesystem"]["allowRead"]) <= {kit, str(term_views._real(NODE).parent), str(term_views._real(SRT / "vendor" / "seccomp"))}
            assert argv[argv.index("--") + 1:][:2] == [NODE, flags[0]]
            # the program's environment: a few of the caller's (no key, no login) and srt's own folders
            assert set(env) <= {*term_views.ENV_KEEP, "HOME", "TMPDIR", "CLAUDE_CODE_TMPDIR"}
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    wrap, argv, env, tmp = term_views.sandbox_argv("bwrap")
    assert wrap == "bwrap" and tmp is None
    assert "--unshare-all" in argv and "--share-net" not in argv and "--clearenv" in argv
    i = argv.index(kit)
    assert argv[i - 1] == "--ro-bind" and argv[i + 1] == kit
    assert "--bind" not in argv, "nothing is writable but the sandbox's own /tmp"


def test_no_sandbox_no_view(monkeypatch):
    """Where neither srt nor bubblewrap runs, no view program runs: the panel says why."""
    monkeypatch.setattr(kernel_wrap, "srt_works", lambda node, pkg: False)
    monkeypatch.setattr(kernel_wrap, "works", lambda: False)
    if NODE is None:
        with pytest.raises(term_views.SandboxError, match="Node"):
            term_views.sandbox_argv()
        return
    with pytest.raises(term_views.SandboxError, match="neither thimble's sandbox runtime nor bubblewrap"):
        term_views.sandbox_argv()


# ------------------------------------------------------------------------------------------------------ the protocol

PROGRAM = r"""
import { draw, fetch, keep, kept, open } from 'thimble-term'
let rows = null
let presses = Number(kept('presses') || 0)
fetch({ op: 'all' }).then((got) => { rows = got.rows })
setTimeout(() => { try { open('board.jsonl#L9') } catch (e) { console.log(`refused: ${e.message}`) } }, 10)
draw((d) => {
  d.line(`presses ${presses}`)
  for (const r of rows || ['◌ reading']) d.line(r)
  d.key('o', 'to open its place', () => { presses++; keep('presses', presses); open('board.jsonl#L1') })
})
"""


@needs_node
async def test_a_program_draws_after_its_answer_and_an_act_comes_only_with_the_key_that_made_it(board, inproc):
    """The first frame comes before the reader answers, a frame the program draws on its own follows the answer; the
    frame that answers a key acknowledges it, with the act the key made; an act asked from a timer is refused; what the
    program keeps is kept for the view and given back at its next opening."""
    slug = _view(PROGRAM)
    pushed: list[dict] = []
    p = term_views.Program(CORPUS, slug, push=lambda pid, m: pushed.append(m), wrap=DRAW_WRAP)
    try:
        first = await p.start(60, 10, text="plain")
        assert first["text"].splitlines()[0].strip() == "presses 0"
        await p.settle()
        assert any("second" in (m["frame"].get("text") or "") for m in pushed if m["t"] == "frame"), pushed
        assert p.frame["hints"] == ["o to open its place"] and p.frame["keys"] == ["o"]
        got = await p.event({"t": "key", "key": "o"})
        assert got["frame"]["ack"] == p.n
        assert got["frame"]["text"].splitlines()[0].strip() == "presses 1"
        assert got["acts"] == [{"kind": "open", "ref": "board.jsonl#L1"}]
        assert any("refused: open() works only during the analyst's own click or key" in line for line in p.logs), p.logs
        await asyncio.sleep(0.2)
        assert term_views.read_state(CORPUS, slug) == {"presses": 1}
    finally:
        await p.close()
    again = term_views.Program(CORPUS, slug, wrap=DRAW_WRAP)
    try:
        assert (await again.start(60, 10, text="plain"))["text"].splitlines()[0].strip() == "presses 1"
    finally:
        await again.close()
    # draw_text draws the view as it opens (not on the kept 1) and keeps nothing
    out = await term_views.draw_text(CORPUS, slug, cols=60, rows=10, keys=["o", "o"], wrap=DRAW_WRAP)
    assert "presses 2" in out and term_views.read_state(CORPUS, slug) == {"presses": 1}


@needs_node
async def test_the_host_serves_thimble_term_over_its_socket_with_its_token(board, inproc, monkeypatch, capsys):
    """`thimble view host`: a ready line naming a socket in a private folder and a token; a request without the token is
    refused; /open answers the first frame, /event the frame that answers it with its acts, /close ends the program."""
    slug = _view(PROGRAM)
    real = term_views.Program
    monkeypatch.setattr(term_views, "Program", lambda *a, **k: real(*a, **{**k, "wrap": DRAW_WRAP}))
    host = term_views.Host(CORPUS)
    task = asyncio.ensure_future(host.serve())
    from app import view_calls

    kernel = view_calls.KERNEL
    try:
        ready = None
        for _ in range(100):
            await asyncio.sleep(0.05)
            out = capsys.readouterr().out
            ready = next((json.loads(x) for x in out.splitlines() if '"ready"' in x), None)
            if ready:
                break
        assert ready and ready["t"] == "ready"
        assert oct(os.stat(os.path.dirname(ready["socket"])).st_mode & 0o777) == "0o700"

        async def post(path: str, body: dict, token: str | None = ready["token"]) -> tuple[int, dict]:
            r, w = await asyncio.open_unix_connection(ready["socket"])
            data = json.dumps(body).encode()
            head = f"POST {path} HTTP/1.1\r\nHost: thimble-views\r\nContent-Length: {len(data)}\r\n"
            if token:
                head += f"x-thimble-token: {token}\r\n"
            w.write(head.encode() + b"\r\n" + data)
            await w.drain()
            raw = await r.read()
            w.close()
            status = int(raw.split(b" ", 2)[1])
            return status, json.loads(raw.split(b"\r\n\r\n", 1)[1])

        assert (await post("/open", {"slug": slug}, token="wrong"))[0] == 403
        status, opened = await post("/open", {"slug": slug, "cols": 60, "rows": 10})
        assert status == 200 and opened["id"] and opened["frame"]["lines"]
        status, got = await post("/event", {"id": opened["id"], "event": {"t": "key", "key": "o"}})
        assert got["acts"] == [{"kind": "open", "ref": "board.jsonl#L1"}]
        assert (await post("/event", {"id": opened["id"], "event": {"t": "nope"}}))[1] == {"error": "no such event"}
        assert (await post("/close", {"id": opened["id"]}))[1] == {"ok": True}
        assert (await post("/event", {"id": opened["id"], "event": {"t": "key", "key": "o"}}))[1] == {"error": "the view is not open"}
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
    assert view_calls.KERNEL == kernel, "the host's own kernels' name is its own while it serves"


COLOR_PROGRAM = """
import { colorBy, draw } from 'thimble-term'
const color = colorBy({ fields: [{ name: 'kind', title: 'Kind', values: ['note'] }], initial: 'kind' })
draw((d) => color.draw(d))
"""


@needs_node
async def test_a_view_opens_on_its_own_field_while_the_label_on_marks_none_of_its_records(board, inproc):
    """A label on in Files whose run marked none of the view's records (a regex that found nothing) colors no row, so
    the view opens on its `initial` field, not on the label with no record marked; a label on that marks one takes it."""
    app = FastAPI()
    app.include_router(concepts.router, prefix="/api")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t", timeout=180) as api:
        async def label(name: str, pattern: str) -> None:
            r = await api.post(f"/api/ws/{CORPUS}/concepts", json={"name": name, "kind": "regex", "spec": pattern})
            assert r.status_code == 200, r.text
            cid = r.json()["id"]
            r = await api.post(f"/api/ws/{CORPUS}/concepts/{cid}/apply", json={"paths": ["board.jsonl"], "wait": True})
            assert r.status_code == 200, r.text
            concepts.show_concept(CORPUS, cid, True)

        slug = _view(COLOR_PROGRAM)
        await label("zebra sightings", r"zebra")
        out = await term_views.draw_text(CORPUS, slug, cols=80, rows=4, wrap=DRAW_WRAP)
        assert "Color by  Kind" in out and "zebra sightings" not in out, out
        await label("second posts", r"second")
        out = await term_views.draw_text(CORPUS, slug, cols=80, rows=4, wrap=DRAW_WRAP)
        assert "Color by  second posts" in out, out


# ------------------------------------------------------------------------------------------------------ Timeline


def _split(lines: list[str], head: int, rows: int) -> tuple[list[str], str]:
    """A panel drawn as text: its body (`rows` rows after `head` rows of header) and its hint row, one row."""
    body = lines[head:head + rows]
    assert len(body) == rows
    rest = [x.strip() for x in lines[head + rows:]]
    assert len(rest) == 1 and rest[0], "the hint row, one row, follows the body"
    return body, rest[0]


def _key_list(out: str) -> list[list[str]]:
    """The list `?` opens, drawn as text: each row's keys and their words."""
    return [re.split(r"\s{2,}", x.strip(" │")) for x in out.splitlines() if x.startswith("  │")]


@pytest.fixture()
def timeline(workspaces_tmp, tmp_path, monkeypatch, inproc) -> str:
    """The worked example Timeline saved as a view of its own sample, with its terminal program."""
    d = tmp_path / "data"
    shutil.copytree(views.EXAMPLES_DIR / "timeline" / "sample", d / "timeline")
    (d / "timeline" / "manifest.json").write_text(json.dumps({"name": "timeline", "description": "an example's sample"}))
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    src = views.EXAMPLES_DIR / "timeline"
    raw = json.loads((src / "view.json").read_text("utf-8"))
    views.write_view("timeline", "timeline", reader=(src / "reader.py").read_text("utf-8"),
                     html=(src / "view.html").read_text("utf-8"), term=(src / "view.term.js").read_text("utf-8"),
                     **{k: raw.get(k) for k in ("name", "description", "scope", "records", "accepts", "units", "libs")})
    return "timeline"


@needs_node
@pytest.mark.parametrize("cols", [120])
async def test_timeline_draws_what_its_browser_page_shows(timeline, cols):
    """The worked example at 120 and 200 columns: the search and Filter by on Incident with its values as toggles; Rows
    on Source, then Color by, Off as the view opens, and with Service chosen its chips; the time range's readout and strip, a lane per source, and the axis alone
    (no key of failed events, no incidents' flags); then what the list shows and how many, its columns' headings, and
    the events with no day's heading between them, each with its time (a day's first with its date), source, kind,
    actor, incident and text; its hint row names
    ↑↓, Enter and `?`, which lists the keys of the controls the top row shows."""
    out = await term_views.draw_text(timeline, "timeline", cols=cols, rows=36, wrap=DRAW_WRAP)
    lines = out.splitlines()
    assert lines[0] == "  Timeline"
    body, hints = _split(lines, 2, 36)
    assert all(len(x) <= cols + 2 for x in body)
    assert body[0].startswith("  / search events  Filter by  Incident  ● INC-312 100  ● INC-313 23  ● INC-311 11  ● no incident 64")
    assert body[1] == "  Rows  Source  Color by  Off"
    assert body[2] == "  May 16 01:14 – May 19 14:25 · 3d 13h"
    assert [x[2:12].strip() for x in body[4:9]] == ["alert", "deploy", "agent", "chat", "ticket"]
    assert body[9].startswith(" " * 12) and "May 17 00:00" in body[9] and "May 18 00:00" in body[9]
    assert "failed" not in "\n".join(body[:11]) and "INC-311" not in "\n".join(body[2:11])
    assert body[10] == ""
    assert body[11] == "  In the range  198 events"
    assert body[12].split() == ["time", "source", "kind", "actor", "incident", "text"]
    assert body[13].startswith("❯ ● May 16 01:40:12  chat    message      Oona")
    assert body[14].startswith("  ●        02:00:05  deploy  started      deploybot")
    assert not any(re.match(r"\s*(Sat|Sun|Mon|Tue), May \d+", x) for x in body[13:]), "no day's heading breaks the list"
    assert "02:57:20  alert   fired        monitor     INC-311   payments: database connections at 181 of 200 for 5 min" in body[20]
    if cols == 200:
        assert "Tonight's release train: web 2.31.0 and payments 4.12.0. deploybot starts at 02:00." in body[13]
    assert hints == "↑↓ to choose · Enter to open · ? for all keys · b to go back · x to close"
    out = await term_views.draw_text(timeline, "timeline", cols=cols, rows=36, wrap=DRAW_WRAP, keys=["c", "click:Service"])
    body, _ = _split(out.splitlines(), 2, 36)
    assert body[1].startswith("  Rows  Source  Color by  Service  ● payments 79  ● web 45")
    out = await term_views.draw_text(timeline, "timeline", cols=cols, rows=36, wrap=DRAW_WRAP, keys=["?"], panel=False)
    assert out.splitlines()[0].startswith("  ╭─ keys ─")
    assert _key_list(out) == [["↑↓", "to choose"], ["Enter", "to open"], ["c", "to color by"], ["/", "to search"],
                              ["f", "to filter by"], ["g", "for rows"], ["a", "to ask"]]


# ------------------------------------------------------------------------------------------------------ Linked sessions


@pytest.fixture()
def linked(workspaces_tmp, tmp_path, monkeypatch, inproc) -> str:
    """The worked example Linked sessions saved as a view of its own sample, with its terminal program."""
    d = tmp_path / "data"
    shutil.copytree(views.EXAMPLES_DIR / "linked-sessions" / "sample", d / "linked")
    (d / "linked" / "manifest.json").write_text(json.dumps({"name": "linked", "description": "an example's sample"}))
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    src = views.EXAMPLES_DIR / "linked-sessions"
    raw = json.loads((src / "view.json").read_text("utf-8"))
    views.write_view("linked", "linked-sessions", reader=(src / "reader.py").read_text("utf-8"),
                     html=(src / "view.html").read_text("utf-8"), term=(src / "view.term.js").read_text("utf-8"),
                     **{k: raw.get(k) for k in ("name", "description", "scope", "records", "accepts", "units", "libs")})
    return "linked"


def _axis(body: list[str]) -> int:
    """The axis under the lanes: the first row after the time range's strip with a blank gutter, where no key stands."""
    top = next(i for i, x in enumerate(body) if re.match(r"\s+\w{3} \d+ \d\d:\d\d", x)) + 2
    return next(i for i in range(top, len(body)) if body[i].strip() and not body[i][:12].strip())


def _tree(body: list[str]) -> list[str]:
    """The lanes' names, from the row under the time range's strip to the axis."""
    top = next(i for i, x in enumerate(body) if re.match(r"\s+\w{3} \d+ \d\d:\d\d", x)) + 2
    return [re.match(r"\s*\S+(?: \S+)*", x[2:])[0] for x in body[top:_axis(body)]]


@needs_node
@pytest.mark.parametrize("cols", [120])
async def test_linked_sessions_draws_what_its_browser_page_shows(linked, cols):
    """The worked example at 120 and 200 columns: the top row (search, Filter by, Rows, Color by with its chips), the
    time range's readout and its strip broken where the runs lie hours apart, each run's sessions as a tree of lanes (a
    lead, the subagents it started under it with their guides), the axis alone (no key of the failed calls: a failed
    call is × in red on its lane and before its tool in the transcript), what links the lead read to the others, then
    its transcript under a title that names it and counts its turns: the user's prompt, each tool call on one line, a
    Task call naming the subagent it started; its hint row names ↑↓, Enter, its own n p and `?`."""
    out = await term_views.draw_text(linked, "linked-sessions", cols=cols, rows=40, wrap=DRAW_WRAP)
    lines = out.splitlines()
    assert lines[:2] == ["  Linked sessions", "  3 runs · 17 sessions · 352 turns"]
    body, hints = _split(lines, 3, 40)
    assert all(len(x) <= cols + 2 for x in body)
    assert body[0].startswith("  / search  Filter by  none  Rows  Session  Color by  Off")
    chosen = await term_views.draw_text(linked, "linked-sessions", cols=cols, rows=40, wrap=DRAW_WRAP, keys=["c", "click:Speaker"])
    assert _split(chosen.splitlines(), 3, 40)[0][0].startswith("  / search  Filter by  none  Rows  Session  Color by  Speaker  ● client-port 100  ● lead 63")
    assert body[1] == "  Sep 12 14:02 – Sep 13 09:53 · 19h 51m"
    assert body[2].count(" // ") == 2
    assert _tree(body) == [
        "▾ Run 1 · lead", "  ├ survey", "  ├ client-port", "  │ ├ pagination", "  │ └ auth-headers", "  ├ webhooks",
        "  └ test-runner", "▾ Run 2 · lead", "  ├ client-port", "  ├ webhooks", "  └ test-runner", "▾ Run 3 · lead",
        "  ├ survey", "  ├ client-port", "  ├ webhooks", "  ├ reviewer", "  └ reviewer 2"]
    # each run's lanes stand in its own stretch of the axis: Run 2's start after the first break, Run 3's after the second
    breaks = [i for i in range(len(body[2])) if body[2][i:i + 4] == " // "]
    assert body[3][22:breaks[0]].strip() and not body[10][22:breaks[0]].strip() and body[10][breaks[0]:breaks[1]].strip()
    axis = _axis(body)
    assert body[axis].count("//") == 2 and "Sep 12 14:15" in body[axis] and "Sep 13 09:15" in body[axis]
    assert "failed" not in "\n".join(body[:axis + 1]), "no key of the failed calls"
    assert any("×" in x[22:] for x in body[3:axis]), "a failed call is × on its lane"
    assert body[axis + 1] == ""
    assert body[axis + 2].startswith("  lead of Run 1 · nested team · subagents survey 14:03:10, client-port 14:09:05, webhooks 14:09:06")
    assert body[axis + 3].startswith("  lead · Run 1 · nested team  20 turns · 14:02:00 – 14:46:10")
    rows = [re.sub(r"\s*▌*$", "", x) for x in body[axis + 4:]]
    assert rows[:2] == ["  Sep 12, 2026", "❯ 14:02:00  ● user"]
    assert rows[2].strip().startswith("Upgrade invoicer from Brambleway API v2 to v3.")
    assert "  14:03:10  ⎿ Task → survey Find every v2 call site" in rows
    assert "  14:30:20  ⎿ × Bash pytest -q" in rows, "a failed call's row gives × before its tool"
    assert hints == "↑↓ to choose · Enter to open · n p for the next or previous lane · ? for all keys · b to go back · x to close"


# ------------------------------------------------------------------------------------------------------ Repository


@pytest.fixture()
def repository(workspaces_tmp, tmp_path, monkeypatch, inproc) -> str:
    """The worked example Repository saved as a view of its own sample, with its terminal program."""
    d = tmp_path / "data"
    shutil.copytree(views.EXAMPLES_DIR / "repository" / "sample", d / "repository")
    (d / "repository" / "manifest.json").write_text(json.dumps({"name": "repository", "description": "an example's sample"}))
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    src = views.EXAMPLES_DIR / "repository"
    raw = json.loads((src / "view.json").read_text("utf-8"))
    views.write_view("repository", "repository", reader=(src / "reader.py").read_text("utf-8"),
                     html=(src / "view.html").read_text("utf-8"), term=(src / "view.term.js").read_text("utf-8"),
                     **{k: raw.get(k) for k in ("name", "description", "scope", "records", "accepts", "units", "libs")})
    return "repository"


@needs_node
@pytest.mark.parametrize("cols", [120])
async def test_repository_draws_what_its_browser_page_shows(repository, cols):
    """The worked example at 120 and 200 columns, one run's repository as a code forge's command line draws it: the
    repository's head (the run switcher with the run's name, and the run's facts), the tabs with the run's counts, the
    top row (search, Filter by, Color by, Off as the view opens, with its chips once State is chosen), no time range, the
    columns' names, then a row per pull request
    of that run alone: its number, its title, its area, state, comments and lines, and under it the dim line a forge
    writes there."""
    out = await term_views.draw_text(repository, "repository", cols=cols, rows=16, wrap=DRAW_WRAP)
    lines = out.splitlines()
    assert lines[0] == "  Repository"
    body, hints = _split(lines, 2, 16)
    assert all(len(x) <= cols + 2 for x in body)
    assert body[0] == "  run  r1  3 agents · 1 approval to merge · Mon, May 11, 2026"
    assert body[1].split() == ["pull", "requests", "8", "issues", "9", "discussions", "3", "agents", "3"]
    assert body[2].startswith("  / search  Filter by  none  Color by  Off")
    assert body[3] == ""
    assert body[4].split() == ["pull", "request", "area", "state", "comments", "lines"]
    assert re.match(r"❯ ● #9   Treat 'next <weekday>' as never today +parser +merged +0 +\+1 -1", body[5])
    assert body[6].strip(" ▌").startswith("opened 09:24 by ash · fixes #1 · approved · merged by its author")
    eleven = next(i for i, x in enumerate(body) if x.startswith("  ● #11  Keep wall-clock"))
    assert body[eleven + 1].strip().startswith("opened 09:50 by cedar · fixes #3 · changes requested · merged by its author")
    assert not any(" // " in x or re.search(r"\d May \d\d:\d\d –", x) for x in body), "no time range"
    assert hints.startswith("↑↓ to choose · Enter to open") and hints.endswith("b to go back · x to close"), hints
    assert "? for all keys" in hints and "to pan" not in hints and "to zoom" not in hints, hints
    chosen = await term_views.draw_text(repository, "repository", cols=cols, rows=16, wrap=DRAW_WRAP, keys=["c", "click:State"])
    assert _split(chosen.splitlines(), 2, 16)[0][2].startswith("  / search  Filter by  none  Color by  State  ● merged 7  ● closed 1")


# ------------------------------------------------------------------------------------------------------ narrow panels


@needs_node
@pytest.mark.parametrize("example, parts", [("timeline", ["Color by", "Filter by", "Rows"]),
                                            ("linked", ["Color by", "Filter by", "Rows"]),
                                            ("repository", ["Color by", "Filter by"])])
async def test_each_worked_example_draws_every_choice_of_its_controls(example, parts, request):
    """The checks' sweep (draw_check with `sweep`, Program.sweep): with the test label on, each worked example is drawn
    on every choice of the kit's controls it draws, Color by's Off and the None of Filter by and Rows among them, the
    test label too, then each control's first choice again after the others, and no choice gives an error."""
    c = request.getfixturevalue(example)
    slug = {"timeline": "timeline", "linked": "linked-sessions", "repository": "repository"}[example]
    d = await term_views.draw_check(c, slug, cols=120, theme="light", sweep=True, wrap=DRAW_WRAP)
    assert d["ok"], d
    tried = [(x["control"], x["choice"]) for x in d["choices"]]
    assert sorted({p for p, _ in tried}) == sorted(parts), tried
    assert ("Color by", "Off") in tried and ("Color by", term_views.probe_label()["name"]) in tried, tried
    for p in parts:
        first = next(ch for q, ch in tried if q == p)
        assert first == ("Off" if p == "Color by" else "None") and (p, f"{first} (after the others)") in tried, tried
    assert not [x for x in d["choices"] if x["errors"]], d["choices"]
