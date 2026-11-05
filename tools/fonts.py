#!/usr/bin/env python3
"""Generate the WOFF2 faces embedded in index.html, and commit their base64.

Why the artifact owns its fonts
-------------------------------
The sheet could ask for ``system-ui``, which lets the browser pick a face this
project does not control. For a reader that is fine; for a golden screenshot it
is fatal, and it also breaks the single-file offline promise. This container
ships one font (``fc-list`` counts one entry), CI ships another, so a
font-less baseline would fail on the runner and pass here for reasons that have
nothing to do with the app.

Why subsetted
-------------
DejaVu Sans is ~750 KiB per face and the game paints a few hundred glyphs.
Subset and WOFF2-compressed, one face costs single-digit KiB in the artifact.

Glyph coverage is a contract, enforced here
-------------------------------------------
A character missing from the subset falls back silently for that one glyph and
re-widens the line -- the exact failure embedding exists to prevent, and one
that would reappear only on a machine with different fonts. So the codepoint
list is *computed* from the text the game can actually paint
(:func:`ridgeline_text.glyph_source_text`), and the written subset is read back
and asserted complete. A build that cannot prove coverage fails.

The output lives in ``build/*.woff2.base64`` and is committed, so building,
testing and viewing the artifact need neither font tooling nor a network.
Regenerating is a deliberate act: a font change moves every glyph and
therefore every golden screenshot.

Dependencies: an importable ``fontTools`` and, for WOFF2 output, a ``brotli``
module in the *same* interpreter. Check both before blaming the font: a missing
``brotli`` and a missing package both look like toolchain absence, not a font
problem. ``./check.sh`` resolves them from the nix store.
"""

from __future__ import annotations

import base64
import sys
from pathlib import Path

from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

from ridgeline_text import BASE_CODEPOINTS, DESIGN_NON_ASCII, glyph_source_text  # noqa: E402

# dejavu-fonts-2.37 from nixpkgs. tools/with-fonttools.sh passes the directory
# belonging to whatever revision flake.lock resolves; this is the fallback.
FALLBACK_FONT_DIR = Path(
    "/nix/store/xadrivsjgk1bslbd64hq9zakin7vp6nr-dejavu-fonts-2.37/share/fonts/truetype"
)

# committed subset name -> source file in the font directory. Two weights
# because the sheet paints 400 and 700; shipping one face lets each engine
# synthesise the other, and synthetic stem weight is engine-specific.
FACES: dict[str, str] = {
    "RidgelineSans-regular": "DejaVuSans.ttf",
    "RidgelineSans-bold": "DejaVuSans-Bold.ttf",
}


def wanted_codepoints(root: Path) -> set[int]:
    """ASCII baseline + design glyphs + every non-ASCII character in painted text."""
    used = {ord(c) for c in glyph_source_text(root)}
    return set(BASE_CODEPOINTS) | used | {ord(c) for c in DESIGN_NON_ASCII}


def coverage_spec(codepoints: set[int]) -> str:
    return ",".join(f"U+{cp:04X}" for cp in sorted(codepoints))


def assert_coverage(target: Path, codepoints: set[int]) -> None:
    """Read the written subset's cmap back and require every requested codepoint.

    A subset that silently dropped one would render in a fallback face only on a
    *different* machine, which is the failure mode this file exists to prevent.
    """
    font = TTFont(target)
    have: set[int] = set()
    for table in font["cmap"].tables:
        have.update(table.cmap.keys())
    font.close()
    missing = sorted(codepoints - have)
    if missing:
        rendered = " ".join(f"U+{cp:04X}" for cp in missing[:20])
        raise SystemExit(f"{target.name}: subset is missing {len(missing)} codepoints: {rendered}")


def subset_face(source: Path, target: Path, codepoints: set[int]) -> None:
    """Subset `source` to `codepoints` and write a WOFF2 to `target`.

    Uses fontTools' own subset API rather than shelling out to `pyftsubset`.
    The subprocess form needed a binary on PATH *and* an importable `brotli`
    for the same interpreter, so it failed in exactly the environments where
    `import fontTools` worked -- and the failure surfaced as FileNotFoundError
    for a program, which reads as "fonttools is not installed" when it is.
    Going through the library means the one dependency the script already
    imports is the only dependency it has.
    """
    from fontTools import subset

    options = subset.Options()
    options.layout_features = ["kern", "liga", "pnum", "tnum"]
    options.hinting = False
    options.desubroutinize = True
    options.name_IDs = [1, 2, 3, 4, 6]
    options.name_legacy = True
    options.name_languages = [0x409]
    options.flavor = "woff2"

    font = subset.load_font(str(source), options)
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=sorted(codepoints))
    subsetter.subset(font)
    subset.save_font(font, str(target), options)
    font.close()

    assert_coverage(target, codepoints)


def main(argv: list[str]) -> int:
    font_dir = Path(argv[1]) if len(argv) > 1 else FALLBACK_FONT_DIR
    if not font_dir.is_dir():
        raise SystemExit(f"font directory not found: {font_dir}")

    codepoints = wanted_codepoints(ROOT)
    print(f"coverage: {len(codepoints)} codepoints")
    out_dir = ROOT / "build"
    out_dir.mkdir(exist_ok=True)

    for name, filename in FACES.items():
        source = font_dir / filename
        if not source.is_file():
            raise SystemExit(f"missing source font: {source}")
        target = out_dir / f"{name}.woff2"
        subset_face(source, target, codepoints)
        raw = target.read_bytes()
        (out_dir / f"{name}.woff2.base64").write_text(base64.b64encode(raw).decode("ascii") + "\n")
        print(f"  {name}: {len(raw)} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
