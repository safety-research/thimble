"""The card harness (app/render.py): where its page comes from, the request it sends, the theme the browser reports,
and the warm pool driving a headless Chromium. The pool's tests use a stand-in render page written here (the same
`window.__thimbleRender` contract as frontend/src/render.tsx), so they test the Python side alone; the real page's
drawing is the frontend suite's. They skip where no Chromium is installed (`playwright install chromium`)."""
import asyncio
import io
import sys

import pytest

from app import config, render

C = "mini"

# A page with the render contract: it draws a box of the requested width holding the card's question, and hangs when
# asked to, so the timeout and the page's replacement can be seen.
STAND_IN = """<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
<script>
let n = 0
window.__thimbleRender = {
  ready: true,
  render: async (req) => {
    n += 1
    document.body.innerHTML = ''
    const card = document.createElement('article')
    card.id = 'card'
    card.style.cssText = `position:absolute;left:16px;top:16px;width:${req.width}px;padding:10px;box-sizing:border-box;background:#fdfcf8;font:14px sans-serif`
    card.textContent = req.card.title
    document.body.appendChild(card)
    if (req.card.title === 'hang') await new Promise(() => {})
    const r = card.getBoundingClientRect()
    return { box: { x: r.left, y: r.top, width: r.width, height: r.height }, fonts: true, requests: [], ms: { settle: 1 }, n, theme: req.theme }
  },
}
</script></body></html>"""


def _chromium_missing() -> str | None:
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
    except ImportError:
        return "Playwright is not installed"
    from app import cli

    base = cli.playwright_browsers_dir()
    return None if any(base.glob("chromium_headless_shell-*")) or any(base.glob("chromium-*")) else "no Chromium for Playwright"


@pytest.fixture()
def page_dir(tmp_path, monkeypatch):
    d = tmp_path / "dist"
    d.mkdir()
    (d / "render.html").write_text(STAND_IN, "utf-8")
    (d / "secret.txt").write_text("inside", "utf-8")
    (tmp_path / "outside.txt").write_text("outside", "utf-8")
    monkeypatch.setenv("THIMBLE_RENDER", "on")
    monkeypatch.setenv("THIMBLE_RENDER_DIR", str(d))
    monkeypatch.delenv("THIMBLE_RENDER_URL", raising=False)
    monkeypatch.delenv("THIMBLE_DEV", raising=False)
    return d


def _card(title="How many?", **extra) -> dict:
    return {"id": "abcd1234", "notebook": "main", "kind": "plot", "title": title, "takeaway": "", "outputs": [],
            "status": "ok", "created_by": "terminal", "ts": "2026-09-24T00:00:00Z", **extra}


def _request(card: dict, width: int = 720) -> dict:
    return {"ws": C, "card": card, "citations": {}, "names": [], "theme": dict(render.DEFAULT_THEME), "width": width}


# ----------------------------------------------------------------------------- where the page comes from


def test_the_page_comes_from_the_render_url_then_dev_vite_then_the_built_ui(monkeypatch, tmp_path):
    monkeypatch.delenv("THIMBLE_RENDER_URL", raising=False)
    monkeypatch.delenv("THIMBLE_RENDER_DIR", raising=False)
    monkeypatch.delenv("THIMBLE_DEV", raising=False)
    monkeypatch.setattr(config, "FRONTEND_DIST", tmp_path)
    assert render.page_source() == (f"{render.RENDER_ORIGIN}/render.html", tmp_path), "the built UI, served from memory"
    monkeypatch.setenv("THIMBLE_DEV", "1")
    monkeypatch.setenv("THIMBLE_FRONTEND_URL", "http://127.0.0.1:5399/")
    assert render.page_source() == ("http://127.0.0.1:5399/render.html", None), "dev mode: the launcher's Vite"
    monkeypatch.setenv("THIMBLE_RENDER_URL", "http://127.0.0.1:5411/render.html")
    assert render.page_source() == ("http://127.0.0.1:5411/render.html", None)


def test_only_files_inside_the_page_folder_are_served(page_dir):
    assert render._serve_path(page_dir, f"{render.RENDER_ORIGIN}/render.html") == (page_dir / "render.html").resolve()
    assert render._serve_path(page_dir, f"{render.RENDER_ORIGIN}/secret.txt") is not None
    assert render._serve_path(page_dir, f"{render.RENDER_ORIGIN}/../outside.txt") is None
    assert render._serve_path(page_dir, f"{render.RENDER_ORIGIN}/%2e%2e/outside.txt") is None
    assert render._serve_path(page_dir, f"{render.RENDER_ORIGIN}/missing.js") is None


def test_the_page_reaches_only_this_machine_by_its_exact_host_and_is_served_under_the_app_s_policy(page_dir):
    for url in ("http://127.0.0.1:8300/api/x", "http://localhost:5300/src/x.ts", f"{render.RENDER_ORIGIN}/assets/a.js",
                "http://[::1]:8300/"):
        assert render.stays_local(url), url
    for url in ("http://localhost.evil.example/x", "http://127.0.0.1.nip.io/x", "https://thimble.render.evil.example/",
                "http://localhost@evil.example/", "https://fonts.googleapis.com/css2", "http://[bad/"):
        assert not render.stays_local(url), url

    class Route:
        def __init__(self, url: str) -> None:
            self.request = type("R", (), {"url": url})()
            self.done: tuple = ()

        async def fulfill(self, **kw):
            self.done = ("fulfill", kw)

        async def abort(self):
            self.done = ("abort",)

        async def fallback(self):
            self.done = ("fallback",)

    served = Route(f"{render.RENDER_ORIGIN}/render.html")
    asyncio.run(render._fulfil(served, page_dir))
    assert served.done[1]["headers"]["content-security-policy"] == render.APP_CSP
    for url, want in (("http://localhost.evil.example/x", "abort"), (f"{render.RENDER_ORIGIN}/render.html", "fallback"),
                      ("data:text/plain,x", "fallback")):
        r = Route(url)
        asyncio.run(render._keep_local(r))
        assert r.done == (want,), url


def test_a_clip_is_snapped_outward_to_whole_pixels():
    assert render._clip({"x": 16.4, "y": 10.6, "width": 720.2, "height": 99.1}) == {"x": 16, "y": 10, "width": 721, "height": 100}


# ----------------------------------------------------------------------------- the request


def test_the_refs_a_card_cites_are_its_takeaway_s_and_its_examples_each_once():
    cell = _card(takeaway="queue a has [[3,861|card:abcd1234#Tickets/a]] of [[4,512|card:abcd1234#Tickets/all%20four]] "
                          "tickets (see [[events.jsonl#L3]] and [[3,861|card:abcd1234#Tickets/a]])",
                 payload={"refs": ["events.jsonl#L3", "tickets.jsonl#L9"]})
    assert render.cited_refs(cell) == ["card:abcd1234#Tickets/a", "card:abcd1234#Tickets/all%20four", "events.jsonl#L3",
                                       "tickets.jsonl#L9"]


def test_the_request_carries_the_card_at_rest_its_refs_resolved_names_theme_and_width(workspaces_tmp):
    cell = _card(takeaway="see [[agents/agent-01.jsonl#L1]] and [[nowhere.jsonl#L1]]", width=500,
                 check={"id": "chk_1", "status": "pending"}, candidate=True, fixes=[{"id": "fix_1", "state": "applied"}])
    req = render.request_for(C, cell)
    assert "check" not in req["card"] and "candidate" not in req["card"], "the check drawing it is not the card"
    assert "fixes" not in req["card"], "an earlier check's fixes draw its mark, which is not the card"
    assert set(req) == {"ws", "card", "citations", "names", "labels", "theme", "width"}
    assert req["labels"] == []
    assert req["width"] == 500 and render.request_for(C, _card())["width"] == render.CARD_W
    assert set(req["citations"]) == {"agents/agent-01.jsonl#L1", "nowhere.jsonl#L1"}
    assert req["citations"]["agents/agent-01.jsonl#L1"].get("excerpt"), "resolved as GET /corpora/{c}/ref answers"
    bad = req["citations"]["nowhere.jsonl#L1"]
    assert bad["status"] == 404 and bad["error"], "a ref that does not resolve is answered with the API's status"
    assert req["theme"] == render.DEFAULT_THEME
    assert req["names"] == [{"id": "abcd1234", "notebook": "main", "title": "How many?"}], "its own name, for its chips"


async def test_a_label_card_s_request_carries_its_label_its_first_rows_per_value_and_the_settings(workspaces_tmp):
    """A label card's face reads its label from the API, which the render page never calls, so the request carries the
    label as GET /concepts/{id} returns it, the first rows of each value as GET /concepts/{id}/rows?text=1 returns
    them, a regex's rows with the words around its match, and the settings (render.tsx answers those calls from it)."""
    from app import concepts, notebook

    s = await concepts.apply_scoped(C, scope="files", name="claims", kind="regex", text=r"(?i)forge pr claim",
                                    values=["claim", "other"], paths=["board.jsonl"], limit=None, comment=False,
                                    filter=False, created_by="terminal", chat=None, group=None)
    card = notebook.get_cell(C, s["cell"])
    req = render.request_for(C, card)
    label = req["label"]
    assert label["concept"]["id"] == s["concept"] and label["concept"]["counts"] == {"claim": 3, "other": 5}
    assert list(label["rows"]) == ["claim", "other"] and [len(r) for r in label["rows"].values()] == [3, 3]
    claim = label["rows"]["claim"][0]
    assert claim["ref"].startswith("board.jsonl#L") and claim["label"] == "claim"
    assert claim["match"].lower() == "forge pr claim" and claim["match"] in claim["text"], "the words that earned the value"
    assert "match" not in label["rows"]["other"][0], "a record the regex did not match has no match"
    assert isinstance(label["settings"], dict)
    assert render.label_data(C, _card()) is None and "label" not in render.request_for(C, _card())
    gone = {**card, "payload": {"concept": "nothere1"}}
    assert render.label_data(C, gone) is None, "a label that is gone draws without its label"
    # the labels a card uses, for the tags in the Labels row under its question: each one's name and what its colour is
    # read from (a label over files has one); a label that is gone draws no tag
    tag = {"id": s["concept"], "name": "claims", "unit": "record", "marks": "record", "labels": ["claim", "other"]}
    assert len(req["labels"]) == 1 and {k: req["labels"][0][k] for k in tag} == tag
    assert [(c["name"], c["color"]) for c in req["labels"][0]["classes"]] == [("claim", 1), ("other", 0)]
    uses = render.request_for(C, _card(labels=[s["concept"], "nothere1"]))
    assert [x["id"] for x in uses["labels"]] == [s["concept"]]


def test_a_call_citation_s_request_carries_the_call_as_its_route_returns_it(workspaces_tmp):
    """A call citation's preview reads the call's whole output from GET /ws/{c}/calls/{chat}/{n}, which the render page
    never calls, so the request carries each cited call (render.tsx answers that route from it); a card citing none
    carries no `calls`, and a call not in the store is left out."""
    from app import calls

    calls.number(C, "orch0001", "t1", "Bash", {"command": "python count.py"}, at="orch0001")
    calls.result(C, "orch0001", "t1", "rows 12\ncaptcha 5\n")
    cell = _card(takeaway="[[5|call:orch0001/1#L2]] of [[12|call:orch0001/1#L1]] rows, and [[call:orch0001/9]]")
    req = render.request_for(C, cell)
    assert set(req["calls"]) == {"orch0001/1"}, "each call once; one not in the store is left out"
    assert req["calls"]["orch0001/1"] == calls.whole(C, "orch0001", 1)
    assert req["calls"]["orch0001/1"]["result"] == "rows 12\ncaptcha 5\n"
    assert req["citations"]["call:orch0001/1#L2"]["excerpt"] == "captcha 5"
    assert "calls" not in render.request_for(C, _card())


async def test_the_browser_reports_its_theme_for_the_workspace(workspaces_tmp):
    config.workspace_dir(C).mkdir(parents=True, exist_ok=True)
    assert render.theme(C) == {"paper": "warm", "accent": "iris"}
    assert await render.put_theme(C, render.ThemeBody(paper="dark", accent="lime")) == {"paper": "dark", "accent": "lime"}
    assert render.theme(C) == {"paper": "dark", "accent": "lime"}
    assert render.request_for(C, _card())["theme"] == {"paper": "dark", "accent": "lime"}
    from fastapi import HTTPException

    with pytest.raises(HTTPException):
        await render.put_theme(C, render.ThemeBody(paper="sepia", accent="lime"))


def test_the_harness_is_off_under_the_suite_and_says_so(monkeypatch):
    monkeypatch.setenv("THIMBLE_RENDER", "off")
    assert not render.enabled() and not render.available() and render.why() == "THIMBLE_RENDER is off"
    with pytest.raises(render.Unavailable):
        asyncio.run(render.render_card(C, _card()))


def test_a_browser_that_cannot_start_names_the_command_that_fixes_it():
    """A machine without the browser, or without the system libraries it links (a bare Linux server), gets the one
    command that fixes it in `why`, which /api/render/status and the server's log show."""
    fetch = render._launch_why(RuntimeError("Executable doesn't exist at /x/chrome-headless-shell"))
    assert "playwright install chromium-headless-shell" in fetch
    libs = render._launch_why(RuntimeError("Host system is missing dependencies to run browsers. Please install them with "
                                           "the following command: sudo playwright install-deps"))
    assert "install-deps chromium-headless-shell" in libs and libs.startswith("this machine lacks")


async def test_a_pool_without_a_page_says_why(tmp_path, monkeypatch):
    monkeypatch.setenv("THIMBLE_RENDER", "on")
    monkeypatch.setenv("THIMBLE_RENDER_DIR", str(tmp_path))
    pool = render.Pool(pages=1)
    assert await pool.start() is False
    assert "render.html" in pool.why
    with pytest.raises(render.Unavailable):
        await pool.render(_request(_card()))


# ----------------------------------------------------------------------------- the pool, in a real headless Chromium


@pytest.fixture()
async def pool(page_dir):
    missing = _chromium_missing()
    if missing:
        pytest.skip(missing)
    p = render.Pool(pages=2)
    assert await p.start(), p.why
    yield p
    await p.stop()


async def test_a_card_is_drawn_at_its_width_and_scale_two(pool):
    from PIL import Image

    res = await pool.render(_request(_card("How many?"), width=500))
    assert res.ok and res.error == ""
    assert res.box["width"] == 500
    w, h = Image.open(io.BytesIO(res.png)).size
    assert (w, h) == (1000, round(res.box["height"]) * 2), "the card's own box at device scale 2"
    assert {"page", "shot", "total"} <= set(res.ms)


async def test_renders_share_the_warm_pages_and_run_side_by_side(pool):
    results = await asyncio.gather(*(pool.render(_request(_card(f"card {i}"))) for i in range(6)))
    assert all(r.ok for r in results)


async def test_a_card_that_never_settles_times_out_and_its_page_is_replaced(pool):
    res = await pool.render(_request(_card("hang")), timeout_s=0.5)
    assert not res.ok and "did not settle" in res.error
    await asyncio.sleep(0.5)  # the replacement page loads in the background
    again = await asyncio.gather(*(pool.render(_request(_card("fine"))) for _ in range(3)))
    assert all(r.ok for r in again), "the pool still has its pages"


async def test_a_page_is_replaced_after_its_renders(pool, monkeypatch):
    monkeypatch.setattr(render, "RECYCLE_AFTER", 2)
    for _ in range(6):
        res = await pool.render(_request(_card()))
        assert res.ok
    await asyncio.sleep(0.8)  # the replacements load in the background
    assert max(pool._uses.values(), default=0) < 2, "no page served more than RECYCLE_AFTER renders"


async def test_nothing_leaves_the_machine_from_the_render_page(pool):
    page = await pool._free.get()
    try:
        ok = await page.evaluate("() => fetch('https://fonts.googleapis.com/css2?family=X').then(() => true, () => false)")
    finally:
        pool._free.put_nowait(page)
    assert ok is False, "a request to another origin is refused"


async def test_the_render_module_draws_a_workspace_card(page_dir, workspaces_tmp, monkeypatch):
    missing = _chromium_missing()
    if missing:
        pytest.skip(missing)
    monkeypatch.setattr(render, "_pool", None)
    try:
        res = await render.render_card(C, _card("from the workspace"))
        assert res.ok and render.available()
    finally:
        await render.shutdown()
    assert not render.available()


def test_doctor_says_whether_the_harness_draws_and_names_the_fetch_when_the_browser_is_missing(monkeypatch, tmp_path):
    """`thimble doctor` (cli.harness_line) works with the server down: it looks for the fetched browser, and names the
    command that fetches it when there is none, since no card is checked without it."""
    from app import cli

    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(tmp_path))
    line = cli.harness_line("http://127.0.0.1:9", False)
    assert "no headless Chromium" in line and cli.BROWSER_FETCH in line
    (tmp_path / "chromium_headless_shell-1187").mkdir()
    assert cli.harness_line("http://127.0.0.1:9", False) == "headless Chromium fetched (the server is down)"
    monkeypatch.setattr(cli, "_request", lambda method, url, body=None, timeout=5.0: (200, {"ready": False, "why": "no render.html"}))
    assert cli.harness_line("http://127.0.0.1:9", True).startswith("not drawing (no render.html)")


def test_doctor_looks_for_the_browser_where_playwright_keeps_it(monkeypatch, tmp_path):
    """Playwright's browsers folder (cli.playwright_browsers_dir): ms-playwright under ~/Library/Caches on macOS, under
    $XDG_CACHE_HOME or ~/.cache on Linux, under %LOCALAPPDATA% on Windows; PLAYWRIGHT_BROWSERS_PATH overrides it, "0"
    meaning the folder inside the installed package and a relative path the working directory's."""
    from app import cli

    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("PLAYWRIGHT_BROWSERS_PATH", raising=False)
    monkeypatch.delenv("XDG_CACHE_HOME", raising=False)
    d = cli.playwright_browsers_dir
    assert d({}, "darwin") == home / "Library" / "Caches" / "ms-playwright"
    assert d({}, "linux") == home / ".cache" / "ms-playwright"
    assert d({"XDG_CACHE_HOME": str(tmp_path / "xdg")}, "linux") == tmp_path / "xdg" / "ms-playwright"
    assert d({"XDG_CACHE_HOME": str(tmp_path / "xdg")}, "darwin") == home / "Library" / "Caches" / "ms-playwright"
    assert d({"LOCALAPPDATA": str(tmp_path / "local")}, "win32") == tmp_path / "local" / "ms-playwright"
    assert d({"PLAYWRIGHT_BROWSERS_PATH": str(tmp_path / "pw")}, "darwin") == tmp_path / "pw"
    assert d({"PLAYWRIGHT_BROWSERS_PATH": "pw", "INIT_CWD": str(tmp_path)}, "linux") == tmp_path / "pw"
    assert d({"PLAYWRIGHT_BROWSERS_PATH": "0"}, "darwin").parts[-3:] == ("driver", "package", ".local-browsers")
    monkeypatch.setattr(sys, "platform", "darwin")
    (home / "Library" / "Caches" / "ms-playwright" / "chromium_headless_shell-1187").mkdir(parents=True)
    assert cli.harness_line("http://127.0.0.1:9", False) == "headless Chromium fetched (the server is down)"
    monkeypatch.setattr(sys, "platform", "linux")
    assert cli.harness_line("http://127.0.0.1:9", False).startswith(f"no headless Chromium in {home / '.cache' / 'ms-playwright'}")
