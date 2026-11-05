#!/usr/bin/env bash
# Put the pinned toolchain on PATH from /nix/store, with no nix daemon and no
# network, then exec the given command.
#
# flake.nix remains the definition of what is pinned. This exists because a
# machine can have every one of those paths already materialised in its store
# while the daemon is unreachable -- "nix is blocked" is not the same statement
# as "node is missing", and confusing the two once cost two sessions of skipped
# verification. Paths are resolved by name so a store bump fails loudly here
# rather than silently using a different node.
#
#   ./tools/toolchain.sh ./check.sh
#   PATH=$(./tools/toolchain.sh --print-path) ...
set -uo pipefail

resolve_one() {
  local -a found=()
  mapfile -t found < <(ls -d ${1} 2>/dev/null | grep -v '\.drv$' | sort | head -1)
  if [[ ${#found[@]} -eq 0 ]]; then
    echo "no store path matches: $1" >&2
    return 1
  fi
  printf '%s\n' "${found[0]}"
}

NODE_DIR=${RIDGELINE_NODE_DIR:-$(resolve_one '/nix/store/*nodejs-slim-22*/bin' || true)}
DRIVER=${PLAYWRIGHT_ENTRY:-$(resolve_one '/nix/store/*playwright-test-*/lib/node_modules/playwright/index.mjs' || true)}
BROWSERS=${PLAYWRIGHT_BROWSERS_PATH:-$(resolve_one '/nix/store/*playwright-browsers' || true)}

missing=0
[[ -x ${NODE_DIR:-}/node ]] || { echo "node 22 not found in /nix/store (set RIDGELINE_NODE_DIR)"; missing=1; }
[[ -f ${DRIVER:-} ]] || { echo "playwright driver not found in /nix/store (set PLAYWRIGHT_ENTRY)"; missing=1; }
[[ -d ${BROWSERS:-} ]] || { echo "playwright browsers not found (set PLAYWRIGHT_BROWSERS_PATH)"; missing=1; }
(( missing )) && exit 1

export PATH="$NODE_DIR:$PATH"
export PLAYWRIGHT_ENTRY="$DRIVER"
export PLAYWRIGHT_BROWSERS_PATH="$BROWSERS"
export NODE_NO_WARNINGS=1

if [[ ${1:-} == --print-path ]]; then
  echo "$NODE_DIR"
  exit 0
fi

exec "$@"
