"""Views round 5: run one generated-view trial end to end in a scratch thimble, for one pipeline and one corpus.

For a pipeline and a corpus it starts a thimble server of its own and a real main (Claude Code with thimble's plugin,
signed in by workload identity), types the corpus's request, lets main describe the data, propose its view or views and
the dev agent build them, waits for the gates and the reviews, then saves what came out. Nothing it starts outlives it.
Adapted from views-abstraction round 4's run_views.py (its capture, per view now, since pipeline 5 builds two).

    PY=<tree>/backend/.venv/bin/python
    $PY explore/r5/run_r5.py run --pipeline new --corpus collusion-wiki --home /mnt/store/scratch/rel/vr5/a \
        --port-base 26400 --slots 1 --slot 0 [--tag 1]
    $PY explore/r5/run_r5.py summary /mnt/store/scratch/rel/views-r5/runs/...
    $PY explore/r5/run_r5.py shoot <output folder>          # pictures again, from the instance
    $PY explore/r5/run_r5.py status | stop <instance> | clean <instance> ...

Pipelines (explore/r5/pipelines.json, --pipeline NAME): each names its tree (a checkout with backend/.venv and
frontend/dist), the prompts diff against origin/main it runs on (none for the baseline) and the environment it adds.
The run copies the tree's prompts/ and docs/ into the instance, applies the diff there (a diff the tree holds already is
left as it is) and points THIMBLE_PROMPTS_DIR and THIMBLE_VIEW_DOCS_DIR at the copies, so no tree is edited. The
pipelines' trees differ in code only: origin/main for the baseline; for the others a tree with profile_data and
pick_views (tools listed only where the prompts give them a section) and without plugin/viewers' worked examples,
which the examples pipeline points THIMBLE_VIEW_EXAMPLES_DIR at a copy of (/mnt/store/scratch/rel/views-r5/examples).
--tree, --overlay and --prompts-ref still work as in round 4 when no --pipeline is given.

Requests (explore/r5/requests.json): the text typed to main per corpus, the same in every pipeline; --request
overrides it.

Each run writes its output folder:
  facts.json        the run: pipeline, corpus, status, minutes, cost, and per view its form, first-load counts, hooks
                    and attempts (views[]), the profile main made (profile) and the picker's call (picks)
  main-calls.json   every call main made of propose_view, profile_data and pick_views: its input and its result
  profile/          what profile_data saved: types.ts or description.md, profile.txt, history/ (each call's pair)
  picks.json        pick_views' record: each call's concepts, the picker's prompt and the two it kept
  views/<slug>/     one folder per proposed view, round 4's layout: proposal.md (the propose_view input), attempts/<n>/
                    (files/, first-load.jpg, gate.txt), builder/ (checks/<n>.jpg, last-message.md), review/
                    (critique.md, before/files, rounds/<r>/, changes.diff, pictures/), final/ (files/, first-load.jpg,
                    hooks/*.jpg, shots.json), facts.json
  transcripts/      main's and each subagent's Claude Code transcript; agents.md the agents' last words
  run.json, log.jsonl, screen.txt, prompts.diff   the run's record and steps, main's last screen, the run's prompts and
                    docs against origin/main's
Every picture is a JPEG. The instance stays under <home>/runs/<pipeline>/<corpus>-<time>/ until `clean` deletes it.

Rules it keeps: CLAUDE_CONFIG_DIR is the run's config folder for main and the server; the WIF variables exist only in
the run's server and main's tmux server (wif.wif_env), never printed; ANTHROPIC_API_KEY is never set or read; every
THIMBLE_* and Claude Code variable of the caller is dropped; PATH is the instance's own (never ~/.local/bin); main quits
with /exit and "Exit and stop tasks", never "Move to background"; a safeguard stop ends the run (no model switch)."""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
DEFAULT_TREE = HERE.parent.parent
R5 = Path("/mnt/store/scratch/rel/views-r5")
HOME_ROOT = Path("/mnt/store/scratch/rel/vr5/home")  # --home changes it (configure); TMPDIR lives under it
CORPORA = (R5 / "corpora",)  # where --corpus looks for a name
OUT_ROOT = R5 / "runs"
CC = HOME_ROOT / "cc"  # --cc, or <home>/cc with --home
CC_TEMPLATE = Path("/mnt/store/scratch/rel/views-abstraction-cc/.claude.json")  # the onboarding keys a new one copies
PIPELINES = HERE / "pipelines.json"
REQUESTS = HERE / "requests.json"
PORT_BASE, SLOTS = 26400, 2  # ports 26400-26407, four per slot; --port-base and --slots change them
TMP_MAX = 64  # TMPDIR's length at most: Claude Code's sandbox puts unix sockets (108 bytes at most) under it
SYSTEM_PATH = ("/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin")
JPEG_QUALITY = 82
MAIN_CALLS = ("propose_view", "profile_data", "pick_views")  # main's calls main-calls.json keeps
WATCH_S = 2.0  # how often the watcher looks at the view's folder and its proposal
NEUTRAL = "Propose the view or views that would best help me understand this data."  # requests.json: same text
FIXED = ("Call propose_view now with exactly these fields, unchanged, and then make the Agent call it returns. "
         "Do not explore the files first.\n{fields}")
NUDGE = "Your choice; go ahead and propose it."
MAIN_MODEL = "claude-opus-5-5"
POLL_S = 10.0
HELLO_S = 300.0
MAIN_QUIET_S = 60.0  # main's screen without a spinner this long, with no view busy, ends the wait
REVIEW_GRACE_S = 150.0  # a passed build starts its review a moment later (view_review.after_built)
REVIEW_TAIL_S = 180.0  # after finish_review ends the review, its agent writes one last message
IDLE_NUDGE_S = 120.0  # main idle this long with no proposal, at least NUDGE_AFTER_S after the request: one nudge
NUDGE_AFTER_S = 240.0
MENU_STUCK_S = 300.0  # a permission menu on main's screen this long ends the run
DROP_ENV = re.compile(r"^(THIMBLE_|ANTHROPIC_|CLAUDECODE$|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$|"
                      r"TMUX$|TMUX_PANE$|VABS_)")
# main at work: the spinner line ("✽ Thundering… (10s · ↓ 497 tokens · thinking with high effort)"), or an older
# version's "esc to interrupt"
BUSY_WORDS = re.compile(r"esc to interrupt|…\s*\((\d+h\s*)?(\d+m\s*)?\d+s\b", re.I)
# Claude Code's permission menu: its question and a numbered Yes/No choice
MENU_WORDS = re.compile(r"Do you want to (proceed|make this edit|create|allow)", re.I)
MENU_CHOICE = re.compile(r"^\s*❯?\s*\d\.\s+(Yes|No)\b", re.M)
# a safety stop: main's meta `alert`, or these words on the screen with a menu line that switches models
SAFETY_WORDS = ("safety check", "Claude's safety")
SWITCH_LINE = re.compile(r"^\s*❯?\s*\d\.\s.*\bswitch", re.I | re.M)
SANDBOX_FAIL = "Sandbox is required but failed to initialize"  # Bash unusable in main or an agent (see Slot.tmp)
VIEW_SKIP = shutil.ignore_patterns("__pycache__", "cache", "*.lock")


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def read(p: Path) -> Any:
    try:
        return json.loads(Path(p).read_text("utf-8"))
    except (OSError, ValueError):
        return None


def write_json(p: Path, obj: Any) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=1, ensure_ascii=False, default=str), "utf-8")
    os.replace(tmp, p)


def venv_python(tree: Path) -> Path:
    return tree / "backend" / ".venv" / "bin" / "python"


def corpus_path(c: str) -> Path:
    p = Path(c)
    if not p.exists():
        p = next((d / c for d in CORPORA if (d / c).is_dir()), p)
    if not p.is_dir():
        raise SystemExit(f"run_views: no corpus folder {c!r} (nor under {', '.join(map(str, CORPORA))})")
    return p.resolve()


def configure(a: argparse.Namespace) -> None:
    """The scratch home, Claude Code's config folder and the ports this process uses (--home, --cc, --port-base,
    --slots)."""
    global HOME_ROOT, CC, PORT_BASE, SLOTS
    if getattr(a, "home", None):
        HOME_ROOT = Path(a.home).resolve()
        CC = HOME_ROOT / "cc"
    if getattr(a, "cc", None):
        CC = Path(a.cc).resolve()
    if getattr(a, "port_base", None):
        PORT_BASE = int(a.port_base)
    if getattr(a, "slots", None):
        SLOTS = int(a.slots)


def clean_path(tree: Path) -> str:
    """PATH for the instance: <home>/bin (a link to the claude binary, nothing else), the tree's plugin/bin and the
    system's folders. ~/.local/bin, which holds the analyst's own `thimble` launcher, and every other folder of the
    caller's PATH are left out."""
    bin_dir = HOME_ROOT / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    link = bin_dir / "claude"
    if not link.exists():
        found = shutil.which("claude") or next((str(p) for p in [Path.home() / ".local" / "bin" / "claude"]
                                                if p.exists()), None)
        if not found:
            raise SystemExit("run_views: claude is neither on PATH nor in ~/.local/bin")
        try:
            link.symlink_to(Path(found).resolve())
        except FileExistsError:  # another run of the lane made it first
            pass
    return ":".join([str(bin_dir), str(tree / "plugin" / "bin"), *SYSTEM_PATH])


CC_KEYS = ("hasCompletedOnboarding", "theme", "lastReleaseNotesSeen", "firstStartVersion", "lastClawdEntranceVersion",
           "officialMarketplaceAutoInstallAttempted", "hasSeenAutoModeEntryWarning",
           "hasResetAutoModeOptInForDefaultOffer", "opusProMigrationComplete", "sonnet1m45MigrationComplete",
           "migrationVersion")


def seed_cc(cc: Path) -> None:
    """A Claude Code config folder made for the first time: settings.json with the light theme, and .claude.json with
    the onboarding done (the keys CC_KEYS of the earlier runs' folder), so the first launch shows no setup screens. No
    account, project or identity is copied: the session signs in by workload identity."""
    if (cc / ".claude.json").exists():
        return
    cc.mkdir(parents=True, exist_ok=True)
    if not (cc / "settings.json").exists():
        write_json(cc / "settings.json", {"theme": "light"})
    src = read(CC_TEMPLATE) or {}
    seed = {k: src[k] for k in CC_KEYS if k in src} or {"hasCompletedOnboarding": True, "theme": "light"}
    tmp = cc / f".claude.json.seed-{os.getpid()}"
    tmp.write_text(json.dumps(seed, indent=1), "utf-8")
    if not (cc / ".claude.json").exists():
        os.replace(tmp, cc / ".claude.json")
    tmp.unlink(missing_ok=True)


def to_jpeg(src: Path, dest: Path) -> bool:
    """A PNG saved as a JPEG (the tree's venv has Pillow)."""
    try:
        from PIL import Image  # noqa: PLC0415
    except ImportError:
        return False
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(src) as im:
            im.convert("RGB").save(dest, "JPEG", quality=JPEG_QUALITY, optimize=True)
        return True
    except OSError:
        return False


def slug(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", text).strip("-") or "x"


def listening_ports() -> dict[int, list[int]]:
    """{port: [pids]} of the TCP ports something listens on (ss -ltnpH)."""
    out: dict[int, list[int]] = {}
    r = subprocess.run(["ss", "-ltnpH"], capture_output=True, text=True)
    for line in r.stdout.splitlines():
        parts = line.split()
        if len(parts) < 4:
            continue
        m = re.search(r":(\d+)$", parts[3])
        if not m:
            continue
        out.setdefault(int(m.group(1)), []).extend(int(x) for x in re.findall(r"pid=(\d+)", line))
    return out


def slot_ports(slot: int) -> list[int]:
    return [PORT_BASE + 4 * slot + i for i in range(4)]


def slot_tmp(slot: int) -> Path:
    return HOME_ROOT / "t" / str(slot)


def slot_socket(slot: int) -> str:
    """The slot's tmux server, named by its first port so that lanes with homes and port ranges of their own never
    share one."""
    return f"vabs{slot_ports(slot)[0]}"


def tmux_alive(sock: str) -> bool:
    return subprocess.run(["tmux", "-L", sock, "has-session"], capture_output=True).returncode == 0


def pids_of_home(home: Path) -> list[int]:
    """Processes whose environment names this instance's THIMBLE_HOME (the server, kernels, main's tools)."""
    want = f"THIMBLE_HOME={home}".encode()
    out = []
    for d in Path("/proc").iterdir():
        if not d.name.isdigit() or int(d.name) == os.getpid():
            continue
        try:
            env = (d / "environ").read_bytes()
        except OSError:
            continue
        if want + b"\0" in env or env.endswith(want):
            out.append(int(d.name))
    return out


def kill_pids(pids: list[int], note) -> None:
    for sig in (signal.SIGTERM, signal.SIGKILL):
        live = []
        for p in pids:
            try:
                os.kill(p, sig)
                live.append(p)
            except OSError:
                pass
        if not live:
            return
        note("killed", pids=live, signal=sig.name)
        time.sleep(3)
        pids = [p for p in live if Path(f"/proc/{p}").exists()]


EXIT_CHOICE = "Exit and stop tasks"
QUIT_WAIT_S = 90.0


def quit_main(term, note) -> bool:
    """/exit, then "Exit and stop tasks" when Claude Code asks what to do with the tasks still running. The menu's cursor
    moves one line at a time, the screen read again after each move, and Enter is pressed only on the line that reads
    "Exit and stop tasks", so no other choice ("Move to background" among them) is ever taken; Left is never pressed.
    True when main ended."""
    if not term.alive():
        return True
    term.keys("Escape")
    time.sleep(0.5)
    term.text("/exit")
    time.sleep(0.5)
    term.keys("Enter")
    deadline = time.monotonic() + QUIT_WAIT_S
    steps = 0
    while time.monotonic() < deadline and term.alive():
        lines = term.screen().splitlines()
        at = max((i for i, ln in enumerate(lines) if EXIT_CHOICE in ln), default=None)
        if at is None:
            time.sleep(1.0)
            continue
        if lines[at].lstrip().startswith("❯"):
            term.keys("Enter")
            note("exit-and-stop-tasks", steps=steps)
            time.sleep(2.0)
            continue
        near = [i for i in range(max(0, at - 6), min(len(lines), at + 7)) if lines[i].lstrip().startswith("❯")]
        if not near or steps > 12:
            time.sleep(1.0)
            continue
        cur = min(near, key=lambda i: abs(i - at))
        term.keys("Down" if at > cur else "Up")
        steps += 1
        time.sleep(0.6)
    ended = not term.alive()
    note("quit", ended=ended)
    return ended


# ----------------------------------------------------------------------------------------------------------------------
# one run
# ----------------------------------------------------------------------------------------------------------------------


class Slot:
    """An instance slot held for the run's life: a lock file, its four ports free and its tmux server down."""

    def __init__(self, want: int | None) -> None:
        (HOME_ROOT / "slots").mkdir(parents=True, exist_ok=True)
        order = [want] if want is not None else list(range(SLOTS))
        busy = listening_ports()
        for n in order:
            f = open(HOME_ROOT / "slots" / f"{n}.lock", "a+")
            try:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                f.close()
                continue
            if any(p in busy for p in slot_ports(n)) or tmux_alive(slot_socket(n)):
                fcntl.flock(f, fcntl.LOCK_UN)
                f.close()
                continue
            # a short TMPDIR: Claude Code's sandbox makes its bridge sockets under it, and a unix socket's path must stay
            # under 108 bytes (a TMPDIR inside the instance folder broke every Bash call: "Sandbox is required but
            # failed to initialize: Failed to create bridge sockets"; srt-mux-<pid>-<n>.sock is added to it)
            tmp = slot_tmp(n)
            if len(str(tmp)) > TMP_MAX:
                fcntl.flock(f, fcntl.LOCK_UN)
                f.close()
                raise SystemExit(f"run_views: TMPDIR {tmp} is longer than {TMP_MAX} characters, which breaks Claude "
                                 "Code's sandbox; pick a shorter --home")
            f.seek(0)
            f.truncate()
            f.write(f"{os.getpid()} {now()}\n")
            f.flush()
            self.n, self.file = n, f
            self.ports = slot_ports(n)
            self.socket = slot_socket(n)
            self.tmp = tmp
            shutil.rmtree(self.tmp, ignore_errors=True)
            self.tmp.mkdir(parents=True)
            return
        raise SystemExit(f"run_views: no free slot among {order}")

    def release(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)
        try:
            self.file.seek(0)
            self.file.truncate()
            fcntl.flock(self.file, fcntl.LOCK_UN)
            self.file.close()
        except (OSError, ValueError):
            pass


def apply_diff(diff: Path, root: Path) -> str:
    """Apply a prompts diff (paths a/prompts/..., a/docs/...) to the copies under `root`: 'applied', 'already' when the
    copies hold it already (the tree has it), else RuntimeError with git's words."""
    subprocess.run(["git", "init", "-q", str(root)], check=True, capture_output=True)
    ok = subprocess.run(["git", "-C", str(root), "apply", "--check", str(diff)], capture_output=True, text=True)
    if ok.returncode == 0:
        subprocess.run(["git", "-C", str(root), "apply", str(diff)], check=True, capture_output=True)
        shutil.rmtree(root / ".git", ignore_errors=True)
        return "applied"
    back = subprocess.run(["git", "-C", str(root), "apply", "--check", "--reverse", str(diff)], capture_output=True)
    shutil.rmtree(root / ".git", ignore_errors=True)
    if back.returncode == 0:
        return "already"
    raise RuntimeError(f"the prompts diff {diff} does not apply: {(ok.stderr or '')[-600:]}")


def make_pipeline_prompts(tree: Path, diff: Path | None, dest: Path) -> dict[str, Any]:
    """A pipeline's prompts and docs: the tree's prompts/ and docs/ copied to dest/prompts and dest/docs, and its diff
    applied to the copies; what they were made from."""
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    shutil.copytree(tree / "prompts", dest / "prompts")
    shutil.copytree(tree / "docs", dest / "docs")
    how = apply_diff(diff, dest) if diff else "no diff"
    head = subprocess.run(["git", "-C", str(tree), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    return {"tree": str(tree), "tree_head": head, "base": "tree prompts/ and docs/ on disk",
            "diff": str(diff) if diff else None, "diff_applied": how, "overlay": None, "overlay_files": []}


def make_prompts(tree: Path, ref: str | None, overlay: Path | None, dest: Path) -> dict[str, Any]:
    """Round 4's variant prompts folder (no --pipeline): the base (prompts/ at `ref`, else the tree's on disk) with
    `overlay` copied over; returns what it was made from."""
    if dest.exists():
        shutil.rmtree(dest)
    if ref:
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.parent / "prompts-ref"
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir()
        arch = subprocess.run(["git", "-C", str(tree), "archive", ref, "prompts"], capture_output=True, check=True)
        subprocess.run(["tar", "-x", "-C", str(tmp)], input=arch.stdout, check=True)
        shutil.move(str(tmp / "prompts"), str(dest))
        shutil.rmtree(tmp, ignore_errors=True)
    else:
        shutil.copytree(tree / "prompts", dest)
    copied = []
    if overlay:
        for f in sorted(p for p in overlay.rglob("*") if p.is_file()):
            rel = f.relative_to(overlay)
            (dest / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, dest / rel)
            copied.append(str(rel))
    head = subprocess.run(["git", "-C", str(tree), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    dirty = subprocess.run(["git", "-C", str(tree), "status", "--porcelain", "prompts"], capture_output=True,
                           text=True).stdout.strip()
    return {"tree": str(tree), "tree_head": head, "base": ref or "tree prompts/ on disk",
            "tree_prompts_dirty": bool(dirty) and not ref, "overlay": str(overlay) if overlay else None,
            "overlay_files": copied}


def prompts_diff(tree: Path, prompts: Path, work: Path, docs: Path | None = None) -> str:
    """The run's prompts (and docs) against origin/main's (diff -ru)."""
    main = work / "prompts-origin-main"
    shutil.rmtree(main, ignore_errors=True)
    main.mkdir(parents=True)
    arch = subprocess.run(["git", "-C", str(tree), "archive", "origin/main", "prompts", "docs"], capture_output=True)
    if arch.returncode != 0:
        return "(origin/main not found)\n"
    subprocess.run(["tar", "-x", "-C", str(main)], input=arch.stdout, check=True)
    out = subprocess.run(["diff", "-ruN", str(main / "prompts"), str(prompts)], capture_output=True, text=True).stdout
    if docs is not None:
        out += subprocess.run(["diff", "-ruN", str(main / "docs"), str(docs)], capture_output=True, text=True).stdout
    shutil.rmtree(main, ignore_errors=True)
    return out or "(no difference from origin/main)\n"


def instance_env(inst: Path, slot: Slot, tree: Path, prompts: Path, a: argparse.Namespace,
                 extra: dict[str, str] | None = None) -> dict[str, str]:
    """The environment of the instance's server and tools: the caller's without any THIMBLE_*, ANTHROPIC_* or Claude
    Code variable, plus the instance's home, ports, prompts and Claude Code config folder, a PATH of its own
    (clean_path) and `extra` (the pipeline's docs folder and environment). No WIF variable: the run adds it to the
    server's and main's environments only."""
    env = {k: v for k, v in os.environ.items() if not DROP_ENV.match(k)}
    home = inst / "home"
    p = slot.ports
    env.update({"PATH": clean_path(tree), "THIMBLE_HOME": str(home), "THIMBLE_WORKSPACES_DIR": str(home / "workspaces"),
                "THIMBLE_DATA_DIR": str(home / "data"), "THIMBLE_DEV_DIR": str(home / "dev"),
                "THIMBLE_PORT": str(p[0]), "THIMBLE_UI_PORT": str(p[1]), "THIMBLE_STACK_PORT": str(p[2]),
                "THIMBLE_STACK_UI_PORT": str(p[3]), "TMPDIR": str(slot.tmp), "CLAUDE_CODE_DISABLE_AGENT_VIEW": "1",
                "DISABLE_AUTOUPDATER": "1", "THIMBLE_PROMPTS_DIR": str(prompts), "CLAUDE_CONFIG_DIR": str(CC),
                "VABS_TREE": str(tree)})
    if a.no_review:
        env["THIMBLE_VIEW_REVIEW"] = "off"
    if a.dev_model:
        env["THIMBLE_DEV_MODEL"] = a.dev_model
    if a.dev_effort:
        env["THIMBLE_DEV_EFFORT"] = a.dev_effort
    env.update(extra or {})
    return env


class Watcher:
    """What thimble keeps no copy of, taken while the run lasts, every WATCH_S, for each proposed view, into
    <instance>/capture/<slug>/:
      attempts/<n>/files  the view's files at each builder attempt: a finish_view call raises the proposal's `attempt`
                          before its gate runs, and the builder waits for the gate's answer, so files taken then are the
                          gate's (place_attempts checks this against the call's time in the builder's transcript);
      review/<r>/files    the view after each review round whose revision passed its gate (the review's `round` goes up
                          with the digest of those files, which `exact` compares);
      checks/<name>.png   each picture the builder's view_check took (the view keeps only the newest views.SHOTS_KEPT).
    <slug>/watch.json lists them."""

    def __init__(self, run: "Run") -> None:
        self.run = run
        self.dir = run.inst / "capture"
        self.state: dict[str, dict[str, Any]] = {}
        self.errors = 0
        self.done = threading.Event()
        self.thread = threading.Thread(target=self.loop, daemon=True, name="vr5-watch")

    def start(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        self.thread.start()

    def stop(self) -> None:
        self.done.set()
        if self.thread.ident is not None:
            self.thread.join(timeout=60)
        try:
            self.tick()  # a last look
        except Exception as e:  # noqa: BLE001
            self.run.note("watch-error", error=repr(e))
        self.save()

    def save(self) -> None:
        for slug_, st in self.state.items():
            write_json(self.dir / slug_ / "watch.json", {"snapshots": st["records"], "checks": sorted(st["checks"]),
                                                         "errors": self.errors})

    def loop(self) -> None:
        while not self.done.wait(WATCH_S):
            try:
                self.tick()
            except Exception as e:  # noqa: BLE001 — a missed look is retried at the next one
                self.errors += 1
                if self.errors <= 3:
                    self.run.note("watch-error", error=repr(e))

    def tick(self) -> None:
        for row in self.run.proposals():
            self.tick_view(row)

    def tick_view(self, row: dict[str, Any]) -> None:
        slug_ = row["slug"]
        st = self.state.setdefault(slug_, {"attempt": 0, "seq": 0, "round": 0, "checks": set(), "records": []})
        src = self.run.ws / "extension" / "views" / slug_
        out = self.dir / slug_
        att = int(row.get("attempt") or 0)
        if att and att != st["attempt"]:  # a new attempt (a new builder starts its count at 0 again)
            st["seq"] += 1
            self.snap(st, slug_, src, out / "attempts" / str(st["seq"]), kind="attempt", seq=st["seq"], attempt=att,
                      status=row.get("status"), agent=row.get("agent_id"))
        st["attempt"] = att
        rv = row.get("review") if isinstance(row.get("review"), dict) else {}
        rnd = int(rv.get("round") or 0)
        if rnd > st["round"]:
            self.snap(st, slug_, src, out / "review" / str(rnd), kind="review", round=rnd, digest=rv.get("digest"))
            st["round"] = rnd
        shots = src / "cache" / "shots"
        if shots.is_dir():
            for p in sorted(shots.glob("check-*.png")):
                if p.name not in st["checks"]:
                    (out / "checks").mkdir(parents=True, exist_ok=True)
                    shutil.copy2(p, out / "checks" / p.name)
                    st["checks"].add(p.name)

    def snap(self, st: dict[str, Any], slug_: str, src: Path, dest: Path, **info: Any) -> None:
        if not src.is_dir():
            return
        at = datetime.now(timezone.utc).isoformat(timespec="milliseconds")  # compared with the transcript's times
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(src, dest / "files", ignore=VIEW_SKIP)
        mt = max((p.stat().st_mtime for p in (dest / "files").rglob("*") if p.is_file()), default=0.0)
        rec: dict[str, Any] = {"dir": str(dest), "at": at, **info,
                               "files_mtime": datetime.fromtimestamp(mt, timezone.utc).isoformat(timespec="milliseconds")}
        if info.get("kind") == "review":
            from app import views  # noqa: PLC0415

            rec["exact"] = bool(info.get("digest")) and views.view_digest(dest / "files") == info.get("digest")
        st["records"].append(rec)
        self.run.note("snapshot", view=slug_, of=rec["kind"],
                      **{k: v for k, v in rec.items() if k not in ("dir", "digest", "kind")})


class Run:
    def __init__(self, a: argparse.Namespace) -> None:
        self.a = a
        self.pipeline: dict[str, Any] | None = None
        if a.pipeline:
            table = read(PIPELINES) or {}
            if a.pipeline not in table:
                raise SystemExit(f"run_r5: no pipeline {a.pipeline!r} in {PIPELINES} ({', '.join(table)})")
            self.pipeline = dict(table[a.pipeline])
            a.variant = a.pipeline
            a.tree = self.pipeline["tree"]
        self.tree = Path(a.tree).resolve()
        self.wif: dict[str, str] = {}
        self.corpus = corpus_path(a.corpus)
        self.name = self.corpus.name
        leaf = self.name + (f"-{slug(a.tag)}" if a.tag else "")
        self.out = Path(a.leaf).resolve() if a.leaf else Path(a.out).resolve() / slug(a.variant) / leaf
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        self.inst = HOME_ROOT / "runs" / slug(a.variant) / f"{leaf}-{stamp}"
        self.rec: dict[str, Any] = {"variant": a.variant, "corpus": self.name, "corpus_source": str(self.corpus),
                                    "tag": a.tag, "status": "starting", "out": str(self.out),
                                    "instance": str(self.inst), "times": {"start": now()}, "nudges": [],
                                    "main_model": a.model, "review_on": not a.no_review,
                                    "pipeline": a.pipeline, "pipeline_config": self.pipeline}
        self.t0 = time.monotonic()
        self.term = None
        self.slot: Slot | None = None
        self.server_env: dict[str, str] = {}
        self.watch: Watcher | None = None

    # -- bookkeeping ---------------------------------------------------------------------------------------------------
    def note(self, kind: str, **f: Any) -> None:
        line = {"at": now(), "t": round(time.monotonic() - self.t0, 1), "kind": kind, **f}
        print(f"[{self.name}] {kind} {json.dumps(f, default=str)[:300]}", flush=True)
        with (self.inst / "log.jsonl").open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(line, ensure_ascii=False, default=str) + "\n")

    def mark(self, what: str) -> None:
        self.rec["times"][what] = now()

    def save(self) -> None:
        write_json(self.out / "run.json", self.rec)

    # -- setup ---------------------------------------------------------------------------------------------------------
    def claim_out(self) -> bool:
        """The output folder, made empty for this run; False when one exists and --force is not given."""
        if self.out.exists():
            if not self.a.force:
                return False
            self.out.rename(self.out.with_name(self.out.name + f".old-{datetime.now():%Y%m%d-%H%M%S}"))
        self.out.mkdir(parents=True)
        return True

    def prepare(self) -> None:
        for d in ("home", "data"):
            (self.inst / d).mkdir(parents=True, exist_ok=True)
        # a hard-linked copy at a path of this run's own (the files stay read-only, as the originals are)
        self.data = self.inst / "data" / self.name
        subprocess.run(["cp", "-al", str(self.corpus), str(self.data)], check=True)
        extra: dict[str, str] = {}
        if self.pipeline is not None:
            diff = Path(self.pipeline["diff"]) if self.pipeline.get("diff") else None
            self.rec["prompts"] = make_pipeline_prompts(self.tree, diff, self.inst / "pp")
            self.prompts, docs = self.inst / "pp" / "prompts", self.inst / "pp" / "docs"
            extra = {"THIMBLE_VIEW_DOCS_DIR": str(docs), **{k: str(v) for k, v in (self.pipeline.get("env") or {}).items()}}
            (self.out / "prompts.diff").write_text(prompts_diff(self.tree, self.prompts, self.inst, docs), "utf-8")
        else:
            overlay = Path(self.a.overlay).resolve() if self.a.overlay else None
            self.prompts = self.inst / "prompts"
            self.rec["prompts"] = make_prompts(self.tree, self.a.prompts_ref, overlay, self.prompts)
            (self.out / "prompts.diff").write_text(prompts_diff(self.tree, self.prompts, self.inst), "utf-8")
        self.rec["extra_env"] = extra
        seed_cc(CC)
        self.slot = Slot(self.a.slot)
        self.rec["slot"] = {"n": self.slot.n, "ports": self.slot.ports, "socket": self.slot.socket}
        self.rec["home"], self.rec["claude_config_dir"], self.rec["tree"] = str(HOME_ROOT), str(CC), str(self.tree)
        self.server_env = instance_env(self.inst, self.slot, self.tree, self.prompts, self.a, extra)
        # this process reads the instance's thimble state through app.config, so its environment names the instance
        os.environ.clear()
        os.environ.update(self.server_env)
        sys.path.insert(0, str(HERE))
        sys.path.insert(0, str(self.tree / "scripts" / "dev"))
        sys.path.insert(0, str(self.tree / "backend"))
        self.save()
        self.note("prepared", slot=self.slot.n, ports=self.slot.ports, socket=self.slot.socket, tree=str(self.tree),
                  home=str(HOME_ROOT), cc=str(CC), prompts=self.rec["prompts"])

    def check_prompts(self) -> None:
        """Every prompt file the overlay changed loads (its includes and directives are sound), as dev.py's gate checks
        a prompt edit; the prompts main, the builder and the reviewer start from load too."""
        names = [f[:-3] for f in (self.rec["prompts"].get("overlay_files") or []) if f.endswith(".md")]
        names += [n for n in ("main", "tools", "dev", "dev-view", "dev-view-task", "view-review") if n not in names]
        names += [n for n in ("dev-view-data", "view-pick", "views", "view-kit", "view-principles")
                  if (self.prompts / f"{n}.md").is_file() and n not in names]
        code = "import sys\nfrom app import prompts\nfor n in sys.argv[1:]: prompts.load(n)\nprint('ok')"
        r = subprocess.run([str(venv_python(self.tree)), "-c", code, *names], capture_output=True, text=True,
                           cwd=str(self.tree / "backend"), env={**self.server_env, "THIMBLE_SKIP_KEY": "1"}, timeout=120)
        self.note("prompts-load", ok=r.returncode == 0, names=names, tail=(r.stdout + r.stderr)[-600:])
        if r.returncode != 0:
            raise RuntimeError(f"the variant's prompts do not load: {(r.stdout + r.stderr)[-600:]}")

    def thimble(self, *args: str, timeout: float = 180, signed_in: bool = False) -> subprocess.CompletedProcess:
        env = {**self.server_env, **self.wif} if signed_in else self.server_env
        return subprocess.run([str(self.tree / "plugin" / "bin" / "thimble"), *args], capture_output=True, text=True,
                              env=env, cwd=str(self.data), timeout=timeout)

    def sign_in(self) -> None:
        """A fresh identity token, kept fresh while the run lasts, and the WIF variables, which only the server's and
        main's environments get (the server's own model calls, such as pick_views' picker, sign in with them)."""
        import wif as bb  # noqa: PLC0415

        opts = argparse.Namespace(wif="hiprio", claude_config_dir=str(CC))
        bb.refresh_token(opts)
        threading.Thread(target=bb.keep_token_fresh, args=(opts,), daemon=True).start()
        self.wif = bb.wif_env(opts)

    def server_up(self) -> None:
        self.sign_in()
        r = self.thimble("server", "up", "--cwd", str(self.data), signed_in=True)
        self.note("server-up", code=r.returncode, out=(r.stdout + r.stderr)[-400:])
        if r.returncode != 0:
            raise RuntimeError(f"server up failed: {(r.stdout + r.stderr)[-400:]}")
        from app import cli, config  # noqa: PLC0415

        code, body = cli._request("POST", f"{cli.api_url()}/api/corpora/register", {"path": str(self.data)},
                                  timeout=120)
        self.c = body.get("name") if isinstance(body, dict) and body.get("name") else self.name
        self.ws = config.workspace_dir(self.c)
        self.rec["workspace"] = self.c
        # the server must read the variant's prompts
        srv = read(self.inst / "home" / "server.json") or {}
        pid = srv.get("pid")
        seen = path = None
        if pid:
            try:
                env = Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
                seen = next((e.decode().split("=", 1)[1] for e in env if e.startswith(b"THIMBLE_PROMPTS_DIR=")), None)
                path = next((e.decode().split("=", 1)[1] for e in env if e.startswith(b"PATH=")), None)
            except OSError:
                pass
        self.rec["server_prompts_dir"], self.rec["server_path"] = seen, path
        self.note("registered", workspace=self.c, register_code=code, server_pid=pid, server_prompts_dir=seen,
                  server_path=path)
        if pid and seen != str(self.prompts):
            raise RuntimeError(f"the server reads prompts from {seen!r}, not {self.prompts}")
        self.mark("server_up")

    def start_main(self) -> None:
        import precache_orientation as pc  # noqa: PLC0415
        import wif as bb  # noqa: PLC0415

        main_env = {**self.server_env, **self.wif}  # the WIF variables reach main's tmux server, as the server's
        self.term = pc.Terminal(self.slot.socket)
        if self.term.alive():
            self.term.stop()
        cmd = pc.launch_command(self.tree, "auto", main_env) + f" --model {self.a.model}"
        subprocess.run(["tmux", "-L", self.slot.socket, "new-session", "-d", "-s", pc.SESSION, "-x", "200", "-y", "50",
                        "-c", str(self.data), cmd], env=main_env, check=True, capture_output=True)
        del main_env
        self.mark("main_started")
        said, deadline = None, time.monotonic() + HELLO_S
        while time.monotonic() < deadline and self.term.alive():
            screen = self.term.screen()
            yes = next((ln.strip(" ❯") for ln in screen.splitlines() if bb.TRUST_YES.search(ln)), None)
            moves = pc.menu_moves(screen, yes) if yes else None
            if moves is not None:
                self.term.keys(*(["Down"] * moves if moves > 0 else ["Up"] * -moves), "Enter")
                self.note("trusted-folder")
                time.sleep(2)
            said = pc.hello(self.ws)
            if said:
                break
            time.sleep(1)
        self.save_screen()
        if not said:
            raise RuntimeError("main's module never said hello")
        self.mark("hello")
        self.note("hello", version=said.get("version"))
        # main's MCP tools (propose_view's schema among them) are listed from the prompts folder their process reads
        seen = self.mcp_prompts_dir()
        self.rec["mcp_prompts_dir"] = seen
        self.note("mcp-prompts", dir=seen)
        if seen is not None and seen != str(self.prompts):
            raise RuntimeError(f"main's MCP tools read prompts from {seen!r}, not {self.prompts}")

    def mcp_prompts_dir(self) -> str | None:
        """THIMBLE_PROMPTS_DIR as main's thimble-mcp process has it ('' when unset); None when no such process is
        found."""
        for pid in pids_of_home(self.inst / "home"):
            try:
                cmd = Path(f"/proc/{pid}/cmdline").read_bytes()
                env = Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
            except OSError:
                continue
            if b"thimble-mcp" in cmd:
                return next((e.decode().split("=", 1)[1] for e in env if e.startswith(b"THIMBLE_PROMPTS_DIR=")), "")
        return None

    def idle(self, quiet_s: float, cap_s: float) -> bool:
        """Wait until main's screen has shown no spinner for quiet_s seconds, at most cap_s: an /exit typed while main
        works can be lost, and then main is only killed with its tmux server."""
        since, end = None, time.monotonic() + cap_s
        while time.monotonic() < end and self.term is not None and self.term.alive():
            busy = bool(BUSY_WORDS.search(self.term.screen()))
            since = None if busy else (since or time.monotonic())
            if since and time.monotonic() - since >= quiet_s:
                return True
            time.sleep(1.0)
        return False

    def save_screen(self) -> str:
        screen = self.term.screen() if self.term is not None and self.term.alive() else ""
        if screen.strip():
            (self.inst / "screen.txt").write_text(screen, "utf-8")
        return screen

    def say(self, text: str) -> None:
        import precache_orientation as pc  # noqa: PLC0415

        if "\n" in text:
            # a message of several lines goes in as one bracketed paste, so its line breaks do not send it early
            self.term.tmux("set-buffer", "-b", "vabs", text)
            self.term.tmux("paste-buffer", "-d", "-b", "vabs", "-p", "-t", pc.SESSION)
        else:
            self.term.text(text)
        time.sleep(1.0)
        self.term.keys("Enter")

    # -- the trial -----------------------------------------------------------------------------------------------------
    def request(self) -> None:
        if self.a.proposal:
            fields = json.loads(Path(self.a.proposal).read_text("utf-8"))
            text = FIXED.format(fields=json.dumps(fields, indent=1, ensure_ascii=False))
        else:
            text = self.a.request or str((read(REQUESTS) or {}).get(self.name) or NEUTRAL)
        self.rec["request"] = text
        time.sleep(3)
        self.say(text)
        self.mark("request")
        self.note("request", text=text[:200])

    def proposals(self) -> list[dict[str, Any]]:
        props = read(self.ws / "views" / "proposals.json")
        rows = props if isinstance(props, list) else (props or {}).get("proposals") or []
        return sorted((r for r in rows if isinstance(r, dict) and r.get("slug")), key=lambda r: str(r.get("ts") or ""))

    def snapshot(self, slug_: str, dest: Path) -> bool:
        src = self.ws / "extension" / "views" / slug_
        if not src.is_dir():
            return False
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(src, dest, ignore=VIEW_SKIP)
        return True

    def reviewer_writing(self, rv: dict[str, Any], t: float, done_at: dict[str, float]) -> bool:
        """The review is done but its agent has not ended: it is still writing its last message (its ten-second
        sentence), which quitting main now would lose. Wait for it, at most REVIEW_TAIL_S."""
        chat = str(rv.get("chat") or "")
        if not chat:
            return False
        first = done_at.setdefault(chat, t)
        m = read(self.ws / "chats" / f"{chat}.meta.json") or {}
        return m.get("status") in ("running", "queued", None) and t - first < REVIEW_TAIL_S

    def wait(self) -> None:
        cap = self.t0 + self.a.minutes * 60
        propose_cap = time.monotonic() + self.a.propose_minutes * 60
        asked = time.monotonic()
        idle_since, menu_since, main_quiet_since = None, None, None
        last, built_at, gate_saved = None, {}, set()
        review_done_at: dict[str, float] = {}
        while time.monotonic() < cap:
            rows = self.proposals()
            line = "; ".join(f"{r['slug']}: {r.get('status')} attempt={r.get('attempt')} "
                             f"review={(r.get('review') or {}).get('state') if isinstance(r.get('review'), dict) else r.get('review')}"
                             for r in rows)
            if line != last:
                self.note("status", line=line or "(no proposal yet)")
                last = line
            screen = self.save_screen()
            meta = read(self.ws / "chats" / "main.meta.json") or {}
            alert = str(meta.get("alert") or "")
            if any(w in alert for w in SAFETY_WORDS) or (any(w in screen for w in SAFETY_WORDS)
                                                         and SWITCH_LINE.search(screen)):
                self.rec["status"] = "safeguard"
                self.note("safeguard", alert=alert[:300])
                return
            if not self.term.alive():
                self.rec["status"] = "main-exited"
                self.note("main-exited")
                return
            menu = bool(MENU_WORDS.search(screen) and MENU_CHOICE.search(screen))
            menu_since = (menu_since or time.monotonic()) if menu else None
            if menu_since and time.monotonic() - menu_since > MENU_STUCK_S:
                self.rec["status"] = "permission-menu"
                self.note("permission-menu", screen=screen[-1500:])
                return
            t = time.monotonic()
            busy_main = bool(BUSY_WORDS.search(screen))
            main_quiet_since = None if busy_main else (main_quiet_since or t)
            for r in rows:
                if r.get("status") == "built" and r["slug"] not in built_at:
                    built_at[r["slug"]] = t
                    self.rec["times"].setdefault("built", now())
                if r.get("status") == "built" and r["slug"] not in gate_saved:
                    if self.snapshot(r["slug"], self.view_dir(r["slug"]) / "review" / "before" / "files"):
                        gate_saved.add(r["slug"])
                        self.note("gate-passed", slug=r["slug"], attempt=r.get("attempt"))
                if r.get("status") == "failed":
                    self.rec["times"].setdefault("failed", now())
            if not rows:
                if "proposed" in self.rec["times"]:
                    pass
                elif t > propose_cap:
                    self.rec["status"] = "no-proposal"
                    self.note("no-proposal")
                    return
                busy = bool(BUSY_WORDS.search(screen))
                idle_since = None if busy or menu else (idle_since or t)
                if (idle_since and t - idle_since > IDLE_NUDGE_S and t - asked > NUDGE_AFTER_S
                        and not self.rec["nudges"]):
                    self.say(NUDGE)
                    self.rec["nudges"].append({"at": now(), "text": NUDGE, "screen": screen[-1500:]})
                    self.note("nudge", text=NUDGE)
                    idle_since = None
                time.sleep(POLL_S)
                continue
            self.rec["times"].setdefault("proposed", now())

            def busy(r: dict[str, Any]) -> bool:
                rv = r.get("review") if isinstance(r.get("review"), dict) else None
                if r.get("status") in ("queued", "building"):
                    return True
                if rv and rv.get("state") in ("running", "queued"):
                    return True
                if rv and rv.get("state") == "done" and self.reviewer_writing(rv, t, review_done_at):
                    return True
                return (r.get("status") == "built" and not rv and not self.a.no_review
                        and t - built_at.get(r["slug"], t) < REVIEW_GRACE_S)

            # settled: no view builds or is reviewed, and main has been quiet a while, since main may still be
            # proposing another view (pipeline 5 proposes two)
            if not any(busy(r) for r in rows) and main_quiet_since and t - main_quiet_since >= MAIN_QUIET_S:
                first = rows[0]
                self.rec["status"] = {"built": "built", "failed": "failed"}.get(str(first.get("status")),
                                                                               str(first.get("status")))
                self.mark("settled")
                self.note("settled", status=self.rec["status"])
                return
            time.sleep(POLL_S)
        self.rec["status"] = "timeout"
        self.note("timeout", minutes=self.a.minutes)

    # -- stop ----------------------------------------------------------------------------------------------------------
    def stop(self) -> None:
        if self.watch is not None:
            self.watch.stop()
        if self.term is not None:
            try:
                self.save_screen()
                self.note("main-idle", idle=self.idle(5.0, 90.0))
                quit_main(self.term, self.note)
                self.term.stop()
            except Exception as e:  # noqa: BLE001
                self.note("stop-main-error", error=repr(e))
            self.mark("main_stopped")
        if self.server_env:
            try:
                r = self.thimble("server", "stop", "--yes", timeout=120)
                self.note("server-stop", code=r.returncode, out=(r.stdout + r.stderr)[-300:])
            except Exception as e:  # noqa: BLE001
                self.note("server-stop-error", error=repr(e))
            kill_pids(pids_of_home(self.inst / "home"), self.note)
        if self.slot is not None:
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline and any(p in listening_ports() for p in self.slot.ports):
                time.sleep(2)
            busy = {p: v for p, v in listening_ports().items() if p in self.slot.ports}
            self.rec["ports_free_at_end"] = not busy
            if busy:
                self.note("ports-still-busy", ports=busy)
            if tmux_alive(self.slot.socket):
                subprocess.run(["tmux", "-L", self.slot.socket, "kill-server"], capture_output=True)

    # -- results -------------------------------------------------------------------------------------------------------
    def view_dir(self, slug_: str) -> Path:
        return self.out / "views" / slug(slug_)

    def collect(self) -> None:
        rows = self.proposals() if hasattr(self, "ws") else []
        self.rec["proposals"] = [{k: v for k, v in r.items() if k not in ("locators",)} for r in rows]
        self.rec["views"] = [r["slug"] for r in rows]
        if rows:
            first = rows[0]
            self.rec["slug"] = first["slug"]
            self.rec["view_name"] = first.get("name")
        for r in rows:
            vd = self.view_dir(r["slug"])
            self.snapshot(r["slug"], vd / "final" / "files")
            review_pictures(self.ws / "views-work" / r["slug"] / "review", vd / "review" / "pictures")
        if hasattr(self, "ws"):
            self.collect_agents()
            self.collect_transcripts()
            for r in rows:
                vd = self.view_dir(r["slug"])
                place_attempts(vd, self.inst / "capture" / r["slug"], self.out / "transcripts", r["slug"], self.note,
                               fallback=vd / "review" / "before" / "files")
                builder_checks(vd, self.inst / "capture" / r["slug"] / "checks")
            self.collect_workspace()
        screen = self.inst / "screen.txt"
        if screen.is_file():
            shutil.copy2(screen, self.out / "screen.txt")
        self.timings()

    def collect_workspace(self) -> None:
        """What main's round-5 tools left in the workspace: profile_data's folder (its input, profile and history) and
        pick_views' record."""
        prof = self.ws / "views-work" / "profile"
        if prof.is_dir():
            shutil.copytree(prof, self.out / "profile", ignore=shutil.ignore_patterns(".engine", "work"), dirs_exist_ok=True)
        picks = self.ws / "views" / "picks.json"
        if picks.is_file():
            shutil.copy2(picks, self.out / "picks.json")

    def collect_agents(self) -> None:
        metas = [m for m in (read(p) for p in sorted((self.ws / "chats").glob("*.meta.json"))) if isinstance(m, dict)]
        agents, lines = [], []
        for m in metas:
            if m.get("id") == "main":
                continue
            agents.append({k: m.get(k) for k in ("id", "title", "agent_type", "agent_id", "status", "created_at",
                                                  "ts_end", "values", "view", "started_by")})
            lines.append(f"## {m.get('title')} ({m.get('agent_type')}, {m.get('status')})\n\n{m.get('result') or ''}\n")
        self.rec["agents"] = agents
        (self.out / "agents.md").write_text("\n".join(lines) or "(no agents)\n", "utf-8")

    def collect_transcripts(self) -> None:
        import wif as bb  # noqa: PLC0415

        dirs = bb.project_dirs(CC, self.data)
        tdir = self.out / "transcripts"
        tdir.mkdir(exist_ok=True)
        mains = sorted((p for d in dirs for p in d.glob("*.jsonl")), key=lambda p: p.stat().st_mtime)
        subs = sorted(p for d in dirs for p in d.glob("*/subagents/*.jsonl"))
        for p in mains:
            shutil.copy2(p, tdir / f"main-{p.name}")
        for p in subs:
            shutil.copy2(p, tdir / p.name)
            meta = p.with_suffix(".meta.json")
            if meta.is_file():
                shutil.copy2(meta, tdir / meta.name)
        calls, cost, usage = [], None, {}
        results: dict[str, Any] = {}
        for p in mains:
            for line in p.read_text("utf-8", errors="replace").splitlines():
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if r.get("type") == "cost-state":
                    cost = {k: r.get(k) for k in ("totalCostUSD", "totalAPIDuration", "totalDuration", "modelUsage",
                                                   "hasUnknownModelCost")}
                msg = r.get("message") if isinstance(r.get("message"), dict) else {}
                content = msg.get("content") if isinstance(msg.get("content"), list) else []
                for b in content:
                    if not isinstance(b, dict):
                        continue
                    if b.get("type") == "tool_use" and str(b.get("name", "")).split("__")[-1] in MAIN_CALLS:
                        calls.append({"id": b.get("id"), "at": r.get("timestamp"),
                                      "name": str(b.get("name")).split("__")[-1], "input": b.get("input")})
                    if b.get("type") == "tool_result":
                        c = b.get("content")
                        text = c if isinstance(c, str) else " ".join(
                            x.get("text", "") for x in c or [] if isinstance(x, dict))
                        results[str(b.get("tool_use_id"))] = {"at": r.get("timestamp"), "error": bool(b.get("is_error")),
                                                              "text": text[:40000]}
        for cl in calls:
            cl["result"] = results.get(str(cl["id"]))
        self.rec["sandbox_failures"] = sum(p.read_text("utf-8", errors="replace").count(SANDBOX_FAIL)
                                           for p in [*mains, *subs])
        if self.rec["sandbox_failures"]:
            self.note("sandbox-failures", count=self.rec["sandbox_failures"])
        for p in mains:
            usage[f"main {p.stem}"] = transcript_usage(p)
        for p in subs:
            kind = (read(p.with_suffix(".meta.json")) or {}).get("agentType") or "agent"
            usage[f"{kind} {p.stem}"] = transcript_usage(p)
        self.rec["cost"] = cost
        self.rec["cost_usd"] = (cost or {}).get("totalCostUSD")
        self.rec["usage"] = usage
        write_json(self.out / "main-calls.json", {"calls": calls, "proposals": self.rec.get("proposals")})
        props = [cl for cl in calls if cl["name"] == "propose_view"]
        ok = [cl for cl in props if cl.get("result") and not cl["result"]["error"]] or props
        if ok:
            self.rec["times"]["propose_call"] = ok[0].get("at")
        self.rec["main_calls"] = Counter(cl["name"] for cl in calls)
        # each proposal's accepted propose_view input, matched by its name (else in order)
        self.rec["proposal_inputs"] = {}
        rows = self.rec.get("proposals") or []
        left = list(ok)
        for r in rows:
            hit = next((cl for cl in left if str((cl.get("input") or {}).get("name") or "").strip() == r.get("name")),
                       left[0] if left else None)
            if hit is None:
                continue
            left.remove(hit)
            inp = hit.get("input") or {}
            self.rec["proposal_inputs"][r["slug"]] = inp
            vd = self.view_dir(r["slug"])
            vd.mkdir(parents=True, exist_ok=True)
            (vd / "proposal.md").write_text(proposal_md(inp), "utf-8")
            write_json(vd / "propose_view.json", {"accepted": inp, "call": hit})

    def timings(self) -> None:
        t = self.rec["times"]

        def secs(a: str | None, b: str | None) -> float | None:
            try:
                return round((datetime.fromisoformat(str(b).replace("Z", "+00:00"))
                              - datetime.fromisoformat(str(a).replace("Z", "+00:00"))).total_seconds(), 1)
            except (TypeError, ValueError):
                return None

        agents = self.rec.get("agents") or []
        builder = next((x for x in agents if x.get("agent_type") == "thimble:view-builder"), {})
        reviewer = next((x for x in agents if x.get("agent_type") == "thimble:view-reviewer"), {})
        self.rec["durations_s"] = {
            "to_hello": secs(t.get("start"), t.get("hello")),
            "request_to_proposal": secs(t.get("request"), t.get("propose_call") or t.get("proposed")),
            "build": secs(builder.get("created_at"), builder.get("ts_end")),
            "review": secs(reviewer.get("created_at"), reviewer.get("ts_end")),
            "request_to_settled": secs(t.get("request"), t.get("settled")),
            "total": secs(t.get("start"), now()),
        }


def transcript_usage(p: Path) -> dict[str, Any]:
    """One transcript's API requests and tokens, each message counted once (its usage as last written). Claude Code
    writes a message's usage as the stream starts, so output tokens are a lower bound; cost-state has the true total."""
    per: dict[str, dict[str, Any]] = {}
    first = last = None
    tools: dict[str, int] = {}
    model = None
    for line in p.read_text("utf-8", errors="replace").splitlines():
        try:
            r = json.loads(line)
        except ValueError:
            continue
        ts = r.get("timestamp")
        if ts:
            first = first or ts
            last = ts
        if r.get("type") != "assistant":
            continue
        m = r.get("message") or {}
        model = m.get("model") or model
        mid = m.get("id") or r.get("requestId") or r.get("uuid")
        u = m.get("usage") or {}
        cur = per.setdefault(mid, {})
        for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"):
            cur[k] = max(int(cur.get(k) or 0), int(u.get(k) or 0))
        for b in m.get("content") or []:
            if isinstance(b, dict) and b.get("type") == "tool_use":
                n = str(b.get("name") or "").split("__")[-1]
                tools[n] = tools.get(n, 0) + 1
    tot = {k: sum(v.get(k, 0) for v in per.values()) for k in
           ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")}
    return {"model": model, "requests": len(per), **tot, "tool_calls": tools, "first": first, "last": last}


SPEC_ORDER = ("name", "candidates", "abstraction", "why", "claims", "unit", "overview", "hooks", "zoom", "filter",
              "details")
UNSEEN = ("claims", "model", "effort", "candidates")  # fields whose words the builder never reads


def proposal_words(inp: dict[str, Any]) -> dict[str, int]:
    out = {}
    for k, v in inp.items():
        text = " ".join(v) if isinstance(v, list) else str(v)
        out[k] = len(text.split())
    out["total"] = sum(n for k, n in out.items() if k not in ("claims", "model", "effort"))
    out["builder"] = sum(n for k, n in out.items() if k not in (*UNSEEN, "total"))  # what the dev agent reads
    return out


def proposal_md(inp: dict[str, Any]) -> str:
    words = proposal_words(inp)
    keys = [*SPEC_ORDER, *(k for k in inp if k not in SPEC_ORDER)]
    lines = [f"# {inp.get('name', '(no name)')}", "", f"{words['total']} words (claims, model and effort excluded), "
             f"{words['builder']} that the builder reads (candidates excluded too)", ""]
    for k in keys:
        if k not in inp or k == "name":
            continue
        v = inp[k]
        text = ", ".join(f"`{x}`" for x in v) if isinstance(v, list) else str(v)
        lines += [f"## {k} ({words.get(k, 0)} words)", "", text, ""]
    return "\n".join(lines)


def shoot(run_dir: Path, inst: Path, ws: str, slug_: str, env: dict[str, str], tree: Path, clicks: list[str],
          note, capture: bool = True) -> dict[str, Any] | None:
    """shoot_view.py in the instance's environment (the server stopped): round 4's final/ pictures (first load, each
    hook, a record) and each attempt's and review round's first load, or with `capture` False rounds 1-3's shots/."""
    if capture:
        dest = run_dir / "final"
        snaps = [d for d in sorted((run_dir / "attempts").glob("*/files"), key=lambda d: numeric(d.parent.name))]
        snaps += [d for d in sorted((run_dir / "review" / "rounds").glob("*/files"), key=lambda d: numeric(d.parent.name))]
        extra = ["--capture", *(x for d in snaps for x in ("--snapshot", f"{d}={d.parent / 'first-load.jpg'}"))]
    else:
        dest = run_dir / "shots"
        extra = [x for c in clicks for x in ("--click", c)]
    cmd = [str(venv_python(tree)), str(HERE / "shoot_view.py"), ws, slug_, str(dest), *extra]
    r = subprocess.run(cmd, capture_output=True, text=True, env=env, cwd=str(tree), timeout=2400)
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "shoot.log").write_text(r.stdout + r.stderr, "utf-8")
    note("shot", code=r.returncode, out=r.stdout[-600:])
    got = read(dest / "shots.json")
    if not got:
        return None
    return {s["state"]: {k: (s.get("first_load") or {}).get(k) for k in
                         ("controls", "text_nodes", "words", "prose_blocks", "hues", "svg_marks", "anchored_in_view",
                          "page_height")} | {"ok": s.get("ok"), "png": s.get("png"), "clicked": s.get("clicked"),
                                             "found": s.get("found"),
                                             "unchanged_after_click": s.get("unchanged_after_click")}
            for s in got.get("states") or []}


# ----------------------------------------------------------------------------------------------------------------------
# round 4's capture: the attempts, the builder's and the reviewer's work, facts.json
# ----------------------------------------------------------------------------------------------------------------------


def numeric(name: str) -> int:
    try:
        return int(name)
    except ValueError:
        return 10 ** 6


def when(x: Any) -> datetime | None:
    try:
        return datetime.fromisoformat(str(x).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def transcript_events(p: Path) -> list[dict[str, Any]]:
    """A subagent's transcript as its steps in order: each tool call {at, name (the tool's own name), input, result,
    result_at, error} and each text it wrote {at, name: '(text)', text}. Its report to main is the SubagentHandback
    call's input.message."""
    uses: dict[str, dict[str, Any]] = {}
    out: list[dict[str, Any]] = []
    for line in p.read_text("utf-8", errors="replace").splitlines():
        try:
            r = json.loads(line)
        except ValueError:
            continue
        m = r.get("message") if isinstance(r.get("message"), dict) else {}
        for b in m.get("content") if isinstance(m.get("content"), list) else []:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "tool_use":
                ev = {"at": r.get("timestamp"), "name": str(b.get("name") or "").split("__")[-1], "input": b.get("input"),
                      "id": b.get("id")}
                uses[str(b.get("id"))] = ev
                out.append(ev)
            elif b.get("type") == "tool_result" and str(b.get("tool_use_id")) in uses:
                ev = uses[str(b["tool_use_id"])]
                c = b.get("content")
                ev["result"] = c if isinstance(c, str) else "\n".join(
                    str(x.get("text") or "") for x in c or [] if isinstance(x, dict) and x.get("type") == "text")
                ev["result_at"], ev["error"] = r.get("timestamp"), bool(b.get("is_error"))
            elif b.get("type") == "text" and r.get("type") == "assistant" and str(b.get("text") or "").strip():
                out.append({"at": r.get("timestamp"), "name": "(text)", "text": b.get("text")})
    return out


SLUG_IN_TASK = re.compile(r"whose slug is `([^`]+)`")  # dev-view-task.md's and dev-view-review.md's first line


def transcript_slug(jl: Path) -> str | None:
    """The view a builder's or reviewer's transcript works on: the slug its task names in its first lines."""
    try:
        with open(jl, encoding="utf-8", errors="replace") as f:
            for _, line in zip(range(8), f):
                m = SLUG_IN_TASK.search(line)
                if m:
                    return m.group(1)
    except OSError:
        return None
    return None


def agent_steps(tdir: Path, view: str | None = None) -> dict[str, list[dict[str, Any]]]:
    """Each subagent type's steps (transcript_events), its transcripts merged in time order: a resumed build starts a
    new transcript file. With `view`, only the transcripts of that view's builders and reviewers (transcript_slug)."""
    out: dict[str, list[dict[str, Any]]] = {}
    for meta in sorted(tdir.glob("agent-*.meta.json")):
        kind = (read(meta) or {}).get("agentType") or "agent"
        jl = meta.with_name(meta.name[:-len(".meta.json")] + ".jsonl")
        if jl.is_file() and (view is None or transcript_slug(jl) == view):
            out.setdefault(kind, []).extend(transcript_events(jl))
    for steps in out.values():
        steps.sort(key=lambda e: str(e.get("at") or ""))
    return out


def handback(steps: list[dict[str, Any]]) -> str:
    """The agent's last report to main (its SubagentHandback message), else its last text."""
    for e in reversed(steps):
        if e.get("name") == "SubagentHandback" and isinstance(e.get("input"), dict):
            return str(e["input"].get("message") or "")
    return next((str(e.get("text")) for e in reversed(steps) if e.get("name") == "(text)"), "")


def review_pictures(src: Path, dest: Path) -> None:
    """The reviewer's own pictures (views-work/<slug>/review/<round>/picture-*.png) as <round>-<name>.jpg."""
    if not src.is_dir():
        return
    for p in sorted(src.glob("*/*.png")):
        to_jpeg(p, dest / f"{p.parent.name}-{p.stem}.jpg")


def builder_checks(out: Path, src: Path) -> None:
    """The builder's view_check pictures (check-<time>-overview.png) as builder/checks/<n>-<name>.jpg, in order."""
    if not src.is_dir():
        return
    for i, p in enumerate(sorted(src.glob("check-*.png")), 1):
        to_jpeg(p, out / "builder" / "checks" / f"{i:02d}-{p.stem}.jpg")


def place_attempts(out: Path, cap: Path | None, tdir: Path, view: str, note,
                   fallback: Path | None = None) -> list[dict[str, Any]]:
    """attempts/<n>/ (under the view's folder `out`) for the n-th finish_view call of the view's builders: gate.txt its
    verdict, files/ the watcher's snapshot taken for it (`cap` the view's capture folder; the latest at or after the
    call; `exact` when its files are no newer than the call, so the gate read them). An attempt that passed with no
    snapshot gets `fallback`, the view as its gate passed. attempts/attempts.json lists them; review/rounds/<r>/ the
    review's rounds. The rows."""
    steps = agent_steps(tdir, view).get("thimble:view-builder", [])
    calls = [e for e in steps if e.get("name") == "finish_view" and e.get("result") is not None]
    watch = read(cap / "watch.json") if cap else None
    snaps = [s for s in (watch or {}).get("snapshots") or [] if s.get("kind") == "attempt"]
    rows: list[dict[str, Any]] = []
    used: set[int] = set()
    for i, call in enumerate(calls, 1):
        d = out / "attempts" / str(i)
        d.mkdir(parents=True, exist_ok=True)
        (d / "gate.txt").write_text(str(call.get("result") or ""), "utf-8")
        nxt = when(calls[i]["at"]) if i < len(calls) else None
        at = when(call["at"])
        pick = None
        for s in snaps:  # the first snapshot after this call and before the next one
            t = when(s.get("at"))
            if s["seq"] not in used and at and t and t >= at and (nxt is None or t < nxt):
                pick = s
                break
        row = {"n": i, "finish_view_at": call.get("at"), "verdict_at": call.get("result_at"),
               "passed": not call.get("error"), "verdict": " ".join(str(call.get("result") or "").split())[:300]}
        if pick is not None:
            used.add(pick["seq"])
            src = Path(pick["dir"]) / "files"
            if src.is_dir():
                shutil.copytree(src, d / "files", dirs_exist_ok=True)
            mt = when(pick.get("files_mtime"))
            row.update(snapshot_at=pick.get("at"), files_mtime=pick.get("files_mtime"), source="watcher",
                       exact=bool(mt and at and mt <= at + timedelta(seconds=1)))
        elif fallback is not None and fallback.is_dir() and row["passed"]:
            shutil.copytree(fallback, d / "files", dirs_exist_ok=True)
            row.update(source="the view as its gate passed (no snapshot in this run)", exact=False)
        row["files"] = (d / "files").is_dir()
        rows.append(row)
    for s in snaps:  # a snapshot no finish_view call explains (the builder's transcript is missing)
        if s["seq"] not in used:
            d = out / "attempts" / f"x{s['seq']}"
            if (Path(s["dir"]) / "files").is_dir():
                shutil.copytree(Path(s["dir"]) / "files", d / "files", dirs_exist_ok=True)
            rows.append({"n": f"x{s['seq']}", "snapshot_at": s.get("at"), "files_mtime": s.get("files_mtime"),
                         "source": "watcher, no finish_view call found", "files": (d / "files").is_dir()})
    for s in (watch or {}).get("snapshots") or []:
        if s.get("kind") == "review" and (Path(s["dir"]) / "files").is_dir():
            d = out / "review" / "rounds" / str(s["round"])
            shutil.copytree(Path(s["dir"]) / "files", d / "files", dirs_exist_ok=True)
            write_json(d / "round.json", {k: v for k, v in s.items() if k != "dir"})
    if rows:
        write_json(out / "attempts" / "attempts.json", rows)
    note("attempts", view=view, n=len(rows), snapshots=len(snaps))
    return rows


def rel(p: Any, root: Path) -> str | None:
    try:
        return str(Path(p).resolve().relative_to(root.resolve())) if p else None
    except ValueError:
        return str(p)


def form_of(text: str) -> str:
    """'<records> as <a form>': the abstraction's (or the baseline's `why`'s) words before its first colon or full
    stop."""
    t = " ".join(str(text or "").split())
    cut = [i for i in (t.find(": "), t.find(". "), t.find("; ")) if 0 < i <= 200]
    return t[:min(cut)] if cut else t[:200]


def describe_view(out: Path, tdir: Path, row: dict[str, Any], accepted: dict[str, Any], rec: dict[str, Any],
                  note) -> dict[str, Any]:
    """One view's folder `out` (views/<slug>): each attempt's first-load counts (b), builder/ and review/ (c) and its
    facts.json (f), from what collect, place_attempts and shoot left; `row` its proposal, `accepted` its propose_view
    input, `tdir` the run's transcripts."""
    steps = agent_steps(tdir, row["slug"])
    builder = steps.get("thimble:view-builder", [])
    reviewer = steps.get("thimble:view-reviewer", [])
    # (b): the first loads shoot_view took
    shots = read(out / "final" / "shots.json") or {}
    loads = {str(Path(s.get("picture") or "").parent): s for s in shots.get("snapshots") or []}
    rows = read(out / "attempts" / "attempts.json") or []
    for r in rows:
        s = loads.get(str(out / "attempts" / str(r["n"])))
        if s:
            fl = s.get("first_load") or {}
            r["first_load"] = {"ok": s.get("ok"), "errors": (s.get("errors") or [])[:3],
                               **{k: fl.get(k) for k in ("controls", "hues", "words", "svg_marks")}}
    if rows:
        write_json(out / "attempts" / "attempts.json", rows)
    # (c) the builder
    if builder:
        (out / "builder").mkdir(parents=True, exist_ok=True)
        (out / "builder" / "last-message.md").write_text(handback(builder) + "\n", "utf-8")
        pics = {re.sub(r"^\d+-", "", p.stem): p.name for p in (out / "builder" / "checks").glob("*.jpg")}
        checks = []
        for e in builder:
            if e.get("name") != "view_check":
                continue
            text = str(e.get("result") or "")
            png = re.search(r"png: \S*/(check-[\w-]+)\.png", text)
            checks.append({"at": e.get("at"), "input": e.get("input"), "passed": "The checks pass" in text,
                           "picture": f"builder/checks/{pics[png.group(1)]}" if png and png.group(1) in pics else None,
                           "verdict": text})
        write_json(out / "builder" / "checks.json", checks)
    # (c) the reviewer
    finishes = [e for e in reviewer if e.get("name") == "finish_review"]
    if reviewer:
        lines = [f"# Review of {row.get('name') or row['slug']}", "", "## The reviewer's report",
                 "", handback(reviewer) or "(none)", ""]
        for i, e in enumerate(finishes, 1):
            inp = e.get("input") if isinstance(e.get("input"), dict) else {}
            lines += [f"## finish_review {i} ({e.get('at')})", "", "Revised:", ""]
            lines += [f"- {x}" for x in (inp.get("revised") or [])] or ["- (nothing)"]
            lines += ["", "Left:", ""] + ([f"- {x}" for x in (inp.get("left") or [])] or ["- (nothing)"])
            lines += ["", "Result: " + " ".join(str(e.get("result") or "").split()), ""]
        pictured = [e for e in reviewer if e.get("name") == "view_pictures"]
        if pictured:
            lines += ["## The states it pictured", ""]
            for e in pictured:
                want = (e.get("input") or {}).get("states") if isinstance(e.get("input"), dict) else None
                got = [ln.strip() for ln in str(e.get("result") or "").splitlines() if re.match(r"\s*\d+: /", ln)]
                asked = json.dumps(want, ensure_ascii=False) if want else "the overview"
                lines.append(f"- {e.get('at')}: {asked}")
                lines += ["  - " + re.sub(r"^(\d+): \S+/", r"\1: ", g) for g in got]
            lines.append("")
        notes = [e for e in reviewer if e.get("name") == "(text)"]
        if notes:
            lines += ["## Its notes while it worked", ""] + [f"{e.get('at')}: {e.get('text')}\n" for e in notes]
        (out / "review").mkdir(parents=True, exist_ok=True)
        (out / "review" / "critique.md").write_text("\n".join(lines), "utf-8")
    before, final = out / "review" / "before" / "files", out / "final" / "files"
    if before.is_dir() and final.is_dir():
        d = subprocess.run(["diff", "-ruN", "-x", "cache", "-x", "__pycache__", str(before), str(final)],
                           capture_output=True, text=True)
        (out / "review" / "changes.diff").write_text(d.stdout or "(no change)\n", "utf-8")
    # (f)
    states = {s["state"]: s for s in shots.get("states") or []}
    fl = (states.get("overview") or {}).get("first_load") or {}
    rv = row.get("review") if isinstance(row.get("review"), dict) else {}
    facts = {
        "slug": row["slug"], "view": row.get("name"), "status": row.get("status"),
        "form": form_of(accepted.get("abstraction") or accepted.get("why") or ""), "why": accepted.get("why"),
        "proposal": {k: v for k, v in accepted.items() if k not in ("claims", "model", "effort")},
        "claims": accepted.get("claims"),
        "first_load": {k: fl.get(k) for k in ("controls", "control_texts", "hues", "words", "text_nodes", "svg_marks",
                                              "chips", "kit")},
        "hooks": {n: {"found": s.get("found"), "picture": rel(s.get("png"), out),
                      "menu_open": (s.get("first_load") or {}).get("menu_open"),
                      "side_open": (s.get("first_load") or {}).get("side_open"), "clicked": s.get("clicked")}
                  for n, s in states.items() if n != "overview"},
        "attempts": len([r for r in rows if isinstance(r.get("n"), int)]),
        "attempt_verdicts": [{"n": r["n"], "passed": r.get("passed"), "exact": r.get("exact"),
                              "controls": (r.get("first_load") or {}).get("controls"),
                              "hues": (r.get("first_load") or {}).get("hues")} for r in rows],
        "builder_checks": len(list((out / "builder" / "checks").glob("*.jpg"))),
        "review": {"state": rv.get("state"), "rounds": rv.get("round"), "revised": rv.get("revised"),
                   "left": rv.get("left"), "finish_calls": len(finishes)},
        "build_minutes": minutes_between(builder),
        "review_minutes": minutes_between(reviewer),
        "proposal_words": proposal_words(accepted) if accepted else None,
    }
    write_json(out / "facts.json", facts)
    note("facts", view=facts["view"], form=facts["form"], controls=facts["first_load"]["controls"],
         hues=facts["first_load"]["hues"], attempts=facts["attempts"])
    return facts


def minutes_between(steps: list[dict[str, Any]]) -> float | None:
    """Minutes from an agent's first step to its last, its transcripts merged."""
    ts = [when(e.get("at")) for e in steps if e.get("at")]
    ts = [t for t in ts if t]
    return round((max(ts) - min(ts)).total_seconds() / 60, 1) if ts else None


def describe_run(out: Path, rec: dict[str, Any], views: list[dict[str, Any]], note) -> dict[str, Any]:
    """The run's facts.json: the pipeline, the corpus, how it ended, its time and cost, each view's facts, the profile
    main made (its kind, the types or words, and how many calls) and the picker's calls."""
    d = rec.get("durations_s") or {}
    prof = out / "profile"
    profile = None
    if (prof / "profile.txt").is_file():
        kind = "types" if (prof / "types.ts").is_file() else "description"
        profile = {"kind": kind, "input": f"profile/{'types.ts' if kind == 'types' else 'description.md'}",
                   "profile": "profile/profile.txt", "calls": len(list((prof / "history").glob("*-profile.txt")))}
    picks = read(out / "picks.json") or []
    facts = {
        "key": rec.get("corpus"), "pipeline": rec.get("pipeline") or rec.get("variant"), "status": rec.get("status"),
        "request": rec.get("request"), "views": views, "profile": profile,
        "picks": [{"n": p.get("n"), "status": p.get("status"), "concepts": [c.get("name") for c in p.get("concepts") or []],
                   "kept": [{"n": k.get("n"), "name": k.get("name"), "why": k.get("why")} for k in p.get("kept") or []]}
                  for p in picks],
        "main_calls": rec.get("main_calls"),
        "minutes": {k: round(v / 60, 1) if isinstance(v, (int, float)) else None for k, v in d.items()},
        "cost_usd": round(rec["cost_usd"], 2) if isinstance(rec.get("cost_usd"), (int, float)) else None,
    }
    write_json(out / "facts.json", facts)
    note("facts-run", views=len(views), profile=bool(profile), picks=len(picks))
    return facts


def run_one(a: argparse.Namespace) -> int:
    run = Run(a)
    if not run.claim_out():
        print(f"run_r5: {run.out} exists (use --tag, or --force to move it aside)", file=sys.stderr)
        return 2
    run.inst.mkdir(parents=True, exist_ok=True)

    def on_signal(signum, _frame):
        # the first signal ends the trial; the cleanup that follows is not interrupted again
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        raise KeyboardInterrupt(f"signal {signum}")

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    code = 0
    try:
        run.prepare()
        run.check_prompts()
        run.server_up()
        if a.setup_only:
            run.rec["status"] = "setup-only"
        else:
            run.watch = Watcher(run)
            run.watch.start()
            run.start_main()
            if a.hello_only:
                run.rec["status"] = "hello-only"
            else:
                run.request()
                run.wait()
    except BaseException as e:  # noqa: BLE001 — every failure still stops the instance and saves what there is
        run.rec["status"] = "error" if not isinstance(e, KeyboardInterrupt) else "interrupted"
        run.rec["error"] = repr(e)[:1000]
        run.note("error", error=repr(e)[:1000])
        code = 1
    finally:
        try:
            run.stop()
        finally:
            try:
                run.collect()
            except Exception as e:  # noqa: BLE001
                run.note("collect-error", error=repr(e))
            run.rec["shots"] = {}
            for slug_ in run.rec.get("views") or []:  # each view's pictures, and its attempts' and rounds' first loads
                try:
                    run.rec["shots"][slug_] = shoot(run.view_dir(slug_), run.inst, run.rec["workspace"], slug_,
                                                    run.server_env, run.tree, a.click or [], run.note)
                except Exception as e:  # noqa: BLE001
                    run.note("shoot-error", view=slug_, error=repr(e))
            if run.rec.get("views"):
                kill_pids(pids_of_home(run.inst / "home"), run.note)
            if run.slot is not None:
                run.slot.release()
            run.rec["times"]["end"] = now()
            run.timings()
            view_facts = []
            for r in run.rec.get("proposals") or []:
                try:
                    view_facts.append(describe_view(run.view_dir(r["slug"]), run.out / "transcripts", r,
                                                    (run.rec.get("proposal_inputs") or {}).get(r["slug"]) or {},
                                                    run.rec, run.note))
                except Exception as e:  # noqa: BLE001
                    run.note("describe-error", view=r.get("slug"), error=repr(e))
            try:
                run.rec["facts"] = describe_run(run.out, run.rec, view_facts, run.note)
            except Exception as e:  # noqa: BLE001
                run.note("describe-error", error=repr(e))
            run.save()
            if (run.inst / "log.jsonl").is_file():
                shutil.copy2(run.inst / "log.jsonl", run.out / "log.jsonl")
    print(json.dumps({"out": str(run.out), "status": run.rec.get("status"), "views": run.rec.get("views"),
                      "cost_usd": run.rec.get("cost_usd"), "minutes": round((time.monotonic() - run.t0) / 60, 1)}))
    return code if run.rec.get("status") == "built" else (code or 1)


# ----------------------------------------------------------------------------------------------------------------------
# commands
# ----------------------------------------------------------------------------------------------------------------------


def run_args(a: argparse.Namespace, corpus: str) -> list[str]:
    out = [*(["--pipeline", a.pipeline] if a.pipeline else ["--variant", a.variant, "--tree", a.tree]),
           "--corpus", corpus, "--out", a.out, "--model", a.model,
           "--minutes", str(a.minutes), "--propose-minutes", str(a.propose_minutes)]
    for k in ("prompts_ref", "overlay", "request", "proposal", "tag", "dev_model", "dev_effort"):
        v = getattr(a, k)
        if v:
            out += [f"--{k.replace('_', '-')}", str(v)]
    for c in a.click or []:
        out += ["--click", c]
    if a.no_review:
        out.append("--no-review")
    if a.setup_only:
        out.append("--setup-only")
    if a.hello_only:
        out.append("--hello-only")
    if a.force:
        out.append("--force")
    for k in ("home", "cc", "port_base", "slots"):
        if getattr(a, k, None):
            out += [f"--{k.replace('_', '-')}", str(getattr(a, k))]
    return out


def cmd_run(a: argparse.Namespace) -> int:
    py = venv_python(Path(a.tree).resolve())
    if Path(sys.executable).resolve() != py.resolve() and not os.environ.get("VABS_REEXEC"):
        os.environ["VABS_REEXEC"] = "1"
        os.execv(str(py), [str(py), str(Path(__file__).resolve()), *sys.argv[1:]])
    return run_one(a)


def cmd_batch(a: argparse.Namespace) -> int:
    py = venv_python(Path(a.tree).resolve())
    corpora = a.corpus
    width = a.parallel or len(corpora)
    logs = Path(a.out).resolve() / slug(a.variant)
    logs.mkdir(parents=True, exist_ok=True)
    pending, live, codes = list(corpora), [], {}

    def forward(signum, _frame):
        # each run stops its own instance on SIGTERM (sent once); nothing new starts
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        pending.clear()
        for _c, p, _log in live:
            if p.poll() is None:
                p.send_signal(signal.SIGTERM)
        print(f"{now()} signal {signum}: stopping {len(live)} run(s)", flush=True)

    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)
    while pending or live:
        while pending and len(live) < width:
            c = pending.pop(0)
            leaf = Path(c).name + (f"-{slug(a.tag)}" if a.tag else "")
            log = open(logs / f"{leaf}.runner.log", "a")
            p = subprocess.Popen([str(py), str(Path(__file__).resolve()), "run", *run_args(a, c)], stdout=log,
                                 stderr=subprocess.STDOUT, env={**os.environ, "VABS_REEXEC": "1"})
            live.append((c, p, log))
            print(f"{now()} started {c} (pid {p.pid}, log {log.name})", flush=True)
            time.sleep(20)  # instances start one after another (slots, trust, hello)
        for item in list(live):
            c, p, log = item
            if p.poll() is not None:
                codes[c] = p.returncode
                log.close()
                live.remove(item)
                print(f"{now()} ended {c} with {p.returncode}", flush=True)
        time.sleep(5)
    print(json.dumps(codes))
    return 0 if all(v == 0 for v in codes.values()) else 1


def cmd_matrix(a: argparse.Namespace) -> int:
    """Every pipeline on every corpus, --reps times, at most --parallel at once: each run a child `run` with a slot of
    its own (ports, tmux server, TMPDIR) and a Claude Code config folder of its own (<home>/cc<slot>), its output in
    <out>/<pipeline>/<corpus>-<rep>, its log beside it (<corpus>-<rep>.runner.log). Runs start 20 s apart; one that
    ends frees its slot for the next. A run whose output folder exists already is skipped, so a matrix can be resumed.
    SIGTERM stops every run (each stops its own instance)."""
    table = read(PIPELINES) or {}
    pipes = [x for x in a.pipelines.split(",") if x]
    for x in pipes:
        if x not in table:
            raise SystemExit(f"run_r5: no pipeline {x!r} in {PIPELINES}")
    corpora = [x for x in a.corpora.split(",") if x]
    combos = [(r, c, p) for r in range(1, a.reps + 1) for c in corpora for p in pipes]  # spread pipelines over time
    out_root = Path(a.out).resolve()
    pending = [(r, c, p) for r, c, p in combos if not (out_root / p / f"{c}-{r}").exists()]
    free = list(range(a.parallel))
    live: list[tuple[tuple[int, str, str], int, subprocess.Popen, Any]] = []
    codes: dict[str, int] = {}
    print(f"{now()} matrix: {len(pending)} of {len(combos)} runs to go, {a.parallel} at once", flush=True)

    def forward(signum, _frame):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        pending.clear()
        for _k, _slot, proc, _log in live:
            if proc.poll() is None:
                proc.send_signal(signal.SIGTERM)
        print(f"{now()} signal {signum}: stopping {len(live)} run(s)", flush=True)

    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)
    while pending or live:
        while pending and free:
            rep, c, pipe = pending.pop(0)
            n = free.pop(0)
            tree = Path(table[pipe]["tree"]).resolve()
            leaf = out_root / pipe / f"{c}-{rep}"
            leaf.parent.mkdir(parents=True, exist_ok=True)
            log = open(leaf.parent / f"{c}-{rep}.runner.log", "a")
            cmd = [str(venv_python(tree)), str(Path(__file__).resolve()), "run", "--pipeline", pipe, "--corpus", c,
                   "--tag", str(rep), "--leaf", str(leaf), "--home", str(HOME_ROOT), "--cc", str(HOME_ROOT / f"cc{n}"),
                   "--port-base", str(PORT_BASE), "--slots", str(a.parallel), "--slot", str(n),
                   "--minutes", str(a.minutes), "--propose-minutes", str(a.propose_minutes)]
            if a.no_review:
                cmd.append("--no-review")
            if a.setup_only:
                cmd.append("--setup-only")
            proc = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, env={**os.environ, "VABS_REEXEC": "1"})
            live.append(((rep, c, pipe), n, proc, log))
            print(f"{now()} started {pipe} {c} rep {rep} on slot {n} (pid {proc.pid})", flush=True)
            time.sleep(20)  # instances start one after another (slots, trust, hello)
        for item in list(live):
            (rep, c, pipe), n, proc, log = item
            if proc.poll() is not None:
                codes[f"{pipe}/{c}-{rep}"] = proc.returncode
                log.close()
                live.remove(item)
                free.append(n)
                print(f"{now()} ended {pipe} {c} rep {rep} with {proc.returncode}", flush=True)
        time.sleep(5)
    print(json.dumps(codes))
    return 0 if all(v == 0 for v in codes.values()) else 1


def cmd_summary(a: argparse.Namespace) -> int:
    """One line per view of each run under the folders: pipeline, corpus, how the run ended, the view, its form's first
    words, attempts, first-load controls and hues, minutes and cost."""
    rows = []
    for root in a.folders:
        for fj in sorted(Path(root).rglob("facts.json")):
            if fj.parent.parent.name == "views":
                continue  # a view's own facts; the run's list them
            f = read(fj) or {}
            d = f.get("minutes") or {}
            for v in f.get("views") or [{}]:
                fl = v.get("first_load") or {}
                rows.append([f.get("pipeline"), f.get("key"), f.get("status"), v.get("view"),
                             str(v.get("form") or "")[:40], v.get("attempts"), fl.get("controls"), fl.get("hues"),
                             (f.get("profile") or {}).get("kind"), len(f.get("picks") or []),
                             d.get("request_to_settled"), f.get("cost_usd")])
    head = ["pipeline", "corpus", "status", "view", "form", "att", "ctl", "hues", "profile", "picks", "min", "usd"]
    w = [max(len(str(x)) for x in col) for col in zip(head, *rows)] if rows else [len(h) for h in head]
    for row in [head, *rows]:
        print("  ".join(str(x if x is not None else "-").ljust(n) for x, n in zip(row, w)))
    return 0


def run_env_of(r: dict[str, Any], tree: Path) -> dict[str, str]:
    """An ended run's instance environment, for pictures taken again with its server stopped."""
    inst = Path(r["instance"])
    env = {k: v for k, v in os.environ.items() if not DROP_ENV.match(k)}
    home = inst / "home"
    env.update({"PATH": clean_path(tree), "THIMBLE_HOME": str(home), "THIMBLE_WORKSPACES_DIR": str(home / "workspaces"),
                "THIMBLE_DATA_DIR": str(home / "data"), "THIMBLE_DEV_DIR": str(home / "dev"),
                "THIMBLE_PORT": str(r["slot"]["ports"][0]), "THIMBLE_UI_PORT": str(r["slot"]["ports"][1]),
                "TMPDIR": str(slot_tmp(r["slot"]["n"])), "THIMBLE_PROMPTS_DIR": str(inst / "prompts"),
                "CLAUDE_CONFIG_DIR": str(CC), "VABS_TREE": str(tree)})
    Path(env["TMPDIR"]).mkdir(parents=True, exist_ok=True)
    return env


def run_tree(r: dict[str, Any], given: str | None = None) -> Path:
    return Path(given or r.get("tree") or (r.get("prompts") or {}).get("tree") or DEFAULT_TREE).resolve()


def adopt_home(r: dict[str, Any]) -> None:
    """The scratch home and config folder an ended run used, unless --home or --cc named others."""
    global HOME_ROOT, CC
    if r.get("home") and HOME_ROOT == Path("/mnt/store/scratch/rel/vr5/home"):
        HOME_ROOT = Path(r["home"])
    if r.get("claude_config_dir") and CC == Path("/mnt/store/scratch/rel/vr5/home/cc"):
        CC = Path(r["claude_config_dir"])


def cmd_shoot(a: argparse.Namespace) -> int:
    """Pictures again from an ended run's instance, for each of its views (views/<slug>/final/)."""
    run_dir = Path(a.run).resolve()
    r = read(run_dir / "run.json") or {}
    adopt_home(r)
    tree = run_tree(r)
    if r.get("slot") and any(p in listening_ports() for p in r["slot"]["ports"]):
        print("note: the instance's ports are in use; the pictures run without its server anyway", file=sys.stderr)
    r["shots"] = {}
    for slug_ in r.get("views") or []:
        r["shots"][slug_] = shoot(run_dir / "views" / slug(slug_), Path(r["instance"]), r["workspace"], slug_,
                                  run_env_of(r, tree), tree, a.click or [],
                                  lambda kind, **f: print(kind, json.dumps(f, default=str)[:600]))
    write_json(run_dir / "run.json", r)
    return 0


def cmd_status(_a: argparse.Namespace) -> int:
    busy = listening_ports()
    print(f"home {HOME_ROOT}, ports {PORT_BASE}-{PORT_BASE + 4 * SLOTS - 1}")
    for n in range(SLOTS):
        lock = HOME_ROOT / "slots" / f"{n}.lock"
        held = False
        if lock.exists():
            with open(lock, "a+") as f:
                try:
                    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    fcntl.flock(f, fcntl.LOCK_UN)
                except OSError:
                    held = True
        ports = {p: busy[p] for p in slot_ports(n) if p in busy}
        print(f"slot {n:2}  ports {slot_ports(n)[0]}-{slot_ports(n)[-1]}  held={held}  tmux {slot_socket(n)}="
              f"{tmux_alive(slot_socket(n))}  listening={ports or '-'}")
    return 0


def cmd_clean(a: argparse.Namespace) -> int:
    """Delete instance folders (never output folders). The corpus copy's files are hard links to the originals, so only
    its folders are made writable, never its files."""
    for x in a.instances:
        inst = Path(x).resolve()
        if inst.parent.parent != HOME_ROOT / "runs":
            print(f"skip {inst}: not an instance under {HOME_ROOT / 'runs'} (--home names the scratch home)")
            continue
        if pids_of_home(inst / "home"):
            print(f"skip {inst}: processes still name its home (run_views.py stop it first)")
            continue
        for d in [inst, *(p for p in inst.rglob("*") if p.is_dir() and not p.is_symlink())]:
            os.chmod(d, os.stat(d).st_mode | 0o700)
        shutil.rmtree(inst)
        print(f"deleted {inst}")
    return 0


def cmd_stop(a: argparse.Namespace) -> int:
    """Stop an instance by hand: its main (/exit, Exit and stop tasks), its tmux server, its server and every process
    that names its home."""
    inst = Path(a.instance).resolve()
    prep: dict[str, Any] = {}
    for line in (inst / "log.jsonl").read_text("utf-8").splitlines() if (inst / "log.jsonl").is_file() else []:
        rec = json.loads(line)
        if rec.get("kind") == "prepared":
            prep = rec
    tree = Path(prep.get("tree") or DEFAULT_TREE)
    sys.path.insert(0, str(tree / "scripts" / "dev"))
    import precache_orientation as pc  # noqa: PLC0415

    log = read(inst / "home" / "server.json") or {}
    socket = prep.get("socket") or (f"vabs{prep['slot']}" if prep.get("slot") is not None else None)
    if socket:
        term = pc.Terminal(socket)
        quit_main(term, lambda kind, **f: print(kind, f))
        term.stop()
    env = {k: v for k, v in os.environ.items() if not DROP_ENV.match(k)}
    env.update({"PATH": clean_path(tree), "THIMBLE_HOME": str(inst / "home"),
                "CLAUDE_CONFIG_DIR": str(prep.get("cc") or CC)})
    if log.get("port"):
        env.update({"THIMBLE_PORT": str(log["port"]), "THIMBLE_UI_PORT": str(log.get("ui_port") or "")})
    subprocess.run([str(tree / "plugin" / "bin" / "thimble"), "server", "stop", "--yes"], env=env,
                   capture_output=True, text=True, timeout=120)
    kill_pids(pids_of_home(inst / "home"), lambda kind, **f: print(kind, f))
    return cmd_status(a)


def lane_options(p: argparse.ArgumentParser) -> None:
    p.add_argument("--home", help="scratch home (instances, slots, TMPDIR, Claude Code's config folder)")
    p.add_argument("--cc", help="Claude Code's config folder (default <home>/cc with --home)")
    p.add_argument("--port-base", type=int, help=f"first port (default {PORT_BASE})")
    p.add_argument("--slots", type=int, help=f"slots of four ports (default {SLOTS})")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("run", "batch"):
        p = sub.add_parser(name)
        p.add_argument("--pipeline", help=f"a pipeline of {PIPELINES.name}: its tree, prompts diff and environment")
        p.add_argument("--variant", help="the output's name without --pipeline (round 4's)")
        p.add_argument("--corpus", required=True, action="append" if name == "batch" else "store")
        p.add_argument("--prompts-ref")
        p.add_argument("--overlay")
        p.add_argument("--tree", default=str(DEFAULT_TREE))
        p.add_argument("--request")
        p.add_argument("--proposal")
        p.add_argument("--no-review", action="store_true")
        p.add_argument("--model", default=MAIN_MODEL)
        p.add_argument("--dev-model")
        p.add_argument("--dev-effort")
        p.add_argument("--minutes", type=float, default=90)
        p.add_argument("--propose-minutes", type=float, default=40)
        p.add_argument("--slot", type=int)
        p.add_argument("--tag")
        p.add_argument("--out", default=str(OUT_ROOT))
        p.add_argument("--leaf", help="the output folder itself (run only)")
        p.add_argument("--force", action="store_true")
        p.add_argument("--click", action="append", help="extra pictures: control texts clicked in turn, joined by >>")
        p.add_argument("--setup-only", action="store_true", help="check the variant and the server, start no main")
        p.add_argument("--hello-only", action="store_true", help="start main, wait for its hello, quit; no request")
        lane_options(p)
        if name == "batch":
            p.add_argument("--parallel", type=int)
    p = sub.add_parser("matrix", help="every pipeline on every corpus, --reps times, --parallel at once")
    p.add_argument("--pipelines", required=True, help="comma-separated names from pipelines.json")
    p.add_argument("--corpora", required=True, help="comma-separated names under views-r5/corpora")
    p.add_argument("--reps", type=int, default=1)
    p.add_argument("--parallel", type=int, default=2, help="runs at once, each a slot of four ports from --port-base")
    p.add_argument("--out", default=str(OUT_ROOT))
    p.add_argument("--minutes", type=float, default=120)
    p.add_argument("--propose-minutes", type=float, default=40)
    p.add_argument("--no-review", action="store_true")
    p.add_argument("--setup-only", action="store_true", help="each run checks its prompts and server, starts no main")
    lane_options(p)
    p = sub.add_parser("summary")
    p.add_argument("folders", nargs="+")
    p = sub.add_parser("shoot")
    p.add_argument("run")
    p.add_argument("--click", action="append")
    lane_options(p)
    p = sub.add_parser("status")
    lane_options(p)
    p = sub.add_parser("stop")
    p.add_argument("instance")
    lane_options(p)
    p = sub.add_parser("clean")
    p.add_argument("instances", nargs="+")
    lane_options(p)
    a = ap.parse_args()
    if a.cmd == "batch" and (a.slot is not None or a.leaf):
        ap.error("batch picks slots and output folders itself")
    if a.cmd in ("run", "batch"):
        if not a.pipeline and not a.variant:
            ap.error("give --pipeline (or --variant with --tree, round 4's way)")
        if a.pipeline:
            table = read(PIPELINES) or {}
            if a.pipeline not in table:
                ap.error(f"no pipeline {a.pipeline!r} in {PIPELINES} ({', '.join(table)})")
            a.tree, a.variant = table[a.pipeline]["tree"], a.pipeline
    configure(a)
    if a.cmd == "matrix":
        a.slots = a.parallel
    return {"run": cmd_run, "batch": cmd_batch, "matrix": cmd_matrix, "summary": cmd_summary, "shoot": cmd_shoot,
            "status": cmd_status, "stop": cmd_stop, "clean": cmd_clean}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
