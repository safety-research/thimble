"""`thimble demo` (app/demo.py, app/demo_data.py): the dataset builders on stubbed sources, the pre-cache's export and
install, and the command's flow with downloads, the server and the session start stubbed. No network."""
import argparse
import hashlib
import io
import json
import re
import zipfile
from pathlib import Path

import pytest

from app import config, demo, demo_data
from app.demo_data import Built, Dataset


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def jsonl(rows, **kw) -> bytes:
    return "".join(json.dumps(r, ensure_ascii=False, **kw) + "\n" for r in rows).encode()


# --------------------------------------------------------------------------- builders


def test_mythos5_drops_the_metadata_row_and_writes_compact_json(monkeypatch):
    raw = jsonl([{"record": "metadata", "title": "names the answer"},
                 {"record": "message", "n": 1, "text": "ä"}, {"record": "message", "n": 2}])
    monkeypatch.setattr(demo_data, "M5_SHA256", sha(raw))
    monkeypatch.setattr(demo_data, "M5_MESSAGES", 2)
    want = b'{"record":"message","n":1,"text":"\xc3\xa4"}\n{"record":"message","n":2}\n'
    monkeypatch.setitem(demo_data.MYTHOS5.expected, "transcript.jsonl", sha(want))
    built = demo_data.build_mythos5(lambda url: raw)
    assert built.files == {"transcript.jsonl": want} and built.warnings == []
    with pytest.raises(demo_data.SourceError):
        demo_data.build_mythos5(lambda url: raw + b'{"record":"message"}\n')


def diffend_page(files: dict[str, list[tuple[str, str]]]) -> bytes:
    body = []
    for name, lines in files.items():
        rows = "".join(f'<tr><td class="{cls}"><span class="d2h-code-line-ctn">{text}</span></td></tr>'
                       for cls, text in lines)
        body.append(f'<div class="d2h-file-wrapper"><div><span class="d2h-file-name">{name}</span></div>'
                    f'<table>{rows}</table></div>')
    return f'<html><meta name="csrf-token" content="x" /><body>{"".join(body)}</body></html>'.encode()


def test_rubyhack_keeps_paths_and_diff_lines_and_redacts_keys(monkeypatch):
    key = "rubygems_" + "a1" * 12
    pages = {"https://my.diffend.io/gems/demo-gem/0.0.1": diffend_page({
        "lib/demo.rb": [("d2h-ins", f"KEY = &quot;{key}&quot;"), ("d2h-cntx", "end")],
        "demo.gemspec": [("d2h-del", "old line")]})}
    url = next(iter(pages))
    monkeypatch.setattr(demo_data, "RH_SOURCES", ((url, "0" * 64),))
    monkeypatch.setattr(demo_data, "RH_SHAPE", (1, 2, 3))
    built = demo_data.build_rubyhack(pages.__getitem__)
    rows = [json.loads(x) for x in built.files["packages.jsonl"].splitlines()]
    assert [r["record_id"] for r in rows] == ["demo-gem:0.0.1:lib/demo.rb", "demo-gem:0.0.1:demo.gemspec"]
    assert rows[0]["lines"][0] == {"kind": "added",
                                  "text": f'KEY = "rubygems_<REDACTED_{sha(key.encode())[:12]}>"'}
    assert key not in built.files["packages.jsonl"].decode()
    assert rows[1]["lines"] == [{"kind": "removed", "text": "old line"}]
    # the page's records differ from the pinned digest and the file from the pinned copy: warnings, not a failure
    assert any("now shows other diff lines" in w for w in built.warnings)
    assert any("differs from the copy" in w for w in built.warnings)


def collusion_sources(monkeypatch):
    """A dump and a report page with the shape the collusion-wiki build expects, and the pins set to them."""
    probes = [t for t in demo_data.CW_PROBE_URLS]
    events = [{"event_id": "attacklog_raw_dse_1", "event_type": "probe", "wiki": "dse", "time": t, "label": None,
               "request": "", "round_id": 3} for t in probes]
    events += [{"event_id": "e-revert", "event_type": "revert", "wiki": "dse", "time": "2026-05-01T00:00:00Z"},
               {"event_id": "d1", "event_type": "delete", "wiki": "dse", "time": "2026-05-02T00:00:00Z",
                "actor_label": "[Admin1]", "time_grade": "A"}]
    raw = {
        "pages.jsonl": jsonl([{"page_id": "P[Person20]", "labels": ["[Admin2]x", "[User3]"], "bucket": "b"}]),
        "revisions.jsonl": jsonl([{"rev_id": "r1", "label": "[Admin2]", "body": "hi [Person5]", "hunks": 2}]),
        "events.jsonl": jsonl(events),
        "labels.jsonl": jsonl([{"label": "[Person7]", "is_human_handle": True}]),
    }
    sums = "".join(f"{sha(v)}  {k}\n" for k, v in raw.items())
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for k, v in raw.items():
            zf.writestr(k, v)
        zf.writestr("SHA256SUMS", sums)
    archive = buf.getvalue()
    xss = "https://wikiservice.at/dse/wiki.cgi?form_editprefs=1&action=form_editprefs&old_plist='><script>(function(){var d=JSON.parse(atob(\"e30=\"))})()</script>"
    mod = "https://wikiservice.at/dse/wiki.cgi?form_editprefs=1&action=form_editprefs&p_username=[RedactedModName]"
    page = (f"<p><code>{xss.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')}</code>"
            f"<code>{mod.replace('&', '&amp;')}</code></p>").encode()
    monkeypatch.setattr(demo_data, "CW_ARCHIVE_SHA256", sha(archive))
    monkeypatch.setattr(demo_data, "CW_REPORT_LINES", {
        "xss_chain": (demo_data.CW_REPORT_LINES["xss_chain"][0], sha(xss.encode())),
        "mod_prefs": ("[RedactedModName]", sha(mod.encode()))})
    return {demo_data.CW_ARCHIVE_URL: archive, demo_data.CW_REPORT_URL: page}, xss


def test_collusion_wiki_strips_analysis_attaches_the_report_and_renames_tokens(monkeypatch):
    sources, xss = collusion_sources(monkeypatch)
    built = demo_data.build_collusion_wiki(sources.__getitem__)
    rows = {k: [json.loads(x) for x in v.splitlines()] for k, v in built.files.items()}
    assert rows["revisions.jsonl"] == [{"rev_id": "r1", "label": "Friеdrich1982", "body": "hi AnjaWeber"}]
    assert rows["pages.jsonl"] == [{"page_id": "PUlrichBach", "labels": ["Friеdrich1982x", "SabineK"]}]
    assert rows["labels.jsonl"][0] == {"label": "JoergWinkler"}
    assert rows["labels.jsonl"][-1]["label"] == "Friedrich1982"  # the genuine admin, Latin spelling
    events = rows["events.jsonl"]
    assert not any(e["event_type"] in ("revert", "probe") for e in events)
    assert [e["time"] for e in events] == sorted(e["time"] for e in events)
    probe = next(e for e in events if e["time"] == "2026-06-18T17:44:47Z")
    assert probe["request"] == xss and probe["label"] == "XSSChainUser" and "round_id" not in probe
    assert probe["event_id"].startswith("request:dse:")
    assert next(e for e in events if e["event_type"] == "delete")["actor_label"] == "MartinHuber"
    prefs = next(e for e in events if e["event_id"] == "request:dse:2026-06-20:0")
    assert prefs["request"].endswith("p_username=MartinHuber") and prefs["label"] == "MartinHuber"
    assert len([e for e in events if e["event_id"].startswith("request:dse:2026-")]) == 22
    assert not re.search(r"\[(Admin|Person|User)\d+\]", "".join(v.decode() for v in built.files.values()))
    # the pins are the real copy's, so this synthetic one is reported as differing
    assert len(built.warnings) == 4


def test_a_changed_report_page_stops_the_collusion_wiki_build(monkeypatch):
    sources, _ = collusion_sources(monkeypatch)
    sources[demo_data.CW_REPORT_URL] = b"<p>moved</p>"
    with pytest.raises(demo_data.SourceError, match="no longer prints"):
        demo_data.build_collusion_wiki(sources.__getitem__)


# --------------------------------------------------------------------------- the pre-cache

SID = "d97f1dd1-78cf-4b0a-8b12-e5a4e45638cc"


def make_workspace(root: Path, corpus: Path, home: Path) -> Path:
    ws = root / "workspaces" / "toy"
    for rel, text in {
        "notebooks/g1.json": json.dumps({"id": "g1", "cells": [
            {"id": "c1", "code": f"pd.read_csv('{ws}/orient/work/t.csv')", "takeaway": "two rows"},
            {"id": "c2", "code": f"open('{corpus}/a.jsonl')", "outputs": [{"text": f"{home}/.claude/x"}]}]}),
        "notebooks/outputs/c1-0.txt": "long output",
        "notebooks/outputs/c1-1.parquet": "PAR1\x00binary",
        "notebooks/trash/old.json": "{}",
        "concepts/l1.json": json.dumps({"id": "l1", "name": "flag"}),
        "labels/l1.jsonl": json.dumps({"ref": "a.jsonl#L1", "label": "yes"}) + "\n",
        "labels/l1.sqlite": "derived",
        "chats/o1.jsonl": json.dumps({"tool_use": {"input": {"path": f"{corpus}/a.jsonl"}}}) + "\n",
        "chats/o1.meta.json": json.dumps({"id": "o1", "kind": "agent", "role": "orient", "model": "claude-opus-5-5",
                                         "effort": "ultracode", "status": "running", "pid": 7, "server": 8,
                                         "session": SID, "follow": {"offset": 999, "session": SID}}),
        "calls/o1.jsonl": "{}\n",
        "chats/main.jsonl": "".join(json.dumps(r) + "\n" for r in (
            {"type": "user", "text": "/exit", "by": "terminal"}, {"type": "user", "text": "hello", "by": "browser"},
            {"type": "user", "text": "", "event": {"kind": "start"}}, {"type": "agent", "chat": "o1"})),
        "orient/run.json": json.dumps({"status": "done", "passes": ["final", "views"], "ultracode": True, "pid": 42,
                                       "chats": {"orient": "o1"}, "session": SID}),
        "orient/summary.md": "summary",
        "orient/work/t.csv": "a,b\n1,2\n",
        "orient/work/.claude/settings.json": "{}",
        "extension/views/v1/view.json": json.dumps({"name": "v1"}),
        "extension/views/v1/cache/x.json": "{}",
        "views/.versions/v1/view.html": "<p>",
        "settings.json": json.dumps({"active_group": "g1", "api_token": "zzz"}),
        "scratch/a.jsonl": "mirror",
        "kernels/k.log": "log",
        "telemetry.jsonl": "{}\n",
        "sessions.json": "{}",
        "investigations/main/report.json": json.dumps({"title": "r"}),
    }.items():
        p = ws / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    return ws


def transcript_records(ws: Path, corpus: Path) -> list[dict]:
    """An orientation transcript as Claude Code writes one: the conversation, attachments that describe the machine and
    account between its records, and one the conversation needs."""
    cwd = str(ws / "orient" / "work")
    base = {"sessionId": SID, "cwd": cwd, "version": "2.1.289"}
    return [
        {"type": "custom-title", "customTitle": "thimble:orient · toy", "sessionId": SID},
        {**base, "type": "user", "uuid": "u1", "parentUuid": None, "message": {"role": "user", "content": "Start."}},
        {**base, "type": "attachment", "uuid": "a1", "parentUuid": "u1",
         "attachment": {"type": "instructions", "files": [{"path": "/home/x/.claude/CLAUDE.md", "content": "mine"}]}},
        {**base, "type": "attachment", "uuid": "a2", "parentUuid": "a1",
         "attachment": {"type": "session_context", "context": {"userEmail": "someone@example.com"}}},
        {**base, "type": "assistant", "uuid": "m1", "parentUuid": "a2", "message": {"role": "assistant", "content": [
            {"type": "thinking", "thinking": "", "signature": "c2ln"},
            {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": f"head {corpus}/a.jsonl"}}]}},
        {**base, "type": "user", "uuid": "r1", "parentUuid": "m1", "serverClassifierContext": {"live_cwd": cwd},
         "message": {"role": "user",
                     "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "{\"x\": 1}"}]}},
        {**base, "type": "attachment", "uuid": "a3", "parentUuid": "r1",
         "attachment": {"type": "hook_additional_context", "content": ["This call's ref is `call:o1/1`."]}},
        {**base, "type": "attachment", "uuid": "a4", "parentUuid": "a3",
         "attachment": {"type": "hook_success", "command": f"{ws}/../app/call_ref.py"}},
        {**base, "type": "assistant", "uuid": "m2", "parentUuid": "a4",
         "message": {"role": "assistant", "content": [{"type": "text", "text": "Done."}]}},
        {"type": "last-prompt", "lastPrompt": "Start.", "leafUuid": "m2", "sessionId": SID},
    ]


def write_transcript(claude: Path, ws: Path, corpus: Path) -> Path:
    p = claude / "projects" / demo.dashed(str(ws / "orient" / "work")) / f"{SID}.jsonl"
    p.parent.mkdir(parents=True)
    p.write_text("".join(json.dumps(r) + "\n" for r in transcript_records(ws, corpus)))
    return p


def made(tmp_path: Path, where: str = "a", name: str = "toy", **kw) -> tuple[Path, Path, dict]:
    """A workspace made on a corpus under tmp_path/where, with its transcript, exported to tmp_path/out/<name>: (the
    pre-cache folder, the corpus, the manifest)."""
    root = tmp_path / where
    corpus = root / "corpus"
    corpus.mkdir(parents=True)
    (corpus / "a.jsonl").write_text('{"x": 1}\n')
    ws = make_workspace(root, corpus, root)
    write_transcript(root / "claude", ws, corpus)
    out = tmp_path / "out" / name
    m = demo.export(ws, corpus, out, name=name, home=root, user="", scan=no_scan, claude_dir=root / "claude", **kw)
    return out, corpus, m


def no_scan(_: Path):
    return []


def tree_text(folder: Path) -> str:
    return "".join(p.read_text() for p in sorted(folder.rglob("*")) if p.is_file())


def test_export_keeps_state_leaves_out_what_is_rebuilt_and_writes_placeholders(tmp_path):
    out, corpus, m = made(tmp_path)
    names = {p.relative_to(out / "workspace").as_posix() for p in (out / "workspace").rglob("*") if p.is_file()}
    assert names == {"notebooks/g1.json", "notebooks/outputs/c1-0.txt", "concepts/l1.json", "labels/l1.jsonl",
                     "chats/main.jsonl", "chats/o1.jsonl", "chats/o1.meta.json", "calls/o1.jsonl", "orient/run.json",
                     "orient/summary.md", "orient/work/t.csv", "extension/views/v1/view.json",
                     "views/.versions/v1/view.html", "settings.json", "investigations/main/report.json"}
    assert {p.name for p in out.iterdir()} == {"workspace", "transcripts", "README.md", demo.MANIFEST}
    text = tree_text(out)
    assert str(tmp_path) not in text and "@@THIMBLE_WORKSPACE@@/orient/work/t.csv" in text
    assert "@@THIMBLE_CORPUS@@/a.jsonl" in text and "@@THIMBLE_USER_HOME@@/.claude/x" in text
    assert "api_token" not in text and '"pid"' not in text and "/exit" not in text
    assert m["typed_in_main"] == ["hello"] and '"start"' in text
    meta = json.loads((out / "workspace" / "chats" / "o1.meta.json").read_text())
    assert meta["status"] == "done" and not {"pid", "server", "follow"} & set(meta) and m["marked_done"] == ["o1"]
    assert m["counts"] == {"cards": 2, "labels": 1, "views": 1, "documents": 1, "chats": 1}
    assert m["orientation"]["model"] == "claude-opus-5-5" and m["orientation"]["ultracode"] is True
    assert m["corpus"] == [{"path": "a.jsonl", "bytes": 9, "sha256": sha(b'{"x": 1}\n')}]
    left = {f["path"]: f["why"] for f in m["left_out"]}
    assert {"labels/l1.sqlite", "scratch/a.jsonl", "telemetry.jsonl", "sessions.json", "notebooks/trash/old.json",
            "orient/work/.claude/settings.json", "extension/views/v1/cache/x.json"} <= set(left)
    assert left["notebooks/outputs/c1-1.parquet"] == "not text"
    assert json.loads((out / demo.MANIFEST).read_text())["files"] == m["files"]
    # a second export replaces the folder
    (out / "workspace" / "stale.json").write_text("{}")
    made(tmp_path, where="b")
    assert not (out / "workspace" / "stale.json").exists()


def test_export_keeps_the_conversation_of_the_transcript_and_drops_the_machine_and_account(tmp_path):
    out, corpus, m = made(tmp_path)
    [t] = m["transcripts"]
    assert t["session"] == SID and t["folder"] == "orient/work" and t["path"] == "transcripts/orient.jsonl"
    assert t["kept"] == 7 and t["dropped"] == {"attachment:hook_success": 1, "attachment:instructions": 1,
                                               "attachment:session_context": 1}
    recs = [json.loads(x) for x in (out / t["path"]).read_text().splitlines()]
    text = (out / t["path"]).read_text()
    assert "someone@example.com" not in text and "CLAUDE.md" not in text and "serverClassifierContext" not in text
    assert str(tmp_path) not in text and '"cwd":"@@THIMBLE_WORKSPACE@@/orient/work"' in text
    assert "head @@THIMBLE_CORPUS@@/a.jsonl" in text and "call:o1/1" in text
    by = {r.get("uuid"): r for r in recs}
    # each record whose parent was dropped follows the dropped one's parent: one unbroken conversation
    assert by["m1"]["parentUuid"] == "u1" and by["m2"]["parentUuid"] == "a3" and by["a3"]["parentUuid"] == "r1"
    assert by["m1"]["message"]["content"][0] == {"type": "thinking", "thinking": "", "signature": "c2ln"}
    readme = (out / "README.md").read_text()
    assert "transcripts/orient.jsonl" in readme and "7 records" in readme and "dropped 3 records" in readme


def test_export_needs_the_transcript_unless_told_to_leave_it_out(tmp_path):
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    ws = make_workspace(tmp_path, corpus, tmp_path)
    out = tmp_path / "out" / "toy"
    with pytest.raises(demo.DemoError, match="--no-transcript"):
        demo.export(ws, corpus, out, name="toy", home=tmp_path, user="", scan=no_scan, claude_dir=tmp_path / "none")
    assert not out.exists()
    m = demo.export(ws, corpus, out, name="toy", home=tmp_path, user="", scan=no_scan, claude_dir=tmp_path / "none",
                    transcript=False)
    assert m["transcripts"] == [] and "starts a new one" in (out / "README.md").read_text()
    (tmp_path / "mine").mkdir()
    (tmp_path / "mine" / "notes.txt").write_text("keep")
    with pytest.raises(demo.DemoError, match="not a pre-cache"):
        demo.export(ws, corpus, tmp_path / "mine", name="toy", home=tmp_path, user="", scan=no_scan, transcript=False)
    assert (tmp_path / "mine" / "notes.txt").read_text() == "keep"


def test_export_refuses_what_may_be_private(tmp_path):
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    ws = make_workspace(tmp_path / "elsewhere", corpus, Path("/home/someone"))
    (ws / "chats" / "o1.jsonl").write_text('{"text": "by maintainername from /mnt/disk/x"}\n')
    out = tmp_path / "p"
    with pytest.raises(demo.DemoError) as e:
        demo.export(ws, corpus, out, name="toy", home=tmp_path / "nohome", user="maintainername", transcript=False,
                    scan=lambda _: ["workspace/chats/o1.jsonl:1: generic-api-key"])
    assert "maintainername" in str(e.value) and "/mnt/disk" in str(e.value) and "generic-api-key" in str(e.value)
    assert not out.exists()
    m = demo.export(ws, corpus, out, name="toy", home=tmp_path / "nohome", user="maintainername", allow_private=True,
                    transcript=False, scan=no_scan)
    assert out.is_dir() and "workspace/chats/o1.jsonl: /mnt/disk" in m["flagged"]


def test_install_fills_the_placeholders_and_places_the_transcript_where_claude_code_resumes_it(tmp_path):
    out, corpus, _ = made(tmp_path)
    new_corpus = tmp_path / 'b "quoted"' / "corpus"
    new_corpus.mkdir(parents=True)
    (new_corpus / "a.jsonl").write_text('{"x": 2}\n')
    new_ws = tmp_path / "b-workspaces" / "toy-2"
    claude = tmp_path / "b-claude"
    m = demo.install(out, new_ws, new_corpus, home=tmp_path / "b", claude_dir=claude)
    nb = json.loads((new_ws / "notebooks" / "g1.json").read_text())
    assert nb["cells"][0]["code"] == f"pd.read_csv('{new_ws}/orient/work/t.csv')"
    assert nb["cells"][1]["code"] == f"open('{new_corpus}/a.jsonl')"
    run = json.loads((new_ws / "orient" / "run.json").read_text())
    assert run["status"] == "done" and run["precached"]["dataset"] == "toy" and "pid" not in run
    [placed] = m["installed_transcripts"]
    sid = placed["session"]
    assert sid != SID and run["session"] == sid
    path = claude / "projects" / demo.dashed(str(new_ws / "orient" / "work")) / f"{sid}.jsonl"
    assert placed["path"] == str(path) and path.is_file()
    text = path.read_text()
    assert SID not in text and "@@THIMBLE" not in text and f'"sessionId":"{sid}"' in text
    assert f'"cwd":"{new_ws}/orient/work"' in text and json.dumps(f"head {new_corpus}/a.jsonl")[1:-1] in text
    meta = json.loads((new_ws / "chats" / "o1.meta.json").read_text())
    assert meta["session"] == sid and meta["follow"] == {"offset": path.stat().st_size, "session": sid}
    assert (new_ws / "orient" / "work" / "t.csv").read_text() == "a,b\n1,2\n"
    assert m["warnings"] == ["a.jsonl differs from the file the orientation read"]
    assert not list(new_ws.parent.glob(".toy-2.demo-*"))
    with pytest.raises(demo.DemoError):
        demo.install(out, new_ws, new_corpus, claude_dir=claude)
    # a second install gets a session of its own
    m2 = demo.install(out, tmp_path / "c" / "toy", new_corpus, claude_dir=claude)
    assert m2["installed_transcripts"][0]["session"] not in (sid, SID)


def test_install_refuses_paths_outside_the_workspace(tmp_path):
    out, corpus, _ = made(tmp_path)
    man = json.loads((out / demo.MANIFEST).read_text())
    man["files"].append({"path": "../../escape.txt"})
    (out / demo.MANIFEST).write_text(json.dumps(man))
    with pytest.raises(demo.DemoError, match="unsafe"):
        demo.install(out, tmp_path / "ws", corpus, claude_dir=tmp_path / "claude")
    assert not (tmp_path / "ws").exists()


def test_projects_folder_is_claude_codes_name_for_a_folder():
    assert demo.dashed("/home/a/b.c d") == "-home-a-b-c-d"
    long = "/home/a/" + "x" * 120 + "/ünï/" + "y" * 100 + "/w"
    # Claude Code 2.1.289: over 200 characters, the first 200 and the base-36 hash of the path
    assert demo.dashed(long) == ("-home-a-" + "x" * 120 + "--n--" + "y" * 67 + "-ggtpxi")


# --------------------------------------------------------------------------- the command


def fake_dataset(name: str) -> Dataset:
    data = b'{"n": 1}\n'
    return Dataset(name=name, title=name, about="about", source="example.org", sources=(f"https://example.org/{name}",),
                   download_bytes=10, expected={"a.jsonl": sha(data)}, transforms="none", licence="test",
                   build=lambda fetch: Built({"a.jsonl": fetch(f"https://example.org/{name}") and data}))


def args(**kw) -> argparse.Namespace:
    base = dict(names=[], yes=True, dir=None, list=False, attach=False, replace=False, precaches=None, export=None,
                dataset=None, corpus=None, allow_private=False, scrub_user=False, app=None, claude_config=None,
                no_transcript=False)
    return argparse.Namespace(**{**base, **kw})


@pytest.fixture()
def fake_world(tmp_path, monkeypatch):
    """Two fake datasets, an empty folder of pre-caches, a data folder and a workspaces folder of the test's own, a
    Claude Code config folder, and no server."""
    monkeypatch.setattr(demo, "DATASETS", {n: fake_dataset(n) for n in ("one", "two")})
    monkeypatch.setattr(demo, "PRECACHES", tmp_path / "demos")
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    env = {"workspaces_dir": str(tmp_path / "workspaces"), "data_dir": str(tmp_path / "data")}
    got: list[str] = []
    lines: list[str] = []
    started: list[Path] = []
    shown: list[str] = []

    def get(url: str) -> bytes:
        got.append(url)
        return b"payload"

    def server(say):
        return None, env

    return {"get": get, "got": got, "lines": lines, "server": server, "root": tmp_path / "demo", "env": env,
            "started": started, "shown": shown}


def said(w) -> str:
    """What the command printed, its wrapped lines joined back."""
    return " ".join(" ".join(w["lines"]).split())


def run(w, a) -> int:
    return demo.run(a, get=w["get"], say=w["lines"].append, server=w["server"], start=w["started"].append,
                    show=lambda url: w["shown"].append(url) or True)


def precache_for(tmp_path: Path, name: str) -> Path:
    """The pre-cache of dataset `name`, made on a copy of its file, in tmp_path/pre/<name>."""
    root = tmp_path / "made-on"
    corpus = root / name
    corpus.mkdir(parents=True)
    (corpus / "a.jsonl").write_bytes(b'{"n": 1}\n')
    ws = make_workspace(root, corpus, root)
    write_transcript(root / "claude", ws, corpus)
    demo.export(ws, corpus, tmp_path / "pre" / name, name=name, home=root, user="", scan=no_scan,
                claude_dir=root / "claude")
    return tmp_path / "pre"


def test_demo_downloads_installs_opens_and_says_how_to_attach(tmp_path, fake_world):
    w = fake_world
    pre = precache_for(tmp_path, "one")
    assert run(w, args(names=["one", "two"], dir=str(w["root"]), precaches=str(pre))) == 0
    assert (w["root"] / "one" / "a.jsonl").read_bytes() == b'{"n": 1}\n'
    assert w["got"] == ["https://example.org/one", "https://example.org/two"]
    installed = Path(w["env"]["workspaces_dir"]) / "one"
    run_rec = json.loads((installed / "orient" / "run.json").read_text())
    assert run_rec["precached"]["dataset"] == "one"
    assert str(w["root"] / "one") in (installed / "notebooks" / "g1.json").read_text()
    assert json.loads((tmp_path / "data" / "one.corpus.json").read_text())["path"] == str(w["root"] / "one")
    # the transcript went into the Claude Code config folder this command's user runs
    assert list((tmp_path / "claude-config" / "projects").glob(f"*/{run_rec['session']}.jsonl"))
    # two has no pre-cache: registered, nothing installed
    assert json.loads((tmp_path / "data" / "two.corpus.json").read_text())["path"] == str(w["root"] / "two")
    assert not (Path(w["env"]["workspaces_dir"]) / "two").exists()
    text = said(w)
    assert "installed as workspace one: 2 cards, 1 labels, 1 views; its session can be continued" in text
    assert "pre-cached orientation" in text and "(claude-opus-5-5, Ultracode, no prompt)" in text
    assert "two has no pre-cached orientation yet" in text
    assert f"cd {w['root'] / 'one'} && thimble # one" in text and f"cd {w['root'] / 'two'} && thimble # two" in text
    assert "No Claude Code session is attached" in text and "message the orientation" in text
    assert w["started"] == []  # no server here, so no page to open either
    assert "## one: one" in (w["root"] / "SOURCES.md").read_text()
    # a second run downloads nothing and leaves the analysis in place
    w["got"].clear()
    assert run(w, args(names=["one"], dir=str(w["root"]), precaches=str(pre))) == 0
    assert w["got"] == [] and "holds an analysis already; it stays" in said(w)
    # --replace archives it and installs the pre-cache again
    assert run(w, args(names=["one"], dir=str(w["root"]), precaches=str(pre), replace=True)) == 0
    assert list((Path(w["env"]["workspaces_dir"]) / ".archive").glob("one-*"))
    assert (installed / "orient" / "run.json").is_file()


def test_demo_opens_the_page_with_a_server_and_attach_starts_main(tmp_path, fake_world, monkeypatch):
    w = fake_world
    pre = precache_for(tmp_path, "one")
    from app import cli

    monkeypatch.setattr(demo, "register", lambda folder, url: folder.name)
    monkeypatch.setattr(cli, "ui_url", lambda name, key=True: f"http://127.0.0.1:1/?ws={name}")
    w["server"] = lambda say: ("http://127.0.0.1:1", w["env"])
    assert run(w, args(names=["one"], dir=str(w["root"]), precaches=str(pre))) == 0
    assert w["shown"] == ["http://127.0.0.1:1/?ws=one"] and "Open at http://127.0.0.1:1/?ws=one" in said(w)
    assert w["started"] == []
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    monkeypatch.setattr("sys.stdout.isatty", lambda: True)
    w["lines"].clear()
    assert run(w, args(names=["one"], dir=str(w["root"]), precaches=str(pre), attach=True)) == 0
    assert w["started"] == [w["root"] / "one"]


def test_demo_asks_before_downloading_and_needs_a_terminal_to_ask(fake_world, monkeypatch):
    w = fake_world
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)
    assert run(w, args(yes=False, dir=str(w["root"]))) == 1
    assert w["got"] == [] and "no terminal to ask on" in w["lines"][-1]
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    answers = iter(["n", "y"])
    monkeypatch.setattr("builtins.input", lambda q: next(answers))
    assert run(w, args(yes=False, dir=str(w["root"]))) == 0
    assert w["got"] == ["https://example.org/two"] and "  one: skipped" in w["lines"]


def test_demo_list_downloads_nothing(fake_world):
    w = fake_world
    assert run(w, args(list=True, dir=str(w["root"]))) == 0
    assert w["got"] == [] and not w["root"].exists()
    assert any("no pre-cached orientation yet" in x for x in w["lines"])


def test_a_folder_with_other_files_is_left_alone(fake_world):
    w = fake_world
    (w["root"] / "one").mkdir(parents=True)
    (w["root"] / "one" / "mine.txt").write_text("keep")
    assert run(w, args(names=["one"], dir=str(w["root"]))) == 1
    assert "holds other files (mine.txt)" in said(w)
    assert (w["root"] / "one" / "mine.txt").read_text() == "keep" and w["got"] == []


def test_the_registry_pins_every_dataset_and_its_sources():
    for d in demo_data.DATASETS.values():
        assert d.expected and all(len(h) == 64 for h in d.expected.values())
        assert all(u.startswith("https://") for u in d.sources)
    # the repository's pre-caches read as this thimble reads them
    for name, pc in demo.precaches(demo.PRECACHES).items():
        assert name in demo_data.DATASETS and pc["transcript"]


def test_export_scrubs_the_user_name_and_paths_a_summary_cut_short(tmp_path):
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    ws = make_workspace(tmp_path, corpus, tmp_path)
    cut = str(ws)[: len(str(ws)) - 4] + "…"
    logged = json.dumps({"input": {"command": f"ls {str(ws)[:-6]}"}, "workflow_dir": f"/p/{demo.dashed(str(ws))}-x"})
    (ws / "chats" / "o1.jsonl").write_text(json.dumps({"summary": f"drwx maintainername maintainername x\n{cut}"}) + "\n"
                                           + logged + "\n")
    out = tmp_path / "s"
    m = demo.export(ws, corpus, out, name="toy", home=tmp_path, user="maintainername", scrub_user=True, scan=no_scan,
                    transcript=False)
    chat = (out / "workspace" / "chats" / "o1.jsonl").read_text()
    assert "drwx user user x" in chat and "@@THIMBLE_WORKSPACE@@\\u2026" in chat and str(tmp_path) not in chat
    assert '"command": "ls @@THIMBLE_WORKSPACE@@…"' in chat and '"/p/@@THIMBLE_DASHED_WORKSPACE@@-x"' in chat
    assert m["user_name_scrubbed"] == 2 and m["flagged"] == []
    back = tmp_path / "elsewhere" / "toy"
    demo.install(out, back, corpus, home=tmp_path, claude_dir=tmp_path / "claude")
    assert f"/p/{demo.dashed(str(back))}-x" in (back / "chats" / "o1.jsonl").read_text()


def test_export_command_waits_for_a_finished_orientation(tmp_path, monkeypatch):
    monkeypatch.setattr(demo, "gitleaks_scan", no_scan)
    monkeypatch.setattr(demo.getpass, "getuser", lambda: "")
    monkeypatch.setenv("HOME", str(tmp_path))
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    ws = make_workspace(tmp_path, corpus, tmp_path)
    write_transcript(tmp_path / "claude", ws, corpus)
    run_path = ws / "orient" / "run.json"
    run_rec = json.loads(run_path.read_text())
    run_path.write_text(json.dumps({**run_rec, "status": "running"}))
    lines: list[str] = []
    a = args(export=[str(ws), str(tmp_path / "out")], corpus=str(corpus), claude_config=str(tmp_path / "claude"))
    assert demo.run(a, say=lines.append) == 1 and "is running; export it once it is done" in " ".join(lines)
    run_path.write_text(json.dumps(run_rec))
    assert demo.run(a, say=lines.append) == 0
    assert (tmp_path / "out" / "toy" / demo.MANIFEST).is_file()
    assert any("the orientation's transcript: 7 records kept, 3 dropped" in x for x in lines)
    # OUT naming the pre-cache folder itself writes it again in place
    assert demo.run(args(export=[str(ws), str(tmp_path / "out" / "toy")], corpus=str(corpus),
                         claude_config=str(tmp_path / "claude")), say=lines.append) == 0
    assert not (tmp_path / "out" / "toy" / "toy").exists()


def test_the_analyst_picks_the_folder_thimble_starts_in(tmp_path, monkeypatch):
    folders = [tmp_path / "a", tmp_path / "b"]
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    for typed, want in (("", folders[0]), ("2", folders[1]), ("n", None), ("9", None)):
        monkeypatch.setattr("builtins.input", lambda q, typed=typed: typed)
        assert demo.pick_folder(folders) == want
    assert demo.pick_folder(folders[:1]) == folders[0]


def test_a_precache_carries_its_sources_notice_first_in_its_readme(tmp_path):
    out, _, m = made(tmp_path, name="mythos-5")
    assert "canary GUID" in m["notice"]
    assert (out / "README.md").read_text().startswith("> Notice from the source: This document should not be included")
    assert json.loads((out / demo.MANIFEST).read_text())["notice"] == m["notice"]
