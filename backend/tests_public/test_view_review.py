"""The review of a built view's pictures (app.view_review), with the pictures, the model's reading and the build
session's revision stubbed: a view with nothing to fix ends done; problems go to a revision that passes and are read
again; a revision that fails its checks leaves the view as it was before it; problems left after the last round flag
the view; pictures drawn without thimble's fonts, a refused reading and a stop show plainly; Undo puts back the view as
it was built, also after a review that ended early and one run again; a view proposed again or deleted stops its
review, and a held view proposed again changed is changed in place, its unfinished revision undone. The prompt the
reading gets names four pictures and six criteria for a view over files with lines, and two and three for one over
binary files. A page with label controls of its own gets a problem under the last criterion whatever the reading says.

The corpus is invented: board.jsonl, three posts, and a view `posts` of it with a proposal, as the dev agent builds one."""
from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import config, view_review, views

CORPUS = "reviewed"
READER = '''
def build_index(paths):
    return {}


def records(index, query):
    return []


def resolve(index, locator):
    return None
'''
PAGE = "<!doctype html><html><body><div data-anchor='board.jsonl#L1'>first</div></body></html>"
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")


@pytest.fixture()
def view(tmp_path, monkeypatch, workspaces_tmp):
    data = tmp_path / "data"
    root = data / CORPUS
    root.mkdir(parents=True)
    (root / "manifest.json").write_text(json.dumps({"name": CORPUS}))
    (root / "board.jsonl").write_text("".join(json.dumps({"body": b}) + "\n" for b in ("one", "two", "three")))
    monkeypatch.setattr(config, "DATA_DIR", data.resolve())
    monkeypatch.setenv("THIMBLE_VIEW_REVIEW", "on")
    views._save_proposals(CORPUS, [{"slug": "posts", "name": "Posts", "why": "the posts", "claims": ["board.jsonl"],
                                    "arrangement": "one post a row", "proposed_by": "orient", "status": "queued",
                                    "ts": "2026-09-01T00:00:00+00:00"}])
    views.write_view(CORPUS, "posts", name="Posts", why="the posts", claims=["board.jsonl"],
                     accepts=[{"form": "L<n>", "means": "a post"}], reader=READER, html=PAGE)
    return views.views_dir(CORPUS) / "posts"


class Stubs:
    """The review's pictures, readings and revisions, each call recorded."""

    def __init__(self, monkeypatch, tmp_path: Path, readings: list, revisions: list | None = None, fonts: bool = True,
                 controls: list[int] | None = None):
        self.readings, self.revisions, self.fonts = list(readings), list(revisions or []), fonts
        self.controls = list(controls or [])  # the label controls each round's pictures 2 to 4 find
        self.shots, self.calls, self.revised = 0, [], []
        self.tmp = tmp_path
        monkeypatch.setattr(view_review, "shoot", self.shoot)
        monkeypatch.setattr(view_review, "_call", self.call)
        monkeypatch.setattr(view_review, "revise", self.revise)

    async def shoot(self, c, slug, view, files, prop, lined, rnd):
        self.shots += 1
        controls = self.controls.pop(0) if self.controls else 0
        out = []
        for i, name in enumerate(view_review.LINED_STATES if lined else view_review.PLAIN_STATES):
            png = self.tmp / f"shot-{self.shots}-{i}.png"
            png.write_bytes(PNG)
            out.append({"ok": True, "errors": [], "state": name, "png": str(png), "records": 3, "units": 0,
                        "marked": 1, "hidden": 0, "controls": controls if i else 0, "fonts": self.fonts,
                        "answers": [[{"ref": "board.jsonl#L1"}]]})
        return out

    async def call(self, c, system, user, tool, images, effort):
        self.calls.append({"system": system, "user": user, "tool": tool, "images": len(images)})
        got = self.readings.pop(0)
        if isinstance(got, SimpleNamespace):
            return got
        return SimpleNamespace(status="ok", output={"assessment": got}, refused_by=None, model_requested="m",
                               detail="")

    async def revise(self, c, slug, prop, problems, shots):
        self.revised.append(problems)
        ok = self.revisions.pop(0) if self.revisions else True
        d = views.views_dir(c) / slug
        (d / "view.html").write_text(PAGE.replace("first", f"revision {len(self.revised)}"))
        return ok, "" if ok else "problem: the page did not load"


def ok(*problems: str) -> list[dict]:
    """A reading's assessment: the given problems under the third criterion, the rest met."""
    return [{"problems": []}, {"problems": []}, {"problems": list(problems)}, *[{"problems": []}] * 3]


async def _review() -> dict:
    views._bind_loop()
    run = view_review.start(CORPUS, "posts")
    assert run is not None
    await run.task
    return views.read_proposal(CORPUS, "posts")["review"]


async def test_a_view_with_nothing_to_fix_ends_done(view, monkeypatch, tmp_path):
    s = Stubs(monkeypatch, tmp_path, [ok()])
    review = await _review()
    assert review["state"] == "done" and review["revised"] == [] and review["left"] == [] and s.revised == []
    assert s.calls[0]["images"] == 4 and "test label" in s.calls[0]["system"]
    assert "picture 1" in s.calls[0]["user"] and "1 overview: 3 records and 0 units anchored" in s.calls[0]["user"]


async def test_problems_go_to_a_revision_that_passes_and_undo_puts_the_view_back_as_built(view, monkeypatch, tmp_path):
    s = Stubs(monkeypatch, tmp_path, [ok("picture 1: the ticks overlap"), ok()])
    built = (view / "view.html").read_text()
    review = await _review()
    assert review["state"] == "done" and review["revised"] == ["picture 1: the ticks overlap"] and review["left"] == []
    assert s.revised == [[[], [], ["picture 1: the ticks overlap"], [], [], []]] and s.shots == 2
    assert "revision 1" in (view / "view.html").read_text() and views.read_built(CORPUS, "posts") is not None
    got = view_review.undo(CORPUS, "posts")
    assert got["undo"] is True and got["revised"] == [] and (view / "view.html").read_text() == built
    with pytest.raises(Exception):
        view_review.undo(CORPUS, "posts")


async def test_a_revision_that_fails_its_checks_leaves_the_view_as_it_was(view, monkeypatch, tmp_path):
    Stubs(monkeypatch, tmp_path, [ok("picture 2: the label does not show")], revisions=[False])
    built = (view / "view.html").read_text()
    review = await _review()
    assert review["state"] == "done" and review["note"] == view_review.REVISION_FAILED_NOTE
    assert review["left"] == ["picture 2: the label does not show"] and review["revised"] == []
    assert (view / "view.html").read_text() == built


async def test_problems_left_after_the_last_round_flag_the_view(view, monkeypatch, tmp_path):
    s = Stubs(monkeypatch, tmp_path, [ok("a"), ok("b"), ok("c")])
    review = await _review()
    assert len(s.revised) == view_review.ROUNDS == 2
    assert review["state"] == "done" and review["revised"] == ["a", "b"] and review["left"] == ["c"]


async def test_pictures_without_thimble_s_fonts_are_not_read(view, monkeypatch, tmp_path):
    s = Stubs(monkeypatch, tmp_path, [ok()], fonts=False)
    review = await _review()
    assert review["state"] == "failed" and review["note"] == view_review.FONTS_NOTE and s.calls == []


async def test_a_refused_reading_that_ran_on_the_fallback_model_says_so(view, monkeypatch, tmp_path):
    fell_back = SimpleNamespace(status="ok", output={"assessment": ok()}, refused_by="claude-opus-5-5",
                                model_requested="claude-opus-4-8", detail="")
    Stubs(monkeypatch, tmp_path, [fell_back])
    review = await _review()
    assert review["state"] == "done" and review["note"].startswith("Downgrading ")
    failed = SimpleNamespace(status="refused", output=None, refused_by="claude-opus-5-5", model_requested="claude-opus-4-8",
                             detail="the model refused the request")
    Stubs(monkeypatch, tmp_path, [failed])
    review = await _review()
    assert review["state"] == "failed" and "refused" in review["note"]


async def test_a_stop_mid_revision_puts_the_view_back_and_says_stopped(view, monkeypatch, tmp_path):
    s = Stubs(monkeypatch, tmp_path, [ok("x")])
    started = asyncio.Event()

    async def slow(c, slug, prop, problems, shots):
        (view / "view.html").write_text("<html>half written</html>")
        started.set()
        await asyncio.sleep(30)
        return True, ""

    monkeypatch.setattr(view_review, "revise", slow)
    built = (view / "view.html").read_text()
    views._bind_loop()
    run = view_review.start(CORPUS, "posts")
    await started.wait()
    assert view_review.stop(CORPUS, "posts")
    await asyncio.gather(run.task, return_exceptions=True)
    review = views.read_proposal(CORPUS, "posts")["review"]
    assert review["state"] == "stopped" and (view / "view.html").read_text() == built and s.calls


async def test_a_view_over_binary_files_is_read_with_two_pictures_and_three_criteria(view, monkeypatch, tmp_path):
    s = Stubs(monkeypatch, tmp_path, [[{"problems": []}] * 3])
    monkeypatch.setattr(views, "lined", lambda v, files: False)
    review = await _review()
    assert review["state"] == "done" and s.calls[0]["images"] == 2
    schema = s.calls[0]["tool"].input_schema["properties"]["assessment"]
    assert schema["minItems"] == schema["maxItems"] == 3 and "test label" not in s.calls[0]["system"]


async def test_the_review_starts_after_a_build_and_not_when_turned_off(view, monkeypatch, tmp_path):
    started: list[str] = []
    monkeypatch.setattr(view_review, "start", lambda c, slug, again=False: started.append(slug))
    view_review.after_built(CORPUS, "posts")
    monkeypatch.setenv("THIMBLE_VIEW_REVIEW", "off")
    view_review.after_built(CORPUS, "posts")
    monkeypatch.setenv("THIMBLE_VIEW_REVIEW", "on")
    view_review.after_built(CORPUS, "spreadsheet")
    assert started == ["posts"]


async def _slow_revision(monkeypatch, view) -> asyncio.Event:
    """A revision that writes half a page and then hangs, until the test stops the review."""
    started = asyncio.Event()

    async def slow(c, slug, prop, problems, shots):
        (view / "view.html").write_text("<html>half written</html>")
        started.set()
        await asyncio.sleep(30)
        return True, ""

    monkeypatch.setattr(view_review, "revise", slow)
    return started


async def test_undo_stays_after_a_review_that_ended_early_and_one_run_again(view, monkeypatch, tmp_path):
    s = Stubs(monkeypatch, tmp_path, [ok("picture 1: the ticks overlap"), "capacity"])
    built = (view / "view.html").read_text()
    overloaded = SimpleNamespace(status="overloaded", output=None, refused_by=None, model_requested="m",
                                 detail="overloaded_error")
    s.readings[1] = overloaded
    monkeypatch.setattr(view_review, "CAPACITY_WAITS_S", ())
    review = await _review()
    assert review["state"] == "failed" and review["revised"] == ["picture 1: the ticks overlap"]
    assert "revision 1" in (view / "view.html").read_text()
    s.readings = [ok("picture 2: the label does not show"), ok()]
    views._bind_loop()
    run = view_review.start(CORPUS, "posts", again=True)
    await run.task
    review = views.read_proposal(CORPUS, "posts")["review"]
    assert review["state"] == "done"
    assert review["revised"] == ["picture 1: the ticks overlap", "picture 2: the label does not show"]
    view_review.undo(CORPUS, "posts")
    assert (view / "view.html").read_text() == built


async def test_a_new_build_is_what_undo_goes_back_to(view, monkeypatch, tmp_path):
    Stubs(monkeypatch, tmp_path, [ok("picture 1: the ticks overlap"), ok()])
    await _review()
    assert view_review._reviewed_dir(CORPUS, "posts").is_dir()
    monkeypatch.setattr(view_review, "auto", lambda c: False)
    (view / "view.html").write_text(PAGE.replace("first", "changed by the analyst"))
    view_review.after_built(CORPUS, "posts")
    assert not view_review._reviewed_dir(CORPUS, "posts").exists()
    assert "review" not in views.read_proposal(CORPUS, "posts")


async def test_a_held_view_proposed_again_changed_stops_its_review_and_is_changed_in_place(view, monkeypatch, tmp_path):
    from app import dev

    Stubs(monkeypatch, tmp_path, [ok("x")])
    built = (view / "view.html").read_text()
    started = await _slow_revision(monkeypatch, view)
    monkeypatch.setattr(dev, "queue_view", lambda c, slug: None)
    monkeypatch.setattr(dev, "stop_view", lambda c, slug, why: False)
    views.update_proposal(CORPUS, "posts", held=True, status="built")
    views._bind_loop()
    run = view_review.start(CORPUS, "posts")
    await started.wait()
    views.propose(CORPUS, "Posts", "the posts", ["board.jsonl"], "one post a row, newest first", proposed_by="orient",
                  hold=True)
    await asyncio.gather(run.task, return_exceptions=True)
    prop = views.read_proposal(CORPUS, "posts")
    assert prop["status"] == "queued" and prop["held"] and prop["changed"] and prop["revision"]
    assert prop["review"]["state"] == "stopped" and prop["review"]["note"] == view_review.CHANGED_NOTE
    assert not view_review.running(CORPUS, "posts")
    assert (view / "view.html").read_text() == built, "the half-written revision is undone and the view stays"


async def test_a_build_that_passes_while_its_review_is_stopping_gets_a_review_of_its_own(view, monkeypatch, tmp_path):
    Stubs(monkeypatch, tmp_path, [ok("x")])
    started = await _slow_revision(monkeypatch, view)
    views._bind_loop()
    run = view_review.start(CORPUS, "posts")
    await started.wait()
    fresh: list[str] = []
    monkeypatch.setattr(view_review, "start", lambda c, slug, again=False: fresh.append(slug))
    view_review.stop(CORPUS, "posts", view_review.CHANGED_NOTE)
    view_review.after_built(CORPUS, "posts")
    assert fresh == []
    await asyncio.gather(run.task, return_exceptions=True)
    assert fresh == ["posts"]


def test_the_revision_message_names_the_pictures_and_lists_the_problems(view):
    shots = [{"state": "overview", "png": "/tmp/a.png"}, {"state": "detail", "png": "/tmp/b.png"}]
    text = view_review.revision_prompt(CORPUS, "posts", [["picture 1: cut off"], [], ["picture 2: overlap"]], shots)
    assert "overview /tmp/a.png, detail /tmp/b.png" in text
    assert "- picture 1: cut off\n- picture 2: overlap" in text and str(views.views_dir(CORPUS) / "posts") in text


async def test_label_controls_in_the_page_are_a_problem_the_revision_gets(view, monkeypatch, tmp_path):
    s = Stubs(monkeypatch, tmp_path, [ok(), ok()], controls=[2, 0])
    review = await _review()
    problem = s.revised[0][-1][0]
    assert problem.startswith("Picture 2: the page has 2 controls of its own that name the test label")
    assert "Labels pane" in problem and s.revised[0][:-1] == [[]] * 5
    assert "2 controls of the page's own naming the test label" in s.calls[0]["user"]
    assert "no label toggle, checkbox, menu or clickable legend" in s.calls[0]["system"]
    assert review["state"] == "done" and review["left"] == [] and len(review["revised"]) == 1
    schema = s.calls[0]["tool"].input_schema["properties"]["assessment"]
    assert schema["minItems"] == schema["maxItems"] == 6
