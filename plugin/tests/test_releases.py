"""thimble's releases on GitHub (engine/kernel/releases.py) and the file each release has attached
(scripts/release-file.sh): the file is git archive of the tag, with its sha256 in SHA256SUMS; thimble reads which
release is the newest from a page that counts nothing, downloads the file, checks it, and makes the release commit
from it, the same on every machine, refusing a file that holds a link or a path out of its folder. GitHub is a server on
127.0.0.1 (releases_server.py). All data here is made up."""
from __future__ import annotations

import io
import os
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "plugin" / "engine"))
sys.path.insert(0, str(HERE))

from kernel import fixes as FX  # noqa: E402
from kernel import releases as R  # noqa: E402
from releases_server import Releases  # noqa: E402

GIT_ID = {"GIT_AUTHOR_NAME": "Release", "GIT_AUTHOR_EMAIL": "release@example.invalid",
          "GIT_COMMITTER_NAME": "Release", "GIT_COMMITTER_EMAIL": "release@example.invalid"}
LONG = "plugin/" + "made-up-folder-" * 6 + "/" + "made-up-name-" * 7 + ".txt"


def sh(*cmd: str, cwd: Path | None = None, **env: str) -> str:
    return subprocess.run(cmd, cwd=cwd, check=True, capture_output=True, text=True,
                          env={**os.environ, **GIT_ID, **env}).stdout.strip()


@pytest.fixture
def repo(tmp_path) -> Path:
    """thimble's made-up repository with two releases: v0.10.2 (a plain tag), with an executable, a path of more than
    150 characters, a file that an ignore rule matches, and names with a space, a quote and an accent; and v0.10.3 (an
    annotated tag), a day later."""
    r = tmp_path / "thimble"
    for path, text in (("plugin/bin/thimble", "#!/bin/sh\necho made-up\n"), (LONG, "long\n"),
                       (".gitignore", "*.log\n"), ("plugin/sample/agents.log", "kept though ignored\n"),
                       ('plugin/a name with "quotes".txt', "q\n"), ("plugin/café.md", "accent\n")):
        (r / path).parent.mkdir(parents=True, exist_ok=True)
        (r / path).write_text(text)
    (r / "plugin" / "bin" / "thimble").chmod(0o755)
    sh("git", "init", "-q", "-b", "main", str(r))
    sh("git", "add", "-A", "-f", cwd=r)
    sh("git", "commit", "-q", "-m", "thimble 0.10.2", cwd=r)
    sh("git", "tag", "v0.10.2", cwd=r)
    (r / "plugin" / "notes.md").write_text("made-up note\n")
    sh("git", "add", "-A", cwd=r)
    sh("git", "commit", "-q", "-m", "thimble 0.10.3", cwd=r, GIT_COMMITTER_DATE="2026-11-04T12:00:00+00:00")
    sh("git", "tag", "-a", "v0.10.3", "-m", "v0.10.3", cwd=r)
    return r


@pytest.fixture
def gh(tmp_path, repo, monkeypatch) -> Releases:
    """GitHub, with both releases published (v0.10.3 the newest) and archives of the repository's branches."""
    g = Releases(tmp_path / "releases", repo)
    g.publish(repo, "v0.10.2")
    g.publish(repo, "v0.10.3")
    monkeypatch.setenv("THIMBLE_RELEASES_URL", g.url)
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "home" / ".thimble"))
    yield g
    g.stop()


def new_repo(at: Path) -> Path:
    sh("git", "init", "-q", str(at))
    return at


def refs_and_commits(repo: Path) -> tuple[str, str]:
    return sh("git", "for-each-ref", cwd=repo), sh("git", "rev-list", "--all", cwd=repo)


# ------------------------------------------------------------------ the file


def test_release_file_sh_builds_the_tag_s_archive_and_its_sha256(tmp_path, repo):
    out = tmp_path / "dist"
    said = sh("bash", str(ROOT / "scripts" / "release-file.sh"), "v0.10.3", str(out), cwd=repo).splitlines()
    assert said == [f"{out}/thimble-0.10.3.tar.gz", f"{out}/SHA256SUMS"]
    f = out / "thimble-0.10.3.tar.gz"
    with tarfile.open(f) as t:
        names = t.getnames()
        # one folder at the top, the tag's files under it, and the tag's commit in the header, as git get-tar-commit-id
        # reads it
        assert {n.split("/")[0] for n in names} == {"thimble-0.10.3"}
        assert sorted(n.split("/", 1)[1] for n in names if t.getmember(n).isfile()) == sorted(
            sh("git", "ls-tree", "-r", "--name-only", "-z", "v0.10.3", cwd=repo).strip("\0").split("\0"))
        assert t.pax_headers["comment"] == sh("git", "rev-parse", "v0.10.3^{commit}", cwd=repo)
    assert (out / "SHA256SUMS").read_text() == f"{R.sha256_of(f)}  thimble-0.10.3.tar.gz\n"
    # a name that is no release's tag, a tag that is not there, and a tag whose files hold a link: nothing is built
    (repo / "plugin" / "link").symlink_to("bin/thimble")
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "a link", cwd=repo)
    sh("git", "tag", "v0.10.4", cwd=repo)
    for tag, why in (("main", "the first argument is a release's tag, such as v0.10.13"),
                     ("v0.10.9", "there is no tag v0.10.9 here"),
                     ("v0.10.4", "v0.10.4 holds a symbolic link or a submodule, which the install refuses")):
        p = subprocess.run(["bash", str(ROOT / "scripts" / "release-file.sh"), tag, str(tmp_path / tag)], cwd=repo,
                           capture_output=True, text=True)
        assert (p.returncode, p.stderr) == (2, f"release-file.sh: {why}\n"), p
        assert not (tmp_path / tag).exists()


# ------------------------------------------------------------------ the release commit


def test_the_release_commit_has_the_tag_s_tree_and_is_the_same_in_every_repository(tmp_path, repo, gh, monkeypatch):
    f = gh.root / "v0.10.2" / "thimble-0.10.2.tar.gz"
    a = R.commit(new_repo(tmp_path / "a"), f, "v0.10.2")
    v2 = sh("git", "rev-parse", "v0.10.2", cwd=repo)
    assert a["commit"] == v2
    # its tree is the tag's, with the executable, the long path, the ignored file and the names that need quotes
    assert sh("git", "rev-parse", f"{a['base']}^{{tree}}", cwd=tmp_path / "a") == sh("git", "rev-parse", "v0.10.2^{tree}",
                                                                                      cwd=repo)
    assert "100755 blob" in sh("git", "ls-tree", a["base"], "plugin/bin/thimble", cwd=tmp_path / "a")
    # no parent, thimble as its author at the release's time, and the release in its message
    when = sh("git", "log", "-1", "--format=%ct", "v0.10.2", cwd=repo)
    assert sh("git", "log", "-1", "--format=%P|%an <%ae> %at|%cn <%ce> %ct|%B", a["base"], cwd=tmp_path / "a") == (
        f"|thimble <thimble@localhost> {when}|thimble <thimble@localhost> {when}|thimble v0.10.2")
    assert a["time"] == int(when)
    # the same commit in another repository, and under a person's git settings that would change a commit git adds
    hostile = tmp_path / "gitconfig"
    hostile.write_text("[core]\n\tfileMode = false\n\tautocrlf = true\n[i18n]\n\tcommitEncoding = ISO-8859-1\n"
                       "[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(hostile))
    assert R.commit(new_repo(tmp_path / "b"), f, "v0.10.2") == a
    # the import's own ref is gone: nothing but the commit's objects is added
    assert sh("git", "for-each-ref", cwd=tmp_path / "b") == ""
    # a branch: its name and GitHub's commit in the message
    got = R.download("main", tmp_path, archive=True)
    main = R.commit(new_repo(tmp_path / "c"), got["path"], "", "main")
    tip = sh("git", "rev-parse", "main", cwd=repo)
    assert main["commit"] == tip and not got["file"]
    assert sh("git", "log", "-1", "--format=%B", main["base"], cwd=tmp_path / "c") == f"thimble main at {tip[:7]}"


def made_up_tar(at: Path, members: list[tuple[str, str]]) -> Path:
    """A .tar.gz with these members (name, kind: file, dir, symlink, hardlink, fifo), as no release file is made."""
    with tarfile.open(at, "w:gz") as t:
        for name, kind in members:
            info = tarfile.TarInfo(name)
            data = b""
            if kind == "file":
                data = b"made-up\n"
                info.size = len(data)
            info.type = {"file": tarfile.REGTYPE, "dir": tarfile.DIRTYPE, "symlink": tarfile.SYMTYPE,
                         "hardlink": tarfile.LNKTYPE, "fifo": tarfile.FIFOTYPE}[kind]
            if kind in ("symlink", "hardlink"):
                info.linkname = "../../outside"
            t.addfile(info, io.BytesIO(data) if data else None)
    return at


@pytest.mark.parametrize("bad, kind", [("/etc/made-up", "file"), ("thimble-0.10.2/../made-up", "file"),
                                       ("thimble-0.10.2/plugin/link", "symlink"),
                                       ("thimble-0.10.2/plugin/hard", "hardlink"), ("thimble-0.10.2/plugin/fifo", "fifo"),
                                       ("another-folder/made-up.txt", "file"), ("thimble-0.10.2/.git/config", "file")])
def test_a_file_that_holds_a_link_or_a_path_out_of_its_folder_adds_nothing(tmp_path, bad, kind):
    f = made_up_tar(tmp_path / "thimble-0.10.2.tar.gz", [("thimble-0.10.2", "dir"), ("thimble-0.10.2/plugin/a.txt", "file"),
                                                         (bad, kind)])
    r = new_repo(tmp_path / "live")
    with pytest.raises(FX.FixError) as e:
        R.commit(r, f, "v0.10.2")
    assert str(e.value).startswith(f"thimble-0.10.2.tar.gz holds {bad}, a link or a path out of its folder, so thimble "
                                   "did not use it and nothing changed; report it at https://github.com/")
    assert refs_and_commits(r) == ("", "")
    assert sh("git", "count-objects", cwd=r).startswith("0 objects") and not list((r / ".git" / "objects" / "pack").iterdir())


# ------------------------------------------------------------------ finding and downloading a release


def test_newest_reads_where_the_latest_release_page_points_and_downloads_nothing(gh, monkeypatch):
    assert R.newest() == "v0.10.3"
    assert gh.requests() == ["GET /releases/latest"]
    (gh.root / "latest").unlink()
    with pytest.raises(FX.FixError) as e:
        R.newest("run the install again")
    assert str(e.value) == f"{gh.url} names no release (GitHub answered 404); run the install again"


def test_download_checks_the_file_against_its_sha256sums_and_each_failure_says_what_to_do(tmp_path, gh, monkeypatch):
    into = tmp_path / "into"
    into.mkdir()
    got = R.download("v0.10.3", into)
    assert got["file"] is True and got["source"] == f"{gh.url}/releases/download/v0.10.3/thimble-0.10.3.tar.gz"
    assert got["sha256"] == R.sha256_of(gh.root / "v0.10.3" / "thimble-0.10.3.tar.gz")
    assert gh.files() == ["/releases/download/v0.10.3/thimble-0.10.3.tar.gz"]

    def fails(ref: str, archive: bool = False) -> str:
        with pytest.raises(FX.FixError) as e:
            R.download(ref, into, "run thimble update again", archive)
        return str(e.value)

    gh.spoil("v0.10.3")
    assert fails("v0.10.3") == ("thimble-0.10.3.tar.gz does not have the sha256 its SHA256SUMS gives, so the download "
                                "is broken and nothing changed; run thimble update again")
    gh.drop("v0.10.3")
    assert fails("v0.10.3") == (
        "thimble 0.10.3 has no release file on GitHub (thimble-0.10.3.tar.gz), so nothing changed. Run thimble update "
        "again in a few minutes; if it says this again, report it at https://github.com/safety-research/thimble/issues")
    # with --ref, a tag with no file is GitHub's archive of it, which GitHub does not count
    before = len(gh.requests())
    got = R.download("v0.10.3", into, archive=True)
    assert got["file"] is False and got["source"] == f"{gh.url}/archive/v0.10.3.tar.gz"
    assert gh.requests()[before:] == ["GET /releases/download/v0.10.3/SHA256SUMS", "GET /archive/v0.10.3.tar.gz"]
    assert fails("no-such-branch") == ("GitHub has no branch or tag named no-such-branch; check the name, then run "
                                       "thimble update again")
    # no curl here
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    assert fails("v0.10.2") == ("thimble reads its releases with curl, which is not installed here: install it with "
                                "your system's package manager, then run thimble update again")
    monkeypatch.undo()
    monkeypatch.setenv("THIMBLE_RELEASES_URL", gh.url)
    # GitHub out of reach: curl's own line
    gh.stop()
    said = fails("v0.10.2")
    assert said.startswith(f"thimble could not reach {gh.url} (") and said.endswith(
        "); check the network, then run thimble update again"), said
    assert "curl: (" not in said


def test_without_the_test_override_curl_takes_https_alone(tmp_path, gh, monkeypatch):
    monkeypatch.delenv("THIMBLE_RELEASES_URL")
    before = len(gh.requests())
    with pytest.raises(FX.FixError, match=r"^thimble could not reach https://github.com/safety-research/thimble \("):
        R._get(f"{gh.url}/releases/download/v0.10.3/SHA256SUMS", tmp_path / "SHA256SUMS", "try again", 10)
    assert len(gh.requests()) == before, "plain http reaches nothing"


def test_fetch_makes_the_release_commit_in_live_under_the_release_s_ref_and_leaves_no_download(tmp_path, gh):
    live = new_repo(tmp_path / "live")
    got = R.fetch({"tag": "v0.10.3", "name": "v0.10.3"}, live)
    assert sh("git", "rev-parse", "refs/thimble/releases/v0.10.3", cwd=live) == got["base"]
    assert (got["tag"], got["ref"], got["version"], got["file"]) == ("v0.10.3", "", "0.10.3", True)
    assert not any(p.name.startswith("download-") for p in FX.home().iterdir())
    # the same release again is the same commit
    assert R.fetch({"tag": "v0.10.3", "name": "v0.10.3"}, live)["base"] == got["base"]
