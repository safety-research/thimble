"""The command: `thimble-browser` opens the folder it is run in, on port 8000 or the next free port."""
import socket

from thimble_browser import __main__ as launch


def test_the_default_port_is_8000():
    assert launch.DEFAULT_PORT == 8000


def test_a_port_in_use_moves_to_the_next_free_one():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        taken = s.getsockname()[1]
        assert launch.free_port(taken) != taken


def test_no_folder_means_the_folder_it_runs_in(folder, monkeypatch):
    seen = {}
    monkeypatch.chdir(folder)
    monkeypatch.setattr(launch.home, "open_folder", lambda f: seen.setdefault("folder", f) and (_ for _ in ()).throw(
        NotADirectoryError()))
    assert launch.main(["--no-open"]) == 2
    assert seen["folder"] == folder.resolve()
