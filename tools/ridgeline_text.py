#!/usr/bin/env python3
"""The set of characters the artifact can paint, derived from the source.

Two consumers, one derivation:

* ``tools/fonts.py`` turns this into the pyftsubset codepoint spec, so a new
  character in the copy cannot ship as a missing glyph.
* ``tests/test_glyphs.py`` asserts the built ``index.html`` needs nothing
  outside the committed subset.

Deriving it from the files rather than from a hand-maintained list is the whole
point: a list rots the first time someone writes a "»" in a message.
"""

from __future__ import annotations

import re
from pathlib import Path

# Printable ASCII the sheet and the canvas can always be asked for. Held here so
# the glyph contract has one definition rather than one per tool. Control
# characters (tab, newline) are separators in the source, never painted, and
# DejaVu maps them to nothing -- including them makes the coverage assertion
# fail on characters the artifact cannot render by design.
BASE_CODEPOINTS: frozenset[int] = frozenset(range(0x20, 0x7F))

# Non-ASCII the *design* asks for regardless of whether it is currently in the
# copy: the glyph shapes the UI is built around (rank arrows, boss crown).
DESIGN_NON_ASCII: frozenset[str] = frozenset("→←↑↓·×°—’“”»«█▓▒░○●◆◇★☆♔♥")

_COMMENT_BLOCK = re.compile(r"/\*[\s\S]*?\*/")
_COMMENT_LINE_JS = re.compile(r"^\s*//.*$", re.MULTILINE)
_TAG = re.compile(r"<[^>]*>")

#: Files whose *painted* text needs glyphs. Comments are stripped first: a dash
#: in a code comment is never rendered, and letting it widen the subset would
#: put bytes in the artifact for nothing.
TEXT_BEARING_SUFFIXES = (".js", ".html", ".css")


def _stripped(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    text = _COMMENT_BLOCK.sub(" ", text)
    if path.suffix == ".js":
        text = _COMMENT_LINE_JS.sub(" ", text)
    if path.suffix == ".html":
        text = _TAG.sub(" ", text)
    return text


def source_files(root: Path) -> list[Path]:
    src = root / "src"
    return sorted(p for p in src.rglob("*") if p.suffix in TEXT_BEARING_SUFFIXES and p.is_file())


def used_non_ascii(root: Path) -> set[str]:
    """Printable non-ASCII characters that appear in painted text."""
    used: set[str] = set()
    for path in source_files(root):
        for character in _stripped(path):
            code = ord(character)
            # 0x00A0..0x2FFF covers punctuation, arrows, blocks and the dingbats
            # this UI uses, while excluding the CJK ranges nothing here renders.
            if 0x00A0 <= code <= 0x2FFF and character.isprintable():
                used.add(character)
    return used


def glyph_source_text(root: Path) -> str:
    """The characters the glyph contract covers, as one string.

    Empty-string sentinels are not a thing here: the value is either the
    characters found or the empty set, and callers union it with
    :data:`DESIGN_NON_ASCII` explicitly.
    """
    return "".join(sorted(used_non_ascii(root) | DESIGN_NON_ASCII))
