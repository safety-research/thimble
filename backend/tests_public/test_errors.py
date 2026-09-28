"""The plain sentence for a link out of the corpus (config.safe_corpus_path)."""
from __future__ import annotations

import os

import pytest

from app import config


def test_a_link_out_of_the_corpus_is_named_as_one(tmp_path):
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("x")
    os.symlink(outside, corpus / "link.txt")
    (corpus / "own.txt").write_text("y")
    os.symlink("own.txt", corpus / "inner.txt")
    assert config.safe_corpus_path(corpus, "inner.txt") == corpus / "own.txt"
    with pytest.raises(ValueError) as e:
        config.safe_corpus_path(corpus, "link.txt")
    assert str(e.value).startswith(f"path escapes corpus: 'link.txt' is a link to {outside}, outside the corpus folder")
    with pytest.raises(ValueError, match=r"^path escapes corpus: '../outside.txt'$"):
        config.safe_corpus_path(corpus, "../outside.txt")
