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
therefore every golden screenshot. That is why writing is opt-in --
``--rebuild``. Without it this script only checks that the pinned source faces
are present, have the expected bytes, and still cover every painted codepoint,
so a routine ``./check.sh`` cannot quietly rewrite the committed blobs with
whatever the runner's toolchain produced.

Usage:
  python3 tools/fonts.py                    # verify coverage + source hashes
  python3 tools/fonts.py --rebuild [dir]    # write build/*.woff2[.base64]

The font directory comes from argv, then ``$RIDGELINE_FONT_DIR`` (exported by
``flake.nix``), then a version-matched probe of ``/nix/store``.

Dependencies: an importable ``fontTools`` and, for WOFF2 output, a ``brotli``
module in the *same* interpreter. Check both before blaming the font: a missing
``brotli`` and a missing package both look like toolchain absence, not a font
problem. ``./check.sh`` resolves them from the nix store.
"""

from __future__ import annotations

import base64
import glob
import hashlib
import os
import sys
from pathlib import Path

from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

from ridgeline_text import BASE_CODEPOINTS, DESIGN_NON_ASCII, glyph_source_text  # noqa: E402

# Where the un-substituted DejaVu source faces live.
#
# Deliberately *not* a literal /nix/store path. The first version of this file
# hard-coded the store path belonging to the machine that wrote it, which passed
# here and died on CI with "font directory not found". Two independent reasons
# that literal could never work, and each is the interesting one:
#
#   1. The hash is an output of a nixpkgs *revision*. This repo has no committed
#      flake.lock, so CI resolves nixpkgs on its own and gets a different path
#      for the same dejavu-fonts-2.37.
#   2. The truth being pinned is not the path but the *bytes*. Three different
#      store paths on this one machine all hold a DejaVuSans.ttf whose sha256 is
#      58568c88..., so "which store path" was never the meaningful question. The
#      source hashes below are, and they are checked before any subset is cut.
#
# So the directory comes from argv[1] or from the environment -- flake.nix
# exports RIDGELINE_FONT_DIR, so `nix develop` answers this question itself --
# and the last-resort fallback probes by version rather than by hash.
FONT_DIR_ENV = "RIDGELINE_FONT_DIR"
FONT_VERSION_GLOB = "/nix/store/*dejavu-fonts-2.37/share/fonts/truetype"

# sha256 of the source faces the committed subsets were cut from. The embedded
# glyphs *are* the artifact's appearance, so which DejaVu a subset came from is
# a correctness question rather than an environment detail.
SOURCE_SHA256 = {
    "DejaVuSans.ttf": "58568c88a01b80dfc056daca3eeafd434a0380df1a48dda53f0de0d716109bbd",
    "DejaVuSans-Bold.ttf": "7c7aef63328a765586cda41bf9d2c227ff1ad82816326dae4d7fe2fd1b7f613a",
}

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


def resolve_font_dir(explicit: str | None) -> Path:
    """argv[1] > $RIDGELINE_FONT_DIR > a version-matching probe of /nix/store.

    An explicit choice -- argv[1] or the env var -- is authoritative: if it is
    set but unusable, that is an error rather than something to paper over by
    quietly falling back to a probe. Silently substituting a different font
    directory is precisely the "works here, different glyphs there" failure this
    function exists to prevent. The /nix/store probe runs only when nothing was
    chosen, which is the bare `python3 tools/fonts.py` case.
    """
    source_files = sorted(set(FACES.values()))
    chosen: list[tuple[str, Path]] = []
    if explicit is not None:
        chosen.append(("argument", Path(explicit)))
    from_env = os.environ.get(FONT_DIR_ENV)
    if from_env is not None:
        chosen.append((FONT_DIR_ENV, Path(from_env)))

    # An explicit choice is authoritative, checked before any probe runs, so a
    # bad override cannot be rescued by a lucky glob.
    for origin, directory in chosen:
        missing = [f for f in source_files if not (directory / f).is_file()]
        if missing:
            raise SystemExit(
                f"{origin}={directory} is not a usable font directory; missing {', '.join(missing)}"
            )
        print(f"font source: {directory} (via {origin})")
        return directory

    for directory in sorted(Path(match) for match in glob.glob(FONT_VERSION_GLOB)):
        if all((directory / f).is_file() for f in source_files):
            print(f"font source: {directory} (via /nix/store probe)")
            return directory

    raise SystemExit(
        f"no directory holding {', '.join(source_files)}.\n"
        f"Probed {FONT_VERSION_GLOB} and found none usable.\n"
        f"Set {FONT_DIR_ENV} or pass the directory as argv[1]."
    )


def verify_source(source: Path) -> None:
    """Refuse to subset a face whose bytes are not the pinned ones.

    A silent substitution here would ship different glyphs while every pixel
    test still passed locally, because the golden baselines were painted from
    the pinned faces.
    """
    expected = SOURCE_SHA256[source.name]
    actual = hashlib.sha256(source.read_bytes()).hexdigest()
    if actual != expected:
        raise SystemExit(
            f"{source}: unexpected bytes.\n  expected sha256 {expected}\n  got      sha256 {actual}\n"
            "The committed subsets and golden baselines were cut from the expected face; "
            "regenerate them together if the pinned font is deliberately changing."
        )


def main(argv: list[str]) -> int:
    """Verify by default; write the subsets only when asked to.

    ./check.sh runs this on every invocation, and a default that overwrote
    build/ would mean the committed blobs silently tracked whatever toolchain
    the last person to run the checklist happened to have. Regenerating is a
    deliberate act, so it needs an explicit flag.
    """
    rebuild = "--rebuild" in argv
    positional = [a for a in argv[1:] if not a.startswith("--")]
    if len(positional) > 1:
        raise SystemExit(f"unexpected arguments: {' '.join(positional[1:])}")
    font_dir = resolve_font_dir(positional[0] if positional else None)

    codepoints = wanted_codepoints(ROOT)
    print(f"coverage: {len(codepoints)} codepoints")
    out_dir = ROOT / "build"

    for name, filename in FACES.items():
        source = font_dir / filename
        if not source.is_file():
            raise SystemExit(f"missing source font: {source}")
        verify_source(source)
        if not rebuild:
            print(f"  {name}: source verified, not writing (pass --rebuild)")
            continue
        out_dir.mkdir(exist_ok=True)
        target = out_dir / f"{name}.woff2"
        subset_face(source, target, codepoints)
        raw = target.read_bytes()
        (out_dir / f"{name}.woff2.base64").write_text(base64.b64encode(raw).decode("ascii") + "\n")
        print(f"  {name}: {len(raw)} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
