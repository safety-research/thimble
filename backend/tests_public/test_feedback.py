"""The problem report (app/feedback.py, app/feedback_routes.py): the zip's contents, the background sessions'
transcripts and the workspace's state, the browser's log, the install log, the size cap with the oldest left out, text
only, secrets redacted, no file outside thimble's own, the fallback to THIMBLE_HOME, the links, `thimble feedback` and
`/thimble feedback` with the server down and the supervisor broken, and the loopback rule. The workspace is built by
hand under a temp WORKSPACES_DIR over the synthetic corpus `mini`; HOME, THIMBLE_HOME, CLAUDE_CONFIG_DIR and the dev
tickets' folder are temp folders."""
from __future__ import annotations

import base64
import json
import os
import random
import string
import time
import zipfile
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import cli, config, feedback, feedback_routes

C = "mini"
SECRET = "outside-thimble-7f3a"  # planted in files the bundle must never read
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
DOCTOR = "thimble doctor\n  server: up at http://127.0.0.1:8311\n  auth: env credential (ANTHROPIC_API_KEY)\n  log tail (x):\n    last doctor line"
CONTACT, CONTACT_URL = feedback.CONTACT, feedback.CONTACT_URL
INSTRUCTIONS = (f"Attach the zip to a GitHub issue only if you are happy to share it publicly; otherwise reach {CONTACT} "
                "on GitHub for private logs.")
# the repo is the one plugin.json names (feedback.repo_slug)
ISSUES = f"https://github.com/{feedback.release_repo()}/issues/new"

app = FastAPI()
app.include_router(feedback_routes.router, prefix="/api")


class RemoteApp:
    """The app as seen from another host: every request's client is off loopback."""

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            scope = {**scope, "client": ("10.0.0.5", 4321)}
        await self.inner(scope, receive, send)


def _lines(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))


def _age(path: Path, seconds_ago: float) -> None:
    t = time.time() - seconds_ago
    os.utime(path, (t, t))


@pytest.fixture()
def env(tmp_path, monkeypatch):
    """HOME with a Downloads folder, THIMBLE_HOME with a server log, the corpus `mini` and its workspace with two chats
    and the event stream; decoys with SECRET in the corpus, Claude Code's own folder and another workspace."""
    user = tmp_path / "user"
    (user / "Downloads").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(user))
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("THIMBLE_HOME", str(home))
    (home / "server.log").write_text("".join(f"log line {i}\n" for i in range(50)))
    wsroot = tmp_path / "workspaces"
    monkeypatch.setattr(config, "WORKSPACES_DIR", wsroot)
    ws = wsroot / C
    _lines(ws / "chats" / "old.jsonl", [{"type": "user", "text": "an old question"}])
    (ws / "chats" / "old.meta.json").write_text(json.dumps({"id": "old", "title": "old"}))
    _lines(ws / "chats" / "new.jsonl", [{"type": "user", "text": "why is the chart blank"}, {"type": "text", "delta": "It has no rows."}])
    (ws / "chats" / "new.meta.json").write_text(json.dumps({"id": "new", "title": "new"}))
    _age(ws / "chats" / "old.jsonl", 3600)
    _lines(ws / "investigations" / "main" / "events.jsonl", [{"seq": i, "type": "chat"} for i in range(5)])
    # thimble's own files the bundle does not take, and files that are not thimble's at all
    _lines(ws / "labels" / "results.jsonl", [{"ref": SECRET}])
    (ws / "settings.json").write_text(json.dumps({"note": SECRET}))
    _lines(wsroot / "other" / "chats" / "x.jsonl", [{"text": SECRET}])
    claude = user / ".claude" / "projects" / "p"
    claude.mkdir(parents=True)
    (claude / "s.jsonl").write_text(SECRET)
    outside = tmp_path / "outside.jsonl"
    outside.write_text(json.dumps({"text": SECRET}) + "\n")
    (ws / "chats" / "link.jsonl").symlink_to(outside)
    monkeypatch.setattr(cli, "doctor_text", lambda: DOCTOR)
    monkeypatch.setattr(feedback, "claude_version", lambda: "2.1.281 (Claude Code)")
    monkeypatch.setattr(feedback, "reveal_command", lambda p: None)
    monkeypatch.setattr(feedback, "server_answers", lambda url: False)
    claude_config = tmp_path / "claude-config"
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(claude_config))
    monkeypatch.setattr(config, "claude_config_dir", lambda: claude_config)
    dev = tmp_path / "dev"
    dev.mkdir()
    monkeypatch.setenv("THIMBLE_DEV_DIR", str(dev))
    return {"user": user, "home": home, "ws": ws, "tmp": tmp_path, "claude": claude_config, "dev": dev}


def _zip(path: str) -> dict[str, bytes]:
    with zipfile.ZipFile(path) as z:
        return {n: z.read(n) for n in z.namelist()}


def _shot() -> str:
    return "data:image/png;base64," + base64.b64encode(PNG).decode()


def test_the_bundle_holds_the_description_versions_doctor_and_the_logs_and_says_how_to_send_it(env):
    r = TestClient(app).post(f"/api/ws/{C}/feedback", json={"description": "The chart is blank.\nIt was fine yesterday.",
                                                            "screenshot": _shot(), "user_agent": "TestBrowser/1.0"})
    assert r.status_code == 201, r.text
    out = r.json()
    path = Path(out["path"])
    assert path.parent == env["user"] / "Downloads" and feedback.NAME_RE.match(path.name) and out["name"] == path.name
    assert out["bytes"] == path.stat().st_size and out["size"].endswith(("B", "KB", "MB"))
    files = _zip(out["path"])
    assert set(files) == {"contents.txt", "description.txt", "screenshot.png", "versions.txt", "doctor.txt", "server-log.txt",
                          "workspace/events.jsonl", "workspace/chats/new.jsonl", "workspace/chats/new.meta.json",
                          "workspace/chats/old.jsonl", "workspace/chats/old.meta.json"}
    assert out["files"] == list(files) and list(files)[0] == "contents.txt"
    assert files["description.txt"].decode() == "The chart is blank.\nIt was fine yesterday.\n"
    assert files["screenshot.png"] == PNG
    versions = files["versions.txt"].decode()
    for line in ("thimble: ", "OS: ", "Python: ", "Claude Code: 2.1.281 (Claude Code)", "browser: TestBrowser/1.0", "workspace: mini"):
        assert line in versions, line
    assert files["doctor.txt"].decode().strip() == DOCTOR
    assert files["server-log.txt"].decode().endswith("log line 49\n")
    assert files["workspace/events.jsonl"].decode().count("\n") == 5
    assert "why is the chart blank" in files["workspace/chats/new.jsonl"].decode()
    assert "2 of the workspace's 2 chats: " in files["contents.txt"].decode()
    assert out["instructions"] == INSTRUCTIONS and (out["contact"], out["contact_url"]) == (CONTACT, CONTACT_URL)
    assert CONTACT_URL == f"https://github.com/{CONTACT.removeprefix('@')}"
    assert "mailto" not in out and "@" not in INSTRUCTIONS.replace(CONTACT, ""), "no email address"
    issue = urlsplit(out["issue_url"])
    assert f"{issue.scheme}://{issue.netloc}{issue.path}" == ISSUES
    q = parse_qs(issue.query)
    assert set(q) == {"title", "body"} and q["title"] == ["The chart is blank."]
    body = q["body"][0]
    assert body.startswith("The chart is blank.\nIt was fine yesterday.\n\n- thimble: ")
    assert "\n- Claude Code: 2.1.281 (Claude Code)\n" in body and "\n- OS: " in body
    assert "\n- doctor: server up; auth env credential\n" in body, "the doctor's summary, not its text"
    assert f"({path.name}): attach it here only if you are happy to share it publicly" in body
    assert f"reach {CONTACT} ({CONTACT_URL}) for private logs" in body
    for kept_out in ("workspace", "log line", "last doctor line", "why is the chart blank", "It has no rows",
                     "TestBrowser", "Python", "ANTHROPIC_API_KEY", "127.0.0.1", str(env["tmp"]), str(feedback.REPO_ROOT)):
        assert kept_out not in body, f"{kept_out!r} stays out of a public issue"
    assert out["can_reveal"] is False


FULL_DOCTOR = """thimble doctor
  versions: thimble git main @ 1a2b3c4; Python 3.12.3; Linux-6.8-x86_64
  claude code: 2.1.282 at /opt/tools/bin/claude
  server: down at http://127.0.0.1:8311; pid 4242 (gone); started 2026-09-25T10:00:00
  repo: /opt/tools/thimble (branch main @ 1a2b3c4, 0 uncommitted paths)
  auth: apiKeyHelper in /opt/tools/claude/settings.json
  network: cannot reach proxy.internal.example (OSError: timed out); model calls fail until the network is back
  card harness: no headless Chromium, so cards are not checked: run `playwright install` in /opt/tools/thimble
  log tail (/opt/tools/home/server.log):
    2026-09-25 10:00:01 ERROR thimble.card_check the chart about the payroll table failed
  recent errors in the log (1 of its last 2.0 MB):
    2026-09-25 10:00:01 ERROR thimble.card_check the chart about the payroll table failed"""


def test_the_doctor_s_summary_is_one_line_of_words_with_no_path_host_or_log_line():
    line = feedback.doctor_summary(FULL_DOCTOR)
    assert line == "server down; auth apiKeyHelper; network unreachable; card harness no Chromium; 1 recent error in the log"
    assert feedback.doctor_summary(DOCTOR) == "server up; auth env credential"
    assert feedback.doctor_summary("thimble doctor\n  network: api.anthropic.com answers\n  recent errors in the log: "
                                   "none in its last 2.0 MB") == "network reachable; 0 recent errors in the log"
    broken = "thimble doctor could not run: cli.py failed to import (import-error.txt)"
    assert feedback.doctor_summary(broken) == broken
    assert feedback.without_log(FULL_DOCTOR).endswith("card harness: no headless Chromium, so cards are not checked: run "
                                                      "`playwright install` in /opt/tools/thimble\n  log tail: left out "
                                                      "with the logs")


def test_the_new_issue_link_is_encoded_and_carries_no_log_path_or_workspace():
    description = "Card #3 & the chart: 50% blank?\nSee https://x.test/?a=1&b=2 — ünïcode"
    vers = {"thimble": "git main @ 1a2b3c4 (0 uncommitted paths), at /opt/tools/thimble", "install": "checkout",
            "server": "answering at http://127.0.0.1:8311", "OS": "Linux-6.8-x86_64", "Python": "3.12.3",
            "Claude Code": "2.1.282 (Claude Code)", "browser": "TestBrowser/1.0", "workspace": "secret-corpus"}
    url = feedback.issue_url(description, vers, feedback.doctor_summary(FULL_DOCTOR), "thimble-feedback-20260925-100000.zip")
    assert url.startswith(f"{ISSUES}?title=Card%20%233%20%26%20the%20chart")
    assert not any(ch in url for ch in " \n#") and url.count("?") == 1 and url.count("&") == 1, "one title, one body"
    q = parse_qs(urlsplit(url).query)
    assert q["title"] == ["Card #3 & the chart: 50% blank?"]
    assert q["body"][0] == (
        f"{description}\n\n"
        "- thimble: git main @ 1a2b3c4 (0 uncommitted paths)\n"
        "- Claude Code: 2.1.282 (Claude Code)\n"
        "- OS: Linux-6.8-x86_64\n"
        "- doctor: server down; auth apiKeyHelper; network unreachable; card harness no Chromium; 1 recent error in the "
        "log\n\n"
        "The problem report zip (thimble-feedback-20260925-100000.zip): attach it here only if you are happy to share it "
        f"publicly, since issues are public. Otherwise leave it out and reach {CONTACT} ({CONTACT_URL}) for private "
        "logs.\n")
    for kept_out in ("/opt/tools", "payroll", "secret-corpus", "127.0.0.1", "proxy.internal", "TestBrowser", "3.12.3"):
        assert kept_out not in q["body"][0], kept_out
    empty = parse_qs(urlsplit(feedback.issue_url("", {})).query)
    assert empty["title"] == ["Problem report"] and empty["body"][0].startswith("(describe what went wrong)\n\n")
    long = parse_qs(urlsplit(feedback.issue_url("x" * 5000, {})).query)
    assert len(long["body"][0].split("\n\n")[0]) == feedback.ISSUE_TEXT_MAX + 1, "the description is cut, with …"


def test_nothing_outside_thimble_s_own_files_goes_in(env):
    out = feedback.build("x", workspace=(C, env["ws"]))
    files = _zip(out["path"])
    assert "workspace/chats/link.jsonl" not in files, "a symlink out of the workspace is skipped"
    for name, data in files.items():
        assert SECRET.encode() not in data, name
    allowed = ("contents.txt", "description.txt", "screenshot.", "versions.txt", "doctor.txt", "server-log.txt",
               "workspace/events.jsonl", "workspace/chats/")
    assert all(n.startswith(allowed) for n in files), sorted(files)


def test_a_chat_s_images_are_left_out_so_the_logs_are_text_only(env):
    blob = base64.b64encode(os.urandom(6000)).decode()
    _lines(env["ws"] / "chats" / "new.jsonl", [{"type": "image", "src": f"data:image/png;base64,{blob}"}, {"type": "text", "delta": "after"}])
    files = _zip(feedback.build("x", workspace=(C, env["ws"]))["path"])
    chat = files["workspace/chats/new.jsonl"].decode()
    assert blob not in chat and "characters of binary data left out" in chat and "after" in chat


def test_the_bundle_stays_under_the_cap_and_the_oldest_logs_are_the_ones_left_out(env):
    rnd = random.Random(7)
    text = lambda n: "".join(rnd.choices(string.ascii_letters + " ", k=n))  # noqa: E731 — barely compressible
    ws = env["ws"]
    for i in range(12):  # 12 chats of 1.2 MB, chat-0 the newest
        p = ws / "chats" / f"chat-{i}.jsonl"
        p.write_text("".join(json.dumps({"n": i, "text": text(1000)}) + "\n" for _ in range(1200)) + json.dumps({"last": i}) + "\n")
        _age(p, 60 * (i + 1))
    (env["home"] / "server.log").write_text("".join(f"{text(200)}\n" for _ in range(15_000)) + "the last log line\n")
    _lines(ws / "investigations" / "main" / "events.jsonl", [{"seq": i, "text": text(300)} for i in range(12_000)] + [{"seq": "last"}])
    big_shot = "data:image/png;base64," + base64.b64encode(PNG + os.urandom(3_000_000)).decode()
    out = feedback.build("x", workspace=(C, ws), screenshot=big_shot)
    assert out["bytes"] < 10_000_000
    files = _zip(out["path"])
    assert sum(len(d) for d in files.values()) <= feedback.MAX_BYTES
    assert files["server-log.txt"].decode().endswith("the last log line\n") and len(files["server-log.txt"]) <= feedback.LOG_MAX
    assert files["workspace/events.jsonl"].decode().endswith('{"seq": "last"}\n')
    kept = sorted(int(n.split("-")[1].split(".")[0]) for n in files if n.startswith("workspace/chats/chat-") and n.endswith(".jsonl"))
    assert kept and kept == list(range(len(kept))), f"the newest chats are kept and the oldest dropped: {kept}"
    assert len(kept) < 12
    assert files["workspace/chats/chat-0.jsonl"].decode().endswith('{"last": 0}\n'), "a cut chat keeps its tail"
    assert "screenshot.png" in files


def test_a_screenshot_that_is_not_a_png_or_jpeg_or_is_too_big_is_left_out(env):
    assert feedback.screenshot_bytes("data:image/png;base64," + base64.b64encode(b"GIF89a....").decode()) is None
    assert feedback.screenshot_bytes("data:image/png;base64,@@@") is None
    assert feedback.screenshot_bytes("data:image/png;base64," + base64.b64encode(PNG + b"\x00" * feedback.SHOT_MAX).decode()) is None
    assert feedback.screenshot_bytes("data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8\xff\xe0rest").decode())[1] == "jpg"


def test_the_routes_answer_this_machine_only(env):
    remote = TestClient(RemoteApp(app))
    assert remote.post(f"/api/ws/{C}/feedback", json={"description": "x"}).status_code == 403
    assert remote.post("/api/feedback/reveal", json={"path": "x"}).status_code == 403
    assert not list((env["user"] / "Downloads").iterdir())


S_ORIENT = "11111111-1111-4111-8111-111111111111"
S_WRITER = "22222222-2222-4222-8222-222222222222"
S_CHECK = "33333333-3333-4333-8333-333333333333"
S_CRITIC = "44444444-4444-4444-8444-444444444444"
S_VIEW = "55555555-5555-4555-8555-555555555555"
S_DEV = "66666666-6666-4666-8666-666666666666"
S_OTHER = "77777777-7777-4777-8777-777777777777"


KEYS = {
    "anthropic-key": "sk-ant-api03-" + "A1b2C3d4E5f6" * 8,
    "openai-key": "sk-proj-" + "Zz9Yy8Xx7Ww6" * 4,
    "github-token": "ghp_" + "a1B2c3D4e5F6g7H8i9J0" * 2,
    "aws-key": "AKIA" + "IOSFODNN7EXAMPLE",
    "slack-token": "xoxb-" + "1234567890-abcdefghij",
    "google-key": "AIza" + "SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY"[:35],
    "jwt": ".".join(["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"]),
}
# the values are put together at run time, so no scanner of the source reads them as real keys
API_VALUE, CLIENT_VALUE, PASSWORD = "k3y-" + "9f8e7d6c5b4a3210", "cs_live_" + "4eC39HqLyjWDarjtT1zdp7dc", "Tr0ub4dor" + "&3horsebatterystaple"
BEARER, URL_PASSWORD, PEM_BODY = "abcdefghij" + "klmnopqrstuvwxyz0123456789", "hunter2" + "hunter2", "MIIEpAIBAAKCAQEA" + "0Z3VS5JJcds3xfn"
SECRET_LINES = [
    ("ANTHROPIC_API_KEY=" + KEYS["anthropic-key"], KEYS["anthropic-key"]),
    ('{"api_key": "%s"}' % API_VALUE, API_VALUE),
    ('{\\"client_secret\\": \\"%s\\"}' % CLIENT_VALUE, CLIENT_VALUE),
    ("Authorization: Bearer " + BEARER, BEARER),
    (f"git clone https://tester:{URL_PASSWORD}@example.com/repo.git", URL_PASSWORD),
    (f"password = '{PASSWORD}'", PASSWORD),
    ("-----BEGIN RSA " + "PRIVATE KEY-----\n" + PEM_BODY + "\n-----END RSA " + "PRIVATE KEY-----", PEM_BODY),
    *((v, v) for v in KEYS.values()),
]
PLAIN_LINES = [
    '{"usage": {"input_tokens": 123456789012345678, "output_tokens": 98765}}',
    '{"session_id": "11111111-1111-4111-8111-111111111111", "tool_use_id": "toolu_01ABCDEFGHIJKLMNOPQRSTUV"}',
    "The password field on the login page was blank.",
    "https://github.com/example/thimble/issues/new",
    '{"apiKeyHelper": "/usr/local/bin/print-api-key --profile work"}',
]


def test_redact_replaces_keys_tokens_and_passwords_and_leaves_ordinary_text(env):
    for line, secret in SECRET_LINES:
        out, n = feedback.redact(line)
        assert secret not in out and n >= 1 and "[redacted:" in out, line
    for line in PLAIN_LINES:
        assert feedback.redact(line) == (line, 0), line


def test_no_secret_reaches_the_bundle_from_any_part(env):
    text = "\n".join(line for line, _ in SECRET_LINES)
    _lines(env["ws"] / "chats" / "new.jsonl", [{"type": "text", "delta": text}])
    (env["home"] / "server.log").write_text(text + "\n")
    _lines(env["ws"] / "permissions.jsonl", [{"event": "asked", "input": KEYS["github-token"]}])
    out = TestClient(app).post(f"/api/ws/{C}/feedback", json={
        "description": f"it failed with {KEYS['anthropic-key']}",
        "browser": [{"kind": "request", "text": f"401: bad key {KEYS['openai-key']}"}]}).json()
    files = _zip(out["path"])
    for name, data in files.items():
        for _, secret in SECRET_LINES:
            assert secret.encode() not in data, (name, secret)
    assert out["redacted"] >= 2 * len(SECRET_LINES)
    assert KEYS["anthropic-key"] not in out["issue_url"]
    assert f"{out['redacted']} values that looked like keys, tokens or passwords were replaced" in files["contents.txt"].decode()
    assert "[redacted:anthropic-key]" in files["description.txt"].decode()


@pytest.fixture()
def corpus(env):
    data = env["tmp"] / "data"
    (data / C).mkdir(parents=True)
    (data / C / "manifest.json").write_text('{"name": "mini"}')
    return data


def test_feedback_py_imports_only_the_standard_library_at_its_top():
    import ast
    import sys

    tree = ast.parse(Path(feedback.__file__).read_text())
    names = [a.name.split(".")[0] for node in tree.body if isinstance(node, ast.Import) for a in node.names]
    names += [node.module.split(".")[0] for node in tree.body if isinstance(node, ast.ImportFrom) and node.module and not node.level]
    assert names and all(n in sys.stdlib_module_names or n == "__future__" for n in names), names
    assert not [node for node in tree.body if isinstance(node, ast.ImportFrom) and node.level], "no app import at the top"


def test_thimble_feedback_through_the_supervisor_s_up_starts_nothing(env, corpus, monkeypatch, capsys):
    monkeypatch.setenv("THIMBLE_DATA_DIR", str(corpus))
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(config.WORKSPACES_DIR))
    monkeypatch.setattr(cli, "ensure_running", lambda wait: pytest.fail("must not start the server"))
    assert cli.main(["server", "up", "--cwd", str(corpus / C), "--session", "s1", "--action", "feedback"]) == 0
    lines = capsys.readouterr().out.splitlines()
    assert len(lines) == 5 and all(ln.startswith("thimble: ") for ln in lines), lines
    assert "workspace/chats/new.jsonl" not in lines[1] and "chats" in lines[1]
    assert lines[2:] == [f"thimble: {INSTRUCTIONS}",
                         f"thimble: Open a GitHub issue: {ISSUES}",
                         f"thimble: {CONTACT} on GitHub: {CONTACT_URL}"]




def test_the_bundle_holds_the_rotated_server_log_and_the_card_check_times(env):
    """A start that rotated the server log leaves the error before it in server.log.1, and a card check's times say
    how each check ended and why: both go in the report when they exist."""
    (env["home"] / "server.log.1").write_text("old line\nRuntimeError: the reason the server stopped\n")
    _lines(env["ws"] / "card-checks" / "timings.jsonl",
           [{"card": "c1", "outcome": "error", "reason": "Anthropic's API is overloaded", "total_ms": 1200}])
    out = feedback.build("after a restart", workspace=(C, env["ws"]))
    files = _zip(out["path"])
    assert files["server-log.1.txt"].decode().endswith("RuntimeError: the reason the server stopped\n")
    assert json.loads(files["workspace/check-timings.jsonl"].decode())["reason"] == "Anthropic's API is overloaded"
    contents = files["contents.txt"].decode()
    assert "server-log.1.txt" in contents and "workspace/check-timings.jsonl" in contents


POLL = ('2026-09-25 03:43:{s:02d},000 INFO:     127.0.0.1:5{n:04d} - "GET /api/ws/mini/chats?after={n} HTTP/1.1" '
        '200 OK\n')
TELEMETRY = '2026-09-25 03:58:00,000 INFO:     127.0.0.1:6{n:04d} - "POST /api/ws/mini/telemetry HTTP/1.1" {status} x\n'
EARLY = ("2026-09-25 03:40:01,000 ERROR thimble.error: request 14acf8b8 failed: POST /api/tools/add_card -> 500\n"
         "Traceback (most recent call last):\n"
         '  File "app/tools.py", line 10, in add_card\n'
         "KeyError: 'kind'\n")


def test_an_early_traceback_survives_a_long_log_of_polling(env):
    """A run of 20,000 lines of the tab's GET polling after an early error: the polling lines are left out, so the
    traceback is still in the report, and contents.txt says how many lines went."""
    log = env["home"] / "server.log"
    log.write_text("2026-09-25 03:40:00,000 INFO thimble: pid 1, port 8311\n" + EARLY
                   + "".join(POLL.format(s=n % 60, n=n) for n in range(20_000))
                   + "".join(TELEMETRY.format(n=n, status=201) for n in range(500))
                   + TELEMETRY.format(n=9, status=500)
                   + '2026-09-25 03:59:00,000 INFO:     127.0.0.1:1 - "POST /api/ws/mini/chats/main HTTP/1.1" '
                     '201 Created\n')
    files = _zip(feedback.build("the card vanished")["path"])
    text = files["server-log.txt"].decode()
    assert EARLY in text and "POST /api/ws/mini/chats/main" in text and "GET /api/ws/mini/chats" not in text
    assert text.count("/telemetry") == 1 and '/telemetry HTTP/1.1" 500' in text, "a failed telemetry POST stays"
    assert "without its 20,500 lines of GET polling and telemetry" in files["contents.txt"].decode()


def test_an_early_traceback_survives_a_log_longer_than_the_cap(env, monkeypatch):
    """When what is left is still longer than the cap, the tail is kept after the warnings and errors from before it,
    with the traceback's lines."""
    monkeypatch.setattr(feedback, "LOG_MAX", 50_000)
    monkeypatch.setattr(feedback, "EARLY_ERRORS_MAX", 5_000)
    log = env["home"] / "server.log"
    log.write_text(EARLY + "".join(f"2026-09-25 03:41:00,000 INFO thimble.jobs: step {n} done\n" for n in range(5_000)))
    files = _zip(feedback.build("slow")["path"])
    text = files["server-log.txt"].decode()
    head, rest = text.split("---- the tail of the log ----\n")
    assert EARLY in head and rest.endswith("step 4999 done\n") and len(text.encode()) <= 50_000
    assert "after 4 lines of warnings and errors from before that" in files["contents.txt"].decode()


def test_a_screenshot_asked_for_and_not_captured_is_said(env):
    out = feedback.build("the canvas is blank", shot_asked=True)
    assert out["screenshot_missing"] is True
    files = _zip(out["path"])
    contents = files["contents.txt"].decode()
    assert "asked for but not captured" in contents and not any(n.startswith("screenshot.") for n in files)
    assert feedback.build("with one", screenshot=_shot(), shot_asked=True)["screenshot_missing"] is False


def test_the_browser_can_download_the_bundle_it_asked_for_and_nothing_else(env):
    client = TestClient(app)
    out = client.post(f"/api/ws/{C}/feedback", json={"description": "x", "screenshot_asked": True}).json()
    assert out["screenshot_missing"] is True
    got = client.get("/api/feedback/download", params={"path": out["path"]})
    assert got.status_code == 200 and got.content == Path(out["path"]).read_bytes()
    assert out["name"] in got.headers["content-disposition"]
    stray = env["user"] / "Downloads" / "notes.zip"
    stray.write_bytes(b"PK")
    assert client.get("/api/feedback/download", params={"path": str(stray)}).status_code == 404
    assert client.get("/api/feedback/download", params={"path": str(env["home"] / "server.log")}).status_code == 404
    assert TestClient(RemoteApp(app)).get("/api/feedback/download", params={"path": out["path"]}).status_code == 403


def test_the_server_log_leaves_out_the_polling_at_the_source():
    """uvicorn's access line for a GET or HEAD below 400, or a telemetry POST below 400, is dropped
    (main.QuietPolling); other writes and failures stay."""
    import logging

    from app import main

    f = main.QuietPolling()

    def rec(method: str, status: int, path: str = "/api/x") -> logging.LogRecord:
        return logging.LogRecord("uvicorn.access", logging.INFO, "", 0, '%s - "%s %s HTTP/%s" %d',
                                 ("127.0.0.1:1", method, path, "1.1", status), None)

    assert not f.filter(rec("GET", 200)) and not f.filter(rec("HEAD", 304))
    assert f.filter(rec("GET", 404)) and f.filter(rec("GET", 500)) and f.filter(rec("POST", 201))
    assert not f.filter(rec("POST", 201, "/api/ws/mini/telemetry"))
    assert f.filter(rec("POST", 500, "/api/ws/mini/telemetry")) and f.filter(rec("POST", 201, "/api/ws/telemetry/chats"))
    other = logging.LogRecord("uvicorn.access", logging.INFO, "", 0, "a line of another shape", (), None)
    assert f.filter(other)
