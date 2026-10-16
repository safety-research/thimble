"""Text an agent reads whole with Claude Code's Read tool (read_parts.py): a text that one Read call cannot return is
cut at line ends into numbered files of at most READ_UNITS UTF-16 code units, which its prompt names in order, and a
file that stays whole gets a window of lines one Read call returns whole wherever it starts.

Whether one Read call returns a text whole is Claude Code 2.1.300's rule (read_returns_whole): a text of at most 25,000
UTF-16 code units comes back whole uncounted; past that Read counts its tokens, and past 25,000 tokens a whole-file Read
gives only the first lines and an offset/limit Read fails. No tokenizer runs here, so a text's tokens are its code units
times the tokens a character that Read counted in a live 2.1.300 session (claude-opus-5-5): Chinese 42,463 tokens for
39,912 characters (a partial view, lines 1-348 of 697), and a 36-line window of a Chinese digest 40,461 for 36,990 (an
error). Chinese is the densest text measured, past one token a character. test_check_subagents imports ZH and
read_returns_whole."""
from __future__ import annotations

from app import critique_session, read_parts

READ_UNCOUNTED_UNITS = 25_000
READ_TOKEN_CAP = 25_000
TOKENS_PER_CHAR = {"zh": 42_463 / 39_912, "zh-digest": 40_461 / 36_990}
ZH = ("用户在第三次登录失败后提交了工单，说明账户被锁定，并且重置密码的邮件一直没有收到。客服人员首先确认了邮箱地址，"
      "然后检查了垃圾邮件文件夹，最后发现邮件服务器的发送队列出现了延迟。问题在两个小时后解决，用户表示满意。")


def read_returns_whole(text: str, kind: str) -> bool:
    """Whether one Read call of Claude Code 2.1.300 returns `text`, of a kind TOKENS_PER_CHAR measured, whole."""
    units = len(text.encode("utf-16-le")) // 2
    return units <= READ_UNCOUNTED_UNITS or units * TOKENS_PER_CHAR[kind] <= READ_TOKEN_CAP


def test_write_puts_the_parts_beside_the_first_file_and_a_shorter_text_removes_only_their_extra_files(tmp_path,
                                                                                                    monkeypatch):
    """The parts are task.md, task-2.md…; a later, shorter text leaves task.md alone and removes those numbered files,
    and only those: an agent's own files in the folder stay, and a link planted as a part goes as a link."""
    monkeypatch.setattr(read_parts, "READ_UNITS", 100)
    folder = tmp_path / "work"
    first = folder / "task.md"
    big = "".join(f"line {i:03d} " + "x" * 30 + "\n" for i in range(12))
    paths = read_parts.write(tmp_path, first, big)
    assert [p.name for p in paths] == ["task.md", "task-2.md", "task-3.md", "task-4.md", "task-5.md", "task-6.md"]
    assert "".join(p.read_text() for p in paths) == big and all(len(p.read_text()) <= 100 for p in paths)
    keep = {name: folder / name for name in ("task-notes.md", "task-2.txt", "transcript.md", "task-02x.md")}
    for path in keep.values():
        path.write_text("an agent's own file")
    outside = tmp_path / "outside.md"
    outside.write_text("not thimble's to remove")
    (folder / "task-9.md").symlink_to(outside)
    assert read_parts.write(tmp_path, first, "small\n") == [first]
    assert first.read_text() == "small\n"
    assert sorted(p.name for p in folder.iterdir()) == sorted(["task.md", *keep])
    assert outside.read_text() == "not thimble's to remove"


def _prose(par: str, n: int = 100_000) -> str:
    out: list[str] = []
    i = 0
    while sum(len(x) + 1 for x in out) < n:
        i += 1
        out += [f"[p{i}] {par}", ""]
    return "\n".join(out)


def test_each_part_of_a_chinese_text_is_one_read_call_whole(tmp_path):
    """read_parts.write, which the writer's context, a check's task and the critic's brief all use, on 100k characters
    of Chinese prose: the prompt says to Read each part whole, and one Read call returns each whole."""
    text = _prose(ZH) + "\n"
    paths = read_parts.write(tmp_path, tmp_path / "w" / "task.md", text)
    assert len(paths) >= 2 and "".join(p.read_text("utf-8") for p in paths) == text
    over = [(p.name, len(p.read_text("utf-8"))) for p in paths if not read_returns_whole(p.read_text("utf-8"), "zh")]
    assert not over, f"parts past Read's token cap: {over}"


def zh_digest(paragraphs: int) -> list[str]:
    """The lines of a digest of an orientation that wrote Chinese, each paragraph wrapped as render wraps it."""
    lines = ["# orientation", ""]
    for i in range(paragraphs):
        lines += [*critique_session._wrap(f"{i}: " + ZH * 40), ""]
    return lines


def test_the_critic_s_window_over_a_chinese_digest_is_one_read_call_whole():
    """The brief says one Read call returns `window` lines of the digest whole from any line
    (critique-transcript-window), and an offset/limit Read past the token cap fails."""
    lines = zh_digest(60)
    w = read_parts.window(lines)
    over = [i + 1 for i in range(len(lines)) if not read_returns_whole("\n".join(lines[i:i + w]), "zh-digest")]
    assert not over, f"window {w}: {len(over)} starting lines give a Read past the token cap, first offset {over[0]}"
