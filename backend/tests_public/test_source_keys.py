"""The keys a file's records can be coloured by in the File browser's Transcript mode (app/source_keys.py): over the whole
file, the keys that name a kind (few values) or a who (values that come back on several records), never one that names
each record (an id, a time) or holds texts or nested values; their values with counts, and where they fall in bins of
the file's lines; a CSV file's columns; a file of another kind has none; the route refuses a path outside the corpus."""
import json
import shutil

import pytest
from fastapi.testclient import TestClient

from app import source_keys
from app.main import app

client = TestClient(app)
CORPUS = "/api/corpora/keyed"


def rows(n: int) -> list[dict]:
    out = []
    for i in range(n):
        out.append({
            "id": f"r{i}",  # one per record
            "time": f"2026-06-18T20:{i // 60:02d}:{i % 60:02d}Z",  # one per record
            "type": "post" if i < n // 2 else "edit",  # two values, the first half then the second
            "user": f"u{i % 10}",  # ten users, each on many records
            "body": "x" * 200,  # a long text
            "meta": {"a": 1},  # nested
            "lane": None if i % 4 else "fast",  # one value and none: not a kind
        })
    return out


@pytest.fixture()
def keyed(tmp_path, monkeypatch, mini_dir):
    from app import config

    data = tmp_path / "data"
    shutil.copytree(mini_dir, data / "keyed")
    root = data / "keyed"
    (root / "posts.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows(400)))
    (root / "table.csv").write_text("who,score,kind\n" + "".join(f"p{i % 3},{i},{'a' if i % 2 else 'b'}\n" for i in range(90)))
    (root / "notes.md").write_text("# notes\n\nplain text\n")
    monkeypatch.setattr(config, "DATA_DIR", data.resolve())
    monkeypatch.setattr(source_keys, "_cache", type(source_keys._cache)())
    return root


def test_the_keys_that_name_a_kind_or_a_who_over_the_whole_file(keyed):
    got = client.get(f"{CORPUS}/source/keys", params={"path": "posts.jsonl", "bins": 4}).json()
    assert got["total"] == 400 and not got["partial"]
    keys = {k["key"]: k for k in got["keys"]}
    assert set(keys) == {"type", "user"}
    assert keys["type"]["values"] == [{"value": "post", "n": 200}, {"value": "edit", "n": 200}] or keys["type"]["values"] == [{"value": "edit", "n": 200}, {"value": "post", "n": 200}]
    ranks = {v["value"]: i for i, v in enumerate(keys["type"]["values"])}
    # the first half of the file is posts, the second edits
    assert keys["type"]["at"] == [ranks["post"], ranks["post"], ranks["edit"], ranks["edit"]]
    assert len(keys["user"]["values"]) == 10 and keys["user"]["none"] == 0
    assert len(got["bytes"]) == 4 and sum(got["bytes"]) == (keyed / "posts.jsonl").stat().st_size


def test_a_csv_file_s_columns(keyed):
    got = client.get(f"{CORPUS}/source/keys", params={"path": "table.csv"}).json()
    keys = {k["key"]: k for k in got["keys"]}
    # the scores are a number per row
    assert set(keys) == {"who", "kind"}
    assert sum(v["n"] for v in keys["who"]["values"]) == 90 and keys["who"]["none"] == 0


def test_a_file_of_another_kind_has_no_keys_and_a_path_outside_is_refused(keyed):
    assert client.get(f"{CORPUS}/source/keys", params={"path": "notes.md"}).json()["keys"] == []
    assert client.get(f"{CORPUS}/source/keys", params={"path": "../x.jsonl"}).status_code == 400


def test_many_values_list_the_commonest_and_count_the_rest(tmp_path, monkeypatch):
    monkeypatch.setattr(source_keys, "VALUES_LISTED", 5)
    p = tmp_path / "pages.jsonl"
    p.write_text("".join(json.dumps({"page": f"p{i % 40}"}) + "\n" for i in range(400)))
    got = source_keys.scan(p, 10)
    (page,) = got["keys"]
    assert len(page["values"]) == 5 and page["more"] == {"values": 35, "n": 350}
