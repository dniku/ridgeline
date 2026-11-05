#!/usr/bin/env bash
# check.sh — the acceptance checklist. Every phase runs or the script fails.
#
# A phase that silently skips is worse than a red build, because a green suite
# that ran nothing is exactly what a broken artifact looks like on CI. So each
# phase is a real command with its exit status checked, and there are no
# "if the browser is available" branches: if the toolchain cannot be resolved,
# toolchain.sh exits non-zero and this script dies.
#
#   ./check.sh              # everything
#   ./check.sh --quick      # skip the long simulation phases
set -uo pipefail
cd "$(dirname "$0")"

QUICK=0
[[ ${1:-} == --quick ]] && QUICK=1

FAILED=0
phase() {
  local name=$1; shift
  printf '\n=== %s ===\n' "$name"
  if "$@"; then
    printf 'PASS %s\n' "$name"
  else
    printf 'FAIL %s\n' "$name"
    FAILED=1
  fi
}

# 1. The toolchain must resolve, or nothing below means anything.
phase "toolchain resolves" ./tools/toolchain.sh node --version

# 2. Fonts: the artifact must carry its own glyph coverage.
#
# fonttools lives at <store>/lib/python3.14/site-packages, not <store>/site-
# packages. Guessing the layout produces a ModuleNotFoundError that looks like
# "fonttools is missing" while the package is sitting right there, which is the
# same trap as concluding a browser is unavailable because the daemon is down.
# Glob for the directory that actually contains fontTools, and fail if none does.
phase "fonts regenerate" ./tools/toolchain.sh bash -c '
  set -euo pipefail
  ft=$(ls -d /nix/store/*python3.14-fonttools-*/lib/python3.14/site-packages 2>/dev/null | grep -v "\.drv" | head -1)
  br=$(ls -d /nix/store/*python3.14-brotli-*/lib/python3.14/site-packages 2>/dev/null | grep -v "\.drv" | head -1)
  [ -n "$ft" ] || { echo "no fonttools site-packages in /nix/store"; exit 1; }
  [ -n "$br" ] || { echo "no brotli site-packages in /nix/store"; exit 1; }
  fbin=$(dirname "$(dirname "$ft")")/bin
  PATH="$fbin:$PATH" PYTHONPATH="$ft:$br" python3 tools/fonts.py
'

# 3. Build the single file.
phase "build index.html" ./tools/toolchain.sh node tools/build.mjs

# 4. The artifact is self-contained: no external src/href, no leftover placeholder.
phase "artifact is self-contained" ./tools/toolchain.sh node tools/build.mjs /dev/stdout >/dev/null

# 4b. The single-file promise, asserted rather than eyeballed.
phase "artifact guarantees" ./tools/toolchain.sh node tools/verify-artifact.mjs

# 5. Rules: the referee's contract.
phase "rules tests" ./tools/toolchain.sh node tests/rules.test.mjs

# 6. Geometry oracle: every floor's stairs are reachable. Strategy-free, so a
#    failure here is the generator, not a bot.
phase "stairs always reachable" ./tools/toolchain.sh node tools/reach.mjs --floors 2000

# 7. Browser smoke: boots, paints, lays out, in both device shapes.
phase "browser smoke (firefox)" ./tools/toolchain.sh node tests/smoke.test.mjs --engine firefox

# 7b. The sandboxed opaque-origin iframe, with a control proving the frame
#     really denies storage, so the pass cannot be vacuous.
phase "sandboxed opaque-origin iframe" ./tools/toolchain.sh node tests/iframe.test.mjs --engine firefox

if [[ $QUICK -eq 0 ]]; then
  # 8. Difficulty curve. Not an assertion of correctness: it prints the curve so
  #    a human can read it. Fails only if the oracle itself errors out.
  phase "climb curve (perfect-information bot)" ./tools/toolchain.sh node tools/climb.mjs --runs 100 --cap-turns 6000
fi

printf '\n========================================\n'
if [[ $FAILED -eq 0 ]]; then
  echo "ALL PHASES PASSED"
else
  echo "SOME PHASES FAILED"
fi
exit $FAILED
