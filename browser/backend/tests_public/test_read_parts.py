"""Text an agent reads whole with Claude Code's Read tool (read_parts.py): a text that one Read call cannot return is
cut at line ends into numbered files of at most READ_UNITS UTF-16 code units, which its prompt names in order, and a
file that stays whole gets a window of lines one Read call returns whole wherever it starts.

Whether one Read call returns a text whole is Claude Code 2.1.300's rule (read_returns_whole): a text of at most 25,000
UTF-16 code units comes back whole uncounted; past that Read counts its tokens, and past 25,000 tokens a whole-file Read
gives only the first lines and an offset/limit Read fails. No tokenizer runs here, so a text's tokens are its code units
times the tokens a character that Read counted in a live 2.1.300 session (claude-opus-5-5) for each kind of text below,
reading the 40,000-character parts the cap in characters made: Chinese 42,463 tokens for 39,912 characters (a partial
view, lines 1-348 of 697), Japanese 34,737 for 39,912, Korean 41,237 for 39,820, a table of UUIDs 29,277 for 39,906, a
table of floats 26,070 for 39,948, and a 36-line window of a Chinese digest 40,461 for 36,990 (an error)."""
from __future__ import annotations

import random
import uuid

import pytest

from app import read_parts, tools

READ_UNCOUNTED_UNITS = 25_000
READ_TOKEN_CAP = 25_000
TOKENS_PER_CHAR = {"zh": 42_463 / 39_912, "ja": 34_737 / 39_912, "ko": 41_237 / 39_820, "uuid": 29_277 / 39_906,
                   "num": 26_070 / 39_948, "zh-digest": 40_461 / 36_990}
ZH = ("用户在第三次登录失败后提交了工单，说明账户被锁定，并且重置密码的邮件一直没有收到。客服人员首先确认了邮箱地址，"
      "然后检查了垃圾邮件文件夹，最后发现邮件服务器的发送队列出现了延迟。问题在两个小时后解决，用户表示满意。")
JA = ("ユーザーは三回目のログインに失敗した後でチケットを提出し、アカウントがロックされ、パスワード再設定のメールが届かないと"
      "説明しました。サポート担当者はまずメールアドレスを確認し、次に迷惑メールフォルダを調べ、最後にメールサーバーの送信"
      "キューに遅延があることを見つけました。問題は二時間後に解決し、ユーザーは満足していると答えました。")
KO = ("사용자는 세 번째 로그인에 실패한 후 티켓을 제출했으며, 계정이 잠겼고 비밀번호 재설정 이메일을 받지 못했다고 설명했습니다. "
      "상담원은 먼저 이메일 주소를 확인하고, 스팸 폴더를 점검한 뒤, 메일 서버의 발송 대기열에 지연이 있다는 것을 발견했습니다. "
      "문제는 두 시간 후에 해결되었고 사용자는 만족한다고 답했습니다.")


def read_returns_whole(text: str, kind: str) -> bool:
    """Whether one Read call of Claude Code 2.1.300 returns `text`, of a kind TOKENS_PER_CHAR measured, whole."""
    units = len(text.encode("utf-16-le")) // 2
    return units <= READ_UNCOUNTED_UNITS or units * TOKENS_PER_CHAR[kind] <= READ_TOKEN_CAP


def test_cut_at_line_ends_and_rejoin_exactly():
    text = "short\n" + "a" * 250 + "\n" + "tail\n"
    parts = read_parts.cut(text, limit=100)
    assert "".join(parts) == text
    assert all(len(p) <= 100 for p in parts)
    assert parts[0] == "short\n", "a line that does not fit the open part starts the next one"
    assert parts[1] == "a" * 100 and parts[2] == "a" * 100, "a line past the cap alone is cut mid-line"
    assert read_parts.cut("", limit=100) == [""]


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


def test_named_names_one_file_or_every_part_in_order(monkeypatch, tmp_path):
    real = tools.descriptions
    hints = {"x-file": "READ {path}", "x-files": "READ {n}: {paths}"}
    monkeypatch.setattr(tools, "descriptions", lambda: {**real(), **hints})
    a, b, c = (tmp_path / n for n in ("task.md", "task-2.md", "task-3.md"))
    assert read_parts.named([a], "x-file", "x-files") == f"READ {a}"
    assert read_parts.named([a, b, c], "x-file", "x-files") == f"READ 3: {a}, {b}, {c}"


def test_window_is_the_most_lines_one_read_call_returns_whole_from_any_line():
    """Every run of `window` lines, each with its line break and room for Read's line-number prefix, fits READ_UNITS,
    and one more line does not fit somewhere. Lines of the digest's longest (CALL_CHARS, 1,500) come to 16 a window; a
    file that fits whole is all its lines."""
    lines = [("y" * 1_400 if i % 5 == 0 else "z" * 90) for i in range(2_000)]
    w = read_parts.window(lines)
    sizes = [len(x) + 1 + read_parts.LINE_PREFIX_CHARS for x in lines]
    assert all(sum(sizes[i:i + w]) <= read_parts.READ_UNITS for i in range(len(lines)))
    assert any(sum(sizes[i:i + w + 1]) > read_parts.READ_UNITS for i in range(len(lines)))
    dense = read_parts.window(["d" * 1_500] * 500)
    assert dense == read_parts.READ_UNITS // (1_500 + 1 + read_parts.LINE_PREFIX_CHARS) == 16
    assert read_parts.window(["short"] * 10) == 10
    assert read_parts.window(["v" * (2 * read_parts.READ_UNITS), "short"]) == 1, "a line past the cap alone: 1"
    assert read_parts.window([]) == 1


def test_cut_and_window_count_utf16_code_units_as_claude_code_does():
    """Claude Code measures a text in UTF-16 code units, where a character past U+FFFF, such as an emoji, counts 2: cut
    holds each part to `limit` of them and never splits a character, and window counts a line's emoji twice."""
    assert read_parts.units("abc") == 3 and read_parts.units("東京") == 2 and read_parts.units("🙂x") == 3
    text = "🙂" * 30 + "\n" + "東" * 10 + "\n"
    parts = read_parts.cut(text, limit=25)
    assert "".join(parts) == text
    assert parts == ["🙂" * 12, "🙂" * 12, "🙂" * 6 + "\n" + "東" * 10 + "\n"]
    assert read_parts.window(["🙂" * 10] * 4, limit=2 * (20 + 1 + read_parts.LINE_PREFIX_CHARS)) == 2


def _prose(par: str, n: int = 100_000) -> str:
    out: list[str] = []
    i = 0
    while sum(len(x) + 1 for x in out) < n:
        i += 1
        out += [f"[p{i}] {par}", ""]
    return "\n".join(out)


def _texts() -> dict[str, str]:
    rnd = random.Random(7)
    return {
        "zh": _prose(ZH), "ja": _prose(JA), "ko": _prose(KO),
        "uuid": "| run | session | parent |\n|---|---|---|\n" + "\n".join(
            f"| {uuid.UUID(int=rnd.getrandbits(128))} | {uuid.UUID(int=rnd.getrandbits(128))} | "
            f"{uuid.UUID(int=rnd.getrandbits(128))} |" for _ in range(900)),
        "num": "| id | a | b | c | d | e |\n|---|---|---|---|---|---|\n" + "\n".join(
            f"| {i} | " + " | ".join(f"{rnd.random():.6f}" for _ in range(5)) + " |" for i in range(2_200)),
    }


@pytest.mark.parametrize("kind", ["zh", "ja", "ko", "uuid", "num"])
def test_each_part_of_a_dense_or_multi_byte_text_is_one_read_call_whole(tmp_path, kind):
    """read_parts.write, which the writer's context, a check's task and the critic's brief all use, on 100k characters
    of Chinese, Japanese or Korean prose or of a table of ids or numbers: the prompt says to Read each part whole, and
    one Read call returns each whole."""
    text = _texts()[kind] + "\n"
    paths = read_parts.write(tmp_path, tmp_path / "w" / "task.md", text)
    assert len(paths) >= 2 and "".join(p.read_text("utf-8") for p in paths) == text
    over = [(p.name, len(p.read_text("utf-8"))) for p in paths if not read_returns_whole(p.read_text("utf-8"), kind)]
    assert not over, f"{kind}: parts past Read's token cap: {over}"


def zh_digest(paragraphs: int) -> list[str]:
    """The lines of a digest of an orientation that wrote Chinese, each paragraph wrapped as render wraps it."""
    lines = ["# orientation", ""]
    for i in range(paragraphs):
        lines += [*critique_session._wrap(f"{i}: " + ZH * 40), ""]
    return lines


