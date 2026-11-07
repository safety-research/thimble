"""thimble's releases on GitHub, read with curl over HTTPS and never with git, and the release commit that thimble makes
from a release's file.

Each release has one file attached, thimble-X.Y.Z.tar.gz (git archive of its tag, under the folder thimble-X.Y.Z), with
SHA256SUMS beside it (scripts/release-file.sh builds both; CONTRIBUTING.md, Releasing thimble). GitHub counts the
downloads of that file, which is how many people install each version; thimble sends nothing else.

    newest()     the newest release: the tag that GitHub's page of the latest release redirects to. It reads that page
                 and no file, so a check for a newer release (a session's, thimble doctor's, thimble update --check)
                 counts nothing
    download()   a release's file, checked against its SHA256SUMS; or GitHub's archive of a branch, or of a tag that has
                 no file (scripts/install.sh --ref), which GitHub does not count
    commit()     the release commit in a repository of thimble's (live), made from the file with git fast-import, with
                 nothing unpacked: a commit with no parent, whose tree is the file's, made by thimble at the release's
                 own time, so that a release is the same commit on every machine
    fetch()      both, into live: what thimble update and the install's --ref move live to

curl runs with no ~/.curlrc (-q) and only over HTTPS. Python from python.org on macOS may have no certificates; curl
uses the system's. thimble's repository on GitHub is https://github.com/safety-research/thimble (fixes.upstream());
THIMBLE_RELEASES_URL stands in for it, for tests (a server on 127.0.0.1, over plain http). The dev install
(scripts/install.sh --local) and a pull request's fetch of main (share.py) still use git."""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import zlib
from pathlib import Path
from typing import Any
from urllib.parse import quote

from . import fixes as FX

# a release's tag, or a ref that may name one (v0.11.0-rc1): its file is looked for first
TAG_LIKE = re.compile(r"^v\d")
COMMIT_ID = re.compile(r"^[0-9a-f]{40}(?:[0-9a-f]{24})?$")
WHO = "thimble <thimble@localhost>"  # the author and committer of a release commit, as of each commit thimble makes


def base() -> str:
    """thimble's repository on GitHub, the address its release pages and files are under (THIMBLE_RELEASES_URL for
    tests)."""
    return (os.environ.get("THIMBLE_RELEASES_URL") or f"https://github.com/{FX.upstream()}").rstrip("/")


def issues() -> str:
    return f"https://github.com/{FX.upstream()}/issues"


def file_name(tag: str) -> str:
    """A release's file: thimble-0.10.13.tar.gz for v0.10.13."""
    return f"thimble-{tag.removeprefix('v')}.tar.gz"


def _q(ref: str) -> str:
    return quote(ref, safe="/+@")


def file_url(tag: str) -> str:
    return f"{base()}/releases/download/{_q(tag)}/{_q(file_name(tag))}"


def sums_url(tag: str) -> str:
    return f"{base()}/releases/download/{_q(tag)}/SHA256SUMS"


def archive_url(ref: str) -> str:
    """GitHub's archive of a branch, a tag or a commit, which it makes on request and does not count."""
    return f"{base()}/archive/{_q(ref)}.tar.gz"


def _why(p: subprocess.CompletedProcess) -> str:
    """curl's own line, without its `curl: (N) `: Could not resolve host: github.com."""
    lines = [x.strip() for x in (p.stderr or "").splitlines() if x.strip()]
    said = [x for x in lines if x.startswith("curl: (")] or lines or [f"curl ended with {p.returncode}"]
    return re.sub(r"^curl: \(\d+\) ", "", said[-1]).rstrip(".")


def _curl(args: list[str], then: str, seconds: int, name: str = "") -> str:
    """curl ARGS, with no ~/.curlrc and over HTTPS alone (plain http too while THIMBLE_RELEASES_URL stands in for
    GitHub): what it wrote for -w. A failure of curl itself is the person's line with its fix, then `then`; a download
    that could not be written (`name`) says to make room on the disk."""
    proto = "=http,https" if os.environ.get("THIMBLE_RELEASES_URL") else "=https"
    cmd = ["curl", "-q", "--proto", proto, "--proto-redir", proto, "-sS", "--connect-timeout", "20", "--retry", "2",
           "--max-time", str(seconds), *args]
    limit = seconds * 3 + 60  # its tries, and the waits between them
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, errors="replace", timeout=limit,
                           stdin=subprocess.DEVNULL)
    except FileNotFoundError:
        raise FX.FixError("thimble reads its releases with curl, which is not installed here: install it with your "
                          f"system's package manager, then {then}")
    except subprocess.TimeoutExpired:
        raise FX.FixError(f"thimble could not reach {base()} (no answer in {limit} s); check the network, then {then}")
    if p.returncode == 23:
        raise FX.FixError(f"the download of {name or 'a release'} could not be written ({_why(p)}); make room on the "
                          f"disk, then {then}")
    if p.returncode != 0:
        raise FX.FixError(f"thimble could not reach {base()} ({_why(p)}); check the network, then {then}")
    return p.stdout.strip()


def newest(then: str = "run thimble update again") -> str:
    """The newest release's tag (v0.10.13): where GitHub's page of the latest release redirects to, read without going
    there. GitHub names only a published release there, never a draft or a prerelease. No file is touched."""
    status, _, to = _curl(["-o", os.devnull, "-w", "%{http_code} %{redirect_url}", f"{base()}/releases/latest"],
                          then, 60).partition(" ")
    m = re.search(r"/releases/tag/(v\d+\.\d+\.\d+)$", to.strip())
    if not m:
        raise FX.FixError(f"thimble found no release at {base()} (GitHub answered {status or 'nothing'}); {then}")
    return m.group(1)


def _get(url: str, path: Path, then: str, seconds: int) -> str:
    """The file at `url`, redirects followed, saved as `path`: the HTTP status of the last answer."""
    return _curl(["-L", "-o", str(path), "-w", "%{http_code}", url], then, seconds, path.name)


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _sum_in(sums: Path, name: str) -> str:
    """The sha256 that SHA256SUMS gives the file `name` ('' when it names none), as sha256sum or shasum writes it."""
    for line in sums.read_text(errors="replace").splitlines():
        h, _, n = line.strip().partition(" ")
        if n.strip().removeprefix("*") == name and re.fullmatch(r"[0-9a-fA-F]{64}", h):
            return h.lower()
    return ""


def _answered(status: str, then: str) -> None:
    if status != "200":
        raise FX.FixError(f"thimble could not download from {base()} (GitHub answered {status or 'nothing'}); check "
                          f"the network, then {then}")


def _capital(s: str) -> str:
    return s[:1].upper() + s[1:]


def download(ref: str, into: Path, then: str = "run thimble update again", archive: bool = False) -> dict[str, Any]:
    """The release `ref` (v0.10.13) into the folder `into`: its SHA256SUMS, then its file, whose sha256 must be the one
    SHA256SUMS gives. A tag with no file stops, saying so, unless `archive` (the install's --ref) lets GitHub's archive of
    it stand in; any other ref (a branch, a commit) is GitHub's archive, whose sha256 is kept for the record, since
    GitHub publishes none. {path, source, sha256, file}, where file says whether it is a release's file. Every failure
    says what to do; nothing else is changed."""
    if TAG_LIKE.match(ref):
        name = file_name(ref)
        sums = into / "SHA256SUMS"
        status = _get(sums_url(ref), sums, then, 120)
        if status == "200":
            path = into / name
            status = _get(file_url(ref), path, then, 600)
            if status == "404":
                raise FX.FixError(f"thimble {ref[1:]}'s release file is missing on GitHub ({name}), so nothing changed. "
                                  f"{_capital(then)} in a few minutes; if it says this again, report it at {issues()}")
            _answered(status, then)
            got = sha256_of(path)
            if got != _sum_in(sums, name):
                raise FX.FixError(f"{name} does not have the sha256 its SHA256SUMS gives, so the download is broken and "
                                  f"nothing changed; {then}")
            return {"path": path, "source": file_url(ref), "sha256": got, "file": True}
        if status != "404":
            _answered(status, then)
        if not archive:
            raise FX.FixError(f"thimble {ref[1:]} has no release file on GitHub ({name}), so nothing changed. "
                              f"{_capital(then)} in a few minutes; if it says this again, report it at {issues()}")
    path = into / f"thimble-{ref.replace('/', '-')}.tar.gz"
    status = _get(archive_url(ref), path, then, 600)
    if status == "404":
        raise FX.FixError(f"GitHub has no branch or tag named {ref}; check the name, then {then}")
    _answered(status, then)
    return {"path": path, "source": archive_url(ref), "sha256": sha256_of(path), "file": False}


def _checked(members: list[tarfile.TarInfo], label: str) -> tuple[list[tarfile.TarInfo], int]:
    """The file's files, and the newest time any member has, once every member is checked: one with an absolute name,
    an empty, ., .., or .git part, one that is no file or folder (a link, a device, a fifo), or one outside the one
    folder at the top stops it, naming the member."""
    if not members:
        raise FX.FixError(f"{label} holds no files, so thimble did not use it and nothing changed; report it at "
                          f"{issues()}")
    top = members[0].name.split("/")[0]
    files: list[tarfile.TarInfo] = []
    for m in members:
        parts = m.name.split("/")
        if (m.name.startswith("/") or any(x in ("", ".", "..") or x.lower() == ".git" for x in parts)
                or not (m.isfile() or m.isdir()) or parts[0] != top or (m.isfile() and len(parts) < 2)):
            raise FX.FixError(f"{label} holds {m.name}, a link or a path out of its folder, so thimble did not use it "
                              f"and nothing changed; report it at {issues()}")
        if m.isfile():
            files.append(m)
    return files, int(max(m.mtime for m in members))


def _quoted(path: str) -> bytes:
    """A path as git fast-import reads it: in double quotes, with \\, " and control characters escaped as C does."""
    out = bytearray(b'"')
    for c in path.encode("utf-8", "surrogateescape"):
        if c in (0x22, 0x5C):
            out += b"\\" + bytes([c])
        elif c < 0x20 or c == 0x7F:
            out += b"\\%03o" % c
        else:
            out.append(c)
    return bytes(out + b'"')


def _import(repo: Path, tar: tarfile.TarFile, files: list[tarfile.TarInfo], when: int, message: str) -> str:
    """The commit of `files` (their paths without the top folder), streamed from the file into git fast-import, which
    writes it to a ref of its own; the ref is read, then deleted. The new commit."""
    ref = f"refs/thimble/import/{os.getpid()}"
    FX.run(["git", "update-ref", "-d", ref], cwd=repo, check=False)
    who = f"{WHO} {when} +0000".encode()
    text = message.encode() + b"\n"
    with tempfile.TemporaryFile() as err:
        p = subprocess.Popen(["git", "fast-import", "--quiet", "--date-format=raw", "--done", "--force"], cwd=repo,
                             stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=err)
        assert p.stdin is not None
        try:
            for n, m in enumerate(files, 1):
                p.stdin.write(b"blob\nmark :%d\ndata %d\n" % (n, m.size))
                src = tar.extractfile(m)
                if src is not None:
                    shutil.copyfileobj(src, p.stdin, 1 << 20)
                p.stdin.write(b"\n")
            p.stdin.write(b"commit %s\nauthor %s\ncommitter %s\ndata %d\n%s" % (ref.encode(), who, who, len(text), text))
            for n, m in enumerate(files, 1):
                mode = b"100755" if m.mode & 0o100 else b"100644"
                p.stdin.write(b"M %s :%d %s\n" % (mode, n, _quoted(m.name.split("/", 1)[1])))
            p.stdin.write(b"\ndone\n")
            p.stdin.close()
        except BrokenPipeError:
            pass  # fast-import stopped: what it said comes below
        except BaseException:
            p.kill()
            p.wait()
            raise
        if p.wait() != 0:
            err.seek(0)
            said = [x.strip() for x in err.read().decode(errors="replace").splitlines() if x.strip()]
            FX.run(["git", "update-ref", "-d", ref], cwd=repo, check=False)
            raise FX.FixError(f"git fast-import failed: {said[-1] if said else 'no message'}")
    new = FX.git("rev-parse", "--verify", f"{ref}^{{commit}}", cwd=repo)
    FX.run(["git", "update-ref", "-d", ref], cwd=repo, check=False)
    return new


def commit(repo: Path, path: Path, tag: str = "", name: str = "", then: str = "try again") -> dict[str, Any]:
    """The release commit of the file `path` (a release's file, or GitHub's archive of a branch) in the repository
    `repo`: {base, commit, time}, where base is the new commit and commit GitHub's commit of the release, which the
    file's header names (git archive's pax comment; '' when it names none).

    The commit has no parent. Its tree is the files under the file's one folder, each executable when the file lets its
    owner run it; git keeps no empty folders. Its author and committer are thimble, at the newest time a member has,
    which is the release commit's time (git archive gives every file that time), and its message is `thimble v0.10.13`,
    or for a branch `thimble NAME at abc1234`: so a release is the same commit on every machine, whatever the person's
    git settings say (fast-import reads none that change what it writes). Every member is checked before anything is
    written (_checked), so a file that stops it adds nothing to the repository."""
    label = path.name
    try:
        with tarfile.open(path, "r:*") as tar:
            files, when = _checked(tar.getmembers(), label)
            github = str(tar.pax_headers.get("comment") or "")
            github = github if COMMIT_ID.match(github) else ""
            message = (f"thimble {tag}" if tag else f"thimble {name} at {github[:7]}" if github else f"thimble {name}")
            new = _import(repo, tar, files, when, message)
    except (tarfile.TarError, EOFError, zlib.error, OSError) as e:
        raise FX.FixError(f"{label} could not be read ({e}), so thimble did not use it and nothing changed; {then}")
    return {"base": new, "commit": github, "time": when}


def fetch(to: dict[str, Any], repo: Path, then: str = "run thimble update again", archive: bool = False) -> dict[str, Any]:
    """The release or branch `to` ({tag, name}, where tag is '' for a branch) in the repository `repo`: downloaded
    into a scratch folder in thimble's fixes folder, which goes whatever happens, made its release commit, and
    refs/thimble/releases/<tag> (refs/thimble/branches/<name> for a branch) pointed at that. What thimble update and
    release.json take: {tag, ref, name, version, base, commit, source, sha256, file}, where version is 0.10.13, or for a
    branch `main at abc1234`, with GitHub's commit."""
    tag = str(to.get("tag") or "")
    name = str(to.get("name") or tag)
    FX.home().mkdir(parents=True, exist_ok=True)
    scratch = Path(tempfile.mkdtemp(prefix="download-", dir=FX.home()))
    try:
        got = download(tag or name, scratch, then, archive)
        made = commit(repo, got["path"], tag, name, then)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    FX.git("update-ref", f"refs/thimble/releases/{tag}" if tag else f"refs/thimble/branches/{name}", made["base"],
           cwd=repo)
    g = made["commit"]
    return {"tag": tag, "ref": "" if tag else name, "name": name,
            "version": tag[1:] if tag else f"{name} at {g[:7]}" if g else name, "base": made["base"], "commit": g,
            "source": got["source"], "sha256": got["sha256"], "file": got["file"]}
